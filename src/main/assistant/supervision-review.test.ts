import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { AssistantDatabase } from './assistant-database'
import { SupervisorService, type SupervisorSummarizerRequest } from './supervisor-service'
import type { SupervisionRunRequest } from '../../shared/supervision-contracts'
import type { ReviewConfiguration } from './supervision-review-store'
import { HeartbeatService } from './heartbeat-service'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup() })
const time = Date.now()
// Explicit re-analysis: reads the whole interval and never moves automatic progress.
const request: SupervisionRunRequest = { trigger: 'manual', reanalyze: true, scope: { kind: 'global' }, timeRange: {
  from: new Date(time - 10000).toISOString(), to: new Date(time + 10000).toISOString()
} }
const empty = { summary: 'Navigation', changeDigest: '', openItems: [], events: [], entities: [], entityChanges: [], relations: [] }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

it('reserves before setup, rejects manual and resume overlap, and lets automatic work wait for settlement', async () => {
  const f = await fixture([['Evidence']])
  const service = f.service()
  const entered = deferred(), finish = deferred()
  f.summarize.mockImplementationOnce(async () => { entered.resolve(); await finish.promise; return empty })
  const first = service.run(request)
  expect(service.execution()).toMatchObject({ active: true })
  await expect(service.run(request)).rejects.toThrow('SUPERVISION_REVIEW_BUSY')
  await entered.promise
  const runId = service.execution().runId!
  await expect(service.resume(runId)).rejects.toThrow('SUPERVISION_REVIEW_BUSY')
  const automatic = service.run({ ...request, trigger: 'heartbeat' })
  const nextAutomatic = service.run({ ...request, trigger: 'heartbeat' })
  expect(f.db.listSupervisionActivity()).toHaveLength(1)
  finish.resolve()
  await expect(first).resolves.toMatchObject({ status: 'completed' })
  await expect(automatic).resolves.toMatchObject({ status: 'completed' })
  await expect(nextAutomatic).resolves.toMatchObject({ status: 'no_change' })
  expect(service.execution().active).toBe(false)
  expect(f.db.listSupervisionActivity()).toHaveLength(3)
  expect(f.summarize).toHaveBeenCalledTimes(2)
})

it('persists cancellation immediately but holds the slot until every in-flight batch settles', async () => {
  const f = await fixture([['First'], ['Second']])
  const service = f.service()
  const entered = deferred(), finish = deferred()
  const signals: AbortSignal[] = []
  f.summarize.mockImplementation(async input => {
    signals.push(input.signal!)
    if (signals.length === 2) entered.resolve()
    await finish.promise
    return empty // Simulate a provider that returns a late success after abort.
  })
  const pending = service.run({ ...request, trigger: 'heartbeat' })
  await entered.promise
  const runId = service.execution().runId!
  let cancelled = false
  const cancellation = service.cancel(runId).then(() => { cancelled = true })
  expect(f.db.listSupervisionActivity()[0]).toMatchObject({ status: 'cancelled', supervisionStatus: 'cancelled', resultId: null })
  expect(signals.every(signal => signal.aborted)).toBe(true)
  expect(service.execution()).toEqual({ active: true, runId, stopping: 'cancelled' })
  await expect(service.run(request)).rejects.toThrow('SUPERVISION_REVIEW_BUSY')
  await expect(service.resume(runId)).rejects.toThrow('SUPERVISION_REVIEW_BUSY')
  expect(cancelled).toBe(false)
  service.pause(runId)
  finish.resolve()
  await cancellation
  await expect(pending).resolves.toMatchObject({ status: 'cancelled' })
  expect(service.execution().active).toBe(false)
  expect(f.db.supervisionReviewStore().batches(runId)).toEqual([])
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM review_checkpoints').get()!.n).toBe(0)
  expect(f.db.listSupervisionResults()).toEqual([])
  await expect(service.resume(runId)).rejects.toThrow('SUPERVISION_REVIEW_CANCELLED')
  expect(f.db.listSupervisionActivity()[0]!.status).toBe('cancelled')
  await service.cancel(runId)
  f.summarize.mockResolvedValue(empty)
  const next = await service.run({ ...request, trigger: 'heartbeat' })
  expect(next.runId).not.toBe(runId)
  expect(next.status).toBe('completed')
})

it.each(['paused', 'failed'] as const)('allows a new review after %s and can cancel retained work without publishing checkpoints', async status => {
  const f = await fixture([['x'.repeat(2500)]], { concurrency: 1 })
  const service = f.service()
  f.summarize.mockResolvedValueOnce(empty).mockImplementationOnce(async () => {
    if (status === 'failed') throw new Error('Provider failed')
    service.pause(service.execution().runId!)
    return empty
  })
  const first = service.run({ ...request, trigger: 'heartbeat' })
  if (status === 'failed') await expect(first).rejects.toThrow('Provider failed')
  else await expect(first).resolves.toMatchObject({ status })
  const runId = f.db.listSupervisionActivity()[0]!.id
  expect(f.db.supervisionReviewStore().batches(runId)).toHaveLength(1)
  await expect(service.run(request)).resolves.toMatchObject({ status: 'completed' })
  await service.cancel(runId)
  await expect(service.resume(runId)).rejects.toThrow('SUPERVISION_REVIEW_CANCELLED')
  expect(f.db.supervisionReviewStore().batches(runId)).toHaveLength(1)
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM review_checkpoints').get()!.n).toBe(0)
  f.db.close(); f.db.initialize(f.directory)
  expect(f.db.listSupervisionActivity().find(row => row.id === runId)!.status).toBe('cancelled')
  await expect(f.service().resume(runId)).rejects.toThrow('SUPERVISION_REVIEW_CANCELLED')
})

it('cancels navigation without publishing fully extracted source checkpoints', async () => {
  const f = await fixture([['x'.repeat(1500)]], { concurrency: 1 })
  const service = f.service()
  const entered = deferred(), finish = deferred()
  f.summarize.mockResolvedValueOnce(empty).mockResolvedValueOnce(empty).mockImplementationOnce(async () => {
    entered.resolve(); await finish.promise; return empty
  })
  const pending = service.run({ ...request, trigger: 'heartbeat' })
  await entered.promise
  const runId = service.execution().runId!
  const cancellation = service.cancel(runId)
  finish.resolve()
  await cancellation
  await expect(pending).resolves.toMatchObject({ status: 'cancelled', coverage: { batches: 2, remainingSources: 0, complete: false } })
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM review_checkpoints').get()!.n).toBe(0)
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM supervision_review_navigation').get()!.n).toBe(0)
  expect(f.db.listSupervisionResults()).toEqual([])
})

it('projects cancellation into heartbeat activity while runtime cleanup is still pending', async () => {
  const f = await fixture([['Evidence']])
  const service = f.service()
  const entered = deferred(), finish = deferred()
  f.summarize.mockImplementationOnce(async () => { entered.resolve(); await finish.promise; return empty })
  const heartbeat = new HeartbeatService(f.db, { review: async ({ run }) => {
    const result = await service.run({ ...request, trigger: 'heartbeat' }, run.id)
    return { status: result.status ?? 'completed', runId: result.runId }
  } })
  const config = heartbeat.create({ name: 'Review', scope: request.scope, timezone: 'UTC',
    recurrence: { type: 'daily', localTime: '09:00' }, enabled: true, lookbackHours: 24, retentionDays: 30 })
  const pending = heartbeat.runNow({ id: config.id, idempotencyKey: randomUUID() })
  await entered.promise
  const runId = service.execution().runId!
  const cancellation = service.cancel(runId)
  expect(f.db.listSupervisionActivity()).toEqual([expect.objectContaining({ kind: 'heartbeat', status: 'cancelled',
    heartbeatStatus: 'completed', supervisionStatus: 'cancelled', completedAt: expect.any(String), reviewProgress: expect.objectContaining({ runId }) })])
  finish.resolve()
  await cancellation
  await pending
  expect(f.db.listSupervisionActivity()[0]!.status).toBe('cancelled')
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM review_checkpoints WHERE stage = ?').get('supervisor')!.n).toBe(0)
})

it.each(['paused', 'failed', 'cancelled'] as const)('wakes waiting automatic work after %s without overlapping requests', async status => {
  const f = await fixture([['Evidence']])
  const service = f.service()
  const entered = deferred(), finish = deferred()
  f.summarize.mockImplementationOnce(async () => {
    entered.resolve(); await finish.promise
    if (status === 'failed') throw new Error('Provider failed')
    return empty
  })
  const pending = service.run(request)
  const outcome = status === 'failed' ? expect(pending).rejects.toThrow('Provider failed')
    : expect(pending).resolves.toMatchObject({ status })
  await entered.promise
  const runId = service.execution().runId!
  const automatic = service.run({ ...request, trigger: 'heartbeat' })
  const cancellation = status === 'cancelled' ? service.cancel(runId) : undefined
  if (status === 'paused') service.pause(runId)
  expect(f.summarize).toHaveBeenCalledTimes(1)
  expect(f.db.listSupervisionActivity()).toHaveLength(1)
  finish.resolve()
  await cancellation
  await outcome
  await expect(automatic).resolves.toMatchObject({ status: 'completed' })
  expect(f.summarize).toHaveBeenCalledTimes(2)
  expect(service.execution().active).toBe(false)
})

async function fixture(contents: string[][], overrides: Partial<ReviewConfiguration> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-review-'))
  const path = join(directory, 'assistant.sqlite')
  const db = new AssistantDatabase(path)
  db.initialize(directory)
  const sql = new DatabaseSync(path)
  cleanups.push(async () => { sql.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
  const project = db.listProjects()[0]!
  const conversations = contents.map((messages, index) => ({ id: randomUUID(), projectId: project.id,
    title: `Conversation ${index}`, updatedAt: time, messages: messages.map(content => ({ id: randomUUID(),
      role: 'user' as const, content, createdAt: time, state: 'complete' as const })) }))
  db.replaceConversations(conversations)
  const summarize = vi.fn(async (input: SupervisorSummarizerRequest) => ({ ...empty,
    events: input.evidence[0]?.sourceType === 'note' ? [] : input.evidence.map(source => ({
      title: 'Retained fact', description: 'Model claim', occurredAt: source.occurredAt, eventType: 'discussion' as const,
      entityIds: [], sourceReferenceIds: [source.id]
    })) }))
  const config: ReviewConfiguration = { version: 1, pageSize: 3, batchCharacters: 1000, batchMessages: 10,
    concurrency: 2, timeoutSeconds: 30, executionSeconds: 300, ...overrides }
  const service = () => new SupervisorService({ collect: async () => { throw new Error('Legacy collector used') } }, { summarize }, {
    scope: scope => db.resolveReviewScope(scope), start: (input, heartbeat) => db.startSupervisionRun(input, heartbeat),
    fail: (id, error) => db.failSupervisionRun(id, error), noChange: id => db.noChangeSupervisionRun(id),
    save: async result => db.saveSupervisionResult(result)
  }, { database: () => db.supervisionReviewStore(), configuration: async () => config })
  return { db, sql, conversations, summarize, service, config, directory }
}

it('exhausts more than 20 conversations and 20 messages, preserves all leaf facts and manual checkpoint isolation', async () => {
  const f = await fixture(Array.from({ length: 22 }, () => Array.from({ length: 23 }, () => 'Evidence 🧭 e\u0301')))
  const result = await f.service().run(request)
  expect(result.status).toBe('completed')
  expect(result.coverage).toMatchObject({ sources: 506, remainingSources: 0, complete: true })
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM review_checkpoints').get()!.n).toBe(0)
  const rows = f.db.supervisionReviewStore().batches(result.runId!, 1000)
  expect(rows.flatMap(row => row.evidence)).toHaveLength(506)
  expect(rows.flatMap(row => row.output.events)).toHaveLength(506)
  expect(f.summarize).toHaveBeenCalledTimes(rows.length * 2 - 1)
  expect(f.db.listSupervisionActivity()[0]!.reviewProgress?.complete).toBe(true)
})

it('reopens saved batches after failure, resumes exact Unicode offsets and only then commits automatic checkpoints', async () => {
  const body = '中文🧭e\u0301'.repeat(800)
  const f = await fixture([[body]], { concurrency: 1 })
  f.summarize.mockImplementationOnce(async () => empty).mockRejectedValueOnce(new Error('Provider failed'))
  const auto = { ...request, trigger: 'heartbeat' as const }
  await expect(f.service().run(auto)).rejects.toThrow('Provider failed')
  const runId = f.db.listSupervisionActivity()[0]!.id
  const saved = f.db.supervisionReviewStore().batches(runId)
  expect(saved).toHaveLength(1)
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM review_checkpoints').get()!.n).toBe(0)
  f.db.close(); f.db.initialize(f.directory)
  const result = await f.service().resume(runId)
  expect(result.status).toBe('completed')
  const evidence = f.db.supervisionReviewStore().batches(runId, 1000).flatMap(row => row.evidence)
  expect(evidence.map(item => item.content).join('')).toBe(body)
  let offset = 0
  for (const item of evidence) {
    expect(item.locator!.start).toBe(offset)
    offset += Array.from(item.content).length
    expect(item.locator!.end).toBe(offset)
    expect(item.content).not.toMatch(/[\uD800-\uDBFF]$/)
  }
  expect(f.db.supervisionReviewStore().batches(runId)[0]).toEqual(saved[0])
  expect(f.sql.prepare('SELECT processed_offset, source_length FROM review_checkpoints').get()).toEqual({ processed_offset: offset, source_length: offset })
  const calls = f.summarize.mock.calls.length
  expect((await f.service().run(auto)).status).toBe('no_change')
  expect(f.summarize).toHaveBeenCalledTimes(calls)
})

it('continues extraction and navigation beyond the saved execution budget', async () => {
  const f = await fixture([['x'.repeat(2500)]], { concurrency: 1, executionSeconds: 30 })
  const clock = vi.spyOn(Date, 'now').mockReturnValue(time)
  f.summarize.mockImplementationOnce(async () => { clock.mockReturnValue(time + 31000); return empty })
  const result = await f.service().run(request)
  expect(result.status).toBe('completed')
  expect(result.coverage).toMatchObject({ batches: 3, remainingSources: 0, complete: true })
  expect(f.summarize).toHaveBeenCalledTimes(5)
  expect(f.db.supervisionReviewStore().batches(result.runId!, 100).flatMap(row => row.evidence).map(row => row.content.length)).toEqual([1000, 1000, 500])
  clock.mockRestore()
})

it('still pauses on user request and resumes saved batches without changing batch settings', async () => {
  const f = await fixture([['x'.repeat(2500)]], { concurrency: 1 })
  const service = f.service()
  f.summarize.mockImplementationOnce(async () => empty).mockImplementationOnce(async () => {
    service.pause(f.db.listSupervisionActivity()[0]!.id)
    return empty
  })
  const result = await service.run(request)
  expect(result.status).toBe('paused')
  expect(result.coverage).toMatchObject({ batches: 1, remainingSources: 1, complete: false })
  f.config.batchCharacters = 16000
  expect((await f.service().resume(result.runId!)).status).toBe('completed')
  expect(f.db.supervisionReviewStore().batches(result.runId!, 100).flatMap(row => row.evidence).map(row => row.content.length)).toEqual([1000, 1000, 500])
})

it('rejects changed source versions and rolls back offsets when batch persistence fails', async () => {
  const f = await fixture([['x'.repeat(2500)]], { concurrency: 1 })
  f.sql.exec("CREATE TRIGGER fail_batch BEFORE INSERT ON supervision_review_batches BEGIN SELECT RAISE(ABORT, 'disk failure'); END")
  await expect(f.service().run(request)).rejects.toThrow('disk failure')
  const runId = f.db.listSupervisionActivity()[0]!.id
  expect(f.db.supervisionReviewStore().progress(runId).characters).toBe(0)
  expect(f.sql.prepare('SELECT processed_offset FROM supervision_review_sources').get()!.processed_offset).toBe(0)
  f.sql.exec('DROP TRIGGER fail_batch')
  f.sql.prepare('UPDATE messages SET content = ? WHERE id = ?').run('Changed', f.conversations[0]!.messages[0]!.id)
  await expect(f.service().resume(runId)).rejects.toThrow('source changed')
  expect(f.db.listSupervisionActivity()[0]!.status).toBe('failed')
})

it('round-robins projects and conversations and keeps semantic chunks independent of database page size', async () => {
  const f = await fixture([['a'.repeat(2500)], ['b'.repeat(2500)], ['c'.repeat(2500)]], { concurrency: 1, pageSize: 1 })
  const other = f.db.createProject({ name: 'Other', description: '', rootPath: process.cwd(), defaultWorkMode: 'ask' })
  f.sql.prepare('UPDATE conversations SET project_id = ? WHERE id = ?').run(other.id, f.conversations[2]!.id)
  await f.service().run(request)
  const leaves = f.summarize.mock.calls.map(([call]) => call.evidence).filter(items => items[0]?.sourceType === 'conversation')
  expect(new Set(leaves.slice(0, 2).map(items => items[0]!.locator!.projectId)).size).toBe(2)
  const first = leaves.map(items => items.map(item => item.content))
  f.summarize.mockClear()
  f.config.pageSize = 200
  await f.service().run(request)
  expect(f.summarize.mock.calls.map(([call]) => call.evidence).filter(items => items[0]?.sourceType === 'conversation').map(items => items.map(item => item.content))).toEqual(first)
})

it('retains successful navigation and leaf batches after final publication failure and resumes without model calls', async () => {
  const f = await fixture([['x'.repeat(3500)]], { concurrency: 1 })
  f.sql.exec("CREATE TRIGGER fail_publication BEFORE INSERT ON supervision_results BEGIN SELECT RAISE(ABORT, 'Publication failed'); END")
  await expect(f.service().run({ ...request, trigger: 'heartbeat' })).rejects.toThrow('Publication failed')
  const runId = f.db.listSupervisionActivity()[0]!.id
  expect(f.db.supervisionReviewStore().progress(runId)).toMatchObject({ batches: 4, remainingSources: 0, complete: false })
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM review_checkpoints').get()!.n).toBe(0)
  const calls = f.summarize.mock.calls.length
  f.sql.exec('DROP TRIGGER fail_publication')
  await f.service().resume(runId)
  expect(f.summarize).toHaveBeenCalledTimes(calls)
  expect(f.db.supervisionReviewStore().progress(runId).complete).toBe(true)
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM review_checkpoints').get()!.n).toBe(1)
})

it('resolves a supplied source token to its unique input fragment without expanding coverage', async () => {
  const f = await fixture([['x'.repeat(1500)]], { concurrency: 1 })
  f.summarize.mockImplementation(async input => ({ ...empty, events: input.evidence[0]?.sourceType === 'note' ? [] : [{
    title: 'Fact', description: 'A fragment claim', occurredAt: request.timeRange.to, eventType: 'discussion', entityIds: [],
    sourceReferenceIds: [String(input.evidence[0]!.locator!.source)]
  }] }))
  const result = await f.service().run(request)
  const batches = f.db.supervisionReviewStore().batches(result.runId!)
  expect(batches).toHaveLength(2)
  for (const batch of batches) expect(batch.output.events[0]!.sourceReferenceIds).toEqual([batch.evidence[0]!.id])
})

it('continues an existing automatic timeline checkpoint without rereading its successful prefix', async () => {
  const f = await fixture([['x'.repeat(3300)]], { concurrency: 1 })
  const old = f.db.collectIncrementalReview({ ...request, trigger: 'heartbeat' }, 'supervisor')
  const checkpoint = old.checkpoints[0]!
  f.sql.prepare('INSERT INTO review_checkpoints VALUES (?, ?, ?, ?, ?, ?)').run('supervisor', 'timeline',
    checkpoint.source, checkpoint.revision, checkpoint.offset, checkpoint.length)
  const result = await f.service().run({ ...request, trigger: 'heartbeat' })
  const evidence = f.db.supervisionReviewStore().batches(result.runId!).flatMap(batch => batch.evidence)
  expect(evidence[0]!.locator!.start).toBe(2000)
  expect(evidence.map(item => item.content).join('')).toBe('x'.repeat(1300))
  expect(result.coverage).toMatchObject({ characters: 1300, remainingSources: 0, complete: true })
  expect(f.sql.prepare('SELECT processed_offset FROM review_checkpoints').get()!.processed_offset).toBe(3300)
})

it('keeps old-version facts but does not permanently block automatic review after a source changes', async () => {
  const f = await fixture([['x'.repeat(2500)]], { concurrency: 1 })
  f.summarize.mockImplementationOnce(async () => empty).mockRejectedValueOnce(new Error('Provider failed'))
  const automatic = { ...request, trigger: 'heartbeat' as const }
  await expect(f.service().run(automatic)).rejects.toThrow('Provider failed')
  const runId = f.db.listSupervisionActivity()[0]!.id
  const saved = f.db.supervisionReviewStore().batches(runId)
  f.sql.prepare('UPDATE messages SET content = ? WHERE id = ?').run('New version', f.conversations[0]!.messages[0]!.id)
  await expect(f.service().resume(runId)).rejects.toThrow('source changed')
  expect(f.db.supervisionReviewStore().progress(runId).restartRequired).toBe(true)
  const result = await f.service().run(automatic)
  expect(result.runId).not.toBe(runId)
  expect(result.status).toBe('completed')
  expect(f.db.supervisionReviewStore().batches(runId)).toEqual(saved)
})

it('makes a manual review incremental by default and keeps explicit re-analysis out of shared progress', async () => {
  const f = await fixture([['Atlas decision'], ['Beacon decision']])
  const service = f.service()
  const manual = { ...request, reanalyze: undefined }
  expect((await service.run(manual)).status).toBe('completed')
  const firstCalls = f.summarize.mock.calls.length
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM review_checkpoints').get()!.n).toBe(2)
  // Unchanged sources are skipped by both a manual review and the heartbeat.
  expect((await service.run(manual)).status).toBe('no_change')
  expect((await service.run({ ...manual, trigger: 'heartbeat' })).status).toBe('no_change')
  expect(f.summarize).toHaveBeenCalledTimes(firstCalls)
  // Re-analysis reads the interval again but neither resets nor advances progress.
  const before = f.sql.prepare('SELECT * FROM review_checkpoints ORDER BY source').all()
  expect((await service.run(request)).coverage).toMatchObject({ sources: 2, complete: true })
  expect(f.sql.prepare('SELECT * FROM review_checkpoints ORDER BY source').all()).toEqual(before)
  // Only the changed source is processed next time.
  f.sql.prepare('UPDATE messages SET content = ? WHERE id = ?').run('Atlas decision revised', f.conversations[0]!.messages[0]!.id)
  expect((await service.run(manual)).coverage).toMatchObject({ sources: 1, complete: true })
})

it('does not let a heartbeat silently resume a review the user paused', async () => {
  const f = await fixture([['Evidence']])
  const service = f.service()
  const automatic = { ...request, reanalyze: undefined, trigger: 'heartbeat' as const }
  const entered = deferred(), finish = deferred()
  f.summarize.mockImplementationOnce(async () => { entered.resolve(); await finish.promise; return empty })
  const pending = service.run(automatic)
  await entered.promise
  const pausedId = service.execution().runId!
  service.pause(pausedId)
  finish.resolve()
  await expect(pending).resolves.toMatchObject({ status: 'paused' })
  const next = await service.run(automatic)
  expect(next.runId).not.toBe(pausedId)
  expect(f.db.listSupervisionActivity().find(row => row.id === pausedId)?.status).toBe('paused')
})