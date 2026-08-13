import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgeService } from '../knowledge/knowledge-service'
import { AssistantDatabase } from '../assistant/assistant-database'
import {
  KnowledgeMcpGateway,
  type MagicNotesDatabase
} from './knowledge-mcp-gateway'

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
          chunk: {
            id: `44444444-4444-4444-8444-44444444444${index}`,
            location: `第 ${index + 1} 段`
          },
          snippet: `<mark>匹配</mark> ${index}`,
          rank: index + 1,
          retrieval: {
            score: 0.5,
            channels: ['fts'] as const,
            lexicalRank: 1,
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
const databases: AssistantDatabase[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.dispose()))
  for (const database of databases.splice(0)) {
    database.close()
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('KnowledgeMcpGateway', () => {
  it('exposes GoodBuddy config reads in Ask and apply only in Execute', async () => {
    const { service } = createService()
    const configService = {
      getCapabilities: vi.fn(() => ({ server: 'goodbuddy_config' })),
      getSnapshot: vi.fn(async () => ({ application: {}, skills: [], mcpServers: [] })),
      plan: vi.fn(async () => ({ planId: 'plan' })),
      apply: vi.fn(async () => ({ status: 'applied' })),
      revokeRequest: vi.fn()
    }
    const gateway = new KnowledgeMcpGateway(service, {
      configService: configService as never
    })
    gateways.push(gateway)
    const readToken = gateway.grant(
      'config-read',
      [],
      new AbortController().signal,
      'none',
      { access: 'read', workspacePath: process.cwd() }
    )!
    const authorizeApply = vi.fn(async () => true)
    const writeToken = gateway.grant(
      'config-write',
      [],
      new AbortController().signal,
      'none',
      {
        access: 'write',
        workspacePath: process.cwd(),
        authorizeApply
      }
    )!

    expect(gateway.getAvailableToolNames(readToken)).toEqual([
      'goodbuddy_config_capabilities',
      'goodbuddy_config_get',
      'goodbuddy_config_plan'
    ])
    expect(gateway.getAvailableToolNames(writeToken)).toEqual([
      'goodbuddy_config_capabilities',
      'goodbuddy_config_get',
      'goodbuddy_config_plan',
      'goodbuddy_config_apply'
    ])
    await gateway.callGoodBuddyConfigTool(
      readToken,
      'goodbuddy_config_capabilities',
      {}
    )
    expect(configService.getCapabilities).toHaveBeenCalledWith({})
    await expect(
      gateway.callGoodBuddyConfigTool(
        readToken,
        'goodbuddy_config_apply',
        { planId: crypto.randomUUID() }
      )
    ).rejects.toThrow('unavailable')
    await gateway.callGoodBuddyConfigTool(
      writeToken,
      'goodbuddy_config_apply',
      { planId: crypto.randomUUID() }
    )
    expect(configService.apply).toHaveBeenCalledWith(
      'config-write',
      expect.any(Object),
      expect.any(AbortSignal),
      authorizeApply
    )
    gateway.revoke(writeToken)
    expect(configService.revokeRequest).toHaveBeenCalledWith('config-write')
  })

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
        chunkId: '44444444-4444-4444-8444-444444444440',
        score: 0.5,
        snippet: '匹配 0'
      })
    ])
    expect(references[0]?.sourceLocation).toBeUndefined()
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
      magicNotesDatabase: {
        listMagicNotes: vi.fn(() => []),
        getMagicNote: vi.fn(() => {
          throw new Error('not used')
        }),
        getMagicNoteEntry: vi.fn(() => {
          throw new Error('not used')
        }),
        searchMagicNotes,
        createMagicNote: vi.fn(() => {
          throw new Error('not used')
        }),
        updateMagicNote: vi.fn(() => {
          throw new Error('not used')
        }),
        deleteMagicNote: vi.fn(),
        createMagicNoteEntry: vi.fn(() => {
          throw new Error('not used')
        }),
        updateMagicNoteEntry: vi.fn(() => {
          throw new Error('not used')
        }),
        deleteMagicNoteEntry: vi.fn(() => {
          throw new Error('not used')
        })
      } satisfies MagicNotesDatabase
    })
    gateways.push(gateway)
    const token = gateway.grant(
      'notes',
      [],
      new AbortController().signal,
      'read'
    )!

    expect(gateway.getAvailableToolNames(token)).toEqual([
      'note_list',
      'note_get',
      'note_search'
    ])
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

  it('keeps Ask read-only and supports revision-safe Magic Notes CRUD in Execute', async () => {
    const { service } = createService()
    const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-note-mcp-'))
    temporaryDirectories.push(directory)
    const database = new AssistantDatabase(
      join(directory, 'assistant.sqlite')
    )
    databases.push(database)
    database.initialize('C:\\Workspace')
    const gateway = new KnowledgeMcpGateway(service, {
      magicNotesDatabase: database
    })
    gateways.push(gateway)
    const readToken = gateway.grant(
      'notes-read',
      [],
      new AbortController().signal,
      'read'
    )!
    const writeToken = gateway.grant(
      'notes-write',
      [],
      new AbortController().signal,
      'write'
    )!

    expect(gateway.getAvailableToolNames(readToken)).toEqual([
      'note_list',
      'note_get',
      'note_search'
    ])
    expect(gateway.getAvailableToolNames(writeToken)).toEqual([
      'note_list',
      'note_get',
      'note_search',
      'note_create',
      'note_update',
      'note_entry_create',
      'note_entry_update',
      'note_entry_delete',
      'note_delete'
    ])
    expect(() =>
      gateway.createMagicNote(readToken, { title: '不允许创建' })
    ).toThrow('unavailable')

    const created = gateway.createMagicNote(writeToken, {
      title: '发布计划',
      content: '核对构建产物'
    })
    expect(gateway.listMagicNotes(readToken)).toEqual([
      expect.objectContaining({
        id: created.id,
        title: '发布计划',
        revision: 1,
        entryCount: 1
      })
    ])
    expect(created.entries[0]?.content).toBe('核对构建产物')
    const withEntry = gateway.createMagicNoteEntry(writeToken, {
      noteId: created.id,
      content: '通知发布负责人'
    })
    const entry = withEntry.entries[1]!
    expect(entry.content).toBe('通知发布负责人')

    const updatedEntry = gateway.updateMagicNoteEntry(writeToken, {
      entryId: entry.id,
      content: '核对六个平台构建产物',
      expectedRevision: entry.revision
    })
    expect(updatedEntry.entries[1]?.content).toBe(
      '核对六个平台构建产物'
    )
    expect(() =>
      gateway.deleteMagicNoteEntry(writeToken, {
        entryId: entry.id,
        expectedRevision: entry.revision
      })
    ).toThrow('已被更新')

    const withoutEntry = gateway.deleteMagicNoteEntry(writeToken, {
      entryId: entry.id,
      expectedRevision: updatedEntry.entries[1]!.revision
    })
    expect(withoutEntry.entries).toEqual([
      expect.objectContaining({ content: '核对构建产物' })
    ])
    expect(
      gateway.deleteMagicNote(writeToken, {
        noteId: created.id,
        expectedRevision: withoutEntry.revision
      })
    ).toEqual({ deleted: true, noteId: created.id })
    expect(() =>
      gateway.getMagicNote(readToken, { noteId: created.id })
    ).toThrow('笔记不存在')
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
