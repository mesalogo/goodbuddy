import { z } from 'zod'

export const CHANNEL_LIMITS = {
  maximumChannelLength: 64,
  maximumEventIdLength: 256,
  maximumIdentityLength: 256,
  maximumTextLength: 32_000,
  maximumResultLength: 16_000,
  maximumErrorLength: 1_000,
  maximumStatusLength: 64
} as const

const channelIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(CHANNEL_LIMITS.maximumIdentityLength)

export const channelWorkModeSchema = z.enum(['ask', 'plan'])
export type ChannelWorkMode = z.infer<typeof channelWorkModeSchema>

export const channelInboundTextSchema = z
  .object({
    channel: z
      .string()
      .trim()
      .min(1)
      .max(CHANNEL_LIMITS.maximumChannelLength),
    eventId: z
      .string()
      .trim()
      .min(1)
      .max(CHANNEL_LIMITS.maximumEventIdLength),
    senderId: channelIdentifierSchema,
    conversationId: channelIdentifierSchema,
    conversationType: z.enum(['direct', 'group']),
    text: z
      .string()
      .trim()
      .min(1)
      .max(CHANNEL_LIMITS.maximumTextLength),
    mentioned: z.boolean().default(false),
    workMode: channelWorkModeSchema.default('ask'),
    receivedAt: z.number().int().nonnegative().optional()
  })
  .strict()

export type ChannelInboundText = z.infer<
  typeof channelInboundTextSchema
>

export const channelExecutorResultSchema = z
  .object({
    status: z
      .string()
      .trim()
      .min(1)
      .max(CHANNEL_LIMITS.maximumStatusLength),
    output: z.string().optional(),
    error: z.string().optional()
  })
  .strict()

export type ChannelExecutorResult = z.infer<
  typeof channelExecutorResultSchema
>

export const channelResultMessageSchema = z
  .object({
    channel: z
      .string()
      .trim()
      .min(1)
      .max(CHANNEL_LIMITS.maximumChannelLength),
    eventId: z
      .string()
      .trim()
      .min(1)
      .max(CHANNEL_LIMITS.maximumEventIdLength),
    conversationId: channelIdentifierSchema,
    recipientId: channelIdentifierSchema,
    status: z
      .string()
      .trim()
      .min(1)
      .max(CHANNEL_LIMITS.maximumStatusLength),
    output: z
      .string()
      .max(CHANNEL_LIMITS.maximumResultLength)
      .optional(),
    error: z
      .string()
      .max(CHANNEL_LIMITS.maximumErrorLength)
      .optional()
  })
  .strict()

export type ChannelResultMessage = z.infer<
  typeof channelResultMessageSchema
>
