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
      repositoryUrls: {
        modelscope:
          'https://modelscope.cn/models/example/test-model',
        'hugging-face':
          'https://huggingface.co/example/test-model'
      },
      license: {
        name: 'Apache License 2.0',
        notice: 'Test license notice.',
        url: 'https://example.com/license'
      },
      files: files.map((file) => ({
        name: file.name,
        role: file.role,
        size: file.bytes.byteLength,
        sha256: sha256(file.bytes),
        targets: {
          modelscope: {
            url:
              'https://modelscope.cn/models/example/test-model/' +
              `resolve/${'a'.repeat(40)}/${file.name}`,
            repositoryUrl:
              'https://modelscope.cn/models/example/test-model',
            revision: 'a'.repeat(40),
            redirectHosts: []
          },
          'hugging-face': {
            url:
              'https://huggingface.co/example/test-model/' +
              `resolve/${'b'.repeat(40)}/${file.name}`,
            repositoryUrl:
              'https://huggingface.co/example/test-model',
            revision: 'b'.repeat(40),
            redirectHosts: []
          }
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
    entry.files.flatMap((file) =>
      Object.values(file.targets).map((target) => [
        target.url,
        modelBytes[file.role]
      ] as const)
    )
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
  it('reports a removed catalog model as unavailable', async () => {
    const { manager } = await createManager()

    await expect(manager.getStatus('retired-model')).resolves.toMatchObject({
      id: 'retired-model',
      available: false,
      verified: false,
      detail: expect.stringContaining('不再提供')
    })
  })

  it('uses immutable byte-identical ModelScope and Hugging Face files', () => {
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
      expect(entry.repositoryUrls.modelscope).toMatch(
        /^https:\/\/modelscope\.cn\/models\/PaddlePaddle\//u
      )
      expect(entry.repositoryUrls['hugging-face']).toMatch(
        /^https:\/\/huggingface\.co\/PaddlePaddle\//u
      )
      for (const file of entry.files) {
        expect(file.targets.modelscope?.url).toMatch(
          /^https:\/\/modelscope\.cn\/models\/PaddlePaddle\/[^/]+\/resolve\/[a-f0-9]{40}\/[^/]+$/u
        )
        expect(file.targets['hugging-face']?.url).toMatch(
          /^https:\/\/huggingface\.co\/PaddlePaddle\/[^/]+\/resolve\/[a-f0-9]{40}\/[^/]+$/u
        )
        expect(file.sha256).toMatch(/^[a-f0-9]{64}$/u)
        expect(file.size).toBeGreaterThan(0)
      }
    }

    const small = DOCUMENT_OCR_MODEL_CATALOG.find(
      (entry) => entry.id === 'pp-ocrv6-small'
    )
    expect(small).toMatchObject({
      languages: ['50 种语言'],
      quality: 'balanced',
      speed: 'balanced',
      recommended: true,
      files: [
        {
          role: 'detection',
          size: 9_880_512,
          sha256:
            'd73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e',
          targets: {
            modelscope: {
              revision: '956a0b620a4017cc04056c692be1703b0025d028'
            },
            'hugging-face': {
              revision: '28fe5895c24fd108c19eb3e8479f4ab385fbfc62'
            }
          }
        },
        {
          role: 'recognition',
          size: 21_159_378,
          sha256:
            '5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634'
        },
        {
          role: 'dictionary',
          size: 150_579,
          sha256:
            'ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1'
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
          size: 62_032_837,
          sha256:
            'eb13b44b25bb36f89528b68720af8a61d9cf381176107f465db1757b65d086e1'
        },
        {
          role: 'recognition',
          size: 76_554_979,
          sha256:
            '9c09abf0957f7968c7586464b7397b84ad2387a0497a351af40e9acc71b673ba'
        },
        {
          role: 'dictionary',
          size: 150_580,
          sha256:
            '991b700facf5b50a7de193468207d5f4255b538dde0d312ae3b7c7a9b6873129'
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
    const snapshot = await manager.getSnapshot()
    expect(snapshot.selectedDownloadSource).toBe('modelscope')
    expect(snapshot.catalog[0]?.files[0]).not.toHaveProperty('targets')
    expect(JSON.stringify(snapshot.catalog)).not.toContain('/resolve/')
  })

  it('downloads the same canonical package from Hugging Face', async () => {
    const { manager } = await createManager()

    await expect(
      manager.install('pp-ocrv6-tiny', 'hugging-face')
    ).resolves.toMatchObject({
      id: 'pp-ocrv6-tiny',
      source: 'download'
    })
  })

  it('does not request another source when selected coverage is missing', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-document-ocr-model-')
    )
    temporaryDirectories.push(directory)
    const detection = Buffer.from('detection')
    const recognition = Buffer.from('recognition')
    const dictionary = dictionaryYaml()
    const sourceCatalog = catalog(
      detection,
      recognition,
      dictionary
    ).map((entry) => ({
      ...entry,
      repositoryUrls: {
        modelscope: entry.repositoryUrls.modelscope
      },
      files: entry.files.map((file) => ({
        ...file,
        targets: {
          modelscope: file.targets.modelscope
        }
      }))
    }))
    const transport = vi.fn<typeof fetch>()
    const manager = new DocumentOcrModelManager({
      userDataDirectory: directory,
      fetch: transport,
      catalog: sourceCatalog
    })

    await expect(
      manager.install('pp-ocrv6-tiny', 'hugging-face')
    ).rejects.toThrow('当前下载源')
    expect(transport).not.toHaveBeenCalled()
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
