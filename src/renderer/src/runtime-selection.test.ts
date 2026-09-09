import { describe, expect, it } from 'vitest'
import type { RuntimeSettings } from '../../shared/contracts'
import {
  getDefaultRuntimeSelection,
  getRuntimeSelectionProfileId,
  getRuntimeSelectionForProvider
} from '../../shared/runtime-selection-contracts'

const harnessProfileId = '00000000-0000-4000-8000-000000000071'

function harnessSettings(
  source: { kind: 'platform' } | { kind: 'profile'; profileId: string }
): RuntimeSettings {
  return {
    provider: 'deepseek-harness',
    deepseekHarnessModelSource: source
  } as RuntimeSettings
}

describe('DeepSeek Harness runtime selection', () => {
  it('references the Runtime configuration without copying its profile', () => {
    const selection = getRuntimeSelectionForProvider(
      'deepseek-harness',
      harnessSettings({
        kind: 'profile',
        profileId: harnessProfileId
      })
    )

    expect(selection).toEqual({
      provider: 'deepseek-harness'
    } satisfies Record<string, string>)
  })

  it('uses platform settings without a profile id', () => {
    const settings = harnessSettings({ kind: 'platform' })

    expect(getDefaultRuntimeSelection(settings)).toEqual({
      provider: 'deepseek-harness'
    })
  })

  it('resolves default references to the first Runtime-compatible profile', () => {
    const imageId = '00000000-0000-4000-8000-000000000072'
    const anthropicId = '00000000-0000-4000-8000-000000000073'
    const openAiId = '00000000-0000-4000-8000-000000000074'
    const settings = {
      provider: 'model' as const,
      defaultModelProfileId: imageId,
      opencodeBaseUrl: '',
      opencodeEmbedded: true,
      opencodeModelSource: { kind: 'default' as const },
      continueModelSource: { kind: 'default' as const },
      deepseekHarnessModelSource: { kind: 'default' as const },
      modelProfiles: [
        { id: imageId, protocol: 'openai-images-generations' },
        { id: anthropicId, protocol: 'anthropic-messages' },
        {
          id: openAiId,
          baseUrl: 'https://gateway.example/v1',
          protocol: 'openai-chat-completions',
          authentication: 'api-key' as const,
          apiKeyConfigured: true
        }
      ]
    }

    expect(getRuntimeSelectionProfileId({ provider: 'opencode' }, settings)).toBe(anthropicId)
    expect(getRuntimeSelectionProfileId({ provider: 'continue' }, settings)).toBe(anthropicId)
    expect(getRuntimeSelectionProfileId({ provider: 'deepseek-harness' }, settings)).toBe(openAiId)
  })
})
