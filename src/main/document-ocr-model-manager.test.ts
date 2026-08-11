import { createHash } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentOcrModelCatalogEntry } from '../shared/document-parsing-contracts'
import { DOCUMENT_OCR_MODEL_CATALOG } from './document-ocr-model-catalog'
import {
  DocumentOcrModelManager,
  extractPaddleCharacterDictionary
} from './document-ocr-model-manager'

const temporaryDirectories: string[] = []

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function dictionaryYaml(): Uint8Array {
  const characters = [
    "'!'",
    "'\"'",
    "''''",
    ...Array.from({ length: 120 }, (_, index) =>
      String.fromCodePoint(0x4e00 + index)
    )
  ]
  return Buffer.from(
    `PostProcess:\n  name: CTCLabelDecode\n  character_dict:\n${characters
      .map((character) => `  - ${character}`)
      .join('\n')}\n`,
    'utf8'
  )
}

function catalog(
  detection: Uint8Array,
  recognition: Uint8Array,
  dictionary: Uint8Array
): readonly DocumentOcrModelCatalogEntry[] {
  const files = [
    {
      name: 'detection.onnx',
      role: 'detection' as const,
      bytes: detection
    },
    {
      name: 'recognition.onnx',
      role: 'recognition' as const,
      bytes: recognition
    },
    {
      name: 'dictionary.yml',
      role: 'dictionary' as const,
      bytes: dictionary
    }
  ]
  return [
    {
      id: 'pp-ocrv6-tiny',
      displayName: 'PP-OCRv6 Tiny',
      description: 'Test OCR model catalog entry.',
      languages: ['中文', '英语'],
      runtime: 'onnxruntime-web-wasm',
      quality: 'balanced',
      speed: 'fast',
      recommended: true,
      repositoryUrl:
        'https://modelscope.cn/models/PaddlePaddle/PP-OCRv6_tiny_rec_onnx',
      license: {
        name: 'Apache License 2.0',
        notice: 'Test license notice.',
        url: 'https://example.com/license'
      },
      files: files.map((file) => ({
        name: file.name,
        role: file.role,
        download: {
          url: `https://modelscope.cn/models/example/resolve/revision/${file.name}`,
          size: file.bytes.byteLength,
          sha256: sha256(file.bytes)
        }
      }))
    }
  ]
}

async function createManager(
  bytes?: {
    detection: Uint8Array
    recognition: Uint8Array
    dictionary: Uint8Array
  }
): Promise<{
  directory: string
  manager: DocumentOcrModelManager
  modelBytes: {
    detection: Uint8Array
    recognition: Uint8Array
    dictionary: Uint8Array
  }
}> {
  const directory = await mkdtemp(
    join(tmpdir(), 'goodbuddy-document-ocr-model-')
  )
  temporaryDirectories.push(directory)
  const modelBytes = bytes ?? {
    detection: Buffer.from('detection model'),
    recognition: Buffer.from('recognition model'),
    dictionary: dictionaryYaml()
  }
  const testCatalog = catalog(
    modelBytes.detection,
    modelBytes.recognition,
    modelBytes.dictionary
  )
  const entry = testCatalog[0]
  if (!entry) {
    throw new Error('Test OCR catalog is empty')
  }
  const files = new Map(
    entry.files.map((file) => [
      file.download.url,
      modelBytes[file.role]
    ])
  )
  const transport = vi.fn(async (input: string | URL | Request) => {
    const url =
      input instanceof Request ? input.url : input.toString()
    const body = files.get(url)
    if (!body) {
      return new Response(null, { status: 404 })
    }
    return new Response(body, {
      status: 200,
      headers: {
        'content-length': String(body.byteLength)
      }
    })
  }) as unknown as typeof fetch
  return {
    directory,
    manager: new DocumentOcrModelManager({
      userDataDirectory: directory,
      fetch: transport,
      catalog: testCatalog
    }),
    modelBytes
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('DocumentOcrModelManager', () => {
  it('uses immutable SHA-256 verified ModelScope catalog files', () => {
    expect(DOCUMENT_OCR_MODEL_CATALOG).toHaveLength(3)
    expect(
      new Set(DOCUMENT_OCR_MODEL_CATALOG.map((entry) => entry.id)).size
    ).toBe(3)
    expect(
      DOCUMENT_OCR_MODEL_CATALOG.filter((entry) => entry.recommended).map(
        (entry) => entry.id
      )
    ).toEqual(['pp-ocrv6-small'])

    for (const entry of DOCUMENT_OCR_MODEL_CATALOG) {
      for (const file of entry.files) {
        expect(file.download.url).toMatch(
          /^https:\/\/modelscope\.cn\/models\/PaddlePaddle\/[^/]+\/resolve\/[a-f0-9]{40}\/[^/]+$/u
        )
        expect(file.download.sha256).toMatch(/^[a-f0-9]{64}$/u)
        expect(file.download.size).toBeGreaterThan(0)
      }
    }

    expect(
      DOCUMENT_OCR_MODEL_CATALOG.find(
        (entry) => entry.id === 'pp-ocrv6-small'
      )
    ).toMatchObject({
      languages: ['50 种语言'],
      quality: 'balanced',
      speed: 'balanced',
      recommended: true,
      files: [
        {
          role: 'detection',
          download: {
            url: 'https://modelscope.cn/models/PaddlePaddle/PP-OCRv6_small_det_onnx/resolve/956a0b620a4017cc04056c692be1703b0025d028/inference.onnx',
            size: 9_880_512,
            sha256:
              'd73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e'
          }
        },
        {
          role: 'recognition',
          download: {
            url: 'https://modelscope.cn/models/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/296d43bc0ebced0fd9c605174aa5962e49810ab6/inference.onnx',
            size: 21_159_378,
            sha256:
              '5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634'
          }
        },
        {
          role: 'dictionary',
          download: {
            url: 'https://modelscope.cn/models/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/296d43bc0ebced0fd9c605174aa5962e49810ab6/inference.yml',
            size: 150_579,
            sha256:
              'ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1'
          }
        }
      ]
    })
    expect(
      DOCUMENT_OCR_MODEL_CATALOG.find(
        (entry) => entry.id === 'pp-ocrv6-medium'
      )
    ).toMatchObject({
      languages: ['50 种语言'],
      quality: 'high',
      speed: 'slow',
      recommended: false,
      files: [
        {
          role: 'detection',
          download: {
            url: 'https://modelscope.cn/models/PaddlePaddle/PP-OCRv6_medium_det_onnx/resolve/c317b40325be40bfaaff58c8dcece2a075294f8a/inference.onnx',
            size: 62_032_837,
            sha256:
              'eb13b44b25bb36f89528b68720af8a61d9cf381176107f465db1757b65d086e1'
          }
        },
        {
          role: 'recognition',
          download: {
            url: 'https://modelscope.cn/models/PaddlePaddle/PP-OCRv6_medium_rec_onnx/resolve/db5d610d492a14e3c34dc1fd4e9339bd369f79e6/inference.onnx',
            size: 76_554_979,
            sha256:
              '9c09abf0957f7968c7586464b7397b84ad2387a0497a351af40e9acc71b673ba'
          }
        },
        {
          role: 'dictionary',
          download: {
            url: 'https://modelscope.cn/models/PaddlePaddle/PP-OCRv6_medium_rec_onnx/resolve/db5d610d492a14e3c34dc1fd4e9339bd369f79e6/inference.yml',
            size: 150_580,
            sha256:
              '991b700facf5b50a7de193468207d5f4255b538dde0d312ae3b7c7a9b6873129'
          }
        }
      ]
    })
  })

  it('downloads, verifies, and loads OCR assets', async () => {
    const { manager, modelBytes } = await createManager()

    await expect(manager.install('pp-ocrv6-tiny')).resolves.toMatchObject({
      id: 'pp-ocrv6-tiny',
      source: 'download'
    })
    await expect(manager.getStatus('pp-ocrv6-tiny')).resolves.toMatchObject({
      available: true,
      verified: true
    })
    const assets = await manager.getAssets('pp-ocrv6-tiny')
    expect(new Uint8Array(assets.detection)).toEqual(
      Uint8Array.from(modelBytes.detection)
    )
    expect(new Uint8Array(assets.recognition)).toEqual(
      Uint8Array.from(modelBytes.recognition)
    )
    expect(new TextDecoder().decode(assets.dictionary)).toContain(
      "!\n\"\n'\n"
    )
  })

  it('rejects an imported model whose hash does not match', async () => {
    const { directory, manager, modelBytes } = await createManager()
    const source = join(directory, 'manual-model')
    await mkdir(source)
    await Promise.all([
      writeFile(join(source, 'detection.onnx'), modelBytes.detection),
      writeFile(join(source, 'recognition.onnx'), modelBytes.recognition),
      writeFile(join(source, 'dictionary.yml'), 'tampered')
    ])

    await expect(
      manager.registerLocalDirectory('pp-ocrv6-tiny', source)
    ).rejects.toThrow('校验失败')
    await expect(manager.getSnapshot()).resolves.toMatchObject({
      installed: [],
      operations: []
    })
  })

  it('round-trips a verified OCR model through an offline ZIP archive', async () => {
    const { directory, manager, modelBytes } = await createManager()
    const archive = join(directory, 'ocr-model.zip')

    await manager.install('pp-ocrv6-tiny')
    await manager.exportArchive('pp-ocrv6-tiny', archive)
    await manager.remove('pp-ocrv6-tiny')

    await expect(
      manager.importArchive('pp-ocrv6-tiny', archive)
    ).resolves.toMatchObject({
      id: 'pp-ocrv6-tiny',
      source: 'local'
    })
    const assets = await manager.getAssets('pp-ocrv6-tiny')
    expect(new Uint8Array(assets.detection)).toEqual(
      Uint8Array.from(modelBytes.detection)
    )
    expect(new Uint8Array(assets.recognition)).toEqual(
      Uint8Array.from(modelBytes.recognition)
    )
  })
})

describe('extractPaddleCharacterDictionary', () => {
  it('converts Paddle YAML scalars into the line dictionary used by OCR', () => {
    const dictionary = extractPaddleCharacterDictionary(
      new TextDecoder().decode(dictionaryYaml())
    )
    expect(dictionary.startsWith("!\n\"\n'\n")).toBe(true)
    expect(dictionary.split('\n')).toHaveLength(124)
  })
})
