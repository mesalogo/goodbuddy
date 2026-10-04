import type { SupervisionAttentionSlot, SupervisionGraphView } from '../../shared/supervision-contracts'
import type { SupervisionExperience, SupervisionStory } from '../../shared/supervision-story-contracts'

/*
 * Pure model for the 3D story view (storyline model step 3), shared by the renderer and tests.
 * Height is time at a uniform scale; the helix radius is attention density, one radius per turn;
 * stories are staves on a fixed outer cylinder at stable angles. See docs/features/story-graph/3d-concept.md.
 */

export type StoryNode = {
  id: string
  name: string
  level: 'root' | 'project' | 'feature' | 'thread' | 'cross' | 'unassigned'
  parent?: StoryNode
  children: StoryNode[]
  /** Primary events of this node and its descendants; for cross stories, the events they link. */
  events: StoryEventPoint[]
  start: number
  end: number
  a0: number
  a1: number
  concluded: boolean
}
export type StoryEventPoint = { id: string; title: string; t: number }
export type StoryWindow = { from: number; to: number; turnHours: number; turns: number }

const TAU = Math.PI * 2
export const TURN_STEPS = [3, 6, 12, 24, 168, 720, 2160, 8760]
const TARGET_TURNS = 8, MAX_TURNS = 14, TRANSITION = 0.3

/** Current memberships of exact review IDs; missing memberships never imply replacement events. */
export function buildStoryTree(stories: SupervisionStory[], projectNames: Map<string, string>, review?: {
  events: SupervisionGraphView['events']; unassigned: string; unknownProject: string
}): StoryNode {
  const events = review && new Map(review.events.map(event => [event.id, event]))
  if (events) stories = stories.map(story => ({ ...story, events: story.events.filter(event => events.has(event.id)) }))
  const root: StoryNode = { id: 'root', name: '', level: 'root', children: [], events: [], start: 0, end: 0, a0: 0, a1: TAU, concluded: false }
  const node = (story: SupervisionStory, parent: StoryNode): StoryNode => ({ id: story.id, name: story.name, level: story.level, parent, children: [],
    events: story.events.filter(event => story.level === 'cross' || event.primary).map(event => {
      const saved = events?.get(event.id)
      return { id: event.id, title: saved?.title ?? event.title, t: Date.parse(saved?.started_at ?? saved?.occurred_at ?? event.startedAt) }
    }),
    start: 0, end: 0, a0: 0, a1: 0, concluded: story.state === 'concluded' })
  const projects = new Map<string, StoryNode>()
  for (const story of stories.filter(item => item.level === 'feature' && item.projectId)) {
    let project = projects.get(story.projectId!)
    if (!project) {
      project = { id: `project:${story.projectId}`, name: story.projectName ?? projectNames.get(story.projectId!) ?? story.projectId!, level: 'project',
        parent: root, children: [], events: [], start: 0, end: 0, a0: 0, a1: 0, concluded: false }
      projects.set(story.projectId!, project)
      root.children.push(project)
    }
    const feature = node(story, project)
    feature.children = stories.filter(item => item.parentId === story.id).map(thread => node(thread, feature))
    project.children.push(feature)
  }
  root.children.push(...stories.filter(item => item.level === 'cross').map(story => node(story, root)))
  if (review) {
    const assigned = new Set(stories.filter(story => story.level !== 'cross').flatMap(story => story.events.filter(event => event.primary).map(event => event.id)))
    for (const event of review.events) {
      if (assigned.has(event.id)) continue
      const projectId = event.project_id ?? ''
      let project = projects.get(projectId)
      if (!project) {
        project = { id: `project:${projectId}`, name: projectNames.get(projectId) ?? review.unknownProject, level: 'project',
          parent: root, children: [], events: [], start: 0, end: 0, a0: 0, a1: 0, concluded: false }
        projects.set(projectId, project)
        root.children.push(project)
      }
      let unassigned = project.children.find(child => child.level === 'unassigned')
      if (!unassigned) {
        unassigned = { id: `unassigned:${projectId}`, name: review.unassigned, level: 'unassigned', parent: project,
          children: [], events: [], start: 0, end: 0, a0: 0, a1: 0, concluded: false }
        project.children.push(unassigned)
      }
      unassigned.events.push({ id: event.id, title: event.title, t: Date.parse(event.started_at ?? event.occurred_at) })
    }
  }
  finish(root)
  layout(root, 0, TAU)
  return root
}

function finish(node: StoryNode): void {
  node.children.forEach(finish)
  if (node.level !== 'cross') {
    const own = new Map(node.events.map(event => [event.id, event]))
    for (const child of node.children) if (child.level !== 'cross') for (const event of child.events) own.set(event.id, event)
    node.events = [...own.values()]
  }
  node.events.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id))
  node.start = node.events[0]?.t ?? 0
  node.end = node.events.at(-1)?.t ?? 0
  node.children = node.children.filter(child => child.events.length > 0)
}

/** Angles by start time; width grows with the square root of event count, so small stories stay clickable. */
export function layout(node: StoryNode, from: number, to: number): void {
  node.a0 = from; node.a1 = to
  const kids = [...node.children].sort((a, b) => a.start - b.start || a.name.localeCompare(b.name))
  const weights = kids.map(kid => Math.max(1.2, Math.sqrt(kid.events.length)))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let at = from
  kids.forEach((kid, index) => { const width = (to - from) * weights[index]! / total; layout(kid, at, at + width); at += width })
}

/** Turn length keeps about 8 turns, at most 14, for any span from hours to years. */
export function storyWindow(from: number, to: number, turnHours?: number): StoryWindow {
  const span = Math.max(1 / 3_600_000, (to - from) / 3_600_000)
  // Closest to the target among steps that stay within the maximum (13 days → 1 day per turn, not 1.9 weekly turns).
  const fitting = TURN_STEPS.filter(step => span / step <= MAX_TURNS)
  let hours = turnHours ?? fitting.reduce((best, step) => Math.abs(span / step - TARGET_TURNS) < Math.abs(span / best - TARGET_TURNS) ? step : best, fitting[0] ?? TURN_STEPS.at(-1)!)
  if (span / hours > MAX_TURNS) hours = fitting[0] ?? TURN_STEPS.at(-1)!
  return { from, to: Math.max(to, from + 1), turnHours: hours, turns: span / hours }
}

/**
 * Radius level 0..1 at position u (0..1) along the window. Each turn holds one radius from its
 * messages per hour, so it reads as a circle; neighbouring turns ease at the boundary.
 * Hourly buckets are distributed by overlap; their within-hour timing is unavailable.
 */
export function radiusLevels(window: StoryWindow, attention: SupervisionAttentionSlot[]): (u: number) => number {
  const n = Math.max(1, Math.ceil(window.turns - 1e-6))
  const perTurn = new Array<number>(n).fill(0)
  const duration = (window.to - window.from) / window.turns
  for (const slot of attention) {
    // The review query includes its upper endpoint, including an exact hourly boundary.
    if (Date.parse(slot.start) === window.to) { perTurn[n - 1]! += slot.turns; continue }
    const start = Math.max(window.from, Date.parse(slot.start))
    const end = Math.min(window.to, Date.parse(slot.start) + 3_600_000)
    if (end <= start) continue
    for (let d = 0; d < n; d++) {
      const overlap = Math.max(0, Math.min(end, window.from + (d + 1) * duration) - Math.max(start, window.from + d * duration))
      perTurn[d]! += slot.turns * overlap / (end - start)
    }
  }
  // Normalize rates, not totals: the last partial turn has a shorter exposure.
  for (let d = 0; d < n; d++) perTurn[d]! /= Math.min(duration, window.to - window.from - d * duration) / 3_600_000
  const top = Math.max(1e-6, ...perTurn)
  const level = perTurn.map(value => Math.sqrt(value / top))
  return (u: number) => {
    const x = Math.max(0, Math.min(1, u)) * window.turns
    const d = Math.min(n - 1, Math.floor(x)), f = x - d, half = TRANSITION / 2
    const ease = (a: number, b: number, k: number) => a + (b - a) * (1 - Math.cos(k * Math.PI)) / 2
    if (f < half && d > 0) return ease(level[d - 1]!, level[d]!, (f + half) / TRANSITION)
    if (f > 1 - half && d < n - 1) return ease(level[d]!, level[d + 1]!, (f - 1 + half) / TRANSITION)
    return level[d]!
  }
}

export type StoryCluster = { t0: number; t1: number; t: number; events: StoryEventPoint[] }
/** Events closer than `span` (ms) along time merge into one band; zooming in re-splits them. */
export function clusterEvents(events: StoryEventPoint[], span: number): StoryCluster[] {
  const out: StoryCluster[] = []
  for (const event of events) {
    const last = out.at(-1)
    if (last && event.t - last.t0 <= span) { last.events.push(event); last.t1 = event.t }
    else out.push({ t0: event.t, t1: event.t, t: event.t, events: [event] })
  }
  for (const cluster of out) cluster.t = (cluster.t0 + cluster.t1) / 2
  return out
}

/** The staves shown for a focus: its children, or its siblings when it is a leaf. */
export function visibleLevel(focus: StoryNode): StoryNode {
  return focus.children.length || !focus.parent ? focus : focus.parent
}

export function findNode(root: StoryNode, id: string): StoryNode | undefined {
  if (root.id === id) return root
  for (const child of root.children) { const hit = findNode(child, id); if (hit) return hit }
  return undefined
}

export type ExperienceLink = {
  id: string
  statement: string
  /** Visible stave and event time where the experience formed (earliest) and where it was applied. */
  from: { stave: StoryNode; t: number }
  to: { stave: StoryNode; t: number }
  /** Node position outside the barrel: between the two staves in angle, between the two times in height. */
  angle: number
  t: number
}

/**
 * Experiences that link two different staves of the shown level: formed in one, applied later in another.
 * Each experience appears once, from its earliest formation to its earliest later application elsewhere.
 * At most `limit`, most-applied first, so the barrel never fills with arcs.
 */
export function experienceLinks(experiences: SupervisionExperience[], staves: StoryNode[], limit = 6): ExperienceLink[] {
  const owner = new Map<string, StoryNode>()
  for (const stave of staves) for (const event of stave.events) owner.set(event.id, stave)
  const links: Array<{ link: ExperienceLink; weight: number }> = []
  for (const experience of experiences) {
    const at = (event: SupervisionExperience['events'][number]) => ({ stave: owner.get(event.id), t: Date.parse(event.at) })
    const formed = experience.events.filter(event => event.role === 'formed').map(at).filter(item => item.stave).sort((a, b) => a.t - b.t)[0]
    if (!formed) continue
    const applied = experience.events.filter(event => event.role === 'applied').map(at)
      .filter(item => item.stave && item.stave !== formed.stave && item.t > formed.t).sort((a, b) => a.t - b.t)
    const to = applied[0]
    if (!to) continue
    const a = (formed.stave!.a0 + formed.stave!.a1) / 2, b = (to.stave!.a0 + to.stave!.a1) / 2
    // Midpoint along the shorter way round the barrel.
    let delta = b - a
    if (delta > Math.PI) delta -= TAU
    if (delta < -Math.PI) delta += TAU
    links.push({ link: { id: experience.id, statement: experience.statement, from: { stave: formed.stave!, t: formed.t }, to: { stave: to.stave!, t: to.t },
      angle: a + delta / 2, t: (formed.t + to.t) / 2 }, weight: new Set(applied.map(item => item.stave)).size })
  }
  return links.sort((x, y) => y.weight - x.weight || x.link.from.t - y.link.from.t).slice(0, limit).map(item => item.link)
}
