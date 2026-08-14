import { describe, expect, it } from 'vitest'
import type { RuntimeSettings } from '../../shared/contracts'
import {
  getDefaultRuntimeSelection,
  getRuntimeSelectionForProvider
} from './runtime-selection'

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
  it('uses the configured Chat Completions profile', () => {
    const selection = getRuntimeSelectionForProvider(
      'deepseek-harness',
      harnessSettings({
        kind: 'profile',
        profileId: harnessProfileId
      })
    )

    expect(selection).toEqual({
      provider: 'deepseek-harness',
      profileId: harnessProfileId
    } satisfies Record<string, string>)
  })

  it('uses platform settings without a profile id', () => {
    const settings = harnessSettings({ kind: 'platform' })

    expect(getDefaultRuntimeSelection(settings)).toEqual({
      provider: 'deepseek-harness'
    })
  })
})
