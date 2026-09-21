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
import { InlineHelp } from './InlineHelp'

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
  navigation,
  sticky = true,
  headingId = `settings-category-${category}`
}: {
  actions?: ReactNode
  category: SettingsCategoryId
  error?: string
  navigation?: ReactNode
  sticky?: boolean
  headingId?: string
}): React.JSX.Element {
  const definition = settingsCategories[category]
  return (
    <SettingsSectionHeader
      actions={actions}
      description={definition.description}
      error={error}
      navigation={navigation}
      sticky={sticky}
      headingId={headingId}
      title={definition.label}
    />
  )
}

export function SettingsSectionHeader({
  actions,
  description,
  error,
  navigation,
  sticky = false,
  headingLevel = 2,
  help,
  headingId,
  title
}: {
  actions?: ReactNode
  description?: string
  error?: string
  navigation?: ReactNode
  sticky?: boolean
  headingLevel?: 2 | 3
  help?: ReactNode
  headingId: string
  title: string
}): React.JSX.Element {
  const Heading = headingLevel === 3 ? 'h3' : 'h2'
  return (
    <header className={`settings-category-header${sticky ? ' settings-category-header--sticky' : ''}`}>
      <div className="settings-category-header__content">
        <Heading id={headingId}>{help != null ? <span className="inline-help-label">{title}<InlineHelp label={title}>{help}</InlineHelp></span> : title}</Heading>
        {description && <p>{description}</p>}
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
      {navigation && (
        <div className="settings-category-header__navigation">{navigation}</div>
      )}
    </header>
  )
}
