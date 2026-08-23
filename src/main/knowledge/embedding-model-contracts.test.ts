import { describe, expect, it } from 'vitest'
import { embeddingModelCatalogEntrySchema } from './embedding-model-contracts'

describe('embedding model contracts', () => {
  it('requires a reason when a catalog package is unavailable', () => {
    const result = embeddingModelCatalogEntrySchema.safeParse({
      id: 'test-model',
      displayName: 'Test',
      description: 'Test model.',
      languages: ['English'],
      runtime: 'onnxruntime-web/wasm',
      dimensions: 4,
      contextTokens: 128,
      quantization: 'int8',
      recommended: false,
      available: false,
      repositoryUrls: {},
      license: {
        name: 'Test',
        notice: 'Test only.',
        url: 'https://example.com/license'
      },
      files: [
        {
          name: 'model.onnx',
          role: 'model',
          size: 1,
          sha256: 'a'.repeat(64),
          targets: {}
        }
      ]
    })

    expect(result.success).toBe(false)
  })

  it('requires all runtime artifacts for an available package', () => {
    const result = embeddingModelCatalogEntrySchema.safeParse({
      id: 'test-model',
      displayName: 'Test',
      description: 'Test model.',
      languages: ['English'],
      runtime: 'onnxruntime-web/wasm',
      dimensions: 4,
      contextTokens: 128,
      quantization: 'int8',
      recommended: false,
      available: true,
      repositoryUrls: {},
      license: {
        name: 'Test',
        notice: 'Test only.',
        url: 'https://example.com/license'
      },
      files: [
        {
          name: 'model.onnx',
          role: 'model',
          size: 1,
          sha256: 'a'.repeat(64),
          targets: {}
        }
      ]
    })

    expect(result.success).toBe(false)
  })
})
