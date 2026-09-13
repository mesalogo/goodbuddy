import { z } from 'zod'
import { agentQuestionResponseSchema } from './contracts'

export const remoteQuestionSchema = z.object({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  questions: z.array(z.object({
    header: z.string(),
    question: z.string(),
    options: z.array(z.object({ label: z.string(), description: z.string() })),
    multiple: z.boolean().default(false),
    custom: z.boolean().default(true)
  })).min(1),
  tool: z.object({ messageID: z.string(), callID: z.string() }).optional()
})

export const remoteQuestionResponseSchema = agentQuestionResponseSchema.extend({
  bindingId: z.string().min(1),
  operationId: z.string().min(1)
}).strict()

export type RemoteQuestionResponse = z.infer<typeof remoteQuestionResponseSchema>
