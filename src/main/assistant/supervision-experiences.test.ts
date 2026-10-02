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

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

type Kind = 'decision' | 'change' | 'discussion' | 'milestone'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-experiences-'))
  const path = join(directory, 'assistant.sqlite')
  const db = new AssistantDatabase(path)
  db.initialize(directory)
  const sql = new DatabaseSync(path)
  cleanups.push(async () => { sql.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
  const project = db.listProjects()[0]!
  // Publishes events of one project in time order, then places them all in one feature story.
  // Every event mentions the entity `topic`; an application must share an entity with the formation.
  const publish = async (items: Array<[string, Kind]>, day: number, story = 'Review scheduling', topic = 'Long jobs') => {
    const request = { trigger: 'manual' as const, scope: { kind: 'projects' as const, projectIds: [project.id] }, timeRange: { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' } }
    const candidates = db.listSupervisionCandidates(request)
    const known = candidates.find(entity => entity.label === topic)
    db.saveSupervisionResult({
      request, candidates,
      evidence: items.map(([title], index) => ({ id: `s${index}`, sourceType: 'conversation' as const, sourceId: 'c', title, content: title,
        occurredAt: `2026-09-${day}T0${index}:00:00.000Z`, locator: { source: `message:${randomUUID()}`, revision: 'r', projectId: project.id, start: 0, end: title.length } })),
      output: { summary: 'x', changeDigest: '', openItems: [], entityChanges: [], relations: [],
        entities: [{ id: 'topic', label: topic, description: topic, sourceReferenceIds: ['s0'], ...(known ? { persistedId: known.id } : {}) }],
        events: items.map(([title, eventType], index) => ({ title, description: title, occurredAt: `2026-09-${day}T0${index}:00:00.000Z`, eventType, entityIds: ['topic'], sourceReferenceIds: [`s${index}`] })) }
    })
    const existing = db.supervisionStories().candidates(project.id, false).find(row => row.name === story)
    await assignStories(db.supervisionStories(), async prompt => {
      const count = prompt.split('\n').filter(line => line.startsWith('{"ref":"e_')).length
      return JSON.stringify(existing
        ? { assignments: Array.from({ length: count }, (_, i) => ({ event: `e_${i + 1}`, story: 'story_1' })) }
        : { stories: [{ key: 'new_1', level: 'feature', name: story }], assignments: Array.from({ length: count }, (_, i) => ({ event: `e_${i + 1}`, story: 'new_1' })) })
    }, { kind: 'global' }, { crossProject: false, threadEvents: 50, batchCharacters: 16000, concurrency: 1 })
  }
  return { db, sql, project, publish, store: db.supervisionExperiences() }
}

const options = { minEvents: 3, batchCharacters: 16000 }

it('extracts evidenced experiences from rule candidates, records later applications and skips quiet stories', async () => {
  const f = await fixture()
  await f.publish([['Pause reviews after 300 seconds', 'decision'], ['Users had to click continue repeatedly', 'discussion'], ['Run reviews until complete', 'change']], 20)
  const first = vi.fn(async (prompt: string) => {
    expect(prompt).toContain('Review scheduling')
    expect(prompt).not.toContain('message:')
    return JSON.stringify({ experiences: [{ key: 'new_1', statement: 'Let long jobs run; pause only on request', conditions: 'Background work', boundaries: '', formed: ['e_1', 'e_3'] }] })
  })
  await expect(extractExperiences(f.store, first, options)).resolves.toMatchObject({ calls: 1, candidates: 1, created: 1, applied: 0 })
  // Nothing new: no call.
  await expect(extractExperiences(f.store, first, options)).resolves.toMatchObject({ calls: 0, candidates: 0 })
  // A later decision applies it; the model sees the existing experience as x_1.
  await f.publish([['Keep heartbeat running until done', 'decision']], 25)
  const later = vi.fn(async (prompt: string) => {
    expect(prompt).toContain('"ref":"x_1"')
    return JSON.stringify({ applications: [{ experience: 'x_1', event: 'e_4', note: 'No manual continue needed' }] })
  })
  await expect(extractExperiences(f.store, later, options)).resolves.toMatchObject({ calls: 1, created: 0, applied: 1 })
  const [experience] = f.store.list()
  expect(experience).toMatchObject({ statement: 'Let long jobs run; pause only on request', userEdited: false })
  expect(experience!.events.map(event => [event.role, event.title, event.storyName])).toEqual([
    ['formed', 'Pause reviews after 300 seconds', 'Review scheduling'], ['formed', 'Run reviews until complete', 'Review scheduling'],
    ['applied', 'Keep heartbeat running until done', 'Review scheduling']])
  expect(f.store.list([randomUUID()])).toEqual([])
})

it('makes no call for small stories or discussion-only progress', async () => {
  const f = await fixture()
  await f.publish([['Decide one thing', 'decision'], ['Talk', 'discussion']], 20)
  const model = vi.fn(async () => '{}')
  await expect(extractExperiences(f.store, model, options)).resolves.toMatchObject({ calls: 0, candidates: 0 })
  // Growing past the minimum with discussion only still costs nothing: the earlier decision was already seen as small.
  await f.publish([['More talk', 'discussion'], ['Even more', 'discussion']], 21)
  await expect(extractExperiences(f.store, model, options)).resolves.toMatchObject({ calls: 0 })
  expect(model).not.toHaveBeenCalled()
})

it('rejects invented evidence and saves nothing from a rejected answer; drops applications that precede formation', async () => {
  const f = await fixture()
  await f.publish([['A', 'decision'], ['B', 'change'], ['C', 'milestone']], 20)
  for (const bad of [
    { experiences: [{ key: 'new_1', statement: 'X', formed: ['e_9'] }] },
    { experiences: [{ key: 'new_1', statement: 'X', formed: [] }] },
    { applications: [{ experience: 'x_1', event: 'e_1' }] }
  ]) await expect(extractExperiences(f.store, async () => JSON.stringify(bad), options)).rejects.toThrow()
  expect(f.store.list()).toEqual([])
  expect(Number(f.sql.prepare('SELECT COUNT(*) AS n FROM supervision_experience_seen').get()!.n)).toBe(0)
  await expect(extractExperiences(f.store, async () => JSON.stringify({ experiences: [{ key: 'new_1', statement: 'X', formed: ['e_2'] }],
    applications: [{ experience: 'new_1', event: 'e_1' }, { experience: 'new_1', event: 'e_3', note: 'ok' }] }), options))
    .resolves.toMatchObject({ created: 1, applied: 1 })
  // An existing experience is checked against its stored evidence too.
  await f.publish([['D', 'decision']], 19)
  await extractExperiences(f.store, async () => JSON.stringify({ applications: [{ experience: 'x_1', event: 'e_1' }] }), options)
  expect(f.store.list()[0]!.events.map(event => [event.role, event.title])).toEqual([['formed', 'B'], ['applied', 'C']])
  // A later event about unrelated knowledge is not recorded as an application.
  await f.publish([['Unrelated decision', 'decision']], 25, 'Review scheduling', 'Billing')
  await expect(extractExperiences(f.store, async prompt => {
    const ref = prompt.split('\n').find(line => line.includes('Unrelated decision'))!.match(/"ref":"(e_\d+)"/)![1]
    return JSON.stringify({ applications: [{ experience: 'x_1', event: ref, note: 'loosely related' }] })
  }, options)).resolves.toMatchObject({ applied: 0 })
})

it('protects edits, keeps removed experiences removed and undoes adjustments', async () => {
  const f = await fixture()
  await f.publish([['A', 'decision'], ['B', 'change'], ['C', 'milestone']], 20)
  await extractExperiences(f.store, async () => JSON.stringify({ experiences: [
    { key: 'new_1', statement: 'Validate first', formed: ['e_1'] }, { key: 'new_2', statement: 'Ship small', formed: ['e_2'] }] }), options)
  const stories = f.db.supervisionStories()
  const [first, second] = f.store.list()
  stories.act({ action: 'experience-edit', experienceId: first!.id, statement: 'Validate the key assumption first', conditions: 'New bets', boundaries: 'Not for fixes' })
  expect(f.store.list()[0]).toMatchObject({ statement: 'Validate the key assumption first', conditions: 'New bets', userEdited: true })
  stories.act({ action: 'experience-merge', experienceId: second!.id, intoId: first!.id })
  expect(f.store.list()).toHaveLength(1)
  expect(f.store.list()[0]!.events.map(event => event.title)).toEqual(['A', 'B'])
  stories.act({ action: 'undo' })
  expect(f.store.list().map(item => item.statement)).toEqual(['Validate the key assumption first', 'Ship small'])
  stories.act({ action: 'experience-remove', experienceId: second!.id })
  // The same statement, or the same evidence under another wording, is not recreated.
  await f.publish([['D', 'decision']], 22)
  await extractExperiences(f.store, async () => JSON.stringify({ experiences: [
    { key: 'new_1', statement: 'ship small!', formed: ['e_4'] }, { key: 'new_2', statement: 'Keep changes tiny', formed: ['e_2'] }] }), options)
  expect(f.store.list().map(item => item.statement)).toEqual(['Validate the key assumption first'])
  stories.act({ action: 'undo' })
  expect(f.store.list().map(item => item.statement)).toEqual(['Validate the key assumption first', 'Ship small'])
})
