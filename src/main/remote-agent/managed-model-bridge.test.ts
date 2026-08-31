import { describe, expect, it } from 'vitest'
import type { ResolvedModelProfile } from '../runtime-settings-store'
import { createManagedModelBridge } from './managed-model-bridge'

const profile: ResolvedModelProfile = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Private profile',
  baseUrl: 'https://provider.example/v1',
  modelName: 'private-model',
  protocol: 'openai-responses',
  authentication: 'api-key',
  supportsImageInput: true,
  maximumOutputTokens: 8_192,
  apiKey: 'prompt-scoped-secret'
}

describe('managed Agent prompt model setup', () => {
  it('validates and clones a bounded Agent prompt profile', () => {
    const setup = createManagedModelBridge({ profile })

    expect(setup.profile).toEqual({
      profileId: profile.id,
      modelProfileDigest: expect.stringMatching(
        /^sha256:[a-f0-9]{64}$/u
      ),
      provider: 'openai',
      baseUrl: 'https://provider.example/v1',
      model: 'private-model',
      protocol: 'openai-responses',
      authentication: 'api-key',
      apiKey: 'prompt-scoped-secret',
      capabilities: { imageInput: true },
      limits: {
        maximumOutputTokens: 8_192,
        maximumModelCalls: 100,
        maximumTotalOutputTokens: 819_200,
        requestTimeoutMilliseconds: 60_000
      }
    })
    expect(setup.policy).toEqual({
      protocol: 'openai-responses',
      model: 'private-model',
      modelProfileDigest: setup.profile.modelProfileDigest,
      supportsImageInput: true
    })
    expect(JSON.stringify(setup.policy)).not.toContain(
      'prompt-scoped-secret'
    )

    profile.apiKey = 'changed-after-creation'
    expect(setup.profile.apiKey).toBe('prompt-scoped-secret')
  })

  it('rejects unusable profiles before opening a remote binding', () => {
    expect(() =>
      createManagedModelBridge({
        profile: {
          ...profile,
          authentication: 'api-key',
          apiKey: undefined
        }
      })
    ).toThrow(/usable text model profile/iu)
    expect(() =>
      createManagedModelBridge({
        profile: {
          ...profile,
          protocol: 'openai-images-generations'
        }
      })
    ).toThrow(/usable text model profile/iu)
  })
})
