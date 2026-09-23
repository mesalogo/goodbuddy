// @vitest-environment node
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import spawn from 'cross-spawn'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runtimeSettingsInputSchema } from '../../shared/contracts'
import { RuntimeSettingsStore } from '../runtime-settings-store'
import { applyRuntimeSelection } from './runtime-selection'
import { OpenCodeRuntime } from './opencode-runtime'
import { resolveBundledRuntimePaths } from './bundled-runtimes'

const cipher = {
  isAvailable: () => false,
  encrypt: (): never => { throw new Error('No credentials in this test') },
  decrypt: (): never => { throw new Error('No credentials in this test') }
}
const newId = '00000000-0000-4000-8000-000000000123'
const denial = "OpenCode's free tier can only be used from within OpenCode"

describe('OpenCode isolated configuration paths', () => {
  let fixtureRoot: string
  let bundledConfigPath: string
  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'goodbuddy-opencode-config-isolation-'))
    const { prepareBundledOpenCodeConfig } = createRequire(import.meta.url)(
      '../../../build/opencode-config.cjs'
    )
    bundledConfigPath = prepareBundledOpenCodeConfig(fixtureRoot)
  }, 60_000)
  afterAll(async () => {
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
  })

  it.each(['default', 'profile', 'platform', 'external'] as const)(
    'resolves persisted %s source independently of the global default', async (source) => {
      const root = await mkdtemp(join(tmpdir(), 'goodbuddy-source-matrix-'))
      try {
        const path = join(root, 'runtime-settings.json')
        const store = new RuntimeSettingsStore(path, cipher, {})
        const fresh = await store.getPublicSettings()
        await store.update(runtimeSettingsInputSchema.parse({
          ...Object.fromEntries(Object.entries(fresh).filter(([key]) => key in runtimeSettingsInputSchema.shape)),
          embeddingConnections: undefined,
          apiKey: { action: 'keep' },
          modelProfiles: [...fresh.modelProfiles, {
            ...fresh.modelProfiles[0], id: newId, name: 'Local probe',
            modelName: 'probe-model', baseUrl: 'http://127.0.0.1:12345/v1'
          }].map((profile) => ({
            id: profile.id, name: profile.name, baseUrl: profile.baseUrl,
            modelName: profile.modelName, protocol: profile.protocol,
            authentication: profile.authentication, imageGenerationQuality: profile.imageGenerationQuality,
            apiKey: { action: 'keep' }
          })),
          opencodeModelSource: source === 'profile'
            ? { kind: 'profile', profileId: newId }
            : { kind: source === 'external' ? 'default' : source },
          opencodeBaseUrl: source === 'external' ? 'http://127.0.0.1:12346' : ''
        }))
        const reloaded = new RuntimeSettingsStore(path, cipher, {})
        const selected = applyRuntimeSelection(await reloaded.getResolvedSettings(), { provider: 'opencode' })
        expect(selected.settings.opencodeEmbedded).toBe(source !== 'external')
        expect(selected.settings.opencodeModelProfile?.modelName).toBe(
          source === 'default' ? 'qwen3' : source === 'profile' ? 'probe-model' : undefined
        )
        expect((await reloaded.getPublicSettings()).opencodeModelSource.kind).toBe(
          source === 'external' ? 'platform' : source
        )
        if (source === 'platform') {
          expect(applyRuntimeSelection(await reloaded.getResolvedSettings(), {
            provider: 'opencode', profileId: newId
          }).settings.opencodeModelProfile?.id).toBe(newId)
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it.each(['profile', 'native-file', 'native-empty'] as const)(
    'runs bundled OpenCode with isolated %s configuration and loopback-only model calls', async (source) => {
      const root = await mkdtemp(join(tmpdir(), 'goodbuddy-opencode-isolation-'))
      const requests: Array<{ path: string; model: string }> = []
      const server = createServer(async (request, response) => {
        let body = ''
        for await (const chunk of request) body += String(chunk)
        requests.push({ path: request.url ?? '', model: JSON.parse(body).model })
        response.writeHead(403, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: denial, type: 'forbidden' } }))
      })
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No loopback address')
      const baseURL = `http://127.0.0.1:${address.port}/v1`
      const configPath = join(root, 'native.json')
      await writeFile(configPath, JSON.stringify({
        model: 'local-native/probe-model',
        provider: { 'local-native': {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL }, models: { 'probe-model': {} }
        } }
      }))
      let launchEnvironment: NodeJS.ProcessEnv = {}
      let serverUrl = ''
      const binaryPath = resolveBundledRuntimePaths({
        appPath: process.cwd(), resourcesPath: process.cwd(), packaged: false
      }).opencode
      const runtime = new OpenCodeRuntime({
        embedded: true, binaryPath, defaultWorkspace: root,
        configPath: source === 'native-empty' ? '' : configPath,
        sharedCacheRoot: join(root, 'runtime-cache'),
        bundledConfigPath,
        ...(source === 'profile' ? { modelProfile: {
          id: newId, name: 'Local mock', baseUrl: baseURL, modelName: 'probe-model',
          protocol: 'openai-chat-completions' as const, authentication: 'none' as const
        } } : {})
      }, {
        startupTimeoutMs: 20_000,
        validateBinary: async () => ({ path: binaryPath, detail: 'Isolated bundled binary' }),
        spawn: ((command, args, options) => {
          // Allow only OS plumbing and the configuration generated by this runtime.
          const env: NodeJS.ProcessEnv = {}
          for (const [key, value] of Object.entries(options?.env ?? {})) {
            if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT)$/i.test(key) ||
                /^OPENCODE_(CONFIG|CONFIG_DIR|CONFIG_CONTENT|SERVER_USERNAME|SERVER_PASSWORD|DISABLE_[A-Z_]+|EXPERIMENTAL_DISABLE_FILEWATCHER)$/.test(key) ||
                key.startsWith('XDG_')) env[key] = value
          }
          Object.assign(env, { HOME: root, USERPROFILE: root, APPDATA: join(root, 'appdata'),
            LOCALAPPDATA: join(root, 'localappdata'), TEMP: root, TMP: root,
            OPENCODE_DISABLE_DEFAULT_PLUGINS: '1' })
          launchEnvironment = env
          serverUrl = `http://127.0.0.1:${args!.find((arg) => arg.startsWith('--port='))!.split('=')[1]}`
          return spawn(command, args!, { ...options, env })
        }) as typeof spawn
      })
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 25_000)
      try {
        const connection = await runtime.testConnection()
        expect(connection, connection.detail).toMatchObject({ available: true })
        const config = JSON.parse(launchEnvironment.OPENCODE_CONFIG_CONTENT!)
        expect(config.model).toBe(source === 'profile' ? 'goodbuddy-openai-chat/probe-model' : undefined)
        expect(launchEnvironment.OPENCODE_CONFIG).toBe(source === 'native-file' ? configPath : undefined)
        expect(launchEnvironment.XDG_CONFIG_HOME).toBe(join(root, 'runtime-cache', 'config'))
        if (source === 'native-empty') {
          // Inspect the bundled catalog without issuing any inference request.
          const requestOptions = {
            headers: { authorization: `Basic ${Buffer.from(
              `${launchEnvironment.OPENCODE_SERVER_USERNAME}:${launchEnvironment.OPENCODE_SERVER_PASSWORD}`
            ).toString('base64')}` }, signal: controller.signal
          }
          const health = await (await fetch(`${serverUrl}/global/health`, requestOptions)).json() as { version: string }
          const installed = JSON.parse(await readFile(join(process.cwd(), 'node_modules', 'opencode-ai', 'package.json'), 'utf8'))
          expect(health.version).toBe(installed.version)
          const response = await fetch(`${serverUrl}/config/providers`, requestOptions)
          expect(response.status).toBe(200)
          const catalog = await response.json() as {
            providers: Array<{ id: string; models: Record<string, { cost: { input: number } }> }>;
            default: Record<string, string>
          }
          const native = catalog.providers.find((provider) => provider.id === 'opencode')
          expect(native).toBeDefined()
          expect(Object.values(native!.models).every((model) => model.cost.input === 0)).toBe(true)
          expect(native!.models[catalog.default.opencode!]).toBeDefined()
          process.stdout.write('Isolated native catalog: ' + JSON.stringify({
            version: health.version,
            providers: catalog.providers.map((provider) => provider.id),
            default: catalog.default, freeModels: Object.keys(native!.models)
          }) + '\n')
          expect(requests).toEqual([])
        } else {
          let failure = ''
          try {
            for await (const event of runtime.run({ requestId: '403-isolation',
              conversationId: '403-isolation', prompt: 'Reply OK', workMode: 'ask'
            }, controller.signal)) void event
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error)
          }
          expect(requests.length).toBeGreaterThan(0)
          expect(requests.every((request) => request.path === '/v1/chat/completions' &&
            request.model === 'probe-model')).toBe(true)
          expect(failure).toContain(denial)
          expect(failure).toContain('statusCode: 403')
          process.stdout.write('Isolated 403 result: ' + JSON.stringify({ source, requests: requests.length, failure }) + '\n')
        }
        expect(JSON.parse(await readFile(configPath, 'utf8')).model).toBe('local-native/probe-model')
      } finally {
        clearTimeout(timeout)
        controller.abort()
        await runtime.dispose()
        server.closeAllConnections()
        await new Promise<void>((done) => server.close(() => done()))
        await rm(root, { recursive: true, force: true })
      }
    }, 40_000
  )
})
