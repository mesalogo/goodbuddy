import { describe, expect, it } from 'vitest'
import { modelArtifactTargetsSchema } from './model-download-contracts'
import {
  speechModelCatalogEntrySchema,
  speechModelLocalDirectoryInputSchema,
  speechModelSnapshotSchema
} from './speech-model-contracts'

const revision = 'a'.repeat(40)
const repositoryUrl =
  'https://huggingface.co/example/test-speech-model'
const downloadableEntry = {
  id: 'test-speech-model',
  displayName: 'Test speech model',
  description: 'A model used to verify the shared contract.',
  languages: ['中文'],
  family: 'whisper' as const,
  quantization: 'int8' as const,
  quality: 'balanced' as const,
  speed: 'balanced' as const,
  recommended: false,
  repositoryUrls: {
    'hugging-face': repositoryUrl
  },
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
      size: 12,
      sha256: 'a'.repeat(64),
      targets: {
        'hugging-face': {
          url: `${repositoryUrl}/resolve/${revision}/model.onnx`,
          repositoryUrl,
          revision,
          redirectHosts: ['cdn-lfs.hf.co']
        }
      }
    }
  ]
}

const catalogView = {
  id: downloadableEntry.id,
  displayName: downloadableEntry.displayName,
  description: downloadableEntry.description,
  languages: downloadableEntry.languages,
  family: downloadableEntry.family,
  quantization: downloadableEntry.quantization,
  quality: downloadableEntry.quality,
  speed: downloadableEntry.speed,
  recommended: downloadableEntry.recommended,
  license: downloadableEntry.license,
  manualOnly: false,
  files: [
    {
      name: 'model.onnx',
      role: 'model' as const,
      size: 12,
      sha256: 'a'.repeat(64)
    }
  ],
  downloadAvailability: [
    {
      source: 'modelscope' as const,
      available: false,
      unavailableReason: '当前下载源暂不提供此模型的完整已验证文件'
    },
    {
      source: 'hugging-face' as const,
      available: true,
      totalBytes: 12
    }
  ]
}

describe('speech model contracts', () => {
  it('requires canonical identity and one complete verified source', () => {
    expect(speechModelCatalogEntrySchema.parse(downloadableEntry)).toEqual(
      downloadableEntry
    )
    expect(
      speechModelCatalogEntrySchema.safeParse({
        ...downloadableEntry,
        files: [
          {
            name: 'model.onnx',
            role: 'model',
            size: 12,
            sha256: 'a'.repeat(64),
            targets: {}
          }
        ]
      }).success
    ).toBe(false)
    expect(
      speechModelCatalogEntrySchema.safeParse({
        ...downloadableEntry,
        files: [
          {
            ...downloadableEntry.files[0],
            targets: {
              'hugging-face': {
                ...downloadableEntry.files[0]!.targets[
                  'hugging-face'
                ],
                url:
                  'https://huggingface.co/example/another-model/' +
                  `resolve/${revision}/model.onnx`
              }
            }
          }
        ]
      }).success
    ).toBe(false)
  })

  it('rejects mutable revisions and source-host mismatches', () => {
    const target =
      downloadableEntry.files[0]!.targets['hugging-face']
    expect(
      speechModelCatalogEntrySchema.safeParse({
        ...downloadableEntry,
        files: [
          {
            ...downloadableEntry.files[0],
            targets: {
              'hugging-face': {
                ...target,
                revision: 'main',
                url: `${repositoryUrl}/resolve/main/model.onnx`
              }
            }
          }
        ]
      }).success
    ).toBe(false)
    expect(
      speechModelCatalogEntrySchema.safeParse({
        ...downloadableEntry,
        files: [
          {
            ...downloadableEntry.files[0],
            targets: {
              modelscope: {
                ...target
              }
            }
          }
        ]
      }).success
    ).toBe(false)
    expect(
      speechModelCatalogEntrySchema.safeParse({
        ...downloadableEntry,
        files: [
          {
            ...downloadableEntry.files[0],
            targets: {
              'hugging-face': {
                ...target,
                redirectHosts: ['modelscope.cn']
              }
            }
          }
        ]
      }).success
    ).toBe(false)
  })

  it('allows only the declared ModelScope CDN redirect host', () => {
    const modelscopeRepositoryUrl =
      'https://modelscope.cn/models/example/test-speech-model'
    const target = {
      url:
        `${modelscopeRepositoryUrl}/resolve/${revision}/` +
        'model.onnx',
      repositoryUrl: modelscopeRepositoryUrl,
      revision,
      redirectHosts: ['cdn-lfs-cn-1.modelscope.cn']
    }

    expect(
      modelArtifactTargetsSchema.safeParse({
        modelscope: target
      }).success
    ).toBe(true)
    expect(
      modelArtifactTargetsSchema.safeParse({
        modelscope: {
          ...target,
          size: 13,
          sha256: 'b'.repeat(64)
        }
      }).success
    ).toBe(true)
    expect(
      modelArtifactTargetsSchema.safeParse({
        modelscope: {
          ...target,
          size: 13
        }
      }).success
    ).toBe(false)
    expect(
      modelArtifactTargetsSchema.safeParse({
        modelscope: {
          ...target,
          redirectHosts: ['untrusted.example']
        }
      }).success
    ).toBe(false)
  })

  it('keeps repository links consistent with source targets', () => {
    expect(
      speechModelCatalogEntrySchema.safeParse({
        ...downloadableEntry,
        repositoryUrls: {
          'hugging-face':
            'https://huggingface.co/example/another-model'
        }
      }).success
    ).toBe(false)
  })

  it('requires a reason for manual-only models and rejects duplicate files', () => {
    const manualFile = {
      name: 'model.onnx',
      role: 'model' as const,
      size: 12,
      sha256: 'a'.repeat(64),
      targets: {}
    }
    expect(
      speechModelCatalogEntrySchema.safeParse({
        ...downloadableEntry,
        manualOnly: true,
        files: [
          manualFile,
          { ...manualFile, role: 'tokens' }
        ]
      }).success
    ).toBe(false)
    expect(
      speechModelCatalogEntrySchema.safeParse({
        ...downloadableEntry,
        manualOnly: true,
        manualReason: '上游没有可核验的下载目标。',
        files: [manualFile]
      }).success
    ).toBe(true)
  })

  it('keeps renderer snapshots URL-free and validates frozen sources', () => {
    expect(
      speechModelSnapshotSchema.safeParse({
        rootDirectory: 'C:\\models\\speech',
        selectedDownloadSource: 'hugging-face',
        catalog: [catalogView],
        installed: [],
        operations: [
          {
            modelId: 'test-speech-model',
            kind: 'download',
            phase: 'transferring',
            currentFile: 'model.onnx',
            completedBytes: 1,
            totalBytes: 12,
            downloadSource: 'hugging-face'
          }
        ],
        selectedModelId: null
      }).success
    ).toBe(true)
    expect(
      speechModelSnapshotSchema.safeParse({
        rootDirectory: 'C:\\models\\speech',
        selectedDownloadSource: 'hugging-face',
        catalog: [catalogView],
        installed: [],
        operations: [
          {
            modelId: 'test-speech-model',
            kind: 'download',
            phase: 'transferring',
            currentFile: 'model.onnx',
            completedBytes: 1,
            totalBytes: 12
          }
        ],
        selectedModelId: null
      }).success
    ).toBe(false)
  })

  it('rejects traversal and unknown local-directory fields', () => {
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
  })
})
