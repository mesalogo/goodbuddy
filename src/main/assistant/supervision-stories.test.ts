// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { AssistantDatabase } from './assistant-database'
import { assignStories } from './story-assignment-service'
import { SupervisorService } from './supervisor-service'
import type { ReviewConfiguration } from './supervision-review-store'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const options = { crossProject: false, threadEvents: 3, batchCharacters: 8000, concurrency: 2 }

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-stories-'))
  const path = join(directory, 'assistant.sqlite')
  const db = new AssistantDatabase(path)
  db.initialize(directory)
  const sql = new DatabaseSync(path)
  cleanups.push(async () => { sql.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
  const a = db.listProjects()[0]!
  const b = db.createProject({ name: 'B', description: '', rootPath: directory })
  const story = db.saveSupervisionResult.bind(db)
  // Publishes events directly on the timeline, one per title, owned by `projectId`.
  const publish = (projectId: string, titles: string[], day = 20) => story({
    request: { trigger: 'manual', scope: { kind: 'projects', projectIds: [projectId] }, timeRange: { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' } },
    evidence: titles.map((title, index) => ({ id: `s${index}`, sourceType: 'conversation' as const, sourceId: 'c', title, content: title,
      occurredAt: `2026-09-${day}T0${index % 10}:00:00.000Z`, locator: { source: `message:${randomUUID()}`, revision: 'r', projectId, start: 0, end: title.length } })),
    output: { summary: 'x', changeDigest: '', openItems: [], entities: [], entityChanges: [], relations: [],
      events: titles.map((title, index) => ({ title, description: title, occurredAt: `2026-09-${day}T0${index % 10}:00:00.000Z`, eventType: 'discussion' as const, entityIds: [], sourceReferenceIds: [`s${index}`] })) }
  })
  return { db, sql, a, b, publish, stories: db.supervisionStories() }
}

const answer = (value: unknown) => vi.fn(async () => JSON.stringify(value))

it('assigns events once with projects from sources, reuses stories after long gaps and calls no model when nothing is new', async () => {
  const f = await fixture()
  f.publish(f.a.id, ['Design timeline', 'Timeline storage', 'Weekly report'])
  f.publish(f.b.id, ['B kickoff'])
  const first = answer({ stories: [{ key: 'new_1', level: 'feature', name: 'Timeline' }], assignments: [
    { event: 'e_1', story: 'new_1' }, { event: 'e_2', story: 'new_1' }, { event: 'e_3', story: null }] })
  const model = vi.fn(async (prompt: string) => prompt.includes('B kickoff')
    ? JSON.stringify({ stories: [{ key: 'new_1', level: 'feature', name: 'Kickoff' }], assignments: [{ event: 'e_1', story: 'new_1' }] })
    : first())
  await expect(assignStories(f.stories, model, { kind: 'global' }, options)).resolves.toMatchObject({ calls: 2, assigned: 3, unassigned: 1, created: 2 })
  const stories = f.stories.list({ kind: 'global' })
  expect(stories.map(story => [story.name, story.projectId, story.events.length])).toEqual(expect.arrayContaining([['Timeline', f.a.id, 2], ['Kickoff', f.b.id, 1]]))
  expect(f.stories.unassignedCount({ kind: 'global' })).toBe(1)
  // Nothing new: no call. The unassigned event is not offered again.
  await expect(assignStories(f.stories, model, { kind: 'global' }, options)).resolves.toMatchObject({ calls: 0 })
  // A month later the same work resumes: the model sees the existing story and joins it.
  f.publish(f.a.id, ['Timeline revisited'], 29)
  const later = vi.fn(async (prompt: string) => {
    expect(prompt).toContain('"name":"Timeline"')
    expect(prompt).not.toContain('Kickoff')
    return JSON.stringify({ assignments: [{ event: 'e_1', story: 'story_1' }] })
  })
  await assignStories(f.stories, later, { kind: 'projects', projectIds: [f.a.id] }, options)
  expect(f.stories.list({ kind: 'projects', projectIds: [f.a.id] })[0]).toMatchObject({ name: 'Timeline', state: 'active', endedAt: '2026-09-29T00:00:00.000Z' })
})

it('rejects incomplete, duplicate or invented assignments and keeps nothing from a rejected answer', async () => {
  const f = await fixture()
  f.publish(f.a.id, ['One', 'Two'])
  for (const bad of [
    { assignments: [{ event: 'e_1', story: null }] },
    { assignments: [{ event: 'e_1', story: null }, { event: 'e_1', story: null }] },
    { assignments: [{ event: 'e_1', story: 'story_9' }, { event: 'e_2', story: null }] },
    { stories: [{ key: 'new_1', level: 'cross', name: 'X' }], assignments: [{ event: 'e_1', story: null }, { event: 'e_2', story: null }] },
    { stories: [{ key: 'new_1', level: 'feature', name: 'F' }], assignments: [{ event: 'e_1', story: 'new_1' }, { event: 'e_2', story: null }], concluded: [{ story: 'new_1', event: 'e_2' }] }
  ]) await expect(assignStories(f.stories, answer(bad), { kind: 'global' }, options)).rejects.toThrow()
  expect(f.stories.list({ kind: 'global' })).toEqual([])
  expect(f.stories.pending({ kind: 'global' })).toHaveLength(2)
})

it('keeps sub-threads only in large features and concludes stories only on cited events', async () => {
  const f = await fixture()
  f.publish(f.a.id, ['Small A', 'Small B'])
  const threads = (feature: string, keyThreads: boolean) => answer({ stories: [{ key: 'new_1', level: 'feature', name: feature },
    ...(keyThreads ? [{ key: 'new_2', level: 'thread', name: `${feature} part`, parent: 'new_1' }] : [])],
  assignments: [{ event: 'e_1', story: 'new_2' }, { event: 'e_2', story: 'new_1' }], concluded: [{ story: 'new_1', event: 'e_2' }] })
  await assignStories(f.stories, threads('Small', true), { kind: 'global' }, options)
  // Two events < threshold 3: the thread collapses into its feature.
  expect(f.stories.list({ kind: 'global' }).map(story => [story.level, story.name, story.events.length, story.state])).toEqual([['feature', 'Small', 2, 'concluded']])
  f.publish(f.b.id, ['Big 1', 'Big 2', 'Big 3'])
  await assignStories(f.stories, answer({ stories: [{ key: 'new_1', level: 'feature', name: 'Big' }, { key: 'new_2', level: 'thread', name: 'Big part', parent: 'new_1' }],
    assignments: [{ event: 'e_1', story: 'new_2' }, { event: 'e_2', story: 'new_2' }, { event: 'e_3', story: 'new_1' }] }), { kind: 'global' }, options)
  const big = f.stories.list({ kind: 'projects', projectIds: [f.b.id] })
  expect(big.map(story => [story.level, story.name, story.events.length, story.state])).toEqual([['feature', 'Big', 1, 'active'], ['thread', 'Big part', 2, 'active']])
  expect(big[1]!.parentId).toBe(big[0]!.id)
})

it('creates cross-project stories only when linking is on, as associations that leave primary stories intact', async () => {
  const f = await fixture()
  f.publish(f.a.id, ['Fly brain in A'])
  f.publish(f.b.id, ['Fly brain in B'])
  const model = vi.fn(async (prompt: string) => {
    const has = prompt.includes('"level":"cross"')
    return JSON.stringify({ stories: [{ key: 'new_1', level: 'feature', name: 'Fly' }, ...(has ? [] : [{ key: 'new_2', level: 'cross', name: 'Fly brain' }])],
      assignments: [{ event: 'e_1', story: 'new_1', related: [has ? 'story_1' : 'new_2'] }] })
  })
  await assignStories(f.stories, model, { kind: 'global' }, { ...options, crossProject: true })
  const stories = f.stories.list({ kind: 'global' })
  const cross = stories.find(story => story.level === 'cross')!
  expect(cross).toMatchObject({ name: 'Fly brain', projectId: null })
  expect(cross.events.map(event => [event.projectId, event.primary]).sort()).toEqual([[f.a.id, false], [f.b.id, false]].sort())
  expect(stories.filter(story => story.level === 'feature').every(story => story.events.length === 1 && story.events[0]!.primary)).toBe(true)
  // Off: the prompt forbids cross stories and existing ones are not offered.
  f.publish(f.a.id, ['Later'], 25)
  const off = vi.fn(async (prompt: string) => {
    expect(prompt).toContain('Cross-project linking is off')
    expect(prompt).not.toContain('Fly brain')
    return JSON.stringify({ assignments: [{ event: 'e_1', story: null }] })
  })
  await assignStories(f.stories, off, { kind: 'global' }, options)
  expect(off).toHaveBeenCalledTimes(1)
})

it('folds features that differ only by version into one and spells out granularity in the prompt', async () => {
  const f = await fixture()
  f.publish(f.a.id, ['Release 0.13.10', 'Release 0.13.11'])
  const first = vi.fn(async (prompt: string) => {
    expect(prompt).toContain('never a feature')
    return JSON.stringify({ stories: [{ key: 'new_1', level: 'feature', name: '0.13.10 发布' }, { key: 'new_2', level: 'feature', name: '0.13.11 发布' }],
      assignments: [{ event: 'e_1', story: 'new_1' }, { event: 'e_2', story: 'new_2' }], concluded: [{ story: 'new_2', event: 'e_2' }] })
  })
  await assignStories(f.stories, first, { kind: 'global' }, options)
  f.publish(f.a.id, ['Release 0.13.12'], 22)
  // Nested-looking keys are still local refs.
  await assignStories(f.stories, answer({ stories: [{ key: 'new_1', level: 'feature', name: 'v0.13.12 发布' }, { key: 'new_1_t1', level: 'thread', name: 'RC', parent: 'new_1' }],
    assignments: [{ event: 'e_1', story: 'new_1_t1' }] }), { kind: 'global' }, options)
  // The folded version's "finished" does not conclude the whole line.
  // The thread of the folded feature lands under the surviving one.
  const tree = f.stories.list({ kind: 'global' })
  expect(tree.map(story => [story.name, story.events.length, story.state])).toEqual([['0.13.10 发布', 2, 'active'], ['RC', 1, 'active']])
  expect(tree[1]!.parentId).toBe(tree[0]!.id)
})

it('offers one bounded thread split to a feature that grew past the threshold and keeps user-set events', async () => {
  const f = await fixture()
  f.publish(f.a.id, ['UI 1', 'UI 2', 'UI 3', 'MCP 1', 'MCP 2', 'Misc'])
  const model = vi.fn(async (prompt: string) => prompt.includes('EXISTING THREADS')
    ? JSON.stringify({ threads: [{ key: 'new_1', name: 'UI' }, { key: 'new_2', name: 'MCP' }],
      moves: [{ event: 'e_1', thread: 'new_1' }, { event: 'e_2', thread: 'new_1' }, { event: 'e_3', thread: 'new_1' }, { event: 'e_4', thread: 'new_2' }, { event: 'e_5', thread: 'new_2' }] })
    : JSON.stringify({ stories: [{ key: 'new_1', level: 'feature', name: 'App' }], assignments: [1, 2, 3, 4, 5, 6].map(n => ({ event: `e_${n}`, story: 'new_1' })) }))
  await expect(assignStories(f.stories, model, { kind: 'global' }, options)).resolves.toMatchObject({ calls: 2, assigned: 6, created: 2, split: 3 })
  // MCP has 2 moves, below the minimum of 3: its events stay on the feature.
  const tree = f.stories.list({ kind: 'global' })
  expect(tree.map(story => [story.level, story.name, story.events.length])).toEqual([['feature', 'App', 3], ['thread', 'UI', 3]])
  // A user-placed event is never moved; a feature that did not cross the next multiple gets no split call.
  const misc = tree[0]!.events.find(event => event.title === 'Misc')!
  f.stories.act({ action: 'move', eventId: misc.id, storyId: tree[0]!.id })
  f.publish(f.a.id, ['UI 4'], 22)
  const later = vi.fn(async (prompt: string) => {
    expect(prompt).not.toContain('EXISTING THREADS')
    return JSON.stringify({ assignments: [{ event: 'e_1', story: 'story_2' }] })
  })
  await expect(assignStories(f.stories, later, { kind: 'global' }, options)).resolves.toMatchObject({ calls: 1, split: 0 })
  // Invalid split answers are rejected whole.
  const input = f.stories.splitInput(tree[0]!.id, 8000)
  expect(input.events.map(event => event.title)).toEqual(['MCP 1', 'MCP 2'])
  expect(() => f.stories.split(input, { threads: [], moves: [{ event: 'e_1', thread: 'thread_9' }] }, 3)).toThrow()
})

it('shows other projects\' features only with linking on and links whole features into a cross story', async () => {
  const f = await fixture()
  f.publish(f.a.id, ['Fly brain simulation'])
  await assignStories(f.stories, answer({ stories: [{ key: 'new_1', level: 'feature', name: 'fly-brain 仿真' }], assignments: [{ event: 'e_1', story: 'new_1' }] }), { kind: 'global' }, options)
  f.publish(f.b.id, ['Drosophila connectome repo', 'Unrelated'])
  const model = vi.fn(async (prompt: string) => {
    expect(prompt).toContain('OTHER PROJECTS')
    expect(prompt).toContain('"ref":"other_1"')
    expect(prompt).toContain('fly-brain 仿真')
    return JSON.stringify({ stories: [{ key: 'new_1', level: 'feature', name: '果蝇神经开源项目' }, { key: 'new_2', level: 'cross', name: '果蝇脑' }],
      assignments: [{ event: 'e_1', story: 'new_1' }, { event: 'e_2', story: null }],
      links: [{ cross: 'new_2', feature: 'other_1' }, { cross: 'new_2', feature: 'new_1' }] })
  })
  await assignStories(f.stories, model, { kind: 'global' }, { ...options, crossProject: true })
  const cross = f.stories.list({ kind: 'global' }).find(story => story.level === 'cross')!
  expect(cross.events.map(event => [event.title, event.primary]).sort()).toEqual([['Drosophila connectome repo', false], ['Fly brain simulation', false]])
  // Later chunks see which features a cross story already links.
  f.publish(f.b.id, ['More fly'], 23)
  const later = vi.fn(async (prompt: string) => {
    expect(prompt).toMatch(/"level":"cross".*"links":\["fly-brain 仿真","果蝇神经开源项目"\]/)
    return JSON.stringify({ assignments: [{ event: 'e_1', story: null }] })
  })
  await assignStories(f.stories, later, { kind: 'projects', projectIds: [f.b.id] }, { ...options, crossProject: true })
  // Off: links are rejected and other projects are not shown.
  f.publish(f.b.id, ['Off'], 24)
  const off = vi.fn(async (prompt: string) => {
    expect(prompt).not.toContain('OTHER PROJECTS')
    return JSON.stringify({ assignments: [{ event: 'e_1', story: null }], links: [{ cross: 'story_1', feature: 'story_1' }] })
  })
  await expect(assignStories(f.stories, off, { kind: 'global' }, options)).rejects.toThrow()
})

it('protects user adjustments from later assignment and undoes them', async () => {
  const f = await fixture()
  f.publish(f.a.id, ['Alpha 1', 'Alpha 2', 'Beta 1'])
  await assignStories(f.stories, answer({ stories: [{ key: 'new_1', level: 'feature', name: 'Alpha' }, { key: 'new_2', level: 'feature', name: 'Beta' }],
    assignments: [{ event: 'e_1', story: 'new_1' }, { event: 'e_2', story: 'new_1' }, { event: 'e_3', story: 'new_2' }] }), { kind: 'global' }, options)
  const [alpha, beta] = f.stories.list({ kind: 'global' })
  f.stories.act({ action: 'rename', storyId: alpha!.id, name: 'Alpha work' })
  f.stories.act({ action: 'merge', storyId: beta!.id, intoId: alpha!.id })
  expect(f.stories.list({ kind: 'global' }).map(story => [story.name, story.events.length, story.userEdited])).toEqual([['Alpha work', 3, true]])
  f.stories.act({ action: 'undo' })
  expect(f.stories.list({ kind: 'global' }).map(story => [story.name, story.events.length])).toEqual([['Alpha work', 2], ['Beta', 1]])
  f.stories.act({ action: 'remove', storyId: beta!.id })
  expect(f.stories.unassignedCount({ kind: 'global' })).toBe(1)
  // A removed story is never recreated under the same name; a renamed one keeps the user's name.
  f.publish(f.a.id, ['Beta 2', 'Alpha 3'], 22)
  await assignStories(f.stories, answer({ stories: [{ key: 'new_1', level: 'feature', name: 'beta' }],
    assignments: [{ event: 'e_1', story: 'new_1' }, { event: 'e_2', story: 'story_1' }], concluded: [{ story: 'story_1', event: 'e_2' }] }), { kind: 'global' }, options)
  const after = f.stories.list({ kind: 'global' })
  expect(after.map(story => [story.name, story.state])).toEqual([['Alpha work', 'active']])
  expect(f.stories.unassignedCount({ kind: 'global' })).toBe(2)
  const moved = after[0]!.events[0]!.id
  f.stories.act({ action: 'move', eventId: moved, storyId: null })
  expect(f.stories.unassignedCount({ kind: 'global' })).toBe(3)
  expect(() => f.stories.act({ action: 'move', eventId: moved, storyId: randomUUID() })).toThrow()
})

it('runs after publication inside the review and records failure without failing the review', async () => {
  const f = await fixture()
  const project = f.a
  f.db.replaceConversations([{ id: randomUUID(), projectId: project.id, title: 'C', updatedAt: Date.now(), messages: [
    { id: randomUUID(), role: 'user', content: 'Work on the timeline', createdAt: Date.now(), state: 'complete' }] }])
  const summarize = vi.fn(async (input: { evidence: Array<{ id: string; occurredAt: string; sourceType: string }> }) => ({ summary: 'S', changeDigest: '', openItems: [], entities: [], entityChanges: [], relations: [],
    events: input.evidence[0]?.sourceType === 'note' ? [] : [{ title: 'Timeline', description: 'd', occurredAt: input.evidence[0]!.occurredAt, eventType: 'discussion', entityIds: [], sourceReferenceIds: [input.evidence[0]!.id] }] }))
  const stories = vi.fn().mockRejectedValueOnce(new Error('Provider down')).mockImplementation(async () => ({ status: 'completed', ...(await assignStories(f.stories,
    answer({ stories: [{ key: 'new_1', level: 'feature', name: 'Timeline' }], assignments: [{ event: 'e_1', story: 'new_1' }] }), { kind: 'global' }, options)) }))
  const config: ReviewConfiguration = { version: 1, pageSize: 50, batchCharacters: 8000, batchMessages: 20, concurrency: 1, timeoutSeconds: 30, executionSeconds: 300 }
  const service = new SupervisorService({ collect: async () => { throw new Error('unused') } }, { summarize }, {
    scope: scope => f.db.resolveReviewScope(scope), start: (input, heartbeat) => f.db.startSupervisionRun(input, heartbeat),
    fail: (id, error) => f.db.failSupervisionRun(id, error), noChange: id => f.db.noChangeSupervisionRun(id), save: async result => f.db.saveSupervisionResult(result)
  }, { database: () => f.db.supervisionReviewStore(), configuration: async () => config, stories })
  const request = { trigger: 'manual' as const, scope: { kind: 'global' as const }, timeRange: { from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() } }
  const result = await service.run(request)
  expect(result.status).toBe('completed')
  expect(result.coverage?.stories).toMatchObject({ status: 'failed', error: 'Provider down' })
  // Retry on the published run, then a later no-change review has nothing left to assign.
  await expect(service.organizeStoriesFor(result.runId!)).resolves.toMatchObject({ stories: { status: 'completed', assigned: 1 } })
  expect(f.stories.list({ kind: 'global' }).map(story => story.name)).toEqual(['Timeline'])
  await expect(service.run(request)).resolves.toMatchObject({ status: 'no_change', coverage: { stories: { status: 'completed', calls: 0 } } })
})

it.each(['remove', 'merge'] as const)('rejects an assignment whose selected story was changed by %s while awaiting the model', async action => {
  const f = await fixture()
  f.publish(f.a.id, ['First', 'Second'])
  await assignStories(f.stories, answer({ stories: [{ key: 'new_1', level: 'feature', name: 'Alpha' }, { key: 'new_2', level: 'feature', name: 'Beta' }],
    assignments: [{ event: 'e_1', story: 'new_1' }, { event: 'e_2', story: 'new_2' }] }), { kind: 'global' }, options)
  const [alpha, beta] = f.stories.list({ kind: 'global' })
  f.publish(f.a.id, ['New evidence'], 22)
  const model = async () => {
    f.stories.act(action === 'remove' ? { action, storyId: alpha!.id } : { action, storyId: alpha!.id, intoId: beta!.id })
    return JSON.stringify({ stories: [{ key: 'new_1', level: 'feature', name: 'Must roll back' }], assignments: [{ event: 'e_1', story: 'story_1' }] })
  }
  await expect(assignStories(f.stories, model, { kind: 'global' }, options)).rejects.toThrow('Story changed')
  expect(f.stories.pending({ kind: 'global' })).toHaveLength(1)
  expect(f.stories.list({ kind: 'global' }).map(story => story.name)).toEqual(['Beta'])
  expect(f.sql.prepare("SELECT COUNT(*) AS n FROM supervision_event_stories es JOIN supervision_stories s ON s.id = es.story_id WHERE s.status != 'current'").get()!.n).toBe(0)
  await assignStories(f.stories, answer({ assignments: [{ event: 'e_1', story: 'story_1' }] }), { kind: 'global' }, { ...options, threadEvents: 100 })
  expect(f.stories.pending({ kind: 'global' })).toEqual([])
  expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})

it.each(['feature', 'thread'] as const)('rejects a split after its %s was removed without leaving new threads', async removed => {
  const f = await fixture()
  f.publish(f.a.id, ['One', 'Two', 'Three', 'Four'])
  await assignStories(f.stories, answer({ stories: [{ key: 'new_1', level: 'feature', name: 'Feature' }, { key: 'new_2', level: 'thread', name: 'Thread', parent: 'new_1' }],
    assignments: [1, 2, 3, 4].map(n => ({ event: `e_${n}`, story: n === 4 ? 'new_2' : 'new_1' })) }), { kind: 'global' }, { ...options, threadEvents: 4 })
  const [feature, thread] = f.stories.list({ kind: 'global' })
  const input = f.stories.splitInput(feature!.id, 8000)
  f.stories.act({ action: 'remove', storyId: removed === 'feature' ? feature!.id : thread!.id })
  const before = f.stories.list({ kind: 'global' })
  expect(() => f.stories.split(input, { threads: [], moves: [{ event: 'e_1', thread: 'thread_1' }] }, 4)).toThrow('Story changed')
  expect(f.stories.list({ kind: 'global' })).toEqual(before)
  expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})
