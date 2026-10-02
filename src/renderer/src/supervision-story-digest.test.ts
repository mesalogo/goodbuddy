import { expect, it } from 'vitest'
import type { SupervisionStory, SupervisionStoryView } from '../../shared/supervision-story-contracts'
import { storyDigest } from './supervision-story-digest'

const event = (id: string, at: string, primary = true) => ({ id, title: id, projectId: 'p', startedAt: at, endedAt: at, primary, userSet: false })
const story = (id: string, events: ReturnType<typeof event>[], extra: Partial<SupervisionStory> = {}): SupervisionStory => ({
  id, projectId: 'p', projectName: 'P', parentId: null, level: 'feature', name: id, description: '', state: 'active', stateEventId: null,
  userEdited: false, events, startedAt: events[0]?.startedAt ?? null, endedAt: events.at(-1)?.endedAt ?? null, ...extra })
const range = { from: '2026-09-20T00:00:00Z', to: '2026-09-27T00:00:00Z' }

it('sorts stories into advanced, started, concluded and quiet for the period, counting threads under their feature', () => {
  const view: SupervisionStoryView = { unassigned: 2, canUndo: false, experiences: [], stories: [
    story('Review', [event('r1', '2026-09-10T00:00:00Z'), event('r2', '2026-09-21T00:00:00Z')]),
    story('Review thread', [event('t1', '2026-09-22T00:00:00Z'), event('t2', '2026-09-23T00:00:00Z')], { level: 'thread', parentId: 'Review' }),
    story('Graph 3D', [event('g1', '2026-09-24T00:00:00Z')]),
    story('Release', [event('x1', '2026-09-05T00:00:00Z'), event('x2', '2026-09-25T00:00:00Z')], { state: 'concluded', stateEventId: 'x2' }),
    story('Notes', [event('n1', '2026-09-01T00:00:00Z'), event('n2', '2026-09-12T00:00:00Z')]),
    story('Done earlier', [event('d1', '2026-09-02T00:00:00Z')], { state: 'concluded', stateEventId: 'd1' }),
    story('Cross', [event('c1', '2026-09-01T00:00:00Z', false)], { level: 'cross', projectId: null }),
    story('Later', [event('l1', '2026-09-29T00:00:00Z')])
  ] }
  const digest = storyDigest(view, range)
  expect(digest.advanced.map(entry => [entry.story.name, entry.events.map(item => item.id), entry.latest.id])).toEqual([['Review', ['r2', 't1', 't2'], 't2']])
  expect(digest.started.map(entry => entry.story.name)).toEqual(['Graph 3D'])
  expect(digest.concluded.map(entry => entry.story.name)).toEqual(['Release'])
  // Quiet is active only; a concluded story and a cross story are not quiet; future-only stories are ignored.
  expect(digest.quiet.map(entry => [entry.story.name, entry.latest.id])).toEqual([['Notes', 'n2']])
  expect(digest.unassigned).toBe(2)
})

it('lists experiences formed in the period, or applied in it when formed earlier', () => {
  const formedEvent = (id: string, at: string, role: 'formed' | 'applied') => ({ id, role, note: '', title: id, projectId: 'p', at, storyId: 's', storyName: 'S' })
  const experience = (id: string, events: ReturnType<typeof formedEvent>[]) => ({ id, statement: id, conditions: '', boundaries: '', userEdited: false, events })
  const view: SupervisionStoryView = { unassigned: 0, canUndo: false, stories: [], experiences: [
    experience('new', [formedEvent('a', '2026-09-21T00:00:00Z', 'formed')]),
    experience('reused', [formedEvent('b', '2026-09-01T00:00:00Z', 'formed'), formedEvent('c', '2026-09-22T00:00:00Z', 'applied')]),
    experience('old', [formedEvent('d', '2026-09-01T00:00:00Z', 'formed')])
  ] }
  expect(storyDigest(view, range).experiences.map(entry => [entry.experience.id, entry.role, entry.events.map(item => item.id)]))
    .toEqual([['new', 'formed', ['a']], ['reused', 'applied', ['c']]])
})
