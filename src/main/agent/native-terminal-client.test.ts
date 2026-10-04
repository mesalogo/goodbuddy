// @vitest-environment node
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedRuntimeSettings } from '../runtime-settings-store'
import type { NativeTerminalLaunch } from '../terminal/terminal-session-manager'
import type { TerminalSnapshot } from '../../shared/terminal-contracts'
import { NativeTerminalClient, type NativeTerminalClientInput } from './native-terminal-client'

const roots: string[] = []
const launches: NativeTerminalLaunch[] = []
afterEach(async () => {
  await Promise.all(launches.splice(0).map(launch => launch.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-terminal-test-'))
  roots.push(root)
  const create = vi.fn(async (_owner, _request, launch: NativeTerminalLaunch | undefined) => {
    launches.push(launch!)
    return { sessionId: 'terminal', state: 'running' } as TerminalSnapshot
  })
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { headers: { 'content-type': 'application/json' } }))
  const client = new NativeTerminalClient({
    terminalManager: { create }, rootDirectory: root,
    bundledRuntimePaths: { opencode: process.execPath, continue: process.execPath, ripgrep: '', deepseekHarness: '' }, fetcher
  })
  const profile = { id: 'selected', name: 'Selected model', modelName: 'selected-model', baseUrl: 'https://provider.example/v1', authentication: 'api-key' as const, protocol: 'openai-chat-completions' as const, apiKey: 'provider-secret', requestHeaders: { 'x-provider-option': 'configured' } }
  const input: NativeTerminalClientInput = {
    projectId: 'project', projectName: 'Project', directory: root, runtime: 'opencode',
    settings: { opencodeBinaryPath: '', opencodeModelProfile: profile } as unknown as ResolvedRuntimeSettings
  }
  return { root, client, create, fetcher, input }
}

describe('native terminal client', () => {
  it('bridges successive native requests with the selected model and keeps credentials in Main', async () => {
    const { client, input, create, fetcher, root } = await fixture()
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
    expect(config.plugin).toBeUndefined()
    await launch.dispose()
    await expect(readdir(configDirectory)).rejects.toThrow()
    expect(await readdir(join(root, 'opencode'))).toHaveLength(1)
    await expect(fetch(`${provider.options.baseURL}/chat/completions`, { method: 'POST' })).rejects.toThrow()
    await client.open(1, input)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('releases prepared resources after terminal creation fails and permits retry', async () => {
    const { client, input, create, root } = await fixture()
    create.mockImplementationOnce(async (_owner, _request, launch) => {
      launches.push(launch!)
      throw new Error('PTY unavailable')
    })
    await expect(client.open(1, input)).rejects.toThrow('PTY unavailable')
    expect((await readdir(root)).filter(name => name.startsWith('launch-'))).toEqual([])
    await expect(client.open(1, input)).resolves.toMatchObject({ state: 'running' })
  })

  it('copies the bundled OpenCode config once and reuses it for later launches', async () => {
    const { root, create, fetcher, input } = await fixture()
    const bundled = join(root, 'bundled-config')
    await mkdir(join(bundled, 'node_modules', 'plugin'), { recursive: true })
    await writeFile(join(bundled, '.goodbuddy-ready.json'), '{"version":"1"}')
    await writeFile(join(bundled, 'node_modules', 'plugin', 'index.js'), 'export {}')
    const client = new NativeTerminalClient({
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
