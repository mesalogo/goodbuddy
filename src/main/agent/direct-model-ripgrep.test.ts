import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rgPath } from '@vscode/ripgrep'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalWorkspaceAccess } from '../workspace'
import { LocalDirectModelProcessService } from './direct-model-process-service'
import { searchWorkspaceWithRipgrep } from './direct-model-ripgrep'

let root: string
let workspace: LocalWorkspaceAccess
let service: LocalDirectModelProcessService
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'goodbuddy-rg-'))
  workspace = new LocalWorkspaceAccess(root)
  service = new LocalDirectModelProcessService()
  await writeFile(join(root, 'valid.txt'), 'before\ntarget\nafter\n')
})
afterEach(async () => {
  await service.dispose()
  await rm(root, { recursive: true, force: true })
})
const search = (args: string[], workMode: 'ask' | 'execute' = 'execute', signal = new AbortController().signal) =>
  searchWorkspaceWithRipgrep(rgPath, { args }, workspace, signal, service, 'owner', workMode)

describe('native ripgrep', () => {
  it('preserves native context, file listing, JSON and multiple expressions', async () => {
    expect((await search(['-A1', '-B1', '-e', 'target', '-e', 'absent', '.'], 'ask')).stdout).toContain('after')
    expect((await search(['--files', '-g', '*.txt'], 'ask')).stdout).toContain('valid.txt')
    expect((await search(['--json', 'target', '.'])).stdout).toContain('"type":"match"')
  })
  it('preserves no matches, regex errors and partial results with exit codes', async () => {
    expect(await search(['absent', '.'])).toMatchObject({ exitCode: 1, stdout: '' })
    expect(await search(['[', '.'])).toMatchObject({ exitCode: 2, stderr: expect.stringContaining('regex parse error') })
    expect(await search(['target', 'valid.txt', 'missing.txt'], 'ask')).toMatchObject({
      exitCode: 2, stdout: expect.stringContaining('target'), stderr: expect.stringContaining('missing.txt')
    })
  })
  it('retains more than the former 4 MiB capture and resumes through EOF', async () => {
    const text = 'target '.repeat(700_000) + 'END-MARKER\n'
    await writeFile(join(root, 'large.txt'), text)
    const result = await search(['--no-line-number', 'target', 'large.txt'])
    expect(result.exitCode).toBe(0)
    expect(result.stdoutTruncated).toBe(true)
    const reference = result.stdoutReference!
    let output = result.stdout
    let cursor = reference.nextCursor
    while (cursor < reference.totalBytes) {
      const page = await service.readOutput('owner', reference.handle, cursor)
      output += page.content
      cursor = page.nextCursor
    }
    expect(output).toBe(text)
    await expect(service.readOutput('another', reference.handle)).rejects.toThrow()
    await service.releaseConversation('owner')
    await expect(service.readOutput('owner', reference.handle)).rejects.toThrow()
  })
  it.each([['--pre=cmd', 'target'], ['--hostname-bin', 'cmd', 'target'], ['-L', 'target'], ['-z', 'target'], ['target', '../outside'], ['-f../outside']])('keeps Ask boundaries for %j', async (...args) => {
    await expect(search(args, 'ask')).rejects.toThrow()
  })
  it('supports cwd and literal shell characters while ignoring external config', async () => {
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'text.txt'), '$(echo unexpected); target\n')
    await writeFile(join(root, 'config'), '--invalid-config-option\n')
    const configured = new LocalDirectModelProcessService({ environment: { ...process.env, RIPGREP_CONFIG_PATH: join(root, 'config') } })
    try {
      const result = await searchWorkspaceWithRipgrep(rgPath, {
        args: ['-F', '$(echo unexpected);', '.'], cwd: 'nested'
      }, workspace, new AbortController().signal, configured, 'owner', 'ask')
      expect(result).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('$(echo unexpected); target') })
    } finally { await configured.dispose() }
  })
  it('allows external Execute paths and rejects Ask directory links', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'goodbuddy-rg-outside-'))
    try {
      await writeFile(join(outside, 'outside.txt'), 'target\n')
      await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
      expect((await search(['target', outside])).exitCode).toBe(0)
      await expect(search(['target', outside], 'ask')).rejects.toThrow('不能超出')
      await expect(search(['target', 'linked'], 'ask')).rejects.toThrow()
    } finally { await rm(outside, { recursive: true, force: true }) }
  })
  it('preserves cancellation', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(search(['target'], 'execute', controller.signal)).rejects.toThrow('cancelled')
  })
})
