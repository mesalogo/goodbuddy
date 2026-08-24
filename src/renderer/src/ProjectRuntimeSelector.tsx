import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { RuntimeSettings } from '../../shared/contracts'
import {
  agentRuntimeSelectionKey,
  getDefaultRuntimeSelection,
  getRuntimeSelectionForProvider,
  isChannelModelProfileUsable,
  repairChannelRuntimeSelection,
  type AgentRuntimeSelection
} from '../../shared/runtime-selection-contracts'

type ProjectRuntimeSelectorProps = {
  ariaLabel: string
  disabled?: boolean
  label: string
  onChange: (selection: AgentRuntimeSelection) => void
  runtimeSettings: RuntimeSettings
  selection?: AgentRuntimeSelection
  selectionMode?: 'configured' | 'channel'
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

export function ProjectRuntimeSelector({
  ariaLabel,
  disabled = false,
  label,
  onChange,
  runtimeSettings,
  selection,
  selectionMode = 'configured'
}: ProjectRuntimeSelectorProps): React.JSX.Element {
  const { t } = useTranslation('integrations')
  const initialSelection =
    selection ?? getDefaultRuntimeSelection(runtimeSettings)
  const runtimeSelection =
    selectionMode === 'channel'
      ? repairChannelRuntimeSelection(initialSelection, runtimeSettings)
      : initialSelection.provider === 'auto'
        ? getDefaultRuntimeSelection(runtimeSettings)
        : initialSelection
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
  const runtimeProviders = [
    'opencode',
    'continue',
    'deepseek-harness'
  ] as const
  const runtimeSelections = runtimeProviders.map((provider) => {
    if (runtimeSelection.provider === provider) {
      return runtimeSelection
    }
    return selectionMode === 'channel'
      ? ({ provider } as AgentRuntimeSelection)
      : getRuntimeSelectionForProvider(provider, runtimeSettings)
  })
  const directSelections = directProfiles.map((profile) => ({
    provider: 'model' as const,
    profileId: profile.id
  }))
  const selections = [...directSelections, ...runtimeSelections]
  const selectionByKey = new Map(
    selections.map((candidate) => [
      agentRuntimeSelectionKey(candidate),
      candidate
    ])
  )

  return (
    <label className="field project-runtime-selector">
      <span>{label}</span>
      <select
        aria-label={ariaLabel}
        disabled={disabled}
        onChange={(event) => {
          const nextSelection = selectionByKey.get(event.target.value)
          if (nextSelection) {
            onChange(nextSelection)
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
          {directSelections.map((candidate) => {
            const profile = directProfiles.find(
              (item) => item.id === candidate.profileId
            )!
            return (
              <option
                key={profile.id}
                value={agentRuntimeSelectionKey(candidate)}
              >
                {profile.name} · {profile.modelName}
              </option>
            )
          })}
        </optgroup>
        <optgroup label="Agent Runtime">
          {runtimeSelections.map((candidate) => (
            <option
              key={candidate.provider}
              value={agentRuntimeSelectionKey(candidate)}
            >
              {candidate.provider === 'opencode'
                ? 'OpenCode'
                : candidate.provider === 'continue'
                  ? 'Continue'
                  : t('channels.project.deepseekHarnessOption')}
            </option>
          ))}
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
  )
}
