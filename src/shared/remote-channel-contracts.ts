import { z } from 'zod'
import { projectChannelSchema } from './assistant-contracts'

export const remoteChannelApprovalDecisionSchema = z.enum([
  'deny',
  'once'
])
export type RemoteChannelApprovalDecision = z.infer<
  typeof remoteChannelApprovalDecisionSchema
>

export const remoteChannelApprovalSchema = z
  .object({
    approvalId: z.string().uuid(),
    requestId: z.string().uuid(),
    kind: z.enum(['request', 'tool']),
    channel: projectChannelSchema,
    channelLabel: z.string().trim().min(1).max(64),
    senderDisplay: z.string().trim().min(1).max(200),
    projectName: z.string().trim().min(1).max(120),
    rootPath: z.string().max(4_096),
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().min(1).max(8_000),
    toolName: z.string().trim().min(1).max(200).optional(),
    argumentSummary: z.string().max(4_000).optional(),
    expiresAt: z.string().datetime({ offset: true })
  })
  .strict()
export type RemoteChannelApproval = z.infer<
  typeof remoteChannelApprovalSchema
>

export const remoteChannelApprovalResponseSchema = z
  .object({
    approvalId: z.string().uuid(),
    decision: remoteChannelApprovalDecisionSchema
  })
  .strict()

export const remoteChannelActivitySchema = z
  .object({
    requestId: z.string().uuid(),
    conversationId: z.string().uuid(),
    channel: projectChannelSchema,
    kind: z.enum(['request', 'approval', 'tool', 'result']),
    title: z.string().trim().min(1).max(240),
    detail: z.string().max(4_000),
    status: z.enum([
      'pending',
      'running',
      'completed',
      'failed',
      'denied',
      'cancelled'
    ]),
    callId: z.string().min(1).max(256).optional()
  })
  .strict()
export type RemoteChannelActivity = z.infer<
  typeof remoteChannelActivitySchema
>
