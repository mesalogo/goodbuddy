// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { createDesktopStorageFiles, openDesktopStorageFiles, type DesktopFilesCaller, type DesktopStorageFilesOwner } from './desktop-storage-files'
import { PagedOutputStore } from './agent/paged-output-store'
import { defaultDocumentParsingSettings } from './document-parsing-settings-store'

const roots: string[] = []
const owners = new Set<DesktopStorageFilesOwner>()
afterEach(async () => {
  for (const owner of owners) await owner.close()
  owners.clear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function setup() {
  const parent = resolve('temp/goodbuddy-files-upgrade')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'owner-'))
  roots.push(root)
  const owner = await openDesktopStorageFiles(root, () => true)
  owners.add(owner)
  // Exercise utility-process DTO shapes: Buffer becomes Uint8Array.
  const call: DesktopFilesCaller['call'] = async (domain, method, args, options) =>
    structuredClone(await owner.dispatch(domain, method, structuredClone(args), options?.signal)) as never
  return { root, owner, ...createDesktopStorageFiles({ call }) }
}

const parsed = {
  title: 'Source', sourceFormat: '.pdf', content: 'Complete parsed content',
  sections: [{ locator: 'Page 1', content: 'Complete parsed content' }], warnings: [],
  parsingSettings: defaultDocumentParsingSettings
}

it('retains adopted child output through stale and current renderer reference replacement', async () => {
  const { attachments } = await setup()
  const conversation = randomUUID(), message = randomUUID(), handle = `subagent:${randomUUID()}`
  await attachments.outputCreate('child-call', handle)
  await attachments.outputAppend('child-call', handle, Buffer.from('complete child output'))
  await attachments.outputFinish('child-call', handle, 21)
  const id = await attachments.outputAdopt('child-call', handle, conversation, 'message', message)
  await attachments.reference(conversation, 'message', message, [])
  await attachments.outputRelease('child-call', handle)
  await attachments.reference(conversation, 'message', message, [id], [handle])
  expect(Buffer.from(await attachments.outputRead(conversation, handle, 0, 21)).toString()).toBe('complete child output')
  const branch = randomUUID(), branchMessage = randomUUID()
  await attachments.reference(branch, 'message', branchMessage, [], [handle])
  await attachments.reference(branch, 'message', branchMessage, [])
  await attachments.deleteConversation(conversation)
  expect(Buffer.from(await attachments.outputRead(branch, handle, 0, 21)).toString()).toBe('complete child output')
  await attachments.release('message', branchMessage)
  await attachments.collect()
  expect(await attachments.has(id)).toBe(false)
  await expect(attachments.reference(branch, 'message', branchMessage, [id], [handle])).rejects.toThrow()
})

it.each(['draft', 'message', 'queue', 'parsing'] as const)('keeps output refs until authoritative %s cancellation and call settlement', async kind => {
  const { attachments } = await setup()
  const conversation = randomUUID(), reference = randomUUID(), handle = `process:${randomUUID()}`
  await attachments.outputCreate('call', handle)
  await attachments.outputAppend('call', handle, Buffer.from('full'))
  await attachments.outputFinish('call', handle, 4)
  const id = await attachments.outputAdopt('call', handle, conversation, kind, reference)
  const attachmentId = randomUUID()
  await attachments.save({ id: attachmentId, name: 'source.txt', kind: 'text', size: 4, preview: 'text' }, '{}', Buffer.from('text'))
  await attachments.reference(conversation, kind, reference, [attachmentId])
  await attachments.reference(conversation, kind, reference, [])
  await attachments.collect()
  expect(await attachments.has(attachmentId)).toBe(false)
  expect(Buffer.from(await attachments.outputRead(conversation, handle, 0, 4)).toString()).toBe('full')
  await attachments.release(kind, reference)
  await attachments.collect()
  expect(await attachments.has(id)).toBe(true)
  await expect(attachments.outputRead(conversation, handle, 0, 4)).rejects.toThrow('owner')
  await attachments.outputRelease('call', handle)
  expect(await attachments.has(id)).toBe(false)
})

it('rejects explicit missing, wrong and unfinished handles without replacing current references', async () => {
  const { attachments } = await setup()
  const conversation = randomUUID(), message = randomUUID(), id = randomUUID()
  await attachments.save({ id, name: 'source.txt', kind: 'text', size: 4, preview: 'text' }, '{}', Buffer.from('text'))
  await attachments.reference(conversation, 'message', message, [id])
  const handle = `process:${randomUUID()}`
  await attachments.outputCreate('call', handle)
  await attachments.outputAppend('call', handle, Buffer.from('full'))
  for (const invalid of [handle, `process:${randomUUID()}`, `process:${id}`]) {
    await expect(attachments.reference(conversation, 'message', message, [], [invalid])).rejects.toThrow()
  }
  await attachments.collect()
  expect(await attachments.has(id)).toBe(true)
  await attachments.outputFinish('call', handle, 4)
  await expect(attachments.reference(conversation, 'message', message, [], [handle.replace('process:', 'rg:')])).rejects.toThrow('missing')
  await attachments.outputRelease('call', handle)
  await attachments.release('message', message)
  await attachments.collect()
  expect(await attachments.has(id)).toBe(false)
})

it('reconciles preserved output refs against authoritative history on clear and cancelled publication', async () => {
  const { owner, attachments } = await setup()
  const conversation = randomUUID(), message = randomUUID(), handle = `process:${randomUUID()}`
  await attachments.outputCreate('call', handle)
  await attachments.outputAppend('call', handle, Buffer.from('full'))
  await attachments.outputFinish('call', handle, 4)
  const id = await attachments.outputAdopt('call', handle, conversation, 'message', message)
  await attachments.reference(conversation, 'message', message, [])
  await attachments.outputRelease('call', handle)
  owner.attachments.reconcile((c, kind, ref) => c === conversation && kind === 'message' && ref === message, true)
  expect(await attachments.has(id)).toBe(true)
  owner.attachments.reconcile(() => false)
  expect(await attachments.has(id)).toBe(false)
})

it('captures, pages, adopts and reopens one backing file; project deletion preserves other history', async () => {
  const { root, owner, backingStore, attachments } = await setup()
  const store = new PagedOutputStore('process', { backingStore })
  const writer = await store.create('call', 7)
  const content = 'prefix-\u4e2d\u6587\ud83d\ude00-tail'.repeat(10_000)
  const bytes = Buffer.from(content)
  for (let offset = 0; offset < bytes.length; offset += 65536) await writer.append(bytes.subarray(offset, offset + 65536))
  const finished = await writer.finish()
  const handle = finished.reference!.handle
  let cursor = finished.reference!.nextCursor
  let restored = finished.text
  while (cursor < bytes.length) {
    const page = await store.read('call', handle, cursor, 16384)
    restored += page.content
    cursor = page.nextCursor
  }
  expect(restored).toBe(content)
  const conversation = randomUUID(), other = randomUUID()
  const id = await attachments.outputAdopt('call', handle, conversation, 'message', 'message-one')
  await attachments.outputAdopt('call', handle, other, 'message', 'message-two')
  await store.dispose()
  const path = join(root, 'conversation-assets', conversation, 'documents', id)
  expect((await readdir(path)).sort()).toEqual(['original.txt', 'request.json'])
  expect(await readFile(join(path, 'original.txt'))).toEqual(bytes)
  expect(await readFile(join(path, 'request.json'), 'utf8')).not.toContain(content)
  expect(Buffer.from(await attachments.outputRead(conversation, handle, 0, 10))).toEqual(bytes.subarray(0, 10))
  await expect(attachments.outputRead('unrelated', handle, 0, 10)).rejects.toThrow('owner')
  await owner.close(); owners.delete(owner)
  const reopened = await openDesktopStorageFiles(root, () => true)
  owners.add(reopened)
  reopened.attachments.reconcile(() => true, true)
  reopened.attachments.deleteProject([conversation])
  expect(reopened.attachments.has(id)).toBe(true)
  expect(Buffer.from(await reopened.attachments.outputRead(other, handle, bytes.length - 4, 4))).toEqual(bytes.subarray(-4))
  reopened.attachments.deleteProject([other])
  expect(reopened.attachments.has(id)).toBe(false)
  await expect(readFile(join(path, 'original.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps short output in memory and cleans aborted, failed and unadopted captures without collecting active attachments', async () => {
  const { owner, root, backingStore, attachments } = await setup()
  const store = new PagedOutputStore('search', { backingStore })
  const small = await store.create('call', 100)
  await small.append('short')
  expect(await small.finish()).toEqual({ text: 'short', truncated: false })
  const id = randomUUID()
  await attachments.save({ id, name: 'draft.txt', kind: 'text', size: 1, preview: 'x' }, '{}', Buffer.from('x'))
  const writer = await store.create('call', 1)
  await writer.append('full output')
  await expect(attachments.outputFinish('call', writer.handle, 3)).rejects.toThrow('Incomplete')
  await expect(attachments.outputAdopt('call', writer.handle, randomUUID(), 'message', 'message')).rejects.toThrow('not finished')
  await expect(attachments.outputAppend('other', writer.handle, Buffer.from('x'))).rejects.toThrow('owner')
  await expect(attachments.outputAppend('call', writer.handle, Buffer.alloc(65537))).rejects.toThrow('64 KiB')
  await writer.abort()
  expect(await attachments.has(id)).toBe(true)
  expect(await attachments.has(writer.handle.split(':').at(-1)!)).toBe(false)
  const abandoned = await store.create('call', 1)
  await abandoned.append('never adopted')
  await abandoned.finish()
  await store.dispose()
  expect(await readdir(join(root, 'temp', 'document-parsing'))).toEqual([id])
  owner.attachments.collect()
})

it('reclaims crashed call references on startup without losing adopted history', async () => {
  const { root, owner, attachments } = await setup()
  const abandoned = `process:${randomUUID()}`, retained = `process:${randomUUID()}`
  for (const handle of [abandoned, retained]) {
    await attachments.outputCreate('call', handle)
    await attachments.outputAppend('call', handle, Buffer.from('complete'))
    await attachments.outputFinish('call', handle, 8)
  }
  const conversation = randomUUID()
  await attachments.outputAdopt('call', retained, conversation, 'message', 'message')
  // Simulate process exit, bypassing orderly call-reference release.
  owner.attachments.close(); owners.delete(owner)
  const reopened = await openDesktopStorageFiles(root, () => true)
  owners.add(reopened)
  reopened.attachments.reconcile(() => true, true)
  expect(reopened.attachments.has(abandoned.split(':')[1]!)).toBe(false)
  expect(Buffer.from(await reopened.attachments.outputRead(conversation, retained, 0, 8)).toString()).toBe('complete')
})

it('writes only manifest content, copies new results without parsed.md, and reads released layouts', async () => {
  const { root, owner, attachments, results } = await setup()
  const id = await attachments.saveDocument('source.pdf', Buffer.from('original'), parsed)
  const context = { id, name: 'source.pdf', resultId: id, kind: 'text' as const, size: 23, preview: 'Complete parsed content' }
  await attachments.adoptDocument(context, JSON.stringify(context))
  const conversation = randomUUID()
  await attachments.reference(conversation, 'message', 'message', [id])
  const path = join(root, 'conversation-assets', conversation, 'documents', id)
  expect(await readdir(path)).not.toContain('parsed.md')
  expect((await results.get(id)).content).toBe(parsed.content)
  const copyId = randomUUID()
  await attachments.save({ ...context, id: copyId, resultId: undefined }, '{}', Buffer.from('original'))
  expect(await attachments.copyResult(id, copyId)).toBe(true)
  expect((await results.get(copyId)).content).toBe(parsed.content)
  // Old redundant bodies remain readable; the manifest has always been authoritative.
  await writeFile(join(path, 'parsed.md'), parsed.content)
  const database = new DatabaseSync(join(root, 'conversation-attachments.sqlite'))
  database.prepare('UPDATE attachments SET path = ? WHERE id = ?').run(`conversation-assets\\${conversation}\\documents\\${id}`, id)
  database.close()
  expect((await attachments.original(id)).data).toEqual(Buffer.from('original'))
  expect((await results.get(id)).content).toBe(parsed.content)
  owner.attachments.reconcile(() => true, true, [copyId])
  expect((await results.get(id)).content).toBe(parsed.content)
  await attachments.deleteProject([conversation], [copyId])
  expect(await attachments.has(id)).toBe(false)
  expect(await attachments.has(copyId)).toBe(true)
})

it('failed adoption retains the temporary result for retry and cancelled save removes partial files', async () => {
  const { root, results, attachments } = await setup()
  const result = await results.save('source.pdf', Buffer.from('original'), parsed, defaultDocumentParsingSettings, 1)
  const context = { id: result.id, name: 'source.pdf', resultId: result.id, kind: 'text' as const, size: 1, preview: '' }
  const database = new DatabaseSync(join(root, 'conversation-attachments.sqlite'))
  try {
    database.exec("CREATE TRIGGER reject_adoption BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'adoption failed'); END")
    await expect(attachments.adoptDocument(context, '{}')).rejects.toThrow('adoption failed')
    expect(await results.isTemporaryResult(result.id)).toBe(true)
    expect((await results.get(result.id)).content).toBe(parsed.content)
    database.exec('DROP TRIGGER reject_adoption')
    await attachments.adoptDocument(context, '{}')
    expect(await results.isTemporaryResult(result.id)).toBe(false)
    await expect(attachments.adoptDocument(context, '{"changed":true}')).rejects.toThrow('already owned')
    expect(await attachments.request(context.id)).toBe('{}')
  } finally { database.close() }
  const controller = new AbortController()
  const saving = results.save('cancel.pdf', Buffer.alloc(1024 * 1024), parsed, defaultDocumentParsingSettings, 1, undefined, controller.signal)
  controller.abort()
  await expect(saving).rejects.toThrow()
  expect(await readdir(join(root, 'temp', 'document-parsing'))).toEqual([result.id])
})
