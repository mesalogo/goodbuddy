import { z } from 'zod'
import type { SharingPersonasApi } from './sharing-personas'

export const sharingIdSchema = z.string().trim().min(1).max(200)
export const sharingSettingsInputSchema = z.object({
  serverUrl: z.url().refine(value => {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  }, 'Use an HTTP(S) service URL without credentials, query or fragment'),
  name: z.string().trim().min(1).max(200)
}).strict()
export const sharingSettingsSchema = sharingSettingsInputSchema.extend({ deviceId: sharingIdSchema })
export const sharingRegistrationInputSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('anonymous') }).strict(),
  z.object({ mode: z.literal('account'), username: z.string().trim().regex(/^[a-zA-Z0-9_.@-]{3,64}$/), password: z.string().min(1).max(1024) }).strict()
]).default({ mode: 'anonymous' })
export type SharingRegistrationInput = z.infer<typeof sharingRegistrationInputSchema>
const sharingMemberSchema = z.object({ id: sharingIdSchema, username: z.string(), displayName: z.string() })
export const sharingDeviceSchema = z.object({
  registrationStatus: z.enum(['approved', 'pending', 'rejected', 'disabled']).optional(),
  authenticationMode: z.enum(['anonymous', 'account']).optional(),
  member: sharingMemberSchema.optional(),
  id: sharingIdSchema, name: z.string(), platform: z.string(), appVersion: z.string(),
  registeredAt: z.string(), updatedAt: z.string()
})
export const sharingPublicationDraftSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(['capability', 'knowledge']),
  description: z.string().trim().max(4000),
  sourceMode: z.enum(['device', 'server']),
  permissions: z.object({ search: z.boolean(), read: z.boolean(), download: z.boolean() }).strict()
}).strict()
export const sharingPublicationSchema = sharingPublicationDraftSchema.extend({
  id: sharingIdSchema, deviceId: sharingIdSchema,
  status: z.enum(['published', 'revoked']), createdAt: z.string(), updatedAt: z.string()
})
export type SharingSettings = z.infer<typeof sharingSettingsSchema>
export type SharingSettingsInput = z.infer<typeof sharingSettingsInputSchema>
export type SharingDevice = z.infer<typeof sharingDeviceSchema>
export type SharingPublicationDraft = z.infer<typeof sharingPublicationDraftSchema>
export type SharingPublication = z.infer<typeof sharingPublicationSchema>
export type SharingCatalog = { devices: SharingDevice[]; publications: SharingPublication[]; registrationStatus?: 'unregistered' | 'approved' | 'pending' | 'rejected' | 'disabled'; authenticationMode?: 'anonymous' | 'account'; member?: z.infer<typeof sharingMemberSchema> }
export const sharingModelConfigSchema = z.object({
  id: z.string().min(1).max(4500), releaseId: sharingIdSchema,
  name: z.string(), version: z.string(), model: z.string(),
  baseURL: sharingSettingsInputSchema.shape.serverUrl,
  protocol: z.literal('openai-chat-completions'),
  routeType: z.enum(['gateway', 'custom']), authentication: z.literal('client-supplied-api-key')
})
export const sharingModelCatalogSchema = z.object({ items: z.array(sharingModelConfigSchema) })
export const sharingModelImportSchema = z.object({
  serverUrl: sharingSettingsInputSchema.shape.serverUrl,
  id: sharingModelConfigSchema.shape.id, releaseId: sharingIdSchema
}).strict()
export type SharingModelCatalog = z.infer<typeof sharingModelCatalogSchema>
export type SharingModelImport = z.infer<typeof sharingModelImportSchema>
export type DeviceSharingApi = SharingPersonasApi & {
  getModelConfigs: () => Promise<SharingModelCatalog>
  importModelConfig: (input: SharingModelImport) => Promise<{ imported: boolean }>
  getSettings: () => Promise<SharingSettings>
  saveSettings: (input: SharingSettingsInput) => Promise<SharingSettings>
  registerDevice: (input?: SharingRegistrationInput) => Promise<SharingDevice>
  getCatalog: () => Promise<SharingCatalog>
  publish: (input: SharingPublicationDraft) => Promise<SharingPublication>
  revoke: (id: string) => Promise<SharingPublication>
}
