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
      .strict()
  ]
)

export type AgentRuntimeSelection = z.infer<
  typeof agentRuntimeSelectionSchema
>

export type RuntimeSelectionRepairSettings = {
  modelProfiles: ReadonlyArray<{ id: string }>
  defaultModelProfileId: string
  opencodeModelSource:
    | { kind: 'platform' }
    | { kind: 'profile'; profileId: string }
  continueModelSource:
    | { kind: 'platform' }
    | { kind: 'profile'; profileId: string }
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
      : settings.continueModelSource
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
