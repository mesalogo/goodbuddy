import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentRuntime } from '../agent/runtime'
import type { SupervisionEvidence, SupervisionRunRequest } from '../../shared/supervision-contracts'
import { AssistantDatabase } from './assistant-database'
import { createProductionSupervisorService, createProductionSuggestionPhraser } from './supervision-production'
import { SupervisionModelPool } from './supervision-model-pool'
import { supervisionEntitySchema } from '../../shared/supervision-contracts'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
const empty = { summary: 'Review', changeDigest: '', openItems: [], events: [], entities: [], entityChanges: [], relations: [] }

it('keeps one model across extraction, navigation, stories and experiences, and reads the next selection on retry', async () => {
  const f = fixture('A'.repeat(1500))
  let profileId: string | null = 'first'
  const phases: string[] = []
  const dispose = vi.fn(async () => {})
  const resolve = vi.fn(async (selected?: string | null) => ({
    runtimeId: 'model', capability: 'chat', requiresToolApproval: false, supportsToolExecution: false, getStatus: vi.fn(), dispose,
    run: async function* (input) {
      expect(selected).toBe('first')
      profileId = 'next'
      let output: unknown
      if (input.prompt.includes('You organise the GoodBuddy')) {
        phases.push('stories')
        output = { stories: [{ key: 'new_1', level: 'feature', name: 'Work' }],
          assignments: [{ event: 'e_1', story: 'new_1' }, { event: 'e_2', story: 'new_1' }] }
      } else if (input.prompt.includes('You distil reusable experience')) {
        phases.push('experiences')
        output = { experiences: [], applications: [] }
      } else if (input.prompt.includes('These inputs are navigation summaries')) {
        phases.push('navigation')
        output = { summary: 'Combined', changeDigest: '', openItems: [] }
      } else {
        phases.push('extraction')
        const evidence = JSON.parse(input.prompt.split('BOUNDED EVIDENCE:\n\n')[1]!.split('\n\nReturn only JSON.')[0]!) as SupervisionEvidence[]
        output = { ...empty, events: [{ title: 'Decision', description: '', eventType: 'decision',
          occurredAt: f.request.timeRange.from, entityIds: [], sourceReferenceIds: [evidence[0]!.id] }] }
      }
      yield { type: 'text', requestId: input.requestId, delta: JSON.stringify(output) }
      yield { type: 'done', requestId: input.requestId }
    }
  } as AgentRuntime))
  const pool = new SupervisionModelPool()
  cleanups.push(() => pool.dispose())
  const service = createProductionSupervisorService(f.db, async () => ({ supervisorModelProfileId: profileId,
    supervisionReview: { pageSize: 10, batchCharacters: 1000, batchMessages: 10, executionSeconds: 300, experienceMinEvents: 2 } }), resolve, pool)
  const result = await service.run(f.request)
  expect(phases).toEqual(['extraction', 'extraction', 'navigation', 'stories', 'experiences'])
  expect(resolve).toHaveBeenCalledExactlyOnceWith('first')
  expect(dispose).toHaveBeenCalledOnce()
  await service.organizeStoriesFor(result.runId!)
  expect(resolve).toHaveBeenLastCalledWith('next')
  expect(dispose).toHaveBeenCalledTimes(2)
})

it('releases a failed review runtime and uses the current model when continuing saved work', async () => {
  const f = fixture()
  let profileId: string | null = 'first'
  const dispose = vi.fn(async () => {})
  const resolve = vi.fn(async (selected?: string | null) => ({ runtimeId: 'model', capability: 'chat',
    requiresToolApproval: false, supportsToolExecution: false, getStatus: vi.fn(), dispose,
    run: async function* (input) {
      if (selected === 'first') throw new Error('Provider unavailable')
      yield { type: 'text', requestId: input.requestId, delta: JSON.stringify(empty) }
      yield { type: 'done', requestId: input.requestId }
    }
  } as AgentRuntime))
  const pool = new SupervisionModelPool()
  cleanups.push(() => pool.dispose())
  const service = createProductionSupervisorService(f.db, async () => ({ supervisorModelProfileId: profileId }), resolve, pool)
  await expect(service.run(f.request)).rejects.toThrow('Provider unavailable')
  expect(dispose).toHaveBeenCalledOnce()
  expect(service.execution().active).toBe(false)
  profileId = null
  await expect(service.resume(f.db.listSupervisionActivity()[0]!.id)).resolves.toMatchObject({ status: 'completed' })
  expect(resolve.mock.calls).toEqual([['first'], [null]])
  expect(dispose).toHaveBeenCalledTimes(2)
})

it('uses the supervisor selection for suggestions and disposes its runtime on failure', async () => {
  const f = fixture()
  const dispose = vi.fn(async () => {})
  const resolve = vi.fn(async () => ({ runtimeId: 'model', capability: 'chat', requiresToolApproval: false, supportsToolExecution: false, getStatus: vi.fn(), dispose,
    run: async function* (input) { yield { type: 'error', requestId: input.requestId, message: 'Provider unavailable' } }
  } as AgentRuntime))
  const pool = new SupervisionModelPool()
  cleanups.push(() => pool.dispose())
  const phrase = createProductionSuggestionPhraser(f.db, async () => ({ supervisorModelProfileId: 'reviewer' }), resolve, pool)
  await expect(phrase({ systemInstruction: 'Suggest', outputContract: '{}', candidates: [] })).rejects.toThrow('Provider unavailable')
  expect(resolve).toHaveBeenCalledExactlyOnceWith('reviewer')
  expect(dispose).toHaveBeenCalledOnce()
})

it('production six-leaf merge failure resumes navigation-only JSON and publishes all retained facts', async () => {
  const f = fixture('A'.repeat(765))
  const now = Date.parse(f.request.timeRange.from) + 1
  for (let index = 0; index < 5; index++) f.db.saveLocalConversations([{
    header: { id: randomUUID(), projectId: f.db.listProjects()[0]!.id, title: `Conversation ${index}`, updatedAt: now },
    messages: [{ id: randomUUID(), role: 'user', state: 'complete', content: 'B'.repeat(750), createdAt: now }]
  }])
  const leaf = f.respond.getMockImplementation()!
  let merges = 0
  f.respond.mockImplementation(prompt => {
    if (!prompt.includes('These inputs are navigation summaries')) return leaf(prompt)
    // The second merge is unusable on both attempts (one retry), so the run fails there.
    if (++merges === 2 || merges === 3) return { summary: 'Invalid navigation', changeDigest: '', openItems: [], events: [{ sourceReferenceIds: ['invented'] }] }
    return { summary: 'Combined navigation', changeDigest: 'Retained leaf decisions', openItems: ['Check sources'] }
  })
  await expect(f.service().run(f.request)).rejects.toThrow()
  const failed = f.db.listSupervisionActivity().find(item => item.status === 'failed')!
  expect(failed.reviewProgress).toMatchObject({ phase: 'summarizing', batches: 6, characters: 4515, remainingSources: 0, complete: false, navigationNodes: 1 })
  const saved = f.db.supervisionReviewStore().batches(failed.id)
  expect(saved).toHaveLength(6)
  expect(f.db.listSupervisionResults()).toHaveLength(0)
  const before = f.respond.mock.calls.length
  const resumed = await f.service().resume(failed.id)
  expect(resumed.status).toBe('completed')
  expect(resumed.coverage).toMatchObject({ phase: 'saving', navigationNodes: 5, complete: true })
  expect(f.respond.mock.calls.length - before).toBe(4)
  expect(f.respond.mock.calls.slice(before).every(([prompt]) => prompt.includes('These inputs are navigation summaries'))).toBe(true)
  expect(f.db.supervisionReviewStore().batches(failed.id)).toEqual(saved)
  expect(f.db.listSupervisionCandidates(f.request)).toHaveLength(12)
  expect(f.db.supervisionReviewStore().progress(failed.id)).toMatchObject({ phase: 'saving', complete: true, navigationNodes: 5 })
})

it.each(['missing arrays', 'unknown source', 'unknown entity'])('production leaf rejects %s without saving coverage or publishing', async mode => {
  const f = fixture()
  f.respond.mockImplementation(() => mode === 'missing arrays' ? { summary: 'Navigation only', changeDigest: '', openItems: [] }
    : { ...empty, events: [{ title: 'Decision', description: '', occurredAt: f.request.timeRange.from, eventType: 'decision',
      sourceReferenceIds: mode === 'unknown source' ? ['invented'] : [], entityIds: mode === 'unknown entity' ? ['invented'] : [] }] })
  await expect(f.service().run(f.request)).rejects.toThrow()
  expect(f.db.listSupervisionActivity()[0]!.reviewProgress).toMatchObject({ phase: 'extracting', batches: 0, remainingSources: 1, complete: false })
  expect(f.db.listSupervisionResults()).toHaveLength(0)
  expect(f.respond).toHaveBeenCalledTimes(3)
})

it('persists publication failure and resumes with saved navigation without model calls', async () => {
  const f = fixture('A'.repeat(1500))
  const summary = 'Retained navigation detail. '.repeat(500)
  const description = 'Retained source qualification. '.repeat(100)
  const leaf = f.respond.getMockImplementation()!
  f.respond.mockImplementation(prompt => {
    if (prompt.includes('These inputs are navigation summaries')) {
      const evidence = JSON.parse(prompt.split('BOUNDED EVIDENCE:\n\n')[1]!.split('\n\nReturn only JSON.')[0]!) as SupervisionEvidence[]
      expect(evidence.map(item => item.content)).toEqual([summary, summary])
      return { summary, changeDigest: 'Change. '.repeat(600), openItems: ['Open item. '.repeat(60)] }
    }
    return { ...(leaf(prompt) as typeof empty), summary, events: [{ title: 'Decision', description,
      occurredAt: f.request.timeRange.from, eventType: 'decision', entityIds: [], sourceReferenceIds: [] }] }
  })
  const save = vi.spyOn(f.db, 'saveSupervisionResult').mockImplementationOnce(() => { throw new Error('Publication failed') })
  await expect(f.service().run(f.request)).rejects.toThrow('Publication failed')
  const failed = f.db.listSupervisionActivity()[0]!
  expect(failed.reviewProgress).toMatchObject({ phase: 'saving', batches: 2, navigationNodes: 1, remainingSources: 0, complete: false })
  const before = f.respond.mock.calls.length
  save.mockRestore()
  await expect(f.service().resume(failed.id)).resolves.toMatchObject({ status: 'completed', output: { summary } })
  expect(f.respond).toHaveBeenCalledTimes(before)
  expect(f.db.listSupervisionResults()[0]!.summary).toBe(summary)
  expect(f.db.reviewSummary(f.request.scope, 'supervisor')).toBe(summary)
  expect(f.db.getSupervisionGraph({ resultId: f.db.listSupervisionResults()[0]!.id }).events)
    .toEqual([expect.objectContaining({ description }), expect.objectContaining({ description })])
  const batches = f.db.supervisionReviewStore().batches(failed.id)
  expect(batches).toHaveLength(2)
  for (const batch of batches) {
    expect(batch.output.summary).toBe(summary)
    expect(batch.output.events[0]!.description).toBe(description)
  }
  const calls = f.respond.mock.calls.length
  expect(f.db.readStoryGraph('story_graph_search', { query: 'Retained source qualification', scope: { kind: 'global' }, object_types: ['event'] }))
    .toMatchObject({ page: { total_count: 2 }, items: [expect.objectContaining({ source_reference_ids: [] }), expect.objectContaining({ source_reference_ids: [] })] })
  expect(f.db.readStoryGraph('story_graph_search', { query: 'Atlas', scope: { kind: 'global' }, object_types: ['entity'] }))
    .toMatchObject({ page: { has_more: false } })
  expect(f.respond).toHaveBeenCalledTimes(calls)
})

it('stops oversized runtime responses with a readable error while preserving resumable progress', async () => {
  const f = fixture()
  f.respond.mockReturnValue({ ...empty, summary: 'x'.repeat(110_000) })
  await expect(f.service(100).run(f.request)).rejects.toThrow('单次模型响应超过 100 KiB')
  expect(f.db.listSupervisionResults()).toHaveLength(0)
  expect(f.db.listSupervisionActivity()[0]!.reviewProgress).toMatchObject({ batches: 0, remainingSources: 1 })
  const runId = f.db.listSupervisionActivity()[0]!.id
  await expect(f.service(2048).resume(runId)).resolves.toMatchObject({ status: 'completed' })
  expect(f.db.listSupervisionResults()[0]!.summary).toBe('x'.repeat(110_000))
})

function fixture(content = 'Atlas and Beacon are separate projects.') {
  const db = new AssistantDatabase(':memory:')
  db.initialize(process.cwd())
  const pool = new SupervisionModelPool()
  cleanups.push(() => { pool.dispose(); db.close() })
  const now = Date.now()
  db.saveLocalConversations([{ header: { id: randomUUID(), projectId: db.listProjects()[0]!.id, title: 'Identity review', updatedAt: now },
    messages: [{ id: randomUUID(), role: 'user', state: 'complete', content, createdAt: now }] }])
  const request: SupervisionRunRequest = { trigger: 'manual', reanalyze: true, scope: { kind: 'global' }, timeRange: {
    from: new Date(now - 1).toISOString(), to: new Date(now + 1).toISOString()
  } }
  const respond = vi.fn((prompt: string): unknown => {
    const evidence = JSON.parse(prompt.split('BOUNDED EVIDENCE:\n\n')[1]!.split('\n\nReturn only JSON.')[0]!) as SupervisionEvidence[]
    return { ...empty, entities: ['Atlas', 'Beacon'].map((label, index) => ({ id: label, label, description: label,
      persistedId: index ? null : '', sourceReferenceIds: [evidence[0]!.id] })) }
  })
  const run: AgentRuntime['run'] = async function* (input) {
    yield { type: 'text', requestId: input.requestId, delta: JSON.stringify(respond(input.prompt)) }
    yield { type: 'done', requestId: input.requestId }
  }
  const service = (responseKiB = 1024) => createProductionSupervisorService(db, async () => ({ supervisorModelConcurrency: 1,
    supervisionReview: { pageSize: 10, batchCharacters: 1000, batchMessages: 10, executionSeconds: 300, responseKiB } }),
    async () => ({ runtimeId: 'model', capability: 'chat', run } as AgentRuntime), pool)
  return { db, request, respond, service }
}

it('records supervisor model usage under a hidden supervision task', async () => {
  const f = fixture()
  const run: AgentRuntime['run'] = async function* (input) {
    yield { type: 'text', requestId: input.requestId, delta: JSON.stringify(f.respond(input.prompt)) }
    yield { type: 'model-usage', requestId: input.requestId, callId: 'call-1', runtime: 'model', provider: 'openai',
      model: 'gpt-review', inputTokens: 40, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 }
    yield { type: 'done', requestId: input.requestId }
  }
  const service = createProductionSupervisorService(f.db, async () => ({ supervisorModelConcurrency: 1,
    supervisionReview: { pageSize: 10, batchCharacters: 1000, batchMessages: 10, executionSeconds: 300, responseKiB: 1024 } }),
    async () => ({ runtimeId: 'model', capability: 'chat', run } as AgentRuntime), new SupervisionModelPool())
  await service.run(f.request)
  const summary = f.db.getTokenUsageSummary()
  expect(summary.records).toEqual([expect.objectContaining({ systemSource: 'supervision', model: 'gpt-review', input: 40, output: 8 })])
  expect(summary.systemTotals).toMatchObject({ callCount: 1, input: 40 })
  expect(f.db.listTasks()).toEqual([])
})

it('production factory normalizes two absent identities, then reuses exact candidate UUIDs without extra calls', async () => {
  const f = fixture()
  const first = await f.service().run(f.request)
  expect(first.output.entities).toHaveLength(2)
  for (const entity of first.output.entities) expect(entity).not.toHaveProperty('persistedId')
  const candidates = f.db.listSupervisionCandidates(f.request)
  expect(candidates).toHaveLength(2)
  expect(f.respond.mock.calls[0]![0]).toContain('KNOWN ENTITIES is empty. Every entity is new; omit candidateRef')
  const original = f.respond.getMockImplementation()!
  f.respond.mockImplementation(prompt => {
    expect(prompt).toContain(JSON.stringify(candidates.map((candidate, index) => ({ candidateRef: `known_${index + 1}`, label: candidate.label, description: candidate.description }))))
    const output = original(prompt) as typeof first.output
    return { ...output, entities: output.entities.map(entity => ({ ...entity, persistedId: undefined, candidateRef: `known_${candidates.findIndex(candidate => candidate.label === entity.label) + 1}` })) }
  })
  const second = await f.service().run(f.request)
  expect(second.output.entities.map(entity => entity.persistedId).sort()).toEqual(candidates.map(candidate => candidate.id).sort())
  expect(f.db.listSupervisionCandidates(f.request)).toHaveLength(2)
  expect(f.respond).toHaveBeenCalledTimes(2)
})

it('retains candidate mappings across leaf batches, failed merge and resume without replaying leaves', async () => {
  const f = fixture('Atlas and Beacon. '.repeat(100))
  f.db.saveSupervisionResult({ request: f.request, evidence: [], output: { ...empty,
    entities: ['Atlas', 'Beacon'].map(label => ({ id: label, label, description: label, sourceReferenceIds: [] })) } })
  const candidates = f.db.listSupervisionCandidates(f.request)
  const original = f.respond.getMockImplementation()!
  let failMerge = true
  f.respond.mockImplementation(prompt => {
    if (prompt.includes('These inputs are navigation summaries')) {
      expect(prompt).toContain('KNOWN ENTITIES:\n\n[]')
      expect(prompt).toContain('"entities":[]')
      if (failMerge) { failMerge = false; throw new Error('Merge interrupted') }
      return empty
    }
    const output = original(prompt) as { entities: Array<{ label: string }> }
    return { ...output, entities: output.entities.map(entity => ({ ...entity, persistedId: candidates.find(candidate => candidate.label === entity.label)!.id })) }
  })
  await expect(f.service().run(f.request)).rejects.toThrow('Merge interrupted')
  const runId = f.db.listSupervisionActivity().find(item => item.status === 'failed')!.id
  const saved = f.db.supervisionReviewStore().batches(runId)
  expect(saved).toHaveLength(2)
  for (const batch of saved) expect(batch.output.entities.map(entity => entity.persistedId).sort()).toEqual(candidates.map(candidate => candidate.id).sort())
  const before = f.respond.mock.calls.length
  await expect(f.service().resume(runId)).resolves.toMatchObject({ status: 'completed' })
  expect(f.respond).toHaveBeenCalledTimes(before + 1)
  expect(f.db.supervisionReviewStore().batches(runId)).toEqual(saved)
  expect(f.db.listSupervisionCandidates(f.request).map(candidate => candidate.id).sort()).toEqual(candidates.map(candidate => candidate.id).sort())
})

it.each(['Atlas', 'optional UUID from KNOWN ENTITIES only', ' ', '', null])('preserves malformed legacy identity %s as a distinct new fact without merging', async persistedId => {
  const f = fixture()
  await f.service().run(f.request)
  const before = f.db.listSupervisionCandidates(f.request)
  const original = f.respond.getMockImplementation()!
  f.respond.mockImplementation(prompt => {
    const output = original(prompt) as { entities: object[] }
    return { ...output, entities: output.entities.map(entity => ({ ...entity, persistedId })) }
  })
  const result = await f.service().run(f.request)
  expect(result.output.entities).toHaveLength(2)
  expect(result.output.entities.every(entity => !entity.persistedId)).toBe(true)
  expect(f.db.listSupervisionCandidates(f.request)).toHaveLength(4)
  expect(f.db.listSupervisionCandidates(f.request)).toEqual(expect.arrayContaining(before))
})

it.each([randomUUID()])('production factory rejects unknown UUID %s without publishing, after the bounded output retries', async persistedId => {
  const f = fixture()
  const original = f.respond.getMockImplementation()!
  f.respond.mockImplementation(prompt => {
    const output = original(prompt) as { entities: object[] }
    return { ...output, entities: output.entities.map(entity => ({ ...entity, persistedId })) }
  })
  await expect(f.service().run(f.request)).rejects.toThrow(/leaf batch: entities\[0\].persistedId/)
  expect(f.db.listSupervisionResults()).toHaveLength(0)
  expect(f.db.listSupervisionActivity()[0]!.status).toBe('failed')
  expect(f.respond).toHaveBeenCalledTimes(3)
})

it.each(['known_999', 'Atlas', ' ', 'optional candidate reference'])('rejects unknown explicit candidate reference %s', async candidateRef => {
  const f = fixture()
  const original = f.respond.getMockImplementation()!
  f.respond.mockImplementation(prompt => {
    const output = original(prompt) as { entities: object[] }
    return { ...output, entities: output.entities.map(entity => ({ ...entity, candidateRef })) }
  })
  await expect(f.service().run(f.request)).rejects.toThrow('candidateRef is outside KNOWN ENTITIES')
  expect(f.db.listSupervisionResults()).toHaveLength(0)
  expect(f.respond).toHaveBeenCalledTimes(3)
})

it('production factory rejects a real UUID from another scope and preserves the existing graph', async () => {
  const f = fixture()
  await f.service().run(f.request)
  const candidates = f.db.listSupervisionCandidates(f.request)
  const original = f.respond.getMockImplementation()!
  f.respond.mockImplementation(prompt => {
    const output = original(prompt) as { entities: object[] }
    return { ...output, entities: output.entities.map((entity, index) => ({ ...entity, persistedId: candidates[index]!.id })) }
  })
  await expect(f.service().run({ ...f.request, scope: { kind: 'projects', projectIds: [f.db.listProjects()[0]!.id] } })).rejects.toThrow('outside KNOWN ENTITIES')
  expect(f.db.listSupervisionResults()).toHaveLength(1)
  expect(f.db.listSupervisionCandidates(f.request)).toEqual(candidates)
  expect(f.respond).toHaveBeenCalledTimes(4)
})

it('reuses actual legacy text-key shapes through strict UUID aliases and preserves confirmed fields and graph links', async () => {
  const f = fixture()
  await f.service().run(f.request)
  const sql = (f.db as unknown as { requireDatabase(): DatabaseSync }).requireDatabase()
  const story = sql.prepare('SELECT id FROM story_lines').get()!
  for (const id of ['goodbuddy', 'authorized-workspace-tools']) {
    sql.prepare(`INSERT INTO supervision_entities (id, story_line_id, canonical_label, description, confirmation_state, updated_at, source_reference_ids_json)
      VALUES (?, ?, ?, 'Human description', 'confirmed', ?, '[]')`).run(id, String(story.id), id, new Date().toISOString())
  }
  const candidates = f.db.listSupervisionCandidates(f.request)
  const legacy = candidates.filter(candidate => candidate.storageId)
  expect(legacy).toHaveLength(2)
  for (const candidate of legacy) expect(supervisionEntitySchema.shape.persistedId.safeParse(candidate.id).success).toBe(true)
  expect(f.db.listSupervisionCandidates(f.request)).toEqual(candidates)
  const original = f.respond.getMockImplementation()!
  f.respond.mockImplementation(prompt => {
    const output = original(prompt) as { entities: Array<{ sourceReferenceIds: string[] }> }
    return { ...output, entities: legacy.map((candidate, i) => ({ ...output.entities[i], id: `e${i}`, label: 'Model overwrite', description: 'Model overwrite',
      persistedId: undefined, candidateRef: `known_${candidates.findIndex(item => item.id === candidate.id) + 1}` })),
    relations: [{ fromEntityId: 'e0', toEntityId: 'e1', relationType: 'related', reason: 'Source relation', sourceReferenceIds: output.entities[0]!.sourceReferenceIds }] }
  })
  const result = await f.service().run(f.request)
  expect(result.status).toBe('completed')
  expect(result.output.entities.map(entity => entity.persistedId).sort()).toEqual(legacy.map(candidate => candidate.id).sort())
  for (const candidate of legacy) expect(sql.prepare('SELECT canonical_label, description, confirmation_state FROM supervision_entities WHERE id=?').get(candidate.storageId!))
    .toMatchObject({ canonical_label: candidate.storageId, description: 'Human description', confirmation_state: 'confirmed' })
  expect(sql.prepare('SELECT from_entity_id, to_entity_id FROM supervision_relations').get()).toMatchObject({ from_entity_id: legacy[0]!.storageId, to_entity_id: legacy[1]!.storageId })
  expect(f.db.listSupervisionCandidates(f.request)).toHaveLength(4)
})
