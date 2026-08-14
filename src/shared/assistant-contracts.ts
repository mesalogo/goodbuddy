import { z } from 'zod'
import { agentRuntimeSelectionSchema } from './runtime-selection-contracts'

export const assistantIdSchema = z.string().uuid()
export const interactiveWorkModes = ['ask', 'execute'] as const
export const workModeSchema = z.enum(interactiveWorkModes)
export const legacyWorkModeSchema = z.enum([
  'ask',
  'plan',
  'execute'
])
export const projectKindSchema = z.enum(['user', 'channel'])
export const projectChannels = [
  'weixin',
  'wecom',
  'dingtalk'
] as const
export const projectChannelSchema = z.enum(projectChannels)
export const projectChannelLabels: Record<ProjectChannel, string> = {
  weixin: '微信 ClawBot',
  wecom: '企业微信',
  dingtalk: '钉钉'
}

export type WorkMode = z.infer<typeof workModeSchema>
export type LegacyWorkMode = z.infer<typeof legacyWorkModeSchema>
export type InteractiveWorkMode = (typeof interactiveWorkModes)[number]
export type ProjectKind = z.infer<typeof projectKindSchema>
export type ProjectChannel = z.infer<typeof projectChannelSchema>

export function normalizeInteractiveWorkMode(
  workMode: LegacyWorkMode | undefined
): InteractiveWorkMode {
  return workMode === 'execute' ? 'execute' : 'ask'
}

export const projectCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2_000),
    rootPath: z.string().trim().max(4_096),
    defaultWorkMode: workModeSchema,
    runtimeSelection: agentRuntimeSelectionSchema.optional()
  })
  .strict()

export const projectUpdateSchema = projectCreateSchema

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>

export const conversationAttachmentSchema = z
  .object({
    id: assistantIdSchema,
    name: z.string().trim().min(1).max(500),
    size: z.number().int().nonnegative().max(12 * 1024 * 1024),
    preview: z.string().max(500),
    kind: z.enum(['text', 'image']),
    thumbnailUrl: z
      .string()
      .max(2_000_000)
      .refine(
        (value) =>
          value.startsWith('data:image/png;base64,') ||
          value.startsWith('data:image/jpeg;base64,'),
        '会话附件缩略图格式无效'
      )
      .optional(),
    contentUrl: z
      .string()
      .max(400_000)
      .refine(
        (value) =>
          value.startsWith('data:image/png;base64,') ||
          value.startsWith('data:image/jpeg;base64,'),
        '会话附件图片格式无效'
      )
      .optional()
  })
  .strict()

export type ConversationAttachment = z.infer<
  typeof conversationAttachmentSchema
>

export const conversationToolActivitySchema = z
  .object({
    callId: z.string().max(256).optional(),
    name: z.string().max(200),
    state: z.enum([
      'pending',
      'running',
      'completed',
      'failed',
      'recoverable',
      'cancelled',
      'interrupted'
    ]),
    summary: z.string().max(2_000),
    input: z.string().max(4_000).optional(),
    output: z.string().max(16_000).optional(),
    error: z.string().max(2_000).optional()
  })
  .strict()

export const conversationMessageBlockSchema = z.discriminatedUnion('type', [
  z
    .object({
      id: assistantIdSchema,
      type: z.literal('text'),
      content: z.string().min(1).max(1_000_000)
    })
    .strict(),
  z
    .object({
      id: assistantIdSchema,
      type: z.literal('reasoning'),
      content: z.string().min(1).max(1_000_000)
    })
    .strict(),
  z
    .object({
      id: assistantIdSchema,
      type: z.literal('tool'),
      tool: conversationToolActivitySchema
    })
    .strict()
])

export const conversationMessageBlocksSchema = z
  .array(conversationMessageBlockSchema)
  .max(500)

export type ConversationToolActivity = z.infer<
  typeof conversationToolActivitySchema
>
export type ConversationMessageBlock = z.infer<
  typeof conversationMessageBlockSchema
>

export const conversationMessageSchema = z
  .object({
    id: assistantIdSchema,
    role: z.enum(['user', 'assistant']),
    content: z.string().max(1_000_000),
    reasoning: z.string().optional(),
    blocks: conversationMessageBlocksSchema.optional(),
    createdAt: z.number().int().nonnegative(),
    state: z.enum(['streaming', 'complete', 'error']),
    status: z.string().max(4_000).optional(),
    tools: z.array(conversationToolActivitySchema).max(100).optional(),
    sources: z.array(z.string().max(8_192)).max(100).optional(),
    sourceReferences: z
      .array(
        z
          .object({
            libraryId: assistantIdSchema,
            libraryName: z.string().max(200),
            documentId: assistantIdSchema,
            chunkId: assistantIdSchema.optional(),
            documentName: z.string().max(500),
            sourceName: z.string().max(500),
            sourceLocation: z.string().max(4_096).optional(),
            locator: z.string().max(1_000).optional(),
            snippet: z.string().max(16_000),
            rank: z.number().finite(),
            score: z.number().finite().optional(),
            lexicalRank: z.number().int().positive().optional(),
            vectorRank: z.number().int().positive().optional(),
            graphRank: z.number().int().positive().optional(),
            similarity: z.number().min(-1).max(1).optional(),
            retrievalChannels: z
              .array(z.enum(['fts', 'cjk', 'vector', 'graph']))
              .max(4)
              .optional(),
            evidenceIds: z
              .array(assistantIdSchema)
              .max(100)
              .optional()
          })
          .strict()
      )
      .max(20)
      .optional(),
    knowledgeRetrieval: z
      .object({
        mode: z.literal('always'),
        state: z.enum([
          'searching',
          'succeeded',
          'zero',
          'degraded',
          'failed',
          'cancelled'
        ]),
        libraryCount: z.number().int().min(1).max(20),
        resultCount: z.number().int().nonnegative().max(20),
        durationMs: z.number().int().nonnegative().optional(),
        usedChannels: z
          .array(z.enum(['fts', 'cjk', 'vector', 'graph']))
          .max(4),
        warnings: z.array(z.string().max(500)).max(20)
      })
      .strict()
      .optional(),
    artifactIds: z.array(assistantIdSchema).max(8).optional(),
    attachments: z
      .array(conversationAttachmentSchema)
      .max(8)
      .optional()
  })
  .strict()

export type ConversationMessage = z.infer<
  typeof conversationMessageSchema
>

export const conversationSnapshotSchema = z
  .object({
    id: assistantIdSchema,
    projectId: assistantIdSchema.optional(),
    runtimeSelection: agentRuntimeSelectionSchema.optional(),
    knowledgeRetrievalMode: z.enum(['auto', 'always']).optional(),
    remote: z
      .object({
        channel: projectChannelSchema,
        accountDisplay: z.string().trim().min(1).max(200),
        conversationType: z.enum(['direct', 'group'])
      })
      .strict()
      .optional(),
    title: z.string().trim().min(1).max(200),
    updatedAt: z.number().int().nonnegative(),
    messages: z
      .array(conversationMessageSchema)
      .max(500)
  })
  .strict()

export type ConversationSnapshot = z.infer<
  typeof conversationSnapshotSchema
>
export const conversationSnapshotsSchema = z
  .array(conversationSnapshotSchema)
  .max(100)

export const localConversationHeaderSchema = conversationSnapshotSchema
  .omit({
    messages: true,
    remote: true
  })

export type LocalConversationHeader = z.infer<
  typeof localConversationHeaderSchema
>

export const localConversationSaveSchema = z
  .object({
    header: localConversationHeaderSchema,
    messages: z.array(conversationMessageSchema).max(500)
  })
  .strict()

export type LocalConversationSaveInput = z.infer<
  typeof localConversationSaveSchema
>

export const localConversationSaveBatchSchema = z
  .array(localConversationSaveSchema)
  .max(100)

export type LocalConversationSaveBatch = z.infer<
  typeof localConversationSaveBatchSchema
>

export type AssistantProject = ProjectCreateInput & {
  id: string
  kind: ProjectKind
  channel?: ProjectChannel
  status: 'active' | 'archived'
  createdAt: string
  updatedAt: string
}

export type WorkspaceChanges = {
  rootPath: string
  available: boolean
  status: string
  patch: string
  files: WorkspaceChangedFile[]
  truncated: boolean
  error?: string
}

export type WorkspaceChangedFile = {
  path: string
  status: string
  previousPath?: string
}

export type WorkspaceDirectoryEntry = {
  name: string
  path: string
  type: 'file' | 'directory'
}

export type WorkspaceDirectoryListing = {
  path: string
  entries: WorkspaceDirectoryEntry[]
  truncated: boolean
}

export type WorkspaceFilePreview = {
  path: string
  name: string
  content: string
  mimeType: 'text/markdown' | 'text/plain' | 'application/json'
  size: number
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
  parentTaskId?: string
  expertId?: string
  routingMode?: 'manual' | 'smart'
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

export type ModelUsageCallInput = {
  requestId: string
  callId: string
  runtime: string
  provider: string
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type TokenUsageRecord = {
  requestId: string
  projectId?: string
  projectName?: string
  conversationId?: string
  conversationTitle?: string
  runtime: string
  provider: string
  model: string
  callCount: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
}

export type TokenUsageSummary = {
  totals: {
    callCount: number
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    totalTokens: number
  }
  records: TokenUsageRecord[]
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
    workMode: z.literal('ask'),
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

export const heartbeatRecurrenceSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('daily'),
      localTime: z
        .string()
        .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
    })
    .strict(),
  z
    .object({
      type: z.literal('weekly'),
      localTime: z
        .string()
        .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
      weekday: z.number().int().min(0).max(6)
    })
    .strict()
])

export const heartbeatCreateSchema = z
  .object({
    projectId: assistantIdSchema.optional(),
    name: z.string().trim().min(1).max(120),
    timezone: z.string().trim().min(1).max(100),
    recurrence: heartbeatRecurrenceSchema,
    enabled: z.boolean(),
    lookbackHours: z.number().int().min(1).max(24 * 30),
    retentionDays: z.number().int().min(1).max(365)
  })
  .strict()

export const heartbeatUpdateSchema = heartbeatCreateSchema

export const heartbeatListSchema = z
  .object({
    projectId: assistantIdSchema.optional()
  })
  .strict()

export const heartbeatHistorySchema = z
  .object({
    configId: assistantIdSchema.optional(),
    limit: z.number().int().min(1).max(200).default(50)
  })
  .strict()

export const heartbeatIdSchema = z
  .object({
    id: assistantIdSchema
  })
  .strict()

export const heartbeatUpdateRequestSchema = z
  .object({
    id: assistantIdSchema,
    config: heartbeatUpdateSchema
  })
  .strict()

export const heartbeatPauseSchema = z
  .object({
    id: assistantIdSchema,
    paused: z.boolean()
  })
  .strict()

export const heartbeatRunNowSchema = z
  .object({
    id: assistantIdSchema,
    idempotencyKey: z.string().trim().min(1).max(200)
  })
  .strict()

export const heartbeatSummaryOutputSchema = z
  .object({
    summary: z.string().trim().min(1).max(12_000),
    highlights: z.array(z.string().trim().min(1).max(1_000)).max(20),
    proposedMemories: z
      .array(
        z
          .object({
            scope: z.enum(['global', 'project']),
            type: z.enum([
              'preference',
              'fact',
              'summary',
              'procedure'
            ]),
            content: z.string().trim().min(1).max(8_000),
            confidence: z.number().min(0).max(1),
            salience: z.number().min(0).max(1)
          })
          .strict()
      )
      .max(10),
    followUpTasks: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(200),
            instructions: z.string().trim().min(1).max(8_000)
          })
          .strict()
      )
      .max(10)
  })
  .strict()

export type HeartbeatRecurrence = z.infer<
  typeof heartbeatRecurrenceSchema
>
export type HeartbeatCreateInput = z.infer<
  typeof heartbeatCreateSchema
>
export type HeartbeatUpdateInput = z.infer<
  typeof heartbeatUpdateSchema
>
export type HeartbeatSummaryOutput = z.infer<
  typeof heartbeatSummaryOutputSchema
>

export type HeartbeatRunStatus =
  | 'claimed'
  | 'completed'
  | 'failed'
  | 'skipped'

export type AssistantHeartbeatConfig = HeartbeatCreateInput & {
  id: string
  nextRunAt: string
  lastRunAt?: string
  lastStatus?: HeartbeatRunStatus
  createdAt: string
  updatedAt: string
}

export type AssistantHeartbeatRun = {
  id: string
  configId: string
  trigger: 'scheduled' | 'manual'
  scheduledFor: string
  status: HeartbeatRunStatus
  attemptCount: number
  nextAttemptAt?: string
  startedAt?: string
  completedAt?: string
  error?: string
  entryId?: string
  createdAt: string
  updatedAt: string
}

export type AssistantHeartbeatEntry = {
  id: string
  configId: string
  runId: string
  scheduledFor: string
  summary: string
  highlights: string[]
  artifactId?: string
  proposedMemoryIds: string[]
  followUpTaskIds: string[]
  createdAt: string
}

const routingKeywordSchema = z
  .string()
  .transform((value) =>
    value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
  )
  .pipe(z.string().min(2).max(48))

export const expertCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500),
    systemInstructions: z.string().trim().min(1).max(20_000),
    modelProfileId: assistantIdSchema.optional(),
    routingKeywords: z
      .array(routingKeywordSchema)
      .max(32)
      .default([])
      .transform((keywords) => [...new Set(keywords)])
  })
  .strict()

export type ExpertCreateInput = z.input<typeof expertCreateSchema>
export type ExpertUpdateInput = ExpertCreateInput

export type AssistantExpert = z.output<typeof expertCreateSchema> & {
  id: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}
