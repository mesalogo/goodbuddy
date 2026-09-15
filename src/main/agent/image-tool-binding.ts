import { z } from 'zod'
import { imageToolInputSchema, imageToolName, type ImageOperation, type ImageRequestContext } from '../../shared/image-generation-contracts'

export type ImageToolBinding = {
  context: Readonly<ImageRequestContext>
  describe(): Promise<string | undefined>
  call(input: unknown, callId: string, waitSignal?: AbortSignal): Promise<ImageOperation>
}

export async function imageToolDefinition(binding: ImageToolBinding | undefined) {
  const description = await binding?.describe()
  if (!description) return undefined
  const inputSchema = z.toJSONSchema(imageToolInputSchema, { target: 'draft-7', io: 'input' })
  Reflect.deleteProperty(inputSchema, '$schema')
  return { name: imageToolName, displayName: 'Generate or edit image', description, inputSchema, source: 'builtin' as const }
}
