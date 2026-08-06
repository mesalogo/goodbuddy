import { z } from 'zod'

export const CHANNEL_SETTINGS_LIMITS = {
  maximumIdentifierLength: 256,
  maximumSecretLength: 4_096,
  maximumAllowedSenders: 100,
  maximumStatusMessageLength: 500,
  maximumWarningLength: 500
} as const

export const managedChannelSchema = z.enum(['wecom', 'dingtalk'])
export type ManagedChannel = z.infer<typeof managedChannelSchema>

const identifierSchema = z
  .string()
  .trim()
  .max(CHANNEL_SETTINGS_LIMITS.maximumIdentifierLength)

const senderIdentifierSchema = identifierSchema.min(1)

export const allowedSenderIdsSchema = z
  .array(senderIdentifierSchema)
  .max(CHANNEL_SETTINGS_LIMITS.maximumAllowedSenders)
  .transform((values) => [...new Set(values)])

export const channelSecretUpdateSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(),
  z
    .object({
      action: z.literal('replace'),
      value: z
        .string()
        .trim()
        .min(1)
        .max(CHANNEL_SETTINGS_LIMITS.maximumSecretLength)
    })
    .strict(),
  z.object({ action: z.literal('clear') }).strict()
])
export type ChannelSecretUpdate = z.infer<
  typeof channelSecretUpdateSchema
>

const editableChannelFields = {
  enabled: z.boolean(),
  secret: channelSecretUpdateSchema,
  allowedSenderIds: allowedSenderIdsSchema,
  allowGroupMessages: z.boolean()
} as const

export const weComChannelSettingsInputSchema = z
  .object({
    ...editableChannelFields,
    botId: identifierSchema
  })
  .strict()
export type WeComChannelSettingsInput = z.infer<
  typeof weComChannelSettingsInputSchema
>

export const dingTalkChannelSettingsInputSchema = z
  .object({
    ...editableChannelFields,
    clientId: identifierSchema
  })
  .strict()
export type DingTalkChannelSettingsInput = z.infer<
  typeof dingTalkChannelSettingsInputSchema
>

export const channelSettingsApplySchema = z
  .object({
    wecom: weComChannelSettingsInputSchema.optional(),
    dingtalk: dingTalkChannelSettingsInputSchema.optional()
  })
  .strict()
  .refine(
    (input) => input.wecom !== undefined || input.dingtalk !== undefined,
    '至少需要提供一个通道设置'
  )
export type ChannelSettingsApply = z.infer<
  typeof channelSettingsApplySchema
>

export const channelCredentialSourceSchema = z.enum([
  'none',
  'encrypted',
  'environment'
])
export type ChannelCredentialSource = z.infer<
  typeof channelCredentialSourceSchema
>

export const channelRuntimeStateSchema = z.enum([
  'disabled',
  'stopped',
  'starting',
  'running',
  'error'
])
export type ChannelRuntimeState = z.infer<
  typeof channelRuntimeStateSchema
>

export const channelRuntimeStatusSchema = z
  .object({
    state: channelRuntimeStateSchema,
    lastError: z
      .string()
      .trim()
      .min(1)
      .max(CHANNEL_SETTINGS_LIMITS.maximumStatusMessageLength)
      .optional()
  })
  .strict()
export type ChannelRuntimeStatus = z.infer<
  typeof channelRuntimeStatusSchema
>

const publicChannelFields = {
  enabled: z.boolean(),
  secretConfigured: z.boolean(),
  source: channelCredentialSourceSchema,
  readOnly: z.boolean(),
  allowedSenderIds: allowedSenderIdsSchema,
  allowGroupMessages: z.boolean(),
  status: channelRuntimeStatusSchema
} as const

export const weComChannelSettingsSchema = z
  .object({
    ...publicChannelFields,
    botId: identifierSchema
  })
  .strict()
export type WeComChannelSettings = z.infer<
  typeof weComChannelSettingsSchema
>

export const dingTalkChannelSettingsSchema = z
  .object({
    ...publicChannelFields,
    clientId: identifierSchema
  })
  .strict()
export type DingTalkChannelSettings = z.infer<
  typeof dingTalkChannelSettingsSchema
>

export const channelSettingsSnapshotSchema = z
  .object({
    wecom: weComChannelSettingsSchema,
    dingtalk: dingTalkChannelSettingsSchema,
    warning: z
      .string()
      .trim()
      .min(1)
      .max(CHANNEL_SETTINGS_LIMITS.maximumWarningLength)
      .optional()
  })
  .strict()
export type ChannelSettingsSnapshot = z.infer<
  typeof channelSettingsSnapshotSchema
>

export const channelConnectionTestResultSchema = z
  .object({
    channel: managedChannelSchema,
    ok: z.boolean(),
    error: z
      .string()
      .trim()
      .min(1)
      .max(CHANNEL_SETTINGS_LIMITS.maximumStatusMessageLength)
      .optional()
  })
  .strict()
  .superRefine((result, context) => {
    if (result.ok && result.error !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: '成功结果不能包含错误'
      })
    }
    if (!result.ok && result.error === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: '失败结果必须包含错误'
      })
    }
  })
export type ChannelConnectionTestResult = z.infer<
  typeof channelConnectionTestResultSchema
>
