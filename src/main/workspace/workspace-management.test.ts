import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  return execFileSync('git', ['-C', root, '-c', 'user.name=Workspace Test', '-c', 'user.email=workspace@example.invalid', ...args], { encoding: 'utf8', windowsHide: true }).trim()
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
  await expect(manageWorkspace(root, { kind: 'history', offset: 0 })).resolves.toMatchObject({ head: oid, commits: [{ subject: 'Initial subject', author: 'Workspace Test' }] })
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
