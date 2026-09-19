import { z } from 'zod'
import { magicNoteCommentFormatSchema } from './magic-notes-contracts'
import { localToolEnvironmentSettingsSchema } from './local-tool-environment-contracts'
import { modelDownloadSourceSchema } from './model-download-contracts'
import { settingsWarningsSchema } from './settings-warning-contracts'

export {
  artifactDownloadSourceSchema,
  defaultLocalToolEnvironmentSettings,
  localToolEnvironmentSettingsSchema,
  localToolExecutablePathSchema,
  localToolRuntimeSelectionSchema,
  type ArtifactDownloadSource,
  type LocalToolEnvironmentSettings,
  type LocalToolRuntimeSelection
} from './local-tool-environment-contracts'
export {
  modelDownloadSourceSchema,
  type ModelDownloadSource
} from './model-download-contracts'

export const magicNoteCommentModeSchema = z.enum([
  'immediate',
  'after-save-auto',
  'after-save-manual'
])

export type MagicNoteCommentMode = z.infer<typeof magicNoteCommentModeSchema>
export const magicNoteCanvasPageCountSchema = z.number().int().min(1).max(8)

export const updateSourceSchema = z.enum(['github', 'mirror'])
export type UpdateSource = z.infer<typeof updateSourceSchema>

export const builtInApplicationIds = ['magic-notes', 'knowledge', 'heartbeat', 'local-inference'] as const
export type BuiltInApplicationId = typeof builtInApplicationIds[number]
export const editableApplicationIds = ['magic-notes', 'local-inference'] as const
export type EditableApplicationId = typeof editableApplicationIds[number]
export const defaultApplicationNavigation = {
  order: ['knowledge', 'heartbeat', 'magic-notes', 'local-inference'] as BuiltInApplicationId[],
  pinned: { 'magic-notes': true, 'local-inference': false }
}
export const applicationNavigationSchema = z.object({
  order: z.array(z.enum(builtInApplicationIds)).length(builtInApplicationIds.length)
    .refine(ids => new Set(ids).size === builtInApplicationIds.length, 'Each application must occur exactly once'),
  pinned: z.object({
    'magic-notes': z.boolean(), 'local-inference': z.boolean()
  }).strict()
}).strict()

const applicationPreferencesSchema = z
  .object({
    checkUpdatesOnStartup: z.boolean(),
    updateSource: updateSourceSchema,
    modelDownloadSource: modelDownloadSourceSchema,
    localToolEnvironment: localToolEnvironmentSettingsSchema,
    conversationHtmlRenderingEnabled: z.boolean(),
    remoteProjectsEnabled: z.boolean(),
    applicationNavigation: applicationNavigationSchema.default(defaultApplicationNavigation),
    localInferenceEnabled: z.boolean().default(true),
    magicNotesEnabled: z.boolean().default(true),
    magicNotesShowIncompleteTodoCount: z.boolean().default(true),
    magicNoteCommentMode: magicNoteCommentModeSchema.default('immediate'),
    magicNoteCommentFormat: magicNoteCommentFormatSchema.default('combined'),
    magicNoteCanvasPageCount: magicNoteCanvasPageCountSchema.default(1)
  })
  .strict()

export const applicationSettingsSchema = applicationPreferencesSchema
  .extend({
    warnings: settingsWarningsSchema.optional()
  })
  .strict()

export const applicationSettingsUpdateSchema = applicationPreferencesSchema
  .partial()
  .extend({
    applicationNavigation: applicationNavigationSchema.optional(),
    localInferenceEnabled: z.boolean().optional(),
    magicNotesEnabled: z.boolean().optional(),
    magicNotesShowIncompleteTodoCount: z.boolean().optional(),
    magicNoteCommentMode: magicNoteCommentModeSchema.optional(),
    magicNoteCommentFormat: magicNoteCommentFormatSchema.optional(),
    magicNoteCanvasPageCount: magicNoteCanvasPageCountSchema.optional()
  })
  .refine((input) => Object.keys(input).length > 0, {
    message: 'At least one application setting is required'
  })

export type ApplicationSettings = z.infer<typeof applicationSettingsSchema>

export type ApplicationSettingsUpdate = z.infer<
  typeof applicationSettingsUpdateSchema
>

export type VersionCheckFile = {
  name: string
  size: number
  sha256: string
}

export type VersionCheckTarget = {
  platform: 'windows' | 'macos' | 'linux'
  arch: 'x64' | 'arm64'
  formats: string[]
  files: VersionCheckFile[]
}

export type VersionCheckResult = {
  updateAvailable: boolean
  currentVersion: string
  latestVersion: string
  releaseUrl: string
  target: VersionCheckTarget
}
