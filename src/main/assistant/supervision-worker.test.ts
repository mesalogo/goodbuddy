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
import { asyncSupervisionStorage } from '../../../tests/support/async-supervision-storage'

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
  const reader = new ReadonlyQueryReader('assistant', path, workerPath)
  const storage = asyncSupervisionStorage(db, undefined, reader).supervision
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
  cleanup.push(async () => { await reader.close(); sql.close(); db.close(); await rm(root, { recursive: true, force: true, maxRetries: 10 }) })
  return { root, path, db, sql, state, project, conversations, storage }
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
      await f.storage.initializeSupervisionReview(id, state, new AbortController().signal)
      const expected = rows.filter(row => scope.kind === 'global' || row.project_id === f.project.id).map(row => ({
        source: row.source, revision: hash(row.context), project_id: row.project_id,
        conversation_id: row.type === 'task' ? f.conversations[0]!.id : row.conversation_id,
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
  expect(await f.storage.supervisionContext(f.state.request)).toEqual({ summary: f.db.reviewSummary(f.state.request.scope, 'supervisor'), background: f.db.reviewBackground(f.state.request.scope) })
  expect(await f.storage.supervisionCandidates(f.state.request)).toEqual(f.db.listSupervisionCandidates(f.state.request))
})

it('rebuilds a partially written manifest after restart and validates completed legacy manifests on resume', async () => {
  const f = await fixture()
  const id = f.db.startSupervisionRun(f.state.request)
  f.sql.exec(`CREATE TRIGGER fail_manifest BEFORE INSERT ON supervision_review_sources
    WHEN (SELECT COUNT(*) FROM supervision_review_sources) >= 200 BEGIN SELECT RAISE(ABORT, 'interrupted initialization'); END`)
  await expect(f.storage.initializeSupervisionReview(id, f.state, new AbortController().signal)).rejects.toThrow('interrupted initialization')
  expect(f.db.supervisionReviewStore().progress(id).sources).toBe(200)
  expect(() => f.db.supervisionReviewStore().assertComplete(id)).toThrow('incomplete source manifest')
  f.sql.exec('DROP TRIGGER fail_manifest')
  f.db.close()
  f.db.initialize(f.root)
  await f.storage.resumeSupervisionReview(id, new AbortController().signal)
  expect(f.db.supervisionReviewStore().progress(id).sources).toBe(422)
  expect(f.db.supervisionReviewStore().load(id).initializing).toBeUndefined()
  // A source changed after freezing is re-frozen at its new version instead of failing the run.
  const changedId = f.conversations[0]!.messages[0]!.id
  f.sql.prepare('UPDATE messages SET content = ? WHERE id = ?').run('Changed', changedId)
  await f.storage.resumeSupervisionReview(id, new AbortController().signal)
  const store = f.db.supervisionReviewStore()
  expect(store.progress(id)).toMatchObject({ sources: 422, revisedSources: 1 })
  expect(store.load(id).restartRequired).toBeUndefined()
  expect(f.sql.prepare('SELECT length, processed_offset FROM supervision_review_sources WHERE run_id = ? AND source = ?')
    .get(id, `message:${changedId}`)).toMatchObject({ length: 'Changed'.length, processed_offset: 0 })
})

it.each(['paused', 'cancelled'] as const)('accepts %s during production initialization, holds the slot, and never calls the model', async status => {
  const f = await fixture()
  const pool = new SupervisionModelPool()
  cleanup.push(async () => pool.dispose())
  const run = vi.fn(async function* () { throw new Error('Model must not start'); yield { type: 'done' } })
  const service = createProductionSupervisorService(f.storage, async () => ({}), async () => ({ run, dispose: async () => {} }) as unknown as AgentRuntime, pool)
  const initialize = f.storage.initializeSupervisionReview.bind(f.storage)
  let cancellation: Promise<void> | undefined
  vi.spyOn(f.storage, 'initializeSupervisionReview').mockImplementation((id, state, signal) => {
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
    await f.storage.resumeSupervisionReview(result.runId!, new AbortController().signal)
    expect(f.db.supervisionReviewStore().progress(result.runId!).sources).toBe(422)
  }
})

it('fails explicitly when the worker entry is missing instead of running the scan on Main', async () => {
  const f = await fixture()
  const reader = new ReadonlyQueryReader('assistant', f.path, join(directory, 'missing-worker.cjs'))
  cleanup.unshift(() => reader.close())
  const id = f.db.startSupervisionRun(f.state.request)
  await expect(f.db.supervisionReviewStore().initializeWithReader(id, f.state, reader.reviewManifest(id))).rejects.toThrow()
  expect(f.db.supervisionReviewStore().load(id).initializing).toBe(true)
  expect(f.db.supervisionReviewStore().progress(id).sources).toBe(0)
})

it('worker resume omits hard-deleted owners including knowledge references and tasks', async () => {
  const f = await fixture()
  const id = f.db.startSupervisionRun(f.state.request)
  await f.storage.initializeSupervisionReview(id, f.state, new AbortController().signal)
  f.sql.prepare('DELETE FROM conversations WHERE id = ?').run(f.conversations[0]!.id)
  await f.storage.resumeSupervisionReview(id, new AbortController().signal)
  expect(f.db.supervisionReviewStore().progress(id)).toMatchObject({ sources: 210, remainingSources: 210, omittedSources: 212 })
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM supervision_review_sources WHERE run_id = ? AND conversation_id = ?').get(id, f.conversations[0]!.id)!.n).toBe(0)
})

it('drops conversation sources deleted while the worker copies its initialization manifest', async () => {
  const f = await fixture()
  const id = f.db.startSupervisionRun(f.state.request)
  f.sql.exec(`CREATE TRIGGER delete_during_manifest AFTER INSERT ON supervision_review_sources
    WHEN (SELECT COUNT(*) FROM supervision_review_sources) = 200 BEGIN
      DELETE FROM conversations WHERE id = '${f.conversations[0]!.id}';
    END`)
  await f.storage.initializeSupervisionReview(id, f.state, new AbortController().signal)
  expect(f.db.supervisionReviewStore().progress(id)).toMatchObject({ sources: 210, omittedSources: 212, remainingSources: 210 })
  expect(() => f.db.getConversation(f.conversations[0]!.id)).toThrow('对话不存在')
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
  const service = createProductionSupervisorService(f.storage, async () => ({}), async () => runtime, pool)
  const result = await service.run(f.state.request)
  expect(result).toMatchObject({ status: 'completed', coverage: { sources: 422, remainingSources: 0, complete: true } })
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM review_checkpoints').get()!.n).toBe(422)
  expect(f.db.listSupervisionResults()).toHaveLength(1)
  const before = calls
  await expect(service.run(f.state.request)).resolves.toMatchObject({ status: 'no_change', coverage: { sources: 0 } })
  expect(calls).toBe(before)
})

it.each([false, true])('production worker preserves batch candidate isolation with crossProject=%s', async crossProject => {
  const f = await fixture()
  const empty = { summary: 'Seed', changeDigest: '', openItems: [], events: [], entities: [], entityChanges: [], relations: [] }
  const projects = f.db.listProjects()
  for (const project of projects) f.db.saveSupervisionResult({
    request: { ...f.state.request, scope: project.id === f.project.id ? { kind: 'global' } : { kind: 'projects', projectIds: [project.id] } },
    evidence: [{ id: 's', sourceType: 'conversation', sourceId: randomUUID(), title: 'Seed', content: 'Seed',
      occurredAt: f.state.request.timeRange.from, locator: { projectId: project.id } }],
    output: { ...empty, entities: [{ id: 'entity', label: project.id, description: 'Owned knowledge', sourceReferenceIds: ['s'] }],
      events: [{ title: 'Seed', description: '', occurredAt: f.state.request.timeRange.from, eventType: 'discussion', entityIds: ['entity'], sourceReferenceIds: ['s'] }] }
  })
  f.sql.exec('INSERT INTO supervision_story_assigned SELECT id FROM supervision_events')
  const pool = new SupervisionModelPool()
  cleanup.push(async () => pool.dispose())
  const seen = new Set<string>()
  const runtime = { async *run(input: { prompt: string }) {
    if (!input.prompt.includes('These inputs are navigation summaries')) {
      const evidence = JSON.parse(input.prompt.split('BOUNDED EVIDENCE:\n\n')[1]!.split('\n\nReturn only JSON.')[0]!) as Array<{ locator: { projectId: string } }>
      const projectId = evidence[0]!.locator.projectId
      const candidates = JSON.parse(input.prompt.split('KNOWN ENTITIES:\n\n')[1]!.split('\n\nPREVIOUS SUMMARY')[0]!) as Array<{ label: string }>
      expect(candidates.map(item => item.label).sort()).toEqual((crossProject ? projects.map(p => p.id) : [projectId]).sort())
      seen.add(projectId)
    }
    yield { type: 'text', delta: JSON.stringify(empty) }
    yield { type: 'done' }
  }, async dispose() {} } as unknown as AgentRuntime
  const service = createProductionSupervisorService(f.storage, async () => ({ supervisionReview: supervisionReviewSettingsSchema.parse({ crossProject }) }), async () => runtime, pool)
  await expect(service.run(f.state.request)).resolves.toMatchObject({ status: 'completed', coverage: { sources: 422 } })
  expect([...seen].sort()).toEqual(projects.map(p => p.id).sort())
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM supervision_entities').get()!.n).toBe(2)
  expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})

it.each(['paused', 'cancelled'] as const)('honors %s during the final production candidate read before publishing', async action => {
  const f = await fixture()
  const pool = new SupervisionModelPool()
  cleanup.push(async () => pool.dispose())
  const runtime = { async *run() {
    yield { type: 'text', delta: JSON.stringify({ summary: 'Saved leaf', changeDigest: '', openItems: [], events: [], entities: [], entityChanges: [], relations: [] }) }
    yield { type: 'done' }
  }, async dispose() {} } as unknown as AgentRuntime
  const service = createProductionSupervisorService(f.storage, async () => ({}), async () => runtime, pool)
  const candidates = f.storage.supervisionCandidates.bind(f.storage)
  let stopped = false
  let cancellation: Promise<void> | undefined
  vi.spyOn(f.storage, 'supervisionCandidates').mockImplementation(async (...args) => {
    const result = await candidates(...args)
    const runId = service.execution().runId!
    if (!stopped && f.db.supervisionReviewStore().progress(runId).phase === 'saving') {
      stopped = true
      if (action === 'paused') service.pause(runId)
      else cancellation = service.cancel(runId)
    }
    return result
  })
  const result = await service.run(f.state.request)
  await cancellation
  expect(stopped).toBe(true)
  expect(result.status).toBe(action)
  expect(f.db.listSupervisionResults()).toEqual([])
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM review_checkpoints').get()!.n).toBe(0)
  const saved = f.db.supervisionReviewStore().batches(result.runId!, 1000)
  expect(saved.length).toBeGreaterThan(0)
  if (action === 'paused') {
    await expect(service.resume(result.runId!)).resolves.toMatchObject({ status: 'completed' })
    expect(f.db.supervisionReviewStore().batches(result.runId!, 1000)).toEqual(saved)
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM review_checkpoints').get()!.n).toBe(422)
  }
})

it.each(['crash', 'close'] as const)('settles scan %s before releasing pending work and can rebuild after reopening', async action => {
  const f = await fixture()
  const id = f.db.startSupervisionRun(f.state.request)
  f.db.supervisionReviewStore().prepareInitialization(id, f.state)
  const reader = new ReadonlyQueryReader('assistant', f.path, workerPath)
  const pending = f.db.supervisionReviewStore().resumeWithReader(id, reader.reviewManifest(id))
  const failure = expect(pending).rejects.toThrow()
  if (action === 'close') reader.close()
  else await reader.terminateWorkerForTest()
  await failure
  expect(reader.pendingCount).toBe(0)
  reader.close()
  await f.storage.resumeSupervisionReview(id, new AbortController().signal)
  expect(f.db.supervisionReviewStore().progress(id).sources).toBe(422)
})
