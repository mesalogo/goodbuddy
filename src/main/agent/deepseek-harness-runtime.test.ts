import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import type { RuntimeEvent } from './runtime'
import {
  ModelToolProvider,
  type ModelToolDefinition,
  type ModelToolProviderLike
} from './model-tool-provider'
import type {
  ResolvedMcpServer
} from '../capabilities/capability-service'
import {
  DeepSeekHarnessRuntime,
  harnessPromptError,
  type DeepSeekHarnessAcpSdk,
  type DeepSeekHarnessChild
} from './deepseek-harness-runtime'
import { RequestError } from '@agentclientprotocol/sdk'

type Permission = Parameters<
  ReturnType<
    ConstructorParameters<
      DeepSeekHarnessAcpSdk['ClientSideConnection']
    >[0]
  >['requestPermission']
>[0]

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function setup(
  options: {
    toolProvider?: ModelToolProviderLike
    promptTimeoutMs?: number
    maxEventCharacters?: number
    maxRequestOutputCharacters?: number
  } = {}
) {
  const exit = deferred<{
    exitCode: number | null
    signal?: string | null
  }>()
  const stderr = new TransformStream<Uint8Array, Uint8Array>()
  const child: DeepSeekHarnessChild = {
    stdin: new WritableStream<Uint8Array>(),
    stdout: new ReadableStream<Uint8Array>(),
    stderr: stderr.readable,
    exited: exit.promise,
    terminate: vi.fn()
  }
  let permissionHandler:
    | ((params: Permission) => Promise<unknown>)
    | undefined
  let updateHandler:
    | ((context: {
        sessionId: string
        update: Record<string, unknown>
      }) => Promise<void>)
    | undefined
  let extensionHandler:
    | ((
        method: string,
        params: Record<string, unknown>
      ) => Promise<Record<string, unknown>>)
    | undefined
  const requests: Array<{
    method: string
    params: Record<string, unknown>
  }> = []
  const notifications: Array<{
    method: string
    params: Record<string, unknown>
  }> = []
  const promptGates: Array<ReturnType<typeof deferred<{ stopReason: string }>>> =
    []
  let sessionIndex = 0
  const connectionClosed = deferred<void>()
  const connectionController = new AbortController()
  const requestAgent = async (
    method: string,
    params: Record<string, unknown>
  ) => {
    requests.push({ method, params })
    if (method === 'initialize') {
      return {
        protocolVersion: 1,
        agentCapabilities: {}
      }
    }
    if (method === 'session/new') {
      sessionIndex += 1
      return { sessionId: `session-${sessionIndex}` }
    }
    if (method === 'session/prompt') {
      const gate = deferred<{ stopReason: string }>()
      promptGates.push(gate)
      return gate.promise
    }
    throw new Error(`unexpected request: ${method}`)
  }
  const notifyAgent = async (
    method: string,
    params: Record<string, unknown>
  ) => {
    notifications.push({ method, params })
  }
  const agent = {
    initialize: vi.fn((params: Record<string, unknown>) =>
      requestAgent('initialize', params)
    ),
    newSession: vi.fn((params: Record<string, unknown>) =>
      requestAgent('session/new', params)
    ),
    prompt: vi.fn((params: Record<string, unknown>) =>
      requestAgent('session/prompt', params)
    ),
    cancel: vi.fn((params: Record<string, unknown>) =>
      notifyAgent('session/cancel', params)
    ),
    extMethod: vi.fn(
      async (method: string, params: Record<string, unknown>) => {
        requests.push({ method, params })
        if (method === 'goodbuddy/handshake') {
          return {
            controlProtocolVersion: 1,
            harnessVersion: '0.1.0-rc.6',
            acpProtocolVersion: 1,
            supports: {
              cancellation: true,
              sessionRelease: true,
              reasoningEvents: true,
              toolEvents: true,
              usageEvents: true,
              credentialResolution: true
            },
            execution: { mode: 'host' }
          }
        }
        if (method === 'goodbuddy/session/prepare') {
          return { prepared: true }
        }
        if (method === 'goodbuddy/session/release') {
          return { released: true }
        }
        if (method === 'goodbuddy/shutdown') {
          return { shutdown: true }
        }
        throw new Error(`unexpected extension: ${method}`)
      }
    ),
    extNotification: vi.fn()
  }
  const connection = {
    ...agent,
    signal: connectionController.signal,
    closed: connectionClosed.promise
  }
  const ClientSideConnection = vi.fn(function (
    this: unknown,
    toClient: (
      connectedAgent: typeof agent
    ) => {
      requestPermission: typeof permissionHandler
      sessionUpdate: typeof updateHandler
      extMethod: (
        method: string,
        params: Record<string, unknown>
      ) => Promise<Record<string, unknown>>
      extNotification: (
        method: string,
        params: Record<string, unknown>
      ) => Promise<void>
    }
  ) {
    const client = toClient(agent)
    permissionHandler = client.requestPermission
    updateHandler = client.sessionUpdate
    extensionHandler = client.extMethod
    agent.extNotification.mockImplementation(
      async (
        method: string,
        params: Record<string, unknown>
      ) => client.extNotification(method, params)
    )
    return connection
  })
  const sdk = {
    PROTOCOL_VERSION: 1,
    ClientSideConnection,
    ndJsonStream: vi.fn(() => ({ stream: true }))
  } as unknown as DeepSeekHarnessAcpSdk
  const launch = vi.fn(async () => child)
  const runtime = new DeepSeekHarnessRuntime({
    defaultWorkspace: 'C:\\workspace',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-test',
    launch,
    loadAcpSdk: async () => sdk,
    initializationTimeoutMs: 100,
    promptTimeoutMs: options.promptTimeoutMs ?? 100,
    shutdownTimeoutMs: 10,
    maxStderrBytes: 16,
    maxEventCharacters: options.maxEventCharacters,
    maxRequestOutputCharacters:
      options.maxRequestOutputCharacters,
    toolProvider: options.toolProvider
  })
  const emit = async (
    sessionId: string,
    update: Record<string, unknown>
  ): Promise<void> => {
    await updateHandler?.({ sessionId, update })
  }
  return {
    runtime,
    child,
    stderr,
    exit,
    sdk,
    launch,
    requests,
    notifications,
    promptGates,
    agent,
    permission: async (request: Permission) =>
      permissionHandler?.(request),
    extension: (
      method: string,
      params: Record<string, unknown>
    ) => extensionHandler?.(method, params),
    notify: (
      method: string,
      params: Record<string, unknown>
    ) => agent.extNotification(method, params),
    emit
  }
}

async function collect(
  stream: AsyncGenerator<RuntimeEvent, void, void>
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}

function request(
  conversationId: string,
  workMode: 'ask' | 'execute' = 'execute'
) {
  return {
    requestId: `request-${conversationId}`,
    conversationId,
    prompt: 'hello',
    workMode
  } as const
}

function permission(sessionId: string): Permission {
  return {
    sessionId,
    toolCall: {
      toolCallId: 'call-1',
      title: 'Run tests',
      name: 'shell',
      kind: 'execute',
      rawInput: { command: 'npm test' }
    },
    options: [
      {
        optionId: 'allow-once',
        name: 'Allow once',
        kind: 'allow_once'
      },
      {
        optionId: 'allow-always',
        name: 'Always allow',
        kind: 'allow_always'
      },
      {
        optionId: 'reject',
        name: 'Reject',
        kind: 'reject_once'
      }
    ]
  }
}

function mcpTool(
  name = 'mcp_deadbeef_cafebabe_game_asset'
): ModelToolDefinition {
  return {
    name,
    displayName: 'Local Game Assets / game_asset',
    description: 'Returns a deterministic local game asset manifest.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string' }
      },
      required: ['kind'],
      additionalProperties: false
    },
    source: 'mcp',
    serverName: 'Local Game Assets'
  }
}

function toolProvider(
  tools: ModelToolDefinition[] = [mcpTool()]
): ModelToolProviderLike {
  return {
    listTools: vi.fn(async () => tools),
    getApproval: vi.fn((tool, _arguments, summary) => ({
      scopeKey: `model:mcp:${tool.name}`,
      title: `允许调用 MCP 工具「${tool.displayName}」？`,
      description: '调用本地测试 MCP。',
      toolName: tool.displayName,
      argumentSummary: summary,
      allowPermanent: false
    })),
    callTool: vi.fn(async () => ({
      parts: [
        {
          type: 'text' as const,
          text: '{"asset":"cube"}'
        }
      ],
      contextBytes: 16
    })),
    releaseConversation: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined)
  }
}

describe('DeepSeekHarnessRuntime', () => {
  it('surfaces bounded internal Harness details from ACP errors', () => {
    expect(
      harnessPromptError(
        RequestError.internalError({
          details: 'DeepSeek provider rejected the request'
        })
      )
    ).toEqual(
      new Error('DeepSeek provider rejected the request')
    )
    expect(
      harnessPromptError(
        RequestError.internalError({ unrelated: 'hidden' })
      )
    ).toBeInstanceOf(RequestError)
  })

  it('uses ACP stdio, maps conversations to sessions, and streams text', async () => {
    const harness = setup()
    const first = collect(
      harness.runtime.run(
        request('one'),
        new AbortController().signal
      )
    )
    await vi.waitFor(() =>
      expect(harness.promptGates).toHaveLength(1)
    )
    await harness.emit('session-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello ' }
    })
    await harness.emit('session-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'world' }
    })
    harness.promptGates[0]!.resolve({ stopReason: 'end_turn' })

    expect(await first).toEqual([
      expect.objectContaining({ type: 'status' }),
      expect.objectContaining({ type: 'text', delta: 'hello ' }),
      expect.objectContaining({ type: 'text', delta: 'world' }),
      expect.objectContaining({
        type: 'done',
        sessionId: 'session-1'
      })
    ])
    expect(harness.sdk.ndJsonStream).toHaveBeenCalledWith(
      harness.child.stdin,
      harness.child.stdout
    )
    expect(harness.launch).toHaveBeenCalledWith({
      cwd: 'C:\\workspace',
      signal: expect.any(AbortSignal),
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-test',
      credentialRefs: [],
      skillPackages: []
    })
    expect(harness.requests).toContainEqual({
      method: 'goodbuddy/session/prepare',
      params: {
        sessionId: 'session-1',
        requestId: 'request-one',
        mode: 'execute'
      }
    })

    const second = collect(
      harness.runtime.run(
        request('one'),
        new AbortController().signal
      )
    )
    await vi.waitFor(() =>
      expect(harness.promptGates).toHaveLength(2)
    )
    harness.promptGates[1]!.resolve({ stopReason: 'end_turn' })
    await second
    expect(
      harness.requests.filter(({ method }) => method === 'session/new')
    ).toHaveLength(1)
    await harness.runtime.dispose()
  })

  it('enforces the cumulative bridge limit against complete wire events', async () => {
    const harness = setup({
      maxEventCharacters: 1_000,
      maxRequestOutputCharacters: 180
    })
    const running = collect(
      harness.runtime.run(
        request('output-limit'),
        new AbortController().signal
      )
    )
    await vi.waitFor(() =>
      expect(harness.promptGates).toHaveLength(1)
    )

    await harness.notify('goodbuddy/session/event', {
      sessionId: 'session-1',
      requestId: 'request-output-limit',
      type: 'reasoning',
      delta: 'x'.repeat(40)
    })
    await harness.notify('goodbuddy/session/event', {
      sessionId: 'session-1',
      requestId: 'request-output-limit',
      type: 'reasoning',
      delta: 'y'.repeat(40)
    })
    harness.promptGates[0]!.resolve({ stopReason: 'end_turn' })

    await expect(running).rejects.toThrow(
      '请求累计输出超过安全限制'
    )
    await harness.runtime.dispose()
  })

  it('keeps independent conversation sessions distinct', async () => {
    const harness = setup()
    const first = collect(
      harness.runtime.run(
        request('one'),
        new AbortController().signal
      )
    )
    const second = collect(
      harness.runtime.run(
        request('two'),
        new AbortController().signal
      )
    )
    await vi.waitFor(() =>
      expect(harness.promptGates).toHaveLength(2)
    )
    harness.promptGates[0]!.resolve({ stopReason: 'end_turn' })
    harness.promptGates[1]!.resolve({ stopReason: 'end_turn' })
    await Promise.all([first, second])

    const prompts = harness.requests.filter(
      ({ method }) => method === 'session/prompt'
    )
    expect(prompts.map(({ params }) => params.sessionId).sort()).toEqual([
      'session-1',
      'session-2'
    ])
    await harness.runtime.dispose()
  })

  it('fails Ask closed and never calls the authorizer', async () => {
    const harness = setup()
    const authorize = vi.fn().mockResolvedValue('once')
    const running = collect(
      harness.runtime.run(
        request('ask', 'ask'),
        new AbortController().signal,
        authorize
      )
    )
    await vi.waitFor(() =>
      expect(harness.promptGates).toHaveLength(1)
    )

    await expect(
      harness.permission(permission('session-1'))
    ).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' }
    })
    expect(authorize).not.toHaveBeenCalled()
    expect(harness.requests).toContainEqual({
      method: 'goodbuddy/session/prepare',
      params: {
        sessionId: 'session-1',
        requestId: 'request-ask',
        mode: 'ask'
      }
    })
    harness.promptGates[0]!.resolve({ stopReason: 'end_turn' })
    await running
    await harness.runtime.dispose()
  })

  it('authorizes Execute but can select only allow-once', async () => {
    const harness = setup()
    const authorize = vi.fn().mockResolvedValue('always')
    const running = collect(
      harness.runtime.run(
        request('execute'),
        new AbortController().signal,
        authorize
      )
    )
    await vi.waitFor(() =>
      expect(harness.promptGates).toHaveLength(1)
    )

    await expect(
      harness.permission(permission('session-1'))
    ).resolves.toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'allow-once'
      }
    })
    expect(authorize).toHaveBeenCalledWith({
      scopeKey: 'deepseek-harness:shell',
      title: 'Run tests',
      description: 'DeepSeek Harness 请求一次性执行此工具',
      toolName: 'shell',
      argumentSummary: '{\n  "command": "npm test"\n}',
      allowPermanent: false
    })
    harness.promptGates[0]!.resolve({ stopReason: 'end_turn' })
    await running
    await harness.runtime.dispose()
  })

  it('lists only bounded MCP schemas without exposing server secrets', async () => {
    const provider = toolProvider([
      mcpTool(),
      {
        ...mcpTool('workspace_read_text'),
        source: 'builtin'
      }
    ])
    const harness = setup({ toolProvider: provider })
    await harness.runtime.getStatus()

    await expect(
      harness.extension('goodbuddy/tools/list', {
        sessionId: 'session-catalog'
      })
    ).resolves.toEqual({
      tools: [
        {
          name: mcpTool().name,
          description: mcpTool().description,
          inputSchema: mcpTool().inputSchema
        }
      ]
    })
    expect(
      JSON.stringify(
        await harness.extension('goodbuddy/tools/list', {
          sessionId: 'session-catalog'
        })
      )
    ).not.toContain('secret')
    await harness.runtime.dispose()
  })

  it('rejects MCP calls in Ask mode without approval or execution', async () => {
    const provider = toolProvider()
    const harness = setup({ toolProvider: provider })
    const authorize = vi.fn().mockResolvedValue('once')
    const running = collect(
      harness.runtime.run(
        request('mcp-ask', 'ask'),
        new AbortController().signal,
        authorize
      )
    )
    await vi.waitFor(() =>
      expect(harness.promptGates).toHaveLength(1)
    )

    await expect(
      harness.extension('goodbuddy/tools/call', {
        sessionId: 'session-1',
        name: mcpTool().name,
        arguments: { kind: 'cube' }
      })
    ).rejects.toThrow('需要 Execute 模式')
    expect(authorize).not.toHaveBeenCalled()
    expect(provider.callTool).not.toHaveBeenCalled()
    harness.promptGates[0]!.resolve({ stopReason: 'end_turn' })
    await running
    await harness.runtime.dispose()
  })

  it('requires one-time approval before calling an assigned MCP tool', async () => {
    const provider = toolProvider()
    const harness = setup({ toolProvider: provider })
    const authorize = vi.fn().mockResolvedValue('once')
    const running = collect(
      harness.runtime.run(
        request('mcp-execute'),
        new AbortController().signal,
        authorize
      )
    )
    await vi.waitFor(() =>
      expect(harness.promptGates).toHaveLength(1)
    )

    await expect(
      harness.extension('goodbuddy/tools/call', {
        sessionId: 'session-1',
        name: mcpTool().name,
        arguments: { kind: 'cube' }
      })
    ).resolves.toEqual({
      content: [
        { type: 'text', text: '{"asset":"cube"}' }
      ]
    })
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(provider.callTool).toHaveBeenCalledWith(
      mcpTool().name,
      { kind: 'cube' },
      expect.any(AbortSignal),
      expect.objectContaining({
        conversationId: 'mcp-execute',
        workMode: 'execute'
      })
    )
    harness.promptGates[0]!.resolve({ stopReason: 'end_turn' })
    await running
    await harness.runtime.dispose()
  })

  it('lists and calls a real local stdio MCP through the Main proxy', async () => {
    const provider = new ModelToolProvider(process.cwd(), [
      {
        id: 'fbf42200-4e60-48d0-b5f2-e816db38ac54',
        name: 'Local 3D Game Blueprint',
        description: 'Deterministic integration fixture',
        enabled: true,
        allowDynamicTools: false,
        assignments: ['deepseek-harness'],
        secretConfigured: false,
        transport: 'stdio',
        command: process.execPath,
        args: [
          resolve('tests', 'fixtures', 'web-3d-game-mcp.mjs')
        ]
      } satisfies ResolvedMcpServer
    ])
    const harness = setup({
      toolProvider: provider,
      promptTimeoutMs: 10_000
    })
    const authorize = vi.fn().mockResolvedValue('once')
    const running = collect(
      harness.runtime.run(
        request('real-mcp'),
        new AbortController().signal,
        authorize
      )
    )
    await vi.waitFor(() =>
      expect(harness.promptGates).toHaveLength(1)
    )

    try {
      const catalog = await harness.extension(
        'goodbuddy/tools/list',
        { sessionId: 'session-1' }
      )
      const tool = (
        catalog as {
          tools: Array<{
            name: string
            description: string
            inputSchema: Record<string, unknown>
          }>
        }
      ).tools.find((candidate) =>
        candidate.name.endsWith('_create_game_blueprint')
      )
      expect(tool).toMatchObject({
        description: expect.stringContaining(
          'offline WebGL game design'
        ),
        inputSchema: expect.objectContaining({ type: 'object' })
      })

      const result = await harness.extension(
        'goodbuddy/tools/call',
        {
          sessionId: 'session-1',
          name: tool!.name,
          arguments: {
            theme: 'neon-ruins',
            seed: 'goodbuddy-0.9.0',
            targetCount: 5
          }
        }
      )
      expect(result).toMatchObject({
        content: [
          {
            type: 'text',
            text: expect.stringContaining('"title":"Prism Relay"')
          }
        ]
      })
      const blueprint = JSON.parse(
        (
          result as {
            content: [{ type: 'text'; text: string }]
          }
        ).content[0].text
      ) as Record<string, unknown>
      expect(blueprint).toMatchObject({
        acceptance: {
          testSurface: 'window.__GOODBUDDY_GAME__'
        }
      })
      expect(authorize).toHaveBeenCalledOnce()
    } finally {
      harness.promptGates[0]?.resolve({ stopReason: 'end_turn' })
      await running.catch(() => undefined)
      await harness.runtime.dispose()
    }
  })

  it('does not execute an MCP tool when authorization is denied', async () => {
    const provider = toolProvider()
    const harness = setup({ toolProvider: provider })
    const authorize = vi.fn().mockResolvedValue('deny')
    const running = collect(
      harness.runtime.run(
        request('mcp-denied'),
        new AbortController().signal,
        authorize
      )
    )
    await vi.waitFor(() =>
      expect(harness.promptGates).toHaveLength(1)
    )

    await expect(
      harness.extension('goodbuddy/tools/call', {
        sessionId: 'session-1',
        name: mcpTool().name,
        arguments: { kind: 'cube' }
      })
    ).rejects.toThrow('未获执行授权')
    expect(provider.callTool).not.toHaveBeenCalled()
    harness.promptGates[0]!.resolve({ stopReason: 'end_turn' })
    await running
    await harness.runtime.dispose()
  })

  it('validates MCP arguments before requesting authorization', async () => {
    const provider = toolProvider()
    const harness = setup({ toolProvider: provider })
    const authorize = vi.fn().mockResolvedValue('once')
    const running = collect(
      harness.runtime.run(
        request('mcp-invalid'),
        new AbortController().signal,
        authorize
      )
    )
    await vi.waitFor(() =>
      expect(harness.promptGates).toHaveLength(1)
    )

    await expect(
      harness.extension('goodbuddy/tools/call', {
        sessionId: 'session-1',
        name: mcpTool().name,
        arguments: {}
      })
    ).rejects.toThrow('MCP 工具参数无效')
    expect(authorize).not.toHaveBeenCalled()
    expect(provider.callTool).not.toHaveBeenCalled()
    harness.promptGates[0]!.resolve({ stopReason: 'end_turn' })
    await running
    await harness.runtime.dispose()
  })

  it('translates AbortSignal to session/cancel', async () => {
    const harness = setup()
    const controller = new AbortController()
    const running = collect(
      harness.runtime.run(request('abort'), controller.signal)
    )
    await vi.waitFor(() =>
      expect(harness.promptGates).toHaveLength(1)
    )
    controller.abort(new Error('cancelled by user'))
    harness.promptGates[0]!.resolve({ stopReason: 'cancelled' })

    await expect(running).rejects.toThrow('cancelled by user')
    expect(harness.notifications).toContainEqual({
      method: 'session/cancel',
      params: { sessionId: 'session-1' }
    })
    await harness.runtime.dispose()
  })

  it('fails on bounded stderr overflow without exposing stderr text', async () => {
    const harness = setup()
    const running = collect(
      harness.runtime.run(
        request('stderr'),
        new AbortController().signal
      )
    )
    await vi.waitFor(() =>
      expect(harness.promptGates).toHaveLength(1)
    )
    const writer = harness.stderr.writable.getWriter()
    await writer.write(
      new TextEncoder().encode('private-secret-is-too-long')
    )
    await vi.waitFor(() =>
      expect(harness.child.terminate).toHaveBeenCalled()
    )
    harness.promptGates[0]!.resolve({ stopReason: 'end_turn' })

    await expect(running).rejects.toThrow('stderr 超过 16 字节')
    await expect(running).rejects.not.toThrow('private-secret')
    await harness.runtime.dispose()
  })

  it('reports process exit and fully disposes the connection and child', async () => {
    const harness = setup()
    await expect(harness.runtime.getStatus()).resolves.toMatchObject({
      available: true
    })
    harness.exit.resolve({ exitCode: 9 })
    await vi.waitFor(async () => {
      const status = await harness.runtime.getStatus()
      expect(status).toMatchObject({
        available: false,
        detail: 'DeepSeek Harness 进程意外退出（code 9）'
      })
    })

    await harness.runtime.dispose()
    expect(harness.child.terminate).toHaveBeenCalled()
  })

  it('fails closed when the required bridge handshake is unavailable', async () => {
    const harness = setup()
    harness.agent.extMethod.mockRejectedValueOnce(
      new Error('method not found')
    )

    await expect(harness.runtime.getStatus()).resolves.toMatchObject({
      available: false,
      detail: 'method not found'
    })
    expect(harness.child.terminate).toHaveBeenCalled()
  })

  it('times out a prompt, cancels it, and bounds disposal wait', async () => {
    const harness = setup()
    const running = collect(
      harness.runtime.run(
        request('timeout'),
        new AbortController().signal
      )
    )
    await expect(running).rejects.toThrow(
      'DeepSeek Harness 请求超时'
    )
    expect(harness.notifications).toContainEqual({
      method: 'session/cancel',
      params: { sessionId: 'session-1' }
    })
    await expect(harness.runtime.dispose()).resolves.toBeUndefined()
  })
})
