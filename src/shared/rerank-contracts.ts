import { z } from 'zod'
import { safeProviderEndpointSchema } from './embedding-contracts'

const boundedLabelSchema = z.string().trim().min(1).max(256)
const boundedReasonSchema = z.string().trim().min(1).max(500)
const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const rerankModeSchema = z.enum(['none', 'local', 'learned'])
export type RerankMode = z.infer<typeof rerankModeSchema>

export const rerankErrorCodeSchema = z.enum([
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
export type RerankErrorCode = z.infer<typeof rerankErrorCodeSchema>

export const rerankSafeErrorSchema = z
  .object({
    code: rerankErrorCodeSchema,
    message: boundedReasonSchema,
    retryable: z.boolean(),
    remedy: boundedReasonSchema.optional()
  })
  .strict()
export type RerankSafeError = z.infer<typeof rerankSafeErrorSchema>

export const rerankConfigurationSummarySchema = z
  .object({
    provider: boundedLabelSchema,
    model: boundedLabelSchema,
    endpoint: safeProviderEndpointSchema.optional(),
    credentialConfigured: z.boolean()
  })
  .strict()
export type RerankConfigurationSummary = z.infer<
  typeof rerankConfigurationSummarySchema
>

const rerankDiagnosticBase = {
  provider: boundedLabelSchema,
  model: boundedLabelSchema,
  checkedAt: timestampSchema,
  latencyMs: countSchema
}

export const rerankDiagnosticResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      ...rerankDiagnosticBase,
      status: z.literal('available')
    })
    .strict(),
  z
    .object({
      ...rerankDiagnosticBase,
      status: z.literal('unavailable'),
      error: rerankSafeErrorSchema
    })
    .strict()
])
export type RerankDiagnosticResult = z.infer<
  typeof rerankDiagnosticResultSchema
>

export const rerankExecutionStatusSchema = z.enum([
  'skipped',
  'applied',
  'fallback',
  'failed'
])
export type RerankExecutionStatus = z.infer<
  typeof rerankExecutionStatusSchema
>

/**
 * Safe, bounded telemetry for one retrieval execution. `requested` records
 * user intent while `used` records the algorithm that actually produced the
 * final ordering.
 */
export const rerankExecutionDiagnosticsSchema = z
  .object({
    requested: rerankModeSchema,
    used: rerankModeSchema,
    status: rerankExecutionStatusSchema,
    candidateCount: countSchema.max(100),
    durationMs: countSchema,
    model: boundedLabelSchema.optional(),
    reason: boundedReasonSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'skipped' && value.used !== 'none') {
      context.addIssue({
        code: 'custom',
        message: 'a skipped rerank must not report an algorithm used',
        path: ['used']
      })
    }
    if (value.status === 'applied' && value.used === 'none') {
      context.addIssue({
        code: 'custom',
        message: 'an applied rerank must report the algorithm used',
        path: ['used']
      })
    }
    if (value.status === 'fallback' && value.requested === value.used) {
      context.addIssue({
        code: 'custom',
        message: 'a fallback must differ from the requested mode',
        path: ['used']
      })
    }
    if (value.used === 'learned' && value.model === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'a learned rerank must identify its model',
        path: ['model']
      })
    }
  })
export type RerankExecutionDiagnostics = z.infer<
  typeof rerankExecutionDiagnosticsSchema
>
