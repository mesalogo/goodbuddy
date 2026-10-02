import { describe, expect, it } from 'vitest'
import type { SupervisionStory } from '../../shared/supervision-story-contracts'
import { buildStoryTree, clusterEvents, radiusLevels, storyWindow, visibleLevel } from './story-graph-3d-model'

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

  it('keeps each turn round: one radius per turn, bounded change between turns', () => {
    const window = storyWindow(Date.parse(at(0)), Date.parse(at(8)))
    const attention = [{ start: at(0.5), turns: 100, characters: 1 }, { start: at(4.5), turns: 1, characters: 1 }]
    const level = radiusLevels(window, attention)
    const turn = (d: number) => Array.from({ length: 21 }, (_, i) => level((d + 0.2 + i * 0.03) / window.turns))
    expect(new Set(turn(0)).size).toBe(1)
    expect(level(0.5 / window.turns)).toBe(1)
    let previous = level(0), largest = 0
    for (let i = 1; i <= 800; i++) { const next = level(i / 800); largest = Math.max(largest, Math.abs(next - previous)); previous = next }
    expect(largest).toBeLessThan(0.05)
  })

  it('merges events closer than the span and keeps the rest apart', () => {
    const events = [0, 1, 2, 50].map(t => ({ id: String(t), title: '', t }))
    expect(clusterEvents(events, 5).map(cluster => cluster.events.length)).toEqual([3, 1])
    expect(clusterEvents(events, 0).map(cluster => cluster.events.length)).toEqual([1, 1, 1, 1])
  })
})
