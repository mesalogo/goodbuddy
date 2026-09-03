import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ContinueHostAdapter,
  inspectContinueNativeConfiguration,
  type ContinueHostLauncher
} from './continue-host-adapter'

const temporaryDirectories: string[] = []
const environmentRestorations: Array<() => void> = []

const inheritedProviderCredentials = {
  ANTHROPIC_API_KEY: 'inherited-anthropic',
  OPENAI_API_KEY: 'inherited-openai',
  GOOGLE_GENERATIVE_AI_API_KEY: 'inherited-google',
  GEMINI_API_KEY: 'inherited-gemini',
  AWS_ACCESS_KEY_ID: 'inherited-aws-access',
  AWS_SECRET_ACCESS_KEY: 'inherited-aws-secret',
  AWS_SESSION_TOKEN: 'inherited-aws-session',
  AWS_PROFILE: 'inherited-aws-profile',
  OPENROUTER_API_KEY: 'inherited-openrouter'
} as const

function inheritProviderCredentials(): void {
  const previousEnvironment = Object.fromEntries(
    Object.keys(inheritedProviderCredentials).map((name) => [
      name,
      process.env[name]
    ])
  )
  Object.assign(process.env, inheritedProviderCredentials)
  environmentRestorations.push(() => {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  })
}

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
    'function ZZo(e){let t=[];if(e.exclude)for(let n of e.exclude){let r=n;t.push({tool:r,permission:"exclude"})}if(e.ask)for(let n of e.ask){let r=n;t.push({tool:r,permission:"ask"})}if(e.allow)for(let n of e.allow){let r=n;t.push({tool:r,permission:"allow"})}return t}',
    'let j=(0,atn.default)();j.use(atn.default.json()),j.get("/state"',
    'listen(i,async()=>{console.log(Ht.green(`Server started on http://localhost:${i}`))',
    'async function SCt(e){return n5e||',
    'shouldUseResponsesEndpoint(t){return this.config.useResponsesApi===!1?!1:this.apiBase==="https://api.openai.com/v1/"&&A0e(t)}',
    'function uAe(e,t){let n={provider:e.provider,model:e.model,apiKey:e.apiKey,apiBase:e.apiBase,requestOptions:e.requestOptions,env:e.env};return CGn(n)??null}',
    'function Sin(e,t){let n=[];n.push({role:"system",content:t});let r=oot(e);return n.push(...r),n}',
    'function Csa(e){return process.platform==="win32"?{shell:"powershell.exe",args:["-NoLogo","-ExecutionPolicy","Bypass","-Command",e]}',
    'let{shell:d,args:p}=Csa(e),f=Esa(d,p),g="",y="",A,S=!1,x=18e4;',
    'let r=[eS.join(n,".continue",AKt),eS.join(n,".claude",AKt),eS.join(hu.continueHome,AKt)],o=',
    'a={onContent:u=>{},onContentComplete:u=>{},onToolStart:(u,l)=>{},onToolResult:(u,l,c)=>{},onToolError:(u,l)=>{},onToolPermissionRequest:',
    'pendingPermission:null},B=',
    'j.get("/state",(we,Te)=>{M.lastActivity=Date.now(),B();let ue=e7e(M.session,M.isProcessing,rS.getQueueLength(),M.pendingPermission);Te.json(ue)})',
    'n?.onToolStart?.(i.name,i.arguments);',
    'n?.onToolError?.(l,i.name)',
    't?.onToolStart?.(c.name,c.arguments);',
    't?.onToolResult?.(String(y.content),c.name,"canceled")',
    't?.onToolResult?.(f,c.name,"done")',
    't?.onToolError?.(g,c.name)',
    't?.onToolError?.(p,c.name)'
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
  for (const restoreEnvironment of environmentRestorations.splice(0)) {
    restoreEnvironment()
  }
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
    expect(bundle).toContain('json({limit:"20mb"})')
    expect(bundle).toContain('listen(i,"127.0.0.1"')
    expect(bundle).toContain(
      'GOODBUDDY_DISABLE_CONTINUE_UPDATES'
    )
    expect(bundle).toContain(
      'this.config.useResponsesApi===!0?!0'
    )
    expect(bundle).toContain(
      'useResponsesApi:e.useResponsesApi'
    )
    expect(bundle).toContain(
      'let r=oot(e).filter(o=>o.role!=="system")'
    )
    expect(bundle).toContain('"-NoProfile"')
    expect(bundle).toContain('[Console]::OutputEncoding')
    expect(bundle).toContain(
      'f.stdout.setEncoding("utf8"),f.stderr.setEncoding("utf8")'
    )
    expect(bundle).toContain(
      'let r=[eS.join(hu.continueHome,AKt)],o='
    )
    expect(bundle).toContain('goodbuddyEvents:[]')
    expect(bundle).toContain('goodbuddyEventsBytes:0')
    expect(bundle).toContain('goodbuddyEventsBytes+=Buffer.byteLength')
    expect(bundle).toContain('goodbuddyEventsBytes<=2097152')
    expect(bundle).toContain('l.length<=1e5')
    expect(bundle).toContain('goodbuddyEventsOverflow:!1')
    expect(bundle).toContain('goodbuddyEventsOverflow=!0')
    expect(bundle).toContain('goodbuddyEvents:ce')
    expect(bundle).toContain('/goodbuddy/question-answer')
    expect(bundle).toContain(
      'goodbuddyQuestion:Lbe.currentState.pendingQuestion'
    )
    expect(bundle.indexOf('GOODBUDDY_CONTINUE_HOST_TOKEN')).toBeLessThan(
      bundle.indexOf('/goodbuddy/question-answer')
    )
    expect(bundle).toContain('type:"text",delta:l')
    expect(bundle).toContain('onToolStart?.(c.name,c.arguments,c.id)')
    expect(bundle).toContain(
      'function ZZo(e){let t=[];if(e.allow)'
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

  it('removes capability config when host preparation fails after generation', async () => {
    const distribution = await createDistribution()
    const adapter = new ContinueHostAdapter({
      binaryPath: distribution.entryPath,
      configPath: '',
      workspace: process.cwd(),
      cacheRoot: distribution.cacheRoot,
      trustedBundleHashes: [],
      modelProfile: {
        id: '00000000-0000-4000-8000-000000000099',
        name: 'Local model',
        baseUrl: 'http://127.0.0.1:11434/v1',
        modelName: 'qwen3',
        protocol: 'openai-chat-completions',
        authentication: 'none'
      }
    })

    await expect(
      adapter.run(
        'search',
        new AbortController().signal,
        async () => 'deny',
        {
          workMode: 'ask',
          knowledgeCapability: {
            endpoint: 'http://127.0.0.1:4567/mcp',
            token: 'main-only-token'
          }
        }
      )
    ).rejects.toThrow('未通过宿主兼容性校验')
    await expect(readdir(distribution.cacheRoot)).resolves.not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^model-config-/u)
      ])
    )
  })

  it('removes capability config when cancellation reaches the pre-spawn check', async () => {
    const distribution = await createDistribution()
    const launchHost = vi.fn<ContinueHostLauncher>()
    const adapter = new ContinueHostAdapter({
      binaryPath: distribution.entryPath,
      configPath: '',
      workspace: process.cwd(),
      cacheRoot: distribution.cacheRoot,
      trustedBundleHashes: [distribution.sourceHash],
      launchHost,
      modelProfile: {
        id: '00000000-0000-4000-8000-000000000098',
        name: 'Local model',
        baseUrl: 'http://127.0.0.1:11434/v1',
        modelName: 'qwen3',
        protocol: 'openai-chat-completions',
        authentication: 'none'
      }
    })
    const controller = new AbortController()
    const pending = adapter.run(
      'search',
      controller.signal,
      async () => 'deny',
      {
        workMode: 'ask',
        knowledgeCapability: {
          endpoint: 'http://127.0.0.1:4567/mcp',
          token: 'main-only-token'
        }
      }
    )
    setTimeout(() => controller.abort(new Error('cancelled')), 0)

    await expect(pending).rejects.toThrow('cancelled')
    expect(launchHost).not.toHaveBeenCalled()
    await expect(readdir(distribution.cacheRoot)).resolves.not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^model-config-/u)
      ])
    )
  })

  it('blocks runs without an explicit model profile or config file', async () => {
    const launchHost = vi.fn()
    const adapter = new ContinueHostAdapter({
      binaryPath: 'C:\\unused\\cn.js',
      configPath: '',
      workspace: process.cwd(),
      cacheRoot: 'C:\\unused\\cache',
      launchHost: launchHost as unknown as ContinueHostLauncher
    })

    await expect(
      adapter.run('hello', new AbortController().signal, async () => 'deny')
    ).rejects.toThrow('尚未配置模型连接')
    expect(launchHost).not.toHaveBeenCalled()
  })

  it('rejects a custom MCP loopback capability outside Continue Agent Execute mode', async () => {
    const launchHost = vi.fn()
    const adapter = new ContinueHostAdapter({
      binaryPath: 'C:\\unused\\cn.js',
      configPath: '',
      workspace: process.cwd(),
      cacheRoot: 'C:\\unused\\cache',
      launchHost: launchHost as unknown as ContinueHostLauncher,
      modelProfile: {
        id: '00000000-0000-4000-8000-000000000097',
        name: 'Local model',
        baseUrl: 'http://127.0.0.1:11434/v1',
        modelName: 'qwen3',
        protocol: 'openai-chat-completions',
        authentication: 'none'
      }
    })

    await expect(
      adapter.run(
        'hello',
        new AbortController().signal,
        async () => 'deny',
        {
          workMode: 'ask',
          customMcpCapability: {
            endpoint: 'http://127.0.0.1:4567/mcp',
            token: 'request-token'
          }
        }
      )
    ).rejects.toThrow('仅允许在 Agent Execute 模式')
    expect(launchHost).not.toHaveBeenCalled()
  })

  it('launches the prepared host through the injected launcher', async () => {
    let now = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    environmentRestorations.push(() => nowSpy.mockRestore())
    const distribution = await createDistribution()
    const skillDirectory = join(
      distribution.cacheRoot,
      '..',
      'longdoc-docx'
    )
    await mkdir(skillDirectory, { recursive: true })
    await writeFile(
      join(skillDirectory, 'SKILL.md'),
      [
        '---',
        'name: longdoc-docx',
        'description: Build a long Word document',
        '---',
        '',
        '# Long document'
      ].join('\n'),
      'utf8'
    )
    await writeFile(
      join(skillDirectory, 'build.py'),
      'print("build")\n',
      'utf8'
    )
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
    let isolatedGlobalDirectory = ''
    let registeredSkill = ''
    let registeredSkillFile = ''
    const launchEnvironmentProvider = vi.fn(() =>
      Object.freeze({
        PATH: 'C:\\GoodBuddy\\tools;C:\\System',
        OPENAI_API_KEY: 'must-not-leak',
        ELECTRON_RUN_AS_NODE: '1'
      })
    )
    const launchHost: ContinueHostLauncher = (
      entryPath,
      args,
      options
    ) => {
      launch = { entryPath, args, env: options.env }
      isolatedGlobalDirectory =
        options.env.CONTINUE_GLOBAL_DIR ?? ''
      registeredSkill = readFileSync(
        join(
          isolatedGlobalDirectory,
          'skills',
          'longdoc-docx',
          'SKILL.md'
        ),
        'utf8'
      )
      registeredSkillFile = readFileSync(
        join(
          isolatedGlobalDirectory,
          'skills',
          'longdoc-docx',
          'build.py'
        ),
        'utf8'
      )
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
          if (stateRequests === 2) {
            now += 25 * 60 * 60_000
          }
          return new Response(
            JSON.stringify({
              session: {
                history:
                  stateRequests <= 2
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
                  stateRequests <= 2
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
              isProcessing: stateRequests === 2,
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
      launchEnvironmentProvider,
      mode: 'chat',
      skillPackages: [
        {
          id: 'longdoc-docx',
          directory: skillDirectory
        }
      ],
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
      adapter.run(
        'hello',
        new AbortController().signal,
        async () => 'deny',
        {
          workMode: 'execute',
          customMcpCapability: {
            endpoint: 'http://127.0.0.1:4567/mcp',
            token: 'request-scoped-custom-token'
          }
        }
      )
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
    expect(launch?.entryPath).toContain('host-v7')
    expect(launch?.args).toEqual([
      '--config',
      expect.stringContaining('model-config-'),
      '--auto',
      'serve',
      '--port',
      expect.any(String),
      '--timeout',
      '300'
    ])
    expect(launch?.env.GOODBUDDY_CONTINUE_HOST_TOKEN).toEqual(
      expect.any(String)
    )
    expect(launchEnvironmentProvider).toHaveBeenCalledOnce()
    expect(launch?.env.PATH).toBe(
      'C:\\GoodBuddy\\tools;C:\\System'
    )
    expect(launch?.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(launch?.env).toMatchObject({
      CONTINUE_CLI_AUTO_UPDATED: '1',
      CONTINUE_CLI_ENABLE_TELEMETRY: '0',
      CONTINUE_METRICS_ENABLED: '0',
      CONTINUE_GLOBAL_DIR: expect.stringContaining('isolated-global'),
      DO_NOT_TRACK: '1',
      GOODBUDDY_DISABLE_CONTINUE_UPDATES: '1',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
      OTEL_EXPORTER_OTLP_HEADERS: '',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: '',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: '',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '',
      OTEL_LOGS_EXPORTER: 'none',
      OTEL_LOG_USER_PROMPTS: '0',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_SDK_DISABLED: 'true',
      OTEL_TRACES_EXPORTER: 'none'
    })
    if (process.platform === 'win32') {
      expect(launch?.env).toMatchObject({
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1'
      })
    }
    expect(registeredSkill).toContain('name: longdoc-docx')
    expect(registeredSkillFile).toBe('print("build")\n')
    expect(existsSync(isolatedGlobalDirectory)).toBe(false)
    expect(killed).toBe(true)
    expect(JSON.parse(generatedConfig)).toMatchObject({
      models: [
        {
          apiBase: 'https://model.example/v1',
          apiKey: '${{ secrets.ANTHROPIC_API_KEY }}',
          model: 'private-model'
        }
      ],
      mcpServers: [
        {
          name: 'goodbuddy-custom-mcp',
          type: 'streamable-http',
          url: 'http://127.0.0.1:4567/mcp',
          requestOptions: {
            headers: {
              Authorization:
                'Bearer request-scoped-custom-token'
            }
          }
        }
      ]
    })
    expect(generatedConfig).not.toContain('private-key')
    expect(launch?.env.ANTHROPIC_API_KEY).toBe('private-key')
    expect(existsSync(generatedConfigPath)).toBe(false)
  })

  it('bounds each host control request without bounding the full run', async () => {
    const distribution = await createDistribution()
    let killed = false
    const launchHost: ContinueHostLauncher = () => ({
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
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (
          input: string | URL | Request,
          init?: RequestInit
        ): Promise<Response> => {
          if (String(input).endsWith('/state')) {
            return Response.json({
              session: { history: [] },
              isProcessing: false,
              messageQueueLength: 0,
              pendingPermission: null
            })
          }
          if (String(input).endsWith('/message')) {
            return await new Promise<Response>((_resolve, reject) => {
              const rejectOnAbort = (): void =>
                reject(init?.signal?.reason)
              init?.signal?.addEventListener(
                'abort',
                rejectOnAbort,
                { once: true }
              )
              if (init?.signal?.aborted) {
                rejectOnAbort()
              }
            })
          }
          return Response.json({})
        }
      )
    )
    const adapter = new ContinueHostAdapter(
      {
        binaryPath: distribution.entryPath,
        configPath: '',
        workspace: process.cwd(),
        cacheRoot: distribution.cacheRoot,
        trustedBundleHashes: [distribution.sourceHash],
        launchHost,
        modelProfile: {
          id: '00000000-0000-4000-8000-000000000012',
          name: '独立模型',
          baseUrl: 'https://model.example',
          modelName: 'private-model',
          protocol: 'anthropic-messages',
          authentication: 'api-key',
          apiKey: 'private-key'
        }
      },
      {
        controlRequestTimeoutMs: 5,
        terminateProcessTree: vi.fn(async (child) => {
          child.kill()
        })
      }
    )

    await expect(
      adapter.run(
        'hello',
        new AbortController().signal,
        async () => 'deny'
      )
    ).rejects.toThrow('Continue 宿主请求超时（/message）')
    expect(killed).toBe(true)
  })

  it('injects scoped knowledge into a temporary copy of a JSONC config', async () => {
    const distribution = await createDistribution()
    const configPath = join(
      distribution.cacheRoot,
      '..',
      'continue.jsonc'
    )
    const originalConfig = [
      '{',
      '  // User-managed Continue configuration',
      '  "name": "Private Continue",',
      '  "version": "1.0.0",',
      '  "schema": "v1",',
      '  "models": [{ "provider": "ollama", "model": "qwen3" }],',
      '  "mcpServers": [{ "name": "user-tools", "command": "tool.exe" }],',
      '}'
    ].join('\n')
    await writeFile(configPath, originalConfig, 'utf8')
    let generatedConfig = ''
    let generatedConfigPath = ''
    let killed = false
    const launchHost: ContinueHostLauncher = (
      _entryPath,
      args
    ) => {
      const configIndex = args.indexOf('--config')
      generatedConfigPath = args[configIndex + 1] ?? ''
      generatedConfig = readFileSync(generatedConfigPath, 'utf8')
      expect(args).toEqual([
        '--config',
        expect.stringContaining('knowledge-config-'),
        '--allow',
        'knowledge_list',
        '--allow',
        'knowledge_search',
        '--allow',
        'note_list',
        '--allow',
        'note_get',
        '--allow',
        'note_search',
        '--allow',
        'goodbuddy_config_capabilities',
        '--allow',
        'goodbuddy_config_get',
        '--allow',
        'goodbuddy_config_plan',
        '--exclude',
        '*',
        'serve',
        '--port',
        expect.any(String),
        '--timeout',
        '300'
      ])
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
                          content: 'CONFIG_KNOWLEDGE_OK'
                        }
                      }
                    ]
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
      configPath,
      workspace: process.cwd(),
      cacheRoot: distribution.cacheRoot,
      trustedBundleHashes: [distribution.sourceHash],
      launchHost,
      mode: 'agent'
    })

    await expect(
      adapter.run(
        'search',
        new AbortController().signal,
        async () => 'deny',
        {
          workMode: 'ask',
          knowledgeCapability: {
            endpoint: 'http://127.0.0.1:4567/mcp',
            token: 'main-only-token'
          }
        }
      )
    ).resolves.toEqual({ text: 'CONFIG_KNOWLEDGE_OK' })
    expect(JSON.parse(generatedConfig)).toMatchObject({
      name: 'Private Continue',
      models: [{ provider: 'ollama', model: 'qwen3' }],
      mcpServers: [
        {
          name: 'goodbuddy-knowledge',
          type: 'streamable-http',
          url: 'http://127.0.0.1:4567/mcp',
          requestOptions: {
            headers: {
              Authorization: 'Bearer main-only-token'
            }
          }
        }
      ]
    })
    expect(generatedConfig).not.toContain('user-tools')
    await expect(readFile(configPath, 'utf8')).resolves.toBe(
      originalConfig
    )
    expect(killed).toBe(true)
    expect(existsSync(generatedConfigPath)).toBe(false)
  })

  it.each([
    {
      label: 'Chat Completions without authentication',
      protocol: 'openai-chat-completions' as const,
      authentication: 'none' as const,
      useResponsesApi: false
    },
    {
      label: 'Responses with an API key',
      protocol: 'openai-responses' as const,
      authentication: 'api-key' as const,
      useResponsesApi: true
    }
  ])(
    'generates an explicit OpenAI config for $label',
    async ({
      protocol,
      authentication,
      useResponsesApi
    }) => {
      inheritProviderCredentials()
      const distribution = await createDistribution()
      let generatedConfig = ''
      let launchedEnvironment: NodeJS.ProcessEnv | undefined
      let launchedArgs: string[] = []
      let submittedMessage: unknown
      const launchHost: ContinueHostLauncher = (
        _entryPath,
        args,
        options
      ) => {
        launchedArgs = args
        const configIndex = args.indexOf('--config')
        generatedConfig = readFileSync(
          args[configIndex + 1] ?? '',
          'utf8'
        )
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
        vi.fn(async (
          input: string | URL | Request,
          init?: RequestInit
        ) => {
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
          if (String(input).endsWith('/message')) {
            submittedMessage = JSON.parse(String(init?.body)).message
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
          protocol,
          authentication,
          supportsImageInput: true,
          ...(authentication === 'api-key'
            ? { apiKey: 'private-key' }
            : {})
        }
      })

      await expect(
        adapter.run(
          'hello',
          new AbortController().signal,
          async () => 'deny',
          {
            workMode: 'ask',
            knowledgeCapability: {
              endpoint: 'http://127.0.0.1:4567/mcp',
              token: 'main-only-token'
            },
            images: [
              {
                name: 'screenshot.png',
                mediaType: 'image/png',
                data: 'aW1hZ2U='
              }
            ]
          }
        )
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
            model: 'qwen3',
            useResponsesApi,
            capabilities: ['image_input']
          }
        ],
        mcpServers: [
          {
            name: 'goodbuddy-knowledge',
            type: 'streamable-http',
            url: 'http://127.0.0.1:4567/mcp',
            requestOptions: {
              headers: {
                Authorization: 'Bearer main-only-token'
              }
            }
          }
        ]
      })
      expect(submittedMessage).toEqual([
        { type: 'text', text: 'hello' },
        {
          type: 'imageUrl',
          imageUrl: {
            url: 'data:image/png;base64,aW1hZ2U='
          }
        }
      ])
      expect(launchedArgs).toEqual(
        expect.arrayContaining([
          '--allow',
          'knowledge_list',
          '--allow',
          'knowledge_search',
          '--allow',
          'note_search',
          '--exclude',
          '*'
        ])
      )
      expect(launchedArgs).not.toContain('--readonly')
      if (authentication === 'api-key') {
        expect(JSON.parse(generatedConfig)).toMatchObject({
          models: [
            {
              apiKey: '${{ secrets.OPENAI_API_KEY }}'
            }
          ]
        })
        expect(launchedEnvironment?.OPENAI_API_KEY).toBe('private-key')
      } else {
        expect(generatedConfig).not.toContain('apiKey')
        expect(launchedEnvironment).not.toHaveProperty(
          'OPENAI_API_KEY'
        )
      }
      for (const name of Object.keys(inheritedProviderCredentials)) {
        const selectedCredential =
          authentication === 'api-key' ? 'OPENAI_API_KEY' : undefined
        if (name !== selectedCredential) {
          expect(launchedEnvironment).not.toHaveProperty(name)
        }
      }
    }
  )

  it('turns a strict upstream error envelope into a failed run', async () => {
    const distribution = await createDistribution()
    let killed = false
    const launchHost: ContinueHostLauncher = () => ({
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
    })
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
                          content: 'Partial response'
                        },
                        toolCallStates: [
                          {
                            toolCallId: 'call-1',
                            toolCall: {
                              function: { name: 'Bash' }
                            },
                            status: 'errored',
                            output: [
                              {
                                content:
                                  'PowerShell 原始错误：路径不存在 ���'
                              }
                            ]
                          }
                        ]
                      },
                      {
                        message: {
                          role: 'system',
                          content:
                            'Error: {"error":{"message":"Request not allowed"}}'
                        }
                      }
                    ]
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
        id: '00000000-0000-4000-8000-000000000013',
        name: 'Local model',
        baseUrl: 'http://127.0.0.1:11434/v1',
        modelName: 'local-model',
        protocol: 'openai-chat-completions',
        authentication: 'none'
      }
    })

    const run = adapter.run(
      'hello',
      new AbortController().signal,
      async () => 'deny'
    )
    await expect(
      run
    ).rejects.toMatchObject({
      message: 'Continue 模型请求失败：Request not allowed',
      tools: [
        {
          callId: 'call-1',
          name: 'Bash',
          state: 'failed',
          error:
            'PowerShell 原始错误：路径不存在 ���'
        }
      ]
    })
    expect(killed).toBe(true)
  })

  it('completes from final history when the patched stream is truncated', async () => {
    const distribution = await createDistribution()
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
                          content: 'CONTINUE_OK'
                        }
                      }
                    ]
            },
            isProcessing: false,
            messageQueueLength: 0,
            pendingPermission: null,
            goodbuddyEventsOverflow: stateRequests === 2
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
      launchHost: () => ({
        exitCode: null,
        killed: false,
        stderr: null,
        once: () => undefined,
        kill: () => true
      }),
      modelProfile: {
        id: randomUUID(),
        name: 'Local model',
        baseUrl: 'http://127.0.0.1:11434/v1',
        modelName: 'qwen3',
        protocol: 'openai-chat-completions',
        authentication: 'none'
      }
    })

    await expect(
      adapter.run(
        'hello',
        new AbortController().signal,
        async () => 'deny'
      )
    ).resolves.toMatchObject({
      text: 'CONTINUE_OK',
      streamTruncated: true
    })
  })

  it(
    'truncates cumulative streamed bytes without stopping the run',
    async () => {
      const distribution = await createDistribution()
      let stateRequests = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request) => {
          if (String(input).endsWith('/state')) {
            stateRequests += 1
            return Response.json({
              session: {
                history:
                  stateRequests < 3
                    ? []
                    : [
                        {
                          message: {
                            role: 'assistant',
                            content: '1234567890CONTINUE_OK'
                          }
                        }
                      ]
              },
              isProcessing: stateRequests === 2,
              messageQueueLength: 0,
              pendingPermission: null,
              goodbuddyEvents:
                stateRequests > 1
                  ? [{ type: 'text', delta: '1234567890' }]
                  : []
            })
          }
          return Response.json({})
        })
      )
      const forwarded: unknown[] = []
      const adapter = new ContinueHostAdapter(
        {
          binaryPath: distribution.entryPath,
          configPath: '',
          workspace: process.cwd(),
          cacheRoot: distribution.cacheRoot,
          trustedBundleHashes: [distribution.sourceHash],
          launchHost: () => ({
            exitCode: null,
            killed: false,
            stderr: null,
            once: () => undefined,
            kill: () => true
          }),
          modelProfile: {
            id: randomUUID(),
            name: 'Local model',
            baseUrl: 'http://127.0.0.1:11434/v1',
            modelName: 'qwen3',
            protocol: 'openai-chat-completions',
            authentication: 'none'
          }
        },
        {
          maximumStreamEventBytes: 60,
          terminateProcessTree: vi.fn().mockResolvedValue(undefined)
        }
      )

      await expect(
        adapter.run(
          'hello',
          new AbortController().signal,
          async () => 'deny',
          {
            onEvent: (event) => {
              forwarded.push(event)
            }
          }
        )
      ).resolves.toMatchObject({
        text: '1234567890CONTINUE_OK',
        streamedText: true,
        streamTruncated: true
      })
      expect(forwarded).toEqual([
        { type: 'text', delta: '1234567890' }
      ])
    }
  )

  it('forwards more than 100 unique tool calls', async () => {
    const distribution = await createDistribution()
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
                          content: 'TOOLS_OK'
                        }
                      }
                    ]
            },
            isProcessing: false,
            messageQueueLength: 0,
            pendingPermission: null,
            goodbuddyEvents:
              stateRequests === 2
                ? Array.from({ length: 101 }, (_, index) => ({
                    type: 'tool',
                    callId: `call-${index + 1}`,
                    name: 'Bash',
                    state: 'completed'
                  }))
                : []
          })
        }
        return Response.json({})
      })
    )
    const forwarded: unknown[] = []
    const adapter = new ContinueHostAdapter(
      {
        binaryPath: distribution.entryPath,
        configPath: '',
        workspace: process.cwd(),
        cacheRoot: distribution.cacheRoot,
        trustedBundleHashes: [distribution.sourceHash],
        launchHost: () => ({
          exitCode: null,
          killed: false,
          stderr: null,
          once: () => undefined,
          kill: () => true
        }),
        modelProfile: {
          id: randomUUID(),
          name: 'Local model',
          baseUrl: 'http://127.0.0.1:11434/v1',
          modelName: 'qwen3',
          protocol: 'openai-chat-completions',
          authentication: 'none'
        }
      },
      {
        maximumStreamEventBytes: 1_000_000,
        terminateProcessTree: vi.fn().mockResolvedValue(undefined)
      }
    )

    await expect(
      adapter.run(
        'hello',
        new AbortController().signal,
        async () => 'deny',
        {
          onEvent: (event) => {
            forwarded.push(event)
          }
        }
      )
    ).resolves.toMatchObject({ text: 'TOOLS_OK' })
    expect(forwarded).toHaveLength(101)
    expect(forwarded.at(-1)).toMatchObject({
      type: 'tool',
      tool: { callId: 'call-101' }
    })
  })

  it('awaits bounded process cleanup before deleting the run directory', async () => {
    const distribution = await createDistribution()
    let globalDirectory = ''
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
                          content: 'CLEANUP_OK'
                        }
                      }
                    ]
            },
            isProcessing: false,
            messageQueueLength: 0,
            pendingPermission: null
          })
        }
        return Response.json({})
      })
    )
    let releaseTermination!: () => void
    const terminateProcessTree = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseTermination = resolve
        })
    )
    const adapter = new ContinueHostAdapter(
      {
        binaryPath: distribution.entryPath,
        configPath: '',
        workspace: process.cwd(),
        cacheRoot: distribution.cacheRoot,
        trustedBundleHashes: [distribution.sourceHash],
        launchHost: (_entry, _args, options) => {
          globalDirectory =
            options.env.CONTINUE_GLOBAL_DIR ?? ''
          return {
            exitCode: null,
            killed: false,
            stderr: null,
            once: () => undefined,
            kill: () => true
          }
        },
        modelProfile: {
          id: randomUUID(),
          name: 'Local model',
          baseUrl: 'http://127.0.0.1:11434/v1',
          modelName: 'qwen3',
          protocol: 'openai-chat-completions',
          authentication: 'none'
        }
      },
      {
        maximumStreamEventBytes: 10_000,
        terminateProcessTree
      }
    )

    const run = adapter.run(
      'hello',
      new AbortController().signal,
      async () => 'deny'
    )
    await vi.waitFor(() =>
      expect(terminateProcessTree).toHaveBeenCalledOnce()
    )
    expect(globalDirectory).toBeTruthy()
    expect(existsSync(globalDirectory)).toBe(true)

    releaseTermination()
    await expect(run).resolves.toEqual({ text: 'CLEANUP_OK' })
    expect(existsSync(globalDirectory)).toBe(false)
  })

  it('uses auto mode and returns audit metadata for agent tools', async () => {
    const distribution = await createDistribution()
    let launchArgs: string[] = []
    const permissionBodies: unknown[] = []
    const streamEvents: unknown[] = []
    const launchHost: ContinueHostLauncher = (
      _entryPath,
      args
    ) => {
      launchArgs = args
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
      vi.fn(
        async (
          input: string | URL | Request,
          init?: RequestInit
        ) => {
          const url = String(input)
          if (url.endsWith('/permission')) {
            permissionBodies.push(JSON.parse(String(init?.body)))
            return Response.json({})
          }
          if (url.endsWith('/state')) {
            stateRequests += 1
            if (stateRequests === 1) {
              return Response.json({
                session: { history: [] },
                isProcessing: false,
                messageQueueLength: 0,
                pendingPermission: null
              })
            }
            if (stateRequests === 2) {
              return Response.json({
                session: { history: [] },
                isProcessing: true,
                messageQueueLength: 0,
                pendingPermission: {
                  toolName: 'Bash',
                  toolArgs: { command: 'npm test' },
                  requestId: 'permission-1'
                },
                goodbuddyEvents: [
                  { type: 'text', delta: '先检查命令。' },
                  {
                    type: 'tool',
                    callId: 'call-1',
                    name: 'Bash',
                    state: 'running',
                    input:
                      '{"command":"npm test","token":"secret-token"}'
                  }
                ]
              })
            }
            return Response.json({
              session: {
                history: [
                  {
                    message: {
                      role: 'assistant',
                      content: 'TOOLS_OK'
                    },
                    toolCallStates: [
                      {
                        toolCallId: 'call-1',
                        toolCall: {
                          function: { name: 'Bash' }
                        },
                        status: 'done'
                      }
                    ]
                  }
                ]
              },
              isProcessing: false,
              messageQueueLength: 0,
              pendingPermission: null,
              goodbuddyEvents: [
                {
                  type: 'tool',
                  callId: 'call-1',
                  name: 'Bash',
                  state: 'completed',
                  output:
                    'Tests passed\nAuthorization: Bearer secret-token'
                },
                { type: 'text', delta: 'TOOLS_OK' }
              ]
            })
          }
          return Response.json({})
        }
      )
    )
    const adapter = new ContinueHostAdapter({
      binaryPath: distribution.entryPath,
      configPath: 'C:\\safe\\continue.yaml',
      workspace: process.cwd(),
      cacheRoot: distribution.cacheRoot,
      trustedBundleHashes: [distribution.sourceHash],
      launchHost,
      mode: 'agent'
    })
    const authorize = vi.fn(async () => 'once' as const)

    await expect(
      adapter.run(
        'hello',
        new AbortController().signal,
        authorize,
        {
          workMode: 'execute',
          onEvent: (event) => {
            streamEvents.push(event)
          }
        }
      )
    ).resolves.toEqual({
      text: 'TOOLS_OK',
      streamedText: true,
      tools: [
        {
          callId: 'call-1',
          name: 'Bash',
          state: 'completed',
          input:
            '{"command":"npm test","token":"secret-token"}',
          output:
            'Tests passed\nAuthorization: Bearer secret-token'
        }
      ]
    })
    expect(streamEvents).toEqual([
      { type: 'text', delta: '先检查命令。' },
      {
        type: 'tool',
        tool: {
          callId: 'call-1',
          name: 'Bash',
          state: 'running',
          input:
            '{"command":"npm test","token":"secret-token"}'
        }
      },
      {
        type: 'tool',
        tool: {
          callId: 'call-1',
          name: 'Bash',
          state: 'completed',
          output:
            'Tests passed\nAuthorization: Bearer secret-token'
        }
      },
      { type: 'text', delta: 'TOOLS_OK' }
    ])
    expect(launchArgs).toContain('--auto')
    expect(launchArgs).not.toContain('--readonly')
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'Bash' })
    )
    expect(permissionBodies).toEqual([
      { requestId: 'permission-1', approved: true }
    ])
  })

  it('merges enabled preset Rules and prompts after native configuration metadata', async () => {
    const distribution = await createDistribution()
    const configPath = join(
      distribution.cacheRoot,
      '..',
      'preset-continue.yaml'
    )
    await writeFile(
      configPath,
      JSON.stringify({
        name: 'Native',
        version: '1.0.0',
        schema: 'v1',
        models: [{ provider: 'ollama', model: 'qwen3' }],
        rules: [{ name: 'Native rule', rule: 'Native content' }],
        prompts: [
          { name: 'Native prompt', prompt: 'Native prompt content' }
        ]
      }),
      'utf8'
    )
    let generatedConfig: Record<string, unknown> = {}
    const launchHost: ContinueHostLauncher = (_entry, args) => {
      const index = args.indexOf('--config')
      generatedConfig = JSON.parse(
        readFileSync(args[index + 1] ?? '', 'utf8')
      )
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
                          content: 'PRESET_OK'
                        }
                      }
                    ]
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
      configPath,
      workspace: process.cwd(),
      cacheRoot: distribution.cacheRoot,
      trustedBundleHashes: [distribution.sourceHash],
      launchHost
    })

    await adapter.run(
      'hello',
      new AbortController().signal,
      async () => 'deny',
      {
        preset: {
          id: randomUUID(),
          name: 'Preset',
          rules: [
            {
              id: randomUUID(),
              name: 'Enabled',
              content: 'Enabled content',
              enabled: true
            },
            {
              id: randomUUID(),
              name: 'Disabled',
              content: 'Disabled content',
              enabled: false
            }
          ],
          prompts: [
            {
              id: randomUUID(),
              name: 'Preset prompt',
              description: 'Preset description',
              prompt: 'Preset prompt content'
            }
          ]
        }
      }
    )

    expect(generatedConfig).toMatchObject({
      rules: [
        { name: 'Native rule', rule: 'Native content' },
        { name: 'Enabled', rule: 'Enabled content' }
      ],
      prompts: [
        { name: 'Native prompt', prompt: 'Native prompt content' },
        {
          name: 'Preset prompt',
          description: 'Preset description',
          prompt: 'Preset prompt content'
        }
      ]
    })
    expect(JSON.stringify(generatedConfig)).not.toContain(
      'Disabled content'
    )
  })

  it('returns a redacted native inventory without scanning host-inaccessible Skills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goodbuddy-continue-inventory-'))
    temporaryDirectories.push(root)
    const workspace = join(root, 'workspace')
    const configPath = join(root, 'continue.jsonc')
    await writeFile(
      configPath,
      JSON.stringify({
        rules: [
          {
            name: 'Native Rule',
            rule: 'Only bounded rule content is exposed'
          }
        ],
        prompts: [
          {
            name: 'Native Prompt',
            description: 'Safe metadata',
            prompt: 'Prompt body'
          }
        ],
        mcpServers: [
          {
            name: 'private-tools',
            command: 'secret-command.exe',
            url: 'https://secret.example/mcp',
            apiKey: 'secret-value'
          },
          {
            name: 'goodbuddy-knowledge',
            url: 'http://127.0.0.1/token'
          }
        ]
      }),
      'utf8'
    )

    const inventory = await inspectContinueNativeConfiguration({
      configPath,
      workspace
    })

    expect(inventory.rules).toEqual([
      expect.objectContaining({
        name: 'Native Rule',
        content: 'Only bounded rule content is exposed'
      })
    ])
    expect(inventory.prompts).toEqual([
      expect.objectContaining({
        name: 'Native Prompt',
        prompt: 'Prompt body'
      })
    ])
    expect(inventory.mcpServers).toEqual([
      expect.objectContaining({
        name: 'private-tools',
        status: 'unknown'
      })
    ])
    expect(inventory).not.toHaveProperty('skills')
    expect(JSON.stringify(inventory)).not.toMatch(
      /secret-command|secret\.example|secret-value|goodbuddy-knowledge/u
    )
    expect(inventory.detail).toContain('不提供 Resources')
  })

  it('bridges authenticated QuizService questions and cleans answered mappings', async () => {
    const distribution = await createDistribution()
    const configPath = join(
      distribution.cacheRoot,
      '..',
      'question-continue.yaml'
    )
    await writeFile(
      configPath,
      JSON.stringify({
        models: [{ provider: 'ollama', model: 'qwen3' }]
      }),
      'utf8'
    )
    const answerBodies: unknown[] = []
    let stateRequests = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (
        input: string | URL | Request,
        init?: RequestInit
      ) => {
        const url = String(input)
        if (url.endsWith('/goodbuddy/question-answer')) {
          answerBodies.push(JSON.parse(String(init?.body)))
          return Response.json({ success: true })
        }
        if (url.endsWith('/state')) {
          stateRequests += 1
          if (stateRequests === 1) {
            return Response.json({
              session: { history: [] },
              isProcessing: false,
              messageQueueLength: 0,
              pendingPermission: null
            })
          }
          if (stateRequests === 2) {
            return Response.json({
              session: { history: [] },
              isProcessing: true,
              messageQueueLength: 0,
              pendingPermission: null,
              goodbuddyQuestion: {
                requestId: 'quiz-123',
                timestamp: Date.now(),
                question: {
                  question: 'Choose safely',
                  options: ['Safe', 'Fast'],
                  defaultAnswer: 'Safe'
                }
              }
            })
          }
          return Response.json({
            session: {
              history: [
                {
                  message: {
                    role: 'assistant',
                    content: 'QUESTION_OK'
                  }
                }
              ]
            },
            isProcessing: false,
            messageQueueLength: 0,
            pendingPermission: null,
            goodbuddyQuestion: null
          })
        }
        return Response.json({})
      })
    )
    const adapter = new ContinueHostAdapter({
      binaryPath: distribution.entryPath,
      configPath,
      workspace: process.cwd(),
      cacheRoot: distribution.cacheRoot,
      trustedBundleHashes: [distribution.sourceHash],
      launchHost: () => ({
        exitCode: null,
        killed: false,
        stderr: null,
        once: () => undefined,
        kill: () => true
      })
    })
    const events: unknown[] = []

    await expect(
      adapter.run(
        'hello',
        new AbortController().signal,
        async () => 'deny',
        {
          onEvent: async (event) => {
            events.push(event)
            if (event.type === 'question') {
              await adapter.respondToQuestion(
                event.questionId,
                [['Safe']]
              )
            }
          }
        }
      )
    ).resolves.toEqual({ text: 'QUESTION_OK' })

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'question',
        questionId: 'quiz-123',
        questions: [
          expect.objectContaining({
            question: 'Choose safely',
            options: [
              { label: 'Safe', description: '' },
              { label: 'Fast', description: '' }
            ]
          })
        ]
      })
    )
    expect(answerBodies).toEqual([
      {
        requestId: 'quiz-123',
        answer: 'Safe',
        isCustomAnswer: false
      }
    ])
    await expect(
      adapter.respondToQuestion('quiz-123', [['Safe']])
    ).rejects.toThrow('已失效或不存在')
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
    'routes a custom-base $label profile to its explicit endpoint in Continue 1.5.47',
    async ({
      protocol,
      expectedPath,
      unexpectedPath
    }) => {
      const root = await mkdtemp(
        join(tmpdir(), 'goodbuddy-continue-responses-')
      )
      temporaryDirectories.push(root)
      const requestPaths: string[] = []
      const requestBodies: unknown[] = []
      const server = createServer(async (request, response) => {
        requestPaths.push(request.url ?? '')
        let body = ''
        for await (const chunk of request) {
          body += chunk
        }
        if (body) {
          requestBodies.push(JSON.parse(body))
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
      const adapter = new ContinueHostAdapter({
        binaryPath: join(
          process.cwd(),
          'node_modules',
          '@continuedev',
          'cli',
          'dist',
          'cn.js'
        ),
        configPath: '',
        workspace: root,
        cacheRoot: join(root, 'cache'),
        modelProfile: {
          id: '00000000-0000-4000-8000-000000000014',
          name: 'Local endpoint probe',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          modelName: 'probe-model',
          protocol,
          authentication: 'none'
        }
      })
      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort(new Error('Routing probe timed out')),
        20_000
      )
      try {
        await adapter
          .run('Reply with OK', controller.signal, async () => 'deny')
          .catch(() => undefined)
        expect(requestPaths).toContain(expectedPath)
        expect(requestPaths).not.toContain(unexpectedPath)
        if (protocol === 'openai-chat-completions') {
          const chatRequest = requestBodies.find(
            (body): body is { messages: Array<{ role?: unknown }> } =>
              Boolean(
                body &&
                  typeof body === 'object' &&
                  'messages' in body &&
                  Array.isArray(body.messages)
              )
          )
          expect(chatRequest).toBeDefined()
          expect(chatRequest?.messages[0]?.role).toBe('system')
          expect(
            chatRequest?.messages.filter(
              (message) => message.role === 'system'
            )
          ).toHaveLength(1)
        }
      } finally {
        clearTimeout(timeout)
        adapter.dispose()
        await new Promise((resolveWait) =>
          setTimeout(resolveWait, 500)
        )
        await new Promise<void>((resolveClose, reject) => {
          server.close((error) =>
            error ? reject(error) : resolveClose()
          )
        })
      }
    },
    30_000
  )
})
