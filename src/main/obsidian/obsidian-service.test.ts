// @vitest-environment node
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { packageObsidianMcpVault } from './package-mcpvault'
import { ObsidianService } from './obsidian-service'

let root: string
let appPath: string
let vaultPath: string
let bin: string
let service: ObsidianService
const electronExecutable = createRequire(import.meta.url)('electron') as string
const provider = vi.fn(() => ({ PATH: process.platform === 'win32'
  ? `${bin}${delimiter}${join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')}`
  : `${bin}:/usr/bin:/bin` }))

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'goodbuddy-obsidian-'))
  appPath = join(root, 'app.asar.unpacked')
  vaultPath = join(root, 'Test Vault')
  bin = join(root, 'managed-bin')
  await mkdir(vaultPath)
  await mkdir(bin)
  const probe = join(root, 'child-pid.cjs')
  await writeFile(probe, `if (!process.versions.electron) throw new Error('Expected Electron managed Node'); require('node:fs').appendFileSync(${JSON.stringify(join(root, 'pids'))}, process.pid + '\\n')`)
  // Run the copied package through real Electron rather than the test runner's Node.
  await writeFile(join(bin, process.platform === 'win32' ? 'node.cmd' : 'node'),
    process.platform === 'win32'
      ? `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${electronExecutable}" --require "${probe}" %*\r\n`
      : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${electronExecutable.replaceAll("'", "'\\''")}' --require '${probe.replaceAll("'", "'\\''")}' "$@"\n`,
    { mode: 0o755 })
  await packageObsidianMcpVault(resolve('.'), join(appPath, 'out', 'main', 'obsidian-mcpvault'))
  service = new ObsidianService({ appPath: join(root, 'app.asar'), launchEnvironmentProvider: provider })
}, 60_000)

afterEach(() => vi.restoreAllMocks())
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

describe('Obsidian vault discovery', () => {
  it.each(['win32', 'darwin', 'linux'] as const)('discovers all registered vaults on %s, including closed ones', async (platform) => {
    const home = join(root, platform)
    const config = platform === 'win32' ? join(home, 'roaming')
      : platform === 'darwin' ? join(home, 'Library', 'Application Support') : join(home, 'xdg')
    await mkdir(join(config, 'obsidian'), { recursive: true })
    await writeFile(join(config, 'obsidian', 'obsidian.json'), JSON.stringify({ vaults: {
      first: { path: vaultPath, open: true }, second: { path: bin, open: false }
    } }))
    const discovery = new ObsidianService({ appPath, launchEnvironmentProvider: provider, platform, homePath: home,
      environment: { APPDATA: config, XDG_CONFIG_HOME: config } })
    expect(await discovery.listVaults({})).toEqual([
      { id: 'first', name: 'Test Vault', path: vaultPath }, { id: 'second', name: 'managed-bin', path: bin }
    ])
    await expect(discovery.callTool({}, { name: 'list_directory', arguments: {} })).rejects.toThrow('vaultId is required')
    await expect(discovery.callTool({}, { vaultId: 'missing', name: 'list_directory', arguments: {} })).rejects.toThrow('Unknown Obsidian vaultId')
    const probe = await discovery.testConnection({})
    expect(probe.vaults).toHaveLength(2)
    expect(probe.toolCount).toBeGreaterThan(15)
    const result = await discovery.callTool({}, { vaultId: 'first', name: 'list_directory', arguments: {} })
    expect(result.isError).not.toBe(true)
  })

  it('bypasses registry for an explicit folder and returns stable path IDs', async () => {
    const explicit = new ObsidianService({ appPath, launchEnvironmentProvider: provider, homePath: join(root, 'missing'), environment: {} })
    const first = await explicit.listVaults({ vaultPath })
    expect(await explicit.listVaults({ vaultPath: join(vaultPath, '.') })).toEqual(first)
    await expect(explicit.listVaults({})).rejects.toThrow('Cannot read Obsidian vault registry')
    await expect(explicit.listVaults({ vaultPath: join(root, 'absent') })).rejects.toThrow('missing or inaccessible')
    await expect(explicit.listVaults({ vaultPath: 'relative' })).rejects.toThrow('must be absolute')
    const file = join(root, 'not-a-folder')
    await writeFile(file, '')
    await expect(explicit.listVaults({ vaultPath: file })).rejects.toThrow('not a folder')
  })

  it('reports empty and invalid registries explicitly', async () => {
    const config = join(root, 'empty-config')
    await mkdir(join(config, 'obsidian'), { recursive: true })
    const registry = join(config, 'obsidian', 'obsidian.json')
    const discovery = new ObsidianService({ appPath, launchEnvironmentProvider: provider, platform: 'linux', environment: { XDG_CONFIG_HOME: config } })
    await writeFile(registry, '{}')
    await expect(discovery.listVaults({ vaultPath: '' })).rejects.toThrow('No Obsidian vaults')
    await writeFile(registry, '{"vaults":{"bad":{}}}')
    await expect(discovery.listVaults({})).rejects.toThrow('Invalid Obsidian vault registry entry: bad')
  })
})

describe('offline packaged MCPVault', () => {
  it('ships exact upstream version, licenses, and native trash assets outside asar', async () => {
    const modules = join(appPath, 'out', 'main', 'obsidian-mcpvault', 'node_modules')
    expect(JSON.parse(await readFile(join(modules, '@bitbonsai', 'mcpvault', 'package.json'), 'utf8')).version).toBe('0.16.0')
    expect(await readFile(join(modules, '@bitbonsai', 'mcpvault', 'LICENSE'), 'utf8')).toContain('MIT')
    expect((await stat(join(modules, 'trash', 'lib', 'windows-trash.exe'))).size).toBeGreaterThan(0)
    expect((await stat(join(modules, 'trash', 'lib', 'macos-trash'))).size).toBeGreaterThan(0)
  })

  it('lists every upstream tool and probes without modifying the vault', async () => {
    const before = await readdir(vaultPath)
    const tools = await service.listTools({ vaultPath })
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'read_note', 'write_note', 'patch_note', 'delete_note', 'move_note', 'move_file',
      'update_frontmatter', 'manage_tags', 'search_notes', 'list_directory'
    ]))
    const source = await readFile(resolve('node_modules/@bitbonsai/mcpvault/dist/src/createServer.js'), 'utf8')
    const names = [...source.matchAll(/name: "([a-z_]+)"/gu)].map((match) => match[1])
    expect(tools.map((tool) => tool.name)).toEqual(names)
    expect(await service.testConnection({ vaultPath })).toEqual({ vaults: await service.listVaults({ vaultPath }), toolCount: tools.length })
    expect(await readdir(vaultPath)).toEqual(before)
    expect(provider).toHaveBeenCalled()
  })

  it('writes, reads, patches, updates frontmatter and lists notes using only the copied package', async () => {
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await service.callTool({ vaultPath }, { name, arguments: args })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      return result.content.map((item) => item.type === 'text' ? item.text : '').join('\n')
    }
    await call('write_note', { path: 'smoke.md', content: '# Original\nBody', frontmatter: { title: 'Smoke', tags: ['test'] } })
    expect(await call('read_note', { path: 'smoke.md' })).toContain('# Original')
    await call('patch_note', { path: 'smoke.md', oldString: 'Original', newString: 'Patched' })
    await call('update_frontmatter', { path: 'smoke.md', frontmatter: { status: 'verified' } })
    const note = JSON.parse(await call('read_note', { path: 'smoke.md' }))
    expect(note.content).toContain('# Patched')
    expect(note.fm).toEqual({ title: 'Smoke', tags: ['test'], status: 'verified' })
    expect(await call('list_directory', {})).toContain('smoke.md')
    expect(await readFile(join(vaultPath, 'smoke.md'), 'utf8')).toContain('status: verified')
    await call('delete_note', { path: 'smoke.md', confirmPath: 'smoke.md', trashMode: 'local' })
  }, 15_000)

  it('does not launch for an already cancelled call', async () => {
    const start = vi.spyOn(StdioClientTransport.prototype, 'start')
    await expect(service.callTool({ vaultPath }, { name: 'list_directory', arguments: {} }, AbortSignal.abort())).rejects.toThrow()
    expect(start).not.toHaveBeenCalled()
  })

  it('closes the actual child when cancelled during initialization or a tool request', async () => {
    for (const method of ['initialize', 'tools/call']) {
      const controller = new AbortController()
      const send = StdioClientTransport.prototype.send
      const transports = new Set<StdioClientTransport>()
      const spy = vi.spyOn(StdioClientTransport.prototype, 'send').mockImplementation(function (this: StdioClientTransport, message) {
        transports.add(this)
        const result = send.call(this, message)
        if ('method' in message && message.method === method) controller.abort(new Error('Cancelled test call'))
        return result
      })
      await expect(service.callTool({ vaultPath }, { name: 'list_directory', arguments: {} }, controller.signal)).rejects.toThrow('Cancelled test call')
      expect(transports.size).toBe(1)
      for (const transport of transports) expect(transport.pid).toBeNull()
      spy.mockRestore()
    }
    const pids = (await readFile(join(root, 'pids'), 'utf8')).trim().split('\n').map(Number)
    await expect.poll(() => pids.filter((pid) => {
      try { process.kill(pid, 0); return true } catch { return false }
    })).toEqual([])
  })
})
