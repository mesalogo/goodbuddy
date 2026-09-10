import { execFileSync } from 'node:child_process'
import { link, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { manageWorkspace } from './workspace-management'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-workspace-management-'))
  roots.push(root)
  git(root, 'init', '-b', 'main')
  return root
}
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim()
}
it('creates, moves, inspects and deletes without overwriting an existing file', async () => {
  const root = await repository()
  await manageWorkspace(root, { kind: 'createDirectory', path: 'docs' })
  await manageWorkspace(root, { kind: 'createFile', path: 'docs/test.txt' })
  await writeFile(join(root, 'docs/test.txt'), 'keep')
  await expect(manageWorkspace(root, { kind: 'createFile', path: 'docs/test.txt' })).rejects.toThrow()
  await manageWorkspace(root, { kind: 'move', path: 'docs/test.txt', destination: 'docs/new.txt' })
  expect(await readFile(join(root, 'docs/new.txt'), 'utf8')).toBe('keep')
  await expect(manageWorkspace(root, { kind: 'properties', path: 'docs/new.txt' })).resolves.toMatchObject({ kind: 'properties', size: 4, type: 'file' })
  await expect(manageWorkspace(root, { kind: 'delete', path: '../outside' })).rejects.toThrow()
  await manageWorkspace(root, { kind: 'delete', path: 'docs' })
})
it('reads unborn history, initial commit files and literal paths, and switches with dirty files intact', async () => {
  const root = await repository()
  await expect(manageWorkspace(root, { kind: 'history', offset: 0 })).resolves.toMatchObject({ commits: [] })
  await writeFile(join(root, '[test].txt'), 'initial\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'Initial subject')
  const oid = git(root, 'rev-parse', 'HEAD')
  await expect(manageWorkspace(root, { kind: 'history', offset: 0 })).resolves.toMatchObject({ head: oid, commits: [{ subject: 'Initial subject', author: git(root, 'log', '-1', '--format=%an') }] })
  await expect(manageWorkspace(root, { kind: 'commitFiles', oid })).resolves.toMatchObject({ files: [{ path: '[test].txt', status: 'A' }] })
  await expect(manageWorkspace(root, { kind: 'commitDiff', oid, path: '[test].txt' })).resolves.toMatchObject({ patch: expect.stringContaining('+initial') })
  await writeFile(join(root, '[test].txt'), 'dirty\n')
  await manageWorkspace(root, { kind: 'createBranch', branch: 'feature/test' })
  await manageWorkspace(root, { kind: 'switchBranch', branch: 'main', remote: false })
  expect(await readFile(join(root, '[test].txt'), 'utf8')).toBe('dirty\n')
  expect(git(root, 'stash', 'list')).toBe('')
  await expect(manageWorkspace(root, { kind: 'branches' })).resolves.toMatchObject({ current: 'main', branches: expect.arrayContaining([{ name: 'feature/test', remote: false }]) })
})
it('reports switch conflicts without discarding dirty content and pages stable history', async () => {
  const root = await repository()
  await writeFile(join(root, 'test.txt'), 'initial')
  git(root, 'add', '.'); git(root, 'commit', '-m', 'initial')
  git(root, 'switch', '-c', 'other')
  await writeFile(join(root, 'test.txt'), 'other')
  git(root, 'commit', '-am', 'other')
  git(root, 'switch', 'main')
  await writeFile(join(root, 'test.txt'), 'dirty')
  await expect(manageWorkspace(root, { kind: 'switchBranch', branch: 'other', remote: false })).rejects.toThrow(/overwritten/)
  expect(await readFile(join(root, 'test.txt'), 'utf8')).toBe('dirty')
  for (let index = 0; index < 51; index++) git(root, 'commit', '--allow-empty', '-m', `page ${index}`)
  const first = await manageWorkspace(root, { kind: 'history', offset: 0 })
  expect(first.kind).toBe('history')
  if (first.kind !== 'history') return
  expect(first.commits).toHaveLength(50)
  expect(first.hasMore).toBe(true)
  const second = await manageWorkspace(root, { kind: 'history', offset: 50, head: first.head })
  expect(second).toMatchObject({ hasMore: false, commits: [{ subject: 'page 0' }, { subject: 'initial' }] })
}, 30_000)

it.each([false, true])('preserves rename metadata and actual edits in a literal commit diff (edited: %s)', async (edited) => {
  const root = await repository()
  const previousPath = '[old];$(echo).txt'
  const path = '[new];$(echo).txt'
  const original = Array.from({ length: 20 }, (_, index) => `original line ${index}\n`).join('')
  await writeFile(join(root, previousPath), original)
  await writeFile(join(root, 'unrelated.txt'), 'unrelated before\n')
  git(root, 'add', '.'); git(root, 'commit', '-m', 'before rename')
  await rename(join(root, previousPath), join(root, path))
  if (edited) await writeFile(join(root, path), original.replace('original line 10\n', 'edited line 10\n'))
  await writeFile(join(root, 'unrelated.txt'), 'unrelated after\n')
  git(root, 'add', '.'); git(root, 'commit', '-m', 'rename')
  const oid = git(root, 'rev-parse', 'HEAD')
  const files = await manageWorkspace(root, { kind: 'commitFiles', oid })
  expect(files).toMatchObject({ files: expect.arrayContaining([{ path, previousPath, status: edited ? expect.stringMatching(/^R\d+$/) : 'R100' }]) })
  const result = await manageWorkspace(root, { kind: 'commitDiff', oid, path })
  expect(result.kind).toBe('commitDiff')
  if (result.kind !== 'commitDiff') return
  expect(result.truncated).toBe(false)
  expect(result.patch).toContain(`rename from ${previousPath}`)
  expect(result.patch).toContain(`rename to ${path}`)
  expect(result.patch).not.toContain('new file mode')
  expect(result.patch).not.toContain('unrelated')
  if (edited) {
    expect(result.patch).toContain('-original line 10')
    expect(result.patch).toContain('+edited line 10')
    expect(result.patch).not.toContain('+original line 0')
  } else {
    expect(result.patch).toContain('similarity index 100%')
    expect(result.patch).not.toContain('@@')
  }
})

it.each(['file', 'directory'] as const)('renames a %s by case only on the current filesystem', async (type) => {
  const root = await repository()
  const source = join(root, 'MixedCase')
  if (type === 'directory') {
    await mkdir(source)
    await writeFile(join(source, 'keep.txt'), 'keep')
  } else await writeFile(source, 'keep')
  const alias = await lstat(join(root, 'mixedcase')).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  })
  if (alias) expect(alias.ino).toBe((await lstat(source)).ino)
  await expect(manageWorkspace(root, { kind: 'move', path: 'MixedCase', destination: 'mixedcase' })).resolves.toEqual({ kind: 'done' })
  const names = await readdir(root)
  expect(names).toContain('mixedcase')
  expect(names).not.toContain('MixedCase')
  expect(await readFile(join(root, 'mixedcase', ...(type === 'directory' ? ['keep.txt'] : [])), 'utf8')).toBe('keep')
})

it.each(['file', 'hardlink', 'directory'] as const)('rejects moving over a separate existing %s without changing either entry', async (type) => {
  const root = await repository()
  if (type === 'directory') {
    await mkdir(join(root, 'source'))
    await mkdir(join(root, 'destination'))
    await writeFile(join(root, 'source/keep.txt'), 'source')
    await writeFile(join(root, 'destination/keep.txt'), 'destination')
  } else {
    await writeFile(join(root, 'source'), 'source')
    if (type === 'hardlink') await link(join(root, 'source'), join(root, 'destination'))
    else await writeFile(join(root, 'destination'), 'destination')
  }
  await expect(manageWorkspace(root, { kind: 'move', path: 'source', destination: 'destination' })).rejects.toThrow('Destination already exists')
  expect(await readFile(join(root, type === 'directory' ? 'source/keep.txt' : 'source'), 'utf8')).toBe('source')
  expect(await readFile(join(root, type === 'directory' ? 'destination/keep.txt' : 'destination'), 'utf8')).toBe(type === 'hardlink' ? 'source' : 'destination')
})

it.for([false, true])('rejects a distinct case-differing destination on case-sensitive filesystems (hardlink: %s)', async (hardlink, context) => {
  const root = await repository()
  await writeFile(join(root, 'Case.txt'), 'source')
  const alias = await lstat(join(root, 'case.txt')).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  })
  if (alias) return context.skip()
  if (hardlink) await link(join(root, 'Case.txt'), join(root, 'case.txt'))
  else await writeFile(join(root, 'case.txt'), 'destination')
  await expect(manageWorkspace(root, { kind: 'move', path: 'Case.txt', destination: 'case.txt' })).rejects.toThrow('Destination already exists')
  expect(await readdir(root)).toEqual(expect.arrayContaining(['Case.txt', 'case.txt']))
  expect(await readFile(join(root, 'Case.txt'), 'utf8')).toBe('source')
  expect(await readFile(join(root, 'case.txt'), 'utf8')).toBe(hardlink ? 'source' : 'destination')
})
