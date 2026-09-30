import { z } from 'zod'

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
export const sharingDeviceSchema = z.object({
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
export type SharingCatalog = { devices: SharingDevice[]; publications: SharingPublication[] }
export type DeviceSharingApi = {
  getSettings: () => Promise<SharingSettings>
  saveSettings: (input: SharingSettingsInput) => Promise<SharingSettings>
  registerDevice: () => Promise<SharingDevice>
  getCatalog: () => Promise<SharingCatalog>
  publish: (input: SharingPublicationDraft) => Promise<SharingPublication>
  revoke: (id: string) => Promise<SharingPublication>
}
