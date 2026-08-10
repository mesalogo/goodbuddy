import type { ReactNode } from 'react'
import {
  settingsCategories,
  type SettingsCategoryId
} from './settings-categories'

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
