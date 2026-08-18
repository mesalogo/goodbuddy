import { z } from 'zod'

export const CHANNEL_LIMITS = {
  maximumChannelLength: 64,
  maximumEventIdLength: 256,
  maximumIdentityLength: 256,
  maximumTextLength: 32_000,
  maximumErrorLength: 1_000,
  maximumStatusLength: 64,
  maximumAttachmentCount: 4,
  maximumAttachmentBytes: 12 * 1024 * 1024,
  maximumAttachmentNameLength: 240,
  maximumAttachmentMimeTypeLength: 128
} as const

const channelIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(CHANNEL_LIMITS.maximumIdentityLength)

export const channelWorkModeSchema = z.literal('ask')
export type ChannelWorkMode = z.infer<typeof channelWorkModeSchema>

const attachmentBase64Schema = z
  .string()
  .max(
    Math.ceil(CHANNEL_LIMITS.maximumAttachmentBytes / 3) * 4 + 4
  )
  .regex(/^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/iu)

export function decodedBase64Size(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

export const channelMediaAttachmentSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(CHANNEL_LIMITS.maximumAttachmentNameLength),
    mimeType: z
      .string()
      .trim()
      .min(1)
      .max(CHANNEL_LIMITS.maximumAttachmentMimeTypeLength)
      .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu),
    size: z
      .number()
      .int()
      .positive()
      .max(CHANNEL_LIMITS.maximumAttachmentBytes),
    kind: z.enum(['image', 'file']),
    dataBase64: attachmentBase64Schema
  })
  .strict()
  .superRefine((attachment, context) => {
    const decodedSize = decodedBase64Size(attachment.dataBase64)
    if (decodedSize !== attachment.size) {
      context.addIssue({
        code: 'custom',
        path: ['dataBase64'],
        message: '附件大小与内容不匹配'
      })
    }
    if (
      attachment.kind === 'image' &&
      !attachment.mimeType.startsWith('image/')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['mimeType'],
        message: '图片附件类型无效'
      })
    }
  })

export type ChannelMediaAttachment = z.infer<
  typeof channelMediaAttachmentSchema
>

export const channelAttachmentsSchema = z
  .array(channelMediaAttachmentSchema)
  .max(CHANNEL_LIMITS.maximumAttachmentCount)
  .superRefine((attachments, context) => {
    const total = attachments.reduce(
      (sum, attachment) => sum + attachment.size,
      0
    )
    if (total > CHANNEL_LIMITS.maximumAttachmentBytes) {
      context.addIssue({
        code: 'custom',
        message: '附件总大小超过限制'
      })
    }
  })

export const channelInboundTextSchema = z
  .object({
    channel: z
      .string()
      .trim()
      .min(1)
      .max(CHANNEL_LIMITS.maximumChannelLength),
    accountId: channelIdentifierSchema.default('default'),
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
      .max(CHANNEL_LIMITS.maximumTextLength)
      .default(''),
    attachments: channelAttachmentsSchema.optional(),
    attachmentError: z
      .string()
      .trim()
      .min(1)
      .max(CHANNEL_LIMITS.maximumErrorLength)
      .optional(),
    mentioned: z.boolean().default(false),
    workMode: channelWorkModeSchema.default('ask'),
    receivedAt: z.number().int().nonnegative().optional()
  })
  .strict()
  .superRefine((message, context) => {
    if (
      message.text.length === 0 &&
      !message.attachments?.length &&
      !message.attachmentError
    ) {
      context.addIssue({
        code: 'custom',
        path: ['text'],
        message: '消息内容不能为空'
      })
    }
  })

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
    error: z.string().optional(),
    attachments: channelAttachmentsSchema.optional()
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
    output: z.string().optional(),
    error: z
      .string()
      .max(CHANNEL_LIMITS.maximumErrorLength)
      .optional(),
    attachments: channelAttachmentsSchema.optional()
  })
  .strict()

export type ChannelResultMessage = z.infer<
  typeof channelResultMessageSchema
>
