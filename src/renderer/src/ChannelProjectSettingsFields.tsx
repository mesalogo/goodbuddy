import { FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProjectCreateInput } from '../../shared/assistant-contracts'
import type { RuntimeSettings } from '../../shared/contracts'
import {
  compactRuntimeSelectionLayer,
  resolveRuntimeChoice
} from '../../shared/runtime-selection-contracts'
import { ProjectRuntimeSelector } from './ProjectRuntimeSelector'

export function channelProjectDraft(
  project: ProjectCreateInput,
  runtimeSettings: RuntimeSettings
): ProjectCreateInput {
  const layer = compactRuntimeSelectionLayer(project.runtimeSelection)
  return {
    name: project.name,
    description: project.description,
    rootPath: project.rootPath,
    runtimeSelection: {
      ...layer,
      provider: resolveRuntimeChoice(runtimeSettings, { project: layer }).provider
    }
  }
}

export function ChannelProjectSettingsFields({
  autoFocus = false,
  disabled = false,
  onChange,
  onSelectRoot,
  runtimeSettings,
  value,
  variant = 'card'
}: {
  autoFocus?: boolean
  disabled?: boolean
  onChange: (value: ProjectCreateInput) => void
  onSelectRoot: () => void
  runtimeSettings: RuntimeSettings
  value: ProjectCreateInput
  variant?: 'card' | 'dialog'
}): React.JSX.Element {
  const { t } = useTranslation('integrations')
  return (
    <section
      aria-label={t('channels.project.sectionAriaLabel', {
        name: value.name
      })}
      className={`channel-project-settings channel-project-settings--${variant}`}
    >
      <label className="field">
        <span>{t('channels.project.descriptionLabel')}</span>
        <textarea
          aria-label={t('channels.project.descriptionAriaLabel', {
            name: value.name
          })}
          autoFocus={autoFocus}
          disabled={disabled}
          maxLength={2_000}
          onChange={(event) =>
            onChange({ ...value, description: event.target.value })
          }
          rows={3}
          value={value.description}
        />
      </label>
      <label className="field">
        <span>{t('channels.project.rootLabel')}</span>
        <div className="channel-project-settings__root">
          <input
            aria-label={t('channels.project.rootAriaLabel', {
              name: value.name
            })}
            disabled={disabled}
            maxLength={4_096}
            onChange={(event) =>
              onChange({ ...value, rootPath: event.target.value })
            }
            value={value.rootPath}
          />
          <button
            aria-label={t('channels.project.selectRootAriaLabel', {
              name: value.name
            })}
            className="secondary-button"
            disabled={disabled}
            onClick={onSelectRoot}
            type="button"
          >
            <FolderOpen aria-hidden="true" size={14} />
            {t('channels.project.select')}
          </button>
        </div>
        <small>{t('channels.project.rootHelp')}</small>
      </label>
      <ProjectRuntimeSelector
        ariaLabelPrefix={value.name}
        disabled={disabled}
        label={t('channels.project.backendLabel')}
        onChange={(runtimeSelection) =>
          onChange({ ...value, runtimeSelection })
        }
        runtimeSettings={runtimeSettings}
        selection={value.runtimeSelection}
        textOnly
      />
      <p className="channel-project-settings__risk">
        {t('channels.project.riskSuffix')}
      </p>
    </section>
  )
}
