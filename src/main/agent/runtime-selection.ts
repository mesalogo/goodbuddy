import {
  isAgentRuntimeModelProtocol,
  isDeepSeekHarnessModelProfile
} from '../../shared/contracts'
import {
  resolveRuntimeChoice,
  type AgentRuntimeSelection,
  type ResolvedRuntimeChoice,
  type RuntimeResolutionOptions,
  type RuntimeResolutionSettings,
  type RuntimeSelectionLayer
} from '../../shared/runtime-selection-contracts'
import type {
  ResolvedModelProfile,
  ResolvedRuntimeSettings
} from '../runtime-settings-store'

export type SelectedRuntimeTarget =
  | 'model'
  | 'opencode'
  | 'continue'
  | 'deepseek-harness'

function requireProfile(
  settings: ResolvedRuntimeSettings,
  profileId: string
): ResolvedModelProfile {
  const profile = settings.modelProfiles.find(
    (candidate) => candidate.id === profileId
  )
  if (!profile) {
    throw new Error('所选模型连接不存在或已被删除')
  }
  return profile
}

export function getConfiguredRuntimeTarget(
  settings: ResolvedRuntimeSettings
): SelectedRuntimeTarget {
  if (settings.provider === 'continue') {
    return 'continue'
  }
  if (settings.provider === 'deepseek-harness') {
    return 'deepseek-harness'
  }
  if (settings.provider === 'opencode') {
    return 'opencode'
  }
  return 'model'
}

/** Presents resolved Main settings in the shape used by the shared resolver. */
export function runtimeResolutionSettings(
  settings: ResolvedRuntimeSettings
): RuntimeResolutionSettings {
  // Partial settings (early startup, narrow callers) resolve with no connections.
  const modelProfiles = settings.modelProfiles ?? []
  const known = (profile?: ResolvedModelProfile) =>
    profile && modelProfiles.some((candidate) => candidate.id === profile.id)
      ? ({ kind: 'profile', profileId: profile.id } as const)
      : ({ kind: 'platform' } as const)
  return {
    provider: settings.provider,
    defaultModelProfileId: settings.defaultModelProfileId,
    modelProfiles: modelProfiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      modelName: profile.modelName,
      baseUrl: profile.baseUrl,
      protocol: profile.protocol,
      authentication: profile.authentication,
      apiKeyConfigured:
        profile.authentication !== 'api-key' || Boolean(profile.apiKey)
    })),
    opencodeModelSource: known(settings.opencodeModelProfile),
    continueModelSource: known(settings.continueModelProfile),
    deepseekHarnessModelSource: known(settings.deepseekHarnessModelProfile),
    opencodeBaseUrl: settings.opencodeBaseUrl
  }
}

export function resolveLayeredRuntimeSelection(
  settings: ResolvedRuntimeSettings,
  layers: {
    project?: RuntimeSelectionLayer
    conversation?: RuntimeSelectionLayer
  } = {},
  options: RuntimeResolutionOptions = {}
): ResolvedRuntimeChoice {
  return resolveRuntimeChoice(runtimeResolutionSettings(settings), layers, options)
}

/** Pins the model a Runtime selection implies so remote validation sees one concrete profile. */
export function resolveConfiguredAgentRuntimeSelection(
  settings: ResolvedRuntimeSettings,
  selection: AgentRuntimeSelection
): AgentRuntimeSelection {
  if (
    selection.provider === 'model' ||
    selection.profileId ||
    ('runtimeConfig' in selection && selection.runtimeConfig)
  ) {
    return selection
  }
  const profile =
    selection.provider === 'opencode'
      ? settings.opencodeModelProfile
      : selection.provider === 'continue'
        ? settings.continueModelProfile
        : settings.deepseekHarnessModelProfile
  return {
    provider: selection.provider,
    ...(profile && settings.modelProfiles.some(
      (candidate) => candidate.id === profile.id
    )
      ? { profileId: profile.id }
      : {})
  }
}

export function applyRuntimeSelection(
  settings: ResolvedRuntimeSettings,
  selection: AgentRuntimeSelection
): {
  settings: ResolvedRuntimeSettings
  target: SelectedRuntimeTarget
} {
  if (selection.provider === 'model') {
    const profile = requireProfile(settings, selection.profileId ?? settings.defaultModelProfileId)
    return {
      target: 'model',
      settings: {
        ...settings,
        provider: 'model',
        modelBaseUrl: profile.baseUrl,
        modelName: profile.modelName,
        modelProtocol: profile.protocol,
        modelAuthentication: profile.authentication,
        supportsImageInput: profile.supportsImageInput,
        imageGenerationQuality:
          profile.imageGenerationQuality ?? settings.imageGenerationQuality,
        apiKey: profile.apiKey,
        defaultModelProfileId: profile.id
      }
    }
  }

  const runtimeConfig = selection.runtimeConfig === true
  const profile = selection.profileId
    ? requireProfile(settings, selection.profileId)
    : runtimeConfig
      ? undefined
      : selection.provider === 'opencode'
        ? settings.opencodeModelProfile
        : selection.provider === 'continue'
          ? settings.continueModelProfile
          : settings.deepseekHarnessModelProfile
  if (selection.provider === 'opencode') {
    if (profile && !isAgentRuntimeModelProtocol(profile.protocol)) {
      throw new Error(
        'OpenCode 独立模型连接仅支持文本对话协议，不支持图像生成协议'
      )
    }
    if (profile && settings.opencodeBaseUrl) {
      throw new Error(
        'OpenCode 独立模型连接需要启用由 GoodBuddy 自动启动的本机 OpenCode'
      )
    }
    return {
      target: 'opencode',
      settings: {
        ...settings,
        provider: 'opencode',
        opencodeEmbedded: !settings.opencodeBaseUrl,
        opencodeModelProfile: profile
      }
    }
  }

  if (selection.provider === 'deepseek-harness') {
    // DeepSeek Harness "own configuration" is the administrator-provided or fallback model.
    const selectedProfile = runtimeConfig
      ? settings.deepseekHarnessPlatformModelProfile
      : profile
    if (
      selectedProfile &&
      !isDeepSeekHarnessModelProfile(selectedProfile)
    ) {
      throw new Error(
        'DeepSeek Harness 仅支持使用 API Key 的 OpenAI 兼容 Chat Completions 连接'
      )
    }
    return {
      target: 'deepseek-harness',
      settings: {
        ...settings,
        provider: 'deepseek-harness',
        deepseekHarnessModelProfile: selectedProfile
      }
    }
  }

  if (
    profile &&
    !isAgentRuntimeModelProtocol(profile.protocol)
  ) {
    throw new Error(
      'Continue 独立模型连接仅支持文本对话协议，不支持图像生成协议'
    )
  }
  return {
    target: 'continue',
    settings: {
      ...settings,
      provider: 'continue',
      continueModelProfile: profile
    }
  }
}
