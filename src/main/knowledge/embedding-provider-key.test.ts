import { describe, expect, it } from 'vitest'
import { embeddingStorageProvider } from './embedding-provider-key'

describe('embeddingStorageProvider', () => {
  it('preserves legacy provider keys without a fingerprint', () => {
    expect(
      embeddingStorageProvider({ provider: 'local-provider' })
    ).toBe('local-provider')
  })

  it('separates matching model names served by different endpoints', () => {
    const first = embeddingStorageProvider({
      provider: 'openai-compatible',
      fingerprint: 'openai-compatible:https://one.invalid:embed-v2'
    })
    const second = embeddingStorageProvider({
      provider: 'openai-compatible',
      fingerprint: 'openai-compatible:https://two.invalid:embed-v2'
    })

    expect(first).not.toBe(second)
    expect(first).not.toContain('one.invalid')
    expect(second).not.toContain('two.invalid')
    expect(first.length).toBeLessThanOrEqual(128)
  })
})
