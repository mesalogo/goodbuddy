import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileOutputBacking } from '../../../tests/support/paged-output-backing'
import { PagedOutputStore, PAGED_OUTPUT_MAX_PAGE_BYTES } from './paged-output-store'

const stores: PagedOutputStore[] = []
const backings: FileOutputBacking[] = []
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.dispose()))
  await Promise.all(backings.splice(0).map((backing) => backing.dispose()))
})

async function createStore() {
  const backing = new FileOutputBacking()
  backings.push(backing)
  const store = new PagedOutputStore('test', { backingStore: backing })
  stores.push(store)
  return { store, backing }
}

describe('PagedOutputStore', () => {
  it.each([1, 2, 3, 4, 7])('round trips split UTF-8 chunks with a %i byte page', async (limit) => {
    const { store } = await createStore()
    const text = 'a\u4f60\ud83d\ude00\ufffd\u597dZ'
    const writer = await store.create('owner', 2)
    for (const byte of Buffer.from(text)) await writer.append(Buffer.from([byte]))
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
    await writer.append('\ufffdrest')
    const saved = await writer.finish()
    expect(saved.text).toBe('\ufffd')
    expect(saved.reference?.nextCursor).toBe(3)
  })

  it('retains output omitted to keep JSON-escaped previews bounded', async () => {
    const { store } = await createStore()
    const writer = await store.create('owner', 12)
    await writer.append('\u0000'.repeat(12))
    const saved = await writer.finish()
    expect(saved.text).toBe('\u0000\u0000')
    expect(saved.reference?.nextCursor).toBe(2)
    const page = await store.read('owner', writer.handle, saved.reference!.nextCursor)
    expect(saved.text + page.content).toBe('\u0000'.repeat(12))
  })

  it('removes small, aborted, released and disposed output files', async () => {
    const { store, backing } = await createStore()
    const small = await store.create('owner', 10)
    await small.append('small')
    expect(await small.finish()).toEqual({ text: 'small', truncated: false })
    const empty = await store.create('owner', 10)
    expect(await empty.finish()).toEqual({ text: '', truncated: false })
    expect(backing.createdDirectory).toBe(false)
    const retained = await store.create('owner', 1)
    await retained.append('retained')
    await retained.finish()
    const active = await store.create('owner', 1)
    await active.append('active')
    const other = await store.create('other', 1)
    await other.append('other')
    await other.finish()
    await store.releaseOwner('owner')
    expect(backing.count).toBe(1)
    await expect(active.finish()).rejects.toThrow()
    await expect(store.read('owner', retained.handle)).rejects.toThrow()
    await expect(store.read('other', other.handle)).resolves.toMatchObject({ content: 'other' })
    await store.create('other', 1)
    await store.dispose()
    expect(backing.count).toBe(0)
    await expect(store.create('owner', 1)).rejects.toThrow()
  })

  it('waits for in-flight creation and writes before disposal', async () => {
    const { store, backing } = await createStore()
    let resume!: () => void
    const gate = new Promise<void>((resolve) => { resume = resolve })
    const create = backing.create.bind(backing)
    const creating = vi.spyOn(backing, 'create').mockImplementation(async (...args) => {
      await gate
      await create(...args)
    })
    const writer = await store.create('owner', 1)
    const pending = writer.append('complete output')
    await vi.waitFor(() => expect(creating).toHaveBeenCalledOnce())
    let disposed = false
    const disposal = store.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    resume()
    await pending
    await disposal
    expect(backing.count).toBe(0)
  })

  it.each(['create', 'append', 'finish'] as const)('cleans partial backing content after %s failure', async (method) => {
    const { store, backing } = await createStore()
    const original = backing[method].bind(backing)
    vi.spyOn(backing, method).mockImplementationOnce(async (...args: unknown[]) => {
      await (original as (...args: unknown[]) => Promise<void>)(...args)
      throw new Error('disk failure')
    })
    const writer = await store.create('owner', 1)
    await writer.append('complete output').catch(() => undefined)
    await expect(writer.finish()).rejects.toThrow()
    expect(backing.count).toBe(0)
  })

  it('does not return a successful partial result when the owner is missing', async () => {
    const store = new PagedOutputStore('unconfigured')
    stores.push(store)
    const writer = await store.create('owner', 2)
    await writer.append('ok')
    expect(() => writer.append('lost')).toThrow('not configured')
    await expect(writer.finish()).rejects.toThrow()
  })

  it('bounds capture across stores and releases admission after settlement', async () => {
    const { store, backing } = await createStore()
    const second = new PagedOutputStore('second', { backingStore: backing })
    stores.push(second)
    const writer = await store.create('owner', 8 * 1024 * 1024)
    await expect(second.create('other', 1)).rejects.toThrow('busy')
    await writer.abort()
    const next = await second.create('other', 1)
    await next.append('recovered')
    await next.finish()
  })

  it('rejects an unbounded producer and retries failed cleanup', async () => {
    const { store, backing } = await createStore()
    const writer = await store.create('owner', 1)
    expect(() => writer.append(Buffer.alloc(8 * 1024 * 1024))).toThrow('busy')
    await expect(writer.finish()).rejects.toThrow()
    const next = await store.create('owner', 1)
    await next.append('retained')
    await next.finish()
    vi.spyOn(backing, 'release').mockRejectedValueOnce(new Error('file busy'))
    await expect(store.dispose()).rejects.toThrow('file busy')
    await store.dispose()
    expect(backing.count).toBe(0)
  })

  it('streams more than the memory budget to one backing object in bounded writes', async () => {
    const { store, backing } = await createStore()
    const writer = await store.create('owner', 1024)
    const chunk = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 160; i += 1) await writer.append(chunk)
    const saved = await writer.finish()
    expect(saved.reference?.totalBytes).toBe(10 * 1024 * 1024)
    expect(backing.count).toBe(1)
    expect(backing.maximumWriteBytes).toBeLessThanOrEqual(64 * 1024)
    let cursor = 0
    while (cursor < saved.reference!.totalBytes) {
      const page = await store.read('owner', writer.handle, cursor)
      expect(page.content).toBe('x'.repeat(page.nextCursor - cursor))
      cursor = page.nextCursor
    }
  })
})
