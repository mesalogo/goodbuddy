import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import type { createOpencodeClient } from '@opencode-ai/sdk/v2'
import type spawn from 'cross-spawn'
import { describe, expect, it, vi } from 'vitest'
import {
  OpenCodeRuntime,
  type OpenCodeRuntimeDependencies
} from './opencode-runtime'

type SpawnedProcess = ReturnType<typeof spawn>

function fakeChild(pid = 42): SpawnedProcess {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    exitCode: number | null
    killed: boolean
    pid: number
    kill: ReturnType<typeof vi.fn>
    unref: ReturnType<typeof vi.fn>
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.killed = false
  child.pid = pid
  child.kill = vi.fn(() => {
    child.killed = true
    queueMicrotask(() => {
      child.exitCode = 0
      child.emit('close', 0, null)
    })
    return true
  })
  child.unref = vi.fn(() => child)
  return child as unknown as SpawnedProcess
}

function fakeClient() {
  return {
    session: {
      list: vi.fn().mockResolvedValue({ data: [], error: undefined })
    }
  } as unknown as ReturnType<typeof createOpencodeClient>
}

function stdoutOf(child: SpawnedProcess): PassThrough {
  return child.stdout as PassThrough
}

function stderrOf(child: SpawnedProcess): PassThrough {
  return child.stderr as PassThrough
}

function closeChild(child: SpawnedProcess, code: number): void {
  ;(child as unknown as { exitCode: number | null }).exitCode = code
  child.emit('close', code, null)
}

function options(
  overrides: Partial<ConstructorParameters<typeof OpenCodeRuntime>[0]> = {}
): ConstructorParameters<typeof OpenCodeRuntime>[0] {
  return {
    embedded: true,
    binaryPath: '',
    configPath: '',
    defaultWorkspace: process.cwd(),
    ...overrides
  }
}

function dependencies(
  child: SpawnedProcess,
  overrides: Partial<OpenCodeRuntimeDependencies> = {}
): {
  deps: Partial<OpenCodeRuntimeDependencies>
  spawnMock: ReturnType<typeof vi.fn>
  detectBinary: ReturnType<typeof vi.fn>
  createClient: ReturnType<typeof vi.fn>
} {
  const spawnMock = vi.fn(() => child)
  const detectBinary = vi.fn().mockResolvedValue({
    path: 'opencode',
    detail: 'OpenCode CLI 已就绪'
  })
  const createClient = vi.fn(() => fakeClient())
  return {
    deps: {
      spawn: spawnMock as unknown as typeof spawn,
      detectBinary,
      createClient: createClient as unknown as typeof createOpencodeClient,
      platform: 'linux',
      startupTimeoutMs: 100,
      ...overrides
    },
    spawnMock,
    detectBinary,
    createClient
  }
}

function permissionEvent(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'event-1',
    type: 'permission.asked',
    properties: {
      id: 'permission-1',
      sessionID: 'session-1',
      permission: 'bash',
      patterns: ['npm test'],
      metadata: { command: 'npm test' },
      always: ['npm test'],
      ...overrides
    }
  }
}

function runClient(events: Record<string, unknown>[]) {
  const callOrder: string[] = []
  const permissionReply = vi.fn().mockResolvedValue({
    data: true,
    error: undefined
  })
  const client = {
    session: {
      list: vi.fn().mockResolvedValue({ data: [], error: undefined }),
      create: vi.fn().mockResolvedValue({
        data: { id: 'session-1' },
        error: undefined
      }),
      update: vi.fn().mockResolvedValue({
        data: { id: 'session-1' },
        error: undefined
      }),
      promptAsync: vi.fn().mockImplementation(async () => {
        callOrder.push('prompt')
        return { data: true, error: undefined }
      }),
      abort: vi.fn().mockResolvedValue({
        data: true,
        error: undefined
      }),
      delete: vi.fn().mockResolvedValue({
        data: true,
        error: undefined
      })
    },
    event: {
      subscribe: vi.fn().mockImplementation(async () => {
        callOrder.push('subscribe')
        return {
          stream: (async function* () {
            for (const event of events) {
              yield event
            }
          })()
        }
      })
    },
    permission: {
      reply: permissionReply
    },
    mcp: {
      add: vi.fn().mockResolvedValue({ data: true, error: undefined }),
      disconnect: vi
        .fn()
        .mockResolvedValue({ data: true, error: undefined })
    },
    tool: {
      ids: vi.fn().mockResolvedValue({
        data: ['read', 'write', 'bash', 'task'],
        error: undefined
      })
    }
  } as unknown as ReturnType<typeof createOpencodeClient>
  return {
    client,
    callOrder,
    permissionReply,
    session: client.session,
    event: client.event,
    tool: client.tool
  }
}

function embeddedRuntime(
  client: ReturnType<typeof createOpencodeClient>
): OpenCodeRuntime {
  const child = fakeChild()
  const { deps } = dependencies(child, {
    createClient: vi.fn(
      () => client
    ) as unknown as typeof createOpencodeClient
  })
  setTimeout(() => {
    stdoutOf(child).write(
      'opencode server listening on http://127.0.0.1:4010\n'
    )
  }, 0)
  return new OpenCodeRuntime(options(), deps)
}

async function collectRun(runtime: OpenCodeRuntime, workMode: 'ask' | 'plan' | 'execute' = 'execute', authorize?: Parameters<OpenCodeRuntime['run']>[2]) {
  const events = []
  for await (const event of runtime.run(
    {
      requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
      conversationId: 'conversation-1',
      prompt: 'test',
      workMode
    },
    new AbortController().signal,
    authorize
  )) {
    events.push(event)
  }
  return events
}

describe('OpenCodeRuntime embedded launcher', () => {
  it('uses the detected binary and passes an absolute config path only through env', async () => {
    const serverChild = fakeChild(314)
    const killerChild = fakeChild(315)
    const detectBinary = vi.fn().mockResolvedValue({
      path: 'C:\\Tools\\opencode.exe',
      detail: 'OpenCode CLI 已就绪'
    })
    const createClient = vi.fn(() => fakeClient())
    const spawnMock = vi.fn((command: string) => {
      if (command === 'taskkill.exe') {
        queueMicrotask(() => {
          closeChild(serverChild, 0)
        })
        return killerChild
      }
      setTimeout(() => {
        stdoutOf(serverChild).write(
          'opencode server listening securely on http://127.0.0.1:43210\n'
        )
      }, 0)
      return serverChild
    })
    const configPath = './private/opencode.json'
    const runtime = new OpenCodeRuntime(
      options({
        binaryPath: 'C:\\Configured\\opencode.exe',
        configPath
      }),
      {
        spawn: spawnMock as unknown as typeof spawn,
        detectBinary,
        createClient: createClient as unknown as typeof createOpencodeClient,
        platform: 'win32'
      }
    )

    await expect(runtime.getStatus()).resolves.toMatchObject({
      available: true,
      detail: '由 GoodBuddy 管理本机 OpenCode 进程'
    })
    expect(detectBinary).toHaveBeenCalledWith(
      'opencode',
      'C:\\Configured\\opencode.exe',
      undefined
    )
    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      'C:\\Tools\\opencode.exe',
      [
        'serve',
        '--hostname=127.0.0.1',
        expect.stringMatching(/^--port=\d+$/u)
      ],
      expect.objectContaining({
        cwd: process.cwd(),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: expect.objectContaining({
          OPENCODE_CONFIG: resolve(configPath)
        })
      })
    )
    const clientOptions = (
      createClient.mock.calls as unknown as Array<
        [
          {
            baseUrl?: string
            directory?: string
            headers?: Record<string, string>
          }
        ]
      >
    )[0]?.[0] as
      | {
          baseUrl?: string
          directory?: string
          headers?: Record<string, string>
        }
      | undefined
    expect(clientOptions).toMatchObject({
      baseUrl: 'http://127.0.0.1:43210',
      directory: process.cwd(),
      headers: {
        Authorization: expect.stringMatching(/^Basic /u)
      }
    })
    const spawnOptions = (
      spawnMock.mock.calls as unknown as Array<
        [string, string[], { env?: NodeJS.ProcessEnv }]
      >
    )[0]?.[2] as
      | { env?: NodeJS.ProcessEnv }
      | undefined
    expect(spawnOptions?.env?.OPENCODE_SERVER_USERNAME).toBe(
      'goodbuddy'
    )
    expect(spawnOptions?.env?.OPENCODE_SERVER_PASSWORD).toBeTruthy()
    expect(
      Buffer.from(
        clientOptions?.headers?.Authorization?.slice(6) ?? '',
        'base64'
      ).toString()
    ).toBe(
      `goodbuddy:${spawnOptions?.env?.OPENCODE_SERVER_PASSWORD}`
    )
    expect(runtime.requiresToolApproval).toBe(false)

    await runtime.dispose()

    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'taskkill.exe',
      ['/PID', '314', '/T', '/F'],
      {
        shell: false,
        stdio: 'ignore',
        windowsHide: true
      }
    )
    expect(killerChild.unref).toHaveBeenCalledOnce()
  })

  it('injects an independent model profile without persisting its key', async () => {
    const child = fakeChild()
    const { deps, spawnMock } = dependencies(child)
    setTimeout(() => {
      stdoutOf(child).write(
        'opencode server listening on http://127.0.0.1:3011\n'
      )
    }, 0)
    const runtime = new OpenCodeRuntime(
      options({
        modelProfile: {
          id: '00000000-0000-4000-8000-000000000011',
          name: '独立模型',
          baseUrl: 'https://model.example',
          modelName: 'private-model',
          apiKey: 'private-key',
          protocol: 'anthropic-messages',
          authentication: 'api-key'
        }
      }),
      deps
    )

    await expect(runtime.getStatus()).resolves.toMatchObject({
      available: true
    })
    const spawnOptions = spawnMock.mock.calls[0]?.[2] as
      | { env?: NodeJS.ProcessEnv }
      | undefined
    const config = JSON.parse(
      spawnOptions?.env?.OPENCODE_CONFIG_CONTENT ?? '{}'
    ) as Record<string, unknown>
    expect(config).toMatchObject({
      model: 'anthropic/private-model',
      provider: {
        anthropic: {
          options: {
            apiKey: 'private-key',
            baseURL: 'https://model.example/v1'
          }
        }
      }
    })
    await runtime.dispose()
  })

  it('isolates embedded server configuration from inherited env', async () => {
    const child = fakeChild()
    const { deps, spawnMock } = dependencies(child)
    const isolatedNames = [
      'OPENCODE_CONFIG',
      'OPENCODE_CONFIG_CONTENT',
      'OPENCODE_SERVER_PASSWORD',
      'OPENCODE_SERVER_USERNAME'
    ] as const
    const inherited = Object.fromEntries(
      isolatedNames.map((name) => [name, process.env[name]])
    )
    const inheritedOtel = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    for (const name of isolatedNames) {
      process.env[name] = 'must-not-be-inherited'
    }
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT =
      'https://telemetry.invalid'
    try {
      setTimeout(() => {
        stdoutOf(child).write(
          'opencode server listening on http://127.0.0.1:3010\n'
        )
      }, 0)
      const runtime = new OpenCodeRuntime(options(), deps)
      await expect(runtime.getStatus()).resolves.toMatchObject({
        available: true
      })

      const spawnOptions = spawnMock.mock.calls[0]?.[2] as
        | { env?: NodeJS.ProcessEnv }
        | undefined
      expect(spawnOptions?.env?.OPENCODE_CONFIG).toBeUndefined()
      expect(spawnOptions?.env?.OPENCODE_CONFIG_CONTENT).toBeUndefined()
      expect(spawnOptions?.env?.OPENCODE_SERVER_USERNAME).toBe(
        'goodbuddy'
      )
      expect(
        spawnOptions?.env?.OPENCODE_SERVER_PASSWORD
      ).not.toBe('must-not-be-inherited')
      expect(spawnOptions?.env).toMatchObject({
        DO_NOT_TRACK: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_EMBEDDED_WEB_UI: '1',
        OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_DISABLE_SHARE: '1',
        OTEL_EXPORTER_OTLP_ENDPOINT: '',
        OTEL_EXPORTER_OTLP_HEADERS: '',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: '',
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: '',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '',
        OTEL_SDK_DISABLED: 'true'
      })
      await runtime.dispose()
    } finally {
      for (const name of isolatedNames) {
        const value = inherited[name]
        if (value === undefined) {
          delete process.env[name]
        } else {
          process.env[name] = value
        }
      }
      if (inheritedOtel === undefined) {
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      } else {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = inheritedOtel
      }
    }
  })

  it.each([
    'https://127.0.0.1:4321',
    'http://0.0.0.0:4321',
    'http://example.com:4321',
    'http://127.0.0.1',
    'http://127.0.0.1:4321/admin'
  ])('rejects an unsafe listening URL: %s', async (url) => {
    const child = fakeChild()
    const { deps, createClient } = dependencies(child)
    setTimeout(() => {
      stdoutOf(child).write(`opencode server listening on ${url}\n`)
      closeChild(child, 7)
    }, 0)
    const runtime = new OpenCodeRuntime(options(), deps)

    await expect(runtime.getStatus()).resolves.toMatchObject({
      available: false,
      detail: 'OpenCode Server 启动前退出（code 7）'
    })
    expect(createClient).not.toHaveBeenCalled()
  })

  it('times out, terminates the process tree, and does not expose stderr', async () => {
    const child = fakeChild()
    const secret = 'private-config-token'
    const { deps } = dependencies(child, { startupTimeoutMs: 5 })
    stderrOf(child).write(secret)
    const runtime = new OpenCodeRuntime(options(), deps)

    const status = await runtime.getStatus()

    expect(status).toMatchObject({
      available: false,
      detail: 'OpenCode Server 启动超时（10 秒）'
    })
    expect(status.detail).not.toContain(secret)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('reports early exit without leaking captured stderr', async () => {
    const child = fakeChild()
    const secret = 'OPENCODE_CONFIG=/secret/config.json'
    const { deps } = dependencies(child)
    setTimeout(() => {
      stderrOf(child).write(secret)
      closeChild(child, 9)
    }, 0)
    const runtime = new OpenCodeRuntime(options(), deps)

    const status = await runtime.getStatus()

    expect(status.detail).toBe('OpenCode Server 启动前退出（code 9）')
    expect(status.detail).not.toContain(secret)
  })

  it('terminates startup when the request is aborted', async () => {
    const child = fakeChild()
    const { deps, spawnMock } = dependencies(child)
    const runtime = new OpenCodeRuntime(options(), deps)
    const controller = new AbortController()
    const stream = runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'test'
      },
      controller.signal
    )

    const pending = stream.next()
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    controller.abort(new Error('sensitive abort reason'))

    await expect(pending).rejects.toThrow('OpenCode Server 启动已取消')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('keeps external baseUrl mode free of binary detection and spawning', async () => {
    const child = fakeChild()
    const { deps, spawnMock, detectBinary, createClient } = dependencies(child)
    const runtime = new OpenCodeRuntime(
      options({
        baseUrl: 'http://127.0.0.1:4096',
        embedded: false
      }),
      deps
    )

    await expect(runtime.getStatus()).resolves.toMatchObject({
      available: true,
      detail: '已连接 http://127.0.0.1:4096'
    })
    expect(detectBinary).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
    expect(createClient).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:4096',
      directory: process.cwd()
    })
    expect(runtime.requiresToolApproval).toBe(true)
  })

  it('loads assigned Skills and MCP servers before prompting', async () => {
    const child = fakeChild()
    const mcpAdd = vi.fn().mockResolvedValue({ error: undefined })
    const mcpDisconnect = vi.fn().mockResolvedValue({ error: undefined })
    const promptAsync = vi.fn().mockResolvedValue({ error: undefined })
    const client = {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'session-1' } }),
        promptAsync,
        abort: vi.fn().mockResolvedValue(undefined)
      },
      event: {
        subscribe: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield {
              type: 'session.idle',
              properties: { sessionID: 'session-1' }
            }
          })()
        })
      },
      mcp: {
        add: mcpAdd,
        disconnect: mcpDisconnect
      },
      tool: {
        ids: vi.fn().mockResolvedValue({
          data: ['read', 'write', 'goodbuddy-mcp'],
          error: undefined
        })
      }
    } as unknown as ReturnType<typeof createOpencodeClient>
    const { deps } = dependencies(child, {
      createClient: vi.fn(
        () => client
      ) as unknown as typeof createOpencodeClient
    })
    const runtime = new OpenCodeRuntime(
      options({
        baseUrl: 'http://127.0.0.1:4096',
        embedded: false,
        skillInstructions: '# 文档写作',
        mcpServers: [
          {
            id: 'd2ef774b-146c-4467-a909-6feb112a9c2c',
            name: 'Local MCP',
            description: '',
            enabled: true,
            assignments: ['opencode'],
            secretConfigured: false,
            transport: 'stdio',
            command: 'node',
            args: ['server.js']
          }
        ]
      }),
      deps
    )

    const events = []
    for await (const event of runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'test',
        workMode: 'ask'
      },
      new AbortController().signal
    )) {
      events.push(event)
    }

    expect(mcpAdd).toHaveBeenCalledWith({
      name: 'goodbuddy-d2ef774b-146c-4467-a909-6feb112a9c2c',
      config: {
        type: 'local',
        command: ['node', 'server.js'],
        enabled: true,
        timeout: 10_000
      },
      directory: process.cwd()
    })
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        system: '# 文档写作',
        tools: {
          read: false,
          write: false,
          'goodbuddy-mcp': false
        },
        parts: [{ type: 'text', text: 'test' }]
      }),
      expect.objectContaining({
        signal: expect.any(AbortSignal)
      })
    )
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    await runtime.dispose()
    expect(mcpDisconnect).toHaveBeenCalledOnce()
  })
})

describe('OpenCodeRuntime embedded permission mediation', () => {
  it('subscribes before prompting and replies once for a session approval', async () => {
    const {
      client,
      callOrder,
      permissionReply,
      session
    } = runClient([
      permissionEvent({ sessionID: 'unrelated-session' }),
      permissionEvent(),
      permissionEvent(),
      {
        id: 'event-text',
        type: 'message.part.delta',
        properties: {
          sessionID: 'session-1',
          messageID: 'message-1',
          partID: 'part-1',
          field: 'text',
          delta: 'approved output'
        }
      },
      {
        id: 'event-idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const runtime = embeddedRuntime(client)
    const authorize = vi.fn().mockResolvedValue('session')

    const events = await collectRun(runtime, 'execute', authorize)

    expect(callOrder).toEqual(['subscribe', 'prompt'])
    expect(session.create).toHaveBeenCalledWith({
      title: 'GoodBuddy 对话',
      directory: process.cwd(),
      permission: [
        { permission: '*', pattern: '*', action: 'ask' },
        { permission: 'task', pattern: '*', action: 'deny' }
      ]
    })
    expect(authorize).toHaveBeenCalledOnce()
    expect(authorize).toHaveBeenCalledWith({
      scopeKey: 'opencode:bash',
      title: 'OpenCode 请求调用 bash',
      description: '仅在你选择允许后，OpenCode 才会执行此工具调用。',
      toolName: 'bash',
      argumentSummary: JSON.stringify({
        patterns: ['npm test'],
        metadata: { command: 'npm test' }
      }),
      allowPermanent: false
    })
    expect(permissionReply).toHaveBeenCalledOnce()
    expect(permissionReply).toHaveBeenCalledWith({
      requestID: 'permission-1',
      directory: process.cwd(),
      reply: 'once'
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'text',
        delta: 'approved output'
      })
    )
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    await runtime.dispose()
  })

  it('uses one tool scope for different requests while preserving their summaries', async () => {
    const { client } = runClient([
      permissionEvent(),
      permissionEvent({
        id: 'permission-2',
        patterns: ['npm run lint'],
        metadata: { command: 'npm run lint' },
        always: ['npm run lint']
      }),
      {
        id: 'event-idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const runtime = embeddedRuntime(client)
    const authorize = vi.fn().mockResolvedValue('session')

    await collectRun(runtime, 'execute', authorize)

    expect(authorize).toHaveBeenCalledTimes(2)
    expect(authorize.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({
        scopeKey: 'opencode:bash',
        argumentSummary: JSON.stringify({
          patterns: ['npm test'],
          metadata: { command: 'npm test' }
        })
      }),
      expect.objectContaining({
        scopeKey: 'opencode:bash',
        argumentSummary: JSON.stringify({
          patterns: ['npm run lint'],
          metadata: { command: 'npm run lint' }
        })
      })
    ])
    await runtime.dispose()
  })

  it('fails the run when a tool reports an error before session idle', async () => {
    const { client, session } = runClient([
      {
        id: 'event-tool-error',
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-1',
          part: {
            id: 'part-1',
            callID: 'call-1',
            type: 'tool',
            tool: 'write',
            state: { status: 'error' }
          }
        }
      },
      {
        id: 'event-idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const runtime = embeddedRuntime(client)

    await expect(collectRun(runtime)).rejects.toThrow(
      'OpenCode 工具执行失败'
    )
    expect(session.abort).toHaveBeenCalledOnce()
    await runtime.dispose()
  })

  it('surfaces a rejected async prompt instead of reporting success', async () => {
    const { client, session } = runClient([
      {
        id: 'event-idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    vi.mocked(session.promptAsync).mockResolvedValueOnce({
      data: undefined,
      error: {
        data: {
          message:
            'prompt rejected Authorization: Bearer secret-token'
        }
      }
    } as never)
    const runtime = embeddedRuntime(client)

    await expect(collectRun(runtime)).rejects.toThrow(
      'prompt rejected Authorization: [REDACTED]'
    )
    await runtime.dispose()
  })

  it('deletes an ephemeral OpenCode session when released', async () => {
    const { client, session } = runClient([
      {
        id: 'event-idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const runtime = embeddedRuntime(client)

    await collectRun(runtime)
    await runtime.releaseConversation('conversation-1')

    expect(session.delete).toHaveBeenCalledWith({
      sessionID: 'session-1',
      directory: process.cwd()
    })
    await runtime.dispose()
  })

  it.each(['deny', 'permanent'] as const)(
    'rejects an OpenCode permission after a %s decision',
    async (decision) => {
      const { client, permissionReply } = runClient([
        permissionEvent(),
        {
          id: 'event-idle',
          type: 'session.idle',
          properties: { sessionID: 'session-1' }
        }
      ])
      const runtime = embeddedRuntime(client)

      await collectRun(
        runtime,
        'execute',
        vi.fn().mockResolvedValue(decision)
      )

      expect(permissionReply).toHaveBeenCalledWith({
        requestID: 'permission-1',
        directory: process.cwd(),
        reply: 'reject'
      })
      await runtime.dispose()
    }
  )

  it('ignores unrelated requests and rejects bounded malformed requests without prompting', async () => {
    const { client, permissionReply } = runClient([
      permissionEvent({ sessionID: 'unrelated-session' }),
      permissionEvent({
        patterns: Array.from({ length: 33 }, () => '*')
      }),
      {
        id: 'event-idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const runtime = embeddedRuntime(client)
    const authorize = vi.fn().mockResolvedValue('once')

    await collectRun(runtime, 'execute', authorize)

    expect(authorize).not.toHaveBeenCalled()
    expect(permissionReply).toHaveBeenCalledOnce()
    expect(permissionReply).toHaveBeenCalledWith({
      requestID: 'permission-1',
      directory: process.cwd(),
      reply: 'reject'
    })
    await runtime.dispose()
  })

  it('fails closed when the OpenCode permission reply fails', async () => {
    const { client, permissionReply, session } = runClient([
      permissionEvent()
    ])
    permissionReply.mockResolvedValue({
      data: false,
      error: { message: 'secret server error' }
    })
    const runtime = embeddedRuntime(client)

    await expect(
      collectRun(
        runtime,
        'execute',
        vi.fn().mockResolvedValue('once')
      )
    ).rejects.toThrow('OpenCode 权限回复失败')
    expect(session.abort).toHaveBeenCalledWith({
      sessionID: 'session-1',
      directory: process.cwd()
    })
    await runtime.dispose()
  })

  it('rejects a pending permission and aborts the session on cancellation', async () => {
    const { client, permissionReply, session } = runClient([
      permissionEvent()
    ])
    const runtime = embeddedRuntime(client)
    const controller = new AbortController()
    const authorize = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true }
          )
        })
    )
    const stream = runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'test',
        workMode: 'execute'
      },
      controller.signal,
      authorize
    )

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'status' }
    })
    const pending = stream.next()
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce())
    controller.abort()

    await expect(pending).rejects.toThrow('cancelled')
    expect(permissionReply).toHaveBeenCalledWith({
      requestID: 'permission-1',
      directory: process.cwd(),
      reply: 'reject'
    })
    expect(session.abort).toHaveBeenCalledWith({
      sessionID: 'session-1',
      directory: process.cwd()
    })
    await runtime.dispose()
  })

  it.each(['ask', 'plan'] as const)(
    'uses deny-all session rules and hard tool disable in %s mode',
    async (workMode) => {
      const { client, session, tool } = runClient([
        {
          id: 'event-idle',
          type: 'session.idle',
          properties: { sessionID: 'session-1' }
        }
      ])
      const runtime = embeddedRuntime(client)

      await collectRun(runtime, workMode)

      expect(session.create).toHaveBeenCalledWith({
        title: 'GoodBuddy 对话',
        directory: process.cwd(),
        permission: [
          { permission: '*', pattern: '*', action: 'deny' }
        ]
      })
      expect(tool.ids).toHaveBeenCalledWith({
        directory: process.cwd()
      })
      expect(session.promptAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: {
            read: false,
            write: false,
            bash: false,
            task: false
          }
        }),
        expect.anything()
      )
      await runtime.dispose()
    }
  )

  it('updates reused sessions when the work mode changes', async () => {
    const { client, session } = runClient([
      {
        id: 'event-idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const runtime = embeddedRuntime(client)

    await collectRun(runtime, 'execute')
    await collectRun(runtime, 'ask')

    expect(session.update).toHaveBeenCalledWith({
      sessionID: 'session-1',
      directory: process.cwd(),
      permission: [
        { permission: '*', pattern: '*', action: 'deny' }
      ]
    })
    await runtime.dispose()
  })

  it('leaves external sessions unmodified for the controller whole-run gate', async () => {
    const { client, session, permissionReply } = runClient([
      permissionEvent(),
      {
        id: 'event-idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const runtime = new OpenCodeRuntime(
      options({
        baseUrl: 'http://127.0.0.1:4096',
        embedded: false
      }),
      {
        createClient: vi.fn(
          () => client
        ) as unknown as typeof createOpencodeClient
      }
    )
    const authorize = vi.fn().mockResolvedValue('once')

    await collectRun(runtime, 'execute', authorize)

    expect(runtime.requiresToolApproval).toBe(true)
    expect(session.create).toHaveBeenCalledWith({
      title: 'GoodBuddy 对话',
      directory: process.cwd()
    })
    expect(authorize).not.toHaveBeenCalled()
    expect(permissionReply).not.toHaveBeenCalled()
    await runtime.dispose()
  })
})

describe('OpenCodeRuntime model usage', () => {
  it('emits one provider-reported usage event for each terminal assistant message', async () => {
    const assistantMessage = {
      id: 'message-assistant-1',
      sessionID: 'session-1',
      role: 'assistant',
      time: {
        created: 1,
        completed: 2
      },
      parentID: 'message-user-1',
      modelID: 'claude-sonnet-provider',
      providerID: 'anthropic',
      mode: 'build',
      agent: 'build',
      path: {
        cwd: process.cwd(),
        root: process.cwd()
      },
      cost: 0.01,
      tokens: {
        total: 42,
        input: 23,
        output: 11,
        reasoning: 3,
        cache: {
          read: 7,
          write: 5
        }
      }
    }
    const { client } = runClient([
      {
        id: 'event-incomplete',
        type: 'message.updated',
        properties: {
          sessionID: 'session-1',
          info: {
            ...assistantMessage,
            time: { created: 1 }
          }
        }
      },
      {
        id: 'event-terminal',
        type: 'message.updated',
        properties: {
          sessionID: 'session-1',
          info: assistantMessage
        }
      },
      {
        id: 'event-terminal-duplicate',
        type: 'message.updated',
        properties: {
          sessionID: 'session-1',
          info: assistantMessage
        }
      },
      {
        id: 'event-idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const runtime = embeddedRuntime(client)

    const events = await collectRun(runtime)

    expect(
      events.filter((event) => event.type === 'model-usage')
    ).toEqual([
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        type: 'model-usage',
        callId: 'message-assistant-1',
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-provider',
        inputTokens: 23,
        outputTokens: 11,
        cacheReadTokens: 7,
        cacheWriteTokens: 5,
        reportedTotalTokens: 42
      }
    ])
    expect(events.at(-2)).toMatchObject({ type: 'model-usage' })
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    await runtime.dispose()
  })

  it('ignores assistant usage from another session', async () => {
    const { client } = runClient([
      {
        id: 'event-unrelated-usage',
        type: 'message.updated',
        properties: {
          sessionID: 'session-2',
          info: {
            id: 'message-assistant-2',
            sessionID: 'session-2',
            role: 'assistant',
            time: {
              created: 1,
              completed: 2
            },
            parentID: 'message-user-2',
            modelID: 'unrelated-model',
            providerID: 'unrelated-provider',
            mode: 'build',
            agent: 'build',
            path: {
              cwd: process.cwd(),
              root: process.cwd()
            },
            cost: 0,
            tokens: {
              input: 100,
              output: 50,
              reasoning: 0,
              cache: {
                read: 0,
                write: 0
              }
            }
          }
        }
      },
      {
        id: 'event-idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const runtime = embeddedRuntime(client)

    const events = await collectRun(runtime)

    expect(
      events.filter((event) => event.type === 'model-usage')
    ).toEqual([])
    await runtime.dispose()
  })
})
