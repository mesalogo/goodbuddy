import { z } from 'zod'

const taskIdSchema = z.string().uuid()
const boundedTaskTextSchema = z.string().trim().min(1).max(1_000)
const optionalTimestampSchema = z.string().datetime().optional()

export const knowledgeTaskScopeSchema = z.enum([
  'library',
  'source',
  'document'
])
export type KnowledgeTaskScope = z.infer<typeof knowledgeTaskScopeSchema>

export const knowledgeTaskKindSchema = z.enum([
  'source-sync',
  'document-process',
  'document-rebuild',
  'library-rebuild',
  'embedding-rebuild',
  'graph-rebuild',
  'parsing',
  'embedding',
  'graph'
])
export type KnowledgeTaskKind = z.infer<typeof knowledgeTaskKindSchema>

export const knowledgeTaskStageSchema = z.enum([
  'queued',
  'syncing',
  'reading',
  'parsing',
  'chunking',
  'indexing',
  'embedding',
  'graph',
  'finalizing'
])
export type KnowledgeTaskStage = z.infer<typeof knowledgeTaskStageSchema>

export const knowledgeTaskStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
  'interrupted'
])
export type KnowledgeTaskStatus = z.infer<typeof knowledgeTaskStatusSchema>

export const knowledgeTaskErrorSchema = z
  .object({
    message: boundedTaskTextSchema,
    remedy: boundedTaskTextSchema.optional()
  })
  .strict()
export type KnowledgeTaskError = z.infer<typeof knowledgeTaskErrorSchema>

export const knowledgeTaskItemSchema = z
  .object({
    id: taskIdSchema,
    libraryId: z.string().trim().min(1).max(128),
    parentTaskId: taskIdSchema.optional(),
    retryOfTaskId: taskIdSchema.optional(),
    sourceId: z.string().trim().min(1).max(128).optional(),
    documentId: z.string().trim().min(1).max(128).optional(),
    documentName: z.string().trim().min(1).max(512),
    scope: knowledgeTaskScopeSchema,
    kind: knowledgeTaskKindSchema,
    stage: knowledgeTaskStageSchema,
    status: knowledgeTaskStatusSchema,
    progress: z.number().int().min(0).max(100),
    completedItems: z.number().int().nonnegative().optional(),
    totalItems: z.number().int().nonnegative().optional(),
    message: z.string().trim().max(1_000).optional(),
    error: knowledgeTaskErrorSchema.optional(),
    attempt: z.number().int().positive(),
    canCancel: z.boolean(),
    canRetry: z.boolean(),
    embeddingJobId: z.string().trim().min(1).max(256).optional(),
    createdAt: z.string().datetime(),
    startedAt: optionalTimestampSchema,
    completedAt: optionalTimestampSchema,
    updatedAt: z.string().datetime()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.completedItems !== undefined &&
      value.totalItems !== undefined &&
      value.completedItems > value.totalItems
    ) {
      context.addIssue({
        code: 'custom',
        message: 'completedItems must not exceed totalItems',
        path: ['completedItems']
      })
    }
    const terminal = [
      'succeeded',
      'failed',
      'cancelled',
      'skipped',
      'interrupted'
    ].includes(value.status)
    if (terminal && value.completedAt === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'terminal tasks must include completedAt',
        path: ['completedAt']
      })
    }
    if (value.status === 'failed' && value.error === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'failed tasks must include an error',
        path: ['error']
      })
    }
    if (value.status === 'succeeded' && value.progress !== 100) {
      context.addIssue({
        code: 'custom',
        message: 'succeeded tasks must report 100 percent',
        path: ['progress']
      })
    }
  })
export type KnowledgeTaskItem = z.infer<typeof knowledgeTaskItemSchema>

export const knowledgeTaskActionInputSchema = z
  .object({
    taskId: taskIdSchema
  })
  .strict()
export type KnowledgeTaskActionInput = z.infer<
  typeof knowledgeTaskActionInputSchema
>
