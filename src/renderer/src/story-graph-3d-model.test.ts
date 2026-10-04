import { describe, expect, it } from 'vitest'
import type { SupervisionStory } from '../../shared/supervision-story-contracts'
import { buildStoryTree, clusterEvents, experienceLinks, radiusLevels, storyWindow, visibleLevel } from './story-graph-3d-model'

const day = 86_400_000
const at = (d: number) => new Date(Date.parse('2026-09-01T00:00:00Z') + d * day).toISOString()
const story = (id: string, level: SupervisionStory['level'], days: number[], extra: Partial<SupervisionStory> = {}): SupervisionStory => ({
  id, projectId: level === 'cross' ? null : 'p1', projectName: level === 'cross' ? null : 'goodbuddy', parentId: null, level, name: id, description: '',
  state: 'active', stateEventId: null, userEdited: false, startedAt: at(days[0] ?? 0), endedAt: at(days.at(-1) ?? 0),
  events: days.map((d, i) => ({ id: `${id}-${i}`, title: `${id} ${i}`, projectId: 'p1', startedAt: at(d), endedAt: at(d), primary: level !== 'cross', userSet: false })),
  ...extra
})

describe('story graph 3d model', () => {
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
