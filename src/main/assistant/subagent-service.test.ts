import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { AssistantExpert } from '../../shared/assistant-contracts'
import type { SubagentEvent } from '../../shared/contracts'
import type {
  AgentExecutionRequest,
  AgentRuntime
} from '../agent/runtime'
import { SubagentService, createSubagentRuntime } from './subagent-service'
import { SubagentScheduler } from './subagent-scheduler'
import { ExecutionSpaceResolver } from '../execution-space'
import { browserTabIdSchema, defaultRuntimeSettings } from '../../shared/contracts'
import { MainImageToolSession } from '../remote-agent/main-image-tool-session'
import type { RuntimeProtocolBinaryChannel, RuntimeProtocolBinaryFrame } from '../remote-agent/protocol-remote-runtime-channel'
import type { ImageToolBinding } from '../agent/image-tool-binding'

const expert: AssistantExpert = {
  id: '00000000-0000-4000-8000-000000000001',
  name: '研究专家',
  description: '',
  systemInstructions: 'Separate evidence from assumptions.',
  routingKeywords: ['研究'],
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

const parentRequest: AgentExecutionRequest = {
  requestId: '00000000-0000-4000-8000-000000000010',
  conversationId: 'conversation',
  prompt: '研究这份材料'
}

function database() {
  return {
    createTask: vi.fn(() => ({})),
    updateTaskStatus: vi.fn(),
    appendTaskEvent: vi.fn()
  }
}

describe('SubagentService', () => {
  it('waits for asynchronous creation and cancellation persistence during shutdown', async () => {
    let created!: () => void
    let saved!: () => void
    const db = {
      createTask: vi.fn(() => new Promise<void>(resolve => { created = resolve })),
      updateTaskStatus: vi.fn(() => new Promise<void>(resolve => { saved = resolve })),
      appendTaskEvent: vi.fn()
    }
    const createRuntime = vi.fn()
    const service = new SubagentService(createRuntime, db as never)
    const run = service.run({ parentRequest, expert, routingMode: 'manual', signal: new AbortController().signal, onEvent: vi.fn() })
    const rejected = expect(run).rejects.toThrow()
    const closed = vi.fn()
    const closing = service.dispose().then(closed)
    await Promise.resolve()
    expect(closed).not.toHaveBeenCalled()
    created()
    await vi.waitFor(() => expect(db.updateTaskStatus).toHaveBeenCalledWith(expect.any(String), 'cancelled', expect.any(String)))
    expect(createRuntime).not.toHaveBeenCalled()
    expect(closed).not.toHaveBeenCalled()
    saved()
    await rejected
    await closing
  })

  it('reports rejected persistence to the caller and shutdown', async () => {
    const failure = new Error('Task storage unavailable')
    const db = { ...database(), createTask: async () => { throw failure } }
    const createRuntime = vi.fn()
    const service = new SubagentService(createRuntime, db as never)
    await expect(service.run({ parentRequest, expert, routingMode: 'manual', signal: new AbortController().signal, onEvent: vi.fn() })).rejects.toBe(failure)
    expect(createRuntime).not.toHaveBeenCalled()
    await expect(service.dispose()).rejects.toBe(failure)
  })

  it.each(['opencode', 'continue'] as const)('saves SSH expert images through the %s Host adapter, never the Desktop save binding', async provider => {
    // Load the Agent entry dynamically: Main and Agent are separate TS projects.
    const { AgentImageToolMcp } = await import('../../agent-daemon/' + 'image-tool-mcp')
    const root = await mkdtemp(join(tmpdir(), 'expert-image-save-'))
    const desktop = join(root, 'desktop')
    const hostPath = join(root, 'host', 'nested', 'fixture.png')
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
    const artifactId = randomUUID()
    const binding: ImageToolBinding = {
      context: { conversationId: parentRequest.conversationId, requestId: parentRequest.requestId, messageId: randomUUID() },
      describe: vi.fn(async () => undefined),
      describeSave: vi.fn(async () => 'Save the owned image fixture'),
      call: vi.fn(async () => { throw new Error('Generation must not be called') }),
      save: vi.fn(async () => { throw new Error('Desktop writer must not be called') }),
      readForSave: vi.fn(async () => png)
    }
    const settings = { ...defaultRuntimeSettings, workspacePath: desktop, defaultModelProfileId: randomUUID(),
      modelProfiles: [{ id: randomUUID(), name: 'Expert', baseUrl: 'https://model.invalid/v1', modelName: 'expert',
        protocol: 'openai-chat-completions' as const, authentication: 'none' as const }] }
    const executionSpace = { kind: 'ssh' as const, hostId: randomUUID(), remoteRootPath: '/project',
      cacheIdentity: 'remote-project', routeIdentity: 'remote-project', workspaceAccess: {} as never }
    const createLocal = vi.fn(async () => { throw new Error('Local runtime must not be created') })
    const remoteRuntime = {
      async *run(request: AgentExecutionRequest) {
        expect(request.prompt).toContain(expert.systemInstructions)
        expect(request.imageToolBinding).toBe(binding)
        const queue: RuntimeProtocolBinaryFrame[] = []
        let receiver: ((frame: RuntimeProtocolBinaryFrame) => void) | undefined
        let rejectReceive: ((error: Error) => void) | undefined
        const listeners = new Set<() => void>()
        let closed = false
        const channel: RuntimeProtocolBinaryChannel = {
          channelId: randomUUID(), channelEpoch: '1',
          send: async payload => adapter.onReply(payload),
          receive: async () => queue.shift() ?? new Promise((resolve, reject) => { receiver = resolve; rejectReceive = reject }),
          close: () => { if (closed) return; closed = true; rejectReceive?.(new Error('closed')); for (const listener of listeners) listener() },
          onClose: listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
        }
        const main = new MainImageToolSession(channel, request.imageToolBinding)
        const adapter = new AgentImageToolMcp({ channelId: channel.channelId, channelEpoch: '1', saveDescription: await binding.describeSave!() }, async (payload: Uint8Array) => {
          const frame = { payload, sequence: '1', consume: async () => {} }
          if (receiver) { const resolve = receiver; receiver = undefined; resolve(frame) } else queue.push(frame)
        })
        const client = new Client({ name: 'expert-image-test', version: '1' })
        try {
          await adapter.start()
          await client.connect(new StreamableHTTPClientTransport(new URL(adapter.url!)))
          const save = (path: string, overwrite = false) => client.callTool({ name: 'save_image', arguments: { artifactId, path, overwrite } })
          expect((await save('relative.png')).isError).toBe(true)
          expect((await save(hostPath)).isError).not.toBe(true)
          expect(await readFile(hostPath)).toEqual(png)
          expect((await save(hostPath)).isError).toBe(true)
          expect(await readFile(hostPath)).toEqual(png)
          expect((await save(hostPath, true)).isError).not.toBe(true)
          yield { requestId: request.requestId, type: 'done' } as const
        } finally {
          main.close(); adapter.close(); await client.close()
        }
      },
      releaseConversation: vi.fn(), dispose: vi.fn()
    } as unknown as AgentRuntime
    const createRemote = vi.fn(async () => remoteRuntime)
    const service = new SubagentService(input => createSubagentRuntime(input, settings, createLocal, createRemote), database() as never)
    try {
      await service.run({ parentRequest: { ...parentRequest, projectId: 'project', runtimeSelection: { provider }, imageToolBinding: binding },
        executionSpace, expert: { ...expert, modelProfileId: settings.modelProfiles[0]!.id }, routingMode: 'manual',
        signal: new AbortController().signal, onEvent: vi.fn() })
      expect(createRemote).toHaveBeenCalledWith({ provider, profileId: settings.modelProfiles[0]!.id }, executionSpace)
      expect(createLocal).not.toHaveBeenCalled()
      expect(binding.save).not.toHaveBeenCalled()
      expect(binding.call).not.toHaveBeenCalled()
      expect(binding.readForSave).toHaveBeenCalledWith(artifactId, 'image/png')
      expect(await readdir(root)).toEqual(['host'])
    } finally { await service.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('uses the dedicated tool-free runtime for synthesis instead of the specialist runtime', async () => {
    const specialist = { run: vi.fn(), dispose: vi.fn() } as unknown as AgentRuntime
    let executionRequest: AgentExecutionRequest | undefined
    const synthesis = {
      run: async function* (request: AgentExecutionRequest) {
        executionRequest = request
        yield { requestId: request.requestId, type: 'text', delta: 'Summary' } as const
        yield { requestId: request.requestId, type: 'done' } as const
      },
      releaseConversation: vi.fn(),
      dispose: vi.fn()
    } as unknown as AgentRuntime
    const service = new SubagentService(async () => specialist, database() as never)

    await expect(service.synthesize(parentRequest, 'Combine results', new AbortController().signal, synthesis))
      .resolves.toBe('Summary')
    expect(specialist.run).not.toHaveBeenCalled()
    expect(executionRequest).not.toHaveProperty('workMode')
    expect(synthesis.releaseConversation).toHaveBeenCalledWith(`subagent-synthesis:${parentRequest.requestId}`)
    await service.dispose()
  })

  it('creates a linked child task and puts expert instructions in system context', async () => {
    let executionRequest: AgentExecutionRequest | undefined
    const expertOutput = '结果'.repeat(35_001)
    const runtime = {
      consumesTrustedInstructions: true,
      run: async function* (request: AgentExecutionRequest) {
        executionRequest = request
        yield {
          requestId: request.requestId,
          type: 'text',
          delta: expertOutput
        } as const
        yield { requestId: request.requestId, type: 'done' } as const
      },
      releaseConversation: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined)
    } as unknown as AgentRuntime
    const db = database()
    const service = new SubagentService(
      async () => runtime,
      db as never,
      new SubagentScheduler({ timeoutMs: 1_000 })
    )
    const events: SubagentEvent[] = []
    const scopedRequest: AgentExecutionRequest = {
      ...parentRequest,
      projectId: 'project',
      executionWorkspace: '/project',
      knowledgeCapabilityToken: 'parent-grant',
      browserTabId: browserTabIdSchema.parse('00000000-0000-4000-8000-000000000201'),
      imageToolBinding: { context: {} as never, describe: vi.fn(), call: vi.fn() },
      storyGraphBinding: { kind: 'test-binding' } as never,
      images: [{ name: 'source.png', mediaType: 'image/png', data: 'aW1hZ2U=' }],
      trustedInstructions: 'Parent capability instructions'
    }
    const result = await service.run({
      parentRequest: scopedRequest,
      executionSpace: new ExecutionSpaceResolver().resolveLocal('/project'),
      expert,
      routingMode: 'smart',
      signal: new AbortController().signal,
      onEvent: (event) => { events.push(event) }
    })

    expect(result.output).toBe(expertOutput)
    expect(result.output.length).toBeGreaterThan(60_000)
    expect(db.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        parentTaskId: parentRequest.requestId,
        expertId: expert.id,
        routingMode: 'smart',
        status: 'queued'
      })
    )
    expect(executionRequest?.prompt).toBe(parentRequest.prompt)
    expect(executionRequest).toMatchObject({ ...scopedRequest,
      requestId: result.childTaskId, conversationId: expect.stringContaining('subagent:'),
      trustedInstructions: expect.stringContaining(scopedRequest.trustedInstructions!) })
    expect(executionRequest?.imageToolBinding).toBe(scopedRequest.imageToolBinding)
    expect(executionRequest?.storyGraphBinding).toBe(scopedRequest.storyGraphBinding)
    expect(executionRequest).toHaveProperty('browserConversationId', scopedRequest.conversationId)
    expect(executionRequest?.trustedInstructions).toContain(
      expert.systemInstructions
    )
    expect(events.map((event) => event.state)).toEqual([
      'queued',
      'running',
      'completed'
    ])
    expect(events.at(-1)).toMatchObject({
      state: 'completed',
      output: expertOutput
    })
    await service.dispose()
  })

  it('does not construct a global runtime when a project execution space is missing', async () => {
    const createRuntime = vi.fn()
    const service = new SubagentService(createRuntime, database() as never)
    await expect(service.run({ parentRequest: { ...parentRequest, projectId: 'project' }, expert,
      routingMode: 'smart', signal: new AbortController().signal, onEvent: vi.fn() }))
      .rejects.toThrow('Expert project execution space is unavailable')
    expect(createRuntime).not.toHaveBeenCalled()
    await service.dispose()
  })

  it('disposes a child created after cancellation without starting its model', async () => {
    let resolveRuntime!: (runtime: AgentRuntime) => void
    const createRuntime = vi.fn(() => new Promise<AgentRuntime>(resolve => { resolveRuntime = resolve }))
    const runtime = { run: vi.fn(), releaseConversation: vi.fn(), dispose: vi.fn() } as unknown as AgentRuntime
    const service = new SubagentService(createRuntime, database() as never)
    const controller = new AbortController()
    const result = service.run({ parentRequest, expert, routingMode: 'manual', signal: controller.signal, onEvent: vi.fn() })
    const rejected = expect(result).rejects.toThrow('Cancelled during creation')
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledOnce())
    controller.abort(new Error('Cancelled during creation'))
    resolveRuntime(runtime)
    await rejected
    await service.dispose()
    expect(runtime.run).not.toHaveBeenCalled()
    expect(runtime.dispose).toHaveBeenCalledOnce()
  })

  it('forwards the parent authorizer and records expert tool activity without a mode', async () => {
    const events: SubagentEvent[] = []
    const authorize = vi.fn(async () => 'once' as const)
    let receivedAuthorize: unknown
    const runtime = {
      run: async function* (
        request: AgentExecutionRequest,
        signal: AbortSignal,
        runtimeAuthorize: unknown
      ) {
        void signal
        receivedAuthorize = runtimeAuthorize
        yield {
          requestId: request.requestId,
          type: 'text',
          delta: '部分结果'
        } as const
        yield {
          requestId: request.requestId,
          type: 'tool',
          callId: 'call',
          name: 'unsafe',
          state: 'running',
          summary: 'unsafe'
        } as const
        yield { requestId: request.requestId, type: 'done' } as const
      },
      dispose: vi.fn(async () => undefined)
    } as unknown as AgentRuntime
    const db = database()
    const service = new SubagentService(async () => runtime, db as never)
    await expect(service.run({
      parentRequest,
      expert,
      routingMode: 'manual',
      signal: new AbortController().signal,
      onEvent: (event) => { events.push(event) },
      authorize
    })).resolves.toMatchObject({ output: '部分结果' })
    expect(receivedAuthorize).toBe(authorize)
    expect(db.createTask).toHaveBeenCalledWith(expect.not.objectContaining({ workMode: expect.anything() }))
    expect(db.appendTaskEvent).toHaveBeenCalledWith(
      expect.any(String),
      'tool',
      expect.objectContaining({ name: 'unsafe' })
    )
    expect(events.at(-1)).toMatchObject({
      state: 'completed',
      output: '部分结果'
    })
    await service.dispose()
  })

  it('passes the expert profile to the per-run factory and disposes each child runtime', async () => {
    const calls: string[] = []
    const createRuntime = (label: string): AgentRuntime =>
      ({
        run: async function* (request: AgentExecutionRequest) {
          calls.push(label)
          yield {
            requestId: request.requestId,
            type: 'text',
            delta: label
          } as const
          yield { requestId: request.requestId, type: 'done' } as const
        },
        releaseConversation: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined)
      }) as unknown as AgentRuntime
    const defaultRuntime = createRuntime('default')
    const profileRuntime = createRuntime('profile')
    const profileId = '00000000-0000-4000-8000-000000000002'
    const service = new SubagentService(
      async input => input.expert.modelProfileId === profileId ? profileRuntime : defaultRuntime,
      database() as never,
      new SubagentScheduler({ timeoutMs: 1_000 })
    )

    const selected = await service.run({
      parentRequest,
      expert: { ...expert, modelProfileId: profileId },
      routingMode: 'manual',
      signal: new AbortController().signal,
      onEvent: vi.fn()
    })
    const fallback = await service.run({
      parentRequest: {
        ...parentRequest,
        requestId: '00000000-0000-4000-8000-000000000011'
      },
      expert: {
        ...expert,
        modelProfileId: '00000000-0000-4000-8000-000000000099'
      },
      routingMode: 'manual',
      signal: new AbortController().signal,
      onEvent: vi.fn()
    })

    expect(selected.output).toBe('profile')
    expect(fallback.output).toBe('default')
    expect(calls).toEqual(['profile', 'default'])
    expect(profileRuntime.dispose).toHaveBeenCalledOnce()
    expect(defaultRuntime.dispose).toHaveBeenCalledOnce()
    await service.dispose()
  })
})
