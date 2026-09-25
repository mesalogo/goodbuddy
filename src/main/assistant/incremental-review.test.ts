import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { AssistantDatabase } from './assistant-database'
import { SupervisorService, type SupervisorSummarizer, type SupervisorSummarizerRequest } from './supervisor-service'
import { HeartbeatService } from './heartbeat-service'
import type { SupervisionRunRequest } from '../../shared/supervision-contracts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
const now = new Date()
const request: SupervisionRunRequest = { trigger: 'heartbeat', scope: { kind: 'global' }, timeRange: {
  from: new Date(now.getTime() - 24 * 3600_000).toISOString(), to: new Date(now.getTime() + 3600_000).toISOString()
} }
const heartbeatOutput = { summary: 'Progress saved', highlights: [], proposedMemories: [], followUpTasks: [] }
function output(input: SupervisorSummarizerRequest) {
  const source = input.evidence.find((item) => item.sourceType !== 'memory')!
  return { summary: 'Atlas release progress', changeDigest: 'Atlas updated', openItems: [],
    entities: [{ id: 'atlas', persistedId: input.candidates[0]?.id, label: 'Atlas', description: source.content, sourceReferenceIds: [source.id] }],
    events: [{ title: 'Atlas updated', description: source.content, occurredAt: source.occurredAt, eventType: 'change', entityIds: ['atlas'], sourceReferenceIds: [source.id] }],
    entityChanges: [], relations: [] }
}
async function fixture(contents = ['Atlas release uses SQLite.']) {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-incremental-'))
  const path = join(directory, 'assistant.sqlite')
  const db = new AssistantDatabase(path)
  db.initialize(directory)
  const sql = new DatabaseSync(path)
  cleanup.push(async () => { sql.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
  const project = db.listProjects()[0]!
  const conversationId = randomUUID()
  const messages = contents.map((content) => ({ id: randomUUID(), role: 'user' as const, content,
    createdAt: now.getTime() - 1000, state: 'complete' as const }))
  db.replaceConversations([{ id: conversationId, projectId: project.id, title: 'Atlas', updatedAt: now.getTime(), messages }])
  const summarize = vi.fn<SupervisorSummarizer['summarize']>(async (input) => output(input))
  const supervisor = new SupervisorService({
    collect: async () => db.collectIncrementalReview(request, 'supervisor').evidence,
    incremental: async (input) => db.collectIncrementalReview(input, 'supervisor')
  }, { summarize }, {
    scope: (scope) => db.resolveReviewScope(scope),
    summary: (input) => db.reviewSummary(input.scope, 'supervisor'),
    start: (input, heartbeatRunId) => db.startSupervisionRun(input, heartbeatRunId),
    fail: (id, error) => db.failSupervisionRun(id, error), noChange: (id) => db.noChangeSupervisionRun(id),
    candidates: async (input) => db.listSupervisionCandidates(input), save: async (result) => db.saveSupervisionResult(result)
  })
  return { db, sql, path, directory, project, messages, summarize, supervisor }
}

it('skips repeats across SQLite reopen, detects message edits and reuses persisted entities', async () => {
  const { db, sql, directory, messages, summarize, supervisor } = await fixture()
  await supervisor.run(request)
  const entity = db.listSupervisionCandidates(request)[0]!
  db.close(); db.initialize(directory)
  expect((await supervisor.run(request)).status).toBe('no_change')
  expect(summarize).toHaveBeenCalledTimes(1)
  expect(db.listSupervisionActivity()[0]).toMatchObject({ status: 'no_change', resultId: null })
  expect((db.getSupervisionGraph().events as unknown[])).toHaveLength(1)
  sql.prepare('UPDATE messages SET content = ? WHERE id = ?').run('Atlas now uses WAL.', messages[0]!.id)
  await supervisor.run(request)
  expect(summarize).toHaveBeenCalledTimes(2)
  expect(summarize.mock.calls[1]![0].previousSummary).toBe('Atlas release progress')
  expect(db.listSupervisionCandidates(request)).toEqual([{ ...entity, description: 'Atlas now uses WAL.' }])
  expect((await supervisor.run(request)).status).toBe('no_change')
})

it('advances only saved portions, retries model and transaction failures, and drains older unseen evidence', async () => {
  const { db, sql, summarize, supervisor } = await fixture(Array.from({ length: 105 }, (_, i) => `Atlas ${i}: ${'x'.repeat(2400)}`))
  const initial = db.collectIncrementalReview(request, 'supervisor')
  expect(initial.evidence).toHaveLength(24)
  summarize.mockRejectedValueOnce(new Error('Provider failed'))
  await expect(supervisor.run(request)).rejects.toThrow('Provider failed')
  expect(db.collectIncrementalReview(request, 'supervisor')).toEqual(initial)
  sql.exec("CREATE TRIGGER fail_review BEFORE INSERT ON supervision_results BEGIN SELECT RAISE(ABORT, 'Save failed'); END")
  await expect(supervisor.run(request)).rejects.toThrow('Save failed')
  expect(db.collectIncrementalReview(request, 'supervisor')).toEqual(initial)
  sql.exec('DROP TRIGGER fail_review')
  // Empty graph output is valid and still processes all supplied evidence.
  summarize.mockImplementation(async () => ({ summary: 'Batch', changeDigest: '', openItems: [], events: [], entities: [], entityChanges: [], relations: [] }))
  let batches = 0
  while ((await supervisor.run(request)).status !== 'no_change') {
    if (++batches > 20) throw new Error('Evidence did not drain')
  }
  const checkpoints = sql.prepare('SELECT * FROM review_checkpoints').all()
  expect(checkpoints).toHaveLength(105)
  expect(checkpoints.every((row) => row.processed_offset === row.source_length)).toBe(true)
  const stored = sql.prepare("SELECT SUM(length(content)) AS size FROM supervision_sources WHERE source_type = 'conversation'").get()!
  expect(stored.size).toBe(Array.from({ length: 105 }, (_, i) => `Atlas ${i}: ${'x'.repeat(2400)}`).join('').length)
})

it('keeps scope, inclusive time boundaries, task revisions and memory background distinct', async () => {
  const { db, sql, project, messages, supervisor, summarize } = await fixture()
  sql.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(request.timeRange.from, messages[0]!.id)
  const second = db.createProject({ name: 'Other', description: '', rootPath: process.cwd(), defaultWorkMode: 'ask' })
  const scoped = { ...request, scope: { kind: 'projects' as const, projectIds: [project.id, second.id] } }
  await supervisor.run(scoped)
  expect((await supervisor.run({ ...scoped, scope: { kind: 'projects', projectIds: [second.id, project.id] } })).status).toBe('no_change')
  const id = randomUUID()
  db.createTask({ id, projectId: project.id, title: 'Atlas task', instructions: 'Private instructions', workMode: 'ask' })
  await supervisor.run(scoped)
  db.updateTaskStatus(id, 'completed')
  await supervisor.run(scoped)
  expect(summarize.mock.calls.at(-1)![0].evidence).toEqual([expect.objectContaining({ sourceType: 'task', sourceId: id })])
  const memory = db.createMemory({ scope: 'global', type: 'fact', content: 'Current background' })
  db.setMemoryStatus(memory.id, 'confirmed')
  expect((await supervisor.run(scoped)).status).toBe('no_change')
  expect((await supervisor.run({ ...request, scope: { kind: 'projects', projectIds: [second.id] } })).status).toBe('no_change')
})

it('skips both automatic paid stages and retries failed supervision without repeating the heartbeat model', async () => {
  const { db, sql, supervisor, summarize } = await fixture()
  const heartbeatModel = vi.fn(async () => heartbeatOutput)
  const heartbeat = new HeartbeatService(db, { summarize: heartbeatModel }, () => {}, async ({ run }) => {
    await supervisor.run(request, run.id)
  })
  const config = heartbeat.create({ name: 'Incremental', scope: request.scope, timezone: 'UTC',
    recurrence: { type: 'daily', localTime: '09:00' }, enabled: true, lookbackHours: 24, retentionDays: 30 }, now)
  let tickNumber = 0
  const tick = async () => {
    sql.prepare('UPDATE heartbeat_configs SET next_run_at = ? WHERE id = ?').run(new Date(now.getTime() - 10000 + tickNumber++).toISOString(), config.id)
    return heartbeat.processDue(new Date())
  }
  summarize.mockRejectedValueOnce(new Error('Supervisor unavailable'))
  await tick()
  expect(db.listSupervisionActivity()[0]).toMatchObject({ status: 'failed', heartbeatStatus: 'completed' })
  await tick()
  expect(heartbeatModel).toHaveBeenCalledTimes(1)
  expect(summarize).toHaveBeenCalledTimes(2)
  await tick()
  expect(heartbeatModel).toHaveBeenCalledTimes(1)
  expect(summarize).toHaveBeenCalledTimes(2)
  expect(db.listSupervisionActivity()[0]).toMatchObject({ status: 'no_change', heartbeatStatus: 'no_change', supervisionStatus: 'no_change' })
  expect(db.listHeartbeatEntries(config.id)).toHaveLength(1)
})

it('processes knowledge edits independently and ignores unrelated message metadata writes', async () => {
  const { db, sql, messages, supervisor, summarize } = await fixture()
  const reference = { libraryId: randomUUID(), documentId: randomUUID(), chunkId: randomUUID(),
    documentName: 'Atlas source', sourceName: 'Atlas source', snippet: 'SQLite supports transactions' }
  sql.prepare('UPDATE messages SET metadata_json = ? WHERE id = ?').run(JSON.stringify({ sourceReferences: [reference] }), messages[0]!.id)
  await supervisor.run(request)
  expect(summarize.mock.calls[0]![0].evidence.map((item) => item.sourceType).sort()).toEqual(['conversation', 'knowledge'])
  sql.prepare("UPDATE messages SET metadata_json = json_set(metadata_json, '$.unrelated', 'updated') WHERE id = ?").run(messages[0]!.id)
  expect((await supervisor.run(request)).status).toBe('no_change')
  sql.prepare("UPDATE messages SET metadata_json = json_set(metadata_json, '$.sourceReferences[0].snippet', 'SQLite WAL supports readers') WHERE id = ?").run(messages[0]!.id)
  const changed = await supervisor.run(request)
  expect(changed.evidence).toEqual([expect.objectContaining({ sourceType: 'knowledge', sourceId: reference.chunkId,
    content: 'SQLite WAL supports readers', locator: expect.objectContaining({ documentId: reference.documentId, libraryId: reference.libraryId }) })])
  expect(db.listSupervisionCandidates(request)).toHaveLength(1)
})

it('rolls back heartbeat checkpoints with a failed report save and retries the same input', async () => {
  const { db, sql } = await fixture()
  const summarize = vi.fn(async () => heartbeatOutput)
  const heartbeat = new HeartbeatService(db, { summarize }, () => {})
  const config = heartbeat.create({ name: 'Failure boundary', scope: request.scope, timezone: 'UTC',
    recurrence: { type: 'daily', localTime: '09:00' }, enabled: true, lookbackHours: 24, retentionDays: 30 }, now)
  sql.prepare('UPDATE heartbeat_configs SET next_run_at = ? WHERE id = ?').run(new Date(now.getTime() - 1000).toISOString(), config.id)
  const initial = db.collectIncrementalReview(request, 'heartbeat', 12000)
  sql.exec("CREATE TRIGGER fail_report BEFORE INSERT ON heartbeat_entries BEGIN SELECT RAISE(ABORT, 'Report save failed'); END")
  expect((await heartbeat.processDue())[0]!.status).toBe('failed')
  expect(db.collectIncrementalReview(request, 'heartbeat', 12000)).toEqual(initial)
  expect(db.listHeartbeatEntries(config.id)).toEqual([])
  sql.exec('DROP TRIGGER fail_report')
  sql.prepare("UPDATE heartbeat_runs SET next_attempt_at = ? WHERE config_id = ?").run(new Date(Date.now() - 1000).toISOString(), config.id)
  expect((await heartbeat.processDue())[0]!.status).toBe('completed')
  expect(summarize).toHaveBeenCalledTimes(2)
  expect(db.collectIncrementalReview(request, 'heartbeat', 12000).evidence).toEqual([])
})

it('preserves schema-45 plans, reports, IDs and foreign keys while extending status constraints', async () => {
  const { db, sql, directory } = await fixture()
  const config = db.createHeartbeatConfig({ name: 'Preserved plan', scope: request.scope, timezone: 'UTC',
    recurrence: { type: 'daily', localTime: '09:00' }, enabled: true, lookbackHours: 24, retentionDays: 30 }, now)
  const claim = db.claimHeartbeatNow(config.id, 'before-upgrade', 'test', now)
  db.completeHeartbeatRun(claim, heartbeatOutput, now)
  const savedConfig = db.getHeartbeatConfig(config.id)
  const savedEntries = db.listHeartbeatEntries(config.id)
  db.close()
  sql.exec(`PRAGMA foreign_keys = OFF; BEGIN;
    DROP VIEW supervision_review_current;
    DROP TABLE supervision_review_navigation; DROP TABLE supervision_review_batches;
    DROP TABLE supervision_review_sources; DROP TABLE supervision_review_runs;
    DROP TRIGGER messages_review_insert; DROP TRIGGER messages_review_update;
    DROP TRIGGER messages_review_delete; DROP TRIGGER tasks_review_delete;
    DROP TABLE review_checkpoints; ALTER TABLE messages DROP COLUMN review_revision;`)
  for (const table of ['heartbeat_configs', 'heartbeat_runs']) {
    const definition = sql.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table)!.sql as string
    const indexes = sql.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(table)
    sql.exec(definition.replace(table, `${table}_old`).replaceAll(", 'no_change'", ''))
    sql.exec(`INSERT INTO ${table}_old SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_old RENAME TO ${table};`)
    for (const index of indexes) sql.exec(String(index.sql))
  }
  sql.exec('PRAGMA user_version = 45; COMMIT; PRAGMA foreign_keys = ON;')
  db.initialize(directory)
  expect(db.getHeartbeatConfig(config.id)).toEqual(savedConfig)
  expect(db.listHeartbeatEntries(config.id)).toEqual(savedEntries)
  const next = db.claimHeartbeatNow(config.id, 'after-upgrade', 'test', now)
  expect(db.noChangeHeartbeatRun(next, now).status).toBe('no_change')
  expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  expect(sql.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' })
})
