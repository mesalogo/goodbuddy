// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { ASSISTANT_DATABASE_SCHEMA_VERSION, AssistantDatabase } from './assistant-database'
import { SupervisorService, type SupervisorSummarizerRequest } from './supervisor-service'
import type { SupervisionRunRequest } from '../../shared/supervision-contracts'
import type { ReviewConfiguration } from './supervision-review-store'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const base = Date.parse('2026-09-20T08:00:00Z')
const range = { from: '2026-09-19T00:00:00Z', to: '2026-09-22T00:00:00Z' }

async function fixture(crossProject = false) {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-timeline-'))
  const path = join(directory, 'assistant.sqlite')
  const db = new AssistantDatabase(path)
  db.initialize(directory)
  const sql = new DatabaseSync(path)
  cleanups.push(async () => { sql.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
  const a = db.listProjects()[0]!
  const b = db.createProject({ name: 'B', description: '', rootPath: directory, defaultWorkMode: 'ask' })
  const message = (content: string, minutes: number) => ({ id: randomUUID(), role: 'user' as const, content, createdAt: base + minutes * 60_000, state: 'complete' as const })
  const conversations = [
    { id: randomUUID(), projectId: a.id, title: 'A', updatedAt: base, messages: [message('Choose SQLite for the timeline', 0), message('Measured: SQLite is fast enough', 90)] },
    { id: randomUUID(), projectId: b.id, title: 'B', updatedAt: base, messages: [message('B also needs storage', 30)] }
  ]
  db.replaceConversations(conversations)
  // One event per batch spanning all its evidence; one entity labelled by project.
  const summarize = vi.fn(async (input: SupervisorSummarizerRequest) => {
    if (input.evidence[0]?.sourceType === 'note') return { summary: 'Navigation', changeDigest: '', openItems: [], events: [], entities: [], entityChanges: [], relations: [] }
    const known = input.candidates[0]
    return { summary: 'Batch', changeDigest: '', openItems: [], entityChanges: [], relations: [],
      entities: [{ id: 'storage', label: 'Storage', description: 'Storage choice', sourceReferenceIds: [input.evidence[0]!.id], ...(known ? { persistedId: known.id } : {}) }],
      events: [{ title: 'Storage discussion', description: 'Discussed storage', occurredAt: input.evidence[0]!.occurredAt,
        eventType: 'discussion' as const, entityIds: ['storage'], sourceReferenceIds: input.evidence.map(item => item.id) }] }
  })
  const config: ReviewConfiguration = { version: 1, pageSize: 50, batchCharacters: 8000, batchMessages: 20, concurrency: 1,
    timeoutSeconds: 30, executionSeconds: 300, crossProject }
  const service = new SupervisorService({ collect: async () => { throw new Error('Legacy collector used') } }, { summarize }, {
    scope: scope => db.resolveReviewScope(scope), start: (input, heartbeat) => db.startSupervisionRun(input, heartbeat),
    fail: (id, error) => db.failSupervisionRun(id, error), noChange: id => db.noChangeSupervisionRun(id),
    candidates: async (request, batch) => db.listSupervisionCandidates(request, batch),
    save: async result => db.saveSupervisionResult(result)
  }, { database: () => db.supervisionReviewStore(), configuration: async () => config })
  const run = (scope: SupervisionRunRequest['scope'], reanalyze = false) => service.run({ trigger: 'manual', reanalyze, scope, timeRange: range })
  return { db, sql, a, b, summarize, run }
}

const current = (sql: DatabaseSync) => sql.prepare('SELECT * FROM supervision_events WHERE superseded_by IS NULL ORDER BY started_at').all()

it('extracts each source once for every scope: a project review then global reads only the other project', async () => {
  const f = await fixture()
  await f.run({ kind: 'projects', projectIds: [f.a.id] })
  expect(f.summarize).toHaveBeenCalledTimes(1)
  const global = await f.run({ kind: 'global' })
  // Only project B's message is new on the shared timeline.
  expect(global.coverage).toMatchObject({ sources: 1 })
  expect(f.summarize.mock.calls.filter(([input]) => input.evidence[0]?.sourceType !== 'note')).toHaveLength(2)
  await expect(f.run({ kind: 'projects', projectIds: [f.a.id] })).resolves.toMatchObject({ status: 'no_change' })
  expect(current(f.sql)).toHaveLength(2)
})

it('derives event spans and projects from sources and supersedes events when the same sources are re-extracted', async () => {
  const f = await fixture()
  await f.run({ kind: 'global' })
  const first = current(f.sql)
  const eventA = first.find(event => event.project_id === f.a.id)!
  expect(eventA).toMatchObject({ started_at: '2026-09-20T08:00:00.000Z', ended_at: '2026-09-20T09:30:00.000Z' })
  expect(first.find(event => event.project_id === f.b.id)).toBeDefined()
  // Re-analysis of an overlapping interval re-extracts the same source versions: no duplicate current events.
  await f.run({ kind: 'global' }, true)
  await f.run({ kind: 'projects', projectIds: [f.a.id] }, true)
  expect(current(f.sql)).toHaveLength(2)
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM supervision_events WHERE superseded_by IS NOT NULL').get()!.n).toBe(3)
  // Global and project graphs read the same current events.
  const globalGraph = f.db.getSupervisionGraph({ storyLineId: String(f.sql.prepare(`SELECT id FROM story_lines WHERE scope_json = '{"kind":"global"}'`).get()!.id) })
  expect((globalGraph.events as unknown[]).length).toBe(2)
  const projectLine = f.db.listSupervisionResults()[0]!.storyLineId
  const projectGraph = f.db.getSupervisionGraph({ storyLineId: projectLine })
  expect((projectGraph.events as Array<{ project_id: string }>).map(event => event.project_id)).toEqual([f.a.id])
  // Attention density is counted from source messages: one turn in the 08:00 hour, one at 09:00.
  expect(projectGraph.attention).toEqual([
    { start: '2026-09-20T08:00:00.000Z', turns: 1, characters: 30 },
    { start: '2026-09-20T09:00:00.000Z', turns: 1, characters: 31 }
  ])
})

it('offers another project\'s knowledge only when cross-project linking is on', async () => {
  for (const crossProject of [false, true]) {
    const f = await fixture(crossProject)
    await f.run({ kind: 'projects', projectIds: [f.a.id] })
    const offered = f.summarize.mock.calls.length
    await f.run({ kind: 'projects', projectIds: [f.b.id] })
    const candidates = f.summarize.mock.calls.slice(offered).find(([input]) => input.evidence[0]?.sourceType !== 'note')![0].candidates
    expect(candidates.map(candidate => candidate.label)).toEqual(crossProject ? ['Storage'] : [])
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM supervision_entities').get()!.n).toBe(crossProject ? 1 : 2)
  }
})

it('upgrades released per-scope progress and duplicated events into the shared timeline', async () => {
  const f = await fixture()
  await f.run({ kind: 'global' })
  await f.run({ kind: 'global' }, true)
  // Simulate schema 52: per-scope checkpoints and no timeline columns.
  f.sql.exec(`UPDATE review_checkpoints SET scope = '{"kind":"global"}';
    DROP INDEX supervision_events_timeline; DROP INDEX supervision_sources_key;
    ALTER TABLE supervision_events DROP COLUMN started_at; ALTER TABLE supervision_events DROP COLUMN ended_at;
    ALTER TABLE supervision_events DROP COLUMN project_id; ALTER TABLE supervision_events DROP COLUMN superseded_by;
    ALTER TABLE supervision_sources DROP COLUMN source_key; ALTER TABLE supervision_sources DROP COLUMN source_revision;
    PRAGMA user_version = 52;`)
  f.db.close()
  f.db.initialize(process.cwd())
  expect(f.sql.prepare('PRAGMA user_version').get()!.user_version).toBe(ASSISTANT_DATABASE_SCHEMA_VERSION)
  expect(f.sql.prepare("SELECT DISTINCT scope FROM review_checkpoints").all().map(row => row.scope)).toEqual(['timeline'])
  expect(current(f.sql)).toHaveLength(2)
  await expect(f.run({ kind: 'projects', projectIds: [f.a.id] })).resolves.toMatchObject({ status: 'no_change' })
})
