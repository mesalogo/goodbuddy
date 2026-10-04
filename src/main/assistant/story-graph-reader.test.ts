// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { AssistantDatabase } from './assistant-database'
import type { StoredSupervisionResult } from './supervisor-service'
import type { StoryGraphToolName } from '../../shared/story-graph-tools'
import { readStoryGraph } from './story-graph-reader'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
type Page = { items: Array<{ object_ref: { type: string; id: string }; result_id: string | null; event_time: string | null;
  content: string; source_reference_ids: string[]; validity: string }>; page: { next_cursor: string | null; has_more: boolean; total_count: number } }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'story-graph-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'assistant.sqlite')
  const db = new AssistantDatabase(path)
  db.initialize(root)
  cleanups.push(() => db.close())
  const sql = new DatabaseSync(path)
  cleanups.push(() => sql.close())
  const project = db.listProjects()[0]!
  const other = db.createProject({ name: 'Other', description: '', rootPath: root })
  const messageId = randomUUID(), conversationId = randomUUID()
  const body = 'Choose A. Then explicitly revise A to B because of measured latency. Option C is only a proposal. '
  const update = (content: string, projectId = project.id) => db.saveLocalConversations([{ header: { id: conversationId, projectId, title: 'Decision', updatedAt: 1 },
    messages: [{ id: messageId, role: 'user', content, createdAt: Date.parse('2026-09-01T00:00:00Z'), state: 'complete' }] }])
  update(body)
  const request: StoredSupervisionResult['request'] = { trigger: 'manual', scope: { kind: 'projects', projectIds: [project.id] },
    timeRange: { from: '2026-09-01T00:00:00Z', to: '2026-09-30T00:00:00Z' } }
  const save = (description: string, occurredAt: string, persistedId?: string) => {
    const result: StoredSupervisionResult = { request, candidates: db.listSupervisionCandidates(request), evidence: [{ id: 'quote',
      sourceType: 'conversation', sourceId: conversationId, title: 'Decision evidence', content: body,
      occurredAt: '2026-09-01T00:00:00Z', locator: { source: `message:${messageId}`, projectId: project.id, conversationId, messageId, start: 0, end: Array.from(body).length, length: Array.from(body).length } }],
      output: { summary: description, changeDigest: '', openItems: ['Execution still pending'],
        entities: [{ id: 'choice', label: 'Decision', description, sourceReferenceIds: ['quote'], ...(persistedId ? { persistedId } : {}) }],
        events: [{ title: description, description, occurredAt, eventType: 'decision', entityIds: ['choice'], sourceReferenceIds: ['quote'] }],
        entityChanges: [{ entityId: 'choice', changeType: persistedId ? 'revised' : 'proposed', description, sourceReferenceIds: ['quote'] }], relations: [] } }
    db.saveSupervisionResult(result)
    return db.listSupervisionCandidates(request)[0]!.id
  }
  const read = (name: StoryGraphToolName, input: Record<string, unknown>) => readStoryGraph(sql, name, input, project.id)
  return { db, sql, read, save, project, other, request, update, body }
}

it('retains A, explicit revision B and proposal C without latest-wins, with event-time order and complete nested pagination', async () => {
  const f = await fixture()
  const id = f.save('Decision A', '2026-09-01T00:00:00Z')
  f.save('Decision B explicitly revises A; execution pending', '2026-09-03T00:00:00Z', id)
  f.save('Decision C is an option, not a replacement', '2026-09-04T00:00:00Z', id)
  f.save('Decision late-recorded discussion', '2026-09-02T09:00:00+09:00', id)
  const input = { object_ref: { type: 'entity', id }, mode: 'timeline', page_size: 2, content_page_size: 71 }
  let cursor: string | null = null
  const fragments = new Map<string, string>()
  const eventTimes = new Map<string, string>()
  do {
    const result = f.read('story_graph_get_context', { ...input, ...(cursor ? { cursor } : {}) }) as Page
    for (const item of result.items) {
      const key = `${item.object_ref.type}:${item.object_ref.id}:${item.result_id}`
      fragments.set(key, (fragments.get(key) ?? '') + item.content)
      if (item.event_time) eventTimes.set(item.object_ref.id, item.event_time)
      expect(item.validity).toBe('unknown')
    }
    cursor = result.page.next_cursor
  } while (cursor)
  const data = [...fragments.values()].map(text => JSON.parse(text))
  expect(data.filter(item => item.canonical_label).map(item => item.description)).toEqual(expect.arrayContaining([
    'Decision A', 'Decision B explicitly revises A; execution pending', 'Decision C is an option, not a replacement'
  ]))
  expect([...eventTimes.values()]).toEqual(['2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', '2026-09-03T00:00:00.000Z', '2026-09-04T00:00:00.000Z'])
  expect(data.some(item => item.content?.includes('measured latency'))).toBe(true)
  const search = f.read('story_graph_search', { query: 'Decision', object_types: ['event'], time_range: { from: '2026-09-02T09:00:00+09:00', to: '2026-09-02T00:00:00Z' } }) as Page
  expect(search.items).toHaveLength(1)
  expect(search.items[0]!.event_time).toBe('2026-09-02T00:00:00.000Z')
})

it('enforces exact scope, rejects as_of and stale/changed cursors, and never writes during reads', async () => {
  const f = await fixture()
  const id = f.save('Decision A', '2026-09-01T00:00:00Z')
  const input = { query: 'Decision', page_size: 1 }
  const first = f.read('story_graph_search', input) as Page
  const before = f.sql.prepare('SELECT total_changes() AS n').get()!.n
  f.sql.exec('PRAGMA query_only = ON')
  expect(f.db.readStoryGraph('story_graph_search', input, f.other.id)).toMatchObject({ items: [], coverage: { status: 'unknown' } })
  // Global is the root of the one shared timeline: it sees the project's current events.
  const global = f.read('story_graph_search', { ...input, page_size: 50, scope: { kind: 'global' } }) as Page
  expect(global.items.map(item => item.object_ref.type)).toEqual(['event'])
  expect(() => f.db.readStoryGraph('story_graph_get_context', { object_ref: { type: 'entity', id } }, f.other.id)).toThrow('scope_mismatch')
  expect(() => f.read('story_graph_get_context', { object_ref: { type: 'entity', id: 'missing' } })).toThrow('object_not_found')
  expect(() => f.db.readStoryGraph('story_graph_search', input)).toThrow('scope_required')
  expect(() => f.read('story_graph_search', { ...input, as_of: '2026-09-01' })).toThrow('unsupported_mode')
  expect(() => f.read('story_graph_get_context', { object_ref: { type: 'entity', id }, mode: 'as_of' })).toThrow('unsupported_mode')
  expect(() => f.read('story_graph_search', { ...input, query: 'Other', cursor: first.page.next_cursor })).toThrow('invalid_cursor')
  expect(f.sql.prepare('SELECT total_changes() AS n').get()!.n).toBe(before)
  f.sql.exec('PRAGMA query_only = OFF')
  f.db.applySupervisionEntityAction({ entityId: id, action: 'revise', description: 'Human confirmed preference' })
  expect(() => f.read('story_graph_search', { ...input, cursor: first.page.next_cursor })).toThrow('stale_cursor')
  const abort = new AbortController(); abort.abort()
  expect(() => f.db.readStoryGraph('story_graph_search', input, f.project.id, abort.signal)).toThrow()
})

it('pages Unicode snapshots, reads explicit current versions, and reports deletion and moved scope without substituting history', async () => {
  const f = await fixture()
  f.save('Decision A', '2026-09-01T00:00:00Z')
  const source = f.sql.prepare('SELECT id FROM supervision_sources').get()!
  f.sql.prepare('UPDATE supervision_sources SET content = ? WHERE id = ?').run('A\u{1f600}B\u{1f601}C', source.id!)
  const input = { source_reference_id: source.id, page_size: 2 }
  let cursor: string | null = null, text = ''
  do {
    const page = f.read('story_graph_read_source', { ...input, ...(cursor ? { cursor } : {}) }) as { content: string; page: { next_cursor: string | null } }
    text += page.content; cursor = page.page.next_cursor
  } while (cursor)
  expect(text).toBe('A\u{1f600}B\u{1f601}C')
  const current = f.read('story_graph_read_source', { source_reference_id: source.id, content_kind: 'current' })
  expect(current.content).toBe(f.body)
  // Released incremental references can have messageId without the newer source key.
  f.sql.prepare("UPDATE supervision_sources SET locator_json = json_remove(locator_json, '$.source') WHERE id = ?").run(source.id!)
  expect(f.read('story_graph_read_source', { source_reference_id: source.id, content_kind: 'current' })).toMatchObject({ content: f.body })
  expect(f.read('story_graph_read_source', { source_reference_id: source.id, content_kind: 'version', source_version: current.source_version })).toMatchObject({ content: f.body, content_kind: 'version' })
  f.update('Changed original')
  const currentPage = f.read('story_graph_read_source', { ...input, content_kind: 'current' }) as { page: { next_cursor: string } }
  f.update('Changed again')
  expect(() => f.read('story_graph_read_source', { ...input, content_kind: 'current', cursor: currentPage.page.next_cursor })).toThrow('stale_cursor')
  expect(f.read('story_graph_read_source', { source_reference_id: source.id, content_kind: 'version', source_version: current.source_version })).toMatchObject({ error: 'historical_version_unavailable' })
  f.update('Moved original', f.other.id)
  expect(() => f.read('story_graph_read_source', { source_reference_id: source.id, content_kind: 'current' })).toThrow('scope_mismatch')
  expect(() => f.db.readStoryGraph('story_graph_read_source', { source_reference_id: source.id }, f.other.id)).toThrow('scope_mismatch')
  f.sql.exec('DELETE FROM messages')
  expect(f.read('story_graph_read_source', { source_reference_id: source.id, content_kind: 'current' })).toMatchObject({ error: 'current_source_unavailable' })
  expect(f.read('story_graph_read_source', { source_reference_id: source.id })).toMatchObject({ content: text, content_kind: 'snapshot' })
  f.sql.prepare('UPDATE supervision_sources SET source_type = ?, locator_json = ? WHERE id = ?').run('knowledge', JSON.stringify({ length: 999 }), source.id!)
  expect(f.read('story_graph_read_source', { source_reference_id: source.id })).toMatchObject({ original_source_length: 'unknown', reviewed_source_length: 999 })
  f.sql.prepare('UPDATE supervision_sources SET locator_json = ? WHERE id = ?').run(JSON.stringify({ detail: 'x'.repeat(100_001) }), source.id!)
  expect(() => f.read('story_graph_read_source', { source_reference_id: source.id })).toThrow('response_too_large')
})

it('prefilters story lines by scope in SQL with the exact normalized match, and caps the scanned objects', async () => {
  const f = await fixture()
  f.save('Decision A', '2026-09-01T00:00:00Z')
  const insert = f.sql.prepare('INSERT INTO story_lines (id, scope_json, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
  const now = '2026-09-01T00:00:00.000Z'
  // Unsorted / duplicate ids still normalize to the requested scope; supersets and other kinds do not.
  insert.run('dup', JSON.stringify({ kind: 'projects', projectIds: [f.project.id, f.project.id] }), 'Decision dup', now, now)
  insert.run('superset', JSON.stringify({ kind: 'projects', projectIds: [f.other.id, f.project.id] }), 'Decision superset', now, now)
  insert.run('global', JSON.stringify({ kind: 'global' }), 'Decision global', now, now)
  const lines = (scope?: unknown) => ((f.read('story_graph_search', { query: 'Decision', page_size: 50, object_types: ['story_line'], ...(scope ? { scope } : {}) }) as Page)
    .items.map(item => item.object_ref.id)).sort()
  const all = f.sql.prepare('SELECT id FROM story_lines').all().map(row => String(row.id))
  expect(lines()).toEqual(expect.arrayContaining(['dup']))
  expect(lines()).not.toContain('superset')
  expect(lines()).not.toContain('global')
  expect(lines({ kind: 'global' })).toEqual(['global'])
  expect(lines({ kind: 'projects', projectIds: [f.project.id, f.other.id] })).toEqual(['superset'])
  expect(all.length).toBeGreaterThanOrEqual(4)
  expect(() => readStoryGraph(f.sql, 'story_graph_search', { query: 'Decision' }, f.project.id, undefined, 2)).toThrow('scan_limit_exceeded')
  expect(readStoryGraph(f.sql, 'story_graph_search', { query: 'Decision' }, f.project.id)).toMatchObject({ page: { complete: true } })
})
