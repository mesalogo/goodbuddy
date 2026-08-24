import { z } from 'zod'
import {
  agentIdentifierSchema,
  sha256DigestSchema,
  utf8StringSchema
} from './agent-protocol/contracts'

const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positiveCountSchema = countSchema.positive()
const timestampSchema = countSchema
const providerLabelSchema = utf8StringSchema(256, {
  minimumBytes: 1,
  label: 'Model provider label'
}).refine((value) => value.trim() === value, 'Label must not have outer whitespace')
const providerIdentifierSchema = utf8StringSchema(256, {
  minimumBytes: 1,
  label: 'Provider identifier'
}).refine(
  (value) => value.trim() === value,
  'Provider identifier must not have outer whitespace'
)

export const modelCallDigestSchema = sha256DigestSchema

export const modelCallStatusSchema = z.enum([
  'prepared',
  'dispatched',
  'completed',
  'failed-definitive',
  'outcome-unknown'
])
export type ModelCallStatus = z.infer<typeof modelCallStatusSchema>

export const modelCallIdentitySchema = z
  .object({
    callOperationId: agentIdentifierSchema,
    requestId: agentIdentifierSchema,
    bindingId: agentIdentifierSchema,
    promptOperationId: agentIdentifierSchema,
    promptSequence: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .default(0),
    roundIndex: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    provider: providerLabelSchema,
    profile: providerLabelSchema,
    model: providerLabelSchema,
    protocol: providerLabelSchema
  })
  .strict()
export type ModelCallIdentity = z.infer<typeof modelCallIdentitySchema>

export const prepareModelCallSchema = z
  .object({
    identity: modelCallIdentitySchema,
    requestDigest: modelCallDigestSchema,
    modelProfileDigest: modelCallDigestSchema,
    // Legacy ledger fields are accepted during migration but no longer
    // constrain dispatch.
    maximumOutputTokens: positiveCountSchema.optional(),
    maximumModelCalls: positiveCountSchema.optional(),
    maximumTotalOutputTokens: positiveCountSchema.optional()
  })
  .strict()
export type PrepareModelCall = z.infer<typeof prepareModelCallSchema>

export const modelCallDispatchMetadataSchema = z
  .object({
    providerIdempotencyKey: providerIdentifierSchema.optional(),
    providerRequestId: providerIdentifierSchema.optional()
  })
  .strict()
export type ModelCallDispatchMetadata = z.infer<
  typeof modelCallDispatchMetadataSchema
>

export const modelCallUsageMetadataSchema = z
  .object({
    inputTokens: countSchema.optional(),
    outputTokens: countSchema.optional(),
    cachedInputTokens: countSchema.optional(),
    reasoningTokens: countSchema.optional()
  })
  .strict()
export type ModelCallUsageMetadata = z.infer<
  typeof modelCallUsageMetadataSchema
>

export const modelCallResultMetadataSchema = z
  .object({
    finishReason: agentIdentifierSchema.optional(),
    outputDigest: modelCallDigestSchema.optional(),
    artifactCount: countSchema.max(1_000).optional()
  })
  .strict()
export type ModelCallResultMetadata = z.infer<
  typeof modelCallResultMetadataSchema
>

export const modelCallErrorMetadataSchema = z
  .object({
    code: agentIdentifierSchema,
    retryable: z.boolean()
  })
  .strict()
export type ModelCallErrorMetadata = z.infer<
  typeof modelCallErrorMetadataSchema
>

export const completeModelCallEvidenceSchema = z
  .object({
    status: z.literal('completed'),
    providerRequestId: providerIdentifierSchema.optional(),
    providerResponseId: providerIdentifierSchema.optional(),
    result: modelCallResultMetadataSchema.optional(),
    usage: modelCallUsageMetadataSchema.optional()
  })
  .strict()
export type CompleteModelCallEvidence = z.infer<
  typeof completeModelCallEvidenceSchema
>

export const failModelCallEvidenceSchema = z
  .object({
    status: z.literal('failed-definitive'),
    providerRequestId: providerIdentifierSchema.optional(),
    providerResponseId: providerIdentifierSchema.optional(),
    error: modelCallErrorMetadataSchema,
    usage: modelCallUsageMetadataSchema.optional()
  })
  .strict()
export type FailModelCallEvidence = z.infer<
  typeof failModelCallEvidenceSchema
>

export const unknownModelCallEvidenceSchema = z
  .object({
    status: z.literal('outcome-unknown'),
    providerRequestId: providerIdentifierSchema.optional(),
    reason: modelCallErrorMetadataSchema
  })
  .strict()
export type UnknownModelCallEvidence = z.infer<
  typeof unknownModelCallEvidenceSchema
>

export const modelCallTerminalEvidenceSchema = z.discriminatedUnion('status', [
  completeModelCallEvidenceSchema,
  failModelCallEvidenceSchema,
  unknownModelCallEvidenceSchema
])
export type ModelCallTerminalEvidence = z.infer<
  typeof modelCallTerminalEvidenceSchema
>

export const modelCallRecordSchema = z
  .object({
    identity: modelCallIdentitySchema,
    requestDigest: modelCallDigestSchema,
    modelProfileDigest: modelCallDigestSchema,
    maximumOutputTokens: positiveCountSchema.optional(),
    maximumModelCalls: positiveCountSchema.optional(),
    maximumTotalOutputTokens: positiveCountSchema.optional(),
    status: modelCallStatusSchema,
    dispatchMetadata: modelCallDispatchMetadataSchema.optional(),
    terminalEvidence: modelCallTerminalEvidenceSchema.optional(),
    preparedAt: timestampSchema,
    updatedAt: timestampSchema,
    dispatchedAt: timestampSchema.optional(),
    terminalAt: timestampSchema.optional(),
    responseDeliveredAt: timestampSchema.optional()
  })
  .strict()
  .superRefine((record, context) => {
    if (record.updatedAt < record.preparedAt) {
      addRecordIssue(context, ['updatedAt'], 'updatedAt precedes preparedAt')
    }
    const hasDispatch =
      record.dispatchMetadata !== undefined && record.dispatchedAt !== undefined
    if (
      (record.dispatchMetadata === undefined) !==
      (record.dispatchedAt === undefined)
    ) {
      addRecordIssue(
        context,
        ['dispatchMetadata'],
        'dispatch metadata and timestamp must appear together'
      )
    }
    if (
      record.dispatchedAt !== undefined &&
      (record.dispatchedAt < record.preparedAt ||
        record.updatedAt < record.dispatchedAt)
    ) {
      addRecordIssue(
        context,
        ['dispatchedAt'],
        'dispatchedAt is outside the record timestamp range'
      )
    }
    if (record.status === 'prepared') {
      if (
        hasDispatch ||
        record.terminalEvidence ||
        record.terminalAt !== undefined ||
        record.responseDeliveredAt !== undefined
      ) {
        addRecordIssue(
          context,
          ['status'],
          'prepared records cannot contain dispatch or terminal state'
        )
      }
      return
    }
    if (!hasDispatch) {
      addRecordIssue(
        context,
        ['dispatchMetadata'],
        'dispatched and terminal records require dispatch state'
      )
    }
    if (record.status === 'dispatched') {
      if (
        record.terminalEvidence ||
        record.terminalAt !== undefined ||
        record.responseDeliveredAt !== undefined
      ) {
        addRecordIssue(
          context,
          ['status'],
          'dispatched records cannot contain terminal state'
        )
      }
      return
    }
    if (
      record.terminalEvidence?.status !== record.status ||
      record.terminalAt === undefined
    ) {
      addRecordIssue(
        context,
        ['terminalEvidence'],
        'terminal evidence and timestamp must match record status'
      )
    }
    if (
      record.terminalAt !== undefined &&
      (record.dispatchedAt === undefined ||
        record.terminalAt < record.dispatchedAt ||
        record.updatedAt < record.terminalAt)
    ) {
      addRecordIssue(
        context,
        ['terminalAt'],
        'terminalAt is outside the record timestamp range'
      )
    }
    if (
      record.responseDeliveredAt !== undefined &&
      (record.status !== 'completed' ||
        record.terminalAt === undefined ||
        record.responseDeliveredAt < record.terminalAt ||
        record.updatedAt < record.responseDeliveredAt)
    ) {
      addRecordIssue(
        context,
        ['responseDeliveredAt'],
        'responseDeliveredAt requires a completed provider response'
      )
    }
  })
export type ModelCallRecord = z.infer<typeof modelCallRecordSchema>

export const modelCallOperationCursorSchema = z
  .object({
    updatedAt: timestampSchema,
    callOperationId: agentIdentifierSchema
  })
  .strict()
export type ModelCallOperationCursor = z.infer<
  typeof modelCallOperationCursorSchema
>

export const modelCallDeliveryFilterSchema = z.enum([
  'any',
  'pending-response',
  'delivered'
])
export type ModelCallDeliveryFilter = z.infer<
  typeof modelCallDeliveryFilterSchema
>

export const modelCallListOptionsSchema = z
  .object({
    statuses: z.array(modelCallStatusSchema).min(1).max(5).optional(),
    delivery: modelCallDeliveryFilterSchema.default('any'),
    cursor: modelCallOperationCursorSchema.optional(),
    limit: positiveCountSchema.max(1_000).default(100)
  })
  .strict()
export type ModelCallListOptions = z.input<
  typeof modelCallListOptionsSchema
>

export type ModelCallOperationPage = {
  records: ModelCallRecord[]
  nextCursor?: ModelCallOperationCursor
}

function addRecordIssue(
  context: z.RefinementCtx,
  path: Array<string | number>,
  message: string
): void {
  context.addIssue({ code: 'custom', path, message })
}
