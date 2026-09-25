import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { AssistantDatabase } from './assistant-database'
import { SupervisorService, type StoredSupervisionResult } from './supervisor-service'
import { HeartbeatService } from './heartbeat-service'

const request: StoredSupervisionResult['request'] = {
  trigger: 'manual', scope: { kind: 'global' },
  timeRange: { from: '2026-09-01T00:00:00Z', to: '2026-09-23T00:00:00Z' }
}
const output: StoredSupervisionResult['output'] = {
  summary: 'Saved review', changeDigest: '', openItems: [], events: [], entities: [], entityChanges: [], relations: []
}
function service(db: AssistantDatabase, summarize: () => Promise<unknown>, collect = async () => []) {
  return new SupervisorService({ collect }, { summarize }, {
    start: (input, heartbeatRunId) => db.startSupervisionRun(input, heartbeatRunId),
    fail: (id, error) => db.failSupervisionRun(id, error),
    save: async (result) => db.saveSupervisionResult(result)
  })
}

it('persists manual running, completed and failed executions through the real service and SQLite', async () => {
  const db = new AssistantDatabase(':memory:')
  db.initialize(process.cwd())
  try {
    let finish!: (value: unknown) => void
    const pending = service(db, () => new Promise((resolve) => { finish = resolve })).run(request)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(db.listSupervisionActivity()).toEqual([expect.objectContaining({ status: 'running', completedAt: null, scope: request.scope })])
    finish(output)
    await pending
    const completed = db.listSupervisionActivity()[0]!
    expect(completed).toMatchObject({ status: 'completed', summary: output.summary, supervisionStatus: 'completed' })
    expect(completed.completedAt).not.toBeNull()
    expect(db.listSupervisionResults(1, undefined, completed.resultId!)[0]!.summary).toBe(output.summary)
    expect(db.getSupervisionGraph({ resultId: completed.resultId! })).toHaveProperty('storyLine')
    await expect(service(db, async () => { throw new Error('Provider unavailable') }).run(request)).rejects.toThrow('Provider unavailable')
    await expect(service(db, async () => ({ ...output, entities: [{ id: 'bad', label: 'Bad', description: '', sourceReferenceIds: ['missing'] }] })).run(request)).rejects.toThrow()
    await expect(service(db, async () => output, async () => { throw new Error('Scope unavailable') }).run(request)).rejects.toThrow('Scope unavailable')
    expect(db.listSupervisionActivity().filter((row) => row.status === 'failed')).toHaveLength(3)
    expect(db.listSupervisionResults()).toHaveLength(1)
    expect(db.listSupervisionActivity(2, 2)).toHaveLength(2)
  } finally { db.close() }
})

it.each([false, true])('groups heartbeat and downstream supervision with truthful stages (failure=%s)', async (failed) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-23T09:00:00Z'))
  const db = new AssistantDatabase(':memory:')
  db.initialize(process.cwd())
  try {
    let finish!: () => void
    db.replaceConversations([{ id: crypto.randomUUID(), projectId: db.listProjects()[0]!.id, title: 'Review input',
      updatedAt: Date.parse('2026-09-23T08:00:00Z'), messages: [{ id: crypto.randomUUID(), role: 'user',
        content: 'New review input', createdAt: Date.parse('2026-09-23T08:00:00Z'), state: 'complete' }] }])
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const supervisor = service(db, async () => {
      entered()
      await new Promise<void>((resolve) => { finish = resolve })
      if (failed) throw new Error('Downstream failed')
      return output
    })
    const heartbeat = new HeartbeatService(db, { summarize: async () => ({ summary: 'Heartbeat saved', highlights: [], proposedMemories: [], followUpTasks: [] }) }, () => {},
      async ({ run }) => { await supervisor.run({ ...request, trigger: 'heartbeat' }, run.id) })
    const config = heartbeat.create({ name: 'Daily', scope: request.scope, timezone: 'UTC', recurrence: { type: 'daily', localTime: '09:00' }, enabled: true, lookbackHours: 24, retentionDays: 30 }, new Date('2026-09-23T00:00:00Z'))
    const pending = failed ? heartbeat.runNow({ id: config.id, idempotencyKey: crypto.randomUUID() })
      : heartbeat.processDue(new Date('2026-09-23T09:00:00Z'))
    await started
    expect(db.listSupervisionActivity()).toEqual([expect.objectContaining({ kind: 'heartbeat', trigger: failed ? 'manual' : 'scheduled', status: 'running', heartbeatStatus: 'completed', supervisionStatus: 'running', completedAt: null })])
    finish()
    await pending
    expect(db.listSupervisionActivity()).toEqual([expect.objectContaining({ status: failed ? 'failed' : 'completed', heartbeatStatus: 'completed', supervisionStatus: failed ? 'failed' : 'completed', error: failed ? 'Downstream failed' : null })])
    expect(db.listSupervisionActivity()[0]!.resultId === null).toBe(failed)
  } finally { db.close(); vi.useRealTimers() }
})

it('records heartbeat failures before downstream execution and projection callback failures', async () => {
  const db = new AssistantDatabase(':memory:')
  db.initialize(process.cwd())
  try {
    const heartbeat = new HeartbeatService(db, { summarize: async () => { throw new Error('Heartbeat failed') } }, () => {})
    const config = heartbeat.create({ name: 'Daily', scope: request.scope, timezone: 'UTC', recurrence: { type: 'daily', localTime: '09:00' }, enabled: true, lookbackHours: 24, retentionDays: 30 })
    await heartbeat.runNow({ id: config.id, idempotencyKey: crypto.randomUUID() })
    expect(db.listSupervisionActivity()[0]).toMatchObject({ status: 'failed', error: 'Heartbeat failed', scope: request.scope, supervisionStatus: null })
    const projection = new HeartbeatService(db, { summarize: async () => ({ summary: 'Report', highlights: [], proposedMemories: [], followUpTasks: [] }) }, () => {}, async () => { throw new Error('Callback failed') })
    await projection.runNow({ id: config.id, idempotencyKey: crypto.randomUUID() })
    expect(db.listSupervisionActivity().find((row) => row.error === 'Callback failed')).toMatchObject({ status: 'failed', heartbeatStatus: 'completed' })
  } finally { db.close() }
})

it('filters by exact plan ID before pagination, including plans with the same name and scope', async () => {
  const db = new AssistantDatabase(':memory:')
  db.initialize(process.cwd())
  try {
    const heartbeat = new HeartbeatService(db, { summarize: async () => { throw new Error('Expected failure') } }, () => {})
    const input = { name: 'Daily', scope: request.scope, timezone: 'UTC', recurrence: { type: 'daily' as const, localTime: '09:00' }, enabled: true, lookbackHours: 24, retentionDays: 30 }
    const first = heartbeat.create(input)
    const second = heartbeat.create(input)
    await heartbeat.runNow({ id: first.id, idempotencyKey: crypto.randomUUID() })
    const firstId = db.listSupervisionActivity()[0]!.id
    await heartbeat.runNow({ id: second.id, idempotencyKey: crypto.randomUUID() })
    await service(db, async () => output).run(request)
    expect(db.listSupervisionActivity(1, 0, first.id).map(row => row.id)).toEqual([firstId])
    expect(db.listSupervisionActivity(1, 1, first.id)).toEqual([])
    expect(db.listSupervisionActivity(50, 0, second.id)).toEqual([expect.objectContaining({ kind: 'heartbeat' })])
    expect(db.listSupervisionActivity(50, 0, 'missing')).toEqual([])
    expect(db.listSupervisionActivity()).toHaveLength(3)
  } finally { db.close() }
})

it('upgrades schema 44 without inventing historical links and preserves runs on reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'supervision-activity-'))
  const path = join(directory, 'assistant.sqlite')
  const db = new AssistantDatabase(path)
  try {
    db.initialize(process.cwd())
    db.saveSupervisionResult({ request, output, evidence: [] })
    const saved = db.listSupervisionResults()
    db.close()
    const legacy = new DatabaseSync(path)
    legacy.exec(`DROP INDEX supervision_runs_heartbeat; DROP INDEX supervision_runs_started; DROP INDEX supervision_results_run;
      ALTER TABLE supervision_runs DROP COLUMN heartbeat_run_id;
      ALTER TABLE heartbeat_runs DROP COLUMN activity_scope_json;
      ALTER TABLE heartbeat_runs DROP COLUMN projection_status;
      ALTER TABLE heartbeat_runs DROP COLUMN projection_error;
      ALTER TABLE heartbeat_runs DROP COLUMN projection_completed_at;
      DROP TRIGGER messages_review_insert; DROP TRIGGER messages_review_update;
      DROP TRIGGER messages_review_delete; DROP TRIGGER tasks_review_delete;
      DROP VIEW supervision_review_current;
      DROP TABLE supervision_review_navigation; DROP TABLE supervision_review_batches;
      DROP TABLE supervision_review_sources; DROP TABLE supervision_review_runs;
      DROP TABLE review_checkpoints; ALTER TABLE messages DROP COLUMN review_revision;
      PRAGMA user_version = 44;`)
    legacy.close()
    db.initialize(process.cwd())
    expect(db.listSupervisionResults()).toEqual(saved)
    const runId = db.startSupervisionRun(request)
    db.close()
    db.initialize(process.cwd())
    expect(db.listSupervisionActivity().find((row) => row.id === runId)).toMatchObject({ status: 'failed', error: 'Application stopped before supervision finished' })
    expect(db.listSupervisionResults()).toEqual(saved)
  } finally { db.close(); await rm(directory, { recursive: true, force: true }) }
})

it('uses actual manual heartbeat and downstream finish times', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-23T10:00:00Z'))
  const db = new AssistantDatabase(':memory:')
  db.initialize(process.cwd())
  try {
    const heartbeat = new HeartbeatService(db, { summarize: async () => {
      vi.setSystemTime(new Date('2026-09-23T10:02:00Z'))
      return { summary: 'Report', highlights: [], proposedMemories: [], followUpTasks: [] }
    } }, () => {}, async () => {
      vi.setSystemTime(new Date('2026-09-23T10:03:00Z'))
      throw new Error('Projection failed')
    })
    const config = heartbeat.create({ name: 'Daily', scope: request.scope, timezone: 'UTC', recurrence: { type: 'daily', localTime: '09:00' }, enabled: true, lookbackHours: 24, retentionDays: 30 })
    const run = await heartbeat.runNow({ id: config.id, idempotencyKey: crypto.randomUUID() })
    expect(run.completedAt).toBe('2026-09-23T10:02:00.000Z')
    expect(db.listSupervisionActivity()[0]).toMatchObject({ startedAt: '2026-09-23T10:00:00.000Z', completedAt: '2026-09-23T10:03:00.000Z', status: 'failed' })
  } finally { db.close(); vi.useRealTimers() }
})
