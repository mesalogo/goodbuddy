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
  return SPEECH_MODEL_CATALOG.map((entry) => ({
    ...entry,
    manualOnly: true,
    manualReason: entry.manualReason ?? '测试使用本地目录导入。',
    files: entry.files.map(({ name, role }) => ({ name, role }))
  }))
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
      repositoryUrl:
        'https://modelscope.cn/models/example/download-test-model',
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
          download: {
            url:
              'https://modelscope.cn/models/example/download-test-model/' +
              `resolve/${'a'.repeat(40)}/model.onnx`,
            size: modelBytes.byteLength,
            sha256: sha256(modelBytes)
          }
        },
        {
          name: 'tokens.txt',
          role: 'tokens',
          download: {
            url:
              'https://modelscope.cn/models/example/download-test-model/' +
              `resolve/${'a'.repeat(40)}/tokens.txt`,
            size: tokenBytes.byteLength,
            sha256: sha256(tokenBytes)
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
      senseVoice?.files.every((file) => file.download !== undefined)
    ).toBe(true)
    expect(whisper?.files.every((file) => file.download !== undefined))
      .toBe(true)
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
      expect(entry.repositoryUrl).toMatch(
        /^https:\/\/(?:modelscope\.cn\/models\/|huggingface\.co\/)/u
      )
      for (const file of entry.files) {
        expect(file.download?.url).toMatch(
          /^https:\/\/(?:modelscope\.cn\/models|huggingface\.co)\/[^/]+\/[^/]+\/resolve\/[a-f0-9]{40}\/[^/]+$/u
        )
      }
    }
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
    await expect(manager.snapshot()).resolves.toMatchObject({
      selectedModelId: 'download-test-model',
      operations: []
    })
    await manager.remove('download-test-model')
    await expect(manager.snapshot()).resolves.toMatchObject({
      selectedModelId: null,
      installed: []
    })
  })

  it('accepts arbitrary HTTP hosts and cross-host redirects', async () => {
    const userData = await temporaryDirectory()
    const modelBytes = new TextEncoder().encode('expected')
    const tokenBytes = new TextEncoder().encode('tokens')
    const catalog = downloadableCatalog(modelBytes).map((entry) => ({
      ...entry,
      files: entry.files.map((file) => ({
        ...file,
        download: file.download
          ? {
              ...file.download,
              url: file.download.url.replace(
                'https://modelscope.cn',
                'http://models.internal.example'
              )
            }
          : undefined
      }))
    }))
    const transport = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      if (url.hostname === 'models.internal.example') {
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://cdn.example.net${url.pathname}`
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
      redirected.install('download-test-model')
    ).resolves.toMatchObject({ id: 'download-test-model' })
    expect(transport).toHaveBeenCalledTimes(4)
    expect(
      transport.mock.calls.map(([input]) => new URL(String(input)).hostname)
    ).toEqual([
      'models.internal.example',
      'cdn.example.net',
      'models.internal.example',
      'cdn.example.net'
    ])
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
