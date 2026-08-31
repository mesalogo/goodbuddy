import { z } from 'zod'
import { assistantIdSchema } from './assistant-contracts'
import { agentSequenceSchema } from './agent-protocol/contracts'

export const REMOTE_PROJECT_RECOVERY_LIMITS = {
  maximumFailureMessageLength: 1_000
} as const

export const remoteProjectRecoveryRequestIdSchema = z.string().uuid()

const recoveryIdentityFields = {
  projectId: assistantIdSchema,
  requestId: remoteProjectRecoveryRequestIdSchema
} as const

const recoveryStageStateSchema = z.discriminatedUnion('stage', [
  z
    .object({
      ...recoveryIdentityFields,
      stage: z.literal('network')
    })
    .strict(),
  z
    .object({
      ...recoveryIdentityFields,
      stage: z.literal('agent')
    })
    .strict(),
  z
    .object({
      ...recoveryIdentityFields,
      stage: z.literal('runtime')
    })
    .strict(),
  z
    .object({
      ...recoveryIdentityFields,
      stage: z.literal('cursor'),
      current: agentSequenceSchema
    })
    .strict()
])

export const remoteProjectRecoveryStateSchema = z.union([
  recoveryStageStateSchema,
  z
    .object({
      ...recoveryIdentityFields,
      stage: z.literal('completed')
    })
    .strict(),
  z
    .object({
      ...recoveryIdentityFields,
      stage: z.literal('failed'),
      message: z
        .string()
        .trim()
        .min(1)
        .max(
          REMOTE_PROJECT_RECOVERY_LIMITS.maximumFailureMessageLength
        ),
      retryable: z.boolean()
    })
    .strict()
])

export const remoteProjectRecoverySnapshotSchema = z
  .object({
    recoveries: z.array(remoteProjectRecoveryStateSchema).max(100)
  })
  .strict()

export const remoteProjectRecoveryRetryRequestSchema = z
  .object({
    projectId: assistantIdSchema
  })
  .strict()

export type RemoteProjectRecoveryState = z.infer<
  typeof remoteProjectRecoveryStateSchema
>
export type RemoteProjectRecoverySnapshot = z.infer<
  typeof remoteProjectRecoverySnapshotSchema
>
export type RemoteProjectRecoveryRetryRequest = z.infer<
  typeof remoteProjectRecoveryRetryRequestSchema
>
