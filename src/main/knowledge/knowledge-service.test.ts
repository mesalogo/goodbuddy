import {
  access,
  mkdtemp,
  mkdir,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeService } from './knowledge-service'
import type { EmbeddingProvider } from './types'
import { UrlImporter } from './url-importer'

const temporaryDirectories: string[] = []
const services: KnowledgeService[] = []

async function createService(
  urlImporter?: UrlImporter,
  embeddingProvider?: EmbeddingProvider
): Promise<{ directory: string; service: KnowledgeService }> {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-knowledge-service-'))
  temporaryDirectories.push(directory)
  const service = new KnowledgeService({
    databasePath: join(directory, 'knowledge.sqlite'),
    managedRoot: join(directory, 'managed'),
    urlImporter,
    embeddingProvider
  })
  await service.initialize()
  services.push(service)
  return { directory, service }
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('KnowledgeService', () => {
  it('indexes referenced files and returns cited search results', async () => {
    const { directory, service } = await createService()
    const sourcePath = join(directory, '产品说明.md')
    await writeFile(sourcePath, '# GoodBuddy\n跨平台桌面智能助手', 'utf8')
    const library = service.createLibrary({
      name: '产品知识',
      storageMode: 'reference',
      graphEnabled: false,
      graphStrategy: 'rules'
    })

    await service.importPaths(library.id, [sourcePath])
    const snapshot = service.snapshot(library.id)
    const results = service.search(library.id, '跨平台桌面')

    expect(snapshot.sources).toHaveLength(1)
    expect(snapshot.documents).toHaveLength(1)
    expect(snapshot.documents[0]?.status).toBe('ready')
    expect(results[0]?.document.title).toBe('产品说明')
    expect(results[0]?.source.location).toBe(sourcePath)
    await service.dispose()
  })

  it('copies managed directories and never deletes the original source', async () => {
    const { directory, service } = await createService()
    const original = join(directory, 'original')
    await mkdir(original)
    await writeFile(join(original, 'notes.txt'), '托管目录知识', 'utf8')
    const library = service.createLibrary({
      name: '托管知识',
      storageMode: 'managed',
      graphEnabled: false,
      graphStrategy: 'rules'
    })

    await service.importPaths(library.id, [original])
    const [source] = service.snapshot(library.id).sources
    expect(source?.location).not.toBe(original)
    if (!source) {
      throw new Error('Managed source was not created')
    }
    await access(join(source.location, 'notes.txt'))

    await service.removeSource(source.id)
    await access(join(original, 'notes.txt'))
    await expect(access(source.location)).rejects.toThrow()
    await service.dispose()
  })

  it('imports safe URLs through the validated importer', async () => {
    const importer = new UrlImporter({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async () => ({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: Buffer.from(
          '<html><title>帮助中心</title><main>安装与配置说明</main></html>'
        )
      })
    })
    const { service } = await createService(importer)
    const library = service.createLibrary({
      name: '网页知识',
      storageMode: 'managed',
      graphEnabled: false,
      graphStrategy: 'rules'
    })

    await service.importUrl(
      library.id,
      'https://example.com/help',
      new AbortController().signal
    )

    expect(service.snapshot(library.id).sources[0]).toMatchObject({
      type: 'url',
      status: 'ready',
      displayName: '帮助中心'
    })
    expect(service.search(library.id, '安装配置')).not.toHaveLength(0)
    await service.dispose()
  })

  it('extracts an optional local rule graph with evidence', async () => {
    const { directory, service } = await createService()
    const sourcePath = join(directory, 'architecture.md')
    await writeFile(
      sourcePath,
      'GoodBuddy（产品）依赖 Electron（框架）。',
      'utf8'
    )
    const library = service.createLibrary({
      name: '架构图谱',
      storageMode: 'reference',
      graphEnabled: true,
      graphStrategy: 'rules'
    })

    await service.importPaths(library.id, [sourcePath])
    const snapshot = service.snapshot(library.id)

    expect(snapshot.entities.length).toBeGreaterThan(0)
    expect(snapshot.evidence.length).toBeGreaterThan(0)
    await service.dispose()
  })

  it('indexes optional embeddings and performs vector-backed hybrid search', async () => {
    const provider: EmbeddingProvider = {
      provider: 'test-provider',
      model: 'test-model',
      embed: async (input) =>
        input.map((text) =>
          text.includes('orbital') || text === 'related meaning'
            ? [1, 0]
            : [0, 1]
        )
    }
    const { directory, service } = await createService(undefined, provider)
    const sourcePath = join(directory, 'vectors.txt')
    await writeFile(sourcePath, 'orbital telescope notes', 'utf8')
    const library = service.createLibrary({
      name: 'Vector knowledge',
      storageMode: 'reference',
      graphEnabled: false
    })

    await service.importPaths(library.id, [sourcePath])
    const document = service.snapshot(library.id).documents[0]
    if (!document) {
      throw new Error('Indexed document missing')
    }
    expect(
      service.database.getEmbeddingIndexState(
        document.id,
        provider.provider,
        provider.model
      )
    ).toMatchObject({ status: 'ready', dimensions: 2 })

    const results = await service.searchHybrid(
      library.id,
      'related meaning'
    )
    expect(results[0]?.document.id).toBe(document.id)
    expect(results[0]?.retrieval.channels).toContain('vector')
  })

  it('keeps FTS available and records diagnostics when embeddings fail', async () => {
    const provider: EmbeddingProvider = {
      provider: 'failing-provider',
      model: 'failing-model',
      embed: async () => {
        throw Object.assign(
          new Error('Bearer sk-private failed with private payload'),
          { status: 503 }
        )
      }
    }
    const { directory, service } = await createService(undefined, provider)
    const sourcePath = join(directory, 'fallback.txt')
    await writeFile(sourcePath, 'lexical fallback remains searchable', 'utf8')
    const library = service.createLibrary({
      name: 'Fallback knowledge',
      storageMode: 'reference',
      graphEnabled: false
    })

    await service.importPaths(library.id, [sourcePath])
    const document = service.snapshot(library.id).documents[0]
    if (!document) {
      throw new Error('Indexed document missing')
    }
    expect(document.status).toBe('ready')
    expect(service.snapshot(library.id).sources[0]?.status).toBe('ready')
    expect(service.search(library.id, 'fallback')).toHaveLength(1)
    expect(
      service.database.getEmbeddingIndexState(
        document.id,
        provider.provider,
        provider.model
      )
    ).toMatchObject({
      status: 'error',
      lastError: '向量服务暂时不可用。'
    })
    expect(
      JSON.stringify(
        service.database.getEmbeddingIndexState(
          document.id,
          provider.provider,
          provider.model
        )
      )
    ).not.toContain('sk-private')
    const results = await service.searchHybrid(library.id, 'fallback')
    expect(results[0]?.retrieval.channels).toContain('fts')
  })

  it('defers existing-document rebuilds when an embedding provider is enabled', async () => {
    const { directory, service } = await createService()
    const sourcePath = join(directory, 'existing.txt')
    await writeFile(sourcePath, 'existing semantic content', 'utf8')
    const library = service.createLibrary({
      name: 'Existing knowledge',
      storageMode: 'reference',
      graphEnabled: false
    })
    await service.importPaths(library.id, [sourcePath])
    const document = service.snapshot(library.id).documents[0]!
    const provider: EmbeddingProvider = {
      provider: 'late-provider',
      model: 'late-model',
      embed: async (input) => input.map(() => [0.5, 0.5])
    }

    await service.setEmbeddingProvider(provider)

    expect(
      service.database.getEmbeddingIndexState(
        document.id,
        provider.provider,
        provider.model
      )
    ).toBeUndefined()
  })

  it('embeds a hybrid query once across multiple libraries', async () => {
    const embed = vi.fn<EmbeddingProvider['embed']>(
      async (input) => input.map(() => [1, 0])
    )
    const provider: EmbeddingProvider = {
      provider: 'shared-query-provider',
      model: 'shared-query-model',
      embed
    }
    const { directory, service } = await createService(undefined, provider)
    const libraryIds: string[] = []
    for (const index of [1, 2]) {
      const sourcePath = join(directory, `library-${index}.txt`)
      await writeFile(sourcePath, `shared topic ${index}`, 'utf8')
      const library = service.createLibrary({
        name: `Library ${index}`,
        storageMode: 'reference',
        graphEnabled: false
      })
      libraryIds.push(library.id)
      await service.importPaths(library.id, [sourcePath])
    }
    embed.mockClear()

    const results = await service.searchHybridMany(
      libraryIds,
      'shared topic'
    )

    expect(embed).toHaveBeenCalledOnce()
    expect(results).toHaveLength(2)
  })
})
