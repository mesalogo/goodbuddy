import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { RuntimeSettings } from '../../shared/contracts'
import {
  allowedRuntimeProviders,
  compactRuntimeSelectionLayer,
  globalDefaultModel,
  isResolvableStatus,
  resolveRuntimeChoice,
  runtimeModelChoiceStatus,
  selectableModelProfiles,
  supportsRuntimeConfig,
  type AgentRuntimeProvider,
  type RuntimeModelChoice,
  type RuntimeSelectionLayer
} from '../../shared/runtime-selection-contracts'
import {
  ignoredChoiceMessage,
  runtimeModelLabel,
  runtimeProviderLabel,
  sourceLabel
} from './runtime-selection'

type ProjectRuntimeSelectorProps = {
  disabled?: boolean
  label: string
  help?: string
  onChange: (selection: RuntimeSelectionLayer | undefined) => void
  runtimeSettings: RuntimeSettings
  selection?: RuntimeSelectionLayer
  /** Managed SSH projects accept only OpenCode and Continue with a GoodBuddy connection. */
  remote?: boolean
  /** Prefix for accessible names when several projects are edited on one page. */
  ariaLabelPrefix?: string
  /** Unattended channel projects cannot use image-generation connections. */
  textOnly?: boolean
}

const INHERIT = ''
const RUNTIME_CONFIG = 'runtime-config'

function modelValue(model: RuntimeModelChoice | undefined): string {
  if (!model) return INHERIT
  return model.kind === 'profile' ? model.profileId : RUNTIME_CONFIG
}

/**
 * Project layer editor: an execution mode and a model, each defaulting to
 * "Follow global (current value)". Saving keeps inheritance instead of
 * freezing today's global value.
 */
export function ProjectRuntimeSelector({
  disabled = false,
  label,
  help,
  onChange,
  runtimeSettings,
  selection,
  remote = false,
  ariaLabelPrefix,
  textOnly = false
}: ProjectRuntimeSelectorProps): React.JSX.Element {
  const { t } = useTranslation('app')
  const id = useId()
  const options = { remote }
  const layer = compactRuntimeSelectionLayer(selection)
  const resolved = resolveRuntimeChoice(runtimeSettings, { project: layer }, options)
  const provider = resolved.provider
  const inheritedModel = globalDefaultModel(provider, runtimeSettings, options)
  const profiles = selectableModelProfiles(provider, runtimeSettings).filter(
    (profile) => !textOnly || profile.protocol !== 'openai-images-generations'
  )
  const storedModel = layer?.model
  const storedModelStatus = storedModel
    ? runtimeModelChoiceStatus(provider, storedModel, runtimeSettings, options)
    : 'ok'
  const warning = ignoredChoiceMessage(resolved, runtimeSettings, t)
  const accessible = (name: string): string =>
    ariaLabelPrefix ? `${ariaLabelPrefix} ${name}` : name

  const update = (next: RuntimeSelectionLayer): void => {
    onChange(compactRuntimeSelectionLayer(next))
  }

  const changeProvider = (value: string): void => {
    const nextProvider = value as AgentRuntimeProvider
    const effective = nextProvider
    // A model chosen for another execution mode rarely applies; keep it only when valid.
    const keepModel =
      storedModel &&
      runtimeModelChoiceStatus(effective, storedModel, runtimeSettings, options) === 'ok'
    update({
      provider: nextProvider,
      ...(keepModel ? { model: storedModel } : {})
    })
  }

  const changeModel = (value: string): void => {
    update({
      ...(layer?.provider ? { provider: layer.provider } : {}),
      ...(value === INHERIT
        ? {}
        : value === RUNTIME_CONFIG
          ? { model: { kind: 'runtime-config' as const } }
          : { model: { kind: 'profile' as const, profileId: value } })
    })
  }

  const providerLabel = t('runtimeSelection.providerLabel')
  const modelLabel = t('runtimeSelection.modelLabel')
  const effectiveProvider = runtimeProviderLabel(resolved.provider, t)
  const effectiveModel = runtimeModelLabel(resolved.provider, resolved.model, runtimeSettings, t)
  const overridden = resolved.modelSource !== 'global'

  return (
    <fieldset className="project-runtime-selector" disabled={disabled}>
      <legend>{label}</legend>
      <div className="project-runtime-selector__fields">
        <label className="field" htmlFor={`${id}-provider`}>
          <span>{providerLabel}</span>
          <select
            aria-label={accessible(providerLabel)}
            id={`${id}-provider`}
            onChange={(event) => changeProvider(event.target.value)}
            // The project owns its execution mode; older projects show what they resolve to.
            value={provider}
          >
            {allowedRuntimeProviders(options).map((candidate) => (
              <option key={candidate} value={candidate}>
                {runtimeProviderLabel(candidate, t)}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor={`${id}-model`}>
          <span>{modelLabel}</span>
          <select
            aria-label={accessible(modelLabel)}
            id={`${id}-model`}
            onChange={(event) => changeModel(event.target.value)}
            value={modelValue(storedModel)}
          >
            <option value={INHERIT}>
              {t('runtimeSelection.followRuntimeDefault', {
                runtime: runtimeProviderLabel(provider, t),
                value: runtimeModelLabel(provider, inheritedModel, runtimeSettings, t)
              })}
            </option>
            {storedModel && !isResolvableStatus(storedModelStatus) && (
              <option disabled value={modelValue(storedModel)}>
                {storedModel.kind === 'profile'
                  ? `⚠ ${runtimeModelLabel(provider, storedModel, runtimeSettings, t)}`
                  : `⚠ ${t('runtimeSelection.runtimeConfig', { runtime: runtimeProviderLabel(provider, t) })}`}
              </option>
            )}
            {supportsRuntimeConfig(provider, options) && (
              <option value={RUNTIME_CONFIG}>
                {t('runtimeSelection.runtimeConfig', {
                  runtime: runtimeProviderLabel(provider, t)
                })}
              </option>
            )}
            {profiles.map((profile) => {
              const status = runtimeModelChoiceStatus(
                provider,
                { kind: 'profile', profileId: profile.id },
                runtimeSettings,
                options
              )
              return (
                <option
                  disabled={!isResolvableStatus(status) && profile.id !== modelValue(storedModel)}
                  key={profile.id}
                  value={profile.id}
                >
                  {profile.name}
                  {profile.modelName ? ` · ${profile.modelName}` : ''}
                  {status === 'unavailable' ? t('runtimeSelection.unavailableSuffix') : ''}
                </option>
              )
            })}
          </select>
        </label>
      </div>
      <p
        className={`project-runtime-selector__summary${overridden ? ' project-runtime-selector__summary--override' : ''}`}
      >
        <span>
          {t('runtimeSelection.effective', {
            provider: effectiveProvider,
            model: effectiveModel
          })}
        </span>
        <small>
          {t('runtimeSelection.effectiveModelSource', {
            model: sourceLabel(resolved.modelSource, t)
          })}
        </small>
      </p>
      {warning && (
        <p className="project-runtime-selector__warning" role="status">
          <span>{warning}</span>
          {storedModel && !isResolvableStatus(storedModelStatus) && (
            <button
              className="secondary-button"
              onClick={() => changeModel(INHERIT)}
              type="button"
            >
              {t('runtimeSelection.followGlobalAction')}
            </button>
          )}
        </p>
      )}
      {help && <small className="project-runtime-selector__scope-help">{help}</small>}
    </fieldset>
  )
}
