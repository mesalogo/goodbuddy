import { z } from 'zod'

/** Pinned official CLI release; GoodBuddy installs exactly this version. */
export const WECOM_CLI_VERSION = '1.3.4'

/** Tool categories, one per official wecom-cli Skill (wecomcli-shared is always provided). */
export const wecomToolCategories = [
  'doc',
  'doc-manage',
  'sheet',
  'smartsheet',
  'smartpage',
  'pptx',
  'disk',
  'media',
  'calendar',
  'meeting',
  'todo',
  'contact',
  'email',
  'message'
] as const
export const wecomToolCategorySchema = z.enum(wecomToolCategories)
export type WecomToolCategory = z.infer<typeof wecomToolCategorySchema>

/** Categories that act on behalf of the user towards other people stay off until enabled. */
export const wecomDefaultDisabledCategories: readonly WecomToolCategory[] = ['email', 'message']

export const wecomCategorySkill: Record<WecomToolCategory, string> = {
  doc: 'wecomcli-doc',
  'doc-manage': 'wecomcli-doc-manage',
  sheet: 'wecomcli-sheet',
  smartsheet: 'wecomcli-smartsheet',
  smartpage: 'wecomcli-smartpage',
  pptx: 'wecomcli-pptx',
  disk: 'wecomcli-disk',
  media: 'wecomcli-media',
  calendar: 'wecomcli-calendar',
  meeting: 'wecomcli-meeting',
  todo: 'wecomcli-todo',
  contact: 'wecomcli-contact',
  email: 'wecomcli-email',
  message: 'wecomcli-message'
}
export const wecomSharedSkill = 'wecomcli-shared'
export const wecomSkillNames = [wecomSharedSkill, ...wecomToolCategories.map(category => wecomCategorySkill[category])] as const

/**
 * Command prefixes each category may run. A command is allowed when its leading
 * words equal one of the prefixes of an enabled category.
 */
export const wecomCategoryCommands: Record<WecomToolCategory, readonly (readonly string[])[]> = {
  doc: [['doc', 'create'], ['doc', 'import'], ['doc', 'contents']],
  'doc-manage': [['doc', 'search'], ['doc', 'members'], ['doc', 'names'], ['doc', 'rules']],
  sheet: [['sheet']],
  smartsheet: [['smartsheet']],
  smartpage: [['smartpage']],
  // The PPT skill also uploads slide images through smart page image upload.
  pptx: [['slide'], ['smartpage', 'images', 'upload']],
  disk: [['disk']],
  media: [['media']],
  calendar: [['calendar']],
  meeting: [['meeting']],
  todo: [['todo']],
  contact: [['contact']],
  email: [['mail']],
  message: [['message'], ['chat']]
}
/** Always allowed while the application is enabled: who the authorized user is. */
export const wecomAlwaysAllowedCommands: readonly (readonly string[])[] = [['identity']]

export function defaultWecomCategories(): Record<WecomToolCategory, boolean> {
  return Object.fromEntries(
    wecomToolCategories.map(category => [category, !wecomDefaultDisabledCategories.includes(category)])
  ) as Record<WecomToolCategory, boolean>
}

export const wecomToolSettingsSchema = z.object({
  enabled: z.boolean(),
  categories: z.object(
    Object.fromEntries(wecomToolCategories.map(category => [category, z.boolean()])) as
      Record<WecomToolCategory, z.ZodBoolean>
  ).strict(),
  allowInMessageSessions: z.boolean()
}).strict()
export type WecomToolSettings = z.infer<typeof wecomToolSettingsSchema>

export const defaultWecomToolSettings = (): WecomToolSettings => ({
  enabled: false,
  categories: defaultWecomCategories(),
  allowInMessageSessions: false
})

export const wecomToolSettingsUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  categories: z.object(
    Object.fromEntries(wecomToolCategories.map(category => [category, z.boolean().optional()])) as
      Record<WecomToolCategory, z.ZodOptional<z.ZodBoolean>>
  ).strict().optional(),
  allowInMessageSessions: z.boolean().optional()
}).strict()
export type WecomToolSettingsUpdate = z.infer<typeof wecomToolSettingsUpdateSchema>

export type WecomCliState =
  | { state: 'missing' }
  | { state: 'ready'; version: string }

export type WecomAuthorization =
  | { state: 'unknown' }
  | { state: 'unauthorized' }
  | { state: 'authorized'; botId?: string }

export type WecomQrAuthorization =
  | { state: 'idle' }
  | { state: 'starting' }
  | { state: 'waiting'; url: string; expiresAt: string }
  | { state: 'failed'; message: string }

export type WecomSnapshot = {
  /** Increases with every state change; receivers keep the highest revision. */
  revision: number
  platformSupported: boolean
  cli: WecomCliState
  authorization: WecomAuthorization
  qr: WecomQrAuthorization
  settings: WecomToolSettings
}

export const wecomManualCredentialsSchema = z.object({
  botId: z.string().trim().min(1).max(256),
  secret: z.string().trim().min(1).max(4096)
}).strict()
export type WecomManualCredentials = z.infer<typeof wecomManualCredentialsSchema>

/** Python minor version the bundled wheels target (the managed Python version). */
export const wecomScriptPythonVersion = '3.13'

/** Python packages the official skill scripts import; installed offline from bundled wheels. */
export const wecomScriptPythonPackages = [
  'python-docx==1.2.0',
  'python-pptx==1.0.2',
  'openpyxl==3.1.5',
  'pillow==11.3.0',
  'pypdfium2==4.30.0'
] as const

/** Skills whose bundled scripts may be run, keyed by category. */
export const wecomScriptCategories: Partial<Record<WecomToolCategory, string>> = {
  doc: 'wecomcli-doc',
  pptx: 'wecomcli-pptx'
}

export const wecomDocSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(200)
}).strict()

export type WecomDocument = {
  id: string
  name: string
  type: string
  url?: string
  modifiedAt?: string
}

export type WecomApi = {
  getSnapshot(): Promise<WecomSnapshot>
  updateSettings(input: WecomToolSettingsUpdate): Promise<WecomSnapshot>
  startQrAuthorization(): Promise<WecomSnapshot>
  cancelQrAuthorization(): Promise<WecomSnapshot>
  authorizeManually(input: WecomManualCredentials): Promise<WecomSnapshot>
  authorizeWithChannelBot(): Promise<WecomSnapshot>
  disconnect(): Promise<WecomSnapshot>
  searchDocuments(input: z.infer<typeof wecomDocSearchInputSchema>): Promise<WecomDocument[]>
  onChanged(listener: (snapshot: WecomSnapshot) => void): () => void
}

/**
 * Returns the category allowing the command, `'identity'` for always-allowed
 * commands, or undefined when no enabled category covers it.
 */
export function wecomCommandCategory(
  args: readonly string[],
  enabled: ReadonlySet<WecomToolCategory>
): WecomToolCategory | 'identity' | undefined {
  const matches = (prefix: readonly string[]): boolean =>
    prefix.every((word, index) => args[index] === word)
  if (wecomAlwaysAllowedCommands.some(matches)) return 'identity'
  return wecomToolCategories.find(category =>
    enabled.has(category) && wecomCategoryCommands[category].some(matches))
}
