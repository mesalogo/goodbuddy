import { z } from 'zod'

export const imageToolInputSchema = z.object({
  prompt: z.string().trim().min(1).max(32_000),
  intent: z.enum(['create', 'edit']),
  modelProfileId: z.string().uuid().optional(),
  sourceArtifactIds: z.array(z.string().uuid()).max(8).default([]),
  quality: z.enum(['auto', 'low', 'medium', 'high']).optional()
}).strict().superRefine((input, context) => {
  if ((input.intent === 'edit') !== (input.sourceArtifactIds.length > 0)) {
    context.addIssue({ code: 'custom', message: 'Editing requires source images; creating must not include source images.' })
  }
})
export type ImageToolInput = z.infer<typeof imageToolInputSchema>

export const imageOperationSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string(),
  messageId: z.string(),
  requestId: z.string(),
  callId: z.string(),
  modelProfileId: z.string().uuid(),
  modelName: z.string(),
  modelProfileName: z.string().optional(),
  input: imageToolInputSchema,
  state: z.enum(['running', 'saving', 'completed', 'cancelling', 'stopped', 'failed', 'unconfirmed']),
  createdAt: z.number(),
  updatedAt: z.number(),
  artifactIds: z.array(z.string().uuid()).default([]),
  error: z.string().optional(),
  cancellationRequested: z.boolean().optional()
}).strict()
export type ImageOperation = z.infer<typeof imageOperationSchema>

/** Bound by Main/Agent transport, never accepted as model tool arguments. */
export type ImageRequestContext = {
  conversationId: string
  messageId: string
  requestId: string
  workMode: 'ask' | 'execute'
}

export const imageToolName = 'generate_image' as const
export const imageToolDescriptionLimit = 16_000
export const imageToolDescription = 'Generate or edit an image using a configured image model. Use intent=create for a new unrelated image, or intent=edit with explicit sourceArtifactIds. Never invent profile or artifact IDs. Clarify ambiguous references. A failed edit must not be replaced by generation. Results contain operation and artifact references, not image bytes. Do not retry a paid request automatically. A running operation continues after this chat stops; inspect its conversation card for completion.'
