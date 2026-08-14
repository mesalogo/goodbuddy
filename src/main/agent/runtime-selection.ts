import {
  isAgentRuntimeModelProtocol,
  isDeepSeekHarnessModelProfile
} from '../../shared/contracts'
import type { AgentRuntimeSelection } from '../../shared/runtime-selection-contracts'
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
  if (
    settings.provider === 'opencode' ||
    settings.provider === 'auto'
  ) {
    return 'opencode'
  }
  return 'model'
}

export function resolveConfiguredAgentRuntimeSelection(
  settings: ResolvedRuntimeSettings,
  selection: AgentRuntimeSelection
): AgentRuntimeSelection {
  if (
    selection.provider !== 'opencode' &&
    selection.provider !== 'continue' &&
    selection.provider !== 'deepseek-harness'
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
  if (selection.provider === 'auto') {
    return {
      settings,
      target: getConfiguredRuntimeTarget(settings)
    }
  }

  if (selection.provider === 'model') {
    const profile = requireProfile(settings, selection.profileId)
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

  const profile = selection.profileId
    ? requireProfile(settings, selection.profileId)
    : undefined
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
    const selectedProfile =
      profile ?? settings.deepseekHarnessModelProfile
    if (
      selectedProfile &&
      !isDeepSeekHarnessModelProfile(selectedProfile)
    ) {
      throw new Error(
        'DeepSeek Harness 独立模型连接仅支持 api.deepseek.com 的 OpenAI Chat Completions 协议'
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
