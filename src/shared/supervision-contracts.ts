import { z } from 'zod'
import { heartbeatScopeSchema } from './assistant-contracts'

export const supervisionTriggerSchema = z.enum(['manual', 'heartbeat'])
export type SupervisionTrigger = z.infer<typeof supervisionTriggerSchema>

export const supervisionTimeRangeSchema = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true })
  })
  .strict()
  .refine((value) => Date.parse(value.from) <= Date.parse(value.to), {
    message: '监督者时间范围无效'
  })

export const supervisionRunRequestSchema = z
  .object({
    trigger: supervisionTriggerSchema,
    scope: heartbeatScopeSchema,
    timeRange: supervisionTimeRangeSchema
  })
  .strict()

export type SupervisionRunRequest = z.infer<typeof supervisionRunRequestSchema>

export const supervisionEvidenceSchema = z
  .object({
    id: z.string().min(1).max(256),
    sourceType: z.enum(['conversation', 'task', 'note', 'memory', 'knowledge']),
    sourceId: z.string().min(1).max(256),
    title: z.string().max(500),
    content: z.string().max(8_000),
    occurredAt: z.string().datetime({ offset: true }),
    locator: z.record(z.string(), z.unknown()).optional()
  })
  .strict()

export type SupervisionEvidence = z.infer<typeof supervisionEvidenceSchema>

const sourceReferenceIdsSchema = z.array(z.string().min(1).max(256)).max(20)

export const supervisionEventSchema = z
  .object({
    title: z.string().min(1).max(240),
    description: z.string().max(2_000),
    occurredAt: z.string().datetime({ offset: true }),
    eventType: z.enum(['decision', 'change', 'discussion', 'milestone']),
    entityIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/)).max(40),
    sourceReferenceIds: sourceReferenceIdsSchema
  })
  .strict()

export const supervisionEntitySchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/),
    persistedId: z.string().uuid().optional(),
    label: z.string().min(1).max(240),
    description: z.string().max(2_000),
    sourceReferenceIds: sourceReferenceIdsSchema
  })
  .strict()

export const supervisionRelationSchema = z
  .object({
    fromEntityId: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/),
    toEntityId: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/),
    relationType: z.enum(['supports', 'depends-on', 'contrasts', 'related']),
    reason: z.string().max(1_000),
    sourceReferenceIds: sourceReferenceIdsSchema
  })
  .strict()

export const supervisionEntityChangeSchema = z.object({
  entityId: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/),
  changeType: z.enum(['proposed', 'added', 'verified', 'revised']),
  description: z.string().max(2_000),
  sourceReferenceIds: sourceReferenceIdsSchema
}).strict()

export const supervisionSummaryOutputSchema = z
  .object({
    summary: z.string().min(1).max(12_000),
    changeDigest: z.string().max(4_000),
  openItems: z.array(z.string().min(1).max(500)).max(20),
  events: z.array(supervisionEventSchema).max(40),
  entities: z.array(supervisionEntitySchema).max(40),
  entityChanges: z.array(supervisionEntityChangeSchema).max(80),
  relations: z.array(supervisionRelationSchema).max(80)
  })
  .strict()

export type SupervisionSummaryOutput = z.infer<
  typeof supervisionSummaryOutputSchema
>

export const supervisionEntityActionSchema = z
  .object({
    resultId: z.string().min(1).optional(),
    entityId: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/),
    action: z.enum(['confirm', 'revise', 'revoke']),
    label: z.string().trim().min(1).max(240).optional(),
    description: z.string().max(2_000).optional()
  })
  .strict()

export const supervisionRelationActionSchema = z
  .object({
    resultId: z.string().min(1).optional(),
    relationId: z.string().uuid(),
    action: z.enum(['confirm', 'revoke'])
  })
  .strict()

export const supervisionSourceRequestSchema = z
  .object({ sourceId: z.string().min(1).max(256) })
  .strict()

export const supervisionContinueContextRequestSchema = z.object({
  sourceId: z.string().min(1).max(256),
  resultId: z.string().min(1).max(256)
}).strict()
export type SupervisionContinueContextRequest = z.infer<typeof supervisionContinueContextRequestSchema>

export const supervisionContinueRequestSchema = z.object({
  conversationId: z.string().min(1).max(128),
  prompt: z.string().trim().min(1).max(12_000),
  runtimeSelection: z.unknown().optional(),
  projectId: z.string().min(1).max(128).optional()
}).strict()
export type SupervisionContinueRequest = z.infer<typeof supervisionContinueRequestSchema>

export const supervisionKnowledgePreviewRequestSchema = z.object({
  operation: z.enum(['create-entity', 'update-entity']),
  libraryId: z.string().uuid(),
  entityId: z.string().uuid().optional(),
  label: z.string().trim().min(1).max(120),
  type: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000),
  aliases: z.array(z.string().trim().min(1).max(120)).max(50),
  sourceId: z.string().min(1).max(256)
}).strict().superRefine((value, context) => {
  if (value.operation === 'update-entity' && !value.entityId) {
    context.addIssue({ code: 'custom', path: ['entityId'], message: 'update-entity requires entityId' })
  }
})
export type SupervisionKnowledgePreviewRequest = z.infer<typeof supervisionKnowledgePreviewRequestSchema>

export const supervisionKnowledgeCommitRequestSchema = z.object({
  previewId: z.string().uuid()
}).strict()
export type SupervisionKnowledgeCommitRequest = z.infer<typeof supervisionKnowledgeCommitRequestSchema>

export type SupervisionEntityAction = z.infer<typeof supervisionEntityActionSchema>
export type SupervisionRelationAction = z.infer<typeof supervisionRelationActionSchema>

export const supervisionResultViewSchema = z.object({
  storyLineId: z.string(),
  sourceId: z.string().nullable(),
  id: z.string(), summary: z.string(), changeDigest: z.string(), createdAt: z.string(),
  scope: heartbeatScopeSchema, timeRange: supervisionTimeRangeSchema,
  openItems: z.array(z.string())
})
export type SupervisionResultView = z.infer<typeof supervisionResultViewSchema>

export const supervisionTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('conversation'), conversationId: z.string().min(1).max(128) }).strict(),
  z.object({ type: z.literal('task'), taskId: z.string().min(1).max(128) }).strict()
])
export type SupervisionTarget = z.infer<typeof supervisionTargetSchema>
export const supervisionOverviewRequestSchema = z.object({ target: supervisionTargetSchema.optional() }).strict()
export const supervisionGraphRequestSchema = z.object({
  resultId: z.string().min(1).optional(), storyLineId: z.string().min(1).optional()
}).strict()
export type SupervisionGraphRequest = z.infer<typeof supervisionGraphRequestSchema>

export const supervisionGraphViewSchema = z.object({
  storyLine: z.object({ id: z.string(), scope_json: z.string() }).nullable(),
  events: z.array(z.object({ id: z.string(), title: z.string(), description: z.string(), occurred_at: z.string() })),
  entities: z.array(z.object({ id: z.string(), canonical_label: z.string(), description: z.string(), confirmation_state: z.string() })),
  relations: z.array(z.object({ id: z.string(), from_entity_id: z.string(), to_entity_id: z.string(), relation_type: z.string(), reason: z.string(), confirmation_state: z.string() })),
  sources: z.array(z.object({ id: z.string(), title: z.string(), occurred_at: z.string() })),
  eventEntities: z.array(z.object({ event_id: z.string(), entity_id: z.string() })),
  eventSources: z.array(z.object({ event_id: z.string(), source_id: z.string() }))
})
export type SupervisionGraphView = z.infer<typeof supervisionGraphViewSchema>
