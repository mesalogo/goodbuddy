import { z } from 'zod'
import type { SupervisionEvidence, SupervisionSummaryOutput } from './supervision-contracts'

export const supervisionReviewSettingsSchema = z.object({
  pageSize: z.number().int().min(1).max(200).default(50),
  batchCharacters: z.number().int().min(1000).max(16000).default(8000),
  batchMessages: z.number().int().min(1).max(50).default(20),
  executionSeconds: z.number().int().min(30).max(3600).default(300),
  responseKiB: z.number().int().min(100).max(16384).optional(),
  // Off: an event can only join knowledge already seen in the same project.
  crossProject: z.boolean().optional(),
  // A feature splits into sub-threads only once it holds at least this many events.
  storyThreadEvents: z.number().int().min(4).max(500).optional(),
  // A story is offered to experience extraction only once it holds at least this many events.
  experienceMinEvents: z.number().int().min(2).max(200).optional(),
  // A heartbeat suggests looking at an active story with no new events for this many days.
  stalledDays: z.number().int().min(1).max(365).optional()
}).strict()
export const defaultStoryThreadEvents = 20
export const defaultExperienceMinEvents = 5
export const defaultStalledDays = 14
export type SupervisionReviewSettings = z.infer<typeof supervisionReviewSettingsSchema>
export const defaultSupervisionReviewSettings = supervisionReviewSettingsSchema.parse({})
export const supervisionReviewIdSchema = z.object({ runId: z.string().uuid() }).strict()
export type SupervisionReviewExecution = {
  active: boolean
  runId?: string
  stopping?: 'paused' | 'cancelled'
}
export const supervisionBatchesRequestSchema = supervisionReviewIdSchema.extend({
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(20).default(10)
})
export type SupervisionReviewProgress = {
  runId: string
  batches: number
  characters: number
  sources: number
  remainingSources: number
  /** Sources excluded because their owning conversation was deleted; not reviewed coverage. */
  omittedSources?: number
  /** Sources that changed during the run and were reviewed again at their newer version. */
  revisedSources?: number
  complete: boolean
  restartRequired?: boolean
  inFlight?: number
  phase?: 'collecting' | 'extracting' | 'summarizing' | 'saving'
  navigationNodes?: number
  /** Story assignment after publication. A failure leaves the published review intact. */
  stories?: { status: 'running' | 'completed' | 'failed'; error?: string; calls?: number; assigned?: number; unassigned?: number; created?: number
    /** Experience extraction after story assignment; its failure leaves the stories intact and is retried with them. */
    experiences?: { status: 'completed' | 'failed'; error?: string; calls?: number; candidates?: number; created?: number; applied?: number } }
  settings?: SupervisionReviewSettings & { timeoutSeconds: number; concurrency: number }
}
export type SupervisionReviewBatch = {
  id: string
  projectId: string
  conversationId: string
  evidence: SupervisionEvidence[]
  output: SupervisionSummaryOutput
}
