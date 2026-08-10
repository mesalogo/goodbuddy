import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgeService } from '../knowledge/knowledge-service'
import { KnowledgeMcpGateway } from './knowledge-mcp-gateway'

const firstLibraryId = '11111111-1111-4111-8111-111111111111'
const secondLibraryId = '22222222-2222-4222-8222-222222222222'

function createService() {
  const searchHybridMany = vi.fn(
    async (libraryIds: readonly string[]) =>
      libraryIds.map((knowledgeBaseId, index) => ({
        knowledgeBaseId,
        result: {
          document: {
            id: `33333333-3333-4333-8333-33333333333${index}`,
            title: `文档 ${index}`
          },
          source: {
            displayName: `来源 ${index}`,
            location: `/private/${index}`
          },
          chunk: { location: `第 ${index + 1} 段` },
          snippet: `<mark>匹配</mark> ${index}`,
          rank: index + 1,
          retrieval: {
            channels: ['fts'] as const,
            evidenceIds: []
          }
        }
      }))
  )
  const service = {
    database: {
      listKnowledgeBases: () => [
        {
          id: firstLibraryId,
          name: '一号知识库',
          description: '不应暴露'
        },
        {
          id: secondLibraryId,
          name: '二号知识库',
          description: '已授权知识'
        }
      ]
    },
    searchHybridMany
  } as unknown as KnowledgeService
  return { service, searchHybridMany }
}

const gateways: KnowledgeMcpGateway[] = []

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.dispose()))
})

describe('KnowledgeMcpGateway', () => {
  it('keeps scope server-side, strips markup, bounds model arguments, and drains references', async () => {
    const { service, searchHybridMany } = createService()
    const gateway = new KnowledgeMcpGateway(service)
    gateways.push(gateway)
    const token = gateway.grant(
      'request-1',
      [secondLibraryId],
      new AbortController().signal
    )

    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/u)
    expect(gateway.getAvailableToolNames(token!)).toEqual([
      'knowledge_list',
      'knowledge_search'
    ])
    expect(gateway.listLibraries(token!)).toEqual([
      {
        id: secondLibraryId,
        name: '二号知识库',
        description: '已授权知识'
      }
    ])
    expect(() =>
      gateway.listLibraries(token!, {
        libraryIds: [firstLibraryId]
      })
    ).toThrow()
    const references = await gateway.search(token!, {
      query: '  要找什么  ',
      limit: 1
    })

    expect(searchHybridMany).toHaveBeenCalledWith(
      [secondLibraryId],
      '要找什么',
      1,
      expect.any(AbortSignal)
    )
    expect(references).toEqual([
      expect.objectContaining({
        libraryId: secondLibraryId,
        libraryName: '二号知识库',
        snippet: '匹配 0'
      })
    ])
    expect(gateway.drainReferences(token)).toEqual(references)
    expect(gateway.drainReferences(token)).toEqual([])
    await expect(
      gateway.search(token!, {
        query: 'x',
        limit: 9,
        libraryIds: [firstLibraryId]
      })
    ).rejects.toThrow()
  })

  it('creates no capability for empty scope and rejects revoked, aborted, and expired capabilities', async () => {
    const { service } = createService()
    let now = 1_000
    const gateway = new KnowledgeMcpGateway(service, {
      capabilityTtlMs: 10,
      now: () => now
    })
    gateways.push(gateway)
    expect(
      gateway.grant('empty', [], new AbortController().signal)
    ).toBeUndefined()

    const revoked = gateway.grant(
      'revoked',
      [firstLibraryId],
      new AbortController().signal
    )!
    gateway.revoke(revoked)
    await expect(
      gateway.search(revoked, { query: 'x' })
    ).rejects.toThrow('unavailable or expired')

    const abortController = new AbortController()
    const aborted = gateway.grant(
      'aborted',
      [firstLibraryId],
      abortController.signal
    )!
    abortController.abort()
    await expect(
      gateway.search(aborted, { query: 'x' })
    ).rejects.toThrow('unavailable or expired')

    const expired = gateway.grant(
      'expired',
      [firstLibraryId],
      new AbortController().signal
    )!
    now += 11
    await expect(
      gateway.search(expired, { query: 'x' })
    ).rejects.toThrow('unavailable or expired')
  })

  it('grants bounded global Magic Notes search without a knowledge scope', () => {
    const { service } = createService()
    const searchMagicNotes = vi.fn(() => [
      {
        noteId: '00000000-0000-4000-8000-000000000701',
        noteTitle: '发布计划',
        entryId: '00000000-0000-4000-8000-000000000702',
        content: '核对构建产物',
        updatedAt: '2026-08-10T00:00:00.000Z'
      }
    ])
    const gateway = new KnowledgeMcpGateway(service, {
      magicNotesDatabase: { searchMagicNotes }
    })
    gateways.push(gateway)
    const token = gateway.grant(
      'notes',
      [],
      new AbortController().signal,
      true
    )!

    expect(gateway.getAvailableToolNames(token)).toEqual(['note_search'])
    expect(
      gateway.searchMagicNotes(token, {
        query: '  发布  ',
        limit: 3
      })
    ).toEqual([
      expect.objectContaining({
        noteTitle: '发布计划',
        content: '核对构建产物'
      })
    ])
    expect(searchMagicNotes).toHaveBeenCalledWith('发布', 3)
    expect(() =>
      gateway.searchMagicNotes(token, {
        query: '发布',
        noteIds: ['not-allowed']
      })
    ).toThrow()
  })

  it('binds a POST-only authenticated endpoint and rejects oversized bodies', async () => {
    const { service } = createService()
    const gateway = new KnowledgeMcpGateway(service, {
      maximumBodyBytes: 32
    })
    gateways.push(gateway)
    await gateway.start()
    const endpoint = gateway.getEndpoint()!
    const token = gateway.grant(
      'http',
      [firstLibraryId],
      new AbortController().signal
    )!

    const getResponse = await fetch(endpoint)
    expect(getResponse.status).toBe(405)
    expect(getResponse.headers.get('access-control-allow-origin')).toBeNull()

    const unauthorized = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}x` },
      body: '{}'
    })
    expect(unauthorized.status).toBe(401)

    const oversized = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ value: 'x'.repeat(100) })
    })
    expect(oversized.status).toBe(413)
  })
})
