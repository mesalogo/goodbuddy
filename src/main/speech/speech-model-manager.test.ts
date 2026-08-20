import { createHash } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpeechModelCatalogEntry } from '../../shared/speech-model-contracts'
import { SPEECH_MODEL_CATALOG } from './speech-model-catalog'
import { SpeechModelManager } from './speech-model-manager'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-speech-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function manualCatalog(): SpeechModelCatalogEntry[] {
  const entry = SPEECH_MODEL_CATALOG.find(
    (candidate) => candidate.id === 'sensevoice-small-int8'
  )
  if (!entry) {
    throw new Error('SenseVoice test catalog entry is missing')
  }
  const modelBytes = new TextEncoder().encode('model')
  const tokenBytes = new TextEncoder().encode('tokens')
  return [{
    ...entry,
    manualOnly: true,
    manualReason: '测试使用本地目录导入。',
    repositoryUrls: {},
    files: [
      {
        name: 'model.int8.onnx',
        role: 'model',
        size: modelBytes.byteLength,
        sha256: sha256(modelBytes),
        targets: {}
      },
      {
        name: 'tokens.txt',
        role: 'tokens',
        size: tokenBytes.byteLength,
        sha256: sha256(tokenBytes),
        targets: {}
      }
    ]
  }]
}

function downloadableCatalog(
  modelBytes: Uint8Array,
  tokenBytes: Uint8Array = new TextEncoder().encode('tokens')
): SpeechModelCatalogEntry[] {
  return [
    {
      id: 'download-test-model',
      displayName: 'Download test model',
      description: 'Download model used by manager tests.',
      languages: ['中文'],
      family: 'whisper',
      quantization: 'int8',
      quality: 'balanced',
      speed: 'balanced',
      recommended: false,
      repositoryUrls: {
        modelscope:
          'https://modelscope.cn/models/example/download-test-model',
        'hugging-face':
          'https://huggingface.co/example/download-test-model'
      },
      license: {
        name: 'MIT License',
        notice: 'Test-only model metadata.',
        url: 'https://opensource.org/license/mit'
      },
      manualOnly: false,
      files: [
        {
          name: 'model.onnx',
          role: 'model',
          size: modelBytes.byteLength,
          sha256: sha256(modelBytes),
          targets: {
            modelscope: {
              url:
                'https://modelscope.cn/models/example/download-test-model/' +
                `resolve/${'a'.repeat(40)}/model.onnx`,
              repositoryUrl:
                'https://modelscope.cn/models/example/download-test-model',
              revision: 'a'.repeat(40),
              redirectHosts: []
            },
            'hugging-face': {
              url:
                'https://huggingface.co/example/download-test-model/' +
                `resolve/${'b'.repeat(40)}/model.onnx`,
              repositoryUrl:
                'https://huggingface.co/example/download-test-model',
              revision: 'b'.repeat(40),
              redirectHosts: []
            }
          }
        },
        {
          name: 'tokens.txt',
          role: 'tokens',
          size: tokenBytes.byteLength,
          sha256: sha256(tokenBytes),
          targets: {
            modelscope: {
              url:
                'https://modelscope.cn/models/example/download-test-model/' +
                `resolve/${'a'.repeat(40)}/tokens.txt`,
              repositoryUrl:
                'https://modelscope.cn/models/example/download-test-model',
              revision: 'a'.repeat(40),
              redirectHosts: []
            },
            'hugging-face': {
              url:
                'https://huggingface.co/example/download-test-model/' +
                `resolve/${'b'.repeat(40)}/tokens.txt`,
              repositoryUrl:
                'https://huggingface.co/example/download-test-model',
              revision: 'b'.repeat(40),
              redirectHosts: []
            }
          }
        }
      ]
    }
  ]
}

describe('speech model catalog', () => {
  it('lists verified multilingual models with accurate licensing', () => {
    const senseVoice = SPEECH_MODEL_CATALOG.find(
      (entry) => entry.id === 'sensevoice-small-int8'
    )
    const whisper = SPEECH_MODEL_CATALOG.find(
      (entry) => entry.id === 'whisper-tiny-multilingual'
    )
    const paraformerBilingual = SPEECH_MODEL_CATALOG.find(
      (entry) => entry.id === 'paraformer-bilingual-zh-en-int8'
    )
    const paraformerTrilingual = SPEECH_MODEL_CATALOG.find(
      (entry) => entry.id === 'paraformer-trilingual-zh-yue-en-int8'
    )
    const whisperSmall = SPEECH_MODEL_CATALOG.find(
      (entry) => entry.id === 'whisper-small-multilingual-int8'
    )
    const whisperMedium = SPEECH_MODEL_CATALOG.find(
      (entry) => entry.id === 'whisper-medium-multilingual-int8'
    )

    expect(senseVoice).toMatchObject({
      manualOnly: false,
      family: 'sensevoice',
      quantization: 'int8',
      license: {
        name: expect.stringContaining('自定义许可')
      }
    })
    expect(senseVoice?.license.notice).toContain('并非 Apache-2.0 或 MIT')
    expect(whisper).toMatchObject({
      manualOnly: false,
      family: 'whisper',
      quantization: 'int8',
      license: { name: 'MIT License' }
    })
    expect(
      senseVoice?.files.every(
        (file) =>
          file.targets.modelscope !== undefined &&
          file.targets['hugging-face'] !== undefined
      )
    ).toBe(true)
    expect(
      whisper?.files.every(
        (file) =>
          file.targets.modelscope !== undefined &&
          file.targets['hugging-face'] !== undefined
      )
    ).toBe(true)
    expect(
      SPEECH_MODEL_CATALOG.filter((entry) =>
        entry.files.every(
          (file) => file.targets.modelscope !== undefined
        )
      ).map((entry) => entry.id)
    ).toEqual([
      'sensevoice-small-int8',
      'whisper-tiny-multilingual',
      'paraformer-bilingual-zh-en-int8',
      'paraformer-trilingual-zh-yue-en-int8',
      'whisper-small-multilingual-int8',
      'whisper-medium-multilingual-int8'
    ])
    expect(whisper?.files.map((file) => file.name)).toEqual([
      'tiny-encoder.int8.onnx',
      'tiny-decoder.int8.onnx',
      'tiny-tokens.txt'
    ])
    expect(paraformerBilingual).toMatchObject({
      family: 'paraformer',
      languages: ['中文', '英语'],
      license: { name: 'Apache License 2.0 / MIT License' },
      recommended: true
    })
    expect(paraformerTrilingual).toMatchObject({
      family: 'paraformer',
      languages: ['中文', '粤语', '英语'],
      license: { name: 'Apache License 2.0' }
    })
    expect(whisperSmall).toMatchObject({
      family: 'whisper',
      quality: 'balanced',
      speed: 'balanced'
    })
    expect(whisperMedium).toMatchObject({
      family: 'whisper',
      quality: 'high',
      speed: 'slow'
    })
    expect(SPEECH_MODEL_CATALOG).toHaveLength(6)
    for (const entry of SPEECH_MODEL_CATALOG) {
      for (const file of entry.files) {
        expect(file.sha256).toMatch(/^[a-f0-9]{64}$/u)
        expect(file.size).toBeGreaterThan(0)
        for (const target of Object.values(file.targets)) {
          expect(target?.url).toMatch(
            /^https:\/\/(?:modelscope\.cn\/models|huggingface\.co)\/[^/]+\/[^/]+\/resolve\/[a-f0-9]{40}\/[^/]+$/u
          )
        }
        if (file.targets.modelscope) {
          expect(file.targets.modelscope.redirectHosts).toEqual([
            'cdn-lfs-cn-1.modelscope.cn'
          ])
        }
      }
    }
    expect(
      paraformerBilingual?.files.map((file) => ({
        canonicalSize: file.size,
        modelscopeSize: file.targets.modelscope?.size,
        sameSha256:
          file.sha256 === file.targets.modelscope?.sha256
      }))
    ).toEqual([
      {
        canonicalSize: 223_385_835,
        modelscopeSize: 227_330_205,
        sameSha256: false
      },
      {
        canonicalSize: 75_756,
        modelscopeSize: 75_354,
        sameSha256: false
      }
    ])
  })
})

describe('SpeechModelManager downloads', () => {
  it('rebuilds a stale selected runtime after valid files are restored', async () => {
    const userData = await temporaryDirectory()
    const modelBytes = new TextEncoder().encode('verified model bytes')
    const tokenBytes = new TextEncoder().encode('verified tokens')
    const root = join(userData, 'models', 'speech')
    const staleStaging =
      '.install-download-test-model-00000000-0000-4000-8000-000000000001'
    await mkdir(root, { recursive: true })
    await Promise.all([
      mkdir(join(root, staleStaging)),
      writeFile(
        join(root, '.selection.json'),
        `${JSON.stringify({
          selectedModelId: 'download-test-model'
        })}\n`
      )
    ])
    const getDownloadSource = vi.fn(() => 'modelscope' as const)
    const manager = new SpeechModelManager({
      userDataDirectory: userData,
      fetch: vi.fn<typeof fetch>(async (input) => {
        const bytes = String(input).endsWith('model.onnx')
          ? modelBytes
          : tokenBytes
        return new Response(bytes, {
          headers: { 'content-length': String(bytes.byteLength) }
        })
      }),
      catalog: downloadableCatalog(modelBytes, tokenBytes),
      getDownloadSource
    })

    await expect(manager.getSelectedRuntimeModel()).resolves.toBeUndefined()
    await manager.install('download-test-model', 'modelscope')
    const selected = await manager.getSelectedRuntimeModel()
    expect(selected).toMatchObject({ id: 'download-test-model' })
    const modelPath = join(
      root,
      'download-test-model',
      'model.onnx'
    )
    const originalModelStat = await stat(modelPath)
    await writeFile(
      modelPath,
      Buffer.alloc(modelBytes.byteLength, 0x7f)
    )
    await utimes(
      modelPath,
      originalModelStat.atime,
      originalModelStat.mtime
    )
    await expect(manager.getSelectedRuntimeModel()).resolves.toBeUndefined()
    await writeFile(modelPath, modelBytes)
    await utimes(
      modelPath,
      originalModelStat.atime,
      originalModelStat.mtime
    )
    const rebuilt = await Promise.all([
      manager.getSelectedRuntimeModel(),
      manager.getSelectedRuntimeModel()
    ])
    expect(rebuilt).toEqual([
      expect.objectContaining({ id: 'download-test-model' }),
      expect.objectContaining({ id: 'download-test-model' })
    ])
    const manifestPath = join(
      root,
      'download-test-model',
      'manifest.json'
    )
    const manifest = await readFile(manifestPath)
    await rm(manifestPath)
    await expect(manager.getSelectedRuntimeModel()).resolves.toBeUndefined()
    await writeFile(manifestPath, manifest)
    await expect(manager.getSelectedRuntimeModel()).resolves.toMatchObject({
      id: 'download-test-model'
    })
    expect(await readdir(root)).toContain(staleStaging)
    expect(getDownloadSource).not.toHaveBeenCalled()

    await writeFile(
      join(root, '.selection.json'),
      '{"selectedModelId":null}\n'
    )
    await expect(manager.getSelectedRuntimeModel()).resolves.toBeUndefined()
  })

  it('preserves an active selection partial during concurrent snapshot cleanup', async () => {
    const userData = await temporaryDirectory()
    const modelBytes = new TextEncoder().encode('verified model bytes')
    const tokenBytes = new TextEncoder().encode('verified tokens')
    let markWriteStarted: (() => void) | undefined
    let releaseWrite: (() => void) | undefined
    const writeStarted = new Promise<void>((resolveStarted) => {
      markWriteStarted = resolveStarted
    })
    const writeGate = new Promise<void>((resolveWrite) => {
      releaseWrite = resolveWrite
    })
    const manager = new SpeechModelManager({
      userDataDirectory: userData,
      fetch: vi.fn<typeof fetch>(async (input) => {
        const bytes = String(input).endsWith('model.onnx')
          ? modelBytes
          : tokenBytes
        return new Response(bytes, {
          headers: { 'content-length': String(bytes.byteLength) }
        })
      }),
      catalog: downloadableCatalog(modelBytes, tokenBytes),
      selectionFileOperations: {
        writeFile: async (path, data, options) => {
          await writeFile(path, data, options)
          markWriteStarted?.()
          await writeGate
        }
      }
    })
    await manager.install('download-test-model')
    const selecting = manager.select('download-test-model')
    await writeStarted
    const root = join(userData, 'models', 'speech')
    const activePartial = (await readdir(root)).find(
      (name) =>
        name.startsWith('.selection.json.') &&
        name.endsWith('.partial')
    )
    expect(activePartial).toBeDefined()

    await manager.snapshot()
    expect(await readdir(root)).toContain(activePartial)

    releaseWrite?.()
    await selecting
    await expect(manager.snapshot()).resolves.toMatchObject({
      selectedModelId: 'download-test-model'
    })
    expect(await readdir(root)).not.toContain(activePartial)
  })

  it('downloads to partial files, verifies hashes, and atomically installs', async () => {
    const userData = await temporaryDirectory()
    const modelBytes = new TextEncoder().encode('verified model bytes')
    const tokenBytes = new TextEncoder().encode('verified tokens')
    const catalog = downloadableCatalog(modelBytes, tokenBytes)
    const transport = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      const bytes = url.endsWith('model.onnx')
        ? modelBytes
        : tokenBytes
      return new Response(bytes, {
        headers: { 'content-length': String(bytes.byteLength) }
      })
    })
    const manager = new SpeechModelManager({
      userDataDirectory: userData,
      fetch: transport,
      catalog
    })

    const installed = await manager.install('download-test-model')

    expect(installed).toMatchObject({
      id: 'download-test-model',
      source: 'download',
      files: [
        {
          name: 'model.onnx',
          size: modelBytes.byteLength,
          sha256: sha256(modelBytes)
        },
        {
          name: 'tokens.txt',
          size: tokenBytes.byteLength,
          sha256: sha256(tokenBytes)
        }
      ]
    })
    expect(transport).toHaveBeenCalledTimes(2)
    for (const [input, init] of transport.mock.calls) {
      expect(String(input)).toMatch(
        /^https:\/\/modelscope\.cn\/models\//u
      )
      expect(init).toMatchObject({
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store'
      })
    }
    const modelDirectory = join(
      userData,
      'models',
      'speech',
      'download-test-model'
    )
    expect(await readFile(join(modelDirectory, 'model.onnx'))).toEqual(
      Buffer.from(modelBytes)
    )
    expect(
      (await readdir(modelDirectory)).some((name) =>
        name.endsWith('.partial')
      )
    ).toBe(false)

    await manager.select('download-test-model')
    const snapshot = await manager.snapshot()
    expect(snapshot).toMatchObject({
      selectedDownloadSource: 'modelscope',
      selectedModelId: 'download-test-model',
      operations: []
    })
    expect(snapshot.catalog[0]?.files[0]).not.toHaveProperty('targets')
    expect(JSON.stringify(snapshot.catalog)).not.toContain('/resolve/')
    await manager.remove('download-test-model')
    await expect(manager.snapshot()).resolves.toMatchObject({
      selectedModelId: null,
      installed: []
    })
  })

  it('installs and round-trips a source-specific artifact fingerprint', async () => {
    const userData = await temporaryDirectory()
    const importUserData = await temporaryDirectory()
    const mixedUserData = await temporaryDirectory()
    const huggingFaceModel = new TextEncoder().encode('hf model')
    const huggingFaceTokens = new TextEncoder().encode('hf tokens')
    const modelScopeModel = new TextEncoder().encode(
      'modelscope model variant'
    )
    const modelScopeTokens = new TextEncoder().encode(
      'modelscope tokens variant'
    )
    const catalog = downloadableCatalog(
      huggingFaceModel,
      huggingFaceTokens
    ).map((entry) => ({
      ...entry,
      files: entry.files.map((file) => {
        const bytes =
          file.role === 'model'
            ? modelScopeModel
            : modelScopeTokens
        return {
          ...file,
          targets: {
            ...file.targets,
            modelscope: file.targets.modelscope
              ? {
                  ...file.targets.modelscope,
                  size: bytes.byteLength,
                  sha256: sha256(bytes)
                }
              : undefined
          }
        }
      })
    }))
    const transport = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      const bytes = url.endsWith('model.onnx')
        ? modelScopeModel
        : modelScopeTokens
      return new Response(bytes, {
        headers: { 'content-length': String(bytes.byteLength) }
      })
    })
    const manager = new SpeechModelManager({
      userDataDirectory: userData,
      fetch: transport,
      catalog
    })

    await expect(manager.snapshot()).resolves.toMatchObject({
      catalog: [
        {
          downloadAvailability: [
            {
              source: 'modelscope',
              available: true,
              totalBytes:
                modelScopeModel.byteLength +
                modelScopeTokens.byteLength
            },
            {
              source: 'hugging-face',
              available: true,
              totalBytes:
                huggingFaceModel.byteLength +
                huggingFaceTokens.byteLength
            }
          ]
        }
      ]
    })
    const installed = await manager.install(
      'download-test-model',
      'modelscope'
    )
    expect(installed.files).toMatchObject([
      {
        name: 'model.onnx',
        size: modelScopeModel.byteLength,
        sha256: sha256(modelScopeModel)
      },
      {
        name: 'tokens.txt',
        size: modelScopeTokens.byteLength,
        sha256: sha256(modelScopeTokens)
      }
    ])
    await manager.select('download-test-model')
    await expect(manager.getSelectedRuntimeModel()).resolves.toMatchObject({
      id: 'download-test-model',
      files: installed.files
    })

    const archive = join(userData, 'modelscope-variant.zip')
    await manager.exportArchive('download-test-model', archive)
    const importing = new SpeechModelManager({
      userDataDirectory: importUserData,
      fetch: vi.fn<typeof fetch>(),
      catalog
    })
    await expect(
      importing.importArchive('download-test-model', archive)
    ).resolves.toMatchObject({
      files: installed.files
    })

    const mixedDirectory = join(mixedUserData, 'mixed-package')
    await mkdir(mixedDirectory)
    await Promise.all([
      writeFile(
        join(mixedDirectory, 'model.onnx'),
        modelScopeModel
      ),
      writeFile(
        join(mixedDirectory, 'tokens.txt'),
        huggingFaceTokens
      )
    ])
    const mixed = new SpeechModelManager({
      userDataDirectory: mixedUserData,
      fetch: vi.fn<typeof fetch>(),
      catalog
    })
    await expect(
      mixed.registerLocalDirectory(
        'download-test-model',
        mixedDirectory
      )
    ).rejects.toThrow('与当前模型目录不匹配')
  })

  it('cleans only manager-owned stale staging and partial artifacts', async () => {
    const userData = await temporaryDirectory()
    const modelBytes = new TextEncoder().encode('verified model bytes')
    const tokenBytes = new TextEncoder().encode('verified tokens')
    const manager = new SpeechModelManager({
      userDataDirectory: userData,
      fetch: vi.fn<typeof fetch>(async (input) => {
        const bytes = String(input).endsWith('model.onnx')
          ? modelBytes
          : tokenBytes
        return new Response(bytes, {
          headers: { 'content-length': String(bytes.byteLength) }
        })
      }),
      catalog: downloadableCatalog(modelBytes, tokenBytes)
    })
    await manager.install('download-test-model')
    const root = join(userData, 'models', 'speech')
    const modelDirectory = join(root, 'download-test-model')
    const staleStaging =
      '.install-download-test-model-00000000-0000-4000-8000-000000000001'
    const unrelatedStaging = '.install-download-test-model-user-backup'
    const selectionPartial =
      '.selection.json.00000000-0000-4000-8000-000000000002.partial'
    await mkdir(join(root, staleStaging))
    await writeFile(join(root, staleStaging, 'model.onnx.partial'), 'stale')
    await mkdir(join(root, unrelatedStaging))
    await writeFile(join(root, unrelatedStaging, 'keep.txt'), 'keep')
    await writeFile(
      join(modelDirectory, 'model.onnx.partial'),
      'interrupted'
    )
    await writeFile(join(modelDirectory, 'notes.partial'), 'keep')
    await writeFile(join(root, selectionPartial), 'interrupted')
    await writeFile(join(root, 'user.partial'), 'keep')

    await expect(manager.snapshot()).resolves.toMatchObject({
      installed: [expect.objectContaining({ id: 'download-test-model' })]
    })

    expect(await readdir(root)).toEqual(
      expect.arrayContaining([
        'download-test-model',
        unrelatedStaging,
        'user.partial'
      ])
    )
    expect(await readdir(root)).not.toEqual(
      expect.arrayContaining([staleStaging, selectionPartial])
    )
    expect(await readdir(modelDirectory)).toEqual(
      expect.arrayContaining([
        'manifest.json',
        'model.onnx',
        'tokens.txt',
        'notes.partial'
      ])
    )
    expect(await readdir(modelDirectory)).not.toContain(
      'model.onnx.partial'
    )
    await expect(
      readFile(join(modelDirectory, 'model.onnx'))
    ).resolves.toEqual(Buffer.from(modelBytes))
    await expect(
      readFile(join(root, unrelatedStaging, 'keep.txt'), 'utf8')
    ).resolves.toBe('keep')
  })

  it('freezes the operation source when the global setting changes', async () => {
    const userData = await temporaryDirectory()
    const modelBytes = new TextEncoder().encode('expected')
    const tokenBytes = new TextEncoder().encode('tokens')
    let selectedSource: 'modelscope' | 'hugging-face' = 'modelscope'
    let releaseFirstRequest: (() => void) | undefined
    let markFirstRequestStarted: (() => void) | undefined
    const firstRequestStarted = new Promise<void>((resolveStarted) => {
      markFirstRequestStarted = resolveStarted
    })
    const firstRequestGate = new Promise<void>((resolveRequest) => {
      releaseFirstRequest = resolveRequest
    })
    let requestCount = 0
    const transport = vi.fn<typeof fetch>(async (input) => {
      requestCount += 1
      if (requestCount === 1) {
        markFirstRequestStarted?.()
        await firstRequestGate
      }
      const bytes = String(input).endsWith('model.onnx')
        ? modelBytes
        : tokenBytes
      return new Response(bytes, {
        headers: { 'content-length': String(bytes.byteLength) }
      })
    })
    const manager = new SpeechModelManager({
      userDataDirectory: userData,
      catalog: downloadableCatalog(modelBytes, tokenBytes),
      fetch: transport,
      getDownloadSource: () => selectedSource
    })

    const installing = manager.install('download-test-model')
    await firstRequestStarted
    selectedSource = 'hugging-face'
    await expect(manager.snapshot()).resolves.toMatchObject({
      selectedDownloadSource: 'hugging-face',
      operations: [
        {
          modelId: 'download-test-model',
          kind: 'download',
          downloadSource: 'modelscope'
        }
      ]
    })
    releaseFirstRequest?.()
    await installing
    expect(
      transport.mock.calls.every(
        ([input]) => new URL(String(input)).hostname === 'modelscope.cn'
      )
    ).toBe(true)
  })

  it('follows only source-declared HTTPS redirect hosts', async () => {
    const userData = await temporaryDirectory()
    const modelBytes = new TextEncoder().encode('expected')
    const tokenBytes = new TextEncoder().encode('tokens')
    const catalog = downloadableCatalog(modelBytes).map((entry) => ({
      ...entry,
      files: entry.files.map((file) => ({
        ...file,
        targets: {
          ...file.targets,
          'hugging-face': file.targets['hugging-face']
            ? {
                ...file.targets['hugging-face'],
                redirectHosts: ['cdn-lfs.hf.co']
              }
            : undefined
        }
      }))
    }))
    const transport = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      if (url.hostname === 'huggingface.co') {
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://cdn-lfs.hf.co${url.pathname}`
          }
        })
      }
      const bytes = url.pathname.endsWith('model.onnx')
        ? modelBytes
        : tokenBytes
      return new Response(bytes, {
        headers: { 'content-length': String(bytes.byteLength) }
      })
    })
    const redirected = new SpeechModelManager({
      userDataDirectory: userData,
      catalog,
      fetch: transport
    })

    await expect(
      redirected.install('download-test-model', 'hugging-face')
    ).resolves.toMatchObject({ id: 'download-test-model' })
    expect(transport).toHaveBeenCalledTimes(4)
    expect(
      transport.mock.calls.map(([input]) => new URL(String(input)).hostname)
    ).toEqual([
      'huggingface.co',
      'cdn-lfs.hf.co',
      'huggingface.co',
      'cdn-lfs.hf.co'
    ])
  })

  it('rejects undeclared redirect hosts without following them', async () => {
    const userData = await temporaryDirectory()
    const modelBytes = new TextEncoder().encode('expected')
    const transport = vi.fn<typeof fetch>(async () =>
      new Response(null, {
        status: 302,
        headers: {
          location: 'https://untrusted.example/model.onnx'
        }
      })
    )
    const manager = new SpeechModelManager({
      userDataDirectory: userData,
      catalog: downloadableCatalog(modelBytes),
      fetch: transport
    })

    await expect(
      manager.install('download-test-model')
    ).rejects.toThrow('未声明的主机')
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('does not request another source when selected coverage is missing', async () => {
    const userData = await temporaryDirectory()
    const modelBytes = new TextEncoder().encode('expected')
    const catalog = downloadableCatalog(modelBytes).map((entry) => ({
      ...entry,
      repositoryUrls: {
        'hugging-face': entry.repositoryUrls['hugging-face']
      },
      files: entry.files.map((file) => ({
        ...file,
        targets: {
          'hugging-face': file.targets['hugging-face']
        }
      }))
    }))
    const transport = vi.fn<typeof fetch>()
    const manager = new SpeechModelManager({
      userDataDirectory: userData,
      catalog,
      fetch: transport
    })

    await expect(
      manager.install('download-test-model', 'modelscope')
    ).rejects.toThrow('当前下载源')
    expect(transport).not.toHaveBeenCalled()
  })

  it('does not request another source after a download failure', async () => {
    const userData = await temporaryDirectory()
    const modelBytes = new TextEncoder().encode('expected')
    const transport = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 503 })
    )
    const manager = new SpeechModelManager({
      userDataDirectory: userData,
      catalog: downloadableCatalog(modelBytes),
      fetch: transport
    })

    await expect(
      manager.install('download-test-model', 'modelscope')
    ).rejects.toThrow('HTTP 503')
    expect(transport).toHaveBeenCalledTimes(1)
    expect(
      new URL(String(transport.mock.calls[0]?.[0])).hostname
    ).toBe('modelscope.cn')
  })

  it('rejects bad digests without installing', async () => {
    const userData = await temporaryDirectory()
    const modelBytes = new TextEncoder().encode('expected')
    const catalog = downloadableCatalog(modelBytes)
    const badDigest = new SpeechModelManager({
      userDataDirectory: userData,
      catalog,
      fetch: vi.fn<typeof fetch>(async (input) => {
        const expectedSize = String(input).endsWith('model.onnx')
          ? modelBytes.byteLength
          : new TextEncoder().encode('tokens').byteLength
        return new Response(new Uint8Array(expectedSize).fill(1), {
          headers: { 'content-length': String(expectedSize) }
        })
      })
    })
    await expect(
      badDigest.install('download-test-model')
    ).rejects.toThrow('校验失败')
    await expect(badDigest.snapshot()).resolves.toMatchObject({
      installed: [],
      operations: []
    })
    expect(
      (await readdir(join(userData, 'models', 'speech'))).filter(
        (name) => name.startsWith('.install-')
      )
    ).toEqual([])
  })

  it('cancels an active download through its AbortSignal', async () => {
    const userData = await temporaryDirectory()
    const modelBytes = new TextEncoder().encode('expected')
    const catalog = downloadableCatalog(modelBytes)
    let requestStarted: (() => void) | undefined
    const started = new Promise<void>((resolveStarted) => {
      requestStarted = resolveStarted
    })
    const manager = new SpeechModelManager({
      userDataDirectory: userData,
      catalog,
      fetch: vi.fn<typeof fetch>(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            requestStarted?.()
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true }
            )
          })
      )
    })

    const installing = manager.install('download-test-model')
    await started
    expect(manager.cancel('download-test-model')).toBe(true)
    await expect(installing).rejects.toMatchObject({ name: 'AbortError' })
    expect(manager.cancel('download-test-model')).toBe(false)
    await expect(manager.snapshot()).resolves.toMatchObject({
      installed: [],
      operations: []
    })
  })

  it('round-trips a verified model through an offline ZIP archive', async () => {
    const userData = await temporaryDirectory()
    const modelBytes = new TextEncoder().encode('verified model bytes')
    const tokenBytes = new TextEncoder().encode('verified tokens')
    const catalog = downloadableCatalog(modelBytes, tokenBytes)
    const manager = new SpeechModelManager({
      userDataDirectory: userData,
      catalog,
      fetch: vi.fn<typeof fetch>(async (input) => {
        const bytes = String(input).endsWith('model.onnx')
          ? modelBytes
          : tokenBytes
        return new Response(bytes, {
          headers: { 'content-length': String(bytes.byteLength) }
        })
      })
    })
    const archive = join(userData, 'speech-model.zip')

    await manager.install('download-test-model')
    await manager.exportArchive('download-test-model', archive)
    await manager.remove('download-test-model')

    await expect(
      manager.importArchive('download-test-model', archive)
    ).resolves.toMatchObject({
      id: 'download-test-model',
      source: 'local',
      files: [
        {
          name: 'model.onnx',
          sha256: sha256(modelBytes)
        },
        {
          name: 'tokens.txt',
          sha256: sha256(tokenBytes)
        }
      ]
    })
  })
})

describe('SpeechModelManager local import', () => {
  it('copies only declared files and rejects executable content', async () => {
    const userData = await temporaryDirectory()
    const source = await temporaryDirectory()
    const manager = new SpeechModelManager({
      userDataDirectory: userData,
      fetch: vi.fn<typeof fetch>(),
      catalog: manualCatalog(),
      maxFileBytes: 1024
    })
    await writeFile(join(source, 'model.int8.onnx'), 'model')
    await writeFile(join(source, 'tokens.txt'), 'tokens')
    await writeFile(join(source, 'notes.md'), 'not copied')

    const installed = await manager.registerLocalDirectory(
      'sensevoice-small-int8',
      source
    )

    expect(installed.source).toBe('local')
    const installedFiles = await readdir(
      join(
        userData,
        'models',
        'speech',
        'sensevoice-small-int8'
      )
    )
    expect(installedFiles.sort()).toEqual(
      ['manifest.json', 'model.int8.onnx', 'tokens.txt'].sort()
    )

    await manager.remove('sensevoice-small-int8')
    await writeFile(join(source, 'run.exe'), 'not allowed')
    await expect(
      manager.registerLocalDirectory(
        'sensevoice-small-int8',
        source
      )
    ).rejects.toThrow('包含可执行文件')
  })

  it('rejects missing and oversized declared files', async () => {
    const userData = await temporaryDirectory()
    const source = await temporaryDirectory()
    const manager = new SpeechModelManager({
      userDataDirectory: userData,
      fetch: vi.fn<typeof fetch>(),
      catalog: manualCatalog(),
      maxFileBytes: 4
    })
    await mkdir(join(source, 'model.int8.onnx'))
    await writeFile(join(source, 'tokens.txt'), 'token')

    await expect(
      manager.registerLocalDirectory(
        'sensevoice-small-int8',
        source
      )
    ).rejects.toThrow('普通文件')

    await rm(join(source, 'model.int8.onnx'), { recursive: true })
    await writeFile(join(source, 'model.int8.onnx'), '12345')
    await expect(
      manager.registerLocalDirectory(
        'sensevoice-small-int8',
        source
      )
    ).rejects.toThrow('大小无效')
  })
})
