import { describe, expect, it } from 'vitest'
import {
  speechModelCatalogEntrySchema,
  speechModelLocalDirectoryInputSchema,
  speechModelSnapshotSchema
} from './speech-model-contracts'

const downloadableEntry = {
  id: 'test-speech-model',
  displayName: 'Test speech model',
  description: 'A model used to verify the shared contract.',
  languages: ['中文'],
  family: 'whisper' as const,
  quantization: 'int8' as const,
  repositoryUrl: 'https://huggingface.co/example/test-speech-model',
  license: {
    name: 'MIT License',
    notice: 'Test license notice.',
    url: 'https://opensource.org/license/mit'
  },
  manualOnly: false,
  files: [
    {
      name: 'model.onnx',
      role: 'model' as const,
      download: {
        url: 'https://huggingface.co/example/test/resolve/main/model.onnx',
        size: 12,
        sha256: 'a'.repeat(64)
      }
    }
  ]
}

describe('speech model contracts', () => {
  it('requires verified download metadata for every automatic file', () => {
    expect(speechModelCatalogEntrySchema.parse(downloadableEntry)).toEqual(
      downloadableEntry
    )
    expect(
      speechModelCatalogEntrySchema.safeParse({
        ...downloadableEntry,
        files: [{ name: 'model.onnx', role: 'model' }]
      }).success
    ).toBe(false)
  })

  it('requires a reason for manual-only models and rejects duplicate files', () => {
    expect(
      speechModelCatalogEntrySchema.safeParse({
        ...downloadableEntry,
        manualOnly: true,
        files: [
          { name: 'model.onnx', role: 'model' },
          { name: 'model.onnx', role: 'tokens' }
        ]
      }).success
    ).toBe(false)
    expect(
      speechModelCatalogEntrySchema.safeParse({
        ...downloadableEntry,
        manualOnly: true,
        manualReason: '上游没有可核验的大小和摘要。',
        files: [{ name: 'model.onnx', role: 'model' }]
      }).success
    ).toBe(true)
  })

  it('rejects traversal, unknown fields, and malformed snapshots', () => {
    expect(
      speechModelCatalogEntrySchema.safeParse({
        ...downloadableEntry,
        files: [
          {
            ...downloadableEntry.files[0],
            name: '../model.onnx'
          }
        ]
      }).success
    ).toBe(false)
    expect(
      speechModelLocalDirectoryInputSchema.safeParse({
        modelId: 'test-speech-model',
        directory: 'C:\\models',
        copyEverything: true
      }).success
    ).toBe(false)
    expect(
      speechModelSnapshotSchema.safeParse({
        rootDirectory: 'C:\\models\\speech',
        catalog: [downloadableEntry],
        installed: [],
        operations: [
          {
            modelId: 'test-speech-model',
            kind: 'download',
            phase: 'transferring',
            currentFile: 'model.onnx',
            completedBytes: -1,
            totalBytes: 12
          }
        ],
        selectedModelId: null
      }).success
    ).toBe(false)
  })
})
