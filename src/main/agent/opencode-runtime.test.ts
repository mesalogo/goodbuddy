import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import type { createOpencodeClient } from '@opencode-ai/sdk/v2'
import type spawn from 'cross-spawn'
import { describe, expect, it, vi } from 'vitest'
import type { KnowledgeMcpGateway } from './knowledge-mcp-gateway'
import type { RuntimeEvent } from './runtime'
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
  validateBinary: ReturnType<typeof vi.fn>
  createClient: ReturnType<typeof vi.fn>
  checkServerHealth: ReturnType<typeof vi.fn>
} {
  const spawnMock = vi.fn(() => child)
  const detectBinary = vi.fn().mockResolvedValue({
    path: 'opencode',
    detail: 'OpenCode CLI 已就绪'
  })
  const validateBinary = vi.fn().mockResolvedValue({
    path: 'opencode',
    detail: 'OpenCode CLI 已就绪'
  })
  const createClient = vi.fn(() => fakeClient())
  const checkServerHealth = vi.fn().mockResolvedValue(true)
  return {
    deps: {
      spawn: spawnMock as unknown as typeof spawn,
      detectBinary,
      validateBinary,
      createClient: createClient as unknown as typeof createOpencodeClient,
      checkServerHealth,
      platform: 'linux',
      startupTimeoutMs: 100,
      ...overrides
    },
    spawnMock,
    detectBinary,
    validateBinary,
    createClient,
    checkServerHealth
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
      tool: {
        messageID: 'message-1',
        callID: 'call-1'
      },
      ...overrides
    }
  }
}

function completedToolEvent(
  callId = 'call-1',
  tool = 'bash'
): Record<string, unknown> {
  return {
    id: `event-tool-${callId}`,
    type: 'message.part.updated',
    properties: {
      sessionID: 'session-1',
      part: {
        id: `part-${callId}`,
        callID: callId,
        type: 'tool',
        tool,
        state: {
          status: 'completed',
          input: {
            command: 'npm test',
            token: 'visible-token'
          },
          output: 'Tests passed\nAuthorization: Bearer secret-token'
        }
      }
    }
  }
}

function runClient(events: Record<string, unknown>[]) {
  const callOrder: string[] = []
  const permissionReply = vi.fn().mockResolvedValue({
    data: true,
    error: undefined
  })
  const questionReply = vi.fn().mockResolvedValue({
    data: true,
    error: undefined
  })
  const questionReject = vi.fn().mockResolvedValue({
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
    question: {
      reply: questionReply,
      reject: questionReject
    },
    mcp: {
      add: vi
        .fn()
        .mockImplementation(
          async (input: { name: string }) => ({
            data: {
              [input.name]: { status: 'connected' }
            },
            error: undefined
          })
        ),
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
    questionReply,
    questionReject,
    session: client.session,
    event: client.event,
    tool: client.tool
  }
}

function embeddedRuntime(
  client: ReturnType<typeof createOpencodeClient>,
  overrides: Partial<
    ConstructorParameters<typeof OpenCodeRuntime>[0]
  > = {},
  dependencyOverrides: Partial<OpenCodeRuntimeDependencies> = {}
): OpenCodeRuntime {
  const child = fakeChild()
  const { deps } = dependencies(child, {
    ...dependencyOverrides,
    createClient: vi.fn(
      () => client
    ) as unknown as typeof createOpencodeClient
  })
  return new OpenCodeRuntime(options(overrides), deps)
}

async function collectRun(
  runtime: OpenCodeRuntime,
  workMode: 'ask' | 'execute' = 'execute'
) {
  const events = []
  for await (const event of runtime.run(
    {
      requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
      conversationId: 'conversation-1',
      prompt: 'test',
      workMode
    },
    new AbortController().signal
  )) {
    events.push(event)
  }
  return events
}

describe('OpenCodeRuntime embedded launcher', () => {
  it('checks embedded availability without starting OpenCode', async () => {
    const child = fakeChild()
    const {
      deps,
      spawnMock,
      detectBinary,
      validateBinary,
      createClient,
      checkServerHealth
    } = dependencies(child)
    const runtime = new OpenCodeRuntime(options(), deps)

    await expect(runtime.getStatus()).resolves.toMatchObject({
      available: true,
      detail: 'OpenCode 已配置，将在首次使用时启动'
    })
    expect(detectBinary).toHaveBeenCalledWith(
      'opencode',
      '',
      undefined
    )
    expect(validateBinary).toHaveBeenCalledWith(
      'opencode',
      'opencode'
    )
    expect(spawnMock).not.toHaveBeenCalled()
    expect(createClient).not.toHaveBeenCalled()
    expect(checkServerHealth).not.toHaveBeenCalled()

    await runtime.dispose()
  })

  it('reports an unavailable embedded binary without starting OpenCode', async () => {
    const child = fakeChild()
    const {
      deps,
      spawnMock,
      detectBinary,
      validateBinary,
      createClient,
      checkServerHealth
    } = dependencies(child)
    detectBinary.mockResolvedValueOnce({
      path: '/missing/opencode',
      detail: 'OpenCode CLI 已就绪'
    })
    validateBinary.mockResolvedValueOnce({
      detail: 'OpenCode CLI 未找到'
    })
    const runtime = new OpenCodeRuntime(
      options({
        binaryPath: '/missing/opencode',
        bundledBinaryPath: '/bundled/opencode'
      }),
      deps
    )

    await expect(runtime.getStatus()).resolves.toEqual({
      id: 'opencode',
      label: 'OpenCode',
      available: false,
      supportsToolExecution: true,
      detail: 'OpenCode CLI 未找到'
    })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(detectBinary).toHaveBeenCalledWith(
      'opencode',
      '/missing/opencode',
      '/bundled/opencode'
    )
    expect(validateBinary).toHaveBeenCalledWith(
      'opencode',
      '/missing/opencode'
    )
    expect(createClient).not.toHaveBeenCalled()
    expect(checkServerHealth).not.toHaveBeenCalled()

    await runtime.dispose()
  })

  it('reports a missing embedded model credential without starting OpenCode', async () => {
    const child = fakeChild()
    const {
      deps,
      spawnMock,
      detectBinary,
      validateBinary,
      createClient,
      checkServerHealth
    } = dependencies(child)
    const runtime = new OpenCodeRuntime(
      options({
        modelProfile: {
          id: '00000000-0000-4000-8000-000000000011',
          name: 'Independent model',
          baseUrl: 'https://model.example',
          modelName: 'private-model',
          protocol: 'anthropic-messages',
          authentication: 'api-key'
        }
      }),
      deps
    )

    await expect(runtime.getStatus()).resolves.toEqual({
      id: 'opencode',
      label: 'OpenCode',
      available: false,
      supportsToolExecution: true,
      detail: 'OpenCode 独立模型连接尚未配置 API Key'
    })
    expect(detectBinary).not.toHaveBeenCalled()
    expect(validateBinary).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
    expect(createClient).not.toHaveBeenCalled()
    expect(checkServerHealth).not.toHaveBeenCalled()

    await runtime.dispose()
  })

  it('uses the detected binary and passes an absolute config path only through env', async () => {
    const serverChild = fakeChild(314)
    const killerChild = fakeChild(315)
    const detectBinary = vi.fn().mockResolvedValue({
      path: 'C:\\Tools\\opencode.exe',
      detail: 'OpenCode CLI 已就绪'
    })
    const createClient = vi.fn(() => fakeClient())
    const checkServerHealth = vi.fn().mockResolvedValue(true)
    const spawnMock = vi.fn((command: string) => {
      if (command === 'taskkill.exe') {
        queueMicrotask(() => {
          closeChild(serverChild, 0)
        })
        return killerChild
      }
      return serverChild
    })
    const configPath = './private/opencode.json'
    const runtime = new OpenCodeRuntime(
      options({
        binaryPath: 'C:\\Configured\\opencode.exe',
        configPath,
        launchEnvironmentProvider: () =>
          Object.freeze({
            PATH: 'C:\\GoodBuddy\\tools;C:\\Windows',
            OPENAI_API_KEY: 'must-not-leak',
            ELECTRON_RUN_AS_NODE: '1'
          })
      }),
      {
        spawn: spawnMock as unknown as typeof spawn,
        detectBinary,
        createClient: createClient as unknown as typeof createOpencodeClient,
        checkServerHealth,
        platform: 'win32'
      }
    )

    await expect(runtime.testConnection()).resolves.toMatchObject({
      available: true,
      detail:
        '由 GoodBuddy 以当前用户权限管理本机 OpenCode 进程'
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
    const firstSpawn = spawnMock.mock.calls[0] as unknown as
      | [string, string[]]
      | undefined
    const serverPort = firstSpawn?.[1]
      ?.find((argument) => argument.startsWith('--port='))
      ?.slice('--port='.length)
    expect(serverPort).toMatch(/^\d+$/u)
    const serverUrl = `http://127.0.0.1:${serverPort}`
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
      baseUrl: serverUrl,
      directory: process.cwd(),
      headers: {
        Authorization: expect.stringMatching(/^Basic /u)
      }
    })
    expect(checkServerHealth).toHaveBeenCalledWith(
      serverUrl,
      clientOptions?.headers?.Authorization,
      expect.any(AbortSignal)
    )
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
    expect(spawnOptions?.env?.PATH).toBe(
      'C:\\GoodBuddy\\tools;C:\\Windows'
    )
    expect(spawnOptions?.env).not.toHaveProperty(
      'ELECTRON_RUN_AS_NODE'
    )
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

  it('registers only assigned Skill packages in an isolated config directory', async () => {
    const sourceRoot = await mkdtemp(
      join(tmpdir(), 'goodbuddy-opencode-skill-source-')
    )
    const skillDirectory = join(sourceRoot, 'longdoc-docx')
    await mkdir(join(skillDirectory, 'templates'), {
      recursive: true
    })
    await writeFile(
      join(skillDirectory, 'SKILL.md'),
      [
        '---',
        'id: longdoc-docx',
        'name: 长文档',
        'description: Build a DOCX',
        '---',
        '',
        '# Long document'
      ].join('\n'),
      'utf8'
    )
    await writeFile(
      join(skillDirectory, 'templates', 'document.txt'),
      'template',
      'utf8'
    )
    const child = fakeChild()
    const { deps, spawnMock } = dependencies(child)
    const runtime = new OpenCodeRuntime(
      options({
        skillPackages: [
          {
            id: 'longdoc-docx',
            directory: skillDirectory
          }
        ]
      }),
      deps
    )

    await expect(runtime.testConnection()).resolves.toMatchObject({
      available: true
    })
    const spawnOptions = spawnMock.mock.calls[0]?.[2] as
      | { env?: NodeJS.ProcessEnv }
      | undefined
    const configDirectory = spawnOptions?.env?.OPENCODE_CONFIG_DIR
    expect(configDirectory).toBeTruthy()
    const registrationRoot = resolve(configDirectory!, '..')
    const registeredSkill = join(
      configDirectory!,
      'skills',
      'longdoc-docx'
    )
    try {
      await expect(
        readFile(
          join(registeredSkill, 'templates', 'document.txt'),
          'utf8'
        )
      ).resolves.toBe('template')
      const registeredManifest = await readFile(
        join(registeredSkill, 'SKILL.md'),
        'utf8'
      )
      expect(registeredManifest).toContain('name: longdoc-docx')
      expect(registeredManifest).not.toContain('id: longdoc-docx')
      const config = JSON.parse(
        spawnOptions?.env?.OPENCODE_CONFIG_CONTENT ?? '{}'
      ) as Record<string, unknown>
      expect(config).toEqual({
        skills: {
          paths: [join(configDirectory!, 'skills')],
          urls: []
        },
        permission: {
          skill: {
            '*': 'deny',
            'longdoc-docx': 'allow'
          }
        }
      })
      expect(spawnOptions?.env).toMatchObject({
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
        OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        XDG_CACHE_HOME: join(registrationRoot, 'xdg-cache'),
        XDG_CONFIG_HOME: join(registrationRoot, 'xdg-config'),
        XDG_DATA_HOME: join(registrationRoot, 'xdg-data'),
        XDG_STATE_HOME: join(registrationRoot, 'xdg-state')
      })
    } finally {
      await runtime.dispose()
      await rm(sourceRoot, { recursive: true, force: true })
    }
    await expect(stat(registrationRoot)).rejects.toThrow()
  })

  it('injects an independent model profile without persisting its key', async () => {
    const child = fakeChild()
    const { deps, spawnMock } = dependencies(child)
    const runtime = new OpenCodeRuntime(
      options({
        modelProfile: {
          id: '00000000-0000-4000-8000-000000000011',
          name: '独立模型',
          baseUrl: 'https://model.example',
          modelName: 'private-model',
          apiKey: 'private-key',
          protocol: 'anthropic-messages',
          authentication: 'api-key',
          supportsImageInput: true
        }
      }),
      deps
    )

    await expect(runtime.testConnection()).resolves.toMatchObject({
      available: true
    })
    const spawnOptions = spawnMock.mock.calls[0]?.[2] as
      | { env?: NodeJS.ProcessEnv }
      | undefined
    const config = JSON.parse(
      spawnOptions?.env?.OPENCODE_CONFIG_CONTENT ?? '{}'
    ) as Record<string, unknown>
    expect(config).toMatchObject({
      model: 'goodbuddy-anthropic/private-model',
      provider: {
        'goodbuddy-anthropic': {
          npm: '@ai-sdk/anthropic',
          options: {
            apiKey: 'private-key',
            baseURL: 'https://model.example/v1'
          },
          models: {
            'private-model': {
              attachment: true,
              modalities: {
                input: ['text', 'image'],
                output: ['text']
              },
              provider: {
                npm: '@ai-sdk/anthropic'
              }
            }
          }
        }
      }
    })
    await runtime.dispose()
  })

  it('isolates an explicit profile from unrelated inherited credentials', async () => {
    const child = fakeChild()
    const { deps, spawnMock } = dependencies(child)
    const inheritedCredentials = {
      ANTHROPIC_API_KEY: 'inherited-anthropic',
      OPENAI_API_KEY: 'inherited-openai',
      GOOGLE_GENERATIVE_AI_API_KEY: 'inherited-google',
      GEMINI_API_KEY: 'inherited-gemini',
      AWS_ACCESS_KEY_ID: 'inherited-aws-access',
      AWS_SECRET_ACCESS_KEY: 'inherited-aws-secret',
      AWS_SESSION_TOKEN: 'inherited-aws-session',
      AWS_PROFILE: 'inherited-aws-profile',
      OPENROUTER_API_KEY: 'inherited-openrouter'
    }
    const previousEnvironment = Object.fromEntries(
      Object.keys(inheritedCredentials).map((name) => [
        name,
        process.env[name]
      ])
    )
    Object.assign(process.env, inheritedCredentials)
    const runtime = new OpenCodeRuntime(
      options({
        modelProfile: {
          id: '00000000-0000-4000-8000-000000000014',
          name: 'Explicit OpenAI profile',
          baseUrl: 'https://model.example/v1',
          modelName: 'private-model',
          protocol: 'openai-responses',
          authentication: 'api-key',
          apiKey: 'selected-openai-key'
        }
      }),
      deps
    )

    try {
      await expect(runtime.testConnection()).resolves.toMatchObject({
        available: true
      })
      const environment = (
        spawnMock.mock.calls[0]?.[2] as
          | { env?: NodeJS.ProcessEnv }
          | undefined
      )?.env
      expect(environment?.OPENAI_API_KEY).toBe('selected-openai-key')
      for (const name of Object.keys(inheritedCredentials)) {
        if (name !== 'OPENAI_API_KEY') {
          expect(environment).not.toHaveProperty(name)
        }
      }
    } finally {
      await runtime.dispose()
      for (const [name, value] of Object.entries(
        previousEnvironment
      )) {
        if (value === undefined) {
          delete process.env[name]
        } else {
          process.env[name] = value
        }
      }
    }
  })

  it.each([
    {
      label: 'Chat Completions',
      protocol: 'openai-chat-completions' as const,
      expectedPath: '/v1/chat/completions',
      unexpectedPath: '/v1/responses'
    },
    {
      label: 'Responses',
      protocol: 'openai-responses' as const,
      expectedPath: '/v1/responses',
      unexpectedPath: '/v1/chat/completions'
    }
  ])(
    'routes a custom-base $label profile through the bundled OpenCode provider',
    async ({
      protocol,
      expectedPath,
      unexpectedPath
    }) => {
      const root = await mkdtemp(
        join(tmpdir(), 'goodbuddy-opencode-routing-')
      )
      const requestPaths: string[] = []
      const tenantHeaders: Array<string | string[] | undefined> = []
      const requestBodies: Array<Record<string, unknown>> = []
      const server = createServer(async (request, response) => {
        requestPaths.push(request.url ?? '')
        tenantHeaders.push(request.headers['x-tenant-id'])
        let body = ''
        for await (const chunk of request) {
          body += String(chunk)
        }
        if (body) {
          requestBodies.push(
            JSON.parse(body) as Record<string, unknown>
          )
        }
        response.writeHead(400, {
          'content-type': 'application/json'
        })
        response.end(
          JSON.stringify({
            error: {
              message: 'Intentional local routing probe'
            }
          })
        )
      })
      await new Promise<void>((resolveListen, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolveListen())
      })
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('Failed to bind local routing probe')
      }
      const isolatedEnvironment = {
        APPDATA: join(root, 'appdata'),
        HOME: root,
        LOCALAPPDATA: join(root, 'localappdata'),
        USERPROFILE: root
      } as const
      const previousEnvironment = Object.fromEntries(
        Object.keys(isolatedEnvironment).map((name) => [
          name,
          process.env[name]
        ])
      )
      Object.assign(process.env, isolatedEnvironment)
      const runtime = new OpenCodeRuntime(
        options({
          binaryPath: join(
            process.cwd(),
            'node_modules',
            'opencode-ai',
            'bin',
            'opencode.exe'
          ),
          defaultWorkspace: root,
          modelProfile: {
            id: '00000000-0000-4000-8000-000000000013',
            name: 'Local endpoint probe',
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            modelName: 'probe-model',
            protocol,
            authentication: 'api-key',
            apiKey: 'local-probe-key',
            requestHeaders: {
              'x-tenant-id': 'opencode-native'
            },
            requestBody: {
              goodbuddy_unsupported_probe: 'must-not-send'
            }
          }
        }),
        { startupTimeoutMs: 20_000 }
      )
      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort(new Error('Routing probe timed out')),
        20_000
      )
      try {
        let failure = ''
        await (async () => {
          for await (const _event of runtime.run(
            {
              requestId:
                '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
              conversationId: 'routing-probe',
              prompt: 'Reply with OK',
              workMode: 'execute'
            },
            controller.signal
          )) {
            // The local probe intentionally returns an upstream error.
            void _event
          }
        })().catch((error) => {
          failure =
            error instanceof Error ? error.message : String(error)
        })
        if (requestPaths.length === 0) {
          throw new Error(`OpenCode routing probe failed: ${failure}`)
        }
        expect(requestPaths).toContain(expectedPath)
        expect(requestPaths).not.toContain(unexpectedPath)
        expect(tenantHeaders).toContain('opencode-native')
        expect(requestBodies).not.toContainEqual(
          expect.objectContaining({
            goodbuddy_unsupported_probe: 'must-not-send'
          })
        )
      } finally {
        clearTimeout(timeout)
        await runtime.dispose()
        for (const [name, value] of Object.entries(
          previousEnvironment
        )) {
          if (value === undefined) {
            delete process.env[name]
          } else {
            process.env[name] = value
          }
        }
        await new Promise<void>((resolveClose, reject) => {
          server.close((error) =>
            error ? reject(error) : resolveClose()
          )
        })
        await rm(root, { recursive: true, force: true })
      }
    },
    30_000
  )

  it.each([
    {
      protocol: 'openai-chat-completions' as const,
      authentication: 'none' as const,
      providerId: 'goodbuddy-openai-chat',
      providerPackage: '@ai-sdk/openai-compatible'
    },
    {
      protocol: 'openai-responses' as const,
      authentication: 'api-key' as const,
      providerId: 'goodbuddy-openai-responses',
      providerPackage: '@ai-sdk/openai'
    }
  ])(
    'generates an explicit $protocol provider configuration',
    async ({
      protocol,
      authentication,
      providerId,
      providerPackage
    }) => {
      const child = fakeChild()
      const { deps, spawnMock } = dependencies(child)
      const runtime = new OpenCodeRuntime(
        options({
          modelProfile: {
            id: '00000000-0000-4000-8000-000000000012',
            name: 'OpenAI 独立模型',
            baseUrl: 'https://model.example/v1',
            modelName: 'custom-model',
            protocol,
            authentication,
            requestHeaders: {
              'x-tenant-id': 'opencode-tenant'
            },
            requestBody: {
              temperature: 0.25
            },
            ...(authentication === 'api-key'
              ? { apiKey: 'private-key' }
              : {})
          }
        }),
        deps
      )

      await expect(runtime.testConnection()).resolves.toMatchObject({
        available: true
      })
      const spawnOptions = spawnMock.mock.calls[0]?.[2] as
        | { env?: NodeJS.ProcessEnv }
        | undefined
      const config = JSON.parse(
        spawnOptions?.env?.OPENCODE_CONFIG_CONTENT ?? '{}'
      ) as {
        model?: string
        provider?: Record<
          string,
          {
            npm?: string
            options?: Record<string, unknown>
            models?: Record<
              string,
              { provider?: { npm?: string } }
            >
          }
        >
      }
      expect(config.model).toBe(`${providerId}/custom-model`)
      expect(config.provider?.[providerId]).toMatchObject({
        npm: providerPackage,
        options: {
          baseURL: 'https://model.example/v1',
          headers: {
            'x-tenant-id': 'opencode-tenant'
          }
        },
        models: {
          'custom-model': {
            provider: {
              npm: providerPackage
            }
          }
        }
      })
      if (authentication === 'api-key') {
        expect(
          config.provider?.[providerId]?.options?.apiKey
        ).toBe('private-key')
      } else {
        expect(
          config.provider?.[providerId]?.options
        ).not.toHaveProperty('apiKey')
      }
      expect(JSON.stringify(config)).not.toContain('temperature')
      await runtime.dispose()
    }
  )

  it('isolates embedded server configuration from inherited env', async () => {
    const child = fakeChild()
    const { deps, spawnMock } = dependencies(child)
    const isolatedNames = [
      'OPENCODE_CONFIG',
      'OPENCODE_CONFIG_CONTENT',
      'OPENCODE_CONFIG_DIR',
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
      const runtime = new OpenCodeRuntime(options(), deps)
      await expect(runtime.testConnection()).resolves.toMatchObject({
        available: true
      })

      const spawnOptions = spawnMock.mock.calls[0]?.[2] as
        | { env?: NodeJS.ProcessEnv }
        | undefined
      expect(spawnOptions?.env?.OPENCODE_CONFIG).toBeUndefined()
      expect(
        spawnOptions?.env?.OPENCODE_CONFIG_CONTENT
      ).not.toBe('must-not-be-inherited')
      expect(spawnOptions?.env?.OPENCODE_CONFIG_DIR).not.toBe(
        'must-not-be-inherited'
      )
      expect(spawnOptions?.env?.OPENCODE_SERVER_USERNAME).toBe(
        'goodbuddy'
      )
      expect(
        spawnOptions?.env?.OPENCODE_SERVER_PASSWORD
      ).not.toBe('must-not-be-inherited')
      expect(spawnOptions?.env).toMatchObject({
        DO_NOT_TRACK: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
        OPENCODE_DISABLE_EMBEDDED_WEB_UI: '1',
        OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
        OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
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

  it('polls the known loopback URL without waiting for stdout', async () => {
    const child = fakeChild()
    const { deps, checkServerHealth, createClient } = dependencies(child, {
      startupTimeoutMs: 1_000
    })
    checkServerHealth
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const runtime = new OpenCodeRuntime(options(), deps)

    await expect(runtime.testConnection()).resolves.toMatchObject({
      available: true
    })
    expect(checkServerHealth).toHaveBeenCalledTimes(2)
    const [url, authorization, signal] =
      checkServerHealth.mock.calls[0] ?? []
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(authorization).toMatch(/^Basic /)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(createClient).toHaveBeenCalledWith({
      baseUrl: url,
      directory: process.cwd(),
      headers: { Authorization: authorization }
    })
  })

  it('allows ARM-class startup to become healthy after ten seconds', async () => {
    vi.useFakeTimers()
    try {
      const child = fakeChild()
      let healthy = false
      const checkServerHealth = vi.fn(async () => healthy)
      const { deps } = dependencies(child, {
        checkServerHealth
      })
      const runtime = new OpenCodeRuntime(options(), deps)
      let settled = false
      const statusPromise = runtime.testConnection().finally(() => {
        settled = true
      })

      await vi.advanceTimersByTimeAsync(10_100)
      expect(settled).toBe(false)

      healthy = true
      await vi.advanceTimersByTimeAsync(100)
      await expect(statusPromise).resolves.toMatchObject({
        available: true
      })
      expect(checkServerHealth).toHaveBeenCalled()

      await runtime.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out, terminates the process tree, and does not expose stderr', async () => {
    const child = fakeChild()
    const secret = 'private-config-token'
    const { deps } = dependencies(child, {
      startupTimeoutMs: 5,
      checkServerHealth: vi.fn().mockResolvedValue(false)
    })
    stderrOf(child).write(secret)
    const runtime = new OpenCodeRuntime(options(), deps)

    const status = await runtime.testConnection()

    expect(status).toMatchObject({
      available: false,
      detail: 'OpenCode Server 启动超时（30 秒）'
    })
    expect(status.detail).not.toContain(secret)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('reports early exit without leaking captured stderr', async () => {
    const child = fakeChild()
    const secret = 'OPENCODE_CONFIG=/secret/config.json'
    let registrationRoot = ''
    const { deps } = dependencies(child, {
      spawn: vi.fn(
        (
          _command: string,
          _args: string[],
          spawnOptions: { env?: NodeJS.ProcessEnv }
        ) => {
          registrationRoot = resolve(
            spawnOptions.env?.OPENCODE_CONFIG_DIR ?? '',
            '..'
          )
          queueMicrotask(() => {
            stderrOf(child).write(secret)
            closeChild(child, 9)
          })
          return child
        }
      ) as unknown as typeof spawn
    })
    const runtime = new OpenCodeRuntime(options(), deps)

    const status = await runtime.testConnection()

    expect(status.detail).toBe('OpenCode Server 启动前退出（code 9）')
    expect(status.detail).not.toContain(secret)
    expect(registrationRoot).toBeTruthy()
    await expect(stat(registrationRoot)).rejects.toThrow()
  })

  it('terminates startup when the request is aborted', async () => {
    const child = fakeChild()
    const { deps, spawnMock } = dependencies(child, {
      checkServerHealth: vi.fn().mockResolvedValue(false)
    })
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

  it('bounds session setup without imposing a full-run deadline', async () => {
    const harness = runClient([])
    ;(
      harness.session.create as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(
      () => new Promise(() => undefined)
    )
    const runtime = embeddedRuntime(
      harness.client,
      {},
      { controlRequestTimeoutMs: 5 }
    )

    await expect(collectRun(runtime)).rejects.toThrow(
      'OpenCode 创建会话超时'
    )
    await runtime.dispose()
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
    expect(runtime.requiresToolApproval).toBe(false)
  })

  it('serializes external runs that share one conversation session', async () => {
    const child = fakeChild()
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let subscriptionCount = 0
    const promptAsync = vi.fn().mockResolvedValue({
      data: true,
      error: undefined
    })
    const client = {
      session: {
        create: vi.fn().mockResolvedValue({
          data: { id: 'session-1' },
          error: undefined
        }),
        update: vi.fn().mockResolvedValue({
          data: { id: 'session-1' },
          error: undefined
        }),
        promptAsync,
        abort: vi.fn().mockResolvedValue({
          data: true,
          error: undefined
        })
      },
      event: {
        subscribe: vi.fn().mockImplementation(async () => {
          subscriptionCount += 1
          const current = subscriptionCount
          return {
            stream: (async function* () {
              if (current === 1) {
                await firstGate
              }
              yield {
                type: 'session.idle',
                properties: { sessionID: 'session-1' }
              }
            })()
          }
        })
      },
      tool: {
        ids: vi.fn().mockResolvedValue({
          data: [],
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
        embedded: false
      }),
      deps
    )
    const request = {
      requestId: '00000000-0000-4000-8000-000000000101',
      conversationId: 'shared-conversation',
      prompt: 'first',
      workMode: 'execute' as const
    }
    const collect = async (
      stream: AsyncGenerator<RuntimeEvent, void, void>
    ): Promise<RuntimeEvent[]> => {
      const events: RuntimeEvent[] = []
      for await (const event of stream) {
        events.push(event)
      }
      return events
    }
    const first = collect(runtime.run(
      request,
      new AbortController().signal
    ))
    await vi.waitFor(() => expect(promptAsync).toHaveBeenCalledTimes(1))
    const second = collect(
      runtime.run(
        {
          ...request,
          requestId: '00000000-0000-4000-8000-000000000102',
          prompt: 'second'
        },
        new AbortController().signal
      )
    )
    await Promise.resolve()
    expect(promptAsync).toHaveBeenCalledTimes(1)

    releaseFirst()
    await first
    await second
    expect(promptAsync).toHaveBeenCalledTimes(2)
    await runtime.dispose()
  })

  it('loads assigned Skills before prompting', async () => {
    const child = fakeChild()
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
        skillInstructions: '# 文档写作'
      }),
      deps
    )

    const events = []
    for await (const event of runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'test',
        workMode: 'execute',
        images: [
          {
            name: 'screenshot.png',
            mediaType: 'image/png',
            data: 'aW1hZ2U='
          }
        ]
      },
      new AbortController().signal
    )) {
      events.push(event)
    }

    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        system: '# 文档写作',
        parts: [
          { type: 'text', text: 'test' },
          {
            type: 'file',
            mime: 'image/png',
            filename: 'screenshot.png',
            url: 'data:image/png;base64,aW1hZ2U='
          }
        ]
      }),
      expect.objectContaining({
        signal: expect.any(AbortSignal)
      })
    )
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    await runtime.dispose()
  })

  it('rejects images when the explicit model connection disables image input', async () => {
    const child = fakeChild()
    const { deps, createClient } = dependencies(child)
    const runtime = new OpenCodeRuntime(
      options({
        modelProfile: {
          id: '00000000-0000-4000-8000-000000000011',
          name: '文本模型',
          baseUrl: 'https://model.example',
          modelName: 'text-model',
          protocol: 'anthropic-messages',
          authentication: 'none',
          supportsImageInput: false
        }
      }),
      deps
    )
    const stream = runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'describe',
        images: [
          {
            name: 'screenshot.png',
            mediaType: 'image/png',
            data: 'aW1hZ2U='
          }
        ]
      },
      new AbortController().signal
    )

    await expect(stream.next()).rejects.toThrow(
      '当前模型连接未启用图像输入'
    )
    expect(createClient).not.toHaveBeenCalled()
  })
})

describe('OpenCodeRuntime embedded permission mediation', () => {
  it('shares assigned custom MCP only with embedded Execute through a scoped loopback token', async () => {
    const setup = runClient([
      {
        id: 'idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const gateway = {
      getEndpoint: vi.fn(() => 'http://127.0.0.1:4567/mcp'),
      grantCustomMcp: vi.fn(() => 'custom-capability'),
      prepareCustomMcpTools: vi.fn(async () => [
        {
          name: 'mcp_12345678_abcdef01_private_tool',
          inputSchema: { type: 'object' }
        }
      ]),
      revoke: vi.fn()
    } as unknown as KnowledgeMcpGateway
    const runtime = embeddedRuntime(setup.client, {
      knowledgeGateway: gateway,
      mcpServers: [
        {
          id: '00000000-0000-4000-8000-000000000092',
          name: 'Private MCP',
          description: '',
          enabled: true,
          allowDynamicTools: false,
          assignments: ['opencode'],
          secretConfigured: true,
          secret: 'must-stay-in-main',
          transport: 'http',
          url: 'https://private.example/mcp'
        }
      ]
    })

    await collectRun(runtime, 'execute')

    expect(gateway.grantCustomMcp).toHaveBeenCalledWith(
      '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
      expect.any(Array),
      expect.any(AbortSignal)
    )
    expect(setup.client.mcp.add).toHaveBeenCalledWith(
      {
        directory: process.cwd(),
        name: expect.stringMatching(/^goodbuddy-custom-[a-f0-9]{20}$/u),
        config: {
          type: 'remote',
          url: 'http://127.0.0.1:4567/mcp',
          enabled: true,
          headers: {
            Authorization: 'Bearer custom-capability'
          },
          oauth: false
        }
      },
      { signal: expect.any(AbortSignal) }
    )
    expect(JSON.stringify(
      (setup.client.mcp.add as unknown as ReturnType<typeof vi.fn>)
        .mock.calls
    )).not.toContain('must-stay-in-main')
    expect(JSON.stringify(
      (setup.client.mcp.add as unknown as ReturnType<typeof vi.fn>)
        .mock.calls
    )).not.toContain('private.example')
    expect(gateway.revoke).toHaveBeenCalledWith('custom-capability')
    await runtime.dispose()
  })

  it.each([
    ['ask', true] as const,
    ['execute', false] as const
  ])(
    'does not share custom MCP with OpenCode in %s mode when embedded is %s',
    async (workMode, embedded) => {
      const setup = runClient([
        {
          id: 'idle',
          type: 'session.idle',
          properties: { sessionID: 'session-1' }
        }
      ])
      const gateway = {
        getEndpoint: vi.fn(() => 'http://127.0.0.1:4567/mcp'),
        grantCustomMcp: vi.fn(() => 'custom-capability'),
        prepareCustomMcpTools: vi.fn(async () => []),
        revoke: vi.fn()
      } as unknown as KnowledgeMcpGateway
      const runtime = embedded
        ? embeddedRuntime(setup.client, {
            knowledgeGateway: gateway,
            mcpServers: [
              {
                id: '00000000-0000-4000-8000-000000000093',
                name: 'Private MCP',
                description: '',
                enabled: true,
                allowDynamicTools: false,
                assignments: ['opencode'],
                secretConfigured: false,
                transport: 'stdio',
                command: 'private-command',
                args: []
              }
            ]
          })
        : new OpenCodeRuntime(
            options({
              baseUrl: 'http://127.0.0.1:4096',
              embedded: false,
              knowledgeGateway: gateway,
              mcpServers: [
                {
                  id: '00000000-0000-4000-8000-000000000093',
                  name: 'Private MCP',
                  description: '',
                  enabled: true,
                  allowDynamicTools: false,
                  assignments: ['opencode'],
                  secretConfigured: false,
                  transport: 'stdio',
                  command: 'private-command',
                  args: []
                }
              ]
            }),
            dependencies(fakeChild(), {
              createClient: vi.fn(
                () => setup.client
              ) as unknown as typeof createOpencodeClient
            }).deps
          )

      await collectRun(runtime, workMode)

      expect(gateway.grantCustomMcp).not.toHaveBeenCalled()
      expect(setup.client.mcp.add).not.toHaveBeenCalled()
      await runtime.dispose()
    }
  )

  it('parses OpenCode questions and sends the selected answers back', async () => {
    const setup = runClient([
      {
        id: 'question-event',
        type: 'question.asked',
        properties: {
          id: 'question-1',
          sessionID: 'session-1',
          questions: [
            {
              header: '实现方式',
              question: '请选择实现方式',
              options: [
                {
                  label: '直接修改',
                  description: '立即更新现有实现'
                },
                {
                  label: '先写测试',
                  description: '先增加回归测试'
                }
              ],
              multiple: false,
              custom: true
            }
          ],
          tool: {
            messageID: 'message-1',
            callID: 'call-question-1'
          }
        }
      },
      {
        id: 'idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const runtime = embeddedRuntime(setup.client)
    const stream = runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'test',
        workMode: 'execute'
      },
      new AbortController().signal
    )

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'status' }
    })
    const questionEvent = await stream.next()
    expect(questionEvent.value).toMatchObject({
      type: 'question',
      questionId: expect.stringMatching(/^opencode-[a-f0-9]{48}$/u),
      questions: [
        {
          header: '实现方式',
          question: '请选择实现方式',
          multiple: false,
          custom: true
        }
      ]
    })
    const questionId =
      questionEvent.value?.type === 'question'
        ? questionEvent.value.questionId
        : ''
    await runtime.respondToQuestion(questionId, [['先写测试']])
    expect(setup.questionReply).toHaveBeenCalledWith(
      {
        requestID: 'question-1',
        directory: process.cwd(),
        answers: [['先写测试']]
      },
      { signal: expect.any(AbortSignal) }
    )
    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'done' }
    })
    await runtime.dispose()
  })

  it('namespaces identical upstream question IDs across concurrent external conversations', async () => {
    const setup = runClient([])
    ;(
      setup.event.subscribe as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(async () => ({
      stream: (async function* () {
        yield {
          id: 'question-event',
          type: 'question.asked',
          properties: {
            id: 'shared-question',
            sessionID: 'session-1',
            questions: [
              {
                header: 'Choice',
                question: 'Choose',
                options: [],
                multiple: false,
                custom: true
              }
            ]
          }
        }
        yield {
          id: 'idle',
          type: 'session.idle',
          properties: { sessionID: 'session-1' }
        }
      })()
    }))
    const runtime = new OpenCodeRuntime(
      options({
        baseUrl: 'http://127.0.0.1:4096',
        embedded: false
      }),
      dependencies(fakeChild(), {
        createClient: vi.fn(
          () => setup.client
        ) as unknown as typeof createOpencodeClient
      }).deps
    )
    const first = runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'first',
        workMode: 'execute'
      },
      new AbortController().signal
    )
    const second = runtime.run(
      {
        requestId: '4f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-2',
        prompt: 'second',
        workMode: 'execute'
      },
      new AbortController().signal
    )

    await Promise.all([first.next(), second.next()])
    const [firstQuestion, secondQuestion] = await Promise.all([
      first.next(),
      second.next()
    ])
    const firstId =
      firstQuestion.value?.type === 'question'
        ? firstQuestion.value.questionId
        : ''
    const secondId =
      secondQuestion.value?.type === 'question'
        ? secondQuestion.value.questionId
        : ''
    expect(firstId).toMatch(/^opencode-[a-f0-9]{48}$/u)
    expect(secondId).toMatch(/^opencode-[a-f0-9]{48}$/u)
    expect(firstId).not.toBe(secondId)

    await Promise.all([
      runtime.respondToQuestion(firstId, [['first answer']]),
      runtime.respondToQuestion(secondId, [['second answer']])
    ])
    expect(setup.questionReply).toHaveBeenCalledTimes(2)
    expect(setup.questionReply).toHaveBeenNthCalledWith(
      1,
      {
        requestID: 'shared-question',
        directory: process.cwd(),
        answers: [['first answer']]
      },
      { signal: expect.any(AbortSignal) }
    )
    expect(setup.questionReply).toHaveBeenNthCalledWith(
      2,
      {
        requestID: 'shared-question',
        directory: process.cwd(),
        answers: [['second answer']]
      },
      { signal: expect.any(AbortSignal) }
    )
    await Promise.all([first.next(), second.next()])
    await runtime.dispose()
  })

  it('emits native Task calls as subagents instead of generic tools', async () => {
    const taskInput = {
      subagent_type: 'explorer',
      description: 'Review application architecture',
      prompt: 'Inspect the complete source tree.'
    }
    const setup = runClient([
      {
        id: 'task-running',
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-1',
          part: {
            id: 'part-task-1',
            callID: 'call-task-1',
            type: 'tool',
            tool: 'task',
            state: {
              status: 'running',
              input: taskInput,
              time: { start: 1 }
            }
          }
        }
      },
      {
        id: 'task-completed',
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-1',
          part: {
            id: 'part-task-1',
            callID: 'call-task-1',
            type: 'tool',
            tool: 'task',
            state: {
              status: 'completed',
              input: taskInput,
              output: 'Architecture review complete.',
              title: 'Review application architecture',
              metadata: {},
              time: { start: 1, end: 2 }
            }
          }
        }
      },
      {
        id: 'idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const runtime = embeddedRuntime(setup.client)

    const events = await collectRun(runtime)
    const subagents = events.filter(
      (event) => event.type === 'subagent'
    )

    expect(subagents).toHaveLength(2)
    expect(subagents[0]).toMatchObject({
      expertName: 'explorer',
      routingMode: 'native',
      runtimeCallId: 'call-task-1',
      state: 'running',
      reason: 'Review application architecture'
    })
    expect(subagents[1]).toMatchObject({
      childTaskId:
        subagents[0]?.type === 'subagent'
          ? subagents[0].childTaskId
          : undefined,
      state: 'completed',
      output: 'Architecture review complete.'
    })
    expect(events.some((event) => event.type === 'tool')).toBe(false)
    await runtime.dispose()
  })

  it('keeps non-Task tools with Task-shaped input as generic tools', async () => {
    const setup = runClient([
      {
        id: 'custom-tool-completed',
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-1',
          part: {
            id: 'part-custom-1',
            callID: 'call-custom-1',
            type: 'tool',
            tool: 'custom_delegate',
            state: {
              status: 'completed',
              input: {
                subagent_type: 'explorer',
                prompt: 'Inspect the complete source tree.'
              },
              output: 'Custom tool result.',
              title: 'Custom delegate',
              metadata: {},
              time: { start: 1, end: 2 }
            }
          }
        }
      },
      {
        id: 'idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const runtime = embeddedRuntime(setup.client)

    const events = await collectRun(runtime)

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool',
        callId: 'call-custom-1',
        name: 'custom_delegate',
        state: 'completed'
      })
    )
    expect(events.some((event) => event.type === 'subagent')).toBe(false)
    await runtime.dispose()
  })

  it('does not impose a default wall-clock deadline on OpenCode runs', async () => {
    vi.useFakeTimers()
    try {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const setup = runClient([])
      ;(
        setup.event.subscribe as unknown as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        stream: (async function* () {
          await gate
          yield {
            id: 'idle',
            type: 'session.idle',
            properties: { sessionID: 'session-1' }
          }
        })()
      })
      const runtime = new OpenCodeRuntime(
        options({
          baseUrl: 'http://127.0.0.1:4096',
          embedded: false
        }),
        dependencies(fakeChild(), {
          createClient: vi.fn(
            () => setup.client
          ) as unknown as typeof createOpencodeClient
        }).deps
      )
      const stream = runtime.run(
        {
          requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
          conversationId: 'conversation-1',
          prompt: 'work for more than a day',
          workMode: 'execute'
        },
        new AbortController().signal
      )

      await expect(stream.next()).resolves.toMatchObject({
        value: { type: 'status' }
      })
      const pending = stream.next()
      await vi.advanceTimersByTimeAsync(25 * 60 * 60_000)
      expect(setup.session.abort).not.toHaveBeenCalled()
      release()
      await expect(pending).resolves.toMatchObject({
        value: { type: 'done' }
      })
      await runtime.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts an OpenCode run at its total execution deadline', async () => {
    const setup = runClient([])
    ;(
      setup.event.subscribe as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(
      async (
        _input: unknown,
        options: { signal: AbortSignal }
      ) => ({
        stream: (async function* () {
          await new Promise<void>((_resolve, reject) => {
            options.signal.addEventListener(
              'abort',
              () => reject(options.signal.reason),
              { once: true }
            )
          })
          yield {
            id: 'unreachable',
            type: 'session.idle',
            properties: { sessionID: 'session-1' }
          }
        })()
      })
    )
    const runtime = new OpenCodeRuntime(
      options({
        baseUrl: 'http://127.0.0.1:4096',
        embedded: false
      }),
      dependencies(fakeChild(), {
        createClient: vi.fn(
          () => setup.client
        ) as unknown as typeof createOpencodeClient,
        executionTimeoutMs: 20
      }).deps
    )
    const stream = runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'never finish',
        workMode: 'execute'
      },
      new AbortController().signal
    )

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'status' }
    })
    await expect(stream.next()).rejects.toThrow(
      'OpenCode 执行超过 20 毫秒总时限'
    )
    expect(setup.session.abort).toHaveBeenCalled()
    await runtime.dispose()
  })

  it('applies the total deadline while agent discovery is stalled', async () => {
    const setup = runClient([])
    const agents = vi.fn(
      () => new Promise<never>(() => undefined)
    )
    Object.assign(setup.client, {
      app: { agents }
    })
    const child = fakeChild()
    const runtime = new OpenCodeRuntime(
      options({
        customization: { defaultAgent: 'build' }
      }),
      dependencies(child, {
        createClient: vi.fn(
          () => setup.client
        ) as unknown as typeof createOpencodeClient,
        executionTimeoutMs: 20
      }).deps
    )
    const stream = runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'never reach the stream',
        workMode: 'execute'
      },
      new AbortController().signal
    )

    await expect(stream.next()).rejects.toThrow(
      'OpenCode 执行超过 20 毫秒总时限'
    )
    expect(agents).toHaveBeenCalledWith(
      { directory: process.cwd() },
      { signal: expect.any(AbortSignal) }
    )
    expect(setup.event.subscribe).not.toHaveBeenCalled()
    await runtime.dispose()
  })

  it('deletes a session created after timeout and does not reuse it', async () => {
    const setup = runClient([
      {
        id: 'idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    let resolveStalledCreation!: (value: {
      data: { id: string }
      error: undefined
    }) => void
    ;(
      setup.session.create as unknown as ReturnType<typeof vi.fn>
    ).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStalledCreation = resolve
        })
    )
    const runtime = new OpenCodeRuntime(
      options({
        baseUrl: 'http://127.0.0.1:4096',
        embedded: false
      }),
      dependencies(fakeChild(), {
        createClient: vi.fn(
          () => setup.client
        ) as unknown as typeof createOpencodeClient,
        executionTimeoutMs: 20
      }).deps
    )
    const first = runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'stalled creation',
        workMode: 'execute'
      },
      new AbortController().signal
    )

    await expect(first.next()).rejects.toThrow(
      'OpenCode 执行超过 20 毫秒总时限'
    )
    resolveStalledCreation({
      data: { id: 'stale-session' },
      error: undefined
    })
    await vi.waitFor(() =>
      expect(setup.session.delete).toHaveBeenCalledWith(
        {
          sessionID: 'stale-session',
          directory: process.cwd()
        },
        { signal: expect.any(AbortSignal) }
      )
    )

    const secondEvents = await collectRun(runtime)
    expect(secondEvents.at(-1)).toMatchObject({ type: 'done' })
    expect(setup.session.create).toHaveBeenCalledTimes(2)
    expect(setup.session.update).not.toHaveBeenCalled()
    await runtime.dispose()
  })

  it('truncates oversized text display without stopping the run', async () => {
    const setup = runClient([
      {
        id: 'first-text',
        type: 'message.part.delta',
        properties: {
          sessionID: 'session-1',
          partID: 'part-1',
          field: 'text',
          delta: 'a'.repeat(600_000)
        }
      },
      {
        id: 'second-text',
        type: 'message.part.delta',
        properties: {
          sessionID: 'session-1',
          partID: 'part-1',
          field: 'text',
          delta: 'b'.repeat(600_000)
        }
      },
      {
        id: 'idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const runtime = embeddedRuntime(setup.client)
    const events = await collectRun(runtime, 'execute')
    const text = events
      .flatMap((event) => event.type === 'text' ? [event.delta] : [])
      .join('')

    expect(Buffer.byteLength(text)).toBe(1024 * 1024)
    expect(events).toContainEqual({
      requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
      type: 'status',
      message:
        'OpenCode 输出较长，已停止继续展示文本；任务仍在继续'
    })
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    expect(setup.session.abort).not.toHaveBeenCalled()
    await runtime.dispose()
  })

  it('completes more than 100 distinct tool calls in one run', async () => {
    const setup = runClient([
      ...Array.from({ length: 101 }, (_, index) =>
        completedToolEvent(`call-${index + 1}`)
      ),
      {
        id: 'idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const runtime = embeddedRuntime(setup.client)

    const events = await collectRun(runtime, 'execute')

    expect(
      events.filter((event) => event.type === 'tool')
    ).toHaveLength(101)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    await runtime.dispose()
  })

  it('adds only request-scoped built-in read tools for Ask and disconnects them', async () => {
    const setup = runClient([
      {
        id: 'idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const toolIds = setup.tool.ids as unknown as ReturnType<typeof vi.fn>
    toolIds
      .mockResolvedValueOnce({
        data: ['read', 'write', 'bash'],
        error: undefined
      })
      .mockResolvedValueOnce({
        data: [
          'read',
          'write',
          'bash',
          'goodbuddy_knowledge_search'
        ],
        error: undefined
      })
      .mockResolvedValue({
        data: [
          'read',
          'write',
          'bash',
          'goodbuddy_knowledge_search'
        ],
        error: undefined
      })
    const gateway = {
      getEndpoint: () => 'http://127.0.0.1:4567/mcp',
      getAvailableToolNames: () => ['knowledge_search']
    } as unknown as KnowledgeMcpGateway
    const child = fakeChild()
    const { deps } = dependencies(child, {
      createClient: vi.fn(
        () => setup.client
      ) as unknown as typeof createOpencodeClient
    })
    const runtime = new OpenCodeRuntime(
      options({ knowledgeGateway: gateway }),
      deps
    )

    const events = []
    for await (const event of runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'search',
        workMode: 'ask',
        knowledgeCapabilityToken: 'secret-capability'
      },
      new AbortController().signal
    )) {
      events.push(event)
    }

    expect(setup.client.mcp.add).toHaveBeenCalledWith(
      {
        directory: process.cwd(),
        name: expect.stringMatching(/^goodbuddy-data-[a-f0-9]{20}$/u),
        config: {
          type: 'remote',
          url: 'http://127.0.0.1:4567/mcp',
          enabled: true,
          headers: {
            Authorization: 'Bearer secret-capability'
          },
          oauth: false
        }
      },
      { signal: expect.any(AbortSignal) }
    )
    const knowledgeMcpName = (
      (
        setup.client.mcp.add as unknown as ReturnType<typeof vi.fn>
      ).mock.calls[0]?.[0] as { name: string }
    ).name
    const knowledgeToolId = `${knowledgeMcpName}_knowledge_search`
    expect(setup.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        permission: [
          { permission: '*', pattern: '*', action: 'deny' },
          {
            permission: knowledgeToolId,
            pattern: '*',
            action: 'allow'
          }
        ]
      }),
      { signal: expect.any(AbortSignal) }
    )
    expect(setup.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: {
          read: false,
          write: false,
          bash: false,
          'goodbuddy-data-*': false,
          'goodbuddy-custom-*': false,
          [knowledgeToolId]: true
        }
      }),
      expect.anything()
    )
    expect(setup.client.mcp.disconnect).toHaveBeenCalledWith(
      {
        name: expect.stringMatching(/^goodbuddy-data-/u),
        directory: process.cwd()
      },
      { signal: expect.any(AbortSignal) }
    )
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    await runtime.dispose()
  })

  it('enables the deterministic MCP tool name when tool ids omit dynamic tools', async () => {
    const setup = runClient([
      {
        id: 'idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const baseline = {
      data: ['read', 'write', 'bash'],
      error: undefined
    }
    const toolIds = setup.tool.ids as unknown as ReturnType<typeof vi.fn>
    toolIds.mockResolvedValue(baseline)
    const child = fakeChild()
    const { deps } = dependencies(child, {
      createClient: vi.fn(
        () => setup.client
      ) as unknown as typeof createOpencodeClient
    })
    const runtime = new OpenCodeRuntime(
      options({
        knowledgeGateway: {
          getEndpoint: () => 'http://127.0.0.1:4567/mcp',
          getAvailableToolNames: () => ['knowledge_search']
        } as unknown as KnowledgeMcpGateway
      }),
      deps
    )

    for await (const _event of runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'search',
        workMode: 'ask',
        knowledgeCapabilityToken: 'secret-capability'
      },
      new AbortController().signal
    )) {
      void _event
    }

    const knowledgeMcpName = (
      (
        setup.client.mcp.add as unknown as ReturnType<typeof vi.fn>
      ).mock.calls[0]?.[0] as { name: string }
    ).name
    const knowledgeToolId = `${knowledgeMcpName}_knowledge_search`
    expect(toolIds).toHaveBeenCalledTimes(1)
    expect(setup.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          read: false,
          write: false,
          bash: false,
          [knowledgeToolId]: true
        })
      }),
      expect.anything()
    )
    await runtime.dispose()
  })

  it('runs embedded conversations concurrently with request-scoped MCP registrations', async () => {
    const setup = runClient([
      {
        id: 'idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const toolIds = setup.tool.ids as unknown as ReturnType<typeof vi.fn>
    const baseline = {
      data: ['read', 'write'],
      error: undefined
    }
    const withKnowledge = {
      data: ['read', 'write', 'goodbuddy_knowledge_search'],
      error: undefined
    }
    for (const response of [
      baseline,
      withKnowledge,
      withKnowledge,
      baseline,
      withKnowledge,
      withKnowledge
    ]) {
      toolIds.mockResolvedValueOnce(response)
    }
    let resolveFirstAdd!: () => void
    const firstAdd = new Promise<void>((resolve) => {
      resolveFirstAdd = resolve
    })
    const mcpAdd = setup.client.mcp.add as unknown as ReturnType<typeof vi.fn>
    mcpAdd
      .mockImplementationOnce(async (input: { name: string }) => {
        await firstAdd
        return {
          data: {
            [input.name]: { status: 'connected' }
          },
          error: undefined
        }
      })
      .mockImplementation(async (input: { name: string }) => ({
        data: {
          [input.name]: { status: 'connected' }
        },
        error: undefined
      }))
    const child = fakeChild()
    const { deps } = dependencies(child, {
      createClient: vi.fn(
        () => setup.client
      ) as unknown as typeof createOpencodeClient
    })
    const runtime = new OpenCodeRuntime(
      options({
        knowledgeGateway: {
          getEndpoint: () => 'http://127.0.0.1:4567/mcp',
          getAvailableToolNames: () => ['knowledge_search']
        } as unknown as KnowledgeMcpGateway
      }),
      deps
    )
    const collect = async (
      requestId: string,
      conversationId: string,
      token: string
    ): Promise<void> => {
      for await (const _event of runtime.run(
        {
          requestId,
          conversationId,
          prompt: 'search',
          workMode: 'ask',
          knowledgeCapabilityToken: token
        },
        new AbortController().signal
      )) {
        void _event
      }
    }

    const first = collect(
      '3f496642-f47d-4e0a-8944-a32c77b0d6e1',
      'conversation-one',
      'first-token'
    )
    await vi.waitFor(() => expect(mcpAdd).toHaveBeenCalledTimes(1))
    const second = collect(
      '3f496642-f47d-4e0a-8944-a32c77b0d6e2',
      'conversation-two',
      'second-token'
    )
    try {
      await vi.waitFor(
        () => expect(mcpAdd).toHaveBeenCalledTimes(2),
        { timeout: 500 }
      )
      await vi.waitFor(
        () => expect(setup.session.promptAsync).toHaveBeenCalledOnce(),
        { timeout: 500 }
      )
    } finally {
      resolveFirstAdd()
    }
    await Promise.all([first, second])
    expect(
      mcpAdd.mock.calls.map(
        ([input]) =>
          (input as {
            config: { headers: { Authorization: string } }
          }).config.headers.Authorization
      )
    ).toEqual(['Bearer first-token', 'Bearer second-token'])
    expect(setup.client.mcp.disconnect).toHaveBeenCalledTimes(2)
    await runtime.dispose()
  })

  it('does not send a knowledge capability to external OpenCode', async () => {
    const setup = runClient([
      {
        id: 'idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const runtime = new OpenCodeRuntime(
      options({
        embedded: false,
        baseUrl: 'http://127.0.0.1:4096',
        knowledgeGateway: {
          getEndpoint: () => 'http://127.0.0.1:4567/mcp',
          getAvailableToolNames: () => ['knowledge_search']
        } as unknown as KnowledgeMcpGateway
      }),
      {
        createClient: vi.fn(
          () => setup.client
        ) as unknown as typeof createOpencodeClient
      }
    )
    for await (const _event of runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'search',
        workMode: 'ask',
        knowledgeCapabilityToken: 'must-not-leave-main'
      },
      new AbortController().signal
    )) {
      void _event
    }
    expect(setup.client.mcp.add).not.toHaveBeenCalled()
    expect(
      JSON.stringify(
        (
          setup.session.promptAsync as unknown as ReturnType<typeof vi.fn>
        ).mock.calls
      )
    ).not.toContain('must-not-leave-main')
    await runtime.dispose()
  })

  it('allows only registered native Skills in read-only modes', async () => {
    const sourceRoot = await mkdtemp(
      join(tmpdir(), 'goodbuddy-opencode-permission-skill-')
    )
    const skillDirectory = join(sourceRoot, 'longdoc-docx')
    await mkdir(skillDirectory)
    await writeFile(
      join(skillDirectory, 'SKILL.md'),
      [
        '---',
        'name: longdoc-docx',
        'description: Build a DOCX',
        '---',
        '',
        '# Long document'
      ].join('\n'),
      'utf8'
    )
    const setup = runClient([
      {
        id: 'idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const runtime = embeddedRuntime(setup.client, {
      skillInstructions: '# Original path: C:\\private\\skills',
      skillPackages: [
        {
          id: 'longdoc-docx',
          directory: skillDirectory
        }
      ]
    })
    try {
      await collectRun(runtime, 'ask')

      expect(setup.session.create).toHaveBeenCalledWith(
        {
          title: 'GoodBuddy 对话',
          directory: process.cwd(),
          permission: [
            { permission: '*', pattern: '*', action: 'deny' },
            { permission: 'skill', pattern: '*', action: 'deny' },
            {
              permission: 'skill',
              pattern: 'longdoc-docx',
              action: 'allow'
            }
          ]
        },
        { signal: expect.any(AbortSignal) }
      )
      expect(setup.session.promptAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          system: undefined,
          tools: {
            read: false,
            write: false,
            bash: false,
            task: false,
            'goodbuddy-data-*': false,
            'goodbuddy-custom-*': false,
            skill: true
          }
        }),
        expect.anything()
      )
    } finally {
      await runtime.dispose()
      await rm(sourceRoot, { recursive: true, force: true })
    }
  })

  it('configures Execute tools as allowed before prompting', async () => {
    const {
      client,
      callOrder,
      permissionReply,
      session
    } = runClient([
      permissionEvent({ sessionID: 'unrelated-session' }),
      permissionEvent(),
      permissionEvent(),
      completedToolEvent(),
      {
        id: 'event-reasoning-part',
        type: 'message.part.updated',
        properties: {
          sessionID: 'session-1',
          part: {
            id: 'part-reasoning',
            sessionID: 'session-1',
            messageID: 'message-1',
            type: 'reasoning',
            text: '',
            time: { start: 1 }
          }
        }
      },
      {
        id: 'event-reasoning',
        type: 'message.part.delta',
        properties: {
          sessionID: 'session-1',
          messageID: 'message-1',
          partID: 'part-reasoning',
          field: 'text',
          delta: 'reasoning output'
        }
      },
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
    const events = await collectRun(runtime, 'execute')

    expect(callOrder).toEqual(['subscribe', 'prompt'])
    expect(session.create).toHaveBeenCalledWith(
      {
        title: 'GoodBuddy 对话',
        directory: process.cwd(),
        permission: [
          { permission: '*', pattern: '*', action: 'allow' },
          {
            permission: 'goodbuddy-data-*',
            pattern: '*',
            action: 'deny'
          },
          {
            permission: 'goodbuddy-custom-*',
            pattern: '*',
            action: 'deny'
          }
        ]
      },
      { signal: expect.any(AbortSignal) }
    )
    expect(session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: {
          'goodbuddy-data-*': false,
          'goodbuddy-custom-*': false
        }
      }),
      expect.anything()
    )
    expect(permissionReply).toHaveBeenCalledOnce()
    expect(permissionReply).toHaveBeenCalledWith(
      {
        requestID: 'permission-1',
        directory: process.cwd(),
        reply: 'once'
      },
      { signal: expect.any(AbortSignal) }
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'reasoning',
        delta: 'reasoning output'
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool',
        callId: 'call-1',
        state: 'pending'
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool',
        callId: 'call-1',
        state: 'completed',
        input:
          '{\n  "command": "npm test",\n  "token": "visible-token"\n}',
        output:
          'Tests passed\nAuthorization: Bearer secret-token'
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'text',
        delta: 'approved output'
      })
    )
    expect(
      events.filter(
        (event) =>
          event.type === 'reasoning' ||
          event.type === 'text' ||
          event.type === 'tool'
      )
    ).toEqual([
      expect.objectContaining({
        type: 'tool',
        callId: 'call-1',
        state: 'pending'
      }),
      expect.objectContaining({
        type: 'tool',
        callId: 'call-1',
        state: 'completed'
      }),
      expect.objectContaining({
        type: 'reasoning',
        delta: 'reasoning output'
      }),
      expect.objectContaining({
        type: 'text',
        delta: 'approved output'
      })
    ])
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    await runtime.dispose()
  })

  it('auto-allows bounded fallback permission requests without GoodBuddy approval', async () => {
    const { client, permissionReply } = runClient([
      permissionEvent(),
      permissionEvent({
        id: 'permission-2',
        patterns: ['npm run lint'],
        metadata: { command: 'npm run lint' },
        always: ['npm run lint'],
        tool: {
          messageID: 'message-2',
          callID: 'call-2'
        }
      }),
      completedToolEvent('call-1'),
      completedToolEvent('call-2'),
      {
        id: 'event-idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const runtime = embeddedRuntime(client)
    await collectRun(runtime, 'execute')

    expect(permissionReply.mock.calls).toEqual([
      [
        {
          requestID: 'permission-1',
          directory: process.cwd(),
          reply: 'once'
        },
        { signal: expect.any(AbortSignal) }
      ],
      [
        {
          requestID: 'permission-2',
          directory: process.cwd(),
          reply: 'once'
        },
        { signal: expect.any(AbortSignal) }
      ]
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
            state: {
              status: 'error',
              error:
                'write failed Authorization: Bearer secret-token'
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
    const stream = runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'test',
        workMode: 'execute'
      },
      new AbortController().signal
    )

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'status' }
    })
    await expect(stream.next()).resolves.toMatchObject({
      value: {
        type: 'tool',
        callId: 'call-1',
        state: 'failed',
        error:
          'write failed Authorization: Bearer secret-token'
      }
    })
    await expect(stream.next()).rejects.toThrow(
      'write failed Authorization: Bearer secret-token'
    )
    expect(session.abort).toHaveBeenCalledOnce()
    await runtime.dispose()
  })

  it('keeps a completed response when an earlier tool attempt failed', async () => {
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
            tool: 'read',
            state: {
              status: 'error',
              error: 'Cannot read binary file'
            }
          }
        }
      },
      completedToolEvent('call-2', 'write'),
      {
        id: 'event-text',
        type: 'message.part.delta',
        properties: {
          sessionID: 'session-1',
          messageID: 'message-1',
          partID: 'part-text',
          field: 'text',
          delta: 'PPT 已生成并保存。'
        }
      },
      {
        id: 'event-idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const runtime = embeddedRuntime(client)
    const events = await collectRun(runtime, 'execute')

    expect(
      events.filter(
        (event) =>
          event.type === 'tool' && event.callId === 'call-1'
      )
    ).toEqual([
      expect.objectContaining({
        state: 'failed',
        error: 'Cannot read binary file'
      }),
      expect.objectContaining({
        state: 'recoverable',
        error: 'Cannot read binary file'
      })
    ])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'text',
        delta: 'PPT 已生成并保存。'
      })
    )
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    expect(session.abort).not.toHaveBeenCalled()
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
      'prompt rejected Authorization: Bearer secret-token'
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

    expect(session.delete).toHaveBeenCalledWith(
      {
        sessionID: 'session-1',
        directory: process.cwd()
      },
      { signal: expect.any(AbortSignal) }
    )
    await runtime.dispose()
  })

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
    await collectRun(runtime, 'execute')

    expect(permissionReply).toHaveBeenCalledOnce()
    expect(permissionReply).toHaveBeenCalledWith(
      {
        requestID: 'permission-1',
        directory: process.cwd(),
        reply: 'reject'
      },
      { signal: expect.any(AbortSignal) }
    )
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
      collectRun(runtime, 'execute')
    ).rejects.toThrow('OpenCode 权限回复失败')
    expect(session.abort).toHaveBeenCalledWith({
      sessionID: 'session-1',
      directory: process.cwd()
    })
    await runtime.dispose()
  })

  it('uses deny-all session rules and hard tool disable in Ask mode', async () => {
      const { client, session, tool } = runClient([
        {
          id: 'event-idle',
          type: 'session.idle',
          properties: { sessionID: 'session-1' }
        }
      ])
      const runtime = embeddedRuntime(client)

      await collectRun(runtime, 'ask')

      expect(session.create).toHaveBeenCalledWith(
        {
          title: 'GoodBuddy 对话',
          directory: process.cwd(),
          permission: [
            { permission: '*', pattern: '*', action: 'deny' }
          ]
        },
        { signal: expect.any(AbortSignal) }
      )
      expect(tool.ids).toHaveBeenCalledWith(
        { directory: process.cwd() },
        { signal: expect.any(AbortSignal) }
      )
      expect(session.promptAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: {
            read: false,
            write: false,
            bash: false,
            task: false,
            'goodbuddy-data-*': false,
            'goodbuddy-custom-*': false
          }
        }),
        expect.anything()
      )
      await runtime.dispose()
  })

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

    expect(session.update).toHaveBeenCalledWith(
      {
        sessionID: 'session-1',
        directory: process.cwd(),
        permission: [
          { permission: '*', pattern: '*', action: 'deny' }
        ]
      },
      { signal: expect.any(AbortSignal) }
    )
    await runtime.dispose()
  })

  it('configures external Execute sessions without whole-run approval', async () => {
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
    await collectRun(runtime, 'execute')

    expect(runtime.requiresToolApproval).toBe(false)
    expect(session.create).toHaveBeenCalledWith(
      {
        title: 'GoodBuddy 对话',
        directory: process.cwd(),
        permission: [
          { permission: '*', pattern: '*', action: 'allow' }
        ]
      },
      { signal: expect.any(AbortSignal) }
    )
    expect(permissionReply).not.toHaveBeenCalled()
    await runtime.dispose()
  })
})

describe('OpenCodeRuntime native customization', () => {
  it('maps bounded native inventory and filters GoodBuddy-owned capabilities', async () => {
    const sourceRoot = await mkdtemp(
      join(tmpdir(), 'goodbuddy-opencode-native-snapshot-')
    )
    const assignedSkillDirectory = join(
      sourceRoot,
      'assigned-skill'
    )
    await mkdir(assignedSkillDirectory)
    await writeFile(
      join(assignedSkillDirectory, 'SKILL.md'),
      [
        '---',
        'name: assigned-skill',
        'description: Assigned test skill',
        '---',
        '',
        '# Assigned skill'
      ].join('\n'),
      'utf8'
    )
    const client = {
      session: {
        list: vi.fn().mockResolvedValue({
          data: [],
          error: undefined
        })
      },
      app: {
        agents: vi.fn().mockResolvedValue({
          data: [
            {
              name: 'build',
              description: 'Primary builder',
              mode: 'primary',
              native: true,
              hidden: false,
              permission: [],
              options: {}
            },
            {
              name: 'hidden',
              mode: 'all',
              hidden: true,
              permission: [],
              options: {}
            }
          ]
        }),
        skills: vi.fn().mockResolvedValue({
          data: [
            {
              name: 'native-skill',
              description: 'Native skill',
              location: 'C:\\private\\native',
              content: 'must not be exposed'
            },
            {
              name: 'assigned-skill',
              location: 'C:\\private\\assigned',
              content: 'assigned content'
            }
          ]
        })
      },
      tool: {
        ids: vi.fn().mockResolvedValue({
          data: [
            'apply_patch',
            'bash',
            'edit',
            'glob',
            'grep',
            'invalid',
            'question',
            'read',
            'skill',
            'task',
            'todowrite',
            'webfetch',
            'websearch',
            'write',
            'goodbuddy-data-123_search',
            'extension_tool'
          ],
          error: undefined
        })
      },
      command: {
        list: vi.fn().mockResolvedValue({
          data: [
            {
              name: 'review',
              description: 'Review changes',
              source: 'command',
              template: 'private command template',
              hints: []
            },
            {
              name: 'mcp-prompt',
              description: 'Prompt from MCP',
              source: 'mcp',
              template: 'Inspect $ARGUMENTS',
              hints: []
            },
            {
              name: 'assigned-skill',
              source: 'skill',
              template: 'assigned skill template',
              hints: []
            },
            {
              name: 'goodbuddy-data-123',
              source: 'mcp',
              template: 'temporary prompt',
              hints: []
            }
          ]
        })
      },
      lsp: {
        status: vi.fn().mockResolvedValue({
          data: [
            {
              id: 'typescript',
              name: 'TypeScript',
              root: 'C:\\private\\workspace',
              status: 'connected'
            }
          ]
        })
      },
      formatter: {
        status: vi.fn().mockResolvedValue({
          data: [
            {
              name: 'prettier',
              enabled: true,
              extensions: ['.ts', '.tsx']
            }
          ]
        })
      },
      mcp: {
        status: vi.fn().mockResolvedValue({
          data: {
            public: { status: 'failed', error: 'private failure' },
            'goodbuddy-custom-123': { status: 'connected' }
          }
        })
      },
      experimental: {
        resource: {
          list: vi.fn().mockResolvedValue({
            data: {
              'public-resource': {
                name: 'Public resource',
                uri: 'docs://public',
                description: 'Reference',
                mimeType: 'text/plain',
                client: 'public'
              },
              temporary: {
                name: 'Temporary resource',
                uri: 'docs://temporary',
                client: 'goodbuddy-data-123'
              }
            }
          })
        }
      }
    } as unknown as ReturnType<typeof createOpencodeClient>
    const runtime = embeddedRuntime(client, {
      skillPackages: [
        {
          id: 'assigned-skill',
          directory: assignedSkillDirectory
        }
      ]
    })

    const snapshot = await runtime.getNativeSnapshot()

    expect(snapshot).toMatchObject({
      available: true,
      inventoryStatus: 'available',
      detail: 'OpenCode 原生能力已就绪',
      agents: [
        {
          id: 'build',
          mode: 'primary',
          native: true,
          hidden: false
        },
        {
          id: 'hidden',
          hidden: true
        }
      ],
      toolsSupported: true,
      tools: expect.arrayContaining([
        {
          id: 'edit',
          name: 'edit',
          kind: 'write',
          source: 'runtime',
          ask: 'blocked',
          execute: 'allowed'
        },
        {
          id: 'read',
          name: 'read',
          kind: 'read',
          source: 'runtime',
          ask: 'blocked',
          execute: 'allowed'
        },
        {
          id: 'skill',
          name: 'skill',
          kind: 'agent',
          source: 'runtime',
          ask: 'conditional',
          execute: 'allowed'
        },
        {
          id: 'extension_tool',
          name: 'extension_tool',
          kind: 'other',
          source: 'unknown',
          ask: 'blocked',
          execute: 'allowed'
        }
      ]),
      commands: [
        {
          id: 'review',
          source: 'command'
        },
        {
          id: 'mcp-prompt',
          source: 'mcp'
        }
      ],
      prompts: [
        {
          id: 'mcp-prompt',
          prompt: 'Inspect $ARGUMENTS',
          source: 'mcp'
        }
      ],
      lsp: [
        {
          id: 'typescript',
          name: 'TypeScript',
          status: 'connected'
        }
      ],
      formatters: [
        {
          id: 'prettier',
          enabled: true,
          extensions: ['.ts', '.tsx']
        }
      ],
      mcpServers: [
        {
          id: 'public',
          status: 'failed'
        }
      ],
      skills: [
        {
          id: 'native-skill',
          description: 'Native skill'
        }
      ],
      resources: [
        {
          id: 'public-resource',
          uri: 'docs://public',
          server: 'public'
        }
      ],
      resourcesSupported: true,
      context: {
        strategy: 'native',
        manualCompact: true
      }
    })
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('private failure')
    expect(serialized).not.toContain('private command template')
    expect(serialized).not.toContain('must not be exposed')
    expect(serialized).not.toContain('C:\\private')
    expect(serialized).not.toContain('assigned-skill')
    expect(serialized).not.toContain('goodbuddy-data-')
    expect(serialized).not.toContain('goodbuddy-custom-')
    expect(serialized).not.toContain('"invalid"')

    vi.mocked(client.tool.ids).mockRejectedValueOnce(
      new Error('tool inventory unavailable')
    )
    const partialSnapshot = await runtime.getNativeSnapshot()
    expect(partialSnapshot).toMatchObject({
      available: true,
      inventoryStatus: 'partial',
      tools: [],
      toolsSupported: false
    })
    expect(partialSnapshot.detail).toContain('工具')
    await runtime.dispose()
    await rm(sourceRoot, { recursive: true, force: true })
  })

  it('reports external OpenCode connectivity without claiming readable native inventory', async () => {
    const client = runClient([]).client
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

    await expect(runtime.getNativeSnapshot()).resolves.toMatchObject({
      available: true,
      inventoryStatus: 'connection-only',
      tools: [],
      toolsSupported: false
    })
    expect(client.tool.ids).not.toHaveBeenCalled()
    await runtime.dispose()
  })

  it('uses an explicit valid agent over the configured default', async () => {
    const setup = runClient([
      {
        id: 'idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    Object.assign(setup.client, {
      app: {
        agents: vi.fn().mockResolvedValue({
          data: [
            {
              name: 'build',
              mode: 'primary',
              hidden: false,
              permission: [],
              options: {}
            },
            {
              name: 'plan',
              mode: 'all',
              hidden: false,
              permission: [],
              options: {}
            }
          ]
        })
      }
    })
    const runtime = embeddedRuntime(setup.client, {
      customization: { defaultAgent: 'build' }
    })

    for await (const _event of runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'test',
        workMode: 'execute',
        runtimeControl: {
          provider: 'opencode',
          agent: 'plan'
        }
      },
      new AbortController().signal
    )) {
      void _event
    }

    expect(setup.session.create).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'plan' }),
      { signal: expect.any(AbortSignal) }
    )
    expect(setup.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'plan' }),
      expect.anything()
    )
    await runtime.dispose()
  })

  it('uses the configured default agent when no request override is present', async () => {
    const setup = runClient([
      {
        id: 'idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    Object.assign(setup.client, {
      app: {
        agents: vi.fn().mockResolvedValue({
          data: [
            {
              name: 'build',
              mode: 'primary',
              hidden: false,
              permission: [],
              options: {}
            }
          ]
        })
      }
    })
    const runtime = embeddedRuntime(setup.client, {
      customization: { defaultAgent: 'build' }
    })

    await collectRun(runtime)

    expect(setup.session.create).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'build' }),
      { signal: expect.any(AbortSignal) }
    )
    expect(setup.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'build' }),
      expect.anything()
    )
    await runtime.dispose()
  })

  it('rejects a stale or hidden agent instead of falling back', async () => {
    const setup = runClient([])
    Object.assign(setup.client, {
      app: {
        agents: vi.fn().mockResolvedValue({
          data: [
            {
              name: 'hidden',
              mode: 'primary',
              hidden: true,
              permission: [],
              options: {}
            }
          ]
        })
      }
    })
    const runtime = embeddedRuntime(setup.client)
    const stream = runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'test',
        workMode: 'execute',
        runtimeControl: {
          provider: 'opencode',
          agent: 'hidden'
        }
      },
      new AbortController().signal
    )

    await expect(stream.next()).rejects.toThrow(
      'OpenCode Agent 不存在、已隐藏或不可作为主 Agent：hidden'
    )
    expect(setup.session.create).not.toHaveBeenCalled()
    expect(setup.session.promptAsync).not.toHaveBeenCalled()
    await runtime.dispose()
  })

  it('executes validated native commands through the command API', async () => {
    const setup = runClient([
      {
        id: 'idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const command = vi.fn().mockResolvedValue({
      data: { info: {}, parts: [] }
    })
    Object.assign(setup.client, {
      app: {
        agents: vi.fn().mockResolvedValue({
          data: [
            {
              name: 'build',
              mode: 'primary',
              hidden: false,
              permission: [],
              options: {}
            }
          ]
        })
      },
      command: {
        list: vi.fn().mockResolvedValue({
          data: [
            {
              name: 'review',
              source: 'command',
              template: 'Review $ARGUMENTS',
              hints: []
            }
          ]
        })
      }
    })
    Object.assign(setup.client.session, { command })
    const runtime = embeddedRuntime(setup.client)

    const events = []
    for await (const event of runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'must not become slash text',
        workMode: 'execute',
        runtimeControl: {
          provider: 'opencode',
          agent: 'build',
          command: {
            name: 'review',
            arguments: '--staged'
          }
        }
      },
      new AbortController().signal
    )) {
      events.push(event)
    }

    expect(command).toHaveBeenCalledWith(
      {
        sessionID: 'session-1',
        directory: process.cwd(),
        command: 'review',
        arguments: '--staged',
        agent: 'build'
      },
      expect.objectContaining({
        signal: expect.any(AbortSignal)
      })
    )
    expect(setup.session.promptAsync).not.toHaveBeenCalled()
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      sessionId: 'session-1'
    })
    await runtime.dispose()
  })

  it('compacts a managed session through the supported native API', async () => {
    const setup = runClient([
      {
        id: 'idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const context = vi.fn().mockResolvedValue({
      data: {
        data: [
          {
            type: 'assistant',
            model: {
              providerID: 'anthropic',
              id: 'claude-sonnet'
            }
          }
        ]
      }
    })
    const summarize = vi.fn().mockResolvedValue({
      data: true,
      error: undefined
    })
    Object.assign(setup.client, {
      v2: {
        session: { context }
      },
      session: { ...setup.client.session, summarize }
    })
    const runtime = embeddedRuntime(setup.client)
    await collectRun(runtime)
    vi.mocked(setup.event.subscribe).mockResolvedValueOnce({
      stream: (async function* () {
        yield {
          type: 'message.updated',
          properties: {
            sessionID: 'session-1',
            info: {
              id: 'compaction-message',
              sessionID: 'session-1',
              role: 'assistant',
              time: {
                created: 1,
                completed: 2
              },
              parentID: 'compaction-parent',
              modelID: 'claude-sonnet',
              providerID: 'anthropic',
              mode: 'compaction',
              agent: 'build',
              path: {
                cwd: process.cwd(),
                root: process.cwd()
              },
              cost: 0,
              tokens: {
                input: 100,
                output: 20,
                reasoning: 0,
                cache: {
                  read: 30,
                  write: 4
                },
                total: 124
              },
              finish: 'stop'
            }
          }
        }
        yield {
          type: 'session.idle',
          properties: { sessionID: 'session-1' }
        }
      })()
    } as never)
    const signal = new AbortController().signal

    await expect(
      runtime.compactConversation(
        {
          requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
          conversationId: 'conversation-1',
          runtimeSelection: { provider: 'opencode' },
          history: [],
          historyMessageIds: []
        },
        signal
      )
    ).resolves.toEqual({
      result: {
        provider: 'opencode',
        strategy: 'native',
        compacted: true,
        detail: 'OpenCode 已完成原生上下文压缩'
      },
      usageEvents: [
        {
          requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
          type: 'model-usage',
          callId: 'compaction-message',
          runtime: 'opencode',
          provider: 'anthropic',
          model: 'claude-sonnet',
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 30,
          cacheWriteTokens: 4,
          reportedTotalTokens: 124
        }
      ]
    })
    expect(context).toHaveBeenCalledWith(
      { sessionID: 'session-1' },
      { signal: expect.any(AbortSignal) }
    )
    expect(summarize).toHaveBeenCalledWith(
      {
        sessionID: 'session-1',
        directory: process.cwd(),
        providerID: 'anthropic',
        modelID: 'claude-sonnet',
        auto: false
      },
      { signal: expect.any(AbortSignal) }
    )
    await runtime.dispose()
  })

  it('reports when a managed session has no model to compact with', async () => {
    const setup = runClient([
      {
        id: 'idle',
        type: 'session.idle',
        properties: { sessionID: 'session-1' }
      }
    ])
    const context = vi.fn().mockResolvedValue({
      data: { data: [] }
    })
    const summarize = vi.fn()
    Object.assign(setup.client, {
      v2: {
        session: { context }
      },
      session: { ...setup.client.session, summarize }
    })
    const runtime = embeddedRuntime(setup.client)
    await collectRun(runtime)

    await expect(
      runtime.compactConversation(
        {
          requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
          conversationId: 'conversation-1',
          runtimeSelection: { provider: 'opencode' },
          history: [],
          historyMessageIds: []
        },
        new AbortController().signal
      )
    ).resolves.toEqual({
      result: {
        provider: 'opencode',
        strategy: 'native',
        compacted: false,
        detail: '当前 OpenCode 会话尚无可用于压缩的模型记录'
      }
    })
    expect(summarize).not.toHaveBeenCalled()
    await runtime.dispose()
  })

  it('reports when no managed OpenCode session can be compacted', async () => {
    const runtime = new OpenCodeRuntime(options())

    await expect(
      runtime.compactConversation(
        {
          requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
          conversationId: 'missing-conversation',
          runtimeSelection: { provider: 'opencode' },
          history: [],
          historyMessageIds: []
        },
        new AbortController().signal
      )
    ).resolves.toEqual({
      result: {
        provider: 'opencode',
        strategy: 'native',
        compacted: false,
        detail: '当前 GoodBuddy 对话尚无可压缩的 OpenCode 会话'
      }
    })
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
