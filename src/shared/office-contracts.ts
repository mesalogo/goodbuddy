import { z } from 'zod'

export const officeOriginSchema = z.string().url().refine(value => {
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
    url.pathname === '/' && !url.search && !url.hash
}, '请输入 ShareServer 的 HTTP(S) 地址，不含路径')
export const officeDocumentSchema = z.object({
  originalName: z.string().optional(), requiresSaveAs: z.boolean().optional(),
  id: z.string().regex(/^[a-f0-9]{32}$/), name: z.string(),
  revision: z.number().int().positive(), size: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['saved', 'closed', 'editing', 'saving', 'recovering', 'error']),
  error: z.string().nullable().optional(), updatedAt: z.number()
})
export type OfficeDocument = z.infer<typeof officeDocumentSchema>
export const officeCapabilitiesSchema = z.object({
  directFormats: z.array(z.string()).optional(), conversions: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean(), formats: z.array(z.string()), maxBytes: z.number().int().positive(),
  versionedDownload: z.boolean().optional()
})
export type OfficeCapabilities = z.infer<typeof officeCapabilitiesSchema>
export const officeInputExtensions = ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt']
export const isOfficeFile = (name: string): boolean => officeInputExtensions.includes(name.split('.').pop()!.toLowerCase())
export const officeSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace'), projectId: z.string().uuid(), path: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal('attachment'), resourceId: z.string().uuid() }).strict()
])
export type OfficeSource = z.infer<typeof officeSourceSchema>
export const officeOpenSchema = z.object({ instanceId: z.string().uuid(), serverUrl: officeOriginSchema, source: officeSourceSchema.optional() }).strict()
export const officeInstanceSchema = z.object({ instanceId: z.string().uuid() }).strict()
export const officeAskSchema = officeInstanceSchema.extend({ conversationId: z.string().uuid(), instruction: z.string().trim().min(1).max(4000) }).strict()
export const officeApplySchema = officeInstanceSchema.extend({ text: z.string().min(1).max(32000) }).strict()
export const officeViewportSchema = officeInstanceSchema.extend({
  visible: z.boolean(), x: z.number().finite(), y: z.number().finite(),
  width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative()
}).strict()
export type OfficeSession = { instanceId: string; document: OfficeDocument; savedToSource: boolean; readOnlySource?: boolean }
export interface OfficeApi {
  capabilities(input: { serverUrl: string }): Promise<OfficeCapabilities>
  open(input: z.infer<typeof officeOpenSchema>): Promise<OfficeSession | null>
  save(input: { instanceId: string; saveAs?: boolean }): Promise<OfficeSession | null>
  close(input: { instanceId: string }): Promise<boolean>
  viewport(input: z.infer<typeof officeViewportSchema>): Promise<void>
  ask(input: z.infer<typeof officeAskSchema>): Promise<{ queueItemId: string; selectedText: string }>
  result(input: { instanceId: string }): Promise<{ state: 'pending' | 'complete' | 'error'; text?: string }>
  apply(input: z.infer<typeof officeApplySchema>): Promise<void>
}
export { officeChannels } from './office-ipc-channels'
