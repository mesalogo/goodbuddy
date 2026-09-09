import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { MODEL_BRIDGE_OPTIONAL_LIMITS_CAPABILITY } from '../../shared/model-bridge-contracts'
import type { ResolvedModelProfile } from '../runtime-settings-store'
import {
  createManagedModelBridge,
  modelProfileForAgent,
  createResolvedModelProfileDigest
} from './managed-model-bridge'

const profile: ResolvedModelProfile = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Private profile',
  baseUrl: 'https://provider.example/v1',
  modelName: 'private-model',
  protocol: 'openai-responses',
  authentication: 'api-key',
  supportsImageInput: true,
  maximumOutputTokens: 8_192,
  requestHeaders: {
    'x-tenant-id': 'remote-tenant'
  },
  requestBody: {
    temperature: 0.2
  },
  apiKey: 'prompt-scoped-secret'
}

describe('managed Agent prompt model setup', () => {
  it('supplies the required released 0.11.22 limits only to Agents without optional-limit support', () => {
    // agent-v0.11.22:src/shared/model-bridge-contracts.ts
    const releasedLimits = z.object({
      maximumOutputTokens: z.number().int().min(1).max(1_000_000),
      requestTimeoutMilliseconds: z.number().int().min(1).max(300_000)
    }).strict()
    const setup = createManagedModelBridge({ profile: { ...profile, maximumOutputTokens: undefined } })
    expect(releasedLimits.safeParse(setup.profile.limits).success).toBe(false)
    const released = modelProfileForAgent(setup.profile, [])
    expect(releasedLimits.parse(released.limits)).toEqual({
      maximumOutputTokens: 32_000,
      requestTimeoutMilliseconds: 60_000
    })
    expect(modelProfileForAgent(setup.profile, [{
      name: MODEL_BRIDGE_OPTIONAL_LIMITS_CAPABILITY, version: 1
    }]).limits).toEqual({})
    expect(setup.profile.limits).toEqual({})
    const large = { ...setup.profile, limits: { maximumOutputTokens: 2_000_000, requestTimeoutMilliseconds: 600_000 } }
    expect(releasedLimits.parse(modelProfileForAgent(large, []).limits)).toEqual({
      maximumOutputTokens: 1_000_000, requestTimeoutMilliseconds: 300_000
    })
    expect(modelProfileForAgent(large, [{
      name: MODEL_BRIDGE_OPTIONAL_LIMITS_CAPABILITY, version: 1
    }]).limits).toEqual(large.limits)
  })

  it('leaves unspecified provider limits unset and preserves configured tokens', () => {
    expect(createManagedModelBridge({
      profile: { ...profile, maximumOutputTokens: undefined }
    }).profile.limits).toEqual({})
    expect(createManagedModelBridge({
      profile: { ...profile, maximumOutputTokens: 2_000_000 }
    }).profile.limits).toEqual({ maximumOutputTokens: 2_000_000 })
  })

  it('validates and clones an Agent prompt profile without prompt-wide quotas', () => {
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
      requestHeaders: {
        'x-tenant-id': 'remote-tenant'
      },
      requestBody: {
        temperature: 0.2
      },
      capabilities: { imageInput: true },
      limits: {
        maximumOutputTokens: 8_192
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

  it('binds request customization but not credentials into the profile digest', () => {
    expect(
      createResolvedModelProfileDigest({
        ...profile,
        apiKey: 'different-secret'
      })
    ).toBe(createResolvedModelProfileDigest(profile))
    expect(
      createResolvedModelProfileDigest({
        ...profile,
        requestBody: {
          ...profile.requestBody,
          temperature: 0.4
        }
      })
    ).not.toBe(createResolvedModelProfileDigest(profile))
  })
})
