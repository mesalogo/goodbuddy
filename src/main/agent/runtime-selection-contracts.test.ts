import { describe, expect, it } from 'vitest'
import { applyRuntimeSelection } from './runtime-selection'
import type { ResolvedRuntimeSettings } from '../runtime-settings-store'
import { defaultRuntimeCustomizationSettings } from '../../shared/contracts'
import {
  repairChannelRuntimeSelection,
  type AgentRuntimeSelection,
  type RuntimeSelectionRepairSettings
} from '../../shared/runtime-selection-contracts'

const defaultId = '00000000-0000-4000-8000-000000000001'
const fallbackId = '00000000-0000-4000-8000-000000000002'
const missingId = '00000000-0000-4000-8000-000000000003'

function settings(
  defaultProfile: Partial<RuntimeSelectionRepairSettings['modelProfiles'][number]>
): RuntimeSelectionRepairSettings {
  return {
    defaultModelProfileId: defaultId,
    modelProfiles: [
      {
        id: defaultId, protocol: 'openai-chat-completions',
        authentication: 'api-key', apiKeyConfigured: true, ...defaultProfile
      },
      {
        id: fallbackId, protocol: 'openai-chat-completions',
        authentication: 'none', apiKeyConfigured: false
      }
    ],
    opencodeModelSource: { kind: 'platform' },
    continueModelSource: { kind: 'platform' }
  }
}

function resolvedSettings(input: RuntimeSelectionRepairSettings): ResolvedRuntimeSettings {
  return {
    provider: 'model', modelBaseUrl: 'https://model.example/v1', modelName: 'default',
    modelProtocol: 'openai-chat-completions', modelAuthentication: 'api-key',
    imageGenerationQuality: 'auto',
    modelProfiles: input.modelProfiles.map((profile) => ({
      id: profile.id, name: profile.id, baseUrl: 'https://model.example/v1',
      modelName: profile.id,
      protocol: profile.protocol as ResolvedRuntimeSettings['modelProtocol'],
      authentication: profile.authentication!,
      apiKey: profile.apiKeyConfigured ? 'fixture-key' : undefined
    })),
    defaultModelProfileId: input.defaultModelProfileId,
    opencodeBaseUrl: '', opencodeEmbedded: false, opencodeBinaryPath: '',
    opencodeConfigPath: '', continueBinaryPath: '', continueConfigPath: '',
    continueMode: 'chat', subagentSmartRoutingEnabled: false,
    knowledgeEmbeddingEnabled: false, knowledgeEmbeddingBaseUrl: '',
    knowledgeEmbeddingModel: '', knowledgeRerankEnabled: false,
    knowledgeRerankEndpoint: '', knowledgeRerankModel: '',
    runtimeCustomization: defaultRuntimeCustomizationSettings,
    workspacePath: '.', toolApproval: 'always'
  }
}

describe('channel direct model repair', () => {
  const selections: AgentRuntimeSelection[] = [
    { provider: 'auto' },
    { provider: 'model' },
    { provider: 'model', profileId: defaultId },
    { provider: 'model', profileId: missingId }
  ]
  it.each([
    { protocol: 'openai-images-generations' },
    { apiKeyConfigured: false },
    { id: missingId }
  ])('pins a verified fallback when the default is unusable: %j', (defaultProfile) => {
    const input = settings(defaultProfile)
    if (defaultProfile.id) input.modelProfiles = input.modelProfiles.slice(1)
    for (const selection of selections) {
      const repaired = repairChannelRuntimeSelection(selection, input)
      expect(repaired).toEqual({ provider: 'model', profileId: fallbackId })
      const resolved = applyRuntimeSelection(resolvedSettings(input), repaired)
      expect(resolved.settings.defaultModelProfileId).toBe(fallbackId)
      expect(resolved.settings.modelProtocol).toBe('openai-chat-completions')
      expect(resolved.settings.modelAuthentication).toBe('none')
    }
  })

  it('keeps a healthy default dynamic and preserves valid explicit pins', () => {
    const input = settings({})
    for (const selection of [selections[0]!, selections[1]!, selections[3]!]) {
      const repaired = repairChannelRuntimeSelection(selection, input)
      expect(repaired).toEqual({ provider: 'model' })
      const changed = { ...resolvedSettings(input), defaultModelProfileId: fallbackId }
      expect(applyRuntimeSelection(changed, repaired).settings.defaultModelProfileId).toBe(fallbackId)
    }
    for (const profileId of [defaultId, fallbackId]) {
      const selection = { provider: 'model', profileId } as const
      expect(repairChannelRuntimeSelection(selection, input)).toEqual(selection)
    }
  })

  it('preserves a valid pin even when the global default is an image model', () => {
    const input = settings({ protocol: 'openai-images-generations' })
    const selection = { provider: 'model', profileId: fallbackId } as const
    expect(repairChannelRuntimeSelection(selection, input)).toEqual(selection)
  })

  it('does not invent a profile when no usable fallback exists', () => {
    const input = settings({ apiKeyConfigured: false })
    input.modelProfiles = input.modelProfiles.slice(0, 1)
    expect(repairChannelRuntimeSelection({ provider: 'auto' }, input))
      .toEqual({ provider: 'model' })
  })
})
