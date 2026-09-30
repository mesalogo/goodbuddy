import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { AssistantDatabase } from './assistant-database'
import { SupervisorService, type SupervisorSummarizerRequest } from './supervisor-service'
import { deriveSuggestions, type SuggestionPhraser } from './supervision-suggester'
import type { SupervisionRunRequest } from '../../shared/supervision-contracts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const time = Date.now()
const request: SupervisionRunRequest = { trigger: 'heartbeat', scope: { kind: 'global' }, timeRange: {
  from: new Date(time - 10000).toISOString(), to: new Date(time + 10000).toISOString()
} }

function graph(input: SupervisorSummarizerRequest, openItem = 'Decide the review page size') {
  if (input.evidence[0]?.sourceType === 'note') return { summary: 'Navigation', changeDigest: '', openItems: [openItem] }
  const source = input.evidence[0]!.id
  const known = (label: string) => input.candidates.findIndex(candidate => candidate.label === label)
  const entity = (id: string, label: string) => ({ id, label, description: `${label} detail`, sourceReferenceIds: [source],
    ...(known(label) >= 0 ? { candidateRef: `known_${known(label) + 1}` } : {}) })
  return { summary: 'Batch', changeDigest: 'Changed', openItems: [openItem],
    events: [{ title: 'Discussed', description: 'Two approaches', occurredAt: input.evidence[0]!.occurredAt, eventType: 'discussion',
      entityIds: ['a', 'b'], sourceReferenceIds: [source] }],
    entities: [entity('a', 'Pause on budget'), entity('b', 'Run until complete')],
    entityChanges: [{ entityId: 'b', changeType: 'revised', description: 'Now runs until complete', sourceReferenceIds: [source] }],
    relations: [{ fromEntityId: 'a', toEntityId: 'b', relationType: 'contrasts', reason: 'Conflicting scheduling rules', sourceReferenceIds: [source] }] }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-suggestions-'))
  const path = join(directory, 'assistant.sqlite')
  const db = new AssistantDatabase(path)
  db.initialize(directory)
  const sql = new DatabaseSync(path)
  cleanups.push(async () => { sql.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
  const project = db.listProjects()[0]!
  const messageId = randomUUID()
  db.replaceConversations([{ id: randomUUID(), projectId: project.id, title: 'Scheduling', updatedAt: time,
    messages: [{ id: messageId, role: 'user', content: 'Should reviews pause after 300 seconds?', createdAt: time, state: 'complete' }] }])
  let openItem = 'Decide the review page size'
  const summarize = vi.fn(async (input: SupervisorSummarizerRequest) => graph(input, openItem))
  const service = new SupervisorService({ collect: async () => [] }, { summarize }, {
    scope: scope => db.resolveReviewScope(scope), start: (input, heartbeat) => db.startSupervisionRun(input, heartbeat),
    fail: (id, error) => db.failSupervisionRun(id, error), noChange: id => db.noChangeSupervisionRun(id),
    candidates: async input => db.listSupervisionCandidates(input), save: async result => db.saveSupervisionResult(result)
  }, { database: () => db.supervisionReviewStore(), configuration: async () => ({ version: 1, pageSize: 50,
    batchCharacters: 8000, batchMessages: 20, concurrency: 1, timeoutSeconds: 30, executionSeconds: 300 }) })
  return { db, sql, project, messageId, summarize, service, setOpenItem: (value: string) => { openItem = value } }
}

it('phrases only rule-selected candidates in one call and never re-reads sources', async () => {
  const f = await fixture()
  const run = await f.service.run(request)
  const phrase = vi.fn<SuggestionPhraser>(async ({ candidates }) => ({ suggestions: candidates.map(candidate => ({
    ref: candidate.ref, title: `Look at ${candidate.title}`, detail: candidate.detail })) }))
  const count = await deriveSuggestions(f.db.supervisionSuggestions(), phrase, { supervisionRunId: run.runId!, heartbeatRunId: 'h1' })
  expect(phrase).toHaveBeenCalledOnce()
  const input = phrase.mock.calls[0]![0]
  expect(JSON.stringify(input)).not.toContain('Should reviews pause after 300 seconds?')
  expect(input.candidates.map(candidate => candidate.kind).sort()).toEqual(['conflict', 'open_item', 'revision'])
  expect(count).toBe(3)
  const saved = f.db.supervisionSuggestions().list('pending', 50, 0)
  expect(saved).toHaveLength(3)
  expect(saved.every(item => item.sourceIds.length > 0 && item.title.startsWith('Look at'))).toBe(true)
  const sourceIds = new Set((f.db.getSupervisionGraph({ resultId: saved[0]!.resultId! }).sources as Array<{ id: string }>).map(source => source.id))
  expect(saved.every(item => item.sourceIds.every(id => sourceIds.has(id)))).toBe(true)
})

it('skips the model when there are no candidates and does not repeat pending or dismissed suggestions without new evidence', async () => {
  const f = await fixture()
  const store = f.db.supervisionSuggestions()
  const phrase = vi.fn<SuggestionPhraser>(async () => ({ suggestions: [] }))
  const first = await f.service.run(request)
  expect(await deriveSuggestions(store, phrase, { supervisionRunId: first.runId!, heartbeatRunId: 'h1' })).toBe(3)
  // Same facts published again: nothing new to suggest, so no model call.
  f.sql.prepare('DELETE FROM review_checkpoints').run()
  const second = await f.service.run(request)
  expect(phrase).toHaveBeenCalledTimes(1)
  expect(await deriveSuggestions(store, phrase, { supervisionRunId: second.runId!, heartbeatRunId: 'h2' })).toBe(0)
  expect(phrase).toHaveBeenCalledTimes(1)
  const open = store.list('pending', 50, 0).find(item => item.kind === 'open_item')!
  f.db.resolveSupervisionSuggestion(open.id, 'dismiss')
  f.sql.prepare('DELETE FROM review_checkpoints').run()
  const third = await f.service.run(request)
  expect(await deriveSuggestions(store, phrase, { supervisionRunId: third.runId!, heartbeatRunId: 'h3' })).toBe(0)
  // New evidence for a dismissed item raises it again.
  f.sql.prepare('UPDATE messages SET content = ? WHERE id = ?').run('Page size is still undecided after testing', f.messageId)
  const fourth = await f.service.run(request)
  expect(await deriveSuggestions(store, phrase, { supervisionRunId: fourth.runId!, heartbeatRunId: 'h4' })).toBe(1)
})

it('turns accepted open items into paused tasks and conventions into confirmed background', async () => {
  const f = await fixture()
  const run = await f.service.run(request)
  await deriveSuggestions(f.db.supervisionSuggestions(), async () => ({ suggestions: [] }), { supervisionRunId: run.runId!, heartbeatRunId: 'h1' })
  const open = f.db.supervisionSuggestions().list('pending', 50, 0).find(item => item.kind === 'open_item')!
  const accepted = f.db.resolveSupervisionSuggestion(open.id, 'accept')
  expect(accepted).toMatchObject({ status: 'accepted', taskId: expect.any(String) })
  expect(f.db.listTasks().find(task => task.id === accepted.taskId)).toMatchObject({ status: 'paused', origin: 'assistant' })
  expect(() => f.db.resolveSupervisionSuggestion(open.id, 'accept')).toThrow()

  const memory = f.db.createMemory({ scope: 'global', type: 'preference', content: 'Prefer Chinese replies' })
  f.db.setMemoryStatus(memory.id, 'proposed')
  f.sql.prepare(`INSERT INTO supervision_suggestions (id, scope_json, kind, fingerprint, title, detail, memory_id, status, created_at, updated_at)
    VALUES (?, ?, 'convention', ?, 'Prefer Chinese replies', 'Prefer Chinese replies', ?, 'pending', ?, ?)`)
    .run(randomUUID(), JSON.stringify({ kind: 'global' }), `memory:${memory.id}`, memory.id, new Date().toISOString(), new Date().toISOString())
  const convention = f.db.supervisionSuggestions().list('pending', 50, 0).find(item => item.kind === 'convention')!
  f.db.resolveSupervisionSuggestion(convention.id, 'accept')
  expect(f.db.listMemories().find(item => item.id === memory.id)?.status).toBe('confirmed')
})

it('carries pending heartbeat memory proposals forward on upgrade without confirming them', async () => {
  const f = await fixture()
  const config = f.db.createHeartbeatConfig({ name: 'Old', scope: { kind: 'global' }, timezone: 'UTC',
    recurrence: { type: 'daily', localTime: '09:00' }, enabled: true, lookbackHours: 24, retentionDays: 30 })
  const claim = f.db.claimHeartbeatNow(config.id, 'legacy', 'test')
  f.db.completeHeartbeatRun(claim, { summary: 'Legacy report', highlights: [], followUpTasks: [], proposedMemories: [
    { scope: 'global', type: 'preference', content: 'Keep answers short', confidence: 0.8, salience: 0.8 }] })
  f.sql.exec(`DROP TABLE supervision_suggestions; ALTER TABLE heartbeat_configs DROP COLUMN intervention;
    ALTER TABLE heartbeat_runs DROP COLUMN suggestion_status; ALTER TABLE heartbeat_runs DROP COLUMN suggestion_error; PRAGMA user_version = 49;`)
  f.db.close()
  f.db.initialize(process.cwd())
  expect(f.db.getHeartbeatConfig(config.id).intervention).toBe('suggest')
  const [carried] = f.db.supervisionSuggestions().list('pending', 50, 0)
  expect(carried).toMatchObject({ kind: 'convention', detail: 'Keep answers short', status: 'pending' })
  expect(f.db.listMemories().find(memory => memory.content === 'Keep answers short')?.status).toBe('proposed')
  expect(f.db.listHeartbeatEntries(config.id)).toHaveLength(1)
})
