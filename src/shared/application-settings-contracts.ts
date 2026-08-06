import { z } from 'zod'

export const applicationSettingsSchema = z
  .object({
    checkUpdatesOnStartup: z.boolean()
  })
  .strict()

export type ApplicationSettings = z.infer<
  typeof applicationSettingsSchema
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
