import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PagedOutputStore, PAGED_OUTPUT_MAX_PAGE_BYTES } from './paged-output-store'

const stores: PagedOutputStore[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.dispose()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-output-test-'))
  directories.push(directory)
  const store = new PagedOutputStore('test', { temporaryParentDirectory: directory })
  stores.push(store)
  return { store, directory }
}

describe('PagedOutputStore', () => {
  it.each([1, 2, 3, 4, 7])('round trips split UTF-8 chunks with a %i byte page', async (limit) => {
    const { store } = await createStore()
    const text = 'a\u4f60\ud83d\ude00\ufffd\u597dZ'
    const writer = await store.create('owner', 2)
    for (const byte of Buffer.from(text)) writer.append(Buffer.from([byte]))
    const saved = await writer.finish()
    expect(saved.text).toBe('a')
    let output = saved.text
    let cursor = saved.reference!.nextCursor
    while (cursor < saved.reference!.totalBytes) {
      const page = await store.read('owner', writer.handle, cursor, limit)
      expect(page.nextCursor).toBeGreaterThan(cursor)
      expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(Math.max(limit, 4))
      output += page.content
      cursor = page.nextCursor
    }
    expect(output).toBe(text)
    await expect(store.read('owner', writer.handle, cursor, limit)).resolves.toMatchObject({ content: '', eof: true, nextCursor: cursor })
    await expect(store.read('owner', writer.handle, 2)).rejects.toThrow('UTF-8')
    await expect(store.read('other', writer.handle)).rejects.toThrow()
    for (const invalid of [-1, 0.5, cursor + 1]) {
      await expect(store.read('owner', writer.handle, invalid)).rejects.toThrow()
    }
    for (const invalid of [0, 0.5, PAGED_OUTPUT_MAX_PAGE_BYTES + 1]) {
      await expect(store.read('owner', writer.handle, 0, invalid)).rejects.toThrow()
    }
  })

  it('keeps literal replacement characters in previews', async () => {
    const { store } = await createStore()
    const writer = await store.create('owner', 3)
    writer.append('\ufffdrest')
    const saved = await writer.finish()
    expect(saved.text).toBe('\ufffd')
    expect(saved.reference?.nextCursor).toBe(3)
  })

  it('retains output omitted to keep JSON-escaped previews bounded', async () => {
    const { store } = await createStore()
    const writer = await store.create('owner', 12)
    writer.append('\u0000'.repeat(12))
    const saved = await writer.finish()
    expect(saved.text).toBe('\u0000\u0000')
    expect(saved.reference?.nextCursor).toBe(2)
    const page = await store.read('owner', writer.handle, saved.reference!.nextCursor)
    expect(saved.text + page.content).toBe('\u0000'.repeat(12))
  })

  it('removes small, aborted, released and disposed output files', async () => {
    const { store, directory } = await createStore()
    const small = await store.create('owner', 10)
    small.append('small')
    expect(await small.finish()).toEqual({ text: 'small', truncated: false })
    const retained = await store.create('owner', 1)
    retained.append('retained')
    await retained.finish()
    const active = await store.create('owner', 1)
    active.append('active')
    const other = await store.create('other', 1)
    other.append('other')
    await other.finish()
    const [childDirectory] = await readdir(directory)
    await store.releaseOwner('owner')
    expect(await readdir(join(directory, childDirectory!))).toHaveLength(1)
    await expect(active.finish()).rejects.toThrow()
    await expect(store.read('owner', retained.handle)).rejects.toThrow()
    await expect(store.read('other', other.handle)).resolves.toMatchObject({ content: 'other' })
    await store.create('other', 1)
    await store.dispose()
    expect(await readdir(directory)).toEqual([])
    await expect(store.create('owner', 1)).rejects.toThrow()
  })

  it('cleans up when disposed during directory creation', async () => {
    const { store, directory } = await createStore()
    const pending = store.create('owner', 1)
    const rejected = expect(pending).rejects.toThrow()
    await store.dispose()
    await rejected
    expect(await readdir(directory)).toEqual([])
  })
})
