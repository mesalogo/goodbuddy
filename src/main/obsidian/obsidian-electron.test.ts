// @vitest-environment node
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import spawn from 'cross-spawn'
import { expect, it } from 'vitest'
import { createLocalToolEnvironment } from '../local-tool-environment/local-tool-environment'
import { ObsidianService } from './obsidian-service'
import { packageObsidianMcpVault } from './package-mcpvault'

it('runs copied MCPVault over stdio using real managed Electron without npm or network connections', async (context) => {
  const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
  const electronPackage = join(projectRoot, 'node_modules', 'electron')
  let electronExecutablePath: string
  try {
    const executable = (await readFile(join(electronPackage, 'path.txt'), 'utf8')).trim()
    electronExecutablePath = await realpath(join(electronPackage, 'dist', executable))
    expect((await stat(electronExecutablePath)).isFile()).toBe(true)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    context.skip('The node_modules/electron executable is not installed')
    return
  }

  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-obsidian-electron-'))
  try {
    const location = relative(projectRoot, root)
    expect(isAbsolute(location) || location === '..' || location.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)).toBe(true)
    const appPath = join(root, 'app.asar.unpacked')
    const vaultPath = join(root, 'Temporary Vault')
    const binDirectory = join(root, 'managed bin')
    await mkdir(vaultPath)
    const output = join(appPath, 'out', 'main', 'obsidian-mcpvault')
    await packageObsidianMcpVault(projectRoot, output)
    const manifest = JSON.parse(await readFile(join(output, 'node_modules', '@bitbonsai', 'mcpvault', 'package.json'), 'utf8'))
    expect(manifest.version).toBe('0.16.0')

    // Only Windows shell/process utilities are needed alongside the managed shim.
    const baseEnvironment: NodeJS.ProcessEnv = { PATH: '' }
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
      expect(systemRoot).toBeTruthy()
      baseEnvironment.SystemRoot = systemRoot
      baseEnvironment.PATH = join(systemRoot!, 'System32')
      baseEnvironment.COMSPEC = join(systemRoot!, 'System32', 'cmd.exe')
      baseEnvironment.PATHEXT = '.COM;.EXE;.BAT;.CMD'
    }
    const prepared = await createLocalToolEnvironment({
      binDirectory,
      nodeSelection: { source: 'managed' },
      pythonSelection: { source: 'managed' },
      packagedNpmCliPath: join(root, 'absent-npm-cli.js'),
      packagedNpxCliPath: join(root, 'absent-npx-cli.js'),
      baseEnvironment,
      probeTimeoutMs: 10_000
    }, { electronExecutablePath })
    expect(prepared.diagnostics.tools.node).toMatchObject({
      available: true, source: 'managed', executablePath: electronExecutablePath,
      shimPath: join(binDirectory, process.platform === 'win32' ? 'node.cmd' : 'node')
    })
    expect(prepared.environment.PATH?.split(delimiter)).toEqual([
      binDirectory, ...(baseEnvironment.PATH ? [baseEnvironment.PATH] : [])
    ])
    for (const name of ['npm', 'npx'] as const) {
      expect(prepared.diagnostics.tools[name].available).toBe(false)
      const probe = spawn.sync(name, ['--version'], {
        cwd: vaultPath, env: { ...baseEnvironment, ...prepared.environment },
        encoding: 'utf8', timeout: 5_000, windowsHide: true
      })
      expect((probe.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOENT')
    }

    const auditPath = join(root, 'children.jsonl')
    const attemptsPath = join(root, 'network-attempts')
    const preload = join(root, 'offline preload.cjs')
    await writeFile(attemptsPath, '')
    // NODE_OPTIONS is passed through the real service filter, not a mocked launcher.
    // These Node API guards cover MCPVault's process, not an OS-wide network sandbox.
    await writeFile(preload, `
const fs = require('node:fs');
const block = () => {
  fs.appendFileSync(${JSON.stringify(attemptsPath)}, 'blocked\\n');
  throw new Error('Network connections are forbidden in the Electron MCPVault test');
};
for (const name of ['node:http', 'node:https']) {
  const module = require(name);
  module.request = block;
  module.get = block;
}
const net = require('node:net');
net.connect = net.createConnection = net.Socket.prototype.connect = block;
require('node:tls').connect = block;
globalThis.fetch = block;
require('node:module').syncBuiltinESMExports();
fs.appendFileSync(${JSON.stringify(auditPath)}, JSON.stringify({
  pid: process.pid,
  executable: fs.realpathSync(process.execPath),
  electron: process.versions.electron,
  node: process.versions.node,
  runAsNode: process.env.ELECTRON_RUN_AS_NODE,
  path: process.env.PATH,
  cwd: process.cwd(),
  entry: process.argv[1]
}) + '\\n');
`)
    const service = new ObsidianService({
      appPath: join(root, 'app.asar'),
      homePath: root,
      environment: { ...baseEnvironment, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
      launchEnvironmentProvider: () => prepared.environment
    })
    const settings = { vaultPath }
    const connection = await service.testConnection(settings)
    expect(connection).toEqual({ vaults: await service.listVaults(settings), toolCount: 18 })
    expect(connection.vaults).toHaveLength(1)
    expect(connection.vaults[0]?.path).toBe(vaultPath)
    expect(await readdir(vaultPath)).toEqual([])

    const content = '# Electron integration\nWritten through the real MCP stdio transport.'
    const frontmatter = { title: 'Temporary Electron note', tags: ['integration'] }
    const written = await service.callTool(settings, {
      name: 'write_note', arguments: { path: 'electron.md', content, frontmatter }
    })
    expect(written.isError, JSON.stringify(written)).not.toBe(true)
    const read = await service.callTool(settings, {
      name: 'read_note', arguments: { path: 'electron.md' }
    })
    expect(read.isError, JSON.stringify(read)).not.toBe(true)
    const note = JSON.parse(read.content.map((item) => item.type === 'text' ? item.text : '').join('\n'))
    expect(note.content.trim()).toBe(content)
    expect(note.fm).toEqual(frontmatter)
    expect(await readFile(join(vaultPath, 'electron.md'), 'utf8')).toContain(content)

    const children = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(children).toHaveLength(3)
    for (const child of children) {
      expect(child).toMatchObject({
        executable: electronExecutablePath,
        electron: expect.stringMatching(/^\d+\.\d+\.\d+/u),
        node: prepared.diagnostics.tools.node.version,
        runAsNode: '1',
        path: prepared.environment.PATH,
        cwd: vaultPath,
        entry: join(output, 'node_modules', '@bitbonsai', 'mcpvault', 'dist', 'server.js')
      })
      await expect.poll(() => {
        try {
          process.kill(child.pid, 0)
          return true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
          throw error
        }
      }, { timeout: 5_000 }).toBe(false)
    }
    expect(await readFile(attemptsPath, 'utf8')).toBe('')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  }
}, 60_000)
