// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Worker } from 'node:worker_threads'
import { AssistantDatabase } from './assistant/assistant-database'
import { KnowledgeDatabase } from './knowledge/knowledge-database'
import { ReadonlyQueryReader, ReadonlyWorkerUnavailableError, type ReadonlyQueryKind } from './readonly-query-reader'

const readers = new Set<ReadonlyQueryReader>()
function createReader(kind: ReadonlyQueryKind, path: string): ReadonlyQueryReader {
  const reader = new ReadonlyQueryReader(kind, path, workerPath)
  readers.add(reader)
  return reader
}
afterEach(async () => { await Promise.all([...readers].map(reader => reader.close())); readers.clear() })

let directory: string
let workerPath: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'goodbuddy-readonly-reader-'))
  workerPath = join(directory, 'readonly-query-worker.cjs')
  await build({ entryPoints: [resolve('src/main/readonly-query-worker.ts')], outfile: workerPath,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
}, 60_000)
afterAll(async () => { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })

const checksum = (value: string): string => createHash('sha256').update(value).digest('hex')

function seedKnowledge(path: string): { database: KnowledgeDatabase; libraryId: string; query: number[] } {
  const database = new KnowledgeDatabase(path)
  database.initialize()
  const library = database.createKnowledgeBase({ name: 'Worker parity', storageMode: 'reference' })
  let seed = 7
  const random = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  const words = 'lighthouse harbor budget latency 发布 审批 流程 跨平台 桌面 vector'.split(' ')
  const sqlite = (database as unknown as { database: import('node:sqlite').DatabaseSync }).database
  for (let documentIndex = 0; documentIndex < 6; documentIndex += 1) {
    const source = database.upsertSource({ knowledgeBaseId: library.id, type: 'file',
      location: `C:\\parity\\doc-${documentIndex}.md`, displayName: `doc-${documentIndex}.md`, status: 'ready' })
    const chunks = Array.from({ length: 30 }, (_, ordinal) => ({ id: `d${documentIndex}-c${ordinal}`, ordinal,
      content: Array.from({ length: 24 }, () => words[Math.floor(random() * words.length)]).join(' '), location: `line ${ordinal}` }))
    const document = database.upsertDocument({ knowledgeBaseId: library.id, sourceId: source.id,
      externalId: `doc-${documentIndex}`, title: `doc-${documentIndex}`, sourceLocation: source.location }, chunks)
    const stored = sqlite.prepare("SELECT id, index_content FROM chunks WHERE document_id = ? AND enabled = 1 AND role <> 'parent'")
      .all(document.id) as Array<{ id: string; index_content: string }>
    database.replaceDocumentEmbeddings(document.id, 'p', 'm', stored.map(row => ({ chunkId: row.id,
      // Duplicate vectors exercise the tie-break on chunk id.
      contentChecksum: checksum(row.index_content), vector: row.id.endsWith('-c3') ? [1, 0, 0, 0] : [random() - 0.5, random() - 0.5, random() - 0.5, random() - 0.5] })))
  }
  return { database, libraryId: library.id, query: [0.9, 0.1, -0.2, 0.05] }
}

describe('knowledge search worker', () => {
  it('returns exactly the synchronous results, order and scores', async () => {
    const path = join(directory, `knowledge-${randomUUID()}.sqlite`)
    const { database, libraryId, query } = seedKnowledge(path)
    const reader = createReader('knowledge', path)
    try {
      const cases = [
        { knowledgeBaseId: libraryId, query: 'lighthouse budget', limit: 40, provider: 'p', model: 'm', vector: query, graphEnabled: false, candidateMultiplier: 1 },
        { knowledgeBaseId: libraryId, query: '发布审批流程', limit: 20, provider: 'p', model: 'm', vector: query, minimumVectorSimilarity: 0.1 },
        { knowledgeBaseId: libraryId, query: 'harbor', limit: 5, ftsWeight: 0 , provider: 'p', model: 'm', vector: query },
        { knowledgeBaseId: libraryId, query: 'latency', limit: 10 }
      ]
      const expected = cases.map(options => database.hybridSearchWithDiagnostics(options))
      const expectedFts = database.search({ knowledgeBaseId: libraryId, query: '跨平台 vector', limit: 30 })
      const actual = await Promise.all(cases.map(options => reader.call<ReturnType<KnowledgeDatabase['hybridSearchWithDiagnostics']>>('hybridSearchWithDiagnostics', [options])))
      expect(reader.pendingCount).toBe(0)
      expect(actual).toEqual(expected)
      expect(actual[0]!.results.length).toBeGreaterThan(10)
      expect(actual[0]!.vectorScannedCount).toBe(180)
      expect(await reader.call('search', [{ knowledgeBaseId: libraryId, query: '跨平台 vector', limit: 30 }])).toEqual(expectedFts)
      // Validation errors keep their type and message across the thread boundary.
      await expect(reader.call('hybridSearchWithDiagnostics', [{ ...cases[0]!, limit: 500 }])).rejects.toThrow(RangeError)
      // A write committed on Main is visible to the next worker read.
      database.updateKnowledgeBase(libraryId, { name: 'Renamed' })
      const source = database.upsertSource({ knowledgeBaseId: libraryId, type: 'file', location: 'C:\\parity\\new.md', displayName: 'new.md', status: 'ready' })
      database.upsertDocument({ knowledgeBaseId: libraryId, sourceId: source.id, externalId: 'new', title: 'new', sourceLocation: source.location },
        [{ id: 'fresh-chunk', ordinal: 0, content: 'zebracorn unique', location: 'l' }])
      expect((await reader.call<ReturnType<KnowledgeDatabase['search']>>('search', [{ knowledgeBaseId: libraryId, query: 'zebracorn' }])).map(item => item.chunk.id)).toEqual(['fresh-chunk'])
    } finally { database.close() }
  }, 60_000)

  it('cancels through the AbortSignal and keeps serving later requests', async () => {
    const path = join(directory, `knowledge-${randomUUID()}.sqlite`)
    const { database, libraryId, query } = seedKnowledge(path)
    const reader = createReader('knowledge', path)
    try {
      const options = { knowledgeBaseId: libraryId, query: 'harbor', provider: 'p', model: 'm', vector: query }
      const preAborted = new AbortController()
      preAborted.abort(new Error('cancelled before'))
      await expect(reader.call('hybridSearchWithDiagnostics', [options], preAborted.signal)).rejects.toThrow('cancelled before')
      const controller = new AbortController()
      const pending = reader.call('hybridSearchWithDiagnostics', [options], controller.signal)
      controller.abort(new Error('cancelled during'))
      await expect(pending).rejects.toThrow('cancelled during')
      expect(reader.pendingCount).toBe(0)
      expect(await reader.call('hybridSearchWithDiagnostics', [options])).toEqual(database.hybridSearchWithDiagnostics(options))
    } finally { database.close() }
  }, 60_000)

  it('rejects on worker loss without SQL fallback and restarts for a later explicit read', async () => {
    const path = join(directory, `knowledge-${randomUUID()}.sqlite`)
    const { database, libraryId, query } = seedKnowledge(path)
    const reader = createReader('knowledge', path)
    try {
      const options = { knowledgeBaseId: libraryId, query: 'budget', provider: 'p', model: 'm', vector: query }
      const expected = database.hybridSearchWithDiagnostics(options)
      expect(await reader.call('hybridSearchWithDiagnostics', [options])).toEqual(expected)
      const inFlight = reader.call('hybridSearchWithDiagnostics', [options])
      const failure = expect(inFlight).rejects.toBeInstanceOf(ReadonlyWorkerUnavailableError)
      await reader.terminateWorkerForTest()
      await failure
      expect(reader.available).toBe(false)
      await expect(reader.call('hybridSearchWithDiagnostics', [options])).rejects.toThrow('backing off')
      reader.resetBackoffForTest()
      expect(reader.available).toBe(true)
      expect(await reader.call('hybridSearchWithDiagnostics', [options])).toEqual(expected)
    } finally { database.close() }
  }, 60_000)

  it('uses owner-local SQL explicitly for memory databases and rejects reader startup failures', async () => {
    const memory = new KnowledgeDatabase(':memory:')
    memory.initialize()
    try {
      const library = memory.createKnowledgeBase({ name: 'Memory', storageMode: 'reference' })
      expect(memory.search({ knowledgeBaseId: library.id, query: 'x' })).toEqual([])
    } finally { memory.close() }
    const missing = new ReadonlyQueryReader('knowledge', join(directory, 'missing.sqlite'), workerPath)
    try {
      await expect(missing.call('search', [{}])).rejects.toBeInstanceOf(ReadonlyWorkerUnavailableError)
      await expect(missing.call('search', [{}])).rejects.toThrow('backing off')
    } finally { await missing.close() }
  }, 60_000)
})

/** The previous per-conversation JS implementation, kept as the semantic reference. */
function referenceSearch(database: AssistantDatabase, query: string): string[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return []
  const sqlite = (database as unknown as { database: import('node:sqlite').DatabaseSync }).database
  const rows = sqlite.prepare(`SELECT id, title FROM conversations WHERE status = 'active' ORDER BY pinned DESC, updated_at DESC`).all() as Array<{ id: string; title: string }>
  const messages = sqlite.prepare('SELECT content FROM messages WHERE conversation_id = ?')
  return rows.filter(row => row.title.toLocaleLowerCase().includes(normalized) ||
    (messages.all(row.id) as Array<{ content: string }>).some(message => message.content.toLocaleLowerCase().includes(normalized)))
    .map(row => row.id)
}

describe('assistant readonly worker', () => {
  it('matches the reference conversation search, including Unicode case folding and CJK, on Main and in the worker', async () => {
    const root = await mkdtemp(join(directory, 'assistant-'))
    const database = new AssistantDatabase(join(root, 'assistant.sqlite'))
    database.initialize(root)
    try {
      const texts = ['ÄPFEL und Birnen', 'straße STRASSE', 'İstanbul ısı', 'ΣΊΣΥΦΟΣ', '跨平台桌面应用发布审批', '100%_literal\\x', 'Ǆemal ǅ', 'plain body', '']
      const conversations = texts.map((text, index) => ({
        id: randomUUID(), title: index % 3 === 0 ? `Title ${text}` : `Conversation ${index}`, updatedAt: index + 1, pinned: index === 4,
        messages: [{ id: randomUUID(), role: 'user' as const, state: 'complete' as const, content: text, createdAt: index * 10 },
          { id: randomUUID(), role: 'assistant' as const, state: 'complete' as const, content: `reply ${index}`, createdAt: index * 10 + 1 }]
      }))
      database.replaceConversations(conversations)
      const queries = ['äpfel', 'ÄPFEL', 'Äp', 'STRASSE', 'straße', 'İstanbul', 'i̇stanbul', 'ISI', 'σίσυφος', 'ΣΊΣΥΦΟΣ', '平台桌面', '审批',
        '%_', '100%', '_', '\\x', 'ǆ', 'Ǆemal', 'reply 1', 'REPLY', 'title', 'conversation 7', '  plain  ', 'missing', ' ']
      const expected = queries.map(query => referenceSearch(database, query))
      expect(expected.some(ids => ids.length > 1)).toBe(true)
      expect(queries.map(query => database.searchConversations(query))).toEqual(expected)
      const reader = createReader('assistant', join(root, 'assistant.sqlite'))
      expect(await Promise.all(queries.map(query => reader.call('searchConversations', [query])))).toEqual(expected)
      expect(reader.pendingCount).toBe(0)
    } finally { database.close() }
  }, 60_000)

  it('lists conversations with batched queries matching per-conversation reads', async () => {
    const root = await mkdtemp(join(directory, 'assistant-'))
    const database = new AssistantDatabase(join(root, 'assistant.sqlite'))
    database.initialize(root)
    try {
      const message = (content: string, createdAt: number, state: 'complete' | 'streaming' = 'complete', role: 'user' | 'assistant' = 'assistant') =>
        ({ id: randomUUID(), role, state, content, createdAt })
      const conversations = [
        { id: randomUUID(), title: 'Empty', updatedAt: 1, messages: [] },
        { id: randomUUID(), title: 'Streaming', updatedAt: 2, messages: [message('q', 1, 'complete', 'user'), message('partial', 2, 'streaming')] },
        { id: randomUUID(), title: 'Done', updatedAt: 3, messages: [message('q', 5, 'complete', 'user'), message('a', 9), message('b', 7)] },
        { id: randomUUID(), title: 'Single', updatedAt: 0, messages: [message('x', 3)] }
      ]
      database.replaceConversations(conversations)
      const full = database.listConversations()
      expect(full).toHaveLength(4)
      for (const item of full) expect(item).toEqual(database.getConversation(item.id))
      const summaries = database.listConversationSummaries([conversations[2]!.id])
      const byId = new Map(summaries.map(item => [item.id, item]))
      expect(byId.get(conversations[2]!.id)).toEqual(database.getConversation(conversations[2]!.id))
      // Streaming histories are loaded only when explicitly requested.
      expect(byId.get(conversations[1]!.id)?.messages).toEqual([])
      expect(byId.get(conversations[1]!.id)?.messageSummary).toEqual({ count: 2, firstRole: 'user', latestMessageAt: 2 })
      expect(database.listConversationSummaries([conversations[1]!.id])
        .find(item => item.id === conversations[1]!.id)).toEqual(database.getConversation(conversations[1]!.id))
      expect(byId.get(conversations[0]!.id)?.messageSummary).toEqual({ count: 0, firstRole: undefined, latestMessageAt: undefined })
      expect(byId.get(conversations[3]!.id)?.messageSummary).toEqual({ count: 1, firstRole: 'assistant', latestMessageAt: 3 })
      expect(byId.get(conversations[3]!.id)?.messages).toEqual([])
    } finally { database.close() }
  }, 60_000)

  it('serves conversation summaries and full history from the worker with the synchronous results', async () => {
    const root = await mkdtemp(join(directory, 'assistant-'))
    const database = new AssistantDatabase(join(root, 'assistant.sqlite'))
    database.initialize(root)
    try {
      const project = database.listProjects()[0]!
      const message = (content: string, createdAt: number, state: 'complete' | 'streaming' = 'complete', role: 'user' | 'assistant' = 'assistant') =>
        ({ id: randomUUID(), role, state, content, createdAt })
      const conversations = Array.from({ length: 12 }, (_, index) => ({
        id: randomUUID(), projectId: index % 2 === 0 ? project.id : undefined, title: `Conversation ${index}`,
        updatedAt: 100 - index, pinned: index === 7,
        messages: index === 0 ? [] : Array.from({ length: index }, (_, at) =>
          message(`m${index}-${at} 跨平台`, index * 10 + at, index === 5 && at === index - 1 ? 'streaming' : 'complete', at === 0 ? 'user' : 'assistant'))
      }))
      database.replaceConversations(conversations)
      const detailSets = [[], [conversations[3]!.id], conversations.map(item => item.id), [randomUUID()]]
      const expected = detailSets.map(ids => database.listConversationSummaries(ids))
      const expectedFull = conversations.map(item => database.getConversation(item.id))
      // Only explicitly retained histories carry messages, including during streaming.
      expect(expected[0]!.find(item => item.id === conversations[4]!.id)?.messageSummary).toEqual({ count: 4, firstRole: 'user', latestMessageAt: 43 })
      expect(expected[0]!.find(item => item.id === conversations[5]!.id)?.messages).toHaveLength(0)
      expect(expected[0]!.find(item => item.id === conversations[5]!.id)?.messageSummary?.count).toBe(5)
      expect(expected[1]!.find(item => item.id === conversations[3]!.id)).toEqual(expectedFull[3])

      const reader = createReader('assistant', join(root, 'assistant.sqlite'))
      expect(await Promise.all(detailSets.map(ids => reader.call('listConversationSummaries', [ids])))).toEqual(expected)
      expect(await Promise.all(conversations.map(item => reader.call('getConversation', [item.id])))).toEqual(expectedFull)
      expect(reader.pendingCount).toBe(0)
      // Missing conversations reject with the synchronous error.
      await expect(reader.call('getConversation', [randomUUID()])).rejects.toThrow('对话不存在')

      // Read after write: a synchronous write on Main is visible to the next worker read.
      database.saveLocalConversations([{ header: { id: conversations[1]!.id, title: 'Renamed', updatedAt: 500 },
        messages: [message('fresh', 999)] }])
      const afterWrite = await reader.call<ReturnType<AssistantDatabase['listConversationSummaries']>>('listConversationSummaries', [[]])
      expect(afterWrite).toEqual(database.listConversationSummaries([]))
      expect(afterWrite[0]!.title).toBe('Renamed')
      expect(await reader.call('getConversation', [conversations[1]!.id])).toEqual(database.getConversation(conversations[1]!.id))

      // Inside an open transaction the synchronous path keeps read-your-writes.
      const raw = (database as unknown as { database: import('node:sqlite').DatabaseSync }).database
      raw.exec('BEGIN IMMEDIATE')
      try {
        raw.prepare('UPDATE conversations SET title = ? WHERE id = ?').run('Uncommitted', conversations[2]!.id)
        expect(database.getConversation(conversations[2]!.id).title).toBe('Uncommitted')
      } finally { raw.exec('ROLLBACK') }

      const inFlight = reader.call('listConversationSummaries', [[conversations[3]!.id]])
      await reader.terminateWorkerForTest()
      // A fast worker may commit the response before termination; the
      // dedicated crash tests cover rejection when failure wins the race.
      await expect(inFlight).resolves.toEqual([expected[3]![0]])
    } finally { database.close() }
  }, 60_000)

  it('serves story graph reads from the worker with the synchronous result and errors', async () => {
    const root = await mkdtemp(join(directory, 'assistant-'))
    const database = new AssistantDatabase(join(root, 'assistant.sqlite'))
    database.initialize(root)
    try {
      const project = database.listProjects()[0]!
      const other = database.createProject({ name: 'Other', description: '', rootPath: root })
      const conversationId = randomUUID(), messageId = randomUUID()
      const body = 'Choose A, then revise A to B because of measured latency.'
      database.saveLocalConversations([{ header: { id: conversationId, projectId: project.id, title: 'Decision', updatedAt: 1 },
        messages: [{ id: messageId, role: 'user', content: body, createdAt: Date.parse('2026-09-01T00:00:00Z'), state: 'complete' }] }])
      const request = { trigger: 'manual' as const, scope: { kind: 'projects' as const, projectIds: [project.id] },
        timeRange: { from: '2026-09-01T00:00:00Z', to: '2026-09-30T00:00:00Z' } }
      database.saveSupervisionResult({ request, candidates: database.listSupervisionCandidates(request),
        evidence: [{ id: 'quote', sourceType: 'conversation', sourceId: conversationId, title: 'Decision evidence', content: body,
          occurredAt: '2026-09-01T00:00:00Z', locator: { source: `message:${messageId}`, projectId: project.id, conversationId, messageId, start: 0, end: body.length, length: body.length } }],
        output: { summary: 'Decision A', changeDigest: '', openItems: [], relations: [],
          entities: [{ id: 'choice', label: 'Decision', description: 'Decision A', sourceReferenceIds: ['quote'] }],
          events: [{ title: 'Decision A', description: 'Decision A', occurredAt: '2026-09-01T00:00:00Z', eventType: 'decision', entityIds: ['choice'], sourceReferenceIds: ['quote'] }],
          entityChanges: [{ entityId: 'choice', changeType: 'proposed', description: 'Decision A', sourceReferenceIds: ['quote'] }] } })
      const withoutReadAt = (value: Record<string, unknown>): Record<string, unknown> => ({ ...value, read_at: undefined })
      const inputs = [
        { query: 'Decision', page_size: 50 },
        { query: 'decision latency', page_size: 2 },
        { query: 'Decision', page_size: 50, scope: { kind: 'global' } }
      ]
      const expected = inputs.map(input => withoutReadAt(database.readStoryGraph('story_graph_search', input, project.id)))
      expect((expected[0]!.items as unknown[]).length).toBeGreaterThan(2)
      const reader = createReader('assistant', join(root, 'assistant.sqlite'))
      const actual = await Promise.all(inputs.map(input => reader.call<Record<string, unknown>>('readStoryGraph', ['story_graph_search', input, project.id])))
      expect(actual.map(withoutReadAt)).toEqual(expected)
      const entity = (expected[0]!.items as Array<{ object_ref: { type: string; id: string } }>).find(item => item.object_ref.type === 'entity')!
      const contextInput = { object_ref: entity.object_ref, mode: 'timeline', page_size: 5 }
      expect(withoutReadAt(await reader.call('readStoryGraph', ['story_graph_get_context', contextInput, project.id])))
        .toEqual(withoutReadAt(database.readStoryGraph('story_graph_get_context', contextInput, project.id)))
      await expect(reader.call('readStoryGraph', ['story_graph_get_context', contextInput, other.id])).rejects.toThrow('scope_mismatch')
      await expect(reader.call('readStoryGraph', ['story_graph_search', { query: 'x' }])).rejects.toThrow('scope_required')
      // Schema validation errors stay ZodErrors so MCP callers classify them unchanged.
      await expect(reader.call('readStoryGraph', ['story_graph_search', { query: 1 }, project.id])).rejects.toMatchObject({ name: 'ZodError' })
      const aborted = new AbortController(); aborted.abort(new Error('stop'))
      await expect(reader.call('readStoryGraph', ['story_graph_search', inputs[0], project.id], aborted.signal)).rejects.toThrow('stop')
      expect(reader.pendingCount).toBe(0)
    } finally { database.close() }
  }, 60_000)
})

describe('WAL checkpoint worker', () => {
  it('checkpoints on the owner-managed entry and confirms exit before closing the database', async () => {
    const path = join(directory, `checkpoint-${randomUUID()}.sqlite`)
    const database = new AssistantDatabase(path)
    database.initialize(directory)
    const raw = (database as unknown as { database: import('node:sqlite').DatabaseSync }).database
    const autocheckpoint = (): number =>
      (raw.prepare('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number }).wal_autocheckpoint
    const worker = new Worker(workerPath, { workerData: { kind: 'checkpoint', databasePath: path, intervalMs: 20 } })
    const exited = new Promise<void>(resolve => worker.once('exit', () => resolve()))
    try {
      expect(autocheckpoint()).toBe(1000)
      await new Promise<void>((resolve, reject) => { worker.once('message', () => resolve()); worker.once('error', reject) })
      raw.exec('PRAGMA wal_autocheckpoint = 0')
      const task = database.createTask({ id: randomUUID(), title: 't', instructions: 'i' })
      const sizeBefore = statSync(path).size
      for (let index = 0; index < 300; index += 1) {
        database.appendTaskEvent(task.id, 'text', { type: 'text', requestId: task.id, delta: 'x'.repeat(4_000) })
      }
      // With automatic checkpoints disabled in this fixture, only the worker
      // can copy these committed frames into the database file.
      await expect.poll(() => statSync(path).size, { timeout: 10_000 }).toBeGreaterThan(sizeBefore + 1_000_000)
      expect((raw.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'text'").get(task.id) as { n: number }).n).toBe(300)
    } finally {
      worker.postMessage({ type: 'close' })
      await exited
      database.close()
    }
    // A reopened database starts with SQLite's default threshold again.
    const reopened = new AssistantDatabase(path)
    reopened.initialize(directory)
    try {
      const again = (reopened as unknown as { database: import('node:sqlite').DatabaseSync }).database
      expect((again.prepare('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number }).wal_autocheckpoint).toBe(1000)
    } finally { reopened.close() }
  }, 60_000)
})
