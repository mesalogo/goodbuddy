import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ContinueHostAdapter,
  type ContinueHostLauncher
} from './continue-host-adapter'

const temporaryDirectories: string[] = []

async function createDistribution(version = '1.5.47'): Promise<{
  cacheRoot: string
  entryPath: string
  sourceHash: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-continue-host-'))
  temporaryDirectories.push(root)
  const distribution = join(root, 'package', 'dist')
  const cacheRoot = join(root, 'cache')
  await mkdir(distribution, { recursive: true })
  await writeFile(
    join(root, 'package', 'package.json'),
    JSON.stringify({ version }),
    'utf8'
  )
  await writeFile(join(distribution, 'cn.js'), 'import "./index.js"\n', 'utf8')
  await writeFile(join(distribution, 'xhr-sync-worker.js'), '', 'utf8')
  const sourceBundle = [
    'toolPermissionOverrides:s,headless:!0});let[a,u,l,c]',
    'i={allow:o.allow,ask:o.ask,exclude:o.exclude,isHeadless:e.headless}',
    'E6t.initialize({isHeadless:e.headless},r,n)',
    'let j=(0,atn.default)();j.use(atn.default.json()),j.get("/state"',
    'listen(i,async()=>{console.log(Ht.green(`Server started on http://localhost:${i}`))',
    'async function SCt(e){return n5e||'
  ].join(';')
  await writeFile(join(distribution, 'index.js'), sourceBundle, 'utf8')
  return {
    cacheRoot,
    entryPath: join(distribution, 'cn.js'),
    sourceHash: createHash('sha256')
      .update(sourceBundle)
      .digest('hex')
  }
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('ContinueHostAdapter', () => {
  it('creates a versioned authenticated loopback host copy', async () => {
    const distribution = await createDistribution()
    const adapter = new ContinueHostAdapter({
      binaryPath: distribution.entryPath,
      configPath: '',
      workspace: process.cwd(),
      cacheRoot: distribution.cacheRoot,
      trustedBundleHashes: [distribution.sourceHash]
    })

    const prepared = await adapter.getPreparedHost()
    const bundle = await readFile(
      join(prepared.entryPath, '..', 'index.js'),
      'utf8'
    )
    const bootstrap = await readFile(
      join(prepared.entryPath, '..', 'utility-bootstrap.mjs'),
      'utf8'
    )

    expect(prepared.version).toBe('1.5.47')
    expect(bundle).toContain('interactivePermissions:!0')
    expect(bundle).toContain(
      'isHeadless:e.interactivePermissions?!1:e.headless'
    )
    expect(bundle).toContain('GOODBUDDY_CONTINUE_HOST_TOKEN')
    expect(bundle).toContain('listen(i,"127.0.0.1"')
    expect(bundle).toContain(
      'GOODBUDDY_DISABLE_CONTINUE_UPDATES'
    )
    expect(bundle).not.toContain(
      'toolPermissionOverrides:s,headless:!0});let'
    )
    expect(bootstrap).toContain(
      'process.argv = process.argv.slice(2)'
    )
  })

  it('rejects unsupported Continue versions without patching them', async () => {
    const distribution = await createDistribution('1.6.0')
    const adapter = new ContinueHostAdapter({
      binaryPath: distribution.entryPath,
      configPath: '',
      workspace: process.cwd(),
      cacheRoot: distribution.cacheRoot,
      trustedBundleHashes: [distribution.sourceHash]
    })

    await expect(adapter.getPreparedHost()).rejects.toThrow(
      '仅支持 1.5.47'
    )
  })

  it('rejects an untrusted bundle even when markers and version match', async () => {
    const distribution = await createDistribution()
    const adapter = new ContinueHostAdapter({
      binaryPath: distribution.entryPath,
      configPath: '',
      workspace: process.cwd(),
      cacheRoot: distribution.cacheRoot,
      trustedBundleHashes: ['0'.repeat(64)]
    })

    await expect(adapter.getPreparedHost()).rejects.toThrow(
      '兼容性校验'
    )
  })

  it('launches the prepared host through the injected launcher', async () => {
    const distribution = await createDistribution()
    let launch:
      | {
          entryPath: string
          args: string[]
          env: NodeJS.ProcessEnv
        }
      | undefined
    let killed = false
    let generatedConfig = ''
    let generatedConfigPath = ''
    const launchHost: ContinueHostLauncher = (
      entryPath,
      args,
      options
    ) => {
      launch = { entryPath, args, env: options.env }
      const configIndex = args.indexOf('--config')
      if (configIndex >= 0) {
        generatedConfigPath = args[configIndex + 1] ?? ''
        generatedConfig = readFileSync(generatedConfigPath, 'utf8')
      }
      return {
        exitCode: null,
        get killed() {
          return killed
        },
        stderr: null,
        once: () => undefined,
        kill: () => {
          killed = true
          return true
        }
      }
    }
    let stateRequests = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith('/state')) {
          stateRequests += 1
          return new Response(
            JSON.stringify({
              session: {
                history:
                  stateRequests === 1
                    ? []
                    : [
                        {
                          message: {
                            role: 'assistant',
                            content: 'HOST_LAUNCH_OK'
                          }
                        }
                      ],
                usage:
                  stateRequests === 1
                    ? {
                        promptTokens: 20,
                        completionTokens: 10,
                        promptTokensDetails: {
                          cachedTokens: 5,
                          cacheWriteTokens: 2
                        }
                      }
                    : {
                        promptTokens: 19,
                        completionTokens: 9,
                        promptTokensDetails: {
                          cachedTokens: 4,
                          cacheWriteTokens: 1
                        }
                      }
              },
              isProcessing: false,
              messageQueueLength: 0,
              pendingPermission: null
            })
          )
        }
        return new Response('{}')
      })
    )
    const adapter = new ContinueHostAdapter({
      binaryPath: distribution.entryPath,
      configPath: '',
      workspace: process.cwd(),
      cacheRoot: distribution.cacheRoot,
      trustedBundleHashes: [distribution.sourceHash],
      launchHost,
      mode: 'chat',
      modelProfile: {
        id: '00000000-0000-4000-8000-000000000011',
        name: '独立模型',
        baseUrl: 'https://model.example',
        modelName: 'private-model',
        protocol: 'anthropic-messages',
        authentication: 'api-key',
        apiKey: 'private-key'
      }
    })

    await expect(
      adapter.run('hello', new AbortController().signal, async () => 'deny')
    ).resolves.toEqual({
      text: 'HOST_LAUNCH_OK',
      usage: {
        provider: 'anthropic',
        model: 'private-model',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      }
    })
    expect(launch?.entryPath).toContain('host-v2')
    expect(launch?.args).toEqual([
      '--config',
      expect.stringContaining('model-config-'),
      '--readonly',
      'serve',
      '--port',
      expect.any(String),
      '--timeout',
      '300'
    ])
    expect(launch?.env.GOODBUDDY_CONTINUE_HOST_TOKEN).toEqual(
      expect.any(String)
    )
    expect(launch?.env).toMatchObject({
      CONTINUE_CLI_AUTO_UPDATED: '1',
      CONTINUE_CLI_ENABLE_TELEMETRY: '0',
      CONTINUE_METRICS_ENABLED: '0',
      CONTINUE_GLOBAL_DIR: expect.stringContaining('isolated-global'),
      GOODBUDDY_DISABLE_CONTINUE_UPDATES: '1',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: '',
      OTEL_LOG_USER_PROMPTS: '0'
    })
    expect(killed).toBe(true)
    expect(JSON.parse(generatedConfig)).toMatchObject({
      models: [
        {
          apiBase: 'https://model.example/v1',
          apiKey: '${{ secrets.ANTHROPIC_API_KEY }}',
          model: 'private-model'
        }
      ]
    })
    expect(generatedConfig).not.toContain('private-key')
    expect(launch?.env.ANTHROPIC_API_KEY).toBe('private-key')
    expect(existsSync(generatedConfigPath)).toBe(false)
  })

  it('generates an OpenAI config without a fake key for Ollama', async () => {
    const distribution = await createDistribution()
    let generatedConfig = ''
    let launchedEnvironment: NodeJS.ProcessEnv | undefined
    const launchHost: ContinueHostLauncher = (_entryPath, args, options) => {
      const configIndex = args.indexOf('--config')
      generatedConfig = readFileSync(args[configIndex + 1] ?? '', 'utf8')
      launchedEnvironment = options.env
      return {
        exitCode: null,
        killed: false,
        stderr: null,
        once: () => undefined,
        kill: () => true
      }
    }
    let stateRequests = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith('/state')) {
          stateRequests += 1
          return Response.json({
            session: {
              history:
                stateRequests === 1
                  ? []
                  : [
                      {
                        message: {
                          role: 'assistant',
                          content: 'OLLAMA_OK'
                        }
                      }
                    ],
              usage:
                stateRequests === 1
                  ? {
                      promptTokens: 100,
                      completionTokens: 20,
                      promptTokensDetails: {
                        cachedTokens: 10,
                        cacheWriteTokens: 3
                      }
                    }
                  : {
                      promptTokens: 131,
                      completionTokens: 29,
                      promptTokensDetails: {
                        cachedTokens: 23,
                        cacheWriteTokens: 7
                      }
                    }
            },
            isProcessing: false,
            messageQueueLength: 0,
            pendingPermission: null
          })
        }
        return Response.json({})
      })
    )
    const adapter = new ContinueHostAdapter({
      binaryPath: distribution.entryPath,
      configPath: '',
      workspace: process.cwd(),
      cacheRoot: distribution.cacheRoot,
      trustedBundleHashes: [distribution.sourceHash],
      launchHost,
      modelProfile: {
        id: '00000000-0000-4000-8000-000000000012',
        name: 'Ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        modelName: 'qwen3',
        protocol: 'openai-chat-completions',
        authentication: 'none'
      }
    })

    await expect(
      adapter.run('hello', new AbortController().signal, async () => 'deny')
    ).resolves.toEqual({
      text: 'OLLAMA_OK',
      usage: {
        provider: 'openai',
        model: 'qwen3',
        inputTokens: 31,
        outputTokens: 9,
        cacheReadTokens: 13,
        cacheWriteTokens: 4
      }
    })
    expect(JSON.parse(generatedConfig)).toMatchObject({
      models: [
        {
          provider: 'openai',
          apiBase: 'http://127.0.0.1:11434/v1',
          model: 'qwen3'
        }
      ]
    })
    expect(generatedConfig).not.toContain('apiKey')
    expect(launchedEnvironment).not.toHaveProperty('OPENAI_API_KEY')
    expect(launchedEnvironment).not.toHaveProperty('ANTHROPIC_API_KEY')
  })
})
