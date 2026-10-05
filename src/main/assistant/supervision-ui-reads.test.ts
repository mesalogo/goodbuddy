// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { AssistantDatabase, ASSISTANT_DATABASE_SCHEMA_VERSION } from './assistant-database'
import { getPendingAssistantStorageUpgrade, upgradeAssistantStorage } from './assistant-storage-upgrade'
import { supervisionReviewSettingsSchema } from '../../shared/supervision-review-contracts'
import type { SupervisionSummaryOutput } from '../../shared/supervision-contracts'

let directory: string, workerPath: string
const cleanups: Array<() => void> = []
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'supervision-ui-reads-'))
  workerPath = join(directory, 'worker.cjs')
  await build({ entryPoints: [resolve('src/main/readonly-query-worker.ts')], outfile: workerPath,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
}, 60_000)
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanups.splice(0)) close() })
afterAll(async () => { await rm(directory, { recursive: true, force: true, maxRetries: 10 }) })

const at = '2026-10-01T12:00:00.000Z'
const request = { trigger: 'manual' as const, scope: { kind: 'global' as const }, timeRange: { from: at, to: at } }
const empty: SupervisionSummaryOutput = { summary: 'Review', changeDigest: '', openItems: [], events: [], entities: [], entityChanges: [], relations: [] }

function fixture() {
  const path = join(directory, `${randomUUID()}.sqlite`)
  const db = new AssistantDatabase(path)
  db.initialize(directory)
  const sql = (db as unknown as { database: DatabaseSync }).database
  cleanups.push(() => db.close())
  const project = db.listProjects()[0]!
  const other = db.createProject({ name: 'Other', description: '', rootPath: directory })
  db.saveSupervisionResult({ request,
    evidence: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, sourceType: 'conversation' as const, sourceId: 'conversation',
      title: `Source ${i}`, content: `Full source ${i} ${'body'.repeat(2000)}`, occurredAt: at,
      locator: { projectId: i < 3 ? project.id : other.id } })),
    output: { ...empty, events: Array.from({ length: 6 }, (_, i) => ({ title: `Event ${i}`, description: 'Description', occurredAt: at,
      eventType: 'decision' as const, sourceReferenceIds: [`s${i}`], entityIds: [] })) } })
  const result = db.listSupervisionResults()[0]!
  const events = sql.prepare('SELECT id, project_id FROM supervision_events ORDER BY title').all()
  for (const [i, event] of events.entries()) {
    sql.prepare(`INSERT INTO supervision_stories (id, project_id, level, name, created_at, updated_at)
      VALUES (?, ?, 'feature', ?, ?, ?)`).run(`story${i}`, String(event.project_id), `Story ${i}`, at, at)
    sql.prepare('INSERT INTO supervision_event_stories (event_id, story_id, is_primary) VALUES (?, ?, 1)').run(String(event.id), `story${i}`)
    sql.prepare('INSERT INTO supervision_experiences (id, statement, created_at, updated_at) VALUES (?, ?, ?, ?)').run(`experience${i}`, `Experience ${i}`, at, at)
    sql.prepare("INSERT INTO supervision_experience_events (experience_id, event_id, role) VALUES (?, ?, 'formed')").run(`experience${i}`, String(event.id))
  }
  // A cross-project experience must retain all links, not only the selected project's links.
  sql.prepare("INSERT INTO supervision_experience_events (experience_id, event_id, role) VALUES ('experience0', ?, 'applied')").run(String(events[3]!.id))
  return { db, sql, path, project, other, result, events }
}

it('returns source headers only in both graph paths while retaining full source detail and source order', () => {
  const f = fixture()
  const expected = f.sql.prepare('SELECT id, title, occurred_at FROM supervision_sources ORDER BY rowid').all()
  for (const input of [{ resultId: f.result.id }, { storyLineId: f.result.storyLineId! }]) {
    expect(f.db.getSupervisionGraph(input).sources).toEqual(expected)
  }
  for (const source of expected) expect(f.db.getSupervisionSource(String(source.id))?.content).toBe(`Full source ${String(source.title).slice(-1)} ${'body'.repeat(2000)}`)
})

it('reads story memberships and scoped experiences in a constant number of SQL statements', () => {
  const f = fixture()
  let queries = 0
  const prepare = f.sql.prepare.bind(f.sql)
  vi.spyOn(f.sql, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql)
    const all = statement.all.bind(statement)
    vi.spyOn(statement, 'all').mockImplementation((...args) => { queries++; return all(...args) })
    return statement
  })
  const stories = f.db.supervisionStories().list({ kind: 'global' })
  expect(stories.map(story => [story.name, story.events.map(event => event.title)])).toEqual(
    Array.from({ length: 6 }, (_, i) => [`Story ${i}`, [`Event ${i}`]]))
  expect(queries).toBe(2)
  queries = 0
  const experiences = f.db.supervisionExperiences().list([f.other.id])
  expect(experiences.map(item => item.statement)).toEqual(['Experience 0', 'Experience 3', 'Experience 4', 'Experience 5'])
  expect(experiences[0]!.events.map(event => [event.title, event.role, event.storyName])).toEqual(
    [0, 3].sort((a, b) => String(f.events[a]!.id).localeCompare(String(f.events[b]!.id))).map(i => [`Event ${i}`, i ? 'applied' : 'formed', `Story ${i}`]))
  expect(queries).toBe(2)
  queries = 0
  expect(f.db.supervisionExperiences().list(['unrelated'])).toEqual([])
  expect(queries).toBe(1)
})

it('serves UI reads on the real worker and observes writes committed before the next read', async () => {
  const f = fixture()
  const overview = f.db.listSupervisionResults()
  const graph = f.db.getSupervisionGraph({ resultId: f.result.id })
  const stories = { stories: f.db.supervisionStories().list(request.scope), experiences: f.db.supervisionExperiences().list(),
    unassigned: f.db.supervisionStories().unassignedCount(request.scope), canUndo: false }
  f.db.enableReadonlyWorker(workerPath)
  const syncOverview = vi.spyOn(f.db, 'listSupervisionResults').mockImplementation(() => { throw new Error('Main overview') })
  const syncGraph = vi.spyOn(f.db, 'getSupervisionGraph').mockImplementation(() => { throw new Error('Main graph') })
  const syncStories = vi.spyOn(f.db, 'supervisionStories').mockImplementation(() => { throw new Error('Main stories') })
  expect(await f.db.listSupervisionResultsAsync()).toEqual(overview)
  expect(await f.db.getSupervisionGraphAsync({ resultId: f.result.id })).toEqual(graph)
  expect(await f.db.getSupervisionStoriesAsync(request.scope)).toEqual(stories)
  f.sql.prepare('UPDATE supervision_results SET summary = ? WHERE id = ?').run('Committed', f.result.id)
  expect((await f.db.listSupervisionResultsAsync())[0]!.summary).toBe('Committed')
  await expect(f.db.getSupervisionGraphAsync({ resultId: f.result.id, storyLineId: 'wrong' })).rejects.toThrow('不匹配')
  await f.db.readonlyWorkerForTest!.terminateWorkerForTest()
  await expect(f.db.listSupervisionResultsAsync()).rejects.toThrow('backing off')
  await expect(f.db.getSupervisionGraphAsync({ resultId: f.result.id })).rejects.toThrow('backing off')
  await expect(f.db.getSupervisionStoriesAsync(request.scope)).rejects.toThrow('backing off')
  expect(syncOverview).not.toHaveBeenCalled()
  expect(syncGraph).not.toHaveBeenCalled()
  expect(syncStories).not.toHaveBeenCalled()
})

it('rejects missing production worker configuration instead of performing a synchronous UI read', async () => {
  const f = fixture()
  await expect(f.db.listSupervisionResultsAsync()).rejects.toThrow('worker is not configured')
  await expect(f.db.getSupervisionGraphAsync({ resultId: f.result.id })).rejects.toThrow('worker is not configured')
  await expect(f.db.getSupervisionStoriesAsync(request.scope)).rejects.toThrow('worker is not configured')
  f.db.enableReadonlyWorker(join(directory, 'missing.cjs'))
  await expect(f.db.listSupervisionResultsAsync()).rejects.toThrow()
})

it('keeps a multi-statement UI read on one WAL snapshot while another connection commits', () => {
  const f = fixture()
  const reader = new AssistantDatabase(f.path)
  reader.openReadOnly()
  cleanups.push(() => reader.close())
  reader.readSnapshot(() => {
    expect(reader.listSupervisionResults()[0]!.summary).toBe('Review')
    f.sql.prepare('UPDATE supervision_results SET summary = ? WHERE id = ?').run('New summary', f.result.id)
    f.sql.prepare("UPDATE supervision_stories SET name = 'Renamed' WHERE id = 'story0'").run()
    expect(reader.listSupervisionResults()[0]!.summary).toBe('Review')
    expect(reader.getSupervisionStories(request.scope).stories[0]!.name).toBe('Story 0')
  })
  expect(reader.listSupervisionResults()[0]!.summary).toBe('New summary')
  expect(reader.getSupervisionStories(request.scope).stories.some(story => story.name === 'Renamed')).toBe(true)
})

it('upgrades schema 61 indexes without changing rows, rowids, source order or reclaiming free pages', () => {
  const f = fixture()
  const tables = f.sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  const contents = () => tables.map(row => [row.name, f.sql.prepare(`SELECT rowid, * FROM "${row.name}" ORDER BY rowid`).all()])
  const before = contents()
  const sources = f.db.getSupervisionGraph({ resultId: f.result.id }).sources
  f.sql.exec(`DROP INDEX IF EXISTS supervision_sources_result;
    DROP INDEX IF EXISTS supervision_results_created;
    CREATE TABLE disposable (body BLOB); INSERT INTO disposable VALUES (zeroblob(1048576)); DROP TABLE disposable;
    PRAGMA user_version = 61`)
  expect(f.sql.prepare('PRAGMA freelist_count').get()!.freelist_count).toBeGreaterThan(0)
  f.db.close()
  expect(getPendingAssistantStorageUpgrade(f.path)).toEqual({ migrateNotes: false, reclaimSpace: false })
  const progress = vi.fn()
  upgradeAssistantStorage(f.path, progress)
  const reopened = new AssistantDatabase(f.path)
  reopened.openReadOnly()
  cleanups.push(() => reopened.close())
  const sql = (reopened as unknown as { database: DatabaseSync }).database
  expect(tables.map(row => [row.name, sql.prepare(`SELECT rowid, * FROM "${row.name}" ORDER BY rowid`).all()])).toEqual(before)
  expect(sql.prepare('PRAGMA user_version').get()!.user_version).toBe(ASSISTANT_DATABASE_SCHEMA_VERSION)
  expect(sql.prepare("SELECT name FROM sqlite_master WHERE name IN ('supervision_sources_result', 'supervision_results_created') ORDER BY name").all())
    .toEqual([{ name: 'supervision_results_created' }, { name: 'supervision_sources_result' }])
  expect(reopened.getSupervisionGraph({ resultId: f.result.id }).sources).toEqual(sources)
  expect(sql.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  expect(progress.mock.calls.some(([value]) => value.stage === 'compacting' || value.stage === 'converting')).toBe(false)
  expect(getPendingAssistantStorageUpgrade(f.path)).toBeUndefined()
  upgradeAssistantStorage(f.path, progress)
})

it('publishes one final snapshot for multiple leaves and rolls back results and checkpoints together', () => {
  const f = fixture()
  const runId = f.db.startSupervisionRun(request)
  const store = f.db.supervisionReviewStore()
  f.db.saveLocalConversations([{ header: { id: 'conversation', projectId: f.project.id, title: 'Synthetic', updatedAt: Date.parse(at) },
    messages: [0, 1].map(i => ({ id: `source${i}`, role: 'user', state: 'complete', content: 'body', createdAt: Date.parse(at) })) }])
  store.initialize(runId, { request, config: { ...supervisionReviewSettingsSchema.parse({}), version: 1, concurrency: 1, timeoutSeconds: 30 }, phase: 'saving' })
  for (let i = 0; i < 2; i++) {
    const source = f.sql.prepare('SELECT source, revision FROM supervision_review_sources WHERE run_id = ? AND source = ?').get(runId, `message:source${i}`)!
    store.save(runId, f.project.id, 'conversation', [{ id: 'source', sourceType: 'conversation', sourceId: 'conversation', title: `Leaf ${i}`, content: 'body', occurredAt: at,
      locator: { source: String(source.source), revision: String(source.revision), start: 0, end: 4, projectId: f.project.id } }],
    { ...empty, entities: [{ id: 'entity', label: `Entity ${i}`, description: 'Original', sourceReferenceIds: ['source'] }] })
  }
  f.sql.exec(`CREATE TRIGGER snapshot_once BEFORE UPDATE OF graph_snapshot_json ON supervision_results
    WHEN OLD.graph_snapshot_json != '{"entities":[],"relations":[]}' BEGIN SELECT RAISE(ABORT, 'Repeated graph snapshot'); END;
    CREATE TRIGGER fail_checkpoints BEFORE INSERT ON review_checkpoints BEGIN SELECT RAISE(ABORT, 'Checkpoint failed'); END`)
  const publication = { request, runId, coverage: store.progress(runId), evidence: [], output: empty }
  expect(() => f.db.saveSupervisionResult(publication)).toThrow('Checkpoint failed')
  expect(f.db.listSupervisionResults()).toHaveLength(1)
  expect(f.sql.prepare('SELECT status FROM supervision_runs WHERE id = ?').get(runId)!.status).toBe('running')
  expect(f.sql.prepare('SELECT * FROM review_checkpoints').all()).toEqual([])
  f.sql.exec('DROP TRIGGER fail_checkpoints')
  f.db.saveSupervisionResult(publication)
  const latest = f.db.listSupervisionResults()[0]!
  const graph = f.db.getSupervisionGraph({ resultId: latest.id })
  expect(graph.entities).toHaveLength(2)
  expect(graph.sources).toHaveLength(2)
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM review_checkpoints').get()!.n).toBe(2)
  expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})

it('retains first-leaf snapshot values and source references when persisted identities recur across leaves', () => {
  const f = fixture()
  f.db.saveSupervisionResult({ request, evidence: [], output: { ...empty,
    entities: ['A', 'B'].map(id => ({ id, label: id, description: 'Original', sourceReferenceIds: [] })),
    relations: [{ fromEntityId: 'A', toEntityId: 'B', relationType: 'related', reason: 'Original', sourceReferenceIds: [] }] } })
  const candidates = f.db.listSupervisionCandidates(request)
  const a = candidates.find(item => item.label === 'A')!, b = candidates.find(item => item.label === 'B')!
  f.db.applySupervisionEntityAction({ entityId: a.id, action: 'confirm' })
  const runId = f.db.startSupervisionRun(request)
  const store = f.db.supervisionReviewStore()
  f.db.saveLocalConversations([{ header: { id: 'conversation', projectId: f.project.id, title: 'Synthetic', updatedAt: Date.parse(at) },
    messages: [0, 1].map(i => ({ id: `source${i}`, role: 'user', state: 'complete', content: 'body', createdAt: Date.parse(at) })) }])
  store.initialize(runId, { request, config: { ...supervisionReviewSettingsSchema.parse({}), version: 1, concurrency: 1, timeoutSeconds: 30 }, phase: 'saving' })
  for (let i = 0; i < 2; i++) {
    const source = f.sql.prepare('SELECT source, revision FROM supervision_review_sources WHERE run_id = ? AND source = ?').get(runId, `message:source${i}`)!
    store.save(runId, f.project.id, 'conversation', [{ id: 'source', sourceType: 'conversation', sourceId: 'conversation', title: `Leaf ${i}`, content: 'body', occurredAt: at,
      locator: { source: String(source.source), revision: String(source.revision), start: 0, end: 4, projectId: f.project.id } }], { ...empty,
      entities: [a, b].map(item => ({ id: item.label, persistedId: item.id, label: item.label, description: `Leaf ${i}`, sourceReferenceIds: ['source'] })),
      relations: [{ fromEntityId: 'A', toEntityId: 'B', relationType: 'related', reason: `Leaf ${i}`, sourceReferenceIds: ['source'] }] })
  }
  f.db.saveSupervisionResult({ request, runId, candidates, coverage: store.progress(runId), evidence: [], output: empty })
  const result = f.db.listSupervisionResults()[0]!
  const graph = f.db.getSupervisionGraph({ resultId: result.id })
  const sourceId = (graph.sources as Array<{ id: string; title: string }>).find(source => source.title === 'Leaf 0')!.id
  expect(graph.entities).toEqual([a, b].sort((x, y) => x.id < y.id ? -1 : 1).map(item => expect.objectContaining({ id: item.id,
    description: item.id === a.id ? 'Original' : 'Leaf 0', confirmation_state: item.id === a.id ? 'confirmed' : 'automatic',
    source_reference_ids_json: JSON.stringify([sourceId]) })))
  expect(graph.relations).toEqual([expect.objectContaining({ reason: 'Leaf 0', source_reference_ids_json: JSON.stringify([sourceId]) })])
  expect(f.sql.prepare('SELECT description FROM supervision_entities WHERE id = ?').get(b.id)!.description).toBe('Leaf 1')
})
