import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import type { RuntimeEvent } from './runtime'
import {
  ModelToolProvider,
  type ModelToolDefinition,
  type ModelToolProviderLike
} from './model-tool-provider'
import { deepSeekHarnessStartupBudget } from './deepseek-harness-control-protocol'
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
    skillPackages?: Array<{ id: string; directory: string }>
    nativeSkills?: Array<Record<string, unknown>>
    nativeTools?: Array<Record<string, unknown>>
    toolsSupported?: boolean
    promptTimeoutMs?: number
    maxEventCharacters?: number
    maxRequestOutputCharacters?: number
    supportsImageInput?: boolean
    advertisedImageInput?: boolean
    initializationTimeoutMs?: number
    useDefaultInitializationTimeout?: boolean
    launchDelayMs?: number
    extensionPackages?: Array<{
      id: string
      entrypoint: string
      configuration: Record<string, unknown>
    }>
    launch?: (
      options: Parameters<
        ConstructorParameters<typeof DeepSeekHarnessRuntime>[0]['launch']
      >[0]
    ) => Promise<DeepSeekHarnessChild>
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
        agentCapabilities: {
          promptCapabilities: {
            image:
              options.advertisedImageInput ??
              (options.supportsImageInput === true)
          }
        }
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
            harnessVersion: '0.1.0-rc.8',
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
        if (method === 'goodbuddy/native/snapshot') {
          return {
            skills: options.nativeSkills ?? [],
            tools: options.nativeTools ?? [],
            toolsSupported: options.toolsSupported ?? true
          }
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
  const launch = vi.fn(
    options.launch ??
      (async () => {
        if (options.launchDelayMs !== undefined) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, options.launchDelayMs)
          )
        }
        return child
      })
  )
  const runtime = new DeepSeekHarnessRuntime({
    defaultWorkspace: 'C:\\workspace',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-test',
    supportsImageInput: options.supportsImageInput,
    launch,
    loadAcpSdk: async () => sdk,
    ...(options.useDefaultInitializationTimeout
      ? {}
      : {
          initializationTimeoutMs:
            options.initializationTimeoutMs ?? 100
        }),
    promptTimeoutMs: options.promptTimeoutMs ?? 100,
    shutdownTimeoutMs: 10,
    maxStderrBytes: 16,
    maxEventCharacters: options.maxEventCharacters,
    maxRequestOutputCharacters:
      options.maxRequestOutputCharacters,
    toolProvider: options.toolProvider,
    skillPackages: options.skillPackages,
    extensionPackages: options.extensionPackages
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

function webTool(
  name: 'web_search' | 'web_fetch' = 'web_search'
): ModelToolDefinition {
  return {
    name,
    displayName: name === 'web_search' ? '联网搜索' : '网页读取',
    description: `Main-owned ${name}`,
    inputSchema: {
      type: 'object',
      properties:
        name === 'web_search'
          ? {
              query: {
                type: 'string',
                minLength: 1,
                maxLength: 1_000
              },
              numResults: {
                type: 'integer',
                minimum: 1,
                maximum: 10,
                default: 6
              }
            }
          : {
              urls: {
                type: 'array',
                minItems: 1,
                maxItems: 5,
                items: { type: 'string', format: 'uri' }
              },
              maxCharacters: {
                type: 'integer',
                minimum: 1,
                maximum: 12_000,
                default: 4_000
              }
            },
      required: [name === 'web_search' ? 'query' : 'urls'],
      additionalProperties: false
    },
    source: 'builtin'
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
  it('includes bounded failed-extension cleanup in the startup budget', () => {
    expect(deepSeekHarnessStartupBudget(11)).toEqual({
      hostTimeoutMs: 76_000,
      mainTimeoutMs: 78_000
    })
    expect(deepSeekHarnessStartupBudget(64)).toEqual({
      hostTimeoutMs: 101_000,
      mainTimeoutMs: 103_000
    })
  })

  it('expands the default launcher deadline for enabled extensions', async () => {
    vi.useFakeTimers()
    try {
      const harness = setup({
        useDefaultInitializationTimeout: true,
        launchDelayMs: 10_001,
        extensionPackages: [
          {
            id: 'slow-one',
            entrypoint: 'C:\\extensions\\slow-one.js',
            configuration: {}
          },
          {
            id: 'slow-two',
            entrypoint: 'C:\\extensions\\slow-two.js',
            configuration: {}
          }
        ]
      })

      const status = harness.runtime.getStatus()
      await vi.advanceTimersByTimeAsync(10_001)

      await expect(status).resolves.toMatchObject({
        available: true
      })
      expect(harness.child.terminate).not.toHaveBeenCalled()
      const disposal = harness.runtime.dispose()
      await vi.advanceTimersByTimeAsync(10)
      await disposal
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the default no-extension launcher deadline bounded', async () => {
    vi.useFakeTimers()
    try {
      let launchSignal: AbortSignal | undefined
      const harness = setup({
        useDefaultInitializationTimeout: true,
        launch: (options) => {
          launchSignal = options.signal
          return new Promise<DeepSeekHarnessChild>(
            () => undefined
          )
        }
      })

      const status = harness.runtime.getStatus()
      await vi.advanceTimersByTimeAsync(12_000)

      await expect(status).resolves.toMatchObject({
        available: false,
        detail: 'DeepSeek Harness 启动超时'
      })
      expect(launchSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts a pending launch and terminates a child returned after disposal', async () => {
    const launch = deferred<DeepSeekHarnessChild>()
    let launchSignal: AbortSignal | undefined
    const harness = setup({
      launch: (options) => {
        launchSignal = options.signal
        return launch.promise
      }
    })

    const status = harness.runtime.getStatus()
    await vi.waitFor(() => expect(harness.launch).toHaveBeenCalledOnce())

    await harness.runtime.dispose()
    expect(launchSignal?.aborted).toBe(true)

    launch.resolve(harness.child)

    await expect(status).resolves.toMatchObject({
      available: false,
      detail: 'DeepSeek Harness Runtime 已关闭'
    })
    expect(harness.child.terminate).toHaveBeenCalledOnce()
  })

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

  it('rejects images before launch when the selected model is text-only', async () => {
    const harness = setup()

    await expect(
      collect(
        harness.runtime.run(
          {
            ...request('text-only-image'),
            images: [
              {
                name: 'reference.png',
                mediaType: 'image/png',
                data: 'aW1hZ2U='
              }
            ]
          },
          new AbortController().signal
        )
      )
    ).rejects.toThrow('未启用图像输入')
    expect(harness.launch).not.toHaveBeenCalled()
  })

  it('forwards inline images when the selected model supports them', async () => {
    const harness = setup({ supportsImageInput: true })
    const running = collect(
      harness.runtime.run(
        {
          ...request('vision'),
          images: [
            {
              name: 'reference.png',
              mediaType: 'image/png',
              data: 'aW1hZ2U='
            }
          ]
        },
        new AbortController().signal
      )
    )
    await vi.waitFor(() =>
      expect(harness.promptGates).toHaveLength(1)
    )

    expect(harness.launch).toHaveBeenCalledWith(
      expect.objectContaining({ supportsImageInput: true })
    )
    expect(
      harness.requests.find(
        (entry) => entry.method === 'session/prompt'
      )?.params
    ).toMatchObject({
      prompt: [
        { type: 'text', text: 'hello' },
        {
          type: 'image',
          mimeType: 'image/png',
          data: 'aW1hZ2U='
        }
      ]
    })
    harness.promptGates[0]!.resolve({ stopReason: 'end_turn' })
    await expect(running).resolves.toContainEqual(
      expect.objectContaining({ type: 'done' })
    )
  })

  it('fails closed when Host image capability disagrees with the model', async () => {
    const harness = setup({
      supportsImageInput: true,
      advertisedImageInput: false
    })

    await expect(harness.runtime.getStatus()).resolves.toMatchObject({
      available: false,
      detail: expect.stringContaining('图片能力')
    })
    expect(harness.child.terminate).toHaveBeenCalled()
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
      supportsImageInput: false,
      credentialRefs: [],
      skillPackages: [],
      extensionPackages: []
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

  it('keeps the original tool name on generic completion updates', async () => {
    const harness = setup()
    const running = collect(
      harness.runtime.run(
        request('tool-events'),
        new AbortController().signal
      )
    )
    await vi.waitFor(() =>
      expect(harness.promptGates).toHaveLength(1)
    )
    await harness.emit('session-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-web-search',
      name: 'web_search',
      status: 'pending',
      rawInput: { query: 'GoodBuddy' }
    })
    await harness.emit('session-1', {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-web-search',
      name: 'tool',
      status: 'completed',
      rawOutput: 'search result'
    })
    harness.promptGates[0]!.resolve({ stopReason: 'end_turn' })

    expect(await running).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool',
          callId: 'call-web-search',
          name: 'web_search',
          state: 'pending'
        }),
        expect.objectContaining({
          type: 'tool',
          callId: 'call-web-search',
          name: 'web_search',
          state: 'completed'
        })
      ])
    )
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

  it('lists only bounded Main proxy schemas without exposing server secrets', async () => {
    const provider = toolProvider([
      mcpTool(),
      webTool(),
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
        },
        {
          name: 'web_search',
          description: webTool().description,
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              numResults: {
                type: 'integer',
                default: 6
              }
            },
            required: ['query'],
            additionalProperties: false
          }
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

  it('exposes and calls Main-owned web tools in Ask without approval', async () => {
    const provider = toolProvider([
      webTool('web_search'),
      webTool('web_fetch'),
      mcpTool()
    ])
    const harness = setup({ toolProvider: provider })
    const authorize = vi.fn().mockResolvedValue('once')
    const running = collect(
      harness.runtime.run(
        request('web-ask', 'ask'),
        new AbortController().signal,
        authorize
      )
    )
    await vi.waitFor(() =>
      expect(harness.promptGates).toHaveLength(1)
    )

    await expect(
      harness.extension('goodbuddy/tools/list', {
        sessionId: 'session-1'
      })
    ).resolves.toEqual({
      tools: [
        expect.objectContaining({ name: 'web_search' }),
        expect.objectContaining({ name: 'web_fetch' })
      ]
    })
    await expect(
      harness.extension('goodbuddy/tools/call', {
        sessionId: 'session-1',
        name: 'web_search',
        arguments: { query: 'GoodBuddy' }
      })
    ).resolves.toEqual({
      content: [
        { type: 'text', text: '{"asset":"cube"}' }
      ]
    })
    expect(authorize).not.toHaveBeenCalled()
    expect(provider.getApproval).not.toHaveBeenCalled()
    expect(provider.callTool).toHaveBeenCalledWith(
      'web_search',
      { query: 'GoodBuddy' },
      expect.any(AbortSignal),
      expect.objectContaining({
        conversationId: 'web-ask',
        workMode: 'ask'
      })
    )
    harness.promptGates[0]!.resolve({ stopReason: 'end_turn' })
    await running
    await harness.runtime.dispose()
  })

  it('filters GoodBuddy assignments from the native Host inventory', async () => {
    const harness = setup({
      skillPackages: [
        { id: 'assigned-skill', directory: 'C:\\assigned' }
      ],
      nativeSkills: [
        {
          id: 'assigned-skill',
          name: 'Assigned Skill',
          description: 'GoodBuddy assignment',
          source: 'bundled',
          provider: 'runtime'
        },
        {
          id: 'plugin-skill',
          name: 'Plugin Skill',
          description: 'Host plugin contribution',
          source: 'custom',
          provider: 'third-party-plugin'
        }
      ],
      nativeTools: [
        {
          id: 'read',
          name: 'read',
          description: 'Read a workspace file'
        },
        {
          id: 'edit',
          name: 'edit',
          description: 'Edit a workspace file'
        },
        {
          id: 'plugin_tool',
          name: 'plugin_tool',
          description: 'Plugin capability'
        }
      ]
    })

    await expect(harness.runtime.getNativeSnapshot()).resolves.toEqual({
      provider: 'deepseek-harness',
      available: true,
      inventoryStatus: 'available',
      detail: expect.stringContaining('GoodBuddy'),
      agents: [],
      toolsSupported: true,
      tools: [
        {
          id: 'read',
          name: 'read',
          description: 'Read a workspace file',
          kind: 'read',
          source: 'runtime',
          ask: 'allowed',
          execute: 'allowed'
        },
        {
          id: 'edit',
          name: 'edit',
          description: 'Edit a workspace file',
          kind: 'write',
          source: 'runtime',
          ask: 'blocked',
          execute: 'allowed'
        },
        {
          id: 'plugin_tool',
          name: 'plugin_tool',
          description: 'Plugin capability',
          kind: 'other',
          source: 'plugin',
          ask: 'blocked',
          execute: 'allowed'
        }
      ],
      commands: [],
      lsp: [],
      formatters: [],
      mcpServers: [],
      skills: [
        {
          id: 'plugin-skill',
          name: 'Plugin Skill',
          description: 'Host plugin contribution',
          source: 'plugin'
        }
      ],
      rules: [],
      prompts: [],
      resources: [],
      resourcesSupported: false,
      context: {
        strategy: 'unsupported',
        manualCompact: false,
        detail: expect.any(String)
      }
    })
    await harness.runtime.dispose()
  })

  it('reports a partial native inventory when Host tool discovery is unavailable', async () => {
    const harness = setup({ toolsSupported: false })

    await expect(harness.runtime.getNativeSnapshot()).resolves.toMatchObject({
      available: true,
      inventoryStatus: 'partial',
      tools: [],
      toolsSupported: false
    })
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
