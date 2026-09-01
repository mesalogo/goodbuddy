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
    <SettingsSectionHeader
      actions={actions}
      description={definition.description}
      error={error}
      headingId={headingId}
      title={definition.label}
    />
  )
}

export function SettingsSectionHeader({
  actions,
  description,
  error,
  headingLevel = 2,
  headingId,
  title
}: {
  actions?: ReactNode
  description: string
  error?: string
  headingLevel?: 2 | 3
  headingId: string
  title: string
}): React.JSX.Element {
  const Heading = headingLevel === 3 ? 'h3' : 'h2'
  return (
    <header className="settings-category-header">
      <div className="settings-category-header__content">
        <Heading id={headingId}>{title}</Heading>
        <p>{description}</p>
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
