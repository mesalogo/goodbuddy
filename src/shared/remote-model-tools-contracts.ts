import { z } from 'zod'
import { jsonValueSchema } from './agent-protocol/control-contracts'

export const REMOTE_MODEL_TOOLS_CAPABILITY = 'workspace/model-tools'
export const remoteModelToolNames = ['workspace_read_text', 'workspace_apply_patch', 'workspace_rg', 'process_execute'] as const
const reference = z.object({ handle: z.string(), nextCursor: z.number().int().nonnegative(), totalBytes: z.number().int().nonnegative() }).strict()
export const remoteModelToolsActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list') }).strict(),
  z.object({ kind: z.literal('call'), callId: z.string().uuid(), name: z.enum(remoteModelToolNames), arguments: z.record(z.string(), jsonValueSchema) }).strict(),
  z.object({ kind: z.literal('cancel'), callId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('release'), callId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('read'), callId: z.string().uuid(), handle: z.string(), cursor: z.number().int().nonnegative() }).strict()
])
export const remoteModelToolsRequestSchema = z.object({
  workspaceId: z.string().min(1), generation: z.number().int().positive(), action: remoteModelToolsActionSchema
}).strict()
export const remoteModelToolsResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('done') }).strict(),
  z.object({ kind: z.literal('tools'), tools: z.array(z.object({
    name: z.enum(remoteModelToolNames), displayName: z.string(), description: z.string(),
    inputSchema: z.record(z.string(), jsonValueSchema), source: z.literal('builtin')
  }).strict()) }).strict(),
  z.object({ kind: z.literal('result'), result: z.object({
    parts: z.array(z.object({ type: z.literal('text'), text: z.string() }).strict()),
    contextBytes: z.number().int().nonnegative(), outputReferences: z.array(reference).optional()
  }).strict() }).strict(),
  z.object({ kind: z.literal('error'), message: z.string(), nextAction: z.string().optional() }).strict(),
  z.object({ kind: z.literal('page'), page: z.object({
    handle: z.string(), content: z.string(), cursor: z.number().int().nonnegative(),
    nextCursor: z.number().int().nonnegative(), totalBytes: z.number().int().nonnegative(), eof: z.boolean()
  }).strict() }).strict()
])
export type RemoteModelToolsAction = z.infer<typeof remoteModelToolsActionSchema>
export type RemoteModelToolsResult = z.infer<typeof remoteModelToolsResultSchema>
