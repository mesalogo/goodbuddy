import { z } from 'zod'
import type { FeishuDomain } from './channel-settings-contracts'

/** Tool categories, following the OpenClaw Feishu plugin tool groups. */
export const feishuToolCategories = ['doc', 'wiki', 'drive', 'bitable', 'perm', 'scopes'] as const
export const feishuToolCategorySchema = z.enum(feishuToolCategories)
export type FeishuToolCategory = z.infer<typeof feishuToolCategorySchema>

/** Permission management changes who can see documents; it stays off until enabled (OpenClaw default). */
export const feishuDefaultDisabledCategories: readonly FeishuToolCategory[] = ['perm']

/**
 * The knowledge base reads and writes pages through document blocks
 * (OpenClaw: wiki requires doc), so it is unusable while 文档 is off.
 */
export const feishuCategoryDependencies: Partial<Record<FeishuToolCategory, FeishuToolCategory>> = { wiki: 'doc' }
export function feishuCategoryUsable(category: FeishuToolCategory, categories: Record<FeishuToolCategory, boolean>): boolean {
  const required = feishuCategoryDependencies[category]
  return required === undefined || categories[required]
}

export const feishuToolSettingsSchema = z.object({
  /** Legacy: availability now follows the application (channel) switch; kept so old files parse. */
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
  /** The application switch (the Feishu channel's enabled state); tools follow it. */
  appEnabled: boolean
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
  /** Where it lives, e.g. "产品知识库 / 发布" (search results). */
  path?: string
  /** Last edit time, ISO 8601, when Feishu returns it. */
  modifiedAt?: string
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

export const feishuSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(200)
}).strict()
export type FeishuSearchInput = z.infer<typeof feishuSearchInputSchema>

/** Creates a document in a drive folder (or the app's root) or a page in a knowledge space. */
export const feishuCreateDocumentInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  location: feishuBrowseInputSchema.shape.location
}).strict()
export type FeishuCreateDocumentInput = z.infer<typeof feishuCreateDocumentInputSchema>

/** Uploads a file picked in a main-process dialog (up to 20 MB) into a drive folder or the app's root. */
export const feishuUploadFileInputSchema = z.object({
  folderToken: z.string().min(1).max(256).optional()
}).strict()
export type FeishuUploadFileInput = z.infer<typeof feishuUploadFileInputSchema>

export type FeishuApiBridge = {
  /** Title search over documents shared with the app; used by `@` references. */
  searchDocuments(input: FeishuSearchInput): Promise<FeishuBrowseItem[]>
  getSnapshot(): Promise<FeishuSnapshot>
  updateSettings(input: FeishuToolSettingsUpdate): Promise<FeishuSnapshot>
  startRegistration(domain: FeishuDomain): Promise<FeishuSnapshot>
  cancelRegistration(): Promise<FeishuSnapshot>
  browse(input: FeishuBrowseInput): Promise<{ items: FeishuBrowseItem[]; hint?: string }>
  createDocument(input: FeishuCreateDocumentInput): Promise<FeishuBrowseItem>
  /** Opens a file dialog in the main process; undefined when cancelled. */
  uploadFile(input: FeishuUploadFileInput): Promise<FeishuBrowseItem | undefined>
  onChanged(listener: (snapshot: FeishuSnapshot) => void): () => void
}
