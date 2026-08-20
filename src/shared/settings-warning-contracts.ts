import { z } from 'zod'

export const settingsWarningCodeSchema = z.enum([
  'application-settings-recovered',
  'document-parsing-settings-recovered',
  'capability-settings-recovered',
  'runtime-settings-recovered',
  'runtime-model-credential-unreadable',
  'runtime-embedding-credential-unreadable',
  'runtime-rerank-credential-unreadable',
  'channel-settings-recovered',
  'channel-weixin-credential-unreadable',
  'channel-weixin-secure-storage-unavailable',
  'channel-weixin-legacy-binding-invalid',
  'channel-wecom-environment-invalid',
  'channel-dingtalk-environment-invalid',
  'channel-wecom-credential-unreadable',
  'channel-dingtalk-credential-unreadable',
  'channel-runtime-selections-repaired'
])

export const settingsWarningSchema = z
  .object({
    code: settingsWarningCodeSchema,
    subject: z.string().trim().min(1).max(120).optional(),
    count: z.number().int().min(1).max(10_000).optional()
  })
  .strict()

export const settingsWarningsSchema = z
  .array(settingsWarningSchema)
  .max(32)

export type SettingsWarningCode = z.infer<
  typeof settingsWarningCodeSchema
>
export type SettingsWarning = z.infer<typeof settingsWarningSchema>

export function settingsWarningKey(warning: SettingsWarning): string {
  return JSON.stringify([
    warning.code,
    warning.subject ?? null,
    warning.count ?? null
  ])
}

export function settingsWarningsEqual(
  left: SettingsWarning,
  right: SettingsWarning
): boolean {
  return settingsWarningKey(left) === settingsWarningKey(right)
}
