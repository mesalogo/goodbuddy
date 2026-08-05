import { z } from 'zod'

const boundedText = (maximumLength: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximumLength)
    .refine(
      (value) =>
        [...value].every((character) => {
          const code = character.charCodeAt(0)
          return code > 31 && code !== 127
        }),
      '值包含控制字符'
    )

const opaqueIdSchema = z
  .string()
  .min(16)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+$/)

export const computerControlRiskSchema = z.enum([
  'observe',
  'navigate',
  'input',
  'commit',
  'forbidden'
])
export type ComputerControlRisk = z.infer<
  typeof computerControlRiskSchema
>

export const computerControlElementRoleSchema = z.enum([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'option',
  'menuitem',
  'tab',
  'listitem',
  'scrollarea'
])
export type ComputerControlElementRole = z.infer<
  typeof computerControlElementRoleSchema
>

export const computerControlElementSchema = z
  .object({
    ref: opaqueIdSchema,
    role: computerControlElementRoleSchema,
    name: boundedText(256),
    enabled: z.boolean(),
    focused: z.boolean(),
    risk: computerControlRiskSchema,
    blocked: z.boolean()
  })
  .strict()
export type ComputerControlElement = z.infer<
  typeof computerControlElementSchema
>

export const computerControlObservationSchema = z
  .object({
    observationId: opaqueIdSchema,
    leaseId: opaqueIdSchema,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    capturedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    windowTitle: z.string().trim().max(256),
    elements: z.array(computerControlElementSchema).max(200)
  })
  .strict()
export type ComputerControlObservation = z.infer<
  typeof computerControlObservationSchema
>

export const computerControlActionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('activate'),
      elementRef: opaqueIdSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('replace_text'),
      elementRef: opaqueIdSchema,
      text: z.string().max(4_096)
    })
    .strict(),
  z
    .object({
      kind: z.literal('select_option'),
      elementRef: opaqueIdSchema,
      optionName: boundedText(256)
    })
    .strict(),
  z
    .object({
      kind: z.literal('scroll'),
      elementRef: opaqueIdSchema,
      direction: z.enum(['up', 'down', 'page_up', 'page_down'])
    })
    .strict()
])
export type ComputerControlAction = z.infer<
  typeof computerControlActionSchema
>

const commandBase = {
  commandId: opaqueIdSchema,
  leaseId: opaqueIdSchema
}

export const computerControlRuntimeCommandSchema = z.discriminatedUnion(
  'kind',
  [
    z
      .object({
        ...commandBase,
        kind: z.literal('observe')
      })
      .strict(),
    z
      .object({
        ...commandBase,
        kind: z.literal('act'),
        observationId: opaqueIdSchema,
        revision: z
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER),
        action: computerControlActionSchema
      })
      .strict()
  ]
)
export type ComputerControlRuntimeCommand = z.infer<
  typeof computerControlRuntimeCommandSchema
>

export const computerControlErrorCodeSchema = z.enum([
  'invalid_request',
  'driver_unavailable',
  'driver_timeout',
  'lease_not_found',
  'lease_expired',
  'lease_mismatch',
  'observation_not_found',
  'observation_stale',
  'observation_consumed',
  'element_not_found',
  'window_not_foreground',
  'element_identity_changed',
  'focus_failed',
  'forbidden',
  'approval_denied',
  'approval_timeout',
  'cancelled',
  'command_id_conflict',
  'outcome_unknown',
  'internal_error'
])
export type ComputerControlErrorCode = z.infer<
  typeof computerControlErrorCodeSchema
>

export const computerControlErrorSchema = z
  .object({
    code: computerControlErrorCodeSchema,
    message: boundedText(256),
    retryable: z.boolean()
  })
  .strict()
export type ComputerControlError = z.infer<
  typeof computerControlErrorSchema
>

export const computerControlApprovalRequestSchema = z
  .object({
    approvalId: opaqueIdSchema,
    leaseId: opaqueIdSchema,
    commandId: opaqueIdSchema,
    risk: z.enum(['input', 'commit']),
    action: z.enum(['activate', 'replace_text', 'select_option']),
    targetName: boundedText(256),
    textLength: z.number().int().nonnegative().max(4_096).optional()
  })
  .strict()
export type ComputerControlApprovalRequest = z.infer<
  typeof computerControlApprovalRequestSchema
>

export const computerControlApprovalResultSchema = z
  .object({
    approvalId: opaqueIdSchema,
    decision: z.enum(['approve_once', 'deny'])
  })
  .strict()
export type ComputerControlApprovalResult = z.infer<
  typeof computerControlApprovalResultSchema
>

export const computerControlCommandResultSchema = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        status: z.literal('observed'),
        commandId: opaqueIdSchema,
        observation: computerControlObservationSchema
      })
      .strict(),
    z
      .object({
        status: z.literal('completed'),
        commandId: opaqueIdSchema,
        risk: computerControlRiskSchema.exclude(['forbidden'])
      })
      .strict(),
    z
      .object({
        status: z.literal('error'),
        commandId: opaqueIdSchema,
        error: computerControlErrorSchema
      })
      .strict()
  ]
)
export type ComputerControlCommandResult = z.infer<
  typeof computerControlCommandResultSchema
>
