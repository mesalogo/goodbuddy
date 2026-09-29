import { describe, expect, it } from 'vitest'
import {
  compactRuntimeSelectionLayer,
  optionalAgentRuntimeSelectionSchema,
  repairRuntimeSelectionLayer,
  resolveRuntimeChoice,
  runtimeSelectionLayerSchema,
  withoutLegacyAutoSelection,
  type RuntimeResolutionSettings
} from '../../shared/runtime-selection-contracts'

const defaultId = '00000000-0000-4000-8000-000000000001'
const secondId = '00000000-0000-4000-8000-000000000002'
const imageId = '00000000-0000-4000-8000-000000000003'
const keylessId = '00000000-0000-4000-8000-000000000004'
const missingId = '00000000-0000-4000-8000-000000000009'

function settings(
  overrides: Partial<RuntimeResolutionSettings> = {}
): RuntimeResolutionSettings {
  return {
    provider: 'opencode',
    defaultModelProfileId: defaultId,
    modelProfiles: [
      { id: defaultId, name: 'Default', protocol: 'openai-chat-completions', baseUrl: 'https://a.example/v1', authentication: 'api-key', apiKeyConfigured: true },
      { id: secondId, name: 'Second', protocol: 'anthropic-messages', baseUrl: 'https://b.example/v1', authentication: 'none' },
      { id: imageId, name: 'Image', protocol: 'openai-images-generations', baseUrl: 'https://c.example/v1', authentication: 'none' },
      { id: keylessId, name: 'Keyless', protocol: 'openai-chat-completions', baseUrl: 'https://d.example/v1', authentication: 'api-key', apiKeyConfigured: false }
    ],
    opencodeModelSource: { kind: 'profile', profileId: secondId },
    continueModelSource: { kind: 'platform' },
    deepseekHarnessModelSource: { kind: 'default' },
    ...overrides
  }
}

describe('layered runtime resolution', () => {
  it('uses global defaults when project and conversation inherit', () => {
    const resolved = resolveRuntimeChoice(settings())
    expect(resolved.selection).toEqual({ provider: 'opencode', profileId: secondId })
    expect(resolved).toMatchObject({ providerSource: 'global', modelSource: 'global' })
  })

  it('inherits each field independently across layers', () => {
    const resolved = resolveRuntimeChoice(settings(), {
      project: { provider: 'continue' },
      conversation: { model: { kind: 'profile', profileId: defaultId } }
    })
    expect(resolved.selection).toEqual({ provider: 'continue', profileId: defaultId })
    expect(resolved).toMatchObject({ providerSource: 'project', modelSource: 'conversation' })
  })

  it('switching only the execution mode takes that mode’s own default model', () => {
    const resolved = resolveRuntimeChoice(settings(), {
      project: { provider: 'opencode', model: { kind: 'profile', profileId: secondId } },
      conversation: { provider: 'continue' }
    })
    // The project's OpenCode model still applies because it is valid for Continue too;
    // a Continue-incompatible model would fall back to Continue's global default.
    expect(resolved.selection).toEqual({ provider: 'continue', profileId: secondId })
    const harness = resolveRuntimeChoice(settings(), {
      project: { model: { kind: 'profile', profileId: secondId } },
      conversation: { provider: 'deepseek-harness' }
    })
    expect(harness.selection).toEqual({ provider: 'deepseek-harness', profileId: defaultId })
    expect(harness.ignored).toMatchObject({ layer: 'project', kind: 'model', reason: 'incompatible' })
  })

  it('keeps a keyless model so the run can explain the missing key', () => {
    expect(resolveRuntimeChoice(settings(), {
      conversation: { model: { kind: 'profile', profileId: keylessId } }
    }).selection).toEqual({ provider: 'opencode', profileId: keylessId })
  })

  it('falls back and reports deleted or incompatible models', () => {
    for (const [profileId, reason] of [
      [missingId, 'missing'],
      [imageId, 'incompatible']
    ] as const) {
      const resolved = resolveRuntimeChoice(settings(), {
        conversation: { model: { kind: 'profile', profileId } }
      })
      expect(resolved.selection).toEqual({ provider: 'opencode', profileId: secondId })
      expect(resolved.ignored).toEqual({ layer: 'conversation', kind: 'model', reason })
    }
  })

  it('treats own configuration as an explicit choice', () => {
    expect(resolveRuntimeChoice(settings(), { project: { provider: 'continue' } }).selection)
      .toEqual({ provider: 'continue', runtimeConfig: true })
    const direct = resolveRuntimeChoice(settings(), {
      project: { provider: 'model' },
      conversation: { model: { kind: 'runtime-config' } }
    })
    expect(direct.selection).toEqual({ provider: 'model', profileId: defaultId })
    expect(direct.ignored?.reason).toBe('incompatible')
  })

  it('limits managed SSH projects to OpenCode and Continue with GoodBuddy connections', () => {
    const resolved = resolveRuntimeChoice(
      settings({ provider: 'model', continueModelSource: { kind: 'platform' } }),
      { project: { provider: 'deepseek-harness' }, conversation: { provider: 'continue' } },
      { remote: true }
    )
    expect(resolved.selection).toEqual({ provider: 'continue', profileId: defaultId })
    expect(resolved.ignored).toMatchObject({ layer: 'project', kind: 'provider' })
  })

  it('treats legacy automatic global settings as the direct model', () => {
    expect(resolveRuntimeChoice(settings({ provider: 'auto' })).selection)
      .toEqual({ provider: 'model', profileId: defaultId })
  })

  it('skips an unusable global direct default instead of failing', () => {
    const resolved = resolveRuntimeChoice(settings({ provider: 'model', defaultModelProfileId: imageId }))
    expect(resolved.selection).toEqual({ provider: 'model', profileId: defaultId })
  })

  it('never invents a profile id when no connections exist', () => {
    expect(resolveRuntimeChoice(settings({ provider: 'model', defaultModelProfileId: '', modelProfiles: [] })).selection)
      .toEqual({ provider: 'model' })
  })

  it('refuses GoodBuddy connections for an external OpenCode server', () => {
    const resolved = resolveRuntimeChoice(settings({ opencodeBaseUrl: 'http://127.0.0.1:4096' }), {
      conversation: { model: { kind: 'profile', profileId: defaultId } }
    })
    expect(resolved.selection).toEqual({ provider: 'opencode', runtimeConfig: true })
  })
})

describe('runtime selection layer storage', () => {
  it('upgrades legacy stored selections', () => {
    expect(runtimeSelectionLayerSchema.parse({ provider: 'auto' })).toEqual({})
    expect(runtimeSelectionLayerSchema.parse({ provider: 'opencode' })).toEqual({ provider: 'opencode' })
    expect(runtimeSelectionLayerSchema.parse({ provider: 'model', profileId: defaultId }))
      .toEqual({ provider: 'model', model: { kind: 'profile', profileId: defaultId } })
    expect(() => runtimeSelectionLayerSchema.parse({ provider: 'model', model: { kind: 'runtime-config' } }))
      .toThrow()
  })

  it('stores inheritance as absence', () => {
    expect(compactRuntimeSelectionLayer({})).toBeUndefined()
    expect(compactRuntimeSelectionLayer(undefined)).toBeUndefined()
  })

  it('repairs only references to deleted connections', () => {
    const input = settings()
    expect(repairRuntimeSelectionLayer(
      { provider: 'continue', model: { kind: 'profile', profileId: missingId } }, input
    )).toEqual({ provider: 'continue' })
    expect(repairRuntimeSelectionLayer(
      { model: { kind: 'profile', profileId: missingId } }, input
    )).toBeUndefined()
    const valid = { provider: 'continue' as const, model: { kind: 'profile' as const, profileId: imageId } }
    // Incompatible but existing: kept so the UI can explain the fallback.
    expect(repairRuntimeSelectionLayer(valid, input)).toEqual(valid)
  })

  it('maps legacy automatic request selections to unspecified', () => {
    expect(withoutLegacyAutoSelection({ provider: 'auto' })).toBeUndefined()
    expect(withoutLegacyAutoSelection({ prompt: 'x', runtimeSelection: { provider: 'auto' } }))
      .toEqual({ prompt: 'x' })
    expect(() => optionalAgentRuntimeSelectionSchema.parse({ provider: 'auto' })).toThrow()
    expect(optionalAgentRuntimeSelectionSchema.parse(withoutLegacyAutoSelection({ provider: 'auto' })))
      .toBeUndefined()
  })
})
