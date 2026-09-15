import { z } from 'zod'
import { agentIdentifierSchema, positiveAgentSequenceSchema } from './agent-protocol/contracts'
import { imageOperationSchema, imageToolDescriptionLimit, imageToolInputSchema } from './image-generation-contracts'

export const remoteImageToolSchema = z.object({
  channelId: agentIdentifierSchema,
  channelEpoch: positiveAgentSequenceSchema,
  description: z.string().min(1).max(imageToolDescriptionLimit)
}).strict()

export const remoteImageToolCallSchema = z.object({
  callId: z.string().uuid(),
  input: imageToolInputSchema
}).strict()

export const remoteImageToolReplySchema = z.object({
  callId: z.string().uuid(),
  result: imageOperationSchema.optional(),
  error: z.string().max(4_000).optional()
}).strict()

// References and operation metadata only. Image bytes never cross this channel.
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
