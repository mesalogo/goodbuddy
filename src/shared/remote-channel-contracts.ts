import { z } from 'zod'
import { projectChannelSchema } from './assistant-contracts'

export const remoteChannelActivitySchema = z
  .object({
    requestId: z.string().uuid(),
    conversationId: z.string().uuid(),
    projectId: z.string().uuid(),
    projectName: z.string().trim().min(1).max(120),
    channel: projectChannelSchema,
    kind: z.enum(['request', 'tool', 'result']),
    title: z.string().trim().min(1).max(240),
    detail: z.string().max(4_000),
    status: z.enum([
      'pending',
      'running',
      'completed',
      'failed',
      'cancelled'
    ]),
    callId: z.string().min(1).max(256).optional()
  })
  .strict()
export type RemoteChannelActivity = z.infer<
  typeof remoteChannelActivitySchema
>
