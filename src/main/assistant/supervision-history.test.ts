import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { AssistantDatabase } from './assistant-database'
import { SupervisorService, type StoredSupervisionResult } from './supervisor-service'
import { supervisionGraphViewSchema } from '../../shared/supervision-contracts'

it('supervision preserves result history and protected identities within scope through schema 42 upgrade', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'supervision-history-'))
  const path = join(directory, 'assistant.sqlite')
  const db = new AssistantDatabase(path)
  db.initialize(process.cwd())
  try {
    const projects = ['A', 'B'].map((name) => db.createProject({ name, description: name, rootPath: directory, defaultWorkMode: 'ask' }))
    db.replaceConversations(projects.map((project) => ({ id: project.name, projectId: project.id, title: project.name, updatedAt: Date.now(), messages: [] })))
    const taskId = randomUUID()
    db.createTask({ id: taskId, projectId: projects[0]!.id, conversationId: 'A', title: 'Task A', instructions: 'Review', workMode: 'ask' })
    const first: StoredSupervisionResult = {
      request: { trigger: 'manual', scope: { kind: 'projects', projectIds: [projects[0]!.id] }, timeRange: { from: '2026-09-01T00:00:00Z', to: '2026-09-22T00:00:00Z' } },
      evidence: [{ id: 'source', sourceType: 'conversation', sourceId: 'A', title: 'A source', content: 'A content', occurredAt: '2026-09-20T00:00:00Z' },
        { id: 'task', sourceType: 'task', sourceId: taskId, title: 'A task', content: 'Task content', occurredAt: '2026-09-20T00:00:00Z' }],
      output: { summary: 'A first', changeDigest: '', openItems: [],
        entities: ['one', 'two'].map((id) => ({ id, label: id, description: 'Original', sourceReferenceIds: ['source'] })),
        events: [{ title: 'A event', description: '', eventType: 'discussion', occurredAt: '2026-09-20T00:00:00Z', entityIds: ['one', 'two'], sourceReferenceIds: ['source'] }],
        entityChanges: [], relations: [{ fromEntityId: 'one', toEntityId: 'two', relationType: 'related', reason: 'Original reason', sourceReferenceIds: [] }] }
    }
    db.saveSupervisionResult(first)
    const a = db.listSupervisionResults()[0]!
    const read = (id: string) => {
      const graph = supervisionGraphViewSchema.parse(db.getSupervisionGraph({ resultId: id }))
      graph.entities.sort((a, b) => a.id.localeCompare(b.id))
      return graph
    }
    const original = read(a.id)
    db.close()
    const legacy = new DatabaseSync(path)
    legacy.exec(`ALTER TABLE supervision_results DROP COLUMN graph_snapshot_json;
      DROP TABLE activity_history_records;
      ALTER TABLE activity_history RENAME COLUMN record_order_json TO records_json;
      DROP TRIGGER messages_review_insert; DROP TRIGGER messages_review_update;
      DROP TRIGGER messages_review_delete; DROP TRIGGER tasks_review_delete;
      DROP VIEW supervision_review_current;
      DROP TABLE supervision_review_navigation; DROP TABLE supervision_review_batches;
      DROP TABLE supervision_review_sources; DROP TABLE supervision_review_runs;
      DROP TABLE review_checkpoints; ALTER TABLE messages DROP COLUMN review_revision;
      PRAGMA user_version = 42;`)
    legacy.close()
    db.initialize(process.cwd())
    expect(read(a.id)).toEqual(original)
    const second = structuredClone(first)
    second.output.summary = 'A second'
    second.output.entities.forEach((entity) => { entity.description = 'Updated'; entity.label += ' updated' })
    const service = new SupervisorService({ collect: async () => second.evidence }, {
      summarize: async ({ candidates }) => ({ ...second.output, entities: second.output.entities.map((entity, index) => ({ ...entity, persistedId: candidates.find((candidate) => candidate.label === first.output.entities[index]!.label)!.id })) })
    }, { candidates: async (request) => db.listSupervisionCandidates(request), save: async (result) => db.saveSupervisionResult(result) })
    await service.run(second.request)
    const a2 = db.listSupervisionResults()[0]!
    expect(read(a2.id).entities.map((entity) => entity.id).sort()).toEqual(original.entities.map((entity) => entity.id).sort())
    expect(read(a2.id).entities.every((entity) => entity.description === 'Updated')).toBe(true)
    expect(read(a.id)).toEqual(original)
    const entityId = original.entities[0]!.id
    const relationId = original.relations[0]!.id
    db.applySupervisionEntityAction({ resultId: a2.id, entityId, action: 'revise', label: 'Human label', description: 'Human description' })
    const confirmedEntity = read(a2.id).entities.find((entity) => entity.id !== entityId)!
    db.applySupervisionEntityAction({ resultId: a2.id, entityId: confirmedEntity.id, action: 'confirm' })
    db.applySupervisionRelationAction({ resultId: a2.id, relationId, action: 'confirm' })
    const third = structuredClone(second)
    third.candidates = db.listSupervisionCandidates(third.request)
    third.output.entities = third.output.entities.map((entity, index) => ({ ...entity, persistedId: original.entities.find((item) => item.canonical_label === first.output.entities[index]!.label)!.id, label: 'Model overwrite', description: 'Model overwrite' }))
    third.output.relations[0]!.reason = 'Model overwrite'
    db.saveSupervisionResult(third)
    const latest = db.listSupervisionResults()[0]!
    expect(read(latest.id).entities.find((entity) => entity.id === entityId)).toMatchObject({ canonical_label: 'Human label', description: 'Human description', confirmation_state: 'revised' })
    expect(read(latest.id).entities.find((entity) => entity.id === confirmedEntity.id)).toMatchObject({ ...confirmedEntity, confirmation_state: 'confirmed' })
    expect(read(latest.id).relations[0]).toMatchObject({ id: relationId, reason: 'Original reason', confirmation_state: 'confirmed' })
    const storedGraph = db.getSupervisionGraph({ resultId: latest.id })
    const currentSource = (storedGraph.sources as Array<{ id: string; source_type: string }>).find((source) => source.source_type === 'conversation')!
    expect((storedGraph.entities as Array<{ source_reference_ids_json: string }>).every((entity) => entity.source_reference_ids_json === JSON.stringify([currentSource.id]))).toBe(true)
    expect(read(a.id)).toEqual(original)
    db.applySupervisionRelationAction({ resultId: latest.id, relationId, action: 'revoke' })
    db.saveSupervisionResult(third)
    expect(read(db.listSupervisionResults()[0]!.id).relations).toEqual([])
    expect(read(a.id).relations).toEqual(original.relations)

    const other = structuredClone(third)
    other.request.scope = { kind: 'projects', projectIds: [projects[1]!.id] }
    expect(() => db.saveSupervisionResult(other)).toThrow('本次范围')
    other.output.entities.forEach((entity) => { delete entity.persistedId })
    other.evidence = [{ ...first.evidence[0]!, sourceId: 'B', title: 'B source' }]
    other.output.summary = 'B latest'
    db.saveSupervisionResult(other)
    const b = db.listSupervisionResults()[0]!
    expect(() => db.getSupervisionGraph({ resultId: a.id, storyLineId: b.storyLineId })).toThrow('不匹配')
    expect(read(b.id).entities.some((entity) => original.entities.some((old) => old.id === entity.id))).toBe(false)
    expect(read(a.id)).toEqual(original)
    expect(() => db.applySupervisionEntityAction({ resultId: a.id, entityId: read(b.id).entities[0]!.id, action: 'confirm' })).toThrow('不匹配')
    // Historical sources can still point to a conversation whose project has changed.
    const foreignScope = structuredClone(first)
    foreignScope.request.scope = other.request.scope
    db.saveSupervisionResult(foreignScope)
    const forA = db.listSupervisionResults(20, { type: 'conversation', conversationId: 'A' })
    expect(forA.every((result) => result.storyLineId === a.storyLineId)).toBe(true)
    expect(forA.length).toBe(4)
    expect(db.listSupervisionResults(20, { type: 'conversation', conversationId: 'B' }).map((result) => result.id)).toEqual([b.id])
    const forTask = db.listSupervisionResults(20, { type: 'task', taskId })
    expect(forTask).toHaveLength(4)
    expect(db.getSupervisionSource(forTask[0]!.sourceId!)?.sourceId).toBe(taskId)
    db.close()
    db.initialize(process.cwd())
    expect(read(a.id)).toEqual(original)
  } finally { db.close(); await rm(directory, { recursive: true, force: true }) }
})
