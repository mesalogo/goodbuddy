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
  > = {}
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
  return new OpenCodeRuntime(options(overrides), deps)
}

async function collectRun(
  runtime: OpenCodeRuntime,
  workMode: 'ask' | 'plan' | 'execute' = 'execute'
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
    setTimeout(() => {
      stdoutOf(child).write(
        'opencode server listening on http://127.0.0.1:3012\n'
      )
    }, 0)
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

    await expect(runtime.getStatus()).resolves.toMatchObject({
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
    setTimeout(() => {
      stdoutOf(child).write(
        'opencode server listening on http://127.0.0.1:3013\n'
      )
    }, 0)
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
      await expect(runtime.getStatus()).resolves.toMatchObject({
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
      const server = createServer((request, response) => {
        requestPaths.push(request.url ?? '')
        request.resume()
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
            process.platform === 'win32'
              ? 'opencode.exe'
              : 'opencode'
          ),
          defaultWorkspace: root,
          modelProfile: {
            id: '00000000-0000-4000-8000-000000000013',
            name: 'Local endpoint probe',
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            modelName: 'probe-model',
            protocol,
            authentication: 'api-key',
            apiKey: 'local-probe-key'
          }
        })
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
      setTimeout(() => {
        stdoutOf(child).write(
          'opencode server listening on http://127.0.0.1:3012\n'
        )
      }, 0)
      const runtime = new OpenCodeRuntime(
        options({
          modelProfile: {
            id: '00000000-0000-4000-8000-000000000012',
            name: 'OpenAI 独立模型',
            baseUrl: 'https://model.example/v1',
            modelName: 'custom-model',
            protocol,
            authentication,
            ...(authentication === 'api-key'
              ? { apiKey: 'private-key' }
              : {})
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
          baseURL: 'https://model.example/v1'
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

  it.each([
    'https://127.0.0.1:4321',
    'http://0.0.0.0:4321',
    'http://example.com:4321',
    'http://127.0.0.1',
    'http://127.0.0.1:4321/admin'
  ])('rejects an unsafe listening URL: %s', async (url) => {
    const child = fakeChild()
    const { deps, createClient } = dependencies(child, {
      spawn: vi.fn(() => {
        queueMicrotask(() => {
          stdoutOf(child).write(`opencode server listening on ${url}\n`)
          closeChild(child, 7)
        })
        return child
      }) as unknown as typeof spawn
    })
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

    const status = await runtime.getStatus()

    expect(status.detail).toBe('OpenCode Server 启动前退出（code 9）')
    expect(status.detail).not.toContain(secret)
    expect(registrationRoot).toBeTruthy()
    await expect(stat(registrationRoot)).rejects.toThrow()
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
    expect(runtime.requiresToolApproval).toBe(false)
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
        workMode: 'execute'
      },
      new AbortController().signal
    )) {
      events.push(event)
    }

    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        system: '# 文档写作',
        parts: [{ type: 'text', text: 'test' }]
      }),
      expect.objectContaining({
        signal: expect.any(AbortSignal)
      })
    )
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    await runtime.dispose()
  })
})

describe('OpenCodeRuntime embedded permission mediation', () => {
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
    await expect(stream.next()).resolves.toMatchObject({
      value: {
        type: 'question',
        questionId: 'question-1',
        questions: [
          {
            header: '实现方式',
            question: '请选择实现方式',
            multiple: false,
            custom: true
          }
        ]
      }
    })
    await runtime.respondToQuestion('question-1', [['先写测试']])
    expect(setup.questionReply).toHaveBeenCalledWith({
      requestID: 'question-1',
      directory: process.cwd(),
      answers: [['先写测试']]
    })
    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'done' }
    })
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
    setTimeout(() => {
      stdoutOf(child).write(
        'opencode server listening on http://127.0.0.1:4010\n'
      )
    }, 0)
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

    expect(setup.client.mcp.add).toHaveBeenCalledWith({
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
    })
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
      })
    )
    expect(setup.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: {
          read: false,
          write: false,
          bash: false,
          [knowledgeToolId]: true
        }
      }),
      expect.anything()
    )
    expect(setup.client.mcp.disconnect).toHaveBeenCalledWith({
      name: expect.stringMatching(/^goodbuddy-data-/u),
      directory: process.cwd()
    })
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
    setTimeout(() => {
      stdoutOf(child).write(
        'opencode server listening on http://127.0.0.1:4010\n'
      )
    }, 0)
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

  it('serializes overlapping embedded MCP registration and discovery', async () => {
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
    setTimeout(() => {
      stdoutOf(child).write(
        'opencode server listening on http://127.0.0.1:4010\n'
      )
    }, 0)
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
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(mcpAdd).toHaveBeenCalledTimes(1)

    resolveFirstAdd()
    await first
    await vi.waitFor(() => expect(mcpAdd).toHaveBeenCalledTimes(2))
    await second
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

      expect(setup.session.create).toHaveBeenCalledWith({
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
      })
      expect(setup.session.promptAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          system: undefined,
          tools: {
            read: false,
            write: false,
            bash: false,
            task: false,
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

  it('subscribes before prompting and auto-allows a tool request', async () => {
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
    expect(session.create).toHaveBeenCalledWith({
      title: 'GoodBuddy 对话',
      directory: process.cwd(),
      permission: [
        { permission: '*', pattern: '*', action: 'ask' },
        { permission: 'task', pattern: '*', action: 'deny' }
      ]
    })
    expect(permissionReply).toHaveBeenCalledOnce()
    expect(permissionReply).toHaveBeenCalledWith({
      requestID: 'permission-1',
      directory: process.cwd(),
      reply: 'once'
    })
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

  it('auto-allows each bounded tool request without GoodBuddy approval', async () => {
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
        }
      ],
      [
        {
          requestID: 'permission-2',
          directory: process.cwd(),
          reply: 'once'
        }
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

    expect(session.delete).toHaveBeenCalledWith({
      sessionID: 'session-1',
      directory: process.cwd()
    })
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
      collectRun(runtime, 'execute')
    ).rejects.toThrow('OpenCode 权限回复失败')
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

  it('leaves trusted external sessions unmodified and skips whole-run approval', async () => {
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
    expect(session.create).toHaveBeenCalledWith({
      title: 'GoodBuddy 对话',
      directory: process.cwd()
    })
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
