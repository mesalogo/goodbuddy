import { z } from 'zod'
import { isDeepSeekHarnessModelProfile } from './deepseek-harness-compatibility'

const runtimeSelectionProfileIdSchema = z.string().uuid()

export const agentRuntimeSelectionSchema = z.discriminatedUnion(
  'provider',
  [
    z.object({ provider: z.literal('auto') }).strict(),
    z
      .object({
        provider: z.literal('model'),
        profileId: runtimeSelectionProfileIdSchema.optional()
      })
      .strict(),
    z
      .object({
        provider: z.literal('opencode'),
        profileId: runtimeSelectionProfileIdSchema.optional()
      })
      .strict(),
    z
      .object({
        provider: z.literal('continue'),
        profileId: runtimeSelectionProfileIdSchema.optional()
      })
      .strict(),
    z
      .object({
        provider: z.literal('deepseek-harness'),
        profileId: runtimeSelectionProfileIdSchema.optional()
      })
      .strict()
  ]
)

export type AgentRuntimeSelection = z.infer<
  typeof agentRuntimeSelectionSchema
>

export type RuntimeSelectionRepairSettings = {
  modelProfiles: ReadonlyArray<{
    id: string
    baseUrl?: string
    protocol?: string
    authentication?: 'api-key' | 'none'
    apiKeyConfigured?: boolean
  }>
  defaultModelProfileId: string
  opencodeModelSource:
    | { kind: 'default' }
    | { kind: 'platform' }
    | { kind: 'profile'; profileId: string }
  continueModelSource:
    | { kind: 'default' }
    | { kind: 'platform' }
    | { kind: 'profile'; profileId: string }
  deepseekHarnessModelSource?:
    | { kind: 'default' }
    | { kind: 'platform' }
    | { kind: 'profile'; profileId: string }
}

type RuntimeModelSource =
  | { kind: 'default' }
  | { kind: 'platform' }
  | { kind: 'profile'; profileId: string }

export type RuntimeSelectionDefaultSettings = {
  provider: AgentRuntimeSelection['provider']
  defaultModelProfileId: string
  modelProfiles?: RuntimeSelectionRepairSettings['modelProfiles']
  opencodeBaseUrl: string
  opencodeEmbedded: boolean
  opencodeModelSource?: RuntimeModelSource
  continueModelSource?: RuntimeModelSource
  deepseekHarnessModelSource?: RuntimeModelSource
  opencodeModelProfile?: { id: string }
  continueModelProfile?: { id: string }
  deepseekHarnessModelProfile?: { id: string }
}

type ChannelModelProfile = RuntimeSelectionRepairSettings['modelProfiles'][number]

export function getRuntimeSelectionForProvider(
  provider: Exclude<AgentRuntimeSelection['provider'], 'auto'>,
  _settings: RuntimeSelectionDefaultSettings
): AgentRuntimeSelection {
  void _settings
  return { provider }
}

export function getDefaultRuntimeSelection(
  settings: RuntimeSelectionDefaultSettings
): AgentRuntimeSelection {
  const provider = settings.provider
  if (provider !== 'auto') {
    return getRuntimeSelectionForProvider(provider, settings)
  }
  return settings.opencodeBaseUrl || settings.opencodeEmbedded
    ? getRuntimeSelectionForProvider('opencode', settings)
    : getRuntimeSelectionForProvider('model', settings)
}

// Resolve only for presentation or request diagnostics, never for persisted defaults.
export function getRuntimeSelectionProfileId(
  selection: AgentRuntimeSelection,
  settings: RuntimeSelectionDefaultSettings
): string | undefined {
  if (selection.provider === 'auto') return undefined
  if (selection.profileId) return selection.profileId
  if (selection.provider === 'model') return settings.defaultModelProfileId
  const source = selection.provider === 'opencode' ? settings.opencodeModelSource
    : selection.provider === 'continue' ? settings.continueModelSource : settings.deepseekHarnessModelSource
  if (source?.kind === 'profile') return source.profileId
  if (source?.kind !== 'default') return undefined
  const profiles = settings.modelProfiles ?? []
  const isCompatible = (profile: ChannelModelProfile): boolean =>
    selection.provider === 'deepseek-harness'
      ? profile.protocol === 'openai-chat-completions' &&
        profile.authentication === 'api-key' &&
        Boolean(profile.baseUrl) &&
        isDeepSeekHarnessModelProfile({
          baseUrl: profile.baseUrl!,
          protocol: profile.protocol,
          authentication: profile.authentication
        })
      : Boolean(profile.protocol) &&
        profile.protocol !== 'openai-images-generations'
  return profiles.find(
    (profile) =>
      profile.id === settings.defaultModelProfileId && isCompatible(profile)
  )?.id ?? profiles.find(isCompatible)?.id
}

export function isChannelModelProfileUsable(
  profile: ChannelModelProfile
): boolean {
  return (
    profile.protocol !== 'openai-images-generations' &&
    !(
      profile.authentication === 'api-key' &&
      profile.apiKeyConfigured === false
    )
  )
}

function isDeepSeekHarnessRepairProfileUsable(
  profile: ChannelModelProfile
): boolean {
  if (
    profile.protocol !== 'openai-chat-completions' ||
    profile.authentication !== 'api-key' ||
    profile.apiKeyConfigured === false ||
    !profile.baseUrl
  ) {
    return false
  }
  return isDeepSeekHarnessModelProfile({
    baseUrl: profile.baseUrl,
    protocol: profile.protocol,
    authentication: profile.authentication
  })
}

export function repairChannelRuntimeSelection(
  selection: AgentRuntimeSelection,
  settings: RuntimeSelectionRepairSettings
): AgentRuntimeSelection {
  const defaultDirectProfile =
    settings.modelProfiles.find(
      (profile) =>
        profile.id === settings.defaultModelProfileId &&
        isChannelModelProfileUsable(profile)
    ) ??
    settings.modelProfiles.find(isChannelModelProfileUsable)
  const defaultDirectSelection: AgentRuntimeSelection = { provider: 'model' }
  if (selection.provider === 'auto') {
    return defaultDirectSelection
  }
  if (
    selection.provider === 'opencode' ||
    selection.provider === 'continue'
  ) {
    return repairAgentRuntimeSelection(selection, settings)
  }
  if (selection.provider === 'deepseek-harness') {
    const repaired = repairAgentRuntimeSelection(selection, settings)
    if (
      repaired.provider === 'deepseek-harness' &&
      repaired.profileId
    ) {
      const profile = settings.modelProfiles.find(
        (candidate) => candidate.id === repaired.profileId
      )
      if (profile && isDeepSeekHarnessRepairProfileUsable(profile)) {
        return repaired
      }
    }
    return { provider: 'deepseek-harness' }
  }
  const repaired = repairAgentRuntimeSelection(selection, settings)
  if (repaired.provider !== 'model') {
    return repaired
  }
  const profile = settings.modelProfiles.find(
    (candidate) => candidate.id === (repaired.profileId ?? defaultDirectProfile?.id)
  )
  return profile && isChannelModelProfileUsable(profile)
    ? repaired
    : defaultDirectSelection
}

export function repairAgentRuntimeSelection(
  selection: AgentRuntimeSelection,
  settings: RuntimeSelectionRepairSettings
): AgentRuntimeSelection {
  if (
    !('profileId' in selection) ||
    !selection.profileId ||
    settings.modelProfiles.some(
      (profile) => profile.id === selection.profileId
    )
  ) {
    return selection
  }
  if (selection.provider === 'model') {
    return { provider: 'model' }
  }
  return { provider: selection.provider }
}

export function agentRuntimeSelectionKey(
  selection: AgentRuntimeSelection
): string {
  return `${selection.provider}:${'profileId' in selection
    ? selection.profileId ?? 'default'
    : 'default'}`
}
