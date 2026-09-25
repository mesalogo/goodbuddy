import { z } from 'zod'
import type { SupervisionEvidence, SupervisionSummaryOutput } from './supervision-contracts'

export const supervisionReviewSettingsSchema = z.object({
  pageSize: z.number().int().min(1).max(200).default(50),
  batchCharacters: z.number().int().min(1000).max(16000).default(8000),
  batchMessages: z.number().int().min(1).max(50).default(20),
  executionSeconds: z.number().int().min(30).max(3600).default(300),
  responseKiB: z.number().int().min(100).max(16384).optional()
}).strict()
export type SupervisionReviewSettings = z.infer<typeof supervisionReviewSettingsSchema>
export const defaultSupervisionReviewSettings = supervisionReviewSettingsSchema.parse({})
export const supervisionReviewIdSchema = z.object({ runId: z.string().uuid() }).strict()
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
  complete: boolean
  restartRequired?: boolean
  inFlight?: number
  phase?: 'collecting' | 'extracting' | 'summarizing' | 'saving'
  navigationNodes?: number
  settings?: SupervisionReviewSettings & { timeoutSeconds: number; concurrency: number }
}
export type SupervisionReviewBatch = {
  id: string
  projectId: string
  conversationId: string
  evidence: SupervisionEvidence[]
  output: SupervisionSummaryOutput
}
