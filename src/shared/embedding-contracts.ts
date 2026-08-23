import { z } from 'zod'
import {
  MODEL_DOWNLOAD_SOURCES,
  modelDownloadAvailabilitySchema,
  modelDownloadSourceSchema
} from './model-download-contracts'

const boundedLabelSchema = z.string().trim().min(1).max(256)
const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const safeProviderEndpointSchema = z
  .url()
  .trim()
  .max(2_048)
  .refine(
    (value) => ['http:', 'https:'].includes(new URL(value).protocol),
    'endpoint must be an HTTP or HTTPS URL'
  )

export const embeddingErrorCodeSchema = z.enum([
  'model_not_found',
  'authentication',
  'rate_limited',
  'timeout',
  'network',
  'provider_unavailable',
  'invalid_configuration',
  'invalid_response',
  'cancelled',
  'unknown'
])
export type EmbeddingErrorCode = z.infer<typeof embeddingErrorCodeSchema>

export const embeddingSafeErrorSchema = z
  .object({
    code: embeddingErrorCodeSchema,
    message: z.string().trim().min(1).max(500),
    retryable: z.boolean(),
    remedy: z.string().trim().min(1).max(500).optional()
  })
  .strict()
export type EmbeddingSafeError = z.infer<typeof embeddingSafeErrorSchema>

export const embeddingConfigurationSummarySchema = z
  .object({
    provider: boundedLabelSchema,
    model: boundedLabelSchema,
    endpoint: safeProviderEndpointSchema.optional(),
    credentialConfigured: z.boolean()
  })
  .strict()
export type EmbeddingConfigurationSummary = z.infer<
  typeof embeddingConfigurationSummarySchema
>

export const embeddingConnectionIdRequestSchema = z
  .object({
    connectionId: z.string().uuid()
  })
  .strict()

export const embeddingConnectionSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(64),
    kind: z.enum(['builtin', 'openai-compatible']),
    model: boundedLabelSchema,
    endpoint: safeProviderEndpointSchema.optional(),
    authentication: z.enum(['api-key', 'none']).optional(),
    credentialConfigured: z.boolean()
  })
  .strict()
export type EmbeddingConnectionSummary = z.infer<
  typeof embeddingConnectionSummarySchema
>

export const embeddingModelIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)

const embeddingModelFileSchema = z
  .object({
    name: z.string().min(1).max(255),
    role: z.enum([
      'model',
      'tokenizer',
      'tokenizer-configuration',
      'configuration',
      'license'
    ]),
    size: z.number().int().positive().safe(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u)
  })
  .strict()

export const embeddingModelOperationSchema = z
  .object({
    modelId: embeddingModelIdSchema,
    kind: z.enum(['download', 'import']),
    phase: z.enum(['preparing', 'transferring', 'installing']),
    currentFile: z.string().min(1).max(255).nullable(),
    completedBytes: z.number().int().nonnegative().safe(),
    totalBytes: z.number().int().positive().safe().nullable(),
    downloadSource: modelDownloadSourceSchema.optional()
  })
  .strict()

export const embeddingModelSnapshotSchema = z
  .object({
    selectedDownloadSource: modelDownloadSourceSchema,
    catalog: z.array(
      z
        .object({
          id: embeddingModelIdSchema,
          displayName: z.string().trim().min(1).max(120),
          description: z.string().trim().min(1).max(1_000),
          languages: z.array(z.string().trim().min(1).max(80)).min(1).max(32),
          runtime: z.literal('onnxruntime-web/wasm'),
          dimensions: z.number().int().positive().max(65_536),
          contextTokens: z.number().int().positive().max(10_000_000),
          quantization: z.string().trim().min(1).max(40),
          recommended: z.boolean(),
          available: z.boolean(),
          unavailableReason: z.string().trim().min(1).max(1_000).optional(),
          license: z
            .object({
              name: z.string().trim().min(1).max(120),
              notice: z.string().trim().min(1).max(1_000),
              url: z.url()
            })
            .strict(),
          files: z.array(embeddingModelFileSchema).min(1).max(32),
          downloadAvailability: z
            .array(modelDownloadAvailabilitySchema)
            .length(MODEL_DOWNLOAD_SOURCES.length)
        })
        .strict()
    ),
    installed: z.array(
      z
        .object({
          id: embeddingModelIdSchema,
          displayName: z.string().trim().min(1).max(120),
          source: z.enum(['download', 'local']),
          installedAt: z.string().datetime(),
          files: z.array(embeddingModelFileSchema).min(1).max(32)
        })
        .strict()
    ),
    operations: z.array(embeddingModelOperationSchema)
  })
  .strict()
export type EmbeddingModelSnapshot = z.infer<
  typeof embeddingModelSnapshotSchema
>

export const embeddingModelActionInputSchema = z
  .object({ modelId: embeddingModelIdSchema })
  .strict()

export const embeddingModelInstallInputSchema = z
  .object({
    modelId: embeddingModelIdSchema,
    expectedDownloadSource: modelDownloadSourceSchema
  })
  .strict()

const embeddingDiagnosticBase = {
  provider: boundedLabelSchema,
  model: boundedLabelSchema,
  checkedAt: timestampSchema,
  latencyMs: countSchema
}

export const embeddingDiagnosticResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      ...embeddingDiagnosticBase,
      status: z.literal('available'),
      dimensions: z.number().int().positive().max(8_192)
    })
    .strict(),
  z
    .object({
      ...embeddingDiagnosticBase,
      status: z.literal('unavailable'),
      error: embeddingSafeErrorSchema
    })
    .strict()
])
export type EmbeddingDiagnosticResult = z.infer<
  typeof embeddingDiagnosticResultSchema
>

export const embeddingIndexJobStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled'
])
export type EmbeddingIndexJobStatus = z.infer<
  typeof embeddingIndexJobStatusSchema
>

export const embeddingIndexProgressSchema = z
  .object({
    completed: countSchema,
    total: countSchema,
    percent: z.number().finite().min(0).max(100)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.completed > value.total) {
      context.addIssue({
        code: 'custom',
        message: 'completed must not exceed total',
        path: ['completed']
      })
    }
    const expected =
      value.total === 0
        ? [0, 100]
        : [(value.completed / value.total) * 100]
    if (
      expected.every(
        (candidate) => Math.abs(value.percent - candidate) > 0.01
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'percent must match completed and total',
        path: ['percent']
      })
    }
  })
export type EmbeddingIndexProgress = z.infer<
  typeof embeddingIndexProgressSchema
>

export const embeddingIndexJobSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    status: embeddingIndexJobStatusSchema,
    provider: boundedLabelSchema,
    model: boundedLabelSchema,
    progress: embeddingIndexProgressSchema,
    createdAt: timestampSchema,
    startedAt: timestampSchema.optional(),
    completedAt: timestampSchema.optional(),
    error: embeddingSafeErrorSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'queued' && value.startedAt !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'a queued job must not have started',
        path: ['startedAt']
      })
    }
    if (
      ['completed', 'failed', 'cancelled'].includes(value.status) &&
      value.completedAt === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'a terminal job must have a completion time',
        path: ['completedAt']
      })
    }
    if (value.status === 'failed' && value.error === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'a failed job must include a safe error',
        path: ['error']
      })
    }
    if (value.status === 'completed' && value.progress.percent !== 100) {
      context.addIssue({
        code: 'custom',
        message: 'a completed job must report 100 percent',
        path: ['progress']
      })
    }
  })
export type EmbeddingIndexJob = z.infer<typeof embeddingIndexJobSchema>

export const embeddingIndexStatusSchema = z
  .object({
    job: embeddingIndexJobSchema.nullable()
  })
  .strict()
export type EmbeddingIndexStatus = z.infer<
  typeof embeddingIndexStatusSchema
>

export const embeddingSettingsSnapshotSchema = z
  .object({
    configuration: embeddingConfigurationSummarySchema,
    connections: z.array(embeddingConnectionSummarySchema),
    currentConnectionId: z.string().uuid(),
    models: embeddingModelSnapshotSchema
  })
  .strict()
export type EmbeddingSettingsSnapshot = z.infer<
  typeof embeddingSettingsSnapshotSchema
>

export const knowledgeEmbeddingIndexRequestSchema = z
  .object({
    knowledgeBaseId: z.string().uuid()
  })
  .strict()

export const knowledgeEmbeddingIndexCancelRequestSchema = z
  .object({
    knowledgeBaseId: z.string().uuid(),
    jobId: z.string().uuid()
  })
  .strict()

export const knowledgeEmbeddingIndexCoverageSchema = z
  .object({
    total: countSchema,
    indexed: countSchema,
    missing: countSchema,
    error: countSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.indexed + value.missing + value.error !== value.total) {
      context.addIssue({
        code: 'custom',
        message: 'coverage counts must equal total',
        path: ['total']
      })
    }
  })
export type KnowledgeEmbeddingIndexCoverage = z.infer<
  typeof knowledgeEmbeddingIndexCoverageSchema
>

export const knowledgeEmbeddingIndexSnapshotSchema = z
  .object({
    knowledgeBaseId: z.string().uuid(),
    enabled: z.boolean(),
    configuration: embeddingConfigurationSummarySchema.optional(),
    coverage: knowledgeEmbeddingIndexCoverageSchema,
    indexStatus: embeddingIndexStatusSchema
  })
  .strict()
export type KnowledgeEmbeddingIndexSnapshot = z.infer<
  typeof knowledgeEmbeddingIndexSnapshotSchema
>

export const isEmbeddingIndexJobActive = (
  job: EmbeddingIndexJob | null | undefined
): boolean => job?.status === 'queued' || job?.status === 'running'
