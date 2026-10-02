import { z } from 'zod'
import { heartbeatScopeSchema } from './assistant-contracts'

export type SupervisionStory = {
  id: string
  projectId: string | null
  projectName: string | null
  parentId: string | null
  level: 'feature' | 'thread' | 'cross'
  name: string
  description: string
  /** `concluded` only when an event states it; quiet stories stay active. */
  state: 'active' | 'concluded'
  stateEventId: string | null
  userEdited: boolean
  /** primary events make up the story's length and density; others are associated links (cross-project). */
  events: SupervisionStoryEvent[]
  startedAt: string | null
  endedAt: string | null
}

export type SupervisionStoryEvent = { id: string; title: string; projectId: string | null; startedAt: string; endedAt: string; primary: boolean; userSet: boolean }

/** An experience (W) distilled from stories: usable as soon as it is extracted, editable by the user. */
export type SupervisionExperience = {
  id: string
  statement: string
  conditions: string
  boundaries: string
  userEdited: boolean
  /** `formed`: evidence events; `applied`: later events where it was used, with the outcome. */
  events: SupervisionExperienceEvent[]
}

export type SupervisionExperienceEvent = {
  id: string
  role: 'formed' | 'applied'
  note: string
  title: string
  projectId: string | null
  at: string
  storyId: string | null
  storyName: string | null
}

export type SupervisionStoryView = { stories: SupervisionStory[]; experiences: SupervisionExperience[]; unassigned: number; canUndo: boolean }

export const supervisionStoryListSchema = z.object({ scope: heartbeatScopeSchema }).strict()
export type SupervisionStoryListRequest = z.infer<typeof supervisionStoryListSchema>

export const supervisionStoryActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rename'), storyId: z.string().uuid(), name: z.string().trim().min(1).max(60), description: z.string().trim().max(400).optional() }).strict(),
  z.object({ action: z.literal('merge'), storyId: z.string().uuid(), intoId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('remove'), storyId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('move'), eventId: z.string().min(1).max(256), storyId: z.string().uuid().nullable() }).strict(),
  z.object({ action: z.literal('undo') }).strict(),
  z.object({ action: z.literal('experience-edit'), experienceId: z.string().uuid(), statement: z.string().trim().min(1).max(200),
    conditions: z.string().trim().max(400), boundaries: z.string().trim().max(400) }).strict(),
  z.object({ action: z.literal('experience-merge'), experienceId: z.string().uuid(), intoId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('experience-remove'), experienceId: z.string().uuid() }).strict()
])
export type SupervisionStoryAction = z.infer<typeof supervisionStoryActionSchema>
export type SupervisionExperienceAction = Extract<SupervisionStoryAction, { action: `experience-${string}` }>
