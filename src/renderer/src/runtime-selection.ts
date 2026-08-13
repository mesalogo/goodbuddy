import type { RuntimeSettings } from '../../shared/contracts'
import type { AgentRuntimeSelection } from '../../shared/runtime-selection-contracts'

export function getRuntimeSelectionForProvider(
  provider: 'model' | 'opencode' | 'continue',
  settings: RuntimeSettings
): AgentRuntimeSelection {
  if (provider === 'model') {
    return {
      provider,
      profileId: settings.defaultModelProfileId
    }
  }
  const source =
    provider === 'opencode'
      ? settings.opencodeModelSource
      : settings.continueModelSource
  return {
    provider,
    ...(source.kind === 'profile' ? { profileId: source.profileId } : {})
  }
}

export function getDefaultRuntimeSelection(
  settings: RuntimeSettings
): AgentRuntimeSelection {
  if (
    settings.provider === 'model' ||
    settings.provider === 'opencode' ||
    settings.provider === 'continue'
  ) {
    return getRuntimeSelectionForProvider(settings.provider, settings)
  }
  return settings.opencodeBaseUrl || settings.opencodeEmbedded
    ? getRuntimeSelectionForProvider('opencode', settings)
    : getRuntimeSelectionForProvider('model', settings)
}
