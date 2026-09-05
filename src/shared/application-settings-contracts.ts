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

export const updateSourceSchema = z.enum(['github', 'mirror'])
export type UpdateSource = z.infer<typeof updateSourceSchema>

const applicationPreferencesSchema = z
  .object({
    checkUpdatesOnStartup: z.boolean(),
    updateSource: updateSourceSchema,
    modelDownloadSource: modelDownloadSourceSchema,
    localToolEnvironment: localToolEnvironmentSettingsSchema,
    conversationHtmlRenderingEnabled: z.boolean(),
    remoteProjectsEnabled: z.boolean(),
    magicNotesEnabled: z.boolean(),
    magicNotesShowIncompleteTodoCount: z.boolean(),
    magicNoteCommentMode: magicNoteCommentModeSchema,
    magicNoteCommentFormat: magicNoteCommentFormatSchema
  })
  .strict()

export const applicationSettingsSchema = applicationPreferencesSchema
  .extend({
    warnings: settingsWarningsSchema.optional()
  })
  .strict()

export const applicationSettingsUpdateSchema = applicationPreferencesSchema
  .partial()
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
