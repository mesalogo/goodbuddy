// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { AssistantDatabase } from './assistant-database'
import { extractExperiences } from './supervision-experiences'
import { assignStories } from './supervision-stories'
import { deriveSuggestions } from './supervision-suggester'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-story-suggestions-'))
  const path = join(directory, 'assistant.sqlite')
  const db = new AssistantDatabase(path)
  db.initialize(directory)
  const sql = new DatabaseSync(path)
  cleanups.push(async () => { sql.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
  const project = db.listProjects()[0]!
  const scope = { kind: 'projects' as const, projectIds: [project.id] }
  /** Publishes one review whose events all mention the entity `topic`, then places them in `story`. */
  const publish = async (story: string, titles: string[], day: string, topic = 'Long jobs') => {
    const candidates = db.listSupervisionCandidates({ trigger: 'manual', scope, timeRange: { from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' } })
    const known = candidates.find(entity => entity.label === topic)
    db.saveSupervisionResult({
      request: { trigger: 'manual', scope, timeRange: { from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' } },
      candidates,
      evidence: titles.map((title, index) => ({ id: `s${index}`, sourceType: 'conversation' as const, sourceId: 'c', title, content: title,
        occurredAt: `${day}T0${index}:00:00.000Z`, locator: { source: `message:${randomUUID()}`, revision: 'r', projectId: project.id, start: 0, end: title.length } })),
      output: { summary: 'x', changeDigest: '', openItems: [], entityChanges: [], relations: [],
        entities: [{ id: 'topic', label: topic, description: topic, sourceReferenceIds: ['s0'], ...(known ? { persistedId: known.id } : {}) }],
        events: titles.map((title, index) => ({ title, description: title, occurredAt: `${day}T0${index}:00:00.000Z`, eventType: 'decision' as const,
          entityIds: ['topic'], sourceReferenceIds: [`s${index}`] })) }
    })
    const runId = String(sql.prepare('SELECT run_id FROM supervision_results ORDER BY created_at DESC, rowid DESC LIMIT 1').get()!.run_id)
    const existing = db.supervisionStories().candidates(project.id, false).find(row => row.name === story)
    await assignStories(db.supervisionStories(), async prompt => {
      const refs = db.supervisionStories().candidates(project.id, false).map((row, index) => [String(row.name), `story_${index + 1}`])
      const count = prompt.split('\n').filter(line => line.startsWith('{"ref":"e_')).length
      const ref = existing ? refs.find(([name]) => name === story)![1] : 'new_1'
      return JSON.stringify({ ...(existing ? {} : { stories: [{ key: 'new_1', level: 'feature', name: story }] }),
        assignments: Array.from({ length: count }, (_, i) => ({ event: `e_${i + 1}`, story: ref })) })
    }, scope, { crossProject: false, threadEvents: 50, batchCharacters: 16000, concurrency: 1 })
    return runId
  }
  return { db, sql, project, scope, publish }
}

const echo = vi.fn(async (request: { candidates: Array<{ ref: string; title: string; detail: string }> }) =>
  ({ suggestions: request.candidates.map(candidate => ({ ref: candidate.ref, title: candidate.title, detail: candidate.detail })) }))

it('flags an active story without new events for the configured days, never as finished, and does not repeat it', async () => {
  const f = await fixture()
  await f.publish('Knowledge import', ['Pick a parser', 'Import Markdown', 'Import PDF'], '2026-09-01')
  const runId = await f.publish('Review scheduling', ['Batch sources', 'Persist batches', 'Resume runs'], '2026-09-28')
  const store = f.db.supervisionSuggestions()
  const now = '2026-09-30T00:00:00.000Z'
  const stalled = store.candidates(runId, { stalledDays: 14, now })!.candidates.filter(item => item.kind === 'stalled')
  expect(stalled.map(item => item.title)).toEqual(['Knowledge import'])
  expect(stalled[0]!.storyId).toBeTruthy()
  expect(stalled[0]!.sourceIds.length).toBeGreaterThan(0)
  expect(store.candidates(runId, { stalledDays: 60, now })!.candidates.some(item => item.kind === 'stalled')).toBe(false)
  // Saved with its story; the story state is untouched.
  await expect(deriveSuggestions(store, echo, { supervisionRunId: runId, heartbeatRunId: 'h1', stalledDays: 14, now })).resolves.toBeGreaterThan(0)
  const saved = store.list('pending', 50, 0).find(item => item.kind === 'stalled')!
  expect(saved.storyId).toBe(stalled[0]!.storyId)
  expect(f.sql.prepare("SELECT state FROM supervision_stories WHERE name = 'Knowledge import'").get()!.state).toBe('active')
  // Pending: not offered again. Accepting creates a paused task.
  expect(store.candidates(runId, { stalledDays: 14, now })!.candidates.some(item => item.kind === 'stalled')).toBe(false)
  const accepted = f.db.resolveSupervisionSuggestion(saved.id, 'accept')
  expect(accepted.taskId).toBeTruthy()
})

it('offers at most three stalled stories per heartbeat, largest first, and the rest later', async () => {
  const f = await fixture()
  for (const [index, name] of ['A', 'B', 'C', 'D', 'E'].entries()) {
    await f.publish(name, Array.from({ length: 3 + index }, (_, i) => `${name} step ${i}`), `2026-09-0${index + 1}`, `Topic ${name}`)
  }
  const runId = await f.publish('Active', ['One', 'Two', 'Three'], '2026-09-29', 'Topic active')
  const store = f.db.supervisionSuggestions()
  const now = '2026-09-30T00:00:00.000Z'
  await deriveSuggestions(store, echo, { supervisionRunId: runId, heartbeatRunId: 'h1', stalledDays: 14, now })
  expect(store.list('pending', 50, 0).filter(item => item.kind === 'stalled').map(item => item.title).sort()).toEqual(['C', 'D', 'E'])
  await deriveSuggestions(store, echo, { supervisionRunId: runId, heartbeatRunId: 'h2', stalledDays: 14, now })
  expect(store.list('pending', 50, 0).filter(item => item.kind === 'stalled').map(item => item.title).sort()).toEqual(['A', 'B', 'C', 'D', 'E'])
  await expect(deriveSuggestions(store, echo, { supervisionRunId: runId, heartbeatRunId: 'h3', stalledDays: 14, now })).resolves.toBe(0)
})

it('suggests an experience for a different story that touches the same knowledge, once', async () => {
  const f = await fixture()
  await f.publish('Review scheduling', ['Pause after 300 seconds', 'Users clicked continue repeatedly', 'Run until complete'], '2026-09-20')
  await extractExperiences(f.db.supervisionExperiences(), async () => JSON.stringify({
    experiences: [{ key: 'new_1', statement: 'Let long jobs run; pause only on request', conditions: 'Background work', boundaries: '', formed: ['e_1', 'e_3'] }]
  }), { minEvents: 3, batchCharacters: 16000 })
  const runId = await f.publish('Knowledge indexing', ['Index the vault in the background', 'Show progress', 'Allow cancel'], '2026-09-25')
  const store = f.db.supervisionSuggestions()
  const now = '2026-09-26T00:00:00.000Z'
  const items = store.candidates(runId, { now })!.candidates.filter(item => item.kind === 'experience')
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({ title: 'Let long jobs run; pause only on request' })
  expect(items[0]!.detail).toContain('Knowledge indexing')
  expect(items[0]!.experienceId).toBeTruthy()
  await deriveSuggestions(store, echo, { supervisionRunId: runId, heartbeatRunId: 'h2', now })
  expect(store.candidates(runId, { now })!.candidates.some(item => item.kind === 'experience')).toBe(false)
  // The story it formed in is never suggested to itself.
  const own = await f.publish('Review scheduling', ['Keep heartbeat running'], '2026-09-27')
  expect(store.candidates(own, { now })!.candidates.some(item => item.kind === 'experience')).toBe(false)
})

it('lets agents search stories and experiences and read their events through the story graph tools', async () => {
  const f = await fixture()
  await f.publish('Review scheduling', ['Pause after 300 seconds', 'Users clicked continue repeatedly', 'Run until complete'], '2026-09-20')
  await extractExperiences(f.db.supervisionExperiences(), async () => JSON.stringify({
    experiences: [{ key: 'new_1', statement: 'Let long jobs run; pause only on request', conditions: 'Background work', boundaries: 'Not for interactive edits', formed: ['e_1', 'e_3'] }]
  }), { minEvents: 3, batchCharacters: 16000 })
  type Page = { items: Array<{ object_ref: { type: string; id: string }; confirmation_state: string; event_time: string | null; content?: string }> }
  const stories = f.db.readStoryGraph('story_graph_search', { query: 'Review scheduling', object_types: ['story'] }, f.project.id) as Page
  expect(stories.items.map(item => item.object_ref.type)).toEqual(['story'])
  expect(stories.items[0]!.event_time).toBe('2026-09-20T00:00:00.000Z')
  const context = f.db.readStoryGraph('story_graph_get_context', { object_ref: stories.items[0]!.object_ref, mode: 'timeline' }, f.project.id) as Page
  expect(context.items.filter(item => item.object_ref.type === 'event')).toHaveLength(3)
  const experiences = f.db.readStoryGraph('story_graph_search', { query: 'long jobs run', object_types: ['experience'] }, f.project.id) as Page
  expect(experiences.items).toHaveLength(1)
  expect(experiences.items[0]!.confirmation_state).toBe('automatic')
  const formed = f.db.readStoryGraph('story_graph_get_context', { object_ref: experiences.items[0]!.object_ref }, f.project.id) as Page
  const events = formed.items.filter(item => item.object_ref.type === 'event')
  expect(events).toHaveLength(2)
  expect(formed.items.find(item => item.object_ref.type === 'experience')!.content).toContain('Not for interactive edits')
  // Outside the project scope nothing is returned.
  const other = f.db.createProject({ name: 'Other', description: '', rootPath: tmpdir(), defaultWorkMode: 'ask' })
  expect((f.db.readStoryGraph('story_graph_search', { query: 'long jobs', object_types: ['experience'] }, other.id) as Page).items).toEqual([])
})

it('upgrades schema 55 suggestions to 56 without losing rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-suggestions-56-'))
  const path = join(directory, 'assistant.sqlite')
  const first = new AssistantDatabase(path)
  first.initialize(directory)
  first.close()
  const sql = new DatabaseSync(path)
  sql.exec(`DROP TABLE supervision_suggestions;
    CREATE TABLE supervision_suggestions (id TEXT PRIMARY KEY, result_id TEXT, heartbeat_run_id TEXT, scope_json TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('open_item', 'conflict', 'convention', 'revision')), fingerprint TEXT NOT NULL, title TEXT NOT NULL,
      detail TEXT NOT NULL, source_reference_ids_json TEXT NOT NULL DEFAULT '[]', entity_id TEXT, relation_id TEXT, memory_id TEXT, task_id TEXT,
      evidence_key TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO supervision_suggestions (id, scope_json, kind, fingerprint, title, detail, status, created_at, updated_at)
      VALUES ('keep', '{"kind":"global"}', 'open_item', 'open_item:x', 'Keep', 'Keep', 'pending', 'now', 'now');
    PRAGMA user_version = 55;`)
  sql.close()
  const db = new AssistantDatabase(path)
  db.initialize(directory)
  cleanups.push(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
  expect(db.supervisionSuggestions().get('keep')).toMatchObject({ kind: 'open_item', title: 'Keep', storyId: null })
  const check = new DatabaseSync(path)
  expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(56)
  check.close()
})