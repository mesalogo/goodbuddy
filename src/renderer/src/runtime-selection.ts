import type { RuntimeSettings } from '../../shared/contracts'
import type { AgentRuntimeSelection } from '../../shared/runtime-selection-contracts'

export function getRuntimeSelectionForProvider(
  provider: 'model' | 'opencode' | 'continue' | 'deepseek-harness',
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
      : provider === 'continue'
        ? settings.continueModelSource
        : settings.deepseekHarnessModelSource ?? { kind: 'platform' }
  return {
    provider,
    ...(source.kind === 'profile' ? { profileId: source.profileId } : {})
  }
}

export function getDefaultRuntimeSelection(
  settings: RuntimeSettings
): AgentRuntimeSelection {
  const provider = settings.provider
  if (
    provider === 'model' ||
    provider === 'opencode' ||
    provider === 'continue' ||
    provider === 'deepseek-harness'
  ) {
    return getRuntimeSelectionForProvider(provider, settings)
  }
  return settings.opencodeBaseUrl || settings.opencodeEmbedded
    ? getRuntimeSelectionForProvider('opencode', settings)
    : getRuntimeSelectionForProvider('model', settings)
}
