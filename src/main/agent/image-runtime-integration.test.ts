// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AssistantDatabase } from '../assistant/assistant-database'
import { ImageGenerationService } from './image-generation-service'
import { KnowledgeMcpGateway } from './knowledge-mcp-gateway'
import { ModelAgentRuntime } from './model-runtime'
import { OpenCodeRuntime } from './opencode-runtime'
import { ContinueAgentRuntime } from './continue-runtime'

vi.mock('electron', () => ({ nativeImage: {} }))
const openCodeBinary = join(process.cwd(), '.runtime-resources', process.arch, process.platform === 'win32' ? 'opencode.exe' : 'opencode')
const continueBinary = join(process.cwd(), 'node_modules', '@continuedev', 'cli', 'dist', 'cn.js')

it.for(['model', 'opencode', 'continue'] as const)('generates and edits through the real local %s tool loop', { timeout: 120_000 }, async (name, { skip }) => {
  if ((name === 'opencode' && !existsSync(openCodeBinary)) || (name === 'continue' && !existsSync(continueBinary))) return skip()
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-image-runtime-'))
  const database = new AssistantDatabase(join(root, 'assistant.sqlite'))
  database.initialize(root)
  const conversationId = randomUUID()
  const imageProfileId = randomUUID()
  let toolInput: Record<string, unknown> = { intent: 'create', prompt: 'Blue circle' }
  const textRequests: unknown[] = []
  const model = createServer((request, response) => {
    void (async () => {
      let content = ''
      for await (const chunk of request) content += String(chunk)
      const body = JSON.parse(content) as { messages?: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] }
      textRequests.push(body)
      let lastUser = -1
      body.messages?.forEach((message, index) => { if (message.role === 'user') lastUser = index })
      const results = body.messages?.slice(lastUser + 1).filter(message => message.role === 'tool') ?? []
      const tool = body.tools?.find(tool => tool.function.name.endsWith('generate_image'))
      if (!tool) throw new Error('Image tool was not exposed')
      const call = results.length === 0
      const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function',
        function: { name: tool.function.name, arguments: JSON.stringify(toolInput) } }] } : { role: 'assistant', content: 'IMAGE_SAVED' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const [value, finish] of [[delta, null], [{}, call ? 'tool_calls' : 'stop']]) {
        response.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', created: 1, model: 'fixture',
          choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`)
      }
      response.end('data: [DONE]\n\n')
    })().catch(error => { response.writeHead(500).end(String(error)) })
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  const port = (model.address() as { port: number }).port
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: 'iVBORw0KGgo=' }] }))
  const service = new ImageGenerationService({ database, fetcher, getSettings: async () => ({ defaultImageModelProfileId: imageProfileId, modelProfiles: [{
    id: imageProfileId, name: 'Image fixture', modelName: 'fixture', protocol: 'openai-images-generations',
    allowConversationInvocation: true, authentication: 'none', baseUrl: 'https://image.test/v1'
  }] }) })
  const gateway = new KnowledgeMcpGateway({} as never)
  await gateway.start()
  const profile = { id: randomUUID(), name: 'Chat fixture', modelName: 'fixture', protocol: 'openai-chat-completions' as const,
    authentication: 'none' as const, baseUrl: `http://127.0.0.1:${port}/v1` }
  const common = { defaultWorkspace: root, knowledgeGateway: gateway, modelProfile: profile }
  const runtime = name === 'model'
    ? new ModelAgentRuntime({ ...profile, model: profile.modelName, defaultWorkspace: root })
    : name === 'opencode'
      ? new OpenCodeRuntime({ ...common, embedded: true, binaryPath: openCodeBinary, configPath: '' })
      : new ContinueAgentRuntime({ ...common, binaryPath: '', bundledBinaryPath: continueBinary, configPath: '', hostCacheRoot: join(root, 'continue') })
  try {
    for (const intent of ['create', 'edit'] as const) {
      const messageId = randomUUID()
      const requestId = randomUUID()
      database.saveLocalConversations([{ header: { id: conversationId, title: 'Image integration', updatedAt: Date.now() },
        messages: [{ id: messageId, role: 'assistant', content: '', createdAt: Date.now(), state: 'complete' }] }])
      const binding = service.bind({ conversationId, messageId, requestId, workMode: 'execute' })
      const events = []
      for await (const event of runtime.run({ requestId, conversationId, prompt: `${intent} image ${requestId}`, workMode: 'execute', imageToolBinding: binding }, new AbortController().signal, async () => 'once')) events.push(event)
      expect(events.some(event => event.type === 'done')).toBe(true)
      const operation = database.getConversation(conversationId).messages.find(message => message.id === messageId)!.imageOperations?.[0]
      expect(operation?.state).toBe('completed')
      expect(database.getArtifact(operation!.artifactIds[0]!).content).toContain('iVBORw0KGgo=')
      toolInput = { intent: 'edit', prompt: 'Turn red', sourceArtifactIds: operation!.artifactIds }
    }
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(String(fetcher.mock.calls[1]![0])).toMatch(/images\/edits$/u)
    expect(textRequests.length).toBeGreaterThanOrEqual(4)
  } finally {
    await runtime.dispose()
    await gateway.dispose()
    await service.dispose()
    model.closeAllConnections()
    await new Promise<void>(resolve => model.close(() => resolve()))
    database.close()
    await rm(root, { recursive: true, force: true })
  }
})
