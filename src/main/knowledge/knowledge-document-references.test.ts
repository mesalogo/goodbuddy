import { describe, expect, it } from 'vitest'
import { KnowledgeDatabase } from './knowledge-database'
import { KnowledgeService } from './knowledge-service'
import { KnowledgeMcpGateway } from '../agent/knowledge-mcp-gateway'
import type { KnowledgeStoragePort } from './knowledge-storage-port'

describe('local document references', () => {
  it('searches names across the full scoped catalog and pages exact Unicode text through the gateway', async () => {
    const database = new KnowledgeDatabase(':memory:')
    database.initialize()
    const library = database.createKnowledgeBase({ name: 'Enabled', storageMode: 'managed', graphEnabled: false, graphStrategy: 'rules' })
    const other = database.createKnowledgeBase({ name: 'Other', storageMode: 'managed', graphEnabled: false, graphStrategy: 'rules' })
    const source = database.upsertSource({ knowledgeBaseId: library.id, type: 'file', location: '/docs', displayName: 'docs' })
    for (let i = 0; i < 501; i++) database.upsertDocument({ knowledgeBaseId: library.id, sourceId: source.id, externalId: `${i}`, title: `old-${i}` }, [])
    const content = '甲😀乙'.repeat(20)
    const document = database.upsertDocument({ knowledgeBaseId: library.id, sourceId: source.id, externalId: 'selected', title: '报告_100%.txt', sourceLocation: '/docs/报告_100%.txt' }, [
      { ordinal: 0, content, location: '1' },
      { ordinal: 1, content: 'disabled', enabled: false, location: '2' },
      { ordinal: 2, content: '末尾', location: '3' }
    ])
    const service = new KnowledgeService({ database: database as unknown as KnowledgeStoragePort, managedRoot: '.' })
    const gateway = new KnowledgeMcpGateway(service)
    const controller = new AbortController()
    const token = gateway.grant('test', [library.id], controller.signal)!
    try {
      expect(database.searchDocumentNames({ libraryIds: [library.id], query: '_100%' })).toEqual([
        expect.objectContaining({ id: document.id, title: '报告_100%.txt', libraryName: 'Enabled' })
      ])
      expect(database.searchDocumentNames({ libraryIds: [other.id], query: '报告' })).toEqual([])
      expect(database.searchDocumentNames({ libraryIds: [], query: '报告' })).toEqual([])
      let cursor: { ordinal: number; offset: number } | null = { ordinal: 0, offset: 0 }
      let text = ''
      do {
        const page = await gateway.readDocument(token, { documentId: document.id, ...cursor, limit: 7 })
        text += page.text
        cursor = page.next
      } while (cursor)
      expect(text).toBe(content + '末尾')
      await expect(gateway.readDocument(token, { documentId: document.id, offset: 10000 })).rejects.toThrow('offset')
      const failed = database.upsertDocument({ knowledgeBaseId: library.id, sourceId: source.id,
        externalId: 'failed', title: '未解析.txt', metadata: { status: 'failed' } }, [])
      expect(await gateway.readDocument(token, { documentId: failed.id })).toMatchObject({ status: 'failed', text: '', next: null,
        message: expect.stringContaining('No enabled parsed text') })
      database.removeDocument(failed.id)
      await expect(gateway.readDocument(token, { documentId: failed.id })).rejects.toThrow('unavailable')
      const excluded = gateway.grant('excluded', [other.id], new AbortController().signal)!
      await expect(gateway.readDocument(excluded, { documentId: document.id })).rejects.toThrow('unavailable')
      controller.abort()
      await expect(gateway.readDocument(token, { documentId: document.id })).rejects.toThrow('authorization')
    } finally {
      await gateway.dispose()
      await service.dispose()
      database.close()
    }
  })
})
