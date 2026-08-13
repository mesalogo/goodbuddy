import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  settingsWarningKey,
  type SettingsWarning
} from '../../shared/settings-warning-contracts'
import {
  settingsCategories,
  type SettingsCategoryId
} from './settings-categories'
import { translateSettingsWarning } from './settings-warnings'

export function SettingsWarningList({
  warnings
}: {
  warnings?: readonly SettingsWarning[]
}): React.JSX.Element | null {
  const { t } = useTranslation('warnings')
  if (!warnings?.length) {
    return null
  }
  return (
    <>
      {warnings.map((warning) => (
        <p
          className="settings-warning"
          key={settingsWarningKey(warning)}
          role="alert"
        >
          {translateSettingsWarning(warning, t)}
        </p>
      ))}
    </>
  )
}

export function SettingsCategoryHeader({
  actions,
  category,
  error,
  headingId = `settings-category-${category}`
}: {
  actions?: ReactNode
  category: SettingsCategoryId
  error?: string
  headingId?: string
}): React.JSX.Element {
  const definition = settingsCategories[category]
  return (
    <header className="settings-category-header">
      <div className="settings-category-header__content">
        <h2 id={headingId}>{definition.label}</h2>
        <p>{definition.description}</p>
      </div>
      {actions && (
        <div className="settings-category-header__actions">
          {actions}
        </div>
      )}
      {error && (
        <p className="settings-warning" role="alert">
          {error}
        </p>
      )}
    </header>
  )
}
