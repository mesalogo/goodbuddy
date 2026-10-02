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

export const imageSaveToolInputSchema = z.object({
  artifactId: z.string().uuid(),
  path: z.string().trim().min(1).max(4_096),
  overwrite: z.boolean().default(false)
}).strict()
export type ImageSaveToolInput = z.infer<typeof imageSaveToolInputSchema>

export type ImageSaveResult = {
  artifactId: string
  path: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  byteSize: number
}

export const imageSaveMimeTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp'])

/** Target format from a save path extension; undefined when unsupported. Pure so the remote Agent can share it. */
export function imageSaveMimeTypeForPath(path: string): ImageSaveResult['mimeType'] | undefined {
  const extension = /\.([A-Za-z0-9]+)$/u.exec(path)?.[1]?.toLowerCase()
  return extension === 'png' ? 'image/png'
    : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
      : extension === 'webp' ? 'image/webp'
        : undefined
}

/** Upper bound for bytes written by save_image, including chunked remote delivery. */
export const imageSaveMaximumBytes = 48 * 1024 * 1024

export const imageSaveToolName = 'save_image' as const
export const imageSaveToolDescription = 'Save an existing conversation image (generated result or uploaded source) to a local file. Use an artifactId listed in this conversation; never invent IDs. path must be absolute and end with .png, .jpg, .jpeg or .webp; the image is converted when the extension differs from its stored format (conversion to .webp is not supported). Missing parent folders are created. Existing files are kept unless overwrite=true. The file is written on the machine where this tool runs (the remote host for remote projects).'

export const imageToolName = 'generate_image' as const
export const imageToolDescriptionLimit = 16_000
export const imageToolDescription = 'Generate or edit an image using a configured image model. Use intent=create for a new unrelated image, or intent=edit with explicit sourceArtifactIds. Never invent profile or artifact IDs. Clarify ambiguous references. A failed edit must not be replaced by generation. Results contain operation and artifact references, not image bytes. Do not retry a paid request automatically. A running operation continues after this chat stops; inspect its conversation card for completion.'
