import { z } from 'zod'
import { assistantIdSchema } from './assistant-contracts'
import { terminalSnapshotSchema } from './terminal-contracts'

export const runtimeNativeClientInputSchema = z.object({ conversationId: assistantIdSchema }).strict()
export const runtimeNativeClientServiceSchema = z.object({ serviceId: z.string().min(1).max(128) }).strict()
export const runtimeNativeClientResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('terminal'), terminal: terminalSnapshotSchema }).strict(),
  runtimeNativeClientServiceSchema.extend({ kind: z.literal('browser') })
])
export type RuntimeNativeClientInput = z.infer<typeof runtimeNativeClientInputSchema>
export type RuntimeNativeClientService = z.infer<typeof runtimeNativeClientServiceSchema>
export type RuntimeNativeClientResult = z.infer<typeof runtimeNativeClientResultSchema>
