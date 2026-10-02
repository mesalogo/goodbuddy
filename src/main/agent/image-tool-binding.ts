import { z } from 'zod'
import {
  imageSaveToolDescription, imageSaveToolInputSchema, imageSaveToolName,
  imageToolInputSchema, imageToolName,
  type ImageOperation, type ImageRequestContext, type ImageSaveResult
} from '../../shared/image-generation-contracts'

export type ImageToolBinding = {
  context: Readonly<ImageRequestContext>
  describe(): Promise<string | undefined>
  call(input: unknown, callId: string, waitSignal?: AbortSignal): Promise<ImageOperation>
  /** Writes an existing conversation image to a local file. Absent for bindings without local file access. */
  save?(input: unknown, signal?: AbortSignal): Promise<ImageSaveResult>
  /** Returns image bytes in the requested format so a remote Agent can write them on its own host. */
  readForSave?(artifactId: string, mimeType: ImageSaveResult['mimeType']): Promise<Buffer>
  /** save_image description with this conversation's image IDs; undefined when saving is not meaningful. */
  describeSave?(): Promise<string | undefined>
}

export async function imageToolDefinition(binding: ImageToolBinding | undefined) {
  const description = await binding?.describe()
  if (!description) return undefined
  const inputSchema = z.toJSONSchema(imageToolInputSchema, { target: 'draft-7', io: 'input' })
  Reflect.deleteProperty(inputSchema, '$schema')
  return { name: imageToolName, displayName: 'Generate or edit image', description, inputSchema, source: 'builtin' as const }
}

export async function imageSaveToolDefinition(binding: ImageToolBinding | undefined) {
  if (!binding?.save || binding.context.workMode !== 'execute') return undefined
  const description = binding.describeSave ? await binding.describeSave() : imageSaveToolDescription
  if (!description) return undefined
  const inputSchema = z.toJSONSchema(imageSaveToolInputSchema, { target: 'draft-7', io: 'input' })
  Reflect.deleteProperty(inputSchema, '$schema')
  return { name: imageSaveToolName, displayName: 'Save image to file', description, inputSchema, source: 'builtin' as const }
}
