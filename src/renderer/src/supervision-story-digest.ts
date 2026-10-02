import type { SupervisionExperience, SupervisionStory, SupervisionStoryEvent, SupervisionStoryView } from '../../shared/supervision-story-contracts'

/**
 * What happened to long-lived stories during one review period, read from stories already
 * stored; no model call. A story counts by its own primary events (a cross story by its links).
 * - advanced: had events in the period and already had events before it.
 * - started: its first event falls in the period.
 * - quiet: still active, had events before the period and none in it. Quiet is not "finished".
 * - concluded: marked concluded by an event in the period.
 * Experiences count as formed or applied when the corresponding event falls in the period.
 */
export type StoryDigestEntry = { story: SupervisionStory; events: SupervisionStoryEvent[]; latest: SupervisionStoryEvent }
export type ExperienceDigestEntry = { experience: SupervisionExperience; role: 'formed' | 'applied'; events: SupervisionExperience['events'] }
export type StoryDigest = {
  advanced: StoryDigestEntry[]
  started: StoryDigestEntry[]
  concluded: StoryDigestEntry[]
  quiet: Array<{ story: SupervisionStory; latest: SupervisionStoryEvent }>
  experiences: ExperienceDigestEntry[]
  unassigned: number
}

const own = (story: SupervisionStory) => story.events.filter(event => story.level === 'cross' || event.primary)

export function storyDigest(view: SupervisionStoryView, range: { from: string; to: string }): StoryDigest {
  const from = Date.parse(range.from)
  const to = Date.parse(range.to)
  const inRange = (value: string) => { const at = Date.parse(value); return at >= from && at <= to }
  const digest: StoryDigest = { advanced: [], started: [], concluded: [], quiet: [], experiences: [], unassigned: view.unassigned }
  // Features show their threads' work too; threads are listed on their own only when the feature is absent.
  const children = (story: SupervisionStory) => view.stories.filter(child => child.parentId === story.id)
  for (const story of view.stories) {
    if (story.level === 'thread' && view.stories.some(parent => parent.id === story.parentId)) continue
    const events = [...own(story), ...children(story).flatMap(own)].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
    if (!events.length) continue
    const during = events.filter(event => inRange(event.startedAt))
    const before = events.filter(event => Date.parse(event.startedAt) < from)
    if (during.length) {
      const entry = { story, events: during, latest: during[during.length - 1]! }
      if (story.state === 'concluded' && story.stateEventId && during.some(event => event.id === story.stateEventId)) digest.concluded.push(entry)
      else if (before.length) digest.advanced.push(entry)
      else digest.started.push(entry)
    } else if (before.length && story.state === 'active' && story.level !== 'cross') {
      digest.quiet.push({ story, latest: before[before.length - 1]! })
    }
  }
  const byActivity = (a: StoryDigestEntry, b: StoryDigestEntry) => b.events.length - a.events.length || b.latest.startedAt.localeCompare(a.latest.startedAt)
  digest.advanced.sort(byActivity)
  digest.started.sort(byActivity)
  digest.concluded.sort(byActivity)
  digest.quiet.sort((a, b) => b.latest.startedAt.localeCompare(a.latest.startedAt))
  for (const experience of view.experiences) {
    const applied = experience.events.filter(event => event.role === 'applied' && inRange(event.at))
    const formed = experience.events.filter(event => event.role === 'formed')
    // Formed in the period when its earliest evidence is in the period.
    const first = formed.map(event => event.at).sort()[0]
    if (first && inRange(first)) digest.experiences.push({ experience, role: 'formed', events: formed.filter(event => inRange(event.at)) })
    else if (applied.length) digest.experiences.push({ experience, role: 'applied', events: applied })
  }
  return digest
}
