import { z } from 'zod'

export const assistantStorageProgressSchema = z.object({
  stage: z.enum(['scanning', 'converting', 'compacting', 'complete', 'failed']),
  processed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  bytesBefore: z.number().nonnegative(),
  bytesAfter: z.number().nonnegative().optional(),
  error: z.string().optional()
}).strict()

export type AssistantStorageProgress = z.infer<
  typeof assistantStorageProgressSchema
>
export const assistantStorageActionSchema = z.enum(['retry', 'quit'])
