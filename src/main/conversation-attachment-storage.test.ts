import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { ConversationAttachmentStorage } from './conversation-attachment-storage'
import { DocumentResultStorage } from './document-result-storage'
import { defaultDocumentParsingSettings } from './document-parsing-settings-store'

describe('conversation attachment files and references', () => {
  it.each([false, true])('measures repeated references with an attachment: %s', async (populated) => {
    const root = await mkdtemp(join(tmpdir(), 'goodbuddy-attachment-'))
    const results = new DocumentResultStorage(join(root, 'temp', 'document-parsing'))
    const storage = new ConversationAttachmentStorage(root, results)
    try {
      const conversation = randomUUID(), id = randomUUID()
      const context = { id, name: 'source.txt', kind: 'text' as const, size: 6, preview: 'source' }
      if (populated) storage.save(context, JSON.stringify(context), Buffer.from('source'))
      const ids = populated ? [id] : []
      storage.reference(conversation, 'draft', conversation, ids)
      const get = vi.spyOn(StatementSync.prototype, 'get')
      const all = vi.spyOn(StatementSync.prototype, 'all')
      const run = vi.spyOn(StatementSync.prototype, 'run')
      const exec = vi.spyOn(DatabaseSync.prototype, 'exec')
      let counts: { selects: number; writes: number; transactions: number }
      try {
        for (let index = 0; index < 100; index++) storage.reference(conversation, 'draft', conversation, ids)
        counts = {
          selects: get.mock.calls.length + all.mock.calls.length,
          writes: run.mock.calls.length,
          transactions: exec.mock.calls.filter(([sql]) => sql === 'BEGIN IMMEDIATE').length
        }
      } finally { get.mockRestore(); all.mockRestore(); run.mockRestore(); exec.mockRestore() }
      const durations: number[] = []
      for (let sample = 0; sample < 3; sample++) {
        const start = performance.now()
        for (let index = 0; index < 1000; index++) storage.reference(conversation, 'draft', conversation, ids)
        durations.push(Number((performance.now() - start).toFixed(3)))
      }
      console.info(JSON.stringify({ populated, countedCalls: 100, ...counts, callsPerSample: 1000, durationsMs: durations }))
      expect(counts.writes).toBe(0)
      expect(counts.transactions).toBe(0)
      expect(storage.draft(conversation)).toEqual(populated ? [context] : [])
    } finally { storage.close(); await results.close(); await rm(root, { recursive: true, force: true }) }
  })

  it.each(['draft', 'message', 'queue', 'parsing'] as const)('preserves ordered replacement, ownership and cleanup for %s references', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'goodbuddy-attachment-'))
    const results = new DocumentResultStorage(join(root, 'temp', 'document-parsing'))
    const storage = new ConversationAttachmentStorage(root, results)
    const database = new DatabaseSync(join(root, 'conversation-attachments.sqlite'))
    try {
      const conversation = randomUUID(), otherConversation = randomUUID(), owner = conversation
      const ids = [randomUUID(), randomUUID(), randomUUID()] as const
      for (const id of ids) {
        const context = { id, name: 'source.txt', kind: 'text' as const, size: 6, preview: 'source' }
        storage.save(context, JSON.stringify(context), Buffer.from(id))
      }
      const refs = () => database.prepare('SELECT attachment_id, conversation_id FROM attachment_refs WHERE kind = ? AND owner_id = ? ORDER BY rowid').all(kind, owner)
      const expected = (ordered: string[], conversationId = conversation) => ordered.map((id) => ({ attachment_id: id, conversation_id: conversationId }))
      storage.reference(conversation, kind, owner, [ids[0], 'missing', ids[0], ids[1]])
      expect(refs()).toEqual(expected(ids.slice(0, 2)))
      expect(storage.original(ids[0]).path).toContain(join('conversation-assets', conversation, 'documents', ids[0]))
      await expect(readFile(join(root, 'temp', 'document-parsing', ids[0], 'original.txt'))).rejects.toThrow()
      const get = vi.spyOn(StatementSync.prototype, 'get')
      const run = vi.spyOn(StatementSync.prototype, 'run')
      const exec = vi.spyOn(DatabaseSync.prototype, 'exec')
      try {
        storage.reference(conversation, kind, owner, [ids[0], 'missing', ids[0], ids[1], 'missing'])
        expect(get.mock.calls.map(([id]) => id)).toEqual([ids[0], 'missing', ids[1]])
        expect(run).not.toHaveBeenCalled()
        expect(exec).not.toHaveBeenCalled()
      } finally { get.mockRestore(); run.mockRestore(); exec.mockRestore() }

      storage.reference(conversation, kind, owner, [ids[1], ids[0]])
      expect(refs()).toEqual(expected([ids[1], ids[0]]))
      if (kind === 'draft') expect(storage.draft(owner).map(({ id }) => id)).toEqual([ids[1], ids[0]])
      storage.reference(otherConversation, kind, owner, [ids[1], ids[0]])
      expect(refs()).toEqual(expected([ids[1], ids[0]], otherConversation))
      storage.deleteConversation(conversation, ids)
      expect(refs()).toEqual(expected([ids[1], ids[0]], otherConversation))

      storage.reference(otherConversation, 'message', 'shared-owner', [ids[0]])
      storage.reference(otherConversation, kind, owner, [ids[2]])
      expect(refs()).toEqual(expected([ids[2]], otherConversation))
      storage.collect()
      expect(storage.has(ids[0])).toBe(true)
      expect(storage.has(ids[1])).toBe(false)
      expect(storage.original(ids[2]).data).toEqual(Buffer.from(ids[2]))
      storage.reference(otherConversation, kind, owner, ['missing'])
      expect(refs()).toEqual([])
      const emptyRun = vi.spyOn(StatementSync.prototype, 'run')
      const emptyExec = vi.spyOn(DatabaseSync.prototype, 'exec')
      try {
        storage.reference(otherConversation, kind, owner, [])
        storage.reference(otherConversation, kind, owner, ['missing', 'missing'])
        expect(emptyRun).not.toHaveBeenCalled()
        expect(emptyExec).not.toHaveBeenCalled()
      } finally { emptyRun.mockRestore(); emptyExec.mockRestore() }
      storage.collect()
      expect(storage.has(ids[2])).toBe(false)
      storage.deleteConversation(otherConversation)
      expect(storage.has(ids[0])).toBe(false)
    } finally { database.close(); storage.close(); await results.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('promotes temporary files even when references already match and rolls back failed replacements', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goodbuddy-attachment-'))
    const results = new DocumentResultStorage(join(root, 'temp', 'document-parsing'))
    const storage = new ConversationAttachmentStorage(root, results)
    const database = new DatabaseSync(join(root, 'conversation-attachments.sqlite'))
    try {
      const conversation = randomUUID(), first = randomUUID(), second = randomUUID()
      for (const id of [first, second]) {
        const context = { id, name: 'image.png', kind: 'image' as const, size: 6, preview: 'source' }
        storage.save(context, JSON.stringify(context), Buffer.from(id))
      }
      database.prepare('INSERT INTO attachment_refs VALUES (?, ?, ?, ?)').run(first, conversation, 'draft', conversation)
      database.exec(`CREATE TRIGGER reject_promotion BEFORE UPDATE OF path ON attachments
        BEGIN SELECT RAISE(ABORT, 'promotion failed'); END`)
      expect(() => storage.reference(conversation, 'draft', conversation, [first])).toThrow('promotion failed')
      expect(storage.original(first).path).toContain(join('temp', 'document-parsing', first))
      expect(storage.original(first).data).toEqual(Buffer.from(first))
      database.exec('DROP TRIGGER reject_promotion')
      storage.reference(conversation, 'draft', conversation, [first, first])
      expect(storage.original(first).path).toContain(join('conversation-assets', conversation, 'images', first))
      expect(storage.original(first).data).toEqual(Buffer.from(first))
      await expect(readFile(join(root, 'temp', 'document-parsing', first, 'original.png'))).rejects.toThrow()

      database.exec(`CREATE TRIGGER reject_reference BEFORE INSERT ON attachment_refs
        WHEN NEW.attachment_id = '${second}' BEGIN SELECT RAISE(ABORT, 'reference failed'); END`)
      expect(() => storage.reference(conversation, 'draft', conversation, [first, second])).toThrow('reference failed')
      expect(storage.draft(conversation).map(({ id }) => id)).toEqual([first])
      // Promotion precedes the reference transaction and remains durable after its rollback.
      expect(storage.original(second).path).toContain(join('conversation-assets', conversation, 'images', second))
      expect(storage.original(second).data).toEqual(Buffer.from(second))
      database.exec('DROP TRIGGER reject_reference')
      storage.reference(conversation, 'draft', conversation, [second, first])
      expect(storage.draft(conversation).map(({ id }) => id)).toEqual([second, first])
      expect(database.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' })
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally { database.close(); storage.close(); await results.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('retains interrupted originals without turning them into sendable draft attachments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goodbuddy-attachment-'))
    let results = new DocumentResultStorage(join(root, 'temp', 'document-parsing'))
    let storage = new ConversationAttachmentStorage(root, results)
    try {
      const conversation = randomUUID()
      const bytes = Buffer.from('synthetic pending source')
      const id = storage.beginParsing(conversation, 'pending.pdf', bytes)
      storage.close()
      results = new DocumentResultStorage(join(root, 'temp', 'document-parsing'))
      storage = new ConversationAttachmentStorage(root, results)
      storage.reconcile((owner) => owner === conversation, true)
      expect(storage.pendingParsing(conversation)).toMatchObject([{ id, parsingState: 'interrupted' }])
      expect(storage.draft(conversation)).toEqual([])
      expect(storage.original(id).data).toEqual(bytes)
      storage.release('parsing', id)
      storage.collect()
      expect(storage.has(id)).toBe(false)
    } finally { storage.close(); await results.close(); await rm(root, { recursive: true, force: true }) }
  })
  it('reopens originals and parsed documents after restart and retains shared references on deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goodbuddy-attachment-'))
    let results = new DocumentResultStorage(join(root, 'temp', 'document-parsing'))
    let storage = new ConversationAttachmentStorage(root, results)
    try {
      const source = Buffer.from('original bytes')
      const id = await storage.saveDocument('SOURCE.PDF', source, {
        title: 'Source', sourceFormat: '.pdf', content: 'Parsed content', sections: [{ locator: 'Page 1', content: 'Parsed content' }],
        warnings: [], parsingSettings: defaultDocumentParsingSettings
      })
      const context = { id, name: 'SOURCE.PDF', originalName: 'SOURCE.PDF', resourceId: id, resultId: id, kind: 'text' as const, size: 14, preview: 'Parsed content' }
      storage.adoptDocument(context, JSON.stringify({ ...context, content: 'Parsed content' }))
      const first = randomUUID(), second = randomUUID()
      storage.reference(first, 'draft', first, [id])
      storage.reference(second, 'message', randomUUID(), [id])
      storage.close()
      await results.close()
      results = new DocumentResultStorage(join(root, 'temp', 'document-parsing'))
      storage = new ConversationAttachmentStorage(root, results)
      expect(storage.draft(first)).toEqual([context])
      expect(storage.original(id).data.equals(source)).toBe(true)
      expect((await results.get(id)).content).toBe('Parsed content')
      storage.deleteConversation(first)
      expect(storage.original(id).data.equals(source)).toBe(true)
      const originalPath = storage.original(id).path
      storage.deleteConversation(second)
      expect(storage.has(id)).toBe(false)
      await expect(readFile(originalPath)).rejects.toThrow()
    } finally { storage.close(); await results.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('keeps image bytes in files and preserves queue resources when a draft is cleared', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goodbuddy-attachment-'))
    const results = new DocumentResultStorage(join(root, 'temp', 'document-parsing'))
    const storage = new ConversationAttachmentStorage(root, results)
    try {
      const id = randomUUID(), conversation = randomUUID(), queue = randomUUID()
      const image = Buffer.from('synthetic original image')
      const context = { id, name: 'image.png', kind: 'image' as const, size: 4, preview: '4x4', thumbnailUrl: 'data:image/png;base64,AAAA', contentUrl: 'data:image/png;base64,BBBB', resourceId: id }
      storage.save(context, JSON.stringify(context), image)
      storage.reference(conversation, 'draft', conversation, [id])
      storage.reference(conversation, 'queue', queue, [id])
      storage.release('draft', conversation)
      storage.collect()
      expect(storage.original(id).data.equals(image)).toBe(true)
      const database = new DatabaseSync(join(root, 'conversation-attachments.sqlite'))
      try {
        const row = database.prepare('SELECT metadata FROM attachments WHERE id = ?').get(id) as { metadata: string }
        expect(row.metadata).not.toContain('base64')
      } finally { database.close() }
      storage.release('queue', queue)
      storage.collect()
      expect(storage.has(id)).toBe(false)
    } finally { storage.close(); await results.close(); await rm(root, { recursive: true, force: true }) }
  })
})
