import { z } from 'zod'

export const magicNoteCommentModeSchema = z.enum([
  'immediate',
  'after-save-auto',
  'after-save-manual'
])

export type MagicNoteCommentMode = z.infer<
  typeof magicNoteCommentModeSchema
>

export const applicationSettingsSchema = z
  .object({
    checkUpdatesOnStartup: z.boolean(),
    magicNotesEnabled: z.boolean(),
    magicNoteCommentMode: magicNoteCommentModeSchema
  })
  .strict()

export const applicationSettingsUpdateSchema = applicationSettingsSchema
  .partial()
  .refine((input) => Object.keys(input).length > 0, {
    message: 'At least one application setting is required'
  })

export type ApplicationSettings = z.infer<
  typeof applicationSettingsSchema
>

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
