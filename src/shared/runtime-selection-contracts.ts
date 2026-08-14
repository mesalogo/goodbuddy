import { z } from 'zod'

const runtimeSelectionProfileIdSchema = z.string().uuid()

export const agentRuntimeSelectionSchema = z.discriminatedUnion(
  'provider',
  [
    z.object({ provider: z.literal('auto') }).strict(),
    z
      .object({
        provider: z.literal('model'),
        profileId: runtimeSelectionProfileIdSchema
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
    | { kind: 'platform' }
    | { kind: 'profile'; profileId: string }
  continueModelSource:
    | { kind: 'platform' }
    | { kind: 'profile'; profileId: string }
  deepseekHarnessModelSource?:
    | { kind: 'platform' }
    | { kind: 'profile'; profileId: string }
}

type ChannelModelProfile = RuntimeSelectionRepairSettings['modelProfiles'][number]

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
  try {
    return new URL(profile.baseUrl).hostname.toLowerCase() ===
      'api.deepseek.com'
  } catch {
    return false
  }
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
  const defaultDirectSelection: AgentRuntimeSelection = {
    provider: 'model',
    profileId:
      defaultDirectProfile?.id ?? settings.defaultModelProfileId
  }
  if (selection.provider === 'auto') {
    return defaultDirectSelection
  }
  if (
    selection.provider === 'opencode' ||
    selection.provider === 'continue'
  ) {
    return { provider: selection.provider }
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
    (candidate) => candidate.id === repaired.profileId
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
    return {
      provider: 'model',
      profileId: settings.defaultModelProfileId
    }
  }
  const source =
    selection.provider === 'opencode'
      ? settings.opencodeModelSource
      : selection.provider === 'continue'
        ? settings.continueModelSource
        : settings.deepseekHarnessModelSource ?? { kind: 'platform' }
  return {
    provider: selection.provider,
    ...(source.kind === 'profile'
      ? { profileId: source.profileId }
      : {})
  }
}

export function agentRuntimeSelectionKey(
  selection: AgentRuntimeSelection
): string {
  return `${selection.provider}:${'profileId' in selection
    ? selection.profileId ?? 'platform'
    : 'default'}`
}
