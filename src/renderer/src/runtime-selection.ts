import type { TFunction } from 'i18next'
import type { RuntimeSettings } from '../../shared/contracts'
import type {
  AgentRuntimeProvider,
  ResolvedRuntimeChoice,
  RuntimeModelChoice,
  RuntimeSelectionLayerName
} from '../../shared/runtime-selection-contracts'

export type AppTranslate = TFunction<'app'>

export function runtimeProviderLabel(
  provider: AgentRuntimeProvider,
  t: AppTranslate
): string {
  return t(`runtimeSelection.providers.${provider}`)
}

function harnessPlatformModelName(settings: RuntimeSettings): string | undefined {
  const platform = settings.deepseekHarnessPlatformModel
  return platform && platform.source !== 'unavailable'
    ? platform.modelName
    : undefined
}

/** A short model label: connection name, or "own configuration" with the resolved model when known. */
export function runtimeModelLabel(
  provider: AgentRuntimeProvider,
  model: RuntimeModelChoice | undefined,
  settings: RuntimeSettings,
  t: AppTranslate
): string {
  if (!model) return t('runtimeSelection.noModel')
  if (model.kind === 'runtime-config') {
    const detail =
      provider === 'deepseek-harness' ? harnessPlatformModelName(settings) : undefined
    const label = t('runtimeSelection.runtimeConfigShort')
    return detail ? `${label} · ${detail}` : label
  }
  const profile = settings.modelProfiles.find(
    (candidate) => candidate.id === model.profileId
  )
  return profile?.name ?? t('runtimeSelection.missingProfile')
}

export function runtimeModelDetail(
  provider: AgentRuntimeProvider,
  model: RuntimeModelChoice | undefined,
  settings: RuntimeSettings,
  t: AppTranslate
): string | undefined {
  if (model?.kind === 'runtime-config') {
    return t('runtimeSelection.runtimeConfig', {
      runtime: runtimeProviderLabel(provider, t)
    })
  }
  if (model?.kind !== 'profile') return undefined
  return settings.modelProfiles.find((profile) => profile.id === model.profileId)
    ?.modelName
}

export function sourceLabel(
  source: RuntimeSelectionLayerName,
  t: AppTranslate
): string {
  return t(`runtimeSelection.sources.${source}`)
}

export function ignoredChoiceMessage(
  resolved: ResolvedRuntimeChoice,
  settings: RuntimeSettings,
  t: AppTranslate
): string | undefined {
  if (!resolved.ignored) return undefined
  const fallback =
    resolved.ignored.kind === 'provider'
      ? runtimeProviderLabel(resolved.provider, t)
      : runtimeModelLabel(resolved.provider, resolved.model, settings, t)
  return resolved.ignored.kind === 'provider'
    ? t('runtimeSelection.ignored.provider', { fallback })
    : t(`runtimeSelection.ignored.${resolved.ignored.reason}`, { fallback })
}
