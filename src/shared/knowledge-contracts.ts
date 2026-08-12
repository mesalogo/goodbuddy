import { z } from 'zod'
import {
  defaultKnowledgeOntologySettings,
  knowledgeOntologySettingsSchema
} from './knowledge-ontology'
import {
  rerankExecutionDiagnosticsSchema,
  rerankModeSchema
} from './rerank-contracts'

const idSchema = z.string().trim().min(1).max(128)
const boundedTextSchema = (maximum: number) =>
  z.string().min(1).max(maximum)

export const knowledgeRetrievalChannelSchema = z.enum([
  'fts',
  'cjk',
  'vector',
  'graph'
])
export type KnowledgeRetrievalChannel = z.infer<
  typeof knowledgeRetrievalChannelSchema
>

export const knowledgeRetrievalSettingsSchema = z
  .object({
    version: z.literal(1).default(1),
    topK: z.number().int().min(1).max(20).default(6),
    minimumVectorSimilarity: z
      .number()
      .finite()
      .min(-1)
      .max(1)
      .transform((value) => Math.max(0, value))
      .default(0),
    ftsWeight: z.number().finite().min(0).max(2).default(1),
    vectorWeight: z.number().finite().min(0).max(2).default(1),
    graphWeight: z.number().finite().min(0).max(2).default(0.8),
    candidateMultiplier: z.number().int().min(2).max(10).default(4),
    contextMaxCharacters: z.number().int().min(2_000).max(48_000).default(16_000),
    adjacentChunkCount: z.number().int().min(0).max(2).default(0),
    localRerankEnabled: z.boolean().default(false),
    rerankMode: rerankModeSchema.default('none')
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.ftsWeight === 0 &&
      value.vectorWeight === 0 &&
      value.graphWeight === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'at least one retrieval channel weight must be greater than zero'
      })
    }
  })
  .transform((value) => {
    const rerankMode =
      value.rerankMode === 'none' && value.localRerankEnabled
        ? 'local'
        : value.rerankMode
    return {
      ...value,
      rerankMode,
      localRerankEnabled: rerankMode !== 'none'
    }
  })
export type KnowledgeRetrievalSettings = z.infer<
  typeof knowledgeRetrievalSettingsSchema
>

export const defaultKnowledgeRetrievalSettings =
  knowledgeRetrievalSettingsSchema.parse({})

export const knowledgeChunkingModeSchema = z.enum([
  'fixed',
  'structure',
  'parent-child'
])
export const knowledgeChunkingSettingsSchema = z
  .object({
    version: z.literal(1).default(1),
    mode: knowledgeChunkingModeSchema.default('structure'),
    targetCharacters: z.number().int().min(400).max(8_000).default(1_600),
    overlapCharacters: z.number().int().min(0).max(3_200).default(160),
    parentCharacters: z.number().int().min(1_600).max(16_000).default(4_800),
    childCharacters: z.number().int().min(300).max(4_000).default(900),
    contextualIndexingEnabled: z.boolean().default(false)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.overlapCharacters > value.targetCharacters * 0.4) {
      context.addIssue({
        code: 'custom',
        path: ['overlapCharacters'],
        message: 'overlapCharacters must not exceed 40% of targetCharacters'
      })
    }
    if (value.childCharacters > value.parentCharacters) {
      context.addIssue({
        code: 'custom',
        path: ['childCharacters'],
        message: 'childCharacters must not exceed parentCharacters'
      })
    }
  })
export type KnowledgeChunkingSettings = z.infer<
  typeof knowledgeChunkingSettingsSchema
>
export const defaultKnowledgeChunkingSettings =
  knowledgeChunkingSettingsSchema.parse({})

export const knowledgeChunkRoleSchema = z.enum([
  'standalone',
  'parent',
  'child'
])
export type KnowledgeChunkRole = z.infer<typeof knowledgeChunkRoleSchema>

export const knowledgeRetrieveInputSchema = z
  .object({
    knowledgeBaseId: idSchema,
    query: boundedTextSchema(4_000),
    settings: knowledgeRetrievalSettingsSchema.optional()
  })
  .strict()
export type KnowledgeRetrieveInput = z.infer<
  typeof knowledgeRetrieveInputSchema
>

const optionalRankSchema = z.number().int().positive().max(1_000_000).optional()
const channelScoresSchema = z
  .object({
    ftsRank: optionalRankSchema,
    cjkRank: optionalRankSchema,
    vectorRank: optionalRankSchema,
    graphRank: optionalRankSchema,
    vectorSimilarity: z.number().finite().min(-1).max(1).optional(),
    fusedScore: z.number().finite().nonnegative(),
    phraseMatch: z.boolean().optional(),
    tokenCoverage: z.number().finite().min(0).max(1).optional(),
    duplicatePenalty: z.number().finite().min(0).max(1).optional(),
    rerankScore: z.number().finite().min(0).max(1).optional()
  })
  .strict()

export const knowledgeRetrievalResultSchema = z
  .object({
    knowledgeBaseId: idSchema,
    documentId: idSchema,
    sourceId: idSchema,
    chunkId: idSchema,
    parentChunkId: idSchema.optional(),
    documentTitle: z.string().max(512),
    sourceDisplayName: z.string().max(512),
    sourceType: z.enum(['file', 'directory', 'url']),
    heading: z.string().max(512).optional(),
    location: z.string().max(8_192).optional(),
    snippet: z.string().max(8_000),
    relevance: z.number().finite().min(0).max(1),
    rank: z.number().int().positive().max(20),
    preRerankRank: optionalRankSchema,
    channels: z.array(knowledgeRetrievalChannelSchema).min(1).max(4),
    scores: channelScoresSchema
  })
  .strict()
export type KnowledgeRetrievalResult = z.infer<
  typeof knowledgeRetrievalResultSchema
>

export const knowledgeContextGroupSchema = z
  .object({
    resultChunkId: idSchema,
    chunkIds: z.array(idSchema).min(1).max(20),
    documentId: idSchema,
    content: z.string().max(48_000),
    characterCount: z.number().int().nonnegative().max(48_000),
    truncated: z.boolean()
  })
  .strict()
export type KnowledgeContextGroup = z.infer<typeof knowledgeContextGroupSchema>

const channelCountSchema = z
  .object({
    fts: z.number().int().nonnegative().optional(),
    cjk: z.number().int().nonnegative().optional(),
    vector: z.number().int().nonnegative().optional(),
    graph: z.number().int().nonnegative().optional()
  })
  .strict()
const channelTimingSchema = z
  .object({
    fts: z.number().int().nonnegative().optional(),
    cjk: z.number().int().nonnegative().optional(),
    vector: z.number().int().nonnegative().optional(),
    graph: z.number().int().nonnegative().optional()
  })
  .strict()

export const knowledgeRetrievalDiagnosticsSchema = z
  .object({
    requestedChannels: z.array(knowledgeRetrievalChannelSchema).max(4),
    usedChannels: z.array(knowledgeRetrievalChannelSchema).max(4),
    degradedChannels: z
      .array(
        z
          .object({
            channel: knowledgeRetrievalChannelSchema,
            reason: z.string().trim().min(1).max(500)
          })
          .strict()
      )
      .max(8),
    candidateCounts: channelCountSchema,
    channelDurationMs: channelTimingSchema,
    vectorScannedCount: z.number().int().nonnegative(),
    filteredByThresholdCount: z.number().int().nonnegative(),
    filteredByBudgetCount: z.number().int().nonnegative(),
    rerank: rerankExecutionDiagnosticsSchema.default({
      requested: 'none',
      used: 'none',
      status: 'skipped',
      candidateCount: 0,
      durationMs: 0
    })
  })
  .strict()

export const knowledgeRetrievalResponseSchema = z
  .object({
    query: boundedTextSchema(4_000),
    durationMs: z.number().int().nonnegative(),
    settings: knowledgeRetrievalSettingsSchema,
    diagnostics: knowledgeRetrievalDiagnosticsSchema,
    results: z.array(knowledgeRetrievalResultSchema).max(20),
    context: z
      .object({
        characterCount: z.number().int().nonnegative().max(48_000),
        truncated: z.boolean(),
        groups: z.array(knowledgeContextGroupSchema).max(20)
      })
      .strict()
  })
  .strict()
export type KnowledgeRetrievalResponse = z.infer<
  typeof knowledgeRetrievalResponseSchema
>

export const knowledgeSettingsUpdateInputSchema = z
  .object({
    knowledgeBaseId: idSchema,
    retrieval: knowledgeRetrievalSettingsSchema.optional(),
    chunking: knowledgeChunkingSettingsSchema.optional(),
    ontology: knowledgeOntologySettingsSchema.optional()
  })
  .strict()
  .refine((value) =>
    value.retrieval !== undefined ||
    value.chunking !== undefined ||
    value.ontology !== undefined, {
    message: 'at least one settings group is required'
  })
export type KnowledgeSettingsUpdateInput = z.infer<
  typeof knowledgeSettingsUpdateInputSchema
>

export const knowledgeChunksListInputSchema = z
  .object({
    knowledgeBaseId: idSchema,
    documentId: idSchema,
    page: z.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.number().int().min(1).max(200).default(50),
    search: z.string().trim().max(1_000).optional()
  })
  .strict()
export type KnowledgeChunksListInput = z.infer<
  typeof knowledgeChunksListInputSchema
>

export const knowledgeChunkUpdateInputSchema = z
  .object({
    knowledgeBaseId: idSchema,
    documentId: idSchema,
    chunkId: idSchema,
    content: boundedTextSchema(2_000_000).optional(),
    enabled: z.boolean().optional()
  })
  .strict()
  .refine((value) => value.content !== undefined || value.enabled !== undefined, {
    message: 'content or enabled is required'
  })
export type KnowledgeChunkUpdateInput = z.infer<
  typeof knowledgeChunkUpdateInputSchema
>

export const knowledgeChunkDeleteInputSchema = z
  .object({
    knowledgeBaseId: idSchema,
    documentId: idSchema,
    chunkId: idSchema
  })
  .strict()
export type KnowledgeChunkDeleteInput = z.infer<
  typeof knowledgeChunkDeleteInputSchema
>

export const knowledgeDocumentRebuildInputSchema = z
  .object({
    knowledgeBaseId: idSchema,
    documentId: idSchema
  })
  .strict()
export type KnowledgeDocumentRebuildInput = z.infer<
  typeof knowledgeDocumentRebuildInputSchema
>

export const knowledgeLibraryRebuildInputSchema = z
  .object({
    knowledgeBaseId: idSchema
  })
  .strict()
export type KnowledgeLibraryRebuildInput = z.infer<
  typeof knowledgeLibraryRebuildInputSchema
>

export const knowledgeReferenceContextInputSchema =
  knowledgeChunkDeleteInputSchema
export type KnowledgeReferenceContextInput = z.infer<
  typeof knowledgeReferenceContextInputSchema
>

export const knowledgeReferenceOpenInputSchema =
  knowledgeChunkDeleteInputSchema
export type KnowledgeReferenceOpenInput = z.infer<
  typeof knowledgeReferenceOpenInputSchema
>

export const knowledgeManagedChunkSchema = z
  .object({
    id: idSchema,
    ordinal: z.number().int().nonnegative(),
    role: knowledgeChunkRoleSchema,
    parentChunkId: idSchema.optional(),
    heading: z.string().max(512).optional(),
    locator: z.string().max(8_192).optional(),
    characterCount: z.number().int().nonnegative().max(2_000_000),
    enabled: z.boolean(),
    content: z.string().max(2_000_000),
    manuallyEdited: z.boolean(),
    updatedAt: z.string().datetime().optional()
  })
  .strict()
export type KnowledgeManagedChunk = z.infer<
  typeof knowledgeManagedChunkSchema
>

export const knowledgeChunkPageSchema = z
  .object({
    items: z.array(knowledgeManagedChunkSchema).max(200),
    page: z.number().int().min(1).max(1_000_000),
    pageSize: z.number().int().min(1).max(200),
    totalItems: z.number().int().nonnegative()
  })
  .strict()
export type KnowledgeChunkPage = z.infer<typeof knowledgeChunkPageSchema>

export const knowledgeReferenceContextSchema = z
  .object({
    knowledgeBaseId: idSchema,
    documentId: idSchema,
    chunkId: idSchema,
    documentTitle: z.string().max(512),
    sourceDisplayName: z.string().max(512),
    locator: z.string().max(8_192).optional(),
    matchedContent: z.string().max(48_000),
    contextContent: z.string().max(48_000),
    contextChunkIds: z.array(idSchema).max(5),
    truncated: z.boolean()
  })
  .strict()
export type KnowledgeReferenceContext = z.infer<
  typeof knowledgeReferenceContextSchema
>

export {
  defaultKnowledgeOntologySettings,
  knowledgeOntologySettingsSchema
}
