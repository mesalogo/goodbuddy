// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { LocalWorkspaceAccess } from './workspace/local-workspace-access'
import { prepareOfficeWorkspaceSource } from './office-workspace-source'

const paths: string[] = []
const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }) })
it('round-trips binary workspace data, rejects conflict, and removes staging', async () => {
  const base = resolve('temp')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'office-workspace-'))
  paths.push(root)
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const original = Buffer.alloc(700000, 231)
  const changed = Buffer.from('new binary document\x00\xff')
  await writeFile(join(workspace, 'source.docx'), original)
  const source = await prepareOfficeWorkspaceSource(new LocalWorkspaceAccess(workspace), 'source.docx', join(root, 'staging'))
  expect(await readFile(source.path)).toEqual(original)
  await writeFile(source.path, changed)
  await source.commit!(source.path, hash(original), hash(changed))
  expect(await readFile(join(workspace, 'source.docx'))).toEqual(changed)
  await writeFile(join(workspace, 'source.docx'), 'external')
  await expect(source.commit!(source.path, hash(changed), hash(changed))).rejects.toThrow('源文件已被其他程序修改')
  expect(await readFile(join(workspace, 'source.docx'), 'utf8')).toBe('external')
  expect(await readdir(workspace)).toEqual(['source.docx'])
  await source.dispose!()
  expect(await readdir(join(root, 'staging'))).toEqual([])
})
