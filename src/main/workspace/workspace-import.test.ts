import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalWorkspaceAccess } from './local-workspace-access'
import { importWorkspaceFiles } from './workspace-import'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('imports multichunk binary and empty files into the selected directory, retaining collisions and source files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-import-')); roots.push(root)
  await mkdir(join(root, 'selected')); await mkdir(join(root, 'source'))
  const binary = Buffer.alloc(700_001).map((_, index) => index % 256)
  await writeFile(join(root, 'source/image.png'), binary)
  await writeFile(join(root, 'source/empty.txt'), '')
  await writeFile(join(root, 'selected/empty.txt'), 'keep')
  const access = new LocalWorkspaceAccess(root)
  const result = await importWorkspaceFiles(access, 'selected', [join(root, 'source/image.png'), join(root, 'source/empty.txt')])
  expect(result.imported).toEqual(['selected/image.png'])
  expect(result.failed).toEqual([{ name: 'empty.txt', error: expect.stringContaining('EEXIST') }])
  expect(await readFile(join(root, 'selected/image.png'))).toEqual(binary)
  expect(await readFile(join(root, 'source/image.png'))).toEqual(binary)
  expect(await readFile(join(root, 'selected/empty.txt'), 'utf8')).toBe('keep')
  expect((await importWorkspaceFiles(access, '', [join(root, 'source/empty.txt')])).imported).toEqual(['empty.txt'])
  expect((await stat(join(root, 'empty.txt'))).size).toBe(0)
  const listing = await access.listDirectory({ path: 'selected' })
  const metadata = await stat(join(root, 'selected/image.png'))
  expect(listing.entries.find(entry => entry.name === 'image.png')).toMatchObject({ modifiedAt: metadata.mtime.toISOString(), ...(metadata.birthtimeMs > 0 ? { createdAt: metadata.birthtime.toISOString() } : {}) })
})

it('removes a partial import after a write failure and continues the batch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-import-failure-')); roots.push(root)
  await mkdir(join(root, 'selected')); await writeFile(join(root, 'large.bin'), Buffer.alloc(300_000)); await writeFile(join(root, 'next.txt'), 'next')
  const access = new LocalWorkspaceAccess(root)
  const manage = access.manage.bind(access)
  vi.spyOn(access, 'manage').mockImplementation(async action => {
    if (action.kind === 'importFile' && action.offset > 0) throw new Error('Connection interrupted')
    return manage(action)
  })
  const result = await importWorkspaceFiles(access, 'selected', [join(root, 'large.bin'), join(root, 'next.txt')])
  expect(result).toEqual({ imported: ['selected/next.txt'], failed: [{ name: 'large.bin', error: 'Connection interrupted' }] })
  expect(await readdir(join(root, 'selected'))).toEqual(['next.txt'])
})
