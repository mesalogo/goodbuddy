import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { ConversationAttachmentStorage } from './conversation-attachment-storage'
import { DocumentResultStorage } from './document-result-storage'
import { defaultDocumentParsingSettings } from './document-parsing-settings-store'

describe('conversation attachment files and references', () => {
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
