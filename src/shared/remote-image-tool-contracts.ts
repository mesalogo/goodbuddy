import { z } from 'zod'
import { agentIdentifierSchema, positiveAgentSequenceSchema } from './agent-protocol/contracts'
import { imageOperationSchema, imageSaveMaximumBytes, imageSaveMimeTypeSchema, imageToolDescriptionLimit, imageToolInputSchema } from './image-generation-contracts'

export const remoteImageToolSchema = z.object({
  channelId: agentIdentifierSchema,
  channelEpoch: positiveAgentSequenceSchema,
  description: z.string().min(1).max(imageToolDescriptionLimit).optional(),
  storyGraph: z.boolean().optional(),
  /** When present, the Agent exposes save_image with this description and writes files on its own host. */
  saveDescription: z.string().min(1).max(imageToolDescriptionLimit).optional()
}).strict()

/** Raw bytes per save_image chunk; base64 plus JSON framing stays below remoteImageToolMaximumBytes. */
export const remoteImageSaveChunkBytes = 128 * 1024

export const remoteImageToolCallSchema = z.union([z.object({
  callId: z.string().uuid(),
  input: imageToolInputSchema
}).strict(), z.object({
  callId: z.string().uuid(),
  name: z.enum(['story_graph_list', 'story_graph_search', 'story_graph_get_context', 'story_graph_read_source']),
  input: z.record(z.string(), z.unknown())
}).strict(), z.object({
  callId: z.string().uuid(),
  name: z.literal('save_image_read'),
  input: z.object({
    artifactId: z.string().uuid(),
    mimeType: imageSaveMimeTypeSchema,
    offset: z.number().int().min(0).max(imageSaveMaximumBytes)
  }).strict()
}).strict()])

export const remoteImageSaveChunkSchema = z.object({
  mimeType: imageSaveMimeTypeSchema,
  totalBytes: z.number().int().min(1).max(imageSaveMaximumBytes),
  offset: z.number().int().min(0).max(imageSaveMaximumBytes),
  data: z.string().max(Math.ceil(remoteImageSaveChunkBytes / 3) * 4)
}).strict()

export const remoteImageToolReplySchema = z.object({
  callId: z.string().uuid(),
  result: imageOperationSchema.optional(),
  storyGraphResult: z.record(z.string(), z.unknown()).optional(),
  imageChunk: remoteImageSaveChunkSchema.optional(),
  error: z.string().max(4_000).optional()
}).strict()

// Bounded graph evidence, image-operation metadata, or one chunk of an image the model explicitly asked to save.
export const remoteImageToolMaximumBytes = 256 * 1024

export function encodeRemoteImageToolMessage(value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  if (bytes.byteLength > remoteImageToolMaximumBytes) throw new Error('Image tool message is too large')
  return bytes
}

export function decodeRemoteImageToolMessage(bytes: Uint8Array): unknown {
  if (bytes.byteLength > remoteImageToolMaximumBytes) throw new Error('Image tool message is too large')
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}
