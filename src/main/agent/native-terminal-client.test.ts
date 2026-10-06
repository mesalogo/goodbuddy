// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedRuntimeSettings } from '../runtime-settings-store'
import type { NativeTerminalLaunch } from '../terminal/terminal-session-manager'
import type { TerminalSnapshot } from '../../shared/terminal-contracts'
import { NativeTerminalClient, type NativeTerminalClientInput } from './native-terminal-client'
import { AgentModelCallLedger, type ModelCallLedgerFactory } from '../../agent-daemon/agent-model-gateway'
import { runtimeTemporaryRoot } from '../runtime-temporary-directory'
import { LocalTerminalSession } from '../terminal/local-terminal-session'

const roots: string[] = []
const launches: NativeTerminalLaunch[] = []
afterEach(async () => {
  await Promise.all(launches.splice(0).map(launch => launch.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(openModelCallLedger: ModelCallLedgerFactory = async path => new AgentModelCallLedger(path)) {
  const root = await mkdtemp(join(tmpdir(), 'native-terminal-test-'))
  roots.push(root)
  const scratch = runtimeTemporaryRoot(root, 'test', 'native')
  const create = vi.fn(async (_owner, _request, launch: NativeTerminalLaunch | undefined) => {
    launches.push(launch!)
    return { sessionId: 'terminal', state: 'running' } as TerminalSnapshot
  })
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { headers: { 'content-type': 'application/json' } }))
  const client = new NativeTerminalClient({
    openModelCallLedger,
    terminalManager: { create }, rootDirectory: root, temporaryRoot: scratch,
    bundledRuntimePaths: { opencode: process.execPath, continue: process.execPath, ripgrep: '', deepseekHarness: '' }, fetcher
  })
  const profile = { id: 'selected', name: 'Selected model', modelName: 'selected-model', baseUrl: 'https://provider.example/v1', authentication: 'api-key' as const, protocol: 'openai-chat-completions' as const, apiKey: 'provider-secret', requestHeaders: { 'x-provider-option': 'configured' } }
  const input: NativeTerminalClientInput = {
    projectId: 'project', projectName: 'Project', directory: root, runtime: 'opencode',
    settings: { opencodeBinaryPath: '', opencodeModelProfile: profile } as unknown as ResolvedRuntimeSettings
  }
  return { root, scratch, client, create, fetcher, input }
}

describe('native terminal client', () => {
  it.skipIf(!process.env.NATIVE_DSH_TEST_NODE)('records a real PTY child and preserves native history after exit and scratch cleanup', async () => {
    const { client, input, root, scratch, fetcher } = await fixture()
    await client.open(1, input)
    const launch = launches[0]!
    const history = launch.spawnSpec.env.XDG_DATA_HOME!
    await mkdir(history, { recursive: true })
    await writeFile(join(history, 'session'), 'retained')
    const session = await LocalTerminalSession.create({
      target: { type: 'project', projectId: 'project' }, targetLabel: 'Native test', title: 'Native test',
      size: { cols: 80, rows: 24 }, projectDirectory: root,
      spawnSpec: { ...launch.spawnSpec, executable: process.env.NATIVE_DSH_TEST_NODE!, args: ['-e', 'setInterval(() => {}, 1000)'] }
    })
    try {
      expect(session.snapshot().state).toBe('running')
      const directory = dirname(launch.spawnSpec.env.OPENCODE_CONFIG_DIR!)
      const owner = JSON.parse(await readFile(join(scratch, `.${basename(directory)}.owner.json`), 'utf8'))
      expect(owner.creatorPid).toBe(process.pid)
      expect(owner.childPid).toBeGreaterThan(0)
      expect(() => process.kill(owner.childPid, 0)).not.toThrow()
    } finally { await session.close() }
    await launch.dispose()
    expect(await readdir(scratch)).toEqual([])
    expect(await readFile(join(history, 'session'), 'utf8')).toBe('retained')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('retains the launch directory until asynchronous ledger close settles', async () => {
    let resolveClose!: () => void
    const closing = new Promise<void>(resolve => { resolveClose = resolve })
    let path = ''
    const close = vi.fn(() => closing)
    const { client, input, scratch } = await fixture(async databasePath => {
      path = databasePath
      return { claim: vi.fn(), complete: vi.fn(), delivered: vi.fn(), outcomeUnknown: vi.fn(), get: vi.fn(), close }
    })
    await client.open(1, input)
    const disposal = launches[0]!.dispose()
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect((await readdir(scratch)).some(name => path.includes(name) && name.startsWith('goodbuddy-opencode-'))).toBe(true)
    resolveClose()
    await disposal
    expect(await readdir(scratch)).toEqual([])
  })

  it('retains launch files after unconfirmed ledger open instead of deleting a possibly open database', async () => {
    const { client, input, scratch, create } = await fixture(async () => { throw new Error('unconfirmed storage open') })
    await expect(client.open(1, input)).rejects.toThrow('unconfirmed storage open')
    expect(create).not.toHaveBeenCalled()
    expect((await readdir(scratch)).filter(name => name.startsWith('goodbuddy-opencode-'))).toHaveLength(1)
  })

  it('does not delete launch files when host close rejects', async () => {
    const { client, input, scratch } = await fixture(async () => ({
      claim: vi.fn(), complete: vi.fn(), delivered: vi.fn(), outcomeUnknown: vi.fn(), get: vi.fn(),
      close: async () => { throw new Error('unconfirmed storage close') }
    }))
    await client.open(1, input)
    const launch = launches.pop()!
    await expect(launch.dispose()).rejects.toThrow('unconfirmed storage close')
    expect((await readdir(scratch)).filter(name => name.startsWith('goodbuddy-opencode-'))).toHaveLength(1)
  })

  it('bridges successive native requests with the selected model and keeps credentials in Main', async () => {
    const { client, input, create, fetcher, root, scratch } = await fixture()
    const first = client.open(1, input)
    expect(client.open(1, input)).toBe(first)
    await first
    expect(create).toHaveBeenCalledOnce()
    const launch = launches[0]!
    expect(JSON.stringify(launch.spawnSpec)).not.toContain('provider-secret')
    const config = JSON.parse(launch.spawnSpec.env.OPENCODE_CONFIG_CONTENT!)
    const provider = Object.values(config.provider)[0] as { options: { baseURL: string; apiKey: string } }
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${provider.options.baseURL}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.options.apiKey}` }, body: JSON.stringify({ model: 'selected-model', messages: [{ role: 'user', content: 'hi' }] }) })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('ok')
    }
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://provider.example/v1/chat/completions')
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers)
    expect(headers.get('authorization')).toBe('Bearer provider-secret')
    expect(headers.get('x-provider-option')).toBe('configured')
    const configDirectory = launch.spawnSpec.env.OPENCODE_CONFIG_DIR!
    expect(config.permission).toBe('allow')
    expect(configDirectory.startsWith(scratch)).toBe(true)
    expect(launch.spawnSpec.env.XDG_DATA_HOME!.startsWith(join(root, 'opencode'))).toBe(true)
    expect(config.plugin).toBeUndefined()
    await launch.dispose()
    await expect(readdir(configDirectory)).rejects.toThrow()
    expect(await readdir(join(root, 'opencode'))).toHaveLength(1)
    await expect(fetch(`${provider.options.baseURL}/chat/completions`, { method: 'POST' })).rejects.toThrow()
    await client.open(1, input)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('releases prepared resources after terminal creation fails and permits retry', async () => {
    const { client, input, create, scratch } = await fixture()
    create.mockImplementationOnce(async (_owner, _request, launch) => {
      launches.push(launch!)
      throw new Error('PTY unavailable')
    })
    await expect(client.open(1, input)).rejects.toThrow('PTY unavailable')
    expect(await readdir(scratch)).toEqual([])
    await expect(client.open(1, input)).resolves.toMatchObject({ state: 'running' })
  })

  it('copies the bundled OpenCode config once and reuses it for later launches', async () => {
    const { root, create, fetcher, input } = await fixture()
    const bundled = join(root, 'bundled-config')
    await mkdir(join(bundled, 'node_modules', 'plugin'), { recursive: true })
    await writeFile(join(bundled, '.goodbuddy-ready.json'), '{"version":"1"}')
    await writeFile(join(bundled, 'node_modules', 'plugin', 'index.js'), 'export {}')
    const client = new NativeTerminalClient({
      openModelCallLedger: async path => new AgentModelCallLedger(path),
      terminalManager: { create }, rootDirectory: root, fetcher,
      bundledRuntimePaths: { opencode: process.execPath, opencodeConfig: bundled, continue: process.execPath, ripgrep: '', deepseekHarness: '' }
    })
    await client.open(1, input)
    const configDirectory = launches[0]!.spawnSpec.env.OPENCODE_CONFIG_DIR!
    expect(configDirectory).toBe(join(root, 'opencode-config'))
    const copied = (await stat(join(configDirectory, 'node_modules', 'plugin', 'index.js'))).mtimeMs
    await launches[0]!.dispose()
    await client.open(1, input)
    expect(launches[1]!.spawnSpec.env.OPENCODE_CONFIG_DIR).toBe(configDirectory)
    expect((await stat(join(configDirectory, 'node_modules', 'plugin', 'index.js'))).mtimeMs).toBe(copied)
  })

  it('uses normal permissions and explicit session MCP endpoints', async () => {
    const { client, input } = await fixture()
    await client.open(1, { ...input, mcpServers: [{ name: 'tools', url: 'http://127.0.0.1:12345/mcp', headers: { Authorization: 'Bearer local-token' } }] })
    const launch = launches[0]!
    const config = JSON.parse(launch.spawnSpec.env.OPENCODE_CONFIG_CONTENT!)
    expect(config.permission).toBe('allow')
    expect(config.mcp.tools.url).toBe('http://127.0.0.1:12345/mcp')
    expect(config.plugin).toBeUndefined()
  })

  it('allows bound tools without a generated whitelist or execution hook', async () => {
    const { client, input } = await fixture()
    await client.open(1, { ...input, mcpServers: [{ name: 'goodbuddy-0', url: 'http://127.0.0.1:12345/mcp', headers: {} }] })
    const config = JSON.parse(launches[0]!.spawnSpec.env.OPENCODE_CONFIG_CONTENT!)
    expect(config.mcp['goodbuddy-0']).toBeDefined()
    expect(config.permission).toBe('allow')
    expect(config.agent.build.permission).toBe('allow')
    expect(config.agent.plan.permission).toBe('allow')
    expect(config.plugin).toBeUndefined()
  })
})
