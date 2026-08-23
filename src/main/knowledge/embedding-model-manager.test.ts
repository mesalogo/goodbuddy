import { createHash } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MODEL_DOWNLOAD_SOURCES,
  resolveModelDownloadPackage
} from '../../shared/model-download-contracts'
import type { EmbeddingModelCatalogEntry } from './embedding-model-contracts'
import { EMBEDDING_MODEL_CATALOG } from './embedding-model-catalog'
import { EmbeddingModelManager } from './embedding-model-manager'

const roots: string[] = []

function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

function testCatalog(
  contents: Record<string, string>
): EmbeddingModelCatalogEntry[] {
  const roles = [
    'model',
    'tokenizer',
    'tokenizer-configuration',
    'configuration',
    'license'
  ] as const
  return [
    {
      id: 'complete-test-model',
      displayName: 'Complete Test Model',
      description: 'A complete injected test model.',
      languages: ['English'],
      runtime: 'onnxruntime-web/wasm',
      dimensions: 4,
      contextTokens: 128,
      quantization: 'test',
      recommended: false,
      available: true,
      repositoryUrls: {},
      license: {
        name: 'Test license',
        notice: 'Tests only.',
        url: 'https://example.com/license'
      },
      files: roles.map((role, index) => {
        const name = Object.keys(contents)[index]!
        const value = contents[name]!
        return {
          name,
          role,
          size: Buffer.byteLength(value),
          sha256: sha256(value),
          targets: {
            modelscope: {
              url: `https://modelscope.cn/models/test/model/resolve/${'a'.repeat(40)}/${name}`,
              repositoryUrl:
                'https://modelscope.cn/models/test/model',
              revision: 'a'.repeat(40),
              redirectHosts: []
            },
            'hugging-face': {
              url: `https://huggingface.co/test/model/resolve/${'b'.repeat(40)}/${name}`,
              repositoryUrl: 'https://huggingface.co/test/model',
              revision: 'b'.repeat(40),
              redirectHosts: []
            }
          }
        }
      })
    }
  ]
}

function embeddingArchive(
  contents: Record<string, string>,
  overrides: {
    kind?: string
    modelId?: string
    extraEntries?: Record<string, Uint8Array>
    hashOverrides?: Record<string, string>
  } = {}
): Uint8Array {
  const entry = testCatalog(contents)[0]!
  const files = entry.files.map(({ name, role, size, sha256 }) => ({
    name,
    role,
    size,
    sha256: overrides.hashOverrides?.[name] ?? sha256
  }))
  return zipSync({
    'goodbuddy-model.json': Buffer.from(
      JSON.stringify({
        format: 'goodbuddy-model-archive',
        version: 1,
        kind: overrides.kind ?? 'embedding',
        modelId: overrides.modelId ?? entry.id,
        displayName: entry.displayName,
        exportedAt: '2026-08-20T00:00:00.000Z',
        files
      })
    ),
    ...Object.fromEntries(
      Object.entries(contents).map(([name, value]) => [
        name,
        Buffer.from(value)
      ])
    ),
    ...overrides.extraEntries
  })
}

async function fixture(): Promise<{
  root: string
  source: string
  manager: EmbeddingModelManager
  contents: Record<string, string>
}> {
  const root = await mkdtemp(join(tmpdir(), 'embedding-model-'))
  roots.push(root)
  const source = join(root, 'source')
  await mkdir(source)
  const contents = {
    'model.onnx': 'model',
    'tokenizer.json': 'tokenizer',
    'tokenizer_config.json': 'tokenizer config',
    'config.json': 'model config',
    LICENSE: 'license'
  }
  for (const [name, value] of Object.entries(contents)) {
    await writeFile(join(source, name), value)
  }
  return {
    root,
    source,
    contents,
    manager: new EmbeddingModelManager({
      userDataDirectory: root,
      catalog: testCatalog(contents)
    })
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    )
  )
})

describe('EmbeddingModelManager', () => {
  it('publishes a complete downloadable production Granite package', async () => {
    expect(EMBEDDING_MODEL_CATALOG).toHaveLength(1)
    expect(EMBEDDING_MODEL_CATALOG[0]).toMatchObject({
      available: true,
      runtime: 'onnxruntime-web/wasm'
    })
    expect(
      EMBEDDING_MODEL_CATALOG[0]!.files.map(
        ({ name, size, sha256 }) => ({ name, size, sha256 })
      )
    ).toEqual([
      {
        name: 'model_quantized.onnx',
        size: 97_858_099,
        sha256:
          '704c1ebca5fbb7cd83ced41827658ac4c9990c64f7f2874d22b78044e5022e22'
      },
      {
        name: 'tokenizer.json',
        size: 25_301_671,
        sha256:
          '51947676cae1f991fa51c6b9a24e14ee5460e5f0b9f692f13bb3159829d1592a'
      },
      {
        name: 'tokenizer_config.json',
        size: 12_860,
        sha256:
          '6ed69389e30a8ecabfce2f9ebcdf0c908b34056f24d994340f2f216521c057d5'
      },
      {
        name: 'config.json',
        size: 1_215,
        sha256:
          'ae74d55a56f779774cb9a8e63d3c2da9ae1af83c00229ffdff43d0b38407a0ee'
      },
      {
        name: 'special_tokens_map.json',
        size: 871,
        sha256:
          '013787ee251ff611722479197c00853b62113ad303cb0a36524231783c676c69'
      }
    ])
    for (const source of MODEL_DOWNLOAD_SOURCES) {
      const resolved = resolveModelDownloadPackage(
        EMBEDDING_MODEL_CATALOG[0]!.files,
        source
      )
      expect(resolved.files.map((file) => file.name)).toEqual([
        'model_quantized.onnx',
        'tokenizer.json',
        'tokenizer_config.json',
        'config.json',
        'special_tokens_map.json'
      ])
      expect(resolved.files.every((file) => file.target.revision.length === 40))
        .toBe(true)
    }

    const root = await mkdtemp(join(tmpdir(), 'embedding-catalog-'))
    roots.push(root)
    const snapshot = await new EmbeddingModelManager({
      userDataDirectory: root
    }).getSnapshot()
    expect(snapshot.catalog[0]!.downloadAvailability).toEqual([
      expect.objectContaining({ available: true }),
      expect.objectContaining({ available: true })
    ])
  })

  it('downloads, verifies, and atomically publishes a package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'embedding-download-'))
    roots.push(root)
    const contents: Record<string, string> = {
      'model.onnx': 'model',
      'tokenizer.json': 'tokenizer',
      'tokenizer_config.json': 'tokenizer config',
      'config.json': 'model config',
      LICENSE: 'license'
    }
    const requests: string[] = []
    const manager = new EmbeddingModelManager({
      userDataDirectory: root,
      catalog: testCatalog(contents),
      fetch: async (input) => {
        const url = input.toString()
        requests.push(url)
        const name = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!)
        const body = contents[name]
        if (body === undefined) {
          return new Response(null, { status: 404 })
        }
        return new Response(body, {
          headers: { 'content-length': String(Buffer.byteLength(body)) }
        })
      }
    })

    const installed = await manager.install(
      'complete-test-model',
      'modelscope'
    )
    expect(installed).toMatchObject({
      source: 'download',
      files: expect.arrayContaining([
        expect.objectContaining({ name: 'model.onnx' }),
        expect.objectContaining({ name: 'tokenizer.json' })
      ])
    })
    expect(requests).toHaveLength(5)
    expect(await manager.getVerifiedModelDirectory('complete-test-model'))
      .toBe(join(manager.rootDirectory, 'complete-test-model'))
    expect(
      await readFile(
        join(manager.rootDirectory, 'complete-test-model', 'config.json'),
        'utf8'
      )
    ).toBe(contents['config.json'])
    expect(
      (
        await readdir(manager.rootDirectory)
      ).some((name) => name.startsWith('.install-'))
    ).toBe(false)
  })

  it('installs a complete local package and exposes only a verified Main path', async () => {
    const { manager, source } = await fixture()
    const installed = await manager.registerLocalDirectory(
      'complete-test-model',
      source
    )
    expect(installed.files).toHaveLength(5)

    const snapshot = await manager.getSnapshot()
    expect(snapshot).not.toHaveProperty('rootDirectory')
    expect(JSON.stringify(snapshot)).not.toContain(manager.rootDirectory)
    expect(snapshot.catalog[0]).not.toHaveProperty('repositoryUrls')
    expect(snapshot.catalog[0]!.files[0]).not.toHaveProperty('targets')
    expect(snapshot.installed).toHaveLength(1)

    const trusted = await manager.getVerifiedModelDirectory(
      'complete-test-model'
    )
    expect(trusted).toBe(
      join(manager.rootDirectory, 'complete-test-model')
    )
    expect(await manager.getStatus('complete-test-model')).toMatchObject({
      catalogAvailable: true,
      installed: true,
      verified: true
    })
  })

  it('imports and atomically publishes a verified embedding ZIP', async () => {
    const { manager, root, contents } = await fixture()
    const archive = join(root, 'embedding.zip')
    await writeFile(archive, embeddingArchive(contents))

    await expect(
      manager.importArchive('complete-test-model', archive)
    ).resolves.toMatchObject({
      id: 'complete-test-model',
      source: 'local',
      files: expect.arrayContaining([
        expect.objectContaining({ name: 'model.onnx' }),
        expect.objectContaining({ name: 'tokenizer.json' })
      ])
    })

    const directory = await manager.getVerifiedModelDirectory(
      'complete-test-model'
    )
    expect(await readdir(directory)).toHaveLength(6)
    await expect(
      readFile(join(directory, 'goodbuddy-model.json'))
    ).rejects.toThrow()
    expect(
      (await readdir(manager.rootDirectory)).some((name) =>
        name.startsWith('.install-')
      )
    ).toBe(false)
  })

  it('rejects mismatched ZIP descriptors and hashes without publishing', async () => {
    const { manager, root, contents } = await fixture()
    const wrongKind = join(root, 'wrong-kind.zip')
    const wrongHash = join(root, 'wrong-hash.zip')
    await Promise.all([
      writeFile(
        wrongKind,
        embeddingArchive(contents, { kind: 'speech' })
      ),
      writeFile(
        wrongHash,
        embeddingArchive(contents, {
          hashOverrides: { 'model.onnx': 'a'.repeat(64) }
        })
      )
    ])

    await expect(
      manager.importArchive('complete-test-model', wrongKind)
    ).rejects.toThrow(/类型或模型 ID 不匹配/u)
    await expect(
      manager.importArchive('complete-test-model', wrongHash)
    ).rejects.toThrow(/校验失败/u)
    expect((await manager.getSnapshot()).installed).toEqual([])
    expect(
      (await readdir(manager.rootDirectory)).some((name) =>
        name.startsWith('.install-')
      )
    ).toBe(false)
  })

  it('rejects undeclared ZIP entries and preserves an installed model', async () => {
    const { manager, source, root, contents } = await fixture()
    await manager.registerLocalDirectory('complete-test-model', source)
    const directory = await manager.getVerifiedModelDirectory(
      'complete-test-model'
    )
    const archive = join(root, 'unsafe.zip')
    await writeFile(
      archive,
      embeddingArchive(contents, {
        extraEntries: {
          '../outside.exe': Buffer.from('unsafe')
        }
      })
    )

    await expect(
      manager.importArchive('complete-test-model', archive)
    ).rejects.toThrow(/已安装/u)
    await expect(
      manager.getVerifiedModelDirectory('complete-test-model')
    ).resolves.toBe(directory)
    await expect(
      readFile(join(directory, 'model.onnx'), 'utf8')
    ).resolves.toBe(contents['model.onnx'])
  })

  it('honors an already-aborted ZIP import and cleans staging', async () => {
    const { manager, root, contents } = await fixture()
    const archive = join(root, 'embedding.zip')
    await writeFile(archive, embeddingArchive(contents))
    const controller = new AbortController()
    controller.abort()

    await expect(
      manager.importArchive(
        'complete-test-model',
        archive,
        controller.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(manager.getProgressSnapshot().operations).toEqual([])
    expect(
      (await readdir(manager.rootDirectory)).some((name) =>
        name.startsWith('.install-')
      )
    ).toBe(false)
  })

  it('rejects wrong hashes and leaves no installed model', async () => {
    const { manager, source } = await fixture()
    await writeFile(join(source, 'model.onnx'), 'tampered')
    await expect(
      manager.registerLocalDirectory('complete-test-model', source)
    ).rejects.toThrow(/校验失败/u)
    expect((await manager.getSnapshot()).installed).toEqual([])
  })

  it('re-verifies installed bytes before returning the trusted directory', async () => {
    const { manager, source } = await fixture()
    await manager.registerLocalDirectory('complete-test-model', source)
    const directory = join(
      manager.rootDirectory,
      'complete-test-model'
    )
    await writeFile(join(directory, 'tokenizer.json'), 'tampered')
    await expect(
      manager.getVerifiedModelDirectory('complete-test-model')
    ).rejects.toThrow(/校验失败/u)
    expect(await manager.getStatus('complete-test-model')).toMatchObject({
      installed: true,
      verified: false
    })
  })

  it('rejects source symlinks', async () => {
    const { manager, source, root } = await fixture()
    const linked = join(root, 'linked')
    await symlink(source, linked, 'junction')
    await expect(
      manager.registerLocalDirectory('complete-test-model', linked)
    ).rejects.toThrow(/普通目录/u)
  })

  it('honors an already-aborted local import signal', async () => {
    const { manager, source } = await fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(
      manager.registerLocalDirectory(
        'complete-test-model',
        source,
        controller.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(manager.getProgressSnapshot().operations).toEqual([])
  })

  it('does not trust a modified manifest', async () => {
    const { manager, source } = await fixture()
    await manager.registerLocalDirectory('complete-test-model', source)
    const manifestPath = join(
      manager.rootDirectory,
      'complete-test-model',
      'manifest.json'
    )
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      id: string
    }
    manifest.id = 'other-model'
    await writeFile(manifestPath, JSON.stringify(manifest))
    await expect(
      manager.getVerifiedModelDirectory('complete-test-model')
    ).rejects.toThrow()
  })
})
