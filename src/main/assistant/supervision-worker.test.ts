// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { AssistantDatabase } from './assistant-database'
import { createProductionSupervisorService } from './supervision-production'
import { SupervisionModelPool } from './supervision-model-pool'
import type { AgentRuntime } from '../agent/runtime'
import { supervisionReviewSettingsSchema } from '../../shared/supervision-review-contracts'
import type { ReviewState } from './supervision-review-store'
import { ReadonlyQueryReader } from '../readonly-query-reader'

let directory: string, workerPath: string
const cleanup: Array<() => Promise<void>> = []
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'supervision-worker-'))
  workerPath = join(directory, 'readonly-query-worker.cjs')
  await build({ entryPoints: [resolve('src/main/readonly-query-worker.ts')], outfile: workerPath,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
}, 60_000)
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
afterAll(async () => { await rm(directory, { recursive: true, force: true, maxRetries: 10 }) })

async function fixture() {
  const root = await mkdtemp(join(directory, 'data-'))
  const path = join(root, 'assistant.sqlite')
  const db = new AssistantDatabase(path)
  db.initialize(root)
  db.enableReadonlyWorker(workerPath)
  const sql = new DatabaseSync(path)
  const project = db.listProjects()[0]!
  const other = db.createProject({ name: 'Other', description: '', rootPath: root })
  const now = Date.parse('2026-10-01T12:00:00Z')
  const conversations = [project, other].map(p => ({ id: randomUUID(), projectId: p.id, title: p.name, updatedAt: now,
    messages: Array.from({ length: 211 }, (_, index) => ({ id: randomUUID(), role: 'user' as const,
      state: 'complete' as const, content: index === 210 ? '' : `Source ${index} \u{1f600}`, createdAt: now })) }))
  db.replaceConversations(conversations)
  sql.prepare('UPDATE messages SET metadata_json = ? WHERE id = ?').run(JSON.stringify({ sourceReferences: [
    { documentId: 'document', documentName: 'Reference', snippet: 'Knowledge \u{1f600}', chunkId: 'chunk' }
  ] }), conversations[0]!.messages[0]!.id)
  db.createTask({ id: randomUUID(), conversationId: conversations[0]!.id, projectId: project.id,
    title: 'Visible task', instructions: 'Test', origin: 'user', visible: true })
  const state: ReviewState = { request: { trigger: 'manual', scope: { kind: 'global' },
    timeRange: { from: '2026-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' } },
    config: { ...supervisionReviewSettingsSchema.parse({}), version: 1, timeoutSeconds: 30, concurrency: 1 }, phase: 'collecting' }
  cleanup.push(async () => { sql.close(); db.close(); await rm(root, { recursive: true, force: true, maxRetries: 10 }) })
  return { root, path, db, sql, state, project, conversations }
}

it('preserves every source, revision, Unicode length and checkpoint for global, project and re-analysis scopes', async () => {
  const f = await fixture()
  const rows = f.sql.prepare('SELECT * FROM supervision_review_current WHERE length(body) > 0').all()
  expect(new Set(rows.map(row => row.type))).toEqual(new Set(['conversation', 'task', 'knowledge']))
  const hash = (value: unknown) => createHash('sha256').update(String(value)).digest('hex')
  const source = rows.find(row => row.type === 'conversation')!
  f.sql.prepare('INSERT INTO review_checkpoints VALUES (?, ?, ?, ?, ?, ?)').run('supervisor', 'timeline', String(source.source), hash(source.context), 3, Array.from(String(source.body)).length)
  for (const scope of [{ kind: 'global' as const }, { kind: 'projects' as const, projectIds: [f.project.id] }]) {
    for (const reanalyze of [false, true]) {
      const state = { ...f.state, request: { ...f.state.request, scope, reanalyze } }
      const id = f.db.startSupervisionRun(state.request)
      await f.db.initializeSupervisionReview(id, state, new AbortController().signal)
      const expected = rows.filter(row => scope.kind === 'global' || row.project_id === f.project.id).map(row => ({
        source: row.source, revision: hash(row.context), project_id: row.project_id, conversation_id: row.conversation_id,
        sequence: row.sequence, length: Array.from(String(row.body)).length,
        initial_offset: !reanalyze && row.source === source.source ? 3 : 0,
        processed_offset: !reanalyze && row.source === source.source ? 3 : 0
      })).sort((a, b) => String(a.source).localeCompare(String(b.source)))
      const actual = f.sql.prepare(`SELECT source, revision, project_id, conversation_id, sequence, length, initial_offset, processed_offset
        FROM supervision_review_sources WHERE run_id = ?`).all(id).sort((a, b) => String(a.source).localeCompare(String(b.source)))
      expect(actual).toEqual(expected)
      expect(f.db.supervisionReviewStore().load(id).initializing).toBeUndefined()
    }
  }
  expect(await f.db.supervisionContext(f.state.request)).toEqual({ summary: f.db.reviewSummary(f.state.request.scope, 'supervisor'), background: f.db.reviewBackground(f.state.request.scope) })
  expect(await f.db.supervisionCandidates(f.state.request)).toEqual(f.db.listSupervisionCandidates(f.state.request))
})

it('rebuilds a partially written manifest after restart and validates completed legacy manifests on resume', async () => {
  const f = await fixture()
  const id = f.db.startSupervisionRun(f.state.request)
  f.sql.exec(`CREATE TRIGGER fail_manifest BEFORE INSERT ON supervision_review_sources
    WHEN (SELECT COUNT(*) FROM supervision_review_sources) >= 200 BEGIN SELECT RAISE(ABORT, 'interrupted initialization'); END`)
  await expect(f.db.initializeSupervisionReview(id, f.state, new AbortController().signal)).rejects.toThrow('interrupted initialization')
  expect(f.db.supervisionReviewStore().progress(id).sources).toBe(200)
  expect(() => f.db.supervisionReviewStore().assertComplete(id)).toThrow('incomplete source manifest')
  f.sql.exec('DROP TRIGGER fail_manifest')
  f.db.close()
  f.db.initialize(f.root)
  await f.db.resumeSupervisionReview(id, new AbortController().signal)
  expect(f.db.supervisionReviewStore().progress(id).sources).toBe(422)
  expect(f.db.supervisionReviewStore().load(id).initializing).toBeUndefined()
  // Existing saved runs have no initialization flag and retain their frozen versions.
  f.sql.prepare('UPDATE messages SET content = ? WHERE id = ?').run('Changed', f.conversations[0]!.messages[0]!.id)
  await expect(f.db.resumeSupervisionReview(id, new AbortController().signal)).rejects.toThrow('source changed')
  expect(f.db.supervisionReviewStore().load(id).restartRequired).toBe(true)
})

it.each(['paused', 'cancelled'] as const)('accepts %s during production initialization, holds the slot, and never calls the model', async status => {
  const f = await fixture()
  const pool = new SupervisionModelPool()
  cleanup.push(async () => pool.dispose())
  const run = vi.fn(async function* () { throw new Error('Model must not start'); yield { type: 'done' } })
  const service = createProductionSupervisorService(f.db, async () => ({}), async () => ({ run, dispose: async () => {} }) as unknown as AgentRuntime, pool)
  const initialize = f.db.initializeSupervisionReview.bind(f.db)
  let cancellation: Promise<void> | undefined
  vi.spyOn(f.db, 'initializeSupervisionReview').mockImplementation((id, state, signal) => {
    const pending = initialize(id, state, signal)
    if (status === 'paused') service.pause(id)
    else cancellation = service.cancel(id)
    expect(service.execution()).toMatchObject({ active: true, runId: id, stopping: status })
    return pending
  })
  const result = await service.run(f.state.request)
  await cancellation
  expect(result.status).toBe(status)
  expect(run).not.toHaveBeenCalled()
  expect(service.execution().active).toBe(false)
  expect(f.db.supervisionReviewStore().load(result.runId!).initializing).toBe(true)
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM review_checkpoints').get()!.n).toBe(0)
  if (status === 'cancelled') await expect(service.resume(result.runId!)).rejects.toThrow('SUPERVISION_REVIEW_CANCELLED')
  else {
    await f.db.resumeSupervisionReview(result.runId!, new AbortController().signal)
    expect(f.db.supervisionReviewStore().progress(result.runId!).sources).toBe(422)
  }
})

it('fails explicitly when the worker entry is missing instead of running the scan on Main', async () => {
  const f = await fixture()
  f.db.enableReadonlyWorker(join(directory, 'missing-worker.cjs'))
  const id = f.db.startSupervisionRun(f.state.request)
  await expect(f.db.initializeSupervisionReview(id, f.state, new AbortController().signal)).rejects.toThrow()
  expect(f.db.supervisionReviewStore().load(id).initializing).toBe(true)
  expect(f.db.supervisionReviewStore().progress(id).sources).toBe(0)
})

it('publishes full worker-selected coverage atomically and skips it on the next production review', async () => {
  const f = await fixture()
  const pool = new SupervisionModelPool()
  cleanup.push(async () => pool.dispose())
  let calls = 0
  const runtime = { async *run() {
    calls++
    yield { type: 'text', delta: JSON.stringify({ summary: 'Local stub', changeDigest: '', openItems: [], events: [], entities: [], entityChanges: [], relations: [] }) }
    yield { type: 'done' }
  }, async dispose() {}, async releaseConversation() {} } as unknown as AgentRuntime
  const service = createProductionSupervisorService(f.db, async () => ({}), async () => runtime, pool)
  const result = await service.run(f.state.request)
  expect(result).toMatchObject({ status: 'completed', coverage: { sources: 422, remainingSources: 0, complete: true } })
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM review_checkpoints').get()!.n).toBe(422)
  expect(f.db.listSupervisionResults()).toHaveLength(1)
  const before = calls
  await expect(service.run(f.state.request)).resolves.toMatchObject({ status: 'no_change', coverage: { sources: 0 } })
  expect(calls).toBe(before)
})

it.each(['crash', 'close'] as const)('settles writer %s before releasing pending work and can rebuild after reopening', async action => {
  const f = await fixture()
  const id = f.db.startSupervisionRun(f.state.request)
  f.db.supervisionReviewStore().prepareInitialization(id, f.state)
  const reader = new ReadonlyQueryReader('supervision', f.path, workerPath)
  const pending = reader.call('initialize', [id, f.state])
  const failure = expect(pending).rejects.toThrow()
  if (action === 'close') reader.close()
  else await reader.terminateWorkerForTest()
  await failure
  expect(reader.pendingCount).toBe(0)
  reader.close()
  await f.db.resumeSupervisionReview(id, new AbortController().signal)
  expect(f.db.supervisionReviewStore().progress(id).sources).toBe(422)
})
