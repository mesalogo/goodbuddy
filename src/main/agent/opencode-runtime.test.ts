import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import type { createOpencodeClient } from '@opencode-ai/sdk'
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
    expect(createClient).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:43210',
      directory: process.cwd()
    })

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
          apiKey: 'private-key'
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
      for (const name of isolatedNames) {
        expect(spawnOptions?.env).not.toHaveProperty(name)
      }
      expect(spawnOptions?.env).toMatchObject({
        DO_NOT_TRACK: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_EMBEDDED_WEB_UI: '1',
        OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_DISABLE_SHARE: '1',
        OTEL_EXPORTER_OTLP_ENDPOINT: '',
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
      body: {
        name: 'goodbuddy-d2ef774b-146c-4467-a909-6feb112a9c2c',
        config: {
          type: 'local',
          command: ['node', 'server.js'],
          enabled: true,
          timeout: 10_000
        }
      },
      query: { directory: process.cwd() }
    })
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          system: '# 文档写作',
          tools: {
            read: false,
            write: false,
            'goodbuddy-mcp': false
          },
          parts: [{ type: 'text', text: 'test' }]
        }
      })
    )
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    await runtime.dispose()
    expect(mcpDisconnect).toHaveBeenCalledOnce()
  })
})
