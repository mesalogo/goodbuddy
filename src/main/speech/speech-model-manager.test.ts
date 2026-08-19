import { createHash } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
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
    expect(whisper?.files.map((file) => file.name)).toEqual([
      'tiny-encoder.int8.onnx',
      'tiny-decoder.int8.onnx',
      'tiny-tokens.txt'
    ])
    expect(paraformerBilingual).toMatchObject({
      family: 'paraformer',
      languages: ['中文', '英语'],
      license: { name: 'MIT License' },
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
      }
    }
    expect(
      paraformerBilingual?.files.some(
        (file) => file.targets.modelscope !== undefined
      )
    ).toBe(false)
  })
})

describe('SpeechModelManager downloads', () => {
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
