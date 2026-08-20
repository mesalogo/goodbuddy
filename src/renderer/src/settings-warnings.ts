import type { TFunction } from 'i18next'
import type { SettingsWarning } from '../../shared/settings-warning-contracts'

export function translateSettingsWarning(
  warning: SettingsWarning,
  t: TFunction<'warnings'>
): string {
  switch (warning.code) {
    case 'runtime-model-credential-unreadable':
      return t(warning.code, {
        subject: warning.subject ?? ''
      })
    case 'channel-runtime-selections-repaired':
      return t(warning.code, {
        count: warning.count ?? 0
      })
    default:
      return t(warning.code)
  }
}
