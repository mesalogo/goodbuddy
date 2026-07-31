import { z } from 'zod'

export const assistantIdSchema = z.string().uuid()
export const workModeSchema = z.enum(['ask', 'plan', 'execute'])

export const projectCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2_000),
    rootPath: z.string().trim().max(4_096),
    defaultWorkMode: workModeSchema
  })
  .strict()

export const projectUpdateSchema = projectCreateSchema

export type WorkMode = z.infer<typeof workModeSchema>
export type ProjectCreateInput = z.infer<typeof projectCreateSchema>

export const conversationSnapshotSchema = z
  .object({
    id: assistantIdSchema,
    projectId: assistantIdSchema.optional(),
    title: z.string().trim().min(1).max(200),
    updatedAt: z.number().int().nonnegative(),
    messages: z
      .array(
        z
          .object({
            id: assistantIdSchema,
            role: z.enum(['user', 'assistant']),
            content: z.string().max(1_000_000),
            createdAt: z.number().int().nonnegative(),
            state: z.enum(['streaming', 'complete', 'error']),
            status: z.string().max(4_000).optional(),
            tools: z
              .array(
                z
                  .object({
                    name: z.string().max(200),
                    state: z.enum([
                      'pending',
                      'running',
                      'completed',
                      'failed'
                    ]),
                    summary: z.string().max(2_000)
                  })
                  .strict()
              )
              .max(100)
              .optional(),
            sources: z.array(z.string().max(8_192)).max(100).optional()
          })
          .strict()
      )
      .max(500)
  })
  .strict()

export type ConversationSnapshot = z.infer<
  typeof conversationSnapshotSchema
>
export const conversationSnapshotsSchema = z
  .array(conversationSnapshotSchema)
  .max(100)

export type AssistantProject = ProjectCreateInput & {
  id: string
  status: 'active' | 'archived'
  createdAt: string
  updatedAt: string
}

export type WorkspaceChanges = {
  rootPath: string
  available: boolean
  status: string
  patch: string
  truncated: boolean
  error?: string
}

export type AssistantTaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type AssistantTask = {
  id: string
  projectId?: string
  conversationId?: string
  title: string
  instructions: string
  origin: 'user' | 'assistant' | 'schedule' | 'delegation' | 'subagent'
  status: AssistantTaskStatus
  progress?: number
  createdAt: string
  startedAt?: string
  completedAt?: string
  error?: string
}

export type AssistantArtifact = {
  id: string
  projectId?: string
  taskId?: string
  kind: 'markdown' | 'text' | 'json' | 'image' | 'file'
  title: string
  mimeType: string
  content?: string
  byteSize: number
  createdAt: string
  updatedAt: string
}

export const memoryCreateSchema = z
  .object({
    scope: z.enum(['global', 'project', 'conversation']),
    scopeId: z.string().max(256).optional(),
    type: z.enum(['preference', 'fact', 'summary', 'procedure']),
    content: z.string().trim().min(1).max(8_000)
  })
  .strict()

export type MemoryCreateInput = z.infer<typeof memoryCreateSchema>

export type AssistantMemory = MemoryCreateInput & {
  id: string
  confidence: number
  salience: number
  status: 'proposed' | 'confirmed' | 'rejected'
  createdAt: string
  updatedAt: string
}

export const scheduleCreateSchema = z
  .object({
    projectId: z.string().uuid().optional(),
    title: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(100_000),
    workMode: z.enum(['ask', 'plan']),
    recurrence: z.enum(['once', 'daily', 'weekly']),
    nextRunAt: z.string().datetime({ offset: true })
  })
  .strict()

export type ScheduleCreateInput = z.infer<typeof scheduleCreateSchema>

export type AssistantSchedule = ScheduleCreateInput & {
  id: string
  enabled: boolean
  lastRunAt?: string
  createdAt: string
  updatedAt: string
}

export const expertCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500),
    systemInstructions: z.string().trim().min(1).max(20_000)
  })
  .strict()

export type ExpertCreateInput = z.infer<typeof expertCreateSchema>

export type AssistantExpert = ExpertCreateInput & {
  id: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}
