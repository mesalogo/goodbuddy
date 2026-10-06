// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { AssistantDatabase } from './assistant-database'
import { createProductionSupervisorService } from './supervision-production'
import { SupervisionModelPool } from './supervision-model-pool'
import { asyncSupervisionStorage } from '../../../tests/support/async-supervision-storage'
import type { AgentRuntime } from '../agent/runtime'
import type { SupervisionRunRequest } from '../../shared/supervision-contracts'
import { HeartbeatService } from './heartbeat-service'
import { deriveSuggestions } from './supervision-suggester'
import { assignStories } from './story-assignment-service'
import { extractExperiences } from './experience-extraction-service'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
const empty = { summary: 'Review', changeDigest: '', openItems: [], events: [], entities: [], entityChanges: [], relations: [] }
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function fixture(before?: (domain: string, method: string, args: unknown[]) => Promise<void>) {
  const db = new AssistantDatabase(':memory:')
  db.initialize(process.cwd())
  const pool = new SupervisionModelPool()
  cleanups.push(() => { pool.dispose(); db.close() })
  const now = Date.now()
  db.saveLocalConversations([{ header: { id: randomUUID(), projectId: db.listProjects()[0]!.id, title: 'Review', updatedAt: now },
    messages: [{ id: randomUUID(), role: 'user', content: 'A decision', state: 'complete', createdAt: now }] }])
  const request: SupervisionRunRequest = { trigger: 'manual', reanalyze: true, scope: { kind: 'global' },
    timeRange: { from: new Date(now - 1).toISOString(), to: new Date(now + 1).toISOString() } }
  const ports = asyncSupervisionStorage(db, before)
  ports.supervision.supervisionReviewStore = async () => ports.review
  ports.supervision.supervisionStories = async () => ports.stories
  ports.supervision.supervisionExperiences = async () => ports.experiences
  const service = (run: AgentRuntime['run'] = async function* (input) {
    yield { type: 'text', requestId: input.requestId, delta: JSON.stringify(empty) }
    yield { type: 'done', requestId: input.requestId }
  }) => createProductionSupervisorService(ports.supervision, async () => ({}),
    async () => ({ runtimeId: 'model', capability: 'chat', run } as AgentRuntime), pool)
  return { db, ports, service, request }
}

it('holds the execution slot through leaf and final publication commits before reading dependent results', async () => {
  const leaf = deferred(), leafCommit = deferred(), publication = deferred(), publicationCommit = deferred()
  const calls: string[] = []
  const f = fixture(async (domain, method) => {
    calls.push(`${domain}.${method}`)
    if (domain === 'review' && method === 'save') { leaf.resolve(); await leafCommit.promise }
    if (method === 'saveSupervisionResult') { publication.resolve(); await publicationCommit.promise }
  })
  const service = f.service()
  let settled = false
  const result = service.run(f.request).finally(() => { settled = true })
  await leaf.promise
  expect(f.db.supervisionReviewStore().batches(service.execution().runId!)).toEqual([])
  expect(calls).not.toContain('assistant.saveSupervisionResult')
  await expect(service.run(f.request)).rejects.toThrow('SUPERVISION_REVIEW_BUSY')
  leafCommit.resolve()
  await publication.promise
  expect(f.db.supervisionReviewStore().batches(service.execution().runId!)).toHaveLength(1)
  expect(calls).not.toContain('stories.pending')
  expect(settled).toBe(false)
  publicationCommit.resolve()
  await expect(result).resolves.toMatchObject({ status: 'completed', coverage: { complete: true, batches: 1 } })
  expect(f.db.listSupervisionResults()).toHaveLength(1)
  expect(calls.indexOf('stories.pending')).toBeGreaterThan(calls.indexOf('assistant.saveSupervisionResult'))
})

it('aborts model work immediately and retains admission until the durable cancellation commits', async () => {
  const entered = deferred(), cancellation = deferred(), cancelCommit = deferred(), modelStopped = deferred()
  const f = fixture(async (domain, method) => {
    if (domain === 'review' && method === 'cancel') { cancellation.resolve(); await cancelCommit.promise }
  })
  const service = f.service(async function* (input, signal) {
    entered.resolve()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    modelStopped.resolve()
    yield { type: 'done', requestId: input.requestId }
  })
  let settled = false
  const result = service.run(f.request).finally(() => { settled = true })
  await entered.promise
  const runId = service.execution().runId!
  const cancelled = service.cancel(runId)
  await cancellation.promise
  await modelStopped.promise
  expect(settled).toBe(false)
  expect(service.execution()).toEqual({ active: true, runId, stopping: 'cancelled' })
  await expect(service.run(f.request)).rejects.toThrow('SUPERVISION_REVIEW_BUSY')
  cancelCommit.resolve()
  await cancelled
  await expect(result).resolves.toMatchObject({ status: 'cancelled' })
  expect(f.db.listSupervisionActivity()[0]).toMatchObject({ status: 'cancelled' })
  expect(f.db.listSupervisionResults()).toEqual([])
  expect(service.execution().active).toBe(false)
})

it.each(['completed', 'failed', 'cancelled'] as const)('awaits usage and terminal task writes on %s execution', async status => {
  const usage = deferred(), usageCommit = deferred(), terminal = deferred(), terminalCommit = deferred()
  const f = fixture(async (_domain, method) => {
    if (method === 'upsertModelUsageCall') { usage.resolve(); await usageCommit.promise }
    if (method === 'updateTaskStatus') { terminal.resolve(); await terminalCommit.promise }
  })
  const service = f.service(async function* (input) {
    yield { type: 'text', requestId: input.requestId, delta: JSON.stringify(empty) }
    yield { type: 'model-usage', requestId: input.requestId, callId: 'usage', runtime: 'model', provider: 'test',
      model: 'review', inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }
    if (status === 'failed') yield { type: 'error', requestId: input.requestId, status: 'failed', message: 'Invalid model response' }
    else yield { type: 'done', requestId: input.requestId }
  })
  let settled = false
  const result = service.run(f.request).finally(() => { settled = true })
  const outcome = status === 'failed' ? expect(result).rejects.toThrow('Invalid model response')
    : expect(result).resolves.toMatchObject({ status })
  await usage.promise
  expect(f.db.getTokenUsageSummary().records).toEqual([])
  const cancellation = status === 'cancelled' ? service.cancel(service.execution().runId!) : undefined
  usageCommit.resolve()
  await terminal.promise
  expect(f.db.getTokenUsageSummary().systemTotals).toMatchObject({ input: 5, output: 2 })
  expect(settled).toBe(false)
  expect(service.execution().active).toBe(true)
  terminalCommit.resolve()
  await outcome
  await cancellation
  expect(service.execution().active).toBe(false)
})

it('does not retry a model when usage persistence fails with a transient-looking storage error', async () => {
  const f = fixture(async (_domain, method) => {
    if (method === 'upsertModelUsageCall') throw Object.assign(new Error('Storage connection reset'), { code: 'ECONNRESET' })
  })
  let calls = 0
  const service = f.service(async function* (input) {
    calls++
    yield { type: 'model-usage', requestId: input.requestId, callId: 'usage', runtime: 'model', provider: 'test',
      model: 'review', inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }
    yield { type: 'done', requestId: input.requestId }
  })
  await expect(service.run(f.request)).rejects.toThrow('Storage connection reset')
  expect(calls).toBe(1)
  expect(f.db.listSupervisionResults()).toEqual([])
})

it('waits for failure bookkeeping before rejecting and releasing the review slot', async () => {
  const failure = deferred(), failureCommit = deferred()
  const f = fixture(async (_domain, method) => {
    if (method === 'failSupervisionRun') { failure.resolve(); await failureCommit.promise }
  })
  const service = f.service(async function* (input) { yield { type: 'error', requestId: input.requestId, status: 'failed', message: 'Model failed' } })
  const result = service.run(f.request)
  const rejection = expect(result).rejects.toThrow('Model failed')
  await failure.promise
  expect(service.execution().active).toBe(true)
  expect(f.db.listSupervisionActivity()[0]).toMatchObject({ status: 'running' })
  failureCommit.resolve()
  await rejection
  expect(f.db.listSupervisionActivity()[0]).toMatchObject({ status: 'failed' })
})

it('keeps a confirmed publication successful when a late cancellation is rejected by storage', async () => {
  const stories = deferred(), continueStories = deferred()
  const f = fixture(async (domain, method) => {
    if (domain === 'stories' && method === 'pending') { stories.resolve(); await continueStories.promise }
  })
  const service = f.service()
  const result = service.run(f.request)
  await stories.promise
  const runId = service.execution().runId!
  const cancellation = expect(service.cancel(runId)).rejects.toThrow('SUPERVISION_REVIEW_NOT_CANCELLABLE')
  continueStories.resolve()
  await cancellation
  await expect(result).resolves.toMatchObject({ status: 'completed', coverage: { complete: true } })
  expect(f.db.listSupervisionActivity()[0]).toMatchObject({ status: 'completed' })
})

it('publishes suggestions before completing heartbeat suggestion status and returning', async () => {
  const publication = deferred(), publicationCommit = deferred(), completion = deferred(), completionCommit = deferred()
  const f = fixture(async (domain, method, args) => {
    if (domain === 'suggestions' && method === 'save') { publication.resolve(); await publicationCommit.promise }
    if (method === 'setHeartbeatSuggestionStatus' && args[1] === 'completed') { completion.resolve(); await completionCommit.promise }
  })
  const service = new HeartbeatService(f.ports.heartbeat, {
    review: async ({ run }) => {
      const runId = await f.ports.supervision.startSupervisionRun(f.request, run.id)
      await f.ports.supervision.saveSupervisionResult({ runId, request: f.request, evidence: [], output: { ...empty, openItems: ['Choose a release date'] } })
      return { status: 'completed', runId }
    },
    suggest: async ({ run, supervisionRunId }) => deriveSuggestions(f.ports.suggestions,
      async ({ candidates }) => ({ suggestions: candidates.map(({ ref, title, detail }) => ({ ref, title, detail })) }),
      { heartbeatRunId: run.id, supervisionRunId })
  })
  const config = await service.create({ name: 'Daily', scope: f.request.scope, timezone: 'UTC',
    recurrence: { type: 'daily', localTime: '09:00' }, enabled: true, lookbackHours: 24, retentionDays: 30 })
  let settled = false
  const result = service.runNow({ id: config.id, idempotencyKey: 'suggest' }).finally(() => { settled = true })
  await publication.promise
  expect(f.db.listSupervisionActivity()[0]).toMatchObject({ suggestionStatus: 'running', suggestionCount: 0 })
  expect(settled).toBe(false)
  publicationCommit.resolve()
  await completion.promise
  expect(f.db.listSupervisionActivity()[0]).toMatchObject({ suggestionStatus: 'running', suggestionCount: 1 })
  expect(settled).toBe(false)
  completionCommit.resolve()
  await result
  expect(f.db.listSupervisionActivity()[0]).toMatchObject({ suggestionStatus: 'completed', suggestionCount: 1 })
})

it('propagates failure to persist suggestion failure while preserving the published review', async () => {
  const f = fixture(async (_domain, method, args) => {
    if (method === 'setHeartbeatSuggestionStatus' && args[1] === 'failed') throw new Error('Storage unavailable')
  })
  const review = vi.fn(async () => ({ status: 'completed' as const, runId: 'published' }))
  const heartbeat = new HeartbeatService(f.ports.heartbeat, { review, suggest: async () => { throw new Error('Phrase failed') } })
  const config = await heartbeat.create({ name: 'Daily', scope: f.request.scope, timezone: 'UTC',
    recurrence: { type: 'daily', localTime: '09:00' }, enabled: true, lookbackHours: 24, retentionDays: 30 })
  await expect(heartbeat.runNow({ id: config.id, idempotencyKey: 'failure' })).rejects.toThrow('Storage unavailable')
  expect(f.db.listSupervisionActivity()[0]).toMatchObject({ status: 'completed' })
  expect(review).toHaveBeenCalledOnce()
})

it('awaits story assignment, thread splitting and experience application over async repository facades', async () => {
  const assigned = deferred(), assignCommit = deferred(), split = deferred(), splitCommit = deferred()
  const experience = deferred(), experienceCommit = deferred()
  const f = fixture(async (domain, method) => {
    if (domain === 'stories' && method === 'apply') { assigned.resolve(); await assignCommit.promise }
    if (domain === 'stories' && method === 'split') { split.resolve(); await splitCommit.promise }
    if (domain === 'experiences' && method === 'apply') { experience.resolve(); await experienceCommit.promise }
  })
  const projectId = f.db.listProjects()[0]!.id
  f.db.saveSupervisionResult({ request: f.request,
    evidence: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, sourceType: 'conversation', sourceId: 'fixture',
      title: `Decision ${i}`, content: `Decision ${i}`, occurredAt: f.request.timeRange.from,
      locator: { source: `message:${randomUUID()}`, revision: 'r', projectId, start: 0, end: 10 } })),
    output: { ...empty, events: Array.from({ length: 6 }, (_, i) => ({ title: `Decision ${i}`, description: `Decision ${i}`,
      occurredAt: f.request.timeRange.from, eventType: 'decision', entityIds: [], sourceReferenceIds: [`s${i}`] })) } })
  let settled = false
  const result = assignStories(f.ports.stories, async prompt => JSON.stringify(prompt.includes('You organise one large feature')
    ? { threads: [{ key: 'new_1', name: 'Thread' }], moves: [1, 2, 3].map(i => ({ event: `e_${i}`, thread: 'new_1' })) }
    : { stories: [{ key: 'new_1', level: 'feature', name: 'Feature' }],
      assignments: [1, 2, 3, 4, 5, 6].map(i => ({ event: `e_${i}`, story: 'new_1' })) }),
  f.request.scope, { crossProject: false, threadEvents: 3, batchCharacters: 8000, concurrency: 1 })
    .finally(() => { settled = true })
  await assigned.promise
  expect(f.db.supervisionStories().list(f.request.scope)).toEqual([])
  expect(settled).toBe(false)
  assignCommit.resolve()
  await split.promise
  expect(f.db.supervisionStories().list(f.request.scope)).toHaveLength(1)
  expect(settled).toBe(false)
  splitCommit.resolve()
  await expect(result).resolves.toMatchObject({ calls: 2, assigned: 6, created: 2, split: 3 })
  const extracted = extractExperiences(f.ports.experiences, async () => JSON.stringify({
    experiences: [{ key: 'new_1', statement: 'Check assumptions', formed: ['e_1'] }]
  }), { minEvents: 2, batchCharacters: 8000 })
  await experience.promise
  expect(f.db.supervisionExperiences().list()).toEqual([])
  experienceCommit.resolve()
  await expect(extracted).resolves.toMatchObject({ calls: 1, created: 1 })
  expect(f.db.supervisionExperiences().list()).toHaveLength(1)
})
