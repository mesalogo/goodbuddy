import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, type Agent, type McpServer } from '@agentclientprotocol/sdk'
import { ContinueHostAdapter } from '../main/agent/continue-host-adapter'
import { promptWithUntrustedConversationHistory } from '../main/agent/runtime-conversation-history'
import type { AgentExecutionRequest, AgentImage } from '../main/agent/runtime'
import { createUnixModelBridgeExchange } from './model-bridge-broker'
import { ModelBridgeLoopbackProxy, MODEL_BRIDGE_SDK_AUTH_SENTINEL, openCodeModelBridgeModelId, type ModelBridgeProtocol } from './model-bridge-helper'

export async function runContinueAcpHelper(options: {
  socketPath: string
  protocol: ModelBridgeProtocol
  model: string
  supportsImageInput: boolean
  workMode: 'ask' | 'execute'
  sharedSessions?: boolean
  entrypoint: string
}): Promise<number> {
  const proxy = new ModelBridgeLoopbackProxy({
    exchange: createUnixModelBridgeExchange({ socketPath: options.socketPath }),
    sharedSessions: options.sharedSessions
  })
  const origin = await proxy.listen()
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-continue-'))
  const questions = new Map<string, { sessionId: string; adapter: ContinueHostAdapter }>()
  const token = randomBytes(32).toString('base64url')
  const replies = createServer((request, response) => { void (async () => {
    if (request.method !== 'POST' || request.url !== `/${token}`) { response.writeHead(404).end(); return }
    let body = ''
    for await (const chunk of request) { body += chunk; if (body.length > 64 * 1024) throw new Error('Question reply too large') }
    const value = JSON.parse(body) as { questionId: string; sessionId: string; answers: string[][] }
    const pending = questions.get(value.questionId)
    if (!pending || pending.sessionId !== value.sessionId) { response.writeHead(409).end(); return }
    await pending.adapter.respondToQuestion(value.questionId, value.answers.length ? value.answers : undefined)
    questions.delete(value.questionId)
    response.writeHead(200).end('{}')
  })().catch(() => response.writeHead(400).end()) })
  await new Promise<void>((resolve, reject) => { replies.once('error', reject); replies.listen(0, '127.0.0.1', resolve) })
  const questionEndpoint = `http://127.0.0.1:${(replies.address() as import('node:net').AddressInfo).port}/${token}`
  const sessions = new Map<string, {
    cwd: string
    mcpServers: McpServer[]
    history: NonNullable<AgentExecutionRequest['history']>
    active?: { abort: AbortController; adapter: ContinueHostAdapter; finished: Promise<void> }
  }>()
  const modelId = openCodeModelBridgeModelId(options.protocol, options.model)
  const configOptions = [{ id: 'model', name: 'Model', type: 'select' as const, currentValue: modelId,
    options: [{ value: modelId, name: options.model }] }]
  const agent: Agent = {
    initialize: async () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {
      loadSession: true, mcpCapabilities: { http: true }, promptCapabilities: { image: true },
      sessionCapabilities: { resume: {}, close: {} }
    }, agentInfo: { name: 'GoodBuddy Continue', version: '1.5.47' } }),
    authenticate: async () => ({}),
    newSession: async ({ cwd, mcpServers }) => {
      const sessionId = randomUUID()
      sessions.set(sessionId, { cwd, mcpServers, history: [] })
      return { sessionId, configOptions }
    },
    loadSession: async ({ sessionId, cwd, mcpServers }) => {
      const session = sessions.get(sessionId)
      if (!session || session.cwd !== cwd) throw new Error('Continue Session is unavailable')
      session.mcpServers = mcpServers
      return { configOptions }
    },
    resumeSession: async ({ sessionId, cwd, mcpServers }) => {
      const session = sessions.get(sessionId)
      if (!session || session.cwd !== cwd) throw new Error('Continue Session is unavailable')
      if (mcpServers) session.mcpServers = mcpServers
      return { configOptions }
    },
    setSessionConfigOption: async ({ sessionId, configId, value }) => {
      if (!sessions.has(sessionId) || configId !== 'model' || value !== modelId) throw new Error('Continue model selection does not match the prepared model')
      return { configOptions }
    },
    prompt: async ({ sessionId, prompt }) => {
      const session = sessions.get(sessionId)
      if (!session || session.active) throw new Error('Continue Session is unavailable or busy')
      const route = options.sharedSessions ? await fetch(`${origin}/session?sessionId=${encodeURIComponent(sessionId)}`, {
        signal: AbortSignal.timeout(10_000)
      }).then(async response => {
        if (!response.ok) throw new Error('Continue model route is unavailable')
        return await response.json() as { operationId: string; workMode: 'ask' | 'execute' }
      }) : undefined
      const workMode = route?.workMode ?? options.workMode
      const sessionMcpServers = workMode === 'execute' ? session.mcpServers.map(server => {
        if (!('type' in server) || server.type !== 'http') throw new Error('Continue remote MCP requires HTTP')
        return { name: server.name, type: 'streamable-http' as const, url: server.url,
          requestOptions: { headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) } }
      }) : []
      const adapter = new ContinueHostAdapter({
        binaryPath: options.entrypoint, configPath: '', workspace: session.cwd, cacheRoot: root, mode: 'chat',
        modelProfile: { id: 'agent-bridge', name: 'GoodBuddy', modelName: options.model,
          protocol: options.protocol, authentication: 'api-key', apiKey: MODEL_BRIDGE_SDK_AUTH_SENTINEL,
          baseUrl: `${origin}/v1`, supportsImageInput: options.supportsImageInput,
          ...(route ? { requestHeaders: { 'x-goodbuddy-session': sessionId, 'x-goodbuddy-operation': route.operationId } } : {}) },
        launchHost: (entry, args, launch) => spawn(process.execPath, [entry, ...args], { ...launch, stdio: ['ignore', 'ignore', 'pipe'] })
      })
      const abort = new AbortController()
      let finish!: () => void
      const text = prompt.filter(part => part.type === 'text').map(part => part.text).join('\n')
      const images = prompt.filter(part => part.type === 'image').map<AgentImage>((part, index) => {
        if (part.mimeType !== 'image/png' && part.mimeType !== 'image/jpeg') throw new Error('Unsupported Continue image type')
        return { name: `image-${index}`, mediaType: part.mimeType, data: part.data }
      })
      session.active = { abort, adapter, finished: new Promise(resolve => { finish = resolve }) }
      try {
        const result = await adapter.run(promptWithUntrustedConversationHistory({ prompt: text, history: session.history }, true), abort.signal,
          async () => workMode === 'execute' ? 'once' : 'deny', {
            workMode, images, sessionMcpServers,
            onEvent: async event => {
              if (event.type === 'text') await connection.sessionUpdate({ sessionId, update: {
                sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.delta }
              } })
              if (event.type === 'checklist') await connection.sessionUpdate({ sessionId, update: {
                sessionUpdate: 'tool_call_update', toolCallId: 'goodbuddy-native-checklist',
                _meta: { goodbuddyChecklist: event.checklist }
              } })
              if (event.type === 'tool') await connection.sessionUpdate({ sessionId, update: {
                sessionUpdate: 'tool_call_update', toolCallId: event.tool.callId, title: event.tool.name,
                status: event.tool.state === 'running' ? 'in_progress' : event.tool.state,
                rawInput: event.tool.input,
                content: event.tool.output || event.tool.error ? [{ type: 'content', content: {
                  type: 'text', text: event.tool.error ?? event.tool.output!
                } }] : []
              } })
              if (event.type === 'question') {
                questions.set(event.questionId, { sessionId, adapter })
                await connection.sessionUpdate({ sessionId, update: {
                  sessionUpdate: 'tool_call_update', toolCallId: event.questionId,
                  _meta: { goodbuddyQuestion: { endpoint: questionEndpoint,
                    question: { id: event.questionId, sessionID: sessionId, questions: event.questions } } }
                } })
              }
            }
          })
        if (!result.streamedText && result.text) await connection.sessionUpdate({ sessionId, update: {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: result.text }
        } })
        session.history.push({ role: 'user', content: text }, { role: 'assistant', content: result.text })
        return { stopReason: 'end_turn', ...(result.usage ? { usage: {
          inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.inputTokens + result.usage.outputTokens,
          cachedReadTokens: result.usage.cacheReadTokens, cachedWriteTokens: result.usage.cacheWriteTokens
        } } : {}) }
      } catch (error) {
        if (abort.signal.aborted) return { stopReason: 'cancelled' }
        throw error
      } finally {
        await adapter.dispose()
        for (const [id, pending] of questions) if (pending.adapter === adapter) questions.delete(id)
        session.active = undefined
        finish()
      }
    },
    cancel: async ({ sessionId }) => {
      const active = sessions.get(sessionId)?.active
      active?.abort.abort(new DOMException('Cancelled', 'AbortError'))
      await active?.finished
    },
    closeSession: async ({ sessionId }) => {
      await agent.cancel({ sessionId })
      sessions.delete(sessionId)
      return {}
    }
  }
  const connection = new AgentSideConnection(() => agent, ndJsonStream(
    Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)
  ))
  try {
    if (options.sharedSessions) await connection.extNotification('goodbuddy/modelBridgeReady', { origin })
    await connection.closed
    return 0
  } finally {
    for (const session of sessions.values()) session.active?.abort.abort()
    await Promise.all([...sessions.values()].map(session => session.active?.finished))
    await proxy.close()
    replies.closeAllConnections()
    await new Promise<void>(resolve => replies.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}
