import { z } from 'zod'
import type { FeishuDomain } from './channel-settings-contracts'

/** Tool categories, following the OpenClaw Feishu plugin tool groups. */
export const feishuToolCategories = ['doc', 'wiki', 'drive', 'bitable', 'perm', 'scopes'] as const
export const feishuToolCategorySchema = z.enum(feishuToolCategories)
export type FeishuToolCategory = z.infer<typeof feishuToolCategorySchema>

/** Permission management changes who can see documents; it stays off until enabled (OpenClaw default). */
export const feishuDefaultDisabledCategories: readonly FeishuToolCategory[] = ['perm']

export const feishuToolSettingsSchema = z.object({
  enabled: z.boolean(),
  categories: z.object(
    Object.fromEntries(feishuToolCategories.map(category => [category, z.boolean()])) as
      Record<FeishuToolCategory, z.ZodBoolean>
  ).strict(),
  allowInMessageSessions: z.boolean(),
  /** Receives edit permission on documents the app creates; set by scan registration. */
  ownerOpenId: z.string().trim().max(256).optional()
}).strict()
export type FeishuToolSettings = z.infer<typeof feishuToolSettingsSchema>

export const defaultFeishuToolSettings = (): FeishuToolSettings => ({
  enabled: false,
  categories: Object.fromEntries(feishuToolCategories.map(category =>
    [category, !feishuDefaultDisabledCategories.includes(category)])) as Record<FeishuToolCategory, boolean>,
  allowInMessageSessions: false
})

export const feishuToolSettingsUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  categories: z.object(
    Object.fromEntries(feishuToolCategories.map(category => [category, z.boolean().optional()])) as
      Record<FeishuToolCategory, z.ZodOptional<z.ZodBoolean>>
  ).strict().optional(),
  allowInMessageSessions: z.boolean().optional()
}).strict()
export type FeishuToolSettingsUpdate = z.infer<typeof feishuToolSettingsUpdateSchema>

export type FeishuRegistration =
  | { state: 'idle' }
  | { state: 'starting' }
  | { state: 'waiting'; url: string; expiresAt: string }
  | { state: 'completed' }
  | { state: 'failed'; message: string }

export type FeishuSnapshot = {
  revision: number
  /** App ID and secret are saved in the Feishu message channel settings. */
  credentialsConfigured: boolean
  appId?: string
  domain?: FeishuDomain
  settings: FeishuToolSettings
  registration: FeishuRegistration
}

export type FeishuBrowseItem = {
  kind: 'space' | 'node' | 'folder' | 'file'
  token: string
  name: string
  type?: string
  url?: string
  /** Opaque location for drilling into children. */
  child?: { kind: 'space' | 'node' | 'folder'; spaceId?: string; token: string }
}

export const feishuBrowseInputSchema = z.object({
  location: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('root') }).strict(),
    z.object({ kind: z.literal('folder'), token: z.string().min(1).max(256) }).strict(),
    z.object({ kind: z.literal('space'), token: z.string().min(1).max(256) }).strict(),
    z.object({ kind: z.literal('node'), spaceId: z.string().min(1).max(256), token: z.string().min(1).max(256) }).strict()
  ])
}).strict()
export type FeishuBrowseInput = z.infer<typeof feishuBrowseInputSchema>

export type FeishuApiBridge = {
  getSnapshot(): Promise<FeishuSnapshot>
  updateSettings(input: FeishuToolSettingsUpdate): Promise<FeishuSnapshot>
  startRegistration(domain: FeishuDomain): Promise<FeishuSnapshot>
  cancelRegistration(): Promise<FeishuSnapshot>
  browse(input: FeishuBrowseInput): Promise<{ items: FeishuBrowseItem[]; hint?: string }>
  onChanged(listener: (snapshot: FeishuSnapshot) => void): () => void
}
