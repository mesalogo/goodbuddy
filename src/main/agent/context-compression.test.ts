import { describe, expect, it } from 'vitest'
import {
  defaultContextCompressionSettings,
  type ContextCompressionSettings
} from '../../shared/contracts'
import {
  estimateTextTokens,
  planContextCompression
} from './context-compression'

function compressionSettings(
  overrides: Partial<ContextCompressionSettings> = {}
): ContextCompressionSettings {
  return {
    ...defaultContextCompressionSettings,
    enabled: true,
    ...overrides
  }
}

describe('context compression planning', () => {
  it('uses a conservative mixed-language token estimate', () => {
    expect(estimateTextTokens('abcdefgh')).toBe(2)
    expect(estimateTextTokens('上下文控制')).toBe(5)
    expect(estimateTextTokens('abc上下文')).toBe(4)
  })

  it('does not compress below the configured threshold', () => {
    expect(
      planContextCompression({
        history: [
          { role: 'user', content: 'Earlier question' },
          { role: 'assistant', content: 'Earlier answer' }
        ],
        prompt: 'Next question',
        settings: compressionSettings(),
        contextWindowTokens: undefined
      })
    ).toBeUndefined()
  })

  it('preserves recent complete turns within the raw token budget', () => {
    const history = [
      { role: 'user' as const, content: `old-user-${'a'.repeat(8_000)}` },
      {
        role: 'assistant' as const,
        content: `old-assistant-${'b'.repeat(8_000)}`
      },
      { role: 'user' as const, content: `mid-user-${'c'.repeat(8_000)}` },
      {
        role: 'assistant' as const,
        content: `mid-assistant-${'d'.repeat(8_000)}`
      },
      { role: 'user' as const, content: `new-user-${'e'.repeat(8_000)}` },
      {
        role: 'assistant' as const,
        content: `new-assistant-${'f'.repeat(8_000)}`
      }
    ]
    const plan = planContextCompression({
      history,
      prompt: 'Continue',
      settings: compressionSettings({
        triggerTokens: 15_000,
        recentRawTokens: 5_000
      })
    })

    expect(plan?.earlierMessages).toEqual(history.slice(0, 4))
    expect(plan?.recentMessages).toEqual(history.slice(4))
  })

  it('uses an optional model context limit as an earlier trigger', () => {
    const history = [
      { role: 'user' as const, content: 'a'.repeat(16_000) },
      { role: 'assistant' as const, content: 'b'.repeat(16_000) },
      { role: 'user' as const, content: 'c'.repeat(16_000) },
      { role: 'assistant' as const, content: 'd'.repeat(16_000) }
    ]
    const plan = planContextCompression({
      history,
      prompt: 'Continue',
      settings: compressionSettings(),
      contextWindowTokens: 32_000
    })

    expect(plan?.effectiveTriggerTokens).toBe(20_000)
    expect(plan?.earlierMessages.length).toBeGreaterThan(0)
  })

  it('defensively clamps legacy undersized context limits', () => {
    const history = [
      { role: 'user' as const, content: 'a'.repeat(40_000) },
      { role: 'assistant' as const, content: 'b'.repeat(40_000) },
      { role: 'user' as const, content: 'c'.repeat(40_000) },
      { role: 'assistant' as const, content: 'd'.repeat(40_000) }
    ]
    const plan = planContextCompression({
      history,
      prompt: 'Continue',
      settings: compressionSettings(),
      contextWindowTokens: 10_000
    })

    expect(plan?.effectiveTriggerTokens).toBe(20_000)
    expect(plan?.earlierMessages.length).toBeGreaterThan(0)
  })
})
