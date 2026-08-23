import { FolderOpen } from 'lucide-react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { ProjectCreateInput } from '../../shared/assistant-contracts'
import type { RuntimeSettings } from '../../shared/contracts'
import {
  agentRuntimeSelectionKey,
  isChannelModelProfileUsable,
  repairChannelRuntimeSelection,
  type AgentRuntimeSelection
} from '../../shared/runtime-selection-contracts'
import { SegmentedControl } from './WorkspacePrimitives'

function configuredRuntimeSelection(
  provider: 'opencode' | 'continue' | 'deepseek-harness'
): AgentRuntimeSelection {
  return { provider }
}

function runtimeSelectionDescription(
  selection: AgentRuntimeSelection,
  settings: RuntimeSettings,
  t: TFunction<'integrations'>
): string {
  if (selection.provider === 'model') {
    const profile = settings.modelProfiles.find(
      (candidate) => candidate.id === selection.profileId
    )
    if (!profile) {
      return t('channels.project.missingSelection')
    }
    if (profile.protocol === 'openai-images-generations') {
      return t('channels.project.imageOnlySelection')
    }
    if (
      profile.authentication === 'api-key' &&
      !profile.apiKeyConfigured
    ) {
      return t('channels.project.missingCredential')
    }
    return t('channels.project.directDescription', {
      name: profile.name,
      modelName: profile.modelName
    })
  }
  if (selection.provider === 'auto') {
    return t('channels.project.automaticDescription')
  }
  const runtimeLabel =
    selection.provider === 'opencode'
      ? 'OpenCode'
      : selection.provider === 'continue'
        ? 'Continue'
        : 'DeepSeek Harness'
  return t('channels.project.runtimeDescription', {
    runtime: runtimeLabel
  })
}

export function channelProjectDraft(
  project: ProjectCreateInput,
  runtimeSettings: RuntimeSettings
): ProjectCreateInput {
  return {
    name: project.name,
    description: project.description,
    rootPath: project.rootPath,
    defaultWorkMode: project.defaultWorkMode,
    runtimeSelection: repairChannelRuntimeSelection(
      project.runtimeSelection ?? { provider: 'auto' },
      runtimeSettings
    )
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
  const runtimeSelection = repairChannelRuntimeSelection(
    value.runtimeSelection ?? { provider: 'auto' },
    runtimeSettings
  )
  const directProfiles = runtimeSettings.modelProfiles.filter(
    isChannelModelProfileUsable
  )
  const selectedDirectProfileId =
    runtimeSelection.provider === 'model'
      ? runtimeSelection.profileId
      : undefined
  const selectedDirectProfile = runtimeSettings.modelProfiles.find(
    (profile) => profile.id === selectedDirectProfileId
  )
  const selectedDirectUnavailable =
    selectedDirectProfileId !== undefined &&
    !directProfiles.some(
      (profile) => profile.id === selectedDirectProfileId
    )
  const openCodeSelection = configuredRuntimeSelection('opencode')
  const continueSelection = configuredRuntimeSelection('continue')
  const deepseekHarnessSelection =
    configuredRuntimeSelection('deepseek-harness')
  const selections: AgentRuntimeSelection[] = [
    ...directProfiles.map((profile) => ({
      provider: 'model' as const,
      profileId: profile.id
    })),
    openCodeSelection,
    continueSelection,
    deepseekHarnessSelection
  ]
  const selectionByKey = new Map(
    selections.map((selection) => [
      agentRuntimeSelectionKey(selection),
      selection
    ])
  )

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
      <label className="field">
        <span>{t('channels.project.backendLabel')}</span>
        <select
          aria-label={t('channels.project.backendAriaLabel', {
            name: value.name
          })}
          disabled={disabled}
          onChange={(event) => {
            const nextSelection = selectionByKey.get(event.target.value)
            if (nextSelection) {
              onChange({
                ...value,
                runtimeSelection: nextSelection
              })
            }
          }}
          value={agentRuntimeSelectionKey(runtimeSelection)}
        >
          <optgroup label={t('channels.project.directModels')}>
            {selectedDirectUnavailable && (
              <option
                disabled
                value={agentRuntimeSelectionKey(runtimeSelection)}
              >
                {selectedDirectProfile
                  ? t('channels.project.unavailableProfile', {
                      name: selectedDirectProfile.name,
                      modelName: selectedDirectProfile.modelName
                    })
                  : t('channels.project.missingProfile')}
              </option>
            )}
            {directProfiles.length === 0 && (
              <option disabled value="model:unavailable">
                {t('channels.project.noTextModels')}
              </option>
            )}
            {directProfiles.map((profile) => {
              const selection = {
                provider: 'model' as const,
                profileId: profile.id
              }
              return (
                <option
                  key={profile.id}
                  value={agentRuntimeSelectionKey(selection)}
                >
                  {profile.name} · {profile.modelName}
                </option>
              )
            })}
          </optgroup>
          <optgroup label="Agent Runtime">
            <option value={agentRuntimeSelectionKey(openCodeSelection)}>
              OpenCode
            </option>
            <option value={agentRuntimeSelectionKey(continueSelection)}>
              Continue
            </option>
            <option
              value={agentRuntimeSelectionKey(
                deepseekHarnessSelection
              )}
            >
              {t('channels.project.deepseekHarnessOption')}
            </option>
          </optgroup>
        </select>
        <small>
          {runtimeSelectionDescription(
            runtimeSelection,
            runtimeSettings,
            t
          )}
        </small>
      </label>
      <fieldset className="channel-work-mode">
        <legend>{t('channels.project.defaultMode')}</legend>
        <SegmentedControl
          ariaLabel={t('channels.project.defaultModeAriaLabel', {
            name: value.name
          })}
          disabled={disabled}
          onChange={(defaultWorkMode) =>
            onChange({ ...value, defaultWorkMode })
          }
          options={[
            { value: 'ask', label: t('channels.project.modes.ask') },
            {
              value: 'execute',
              label: t('channels.project.modes.execute')
            }
          ]}
          value={value.defaultWorkMode}
        />
        <small>{t('channels.project.overrideHelp')}</small>
      </fieldset>
      <p className="channel-project-settings__risk">
        {value.defaultWorkMode === 'execute'
          ? t('channels.project.executeRisk')
          : t('channels.project.askRisk')}{' '}
        {t('channels.project.riskSuffix')}
      </p>
    </section>
  )
}
