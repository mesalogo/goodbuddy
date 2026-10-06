import { describe, expect, it } from 'vitest'
import type { SupervisionStory } from '../../shared/supervision-story-contracts'
import { buildStoryTree, clusterEvents, experienceLinks, radiusLevels, selectionFocus, storyWindow, timelineSegments, visibleLevel } from './story-graph-3d-model'

const day = 86_400_000
const at = (d: number) => new Date(Date.parse('2026-09-01T00:00:00Z') + d * day).toISOString()
const story = (id: string, level: SupervisionStory['level'], days: number[], extra: Partial<SupervisionStory> = {}): SupervisionStory => ({
  id, projectId: level === 'cross' ? null : 'p1', projectName: level === 'cross' ? null : 'goodbuddy', parentId: null, level, name: id, description: '',
  state: 'active', stateEventId: null, userEdited: false, startedAt: at(days[0] ?? 0), endedAt: at(days.at(-1) ?? 0),
  events: days.map((d, i) => ({ id: `${id}-${i}`, title: `${id} ${i}`, projectId: 'p1', startedAt: at(d), endedAt: at(d), primary: level !== 'cross', userSet: false })),
  ...extra
})

describe('story graph 3d model', () => {
  it('resolves external selections across hidden hierarchies without moving visible events to another level', () => {
    const tree = buildStoryTree([story('a', 'feature', [1]), story('thread', 'thread', [2], { parentId: 'a' }),
      story('b', 'feature', [3], { projectId: 'p2' }), story('cross', 'cross', [4])], new Map())
    const a = tree.children[0]!.children[0]!
    const b = tree.children[1]!.children[0]!
    expect(selectionFocus(tree, tree, { kind: 'event', id: 'b-0' }, [])?.node).toBe(tree)
    expect(selectionFocus(tree, a, { kind: 'event', id: 'b-0' }, [])?.node).toBe(b)
    expect(selectionFocus(tree, b, { kind: 'event', id: 'thread-0' }, [])?.node).toBe(a.children[0])
    const featureEvent = selectionFocus(tree, b, { kind: 'event', id: 'a-0' }, [])!
    expect(featureEvent.node).toBe(a.parent)
    expect(visibleLevel(featureEvent.node).children.some(node => node.events.some(event => event.id === 'a-0'))).toBe(true)
    expect(selectionFocus(tree, b, { kind: 'story', id: 'a' }, [])).toMatchObject({ node: a, angle: (a.a0 + a.a1) / 2, time: (a.start + a.end) / 2 })
    expect(selectionFocus(tree, a, { kind: 'story', id: 'cross' }, [])?.node.level).toBe('cross')
    expect(selectionFocus(tree, a, { kind: 'event', id: 'missing' }, [])).toBeUndefined()
  })

  it('finds a hidden experience at its linking level even outside the default six-link limit', () => {
    const tree = buildStoryTree([story('a', 'feature', [1]), story('b', 'feature', [3])], new Map())
    const experiences = Array.from({ length: 7 }, (_, i) => ({ id: `w${i}`, statement: '', conditions: '', boundaries: '', userEdited: false,
      events: ['a-0', 'b-0'].map((id, index) => ({ id, role: index ? 'applied' as const : 'formed' as const, at: at(index ? 3 : 1), note: '', title: '', projectId: 'p1', storyId: null, storyName: null })) }))
    expect(experienceLinks(experiences, tree.children[0]!.children).some(link => link.id === 'w6')).toBe(false)
    const target = selectionFocus(tree, tree, { kind: 'experience', id: 'w6' }, experiences)
    expect(target?.node).toBe(tree.children[0])
    expect(target?.time).toBe(Date.parse(at(2)))
    expect(selectionFocus(tree, tree, { kind: 'experience', id: 'missing' }, experiences)).toBeUndefined()
    const nested = buildStoryTree([story('feature', 'feature', []), story('a', 'thread', [1], { parentId: 'feature' }),
      story('b', 'thread', [3], { parentId: 'feature' })], new Map())
    const project = nested.children[0]!
    expect(selectionFocus(nested, project, { kind: 'experience', id: 'w6' }, experiences)?.node).toBe(project.children[0])
  })

  it('retains historical IDs and genuinely unassigned events without borrowing current replacements', () => {
    const saved = (id: string, project_id: string | null, d: number) => ({ id, project_id, title: 'Same title', description: '', occurred_at: at(d), started_at: at(d - 0.5) })
    const events = [saved('old-extraction', 'p1', 1), saved('never-assigned', 'p1', 2), saved('unknown-project', null, 3), saved('exact-member', 'p1', 4)]
    const current = story('feature', 'feature', [1, 4], { events: [
      { id: 'replacement', title: 'Same title', projectId: 'p1', startedAt: at(1), endedAt: at(1), primary: true, userSet: false },
      { id: 'exact-member', title: 'Current title', projectId: 'p1', startedAt: at(9), endedAt: at(9), primary: true, userSet: false }
    ] })
    const tree = buildStoryTree([current], new Map([['p1', 'Project']]), { events, unassigned: 'Unassigned', unknownProject: 'Unknown' })
    expect(tree.events.map(event => event.id)).toEqual(events.map(event => event.id))
    expect(tree.children[0]!.children.map(node => [node.level, node.events.map(event => event.id)])).toEqual([
      ['feature', ['exact-member']], ['unassigned', ['old-extraction', 'never-assigned']]
    ])
    expect(tree.children[1]!.name).toBe('Unknown')
    expect(tree.events.at(-1)).toEqual({ id: 'exact-member', title: 'Same title', t: Date.parse(at(3.5)), end: Date.parse(at(3.5)), storyId: 'feature' })
    const beforeStories = buildStoryTree([], new Map([['p1', 'Project']]), { events, unassigned: 'Unassigned', unknownProject: 'Unknown' })
    expect(beforeStories.events.map(event => event.id)).toEqual(tree.events.map(event => event.id))
    expect(beforeStories.events.every(event => !event.storyId)).toBe(true)
    expect(beforeStories.children.flatMap(project => project.children).every(node => node.level === 'unassigned')).toBe(true)
  })

  it('builds project › feature › thread with cross stories at the root and spans from primary events', () => {
    const tree = buildStoryTree([story('feature', 'feature', [3, 1]), story('thread', 'thread', [5], { parentId: 'feature' }),
      story('empty', 'feature', []), story('cross', 'cross', [2, 8])], new Map())
    expect(tree.children.map(node => [node.level, node.name])).toEqual([['project', 'goodbuddy'], ['cross', 'cross']])
    const feature = tree.children[0]!.children[0]!
    expect(feature.events.map(event => event.id)).toEqual(['feature-1', 'feature-0', 'thread-0'])
    expect([feature.start, feature.end]).toEqual([Date.parse(at(1)), Date.parse(at(5))])
    expect(tree.children[0]!.children).toHaveLength(1)
    // Every level fills a full circle without overlap.
    const kids = tree.children
    expect(kids[0]!.a0).toBe(0)
    expect(kids.at(-1)!.a1).toBeCloseTo(Math.PI * 2)
    expect(visibleLevel(feature.children[0]!)).toBe(feature)
  })

  it('chooses a turn length that keeps about eight and at most fourteen turns', () => {
    expect(storyWindow(0, 7 * day).turnHours).toBe(24)
    expect(storyWindow(0, day).turnHours).toBe(3)
    expect(storyWindow(0, 13 * day).turnHours).toBe(24)
    expect(storyWindow(0, 90 * day).turnHours).toBe(168)
    expect(storyWindow(0, 365 * day).turnHours).toBe(2160)
    const years = storyWindow(0, 3 * 365 * day)
    expect(years.turns).toBeLessThanOrEqual(14)
    expect(storyWindow(0, 3 * day, 3).turnHours).toBe(6)
  })

  it('colors only saved intervals with primary membership, keeping points, gaps and overlaps truthful', () => {
    const feature = story('feature', 'feature', [1])
    const cross = story('cross', 'cross', [1], { events: feature.events.map(event => ({ ...event, primary: false })) })
    const tree = buildStoryTree([feature, cross], new Map(), { unassigned: 'Unassigned', unknownProject: 'Unknown', events: [
      { id: 'feature-0', title: 'Saved interval', description: '', occurred_at: at(1), started_at: at(1), ended_at: at(3) },
      { id: 'point', title: 'Point', description: '', occurred_at: at(5) }
    ] })
    expect(tree.events[0]).toMatchObject({ t: Date.parse(at(1)), end: Date.parse(at(3)), storyId: 'feature' })
    expect(tree.children[0]!.end).toBe(Date.parse(at(3)))
    expect(tree.children.find(node => node.level === 'cross')!.events[0]!.storyId).toBe('feature')
    const segments = timelineSegments(tree.events, storyWindow(Date.parse(at(0)), Date.parse(at(6))))
    expect(segments.map(segment => [(segment.from - Date.parse(at(0))) / day, (segment.to - Date.parse(at(0))) / day, segment.event?.storyId])).toEqual([
      [0, 1, undefined], [1, 3, 'feature'], [3, 6, undefined]
    ])
    const overlapping = [
      { id: 'a', title: '', t: -1, end: 6, storyId: 'one' },
      { id: 'b', title: '', t: 2, end: 4, storyId: 'two' },
      { id: 'c', title: '', t: 2, end: 3, storyId: 'three' },
      { id: 'point', title: '', t: 7, end: 7 },
      { id: 'unassigned', title: '', t: 8, end: 12 }
    ]
    const mapped = timelineSegments(overlapping, storyWindow(0, 10))
    expect(mapped.map(segment => [segment.from, segment.to, segment.event?.id])).toEqual([
      [0, 2, 'a'], [2, 3, 'b'], [3, 4, 'b'], [4, 6, 'a'], [6, 8, undefined], [8, 10, 'unassigned']
    ])
    expect(timelineSegments([...overlapping].reverse(), storyWindow(0, 10))).toEqual(mapped)
  })

  it('keeps each turn round with continuous transitions and actual density differences', () => {
    const window = storyWindow(Date.parse(at(0)), Date.parse(at(8)))
    const attention = [{ start: at(0.5), turns: 100, characters: 1 }, { start: at(4.5), turns: 1, characters: 1 }]
    const level = radiusLevels(window, attention)
    const turn = (d: number) => Array.from({ length: 21 }, (_, i) => level((d + 0.2 + i * 0.03) / window.turns))
    expect(new Set(turn(0)).size).toBe(1)
    expect(level(0.5 / window.turns)).toBe(1)
    let previous = level(0), largest = 0
    for (let i = 1; i <= 800; i++) { const next = level(i / 800); largest = Math.max(largest, Math.abs(next - previous)); previous = next }
    expect(largest).toBeLessThan(0.06)
    expect(level(4.5 / window.turns)).toBeCloseTo(0.1)
    expect(level(2.5 / window.turns)).toBe(0)
    for (let d = 1; d < window.turns; d++) {
      expect(level((d - 1e-8) / window.turns)).toBeCloseTo(level((d + 1e-8) / window.turns), 6)
    }
  })

  it('normalizes hourly rates including partial turns without inventing variation for equal densities', () => {
    const window = storyWindow(Date.parse(at(0)), Date.parse(at(0)) + 7.5 * 3_600_000, 3)
    const attention = Array.from({ length: 8 }, (_, hour) => ({
      start: new Date(window.from + hour * 3_600_000).toISOString(), turns: hour === 7 ? 2 : 4, characters: 0
    }))
    const level = radiusLevels(window, attention)
    for (const u of [0, 0.2, 0.5, 0.8, 1]) expect(level(u)).toBeCloseTo(1)
    expect(radiusLevels(window, [])(0.5)).toBe(0)
    expect(storyWindow(0, 1_800_000).turns).toBeCloseTo(1 / 6)
  })

  it('retains a clipped boundary bucket and ignores attention outside the selected interval', () => {
    const from = Date.parse(at(0)) + 50 * 60_000
    const window = storyWindow(from, from + 6 * 3_600_000, 3)
    const level = radiusLevels(window, [
      { start: at(-1), turns: 10000, characters: 0 },
      { start: at(0), turns: 4, characters: 0 },
      { start: new Date(from + 4 * 3_600_000).toISOString(), turns: 1, characters: 0 }
    ])
    expect(level(0.25)).toBe(1)
    expect(level(0.75)).toBe(0.5)
  })

  it('merges events closer than the span and keeps the rest apart', () => {
    const events = [0, 1, 2, 50].map(t => ({ id: String(t), title: '', t }))
    expect(clusterEvents(events, 5).map(cluster => cluster.events.length)).toEqual([3, 1])
    expect(clusterEvents(events, 0).map(cluster => cluster.events.length)).toEqual([1, 1, 1, 1])
  })
it('links an experience from the stave it formed in to the first later stave that applied it, once', () => {
    const tree = buildStoryTree([story('a', 'feature', [1, 2]), story('b', 'feature', [3, 6]), story('c', 'feature', [4])], new Map())
    const staves = tree.children[0]!.children
    const event = (id: string, role: 'formed' | 'applied', d: number) => ({ id, role, note: '', title: id, projectId: 'p1', at: at(d), storyId: null, storyName: null })
    const experience = (id: string, events: ReturnType<typeof event>[]) => ({ id, statement: id, conditions: '', boundaries: '', userEdited: false, events })
    const links = experienceLinks([
      experience('reused', [event('a-0', 'formed', 1), event('a-1', 'applied', 2), event('c-0', 'applied', 4), event('b-1', 'applied', 6)]),
      experience('same story only', [event('a-0', 'formed', 1), event('a-1', 'applied', 2)]),
      experience('applied before formed', [event('b-1', 'formed', 6), event('a-0', 'applied', 1)]),
      experience('outside the level', [event('zzz', 'formed', 1), event('b-0', 'applied', 3)])
    ], staves)
    expect(links.map(link => [link.id, link.from.stave.name, link.to.stave.name])).toEqual([['reused', 'a', 'c']])
    const [link] = links
    expect(link!.t).toBe((Date.parse(at(1)) + Date.parse(at(4))) / 2)
    expect(experienceLinks([experience('reused', [event('a-0', 'formed', 1), event('c-0', 'applied', 4)])], staves, 0)).toEqual([])
  })
})
