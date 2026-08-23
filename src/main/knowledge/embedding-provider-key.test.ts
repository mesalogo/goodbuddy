import { describe, expect, it } from 'vitest'
import {
  embeddingProviderFingerprint,
  embeddingStorageProvider
} from './embedding-provider-key'

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

  it('canonically fingerprints every vector compatibility field', () => {
    const fields = {
      provider: 'openai-compatible',
      endpoint: 'https://vectors.invalid/v1/embeddings',
      dataPath: { scope: 'network', kind: 'endpoint' },
      model: 'embed-v2',
      dimensions: 768,
      encodingRecipe: {
        recipeId: 'query-passage',
        queryTemplate: 'query: {text}',
        documentTemplate: 'passage: {text}'
      }
    } as const
    const reordered = {
      dimensions: 768,
      model: 'embed-v2',
      provider: 'openai-compatible',
      encodingRecipe: {
        documentTemplate: 'passage: {text}',
        queryTemplate: 'query: {text}',
        recipeId: 'query-passage'
      },
      dataPath: { kind: 'endpoint', scope: 'network' },
      endpoint: 'https://vectors.invalid/v1/embeddings'
    } as const

    expect(embeddingProviderFingerprint(fields)).toBe(
      embeddingProviderFingerprint(reordered)
    )
    for (const changed of [
      { ...fields, endpoint: 'https://other.invalid/v1/embeddings' },
      { ...fields, dataPath: { kind: 'endpoint', scope: 'loopback' } },
      { ...fields, model: 'embed-v3' },
      { ...fields, dimensions: 384 },
      {
        ...fields,
        encodingRecipe: {
          ...fields.encodingRecipe,
          queryTemplate: 'search: {text}'
        }
      }
    ]) {
      expect(embeddingProviderFingerprint(changed)).not.toBe(
        embeddingProviderFingerprint(fields)
      )
    }
  })
})
