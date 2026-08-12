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
import type { ExtractStructured } from './graph-extractor'
import { embeddingStorageProvider } from './embedding-provider-key'
import { KnowledgeService } from './knowledge-service'
import type { EmbeddingProvider, RerankProvider } from './types'
import { UrlImporter } from './url-importer'

const temporaryDirectories: string[] = []
const services: KnowledgeService[] = []

async function createService(
  urlImporter?: UrlImporter,
  embeddingProvider?: EmbeddingProvider,
  extractStructured?: ExtractStructured,
  rerankProvider?: RerankProvider
): Promise<{ directory: string; service: KnowledgeService }> {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-knowledge-service-'))
  temporaryDirectories.push(directory)
  const service = new KnowledgeService({
    databasePath: join(directory, 'knowledge.sqlite'),
    managedRoot: join(directory, 'managed'),
    urlImporter,
    embeddingProvider,
    extractStructured,
    rerankProvider
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
  it('rebuilds vectors only for the selected knowledge base', async () => {
    const embed = vi.fn(async (input: readonly string[]) =>
      input.map(() => [1, 0])
    )
    const provider: EmbeddingProvider = {
      provider: 'openai-compatible',
      model: 'embed-v1',
      fingerprint: 'openai-compatible:https://safe.invalid:embed-v1',
      embed
    }
    const { directory, service } = await createService(
      undefined,
      provider
    )
    const firstPath = join(directory, 'first.md')
    const secondPath = join(directory, 'second.md')
    await writeFile(firstPath, 'first vector document', 'utf8')
    await writeFile(secondPath, 'second vector document', 'utf8')
    const first = service.createLibrary({
      name: 'First vector library',
      storageMode: 'reference',
      graphEnabled: false
    })
    const second = service.createLibrary({
      name: 'Second vector library',
      storageMode: 'reference',
      graphEnabled: false
    })
    await service.importPaths(first.id, [firstPath])
    await service.importPaths(second.id, [secondPath])
    const firstDocument = service.snapshot(first.id).documents[0]!
    const secondDocument = service.snapshot(second.id).documents[0]!
    service.database.upsertDocument(
      {
        id: firstDocument.id,
        knowledgeBaseId: first.id,
        sourceId: firstDocument.sourceId,
        externalId: firstDocument.externalId,
        title: firstDocument.title,
        mimeType: firstDocument.mimeType,
        metadata: firstDocument.metadata
      },
      [{ ordinal: 0, content: 'first changed content' }]
    )
    service.database.upsertDocument(
      {
        id: secondDocument.id,
        knowledgeBaseId: second.id,
        sourceId: secondDocument.sourceId,
        externalId: secondDocument.externalId,
        title: secondDocument.title,
        mimeType: secondDocument.mimeType,
        metadata: secondDocument.metadata
      },
      [{ ordinal: 0, content: 'second changed content' }]
    )
    embed.mockClear()

    const started = await service.rebuildEmbeddingIndex(first.id, {
      provider: provider.provider,
      model: provider.model,
      credentialConfigured: false
    })
    expect(started.knowledgeBaseId).toBe(first.id)
    await vi.waitFor(async () => {
      const status = await service.getEmbeddingIndexSnapshot(first.id, {
        provider: provider.provider,
        model: provider.model,
        credentialConfigured: false
      })
      expect(status.indexStatus.job?.status).toBe('completed')
    })

    expect(embed).toHaveBeenCalledTimes(1)
    expect(
      service.database.getEmbeddingIndexState(
        firstDocument.id,
        embeddingStorageProvider(provider),
        provider.model
      )
    ).toMatchObject({ status: 'ready' })
    expect(
      service.database.getEmbeddingIndexState(
        secondDocument.id,
        embeddingStorageProvider(provider),
        provider.model
      )
    ).toBeUndefined()
    expect(
      (
        await service.getEmbeddingIndexSnapshot(second.id, {
          provider: provider.provider,
          model: provider.model,
          credentialConfigured: false
        })
      ).indexStatus.job
    ).toBeNull()
  })

  it('cancels a vector rebuild only for its matching library job', async () => {
    let receivedSignal: AbortSignal | undefined
    const provider: EmbeddingProvider = {
      provider: 'openai-compatible',
      model: 'embed-v1',
      embed: (_input, signal) =>
        new Promise<number[][]>((_resolve, reject) => {
          receivedSignal = signal
          signal?.addEventListener(
            'abort',
            () => reject(signal.reason),
            { once: true }
          )
        })
    }
    const { directory, service } = await createService()
    const sourcePath = join(directory, 'cancel-vector.md')
    await writeFile(sourcePath, 'cancel this vector rebuild', 'utf8')
    const library = service.createLibrary({
      name: 'Cancellable vector library',
      storageMode: 'reference',
      graphEnabled: false
    })
    const other = service.createLibrary({
      name: 'Other vector library',
      storageMode: 'reference',
      graphEnabled: false
    })
    await service.importPaths(library.id, [sourcePath])
    await service.setEmbeddingProvider(provider)

    const started = await service.rebuildEmbeddingIndex(library.id, {
      provider: provider.provider,
      model: provider.model,
      credentialConfigured: false
    })
    const jobId = started.indexStatus.job?.id
    expect(jobId).toBeDefined()
    await vi.waitFor(() => {
      expect(receivedSignal).toBeDefined()
    })

    expect(
      await service.cancelEmbeddingIndex(other.id, jobId!)
    ).toBe(false)
    expect(
      await service.cancelEmbeddingIndex(library.id, jobId!)
    ).toBe(true)
    await vi.waitFor(async () => {
      const status = await service.getEmbeddingIndexSnapshot(library.id, {
        provider: provider.provider,
        model: provider.model,
        credentialConfigured: false
      })
      expect(status.indexStatus.job?.status).toBe('cancelled')
    })
    expect(receivedSignal?.aborted).toBe(true)
  })

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

  it('uses chunking changes made while an empty library first imports', async () => {
    let notifyParserStarted: (() => void) | undefined
    const parserStarted = new Promise<void>((resolve) => {
      notifyParserStarted = resolve
    })
    let releaseParser: (() => void) | undefined
    const parserReleased = new Promise<void>((resolve) => {
      releaseParser = resolve
    })
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-knowledge-service-')
    )
    temporaryDirectories.push(directory)
    const service = new KnowledgeService({
      databasePath: join(directory, 'knowledge.sqlite'),
      managedRoot: join(directory, 'managed'),
      parseDocument: async (name) => {
        notifyParserStarted?.()
        await parserReleased
        return {
          title: name,
          content: '# Contextual\nfirst import content',
          sourceFormat: 'text',
          sections: [{
            locator: '全文',
            content: '# Contextual\nfirst import content'
          }],
          warnings: []
        }
      }
    })
    await service.initialize()
    services.push(service)
    const sourcePath = join(directory, 'contextual.md')
    await writeFile(sourcePath, '# Contextual\nfirst import content', 'utf8')
    const library = service.createLibrary({
      name: 'Contextual knowledge',
      storageMode: 'reference',
      graphEnabled: false
    })

    const importing = service.importPaths(library.id, [sourcePath])
    await parserStarted
    const updated = service.updateSettings({
      knowledgeBaseId: library.id,
      chunking: {
        ...library.chunkingSettings,
        contextualIndexingEnabled: true
      }
    })

    expect(updated.chunkingRebuildRequired).toBe(false)

    releaseParser?.()
    await importing

    const snapshot = service.snapshot(library.id)
    const document = snapshot.documents[0]
    expect(snapshot.libraries[0]?.chunkingRebuildRequired).toBe(false)
    expect(document).toBeDefined()
    expect(
      service.database.getEmbeddingIndexDocument(document!.id)?.items[0]
        ?.content
    ).toContain('[context ')
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
    expect(snapshot.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'parsing',
          status: 'succeeded',
          progress: 100
        }),
        expect.objectContaining({
          kind: 'embedding',
          status: 'skipped',
          progress: 100
        }),
        expect.objectContaining({
          kind: 'graph',
          status: 'succeeded',
          progress: 100
        })
      ])
    )
    await service.dispose()
  })

  it('reextracts graph evidence and removes only stale generated entities', async () => {
    const { directory, service } = await createService()
    const sourcePath = join(directory, 'reextract.md')
    await writeFile(
      sourcePath,
      'GoodBuddy（产品）依赖 Electron（框架）。',
      'utf8'
    )
    const library = service.createLibrary({
      name: '重新抽取',
      storageMode: 'reference',
      graphEnabled: true,
      graphStrategy: 'rules'
    })
    await service.importPaths(library.id, [sourcePath])
    const stale = service.database.createEntity({
      knowledgeBaseId: library.id,
      name: '过期实体',
      type: '概念',
      locked: false
    })
    const manual = service.database.createEntity({
      knowledgeBaseId: library.id,
      name: '人工实体',
      type: '概念',
      locked: true
    })

    await service.reextractGraph(library.id)

    const snapshot = service.snapshot(library.id)
    expect(snapshot.evidence.length).toBeGreaterThan(0)
    expect(service.database.getEntity(stale.id)).toBeUndefined()
    expect(service.database.getEntity(manual.id)).toBeDefined()
  })

  it('prunes generated graph records after chunk evidence is removed', async () => {
    const { directory, service } = await createService()
    const sourcePath = join(directory, 'chunk-graph.md')
    await writeFile(sourcePath, '# Disposable Entity', 'utf8')
    const library = service.createLibrary({
      name: 'Chunk graph cleanup',
      storageMode: 'reference',
      graphEnabled: true,
      graphStrategy: 'rules'
    })
    await service.importPaths(library.id, [sourcePath])
    const snapshot = service.snapshot(library.id)
    const document = snapshot.documents[0]!
    const generatedEntity = snapshot.entities.find(
      (entity) => entity.name === 'Disposable Entity'
    )!
    const evidence = snapshot.evidence.find(
      (item) => item.entityId === generatedEntity.id
    )!

    await service.updateChunk({
      knowledgeBaseId: library.id,
      documentId: document.id,
      chunkId: evidence.chunkId!,
      content: 'Replacement text without graph evidence'
    })

    expect(service.database.getEntity(generatedEntity.id)).toBeUndefined()
    expect(service.snapshot(library.id).evidence).toEqual([])
  })

  it('keeps a committed chunk edit successful when graph refresh fails', async () => {
    const extractStructured = vi.fn(async () => {
      throw new Error('synthetic edit graph failure')
    })
    const { directory, service } = await createService(
      undefined,
      undefined,
      extractStructured
    )
    const sourcePath = join(directory, 'edit-graph-failure.md')
    await writeFile(sourcePath, 'initial edit content', 'utf8')
    const library = service.createLibrary({
      name: 'Edit graph failure',
      storageMode: 'reference',
      graphEnabled: false,
      graphStrategy: 'model'
    })
    await service.importPaths(library.id, [sourcePath])
    service.database.updateKnowledgeBase(library.id, { graphEnabled: true })
    const document = service.snapshot(library.id).documents[0]!
    const chunk = service.database
      .listChunks(document.id)
      .find((candidate) => candidate.role !== 'parent')!

    await expect(service.updateChunk({
      knowledgeBaseId: library.id,
      documentId: document.id,
      chunkId: chunk.id,
      content: 'committed edit survives graph failure'
    })).resolves.toMatchObject({
      content: 'committed edit survives graph failure'
    })
    await vi.waitFor(() => expect(extractStructured).toHaveBeenCalled())
    expect(service.search(library.id, 'committed')).toHaveLength(1)
  })

  it('coalesces edit graph refreshes so stale extraction cannot publish last', async () => {
    const resolvers: Array<(value: {
      entities: unknown[]
      relations: unknown[]
    }) => void> = []
    const extractStructured: ExtractStructured = () =>
      new Promise((resolve) => {
        resolvers.push(resolve)
      })
    const { directory, service } = await createService(
      undefined,
      undefined,
      extractStructured
    )
    const sourcePath = join(directory, 'coalesced-edit-graph.md')
    await writeFile(sourcePath, 'initial graph content', 'utf8')
    const library = service.createLibrary({
      name: 'Coalesced edit graph',
      storageMode: 'reference',
      graphEnabled: false,
      graphStrategy: 'model'
    })
    await service.importPaths(library.id, [sourcePath])
    service.database.updateKnowledgeBase(library.id, { graphEnabled: true })
    const document = service.snapshot(library.id).documents[0]!
    const chunk = service.database
      .listChunks(document.id)
      .find((candidate) => candidate.role !== 'parent')!

    await service.updateChunk({
      knowledgeBaseId: library.id,
      documentId: document.id,
      chunkId: chunk.id,
      content: 'first graph edit'
    })
    await vi.waitFor(() => expect(resolvers).toHaveLength(1))
    await service.updateChunk({
      knowledgeBaseId: library.id,
      documentId: document.id,
      chunkId: chunk.id,
      content: 'second graph edit'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(resolvers).toHaveLength(1)

    resolvers.shift()?.({ entities: [], relations: [] })
    await vi.waitFor(() => expect(resolvers).toHaveLength(1))
    resolvers.shift()?.({ entities: [], relations: [] })
    await vi.waitFor(() => {
      expect(
        service.snapshot(library.id).tasks.filter(
          (task) => task.kind === 'graph' && task.status === 'succeeded'
        )
      ).toHaveLength(1)
    })
    expect(service.database.listChunks(document.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: 'second graph edit' })
      ])
    )
  })

  it('fails hybrid reextraction when model extraction fails', async () => {
    const extractStructured = vi.fn(async () => {
      throw new Error('模型未返回图谱内容')
    })
    const { directory, service } = await createService(
      undefined,
      undefined,
      extractStructured
    )
    const sourcePath = join(directory, 'hybrid-fallback.md')
    await writeFile(sourcePath, '# 本地实体', 'utf8')
    const library = service.createLibrary({
      name: '混合抽取',
      storageMode: 'reference',
      graphEnabled: false,
      graphStrategy: 'hybrid'
    })
    await service.importPaths(library.id, [sourcePath])
    service.database.updateKnowledgeBase(library.id, {
      graphEnabled: true
    })

    await expect(service.reextractGraph(library.id)).rejects.toThrow(
      '模型未返回图谱内容'
    )
    expect(service.snapshot(library.id).entities).toHaveLength(0)
    expect(service.snapshot(library.id).tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'graph',
          status: 'failed',
          message: '模型未返回图谱内容'
        })
      ])
    )
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

  it('does not serve vectors from a different provider fingerprint', async () => {
    const firstProvider: EmbeddingProvider = {
      provider: 'openai-compatible',
      model: 'same-model',
      fingerprint: 'openai-compatible:https://one.invalid:same-model',
      embed: async (input) => input.map(() => [1, 0])
    }
    const { directory, service } = await createService(
      undefined,
      firstProvider
    )
    const sourcePath = join(directory, 'fingerprint.txt')
    await writeFile(sourcePath, 'fingerprint compatibility', 'utf8')
    const library = service.createLibrary({
      name: 'Fingerprint knowledge',
      storageMode: 'reference',
      graphEnabled: false
    })
    await service.importPaths(library.id, [sourcePath])
    const document = service.snapshot(library.id).documents[0]!

    expect(
      service.database.getEmbeddingIndexState(
        document.id,
        embeddingStorageProvider(firstProvider),
        firstProvider.model
      )
    ).toMatchObject({ status: 'ready' })
    expect(
      service.database.getEmbeddingIndexState(
        document.id,
        firstProvider.provider,
        firstProvider.model
      )
    ).toBeUndefined()
    const firstResponse = await service.retrieve({
      knowledgeBaseId: library.id,
      query: 'semantically related',
      settings: {
        ...library.retrievalSettings,
        ftsWeight: 0,
        vectorWeight: 1,
        graphWeight: 0,
        minimumVectorSimilarity: 0
      }
    })
    expect(firstResponse.diagnostics.vectorScannedCount).toBe(1)
    expect(firstResponse.results[0]?.channels).toContain('vector')

    const secondProvider: EmbeddingProvider = {
      ...firstProvider,
      fingerprint:
        'openai-compatible:https://two.invalid:same-model'
    }
    await service.setEmbeddingProvider(secondProvider)
    const response = await service.retrieve({
      knowledgeBaseId: library.id,
      query: 'fingerprint'
    })

    expect(response.diagnostics.vectorScannedCount).toBe(0)
    expect(response.diagnostics.degradedChannels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'vector',
          reason: '当前向量模型没有可用的兼容索引。'
        })
      ])
    )
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

  it('bounds long indexing failures so task persistence does not mask them', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-knowledge-service-')
    )
    temporaryDirectories.push(directory)
    const service = new KnowledgeService({
      databasePath: join(directory, 'knowledge.sqlite'),
      managedRoot: join(directory, 'managed'),
      parseDocument: async () => {
        throw new Error('x'.repeat(2_000))
      }
    })
    await service.initialize()
    services.push(service)
    const sourcePath = join(directory, 'failure.txt')
    await writeFile(sourcePath, 'failure source', 'utf8')
    const library = service.createLibrary({
      name: 'Bounded task errors',
      storageMode: 'reference',
      graphEnabled: false
    })

    await expect(
      service.importPaths(library.id, [sourcePath])
    ).rejects.toThrow()
    const failedTasks = service
      .snapshot(library.id)
      .tasks.filter((task) => task.status === 'failed')
    expect(failedTasks.length).toBeGreaterThan(0)
    expect(
      failedTasks.every(
        (task) =>
          (task.message?.length ?? 0) <= 1_000 &&
          (task.error?.message.length ?? 0) <= 1_000
      )
    ).toBe(true)
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

  it('embeds a retrieval query once across multiple libraries', async () => {
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

    const results = await service.retrieveMany(
      libraryIds,
      'shared topic'
    )

    expect(embed).toHaveBeenCalledOnce()
    expect(results).toHaveLength(2)
    expect(
      results.every((item) => item.response.results.length > 0)
    ).toBe(true)
  })

  it('reranks multiple libraries concurrently while preserving input order', async () => {
    let releaseReranks: (() => void) | undefined
    let startedReranks = 0
    const allStarted = new Promise<void>((resolve) => {
      releaseReranks = resolve
    })
    const rerank = vi.fn<RerankProvider['rerank']>(
      async (_query, _documents, _topN, signal) => {
        startedReranks += 1
        if (startedReranks === 2) {
          releaseReranks?.()
        }
        await allStarted
        signal?.throwIfAborted()
        return [{ index: 0, relevanceScore: 0.9 }]
      }
    )
    const rerankProvider: RerankProvider = {
      provider: 'concurrency-test',
      model: 'concurrency-test-model',
      rerank
    }
    const { directory, service } = await createService(
      undefined,
      undefined,
      undefined,
      rerankProvider
    )
    const libraryIds: string[] = []
    for (const index of [1, 2]) {
      const sourcePath = join(directory, `rerank-library-${index}.txt`)
      await writeFile(sourcePath, `shared rerank topic ${index}`, 'utf8')
      const library = service.createLibrary({
        name: `Rerank library ${index}`,
        storageMode: 'reference',
        graphEnabled: false
      })
      libraryIds.push(library.id)
      await service.importPaths(library.id, [sourcePath])
      service.updateSettings({
        knowledgeBaseId: library.id,
        retrieval: {
          ...library.retrievalSettings,
          vectorWeight: 0,
          graphWeight: 0,
          rerankMode: 'learned',
          localRerankEnabled: true
        }
      })
    }

    const results = await service.retrieveMany(
      libraryIds,
      'shared rerank topic'
    )

    expect(rerank).toHaveBeenCalledTimes(2)
    expect(results.map((item) => item.knowledgeBaseId)).toEqual(libraryIds)
  })

  it('applies learned reranking with bounded candidates and score diagnostics', async () => {
    const { directory, service } = await createService()
    const sourcePath = join(directory, 'learned-rerank.txt')
    await writeFile(
      sourcePath,
      [
        'shared keyword first candidate',
        '',
        'shared keyword preferred candidate'
      ].join('\n'),
      'utf8'
    )
    const library = service.createLibrary({
      name: 'Learned rerank',
      storageMode: 'reference',
      graphEnabled: false
    })
    await service.importPaths(library.id, [sourcePath])
    const original = service.snapshot(library.id).documents[0]!
    service.database.upsertDocument(
      {
        ...original,
        title: original.title
      },
      [
        { id: 'rerank-first', ordinal: 0, content: 'shared keyword first' },
        {
          id: 'rerank-preferred',
          ordinal: 1,
          content: 'shared keyword preferred'
        }
      ]
    )
    const rerank = vi.fn<RerankProvider['rerank']>(
      async (_query, documents, topN) => {
        expect(documents).toHaveLength(2)
        expect(topN).toBe(2)
        return [
          { index: 1, relevanceScore: 0.95 },
          { index: 0, relevanceScore: 0.2 }
        ]
      }
    )
    await service.setRerankProvider({
      provider: 'cohere-compatible',
      model: 'rerank-test',
      rerank
    })
    const response = await service.retrieve({
      knowledgeBaseId: library.id,
      query: 'shared keyword',
      settings: {
        ...library.retrievalSettings,
        topK: 2,
        candidateMultiplier: 2,
        vectorWeight: 0,
        graphWeight: 0,
        rerankMode: 'learned',
        localRerankEnabled: true
      }
    })

    expect(rerank).toHaveBeenCalledOnce()
    expect(response.results.map((result) => result.chunkId)).toEqual([
      'rerank-preferred',
      'rerank-first'
    ])
    expect(response.results[0]).toMatchObject({
      preRerankRank: 2,
      relevance: 0.95,
      scores: { rerankScore: 0.95 }
    })
    expect(response.diagnostics.rerank).toMatchObject({
      requested: 'learned',
      used: 'learned',
      status: 'applied',
      candidateCount: 2,
      model: 'rerank-test'
    })
  })

  it('falls back locally on learned rerank failure and propagates cancellation', async () => {
    const { directory, service } = await createService()
    const sourcePath = join(directory, 'rerank-fallback.txt')
    await writeFile(sourcePath, 'fallback keyword content', 'utf8')
    const library = service.createLibrary({
      name: 'Rerank fallback',
      storageMode: 'reference',
      graphEnabled: false
    })
    await service.importPaths(library.id, [sourcePath])
    await service.setRerankProvider({
      provider: 'cohere-compatible',
      model: 'rerank-test',
      rerank: async () => {
        throw Object.assign(new Error('private provider response'), {
          status: 503
        })
      }
    })

    const fallback = await service.retrieve({
      knowledgeBaseId: library.id,
      query: 'fallback keyword',
      settings: {
        ...library.retrievalSettings,
        vectorWeight: 0,
        graphWeight: 0,
        rerankMode: 'learned',
        localRerankEnabled: true
      }
    })
    expect(fallback.results).toHaveLength(1)
    expect(fallback.diagnostics.rerank).toMatchObject({
      requested: 'learned',
      used: 'local',
      status: 'fallback',
      reason: '重排服务暂时不可用。'
    })

    const controller = new AbortController()
    await service.setRerankProvider({
      provider: 'cohere-compatible',
      model: 'rerank-test',
      rerank: async (_query, _documents, _topN, signal) => {
        controller.abort(new Error('cancel learned rerank'))
        signal?.throwIfAborted()
        return []
      }
    })
    await expect(
      service.retrieve(
        {
          knowledgeBaseId: library.id,
          query: 'fallback keyword',
          settings: {
            ...library.retrievalSettings,
            vectorWeight: 0,
            graphWeight: 0,
            rerankMode: 'learned',
            localRerankEnabled: true
          }
        },
        controller.signal
      )
    ).rejects.toThrow('cancel learned rerank')
  })

  it('returns explicit degradation diagnostics and enforces context budgets', async () => {
    const provider: EmbeddingProvider = {
      provider: 'offline-provider',
      model: 'offline-model',
      embed: async () => {
        throw Object.assign(new Error('private provider response'), {
          status: 503
        })
      }
    }
    const { directory, service } = await createService(undefined, provider)
    const sourcePath = join(directory, 'budget.txt')
    await writeFile(
      sourcePath,
      Array.from(
        { length: 500 },
        (_, index) => `预算检索内容 ${index}，这是用于上下文限制的说明。`
      ).join('\n'),
      'utf8'
    )
    const library = service.createLibrary({
      name: 'Budget',
      storageMode: 'reference',
      graphEnabled: false
    })
    await service.importPaths(library.id, [sourcePath])
    service.updateSettings({
      knowledgeBaseId: library.id,
      retrieval: {
        ...library.retrievalSettings,
        contextMaxCharacters: 2_000,
        topK: 6,
        adjacentChunkCount: 1,
        localRerankEnabled: true
      }
    })

    const response = await service.retrieve({
      knowledgeBaseId: library.id,
      query: '预算检索内容'
    })

    expect(response.results.length).toBeGreaterThan(0)
    expect(response.context.characterCount).toBeLessThanOrEqual(2_000)
    expect(response.context.truncated).toBe(true)
    expect(response.results[0]?.preRerankRank).toBeDefined()
    expect(response.diagnostics.degradedChannels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: 'vector' }),
        expect.objectContaining({ channel: 'graph' })
      ])
    )
    expect(JSON.stringify(response)).not.toContain('private provider response')
  })

  it('rebuilds one document from its scoped source', async () => {
    const { directory, service } = await createService()
    const firstPath = join(directory, 'first.txt')
    const secondPath = join(directory, 'second.txt')
    await writeFile(firstPath, 'first old content', 'utf8')
    await writeFile(secondPath, 'second stable content', 'utf8')
    const library = service.createLibrary({
      name: 'Scoped rebuild',
      storageMode: 'reference',
      graphEnabled: false
    })
    await service.importPaths(library.id, [firstPath, secondPath])
    const documents = service.snapshot(library.id).documents
    const first = documents.find((document) =>
      document.sourceLocation?.endsWith('first.txt')
    )!
    const second = documents.find((document) =>
      document.sourceLocation?.endsWith('second.txt')
    )!
    const secondChecksum = second.checksum
    await writeFile(firstPath, 'first rebuilt content', 'utf8')

    await service.rebuildDocument({
      knowledgeBaseId: library.id,
      documentId: first.id
    })

    expect(service.search(library.id, 'rebuilt')[0]?.document.id).toBe(first.id)
    expect(service.database.getDocument(second.id)?.checksum).toBe(
      secondChecksum
    )
  })

  it('preserves old chunks, vectors, and graph evidence when rebuild extraction fails', async () => {
    let failExtraction = false
    const extractStructured: ExtractStructured = async () => {
      if (failExtraction) {
        throw new Error('synthetic graph failure')
      }
      return {
        entities: [],
        relations: []
      }
    }
    const provider: EmbeddingProvider = {
      provider: 'atomic-provider',
      model: 'atomic-model',
      embed: async (input) => input.map(() => [1, 0])
    }
    const { directory, service } = await createService(
      undefined,
      provider,
      extractStructured
    )
    const sourcePath = join(directory, 'atomic-rebuild.md')
    await writeFile(sourcePath, '# Original Entity\nold searchable text', 'utf8')
    const library = service.createLibrary({
      name: 'Atomic rebuild',
      storageMode: 'reference',
      graphEnabled: true,
      graphStrategy: 'hybrid'
    })
    await service.importPaths(library.id, [sourcePath])
    const before = service.snapshot(library.id)
    const document = before.documents[0]!
    const oldChunk = service.database.listChunks(document.id)[0]!
    const oldEvidence = before.evidence
    failExtraction = true
    await writeFile(sourcePath, '# Replacement Entity\nnew searchable text', 'utf8')

    await expect(service.rebuildDocument({
      knowledgeBaseId: library.id,
      documentId: document.id
    })).rejects.toThrow('synthetic graph failure')

    expect(service.search(library.id, 'old')[0]?.chunk.id).toBe(oldChunk.id)
    expect(service.search(library.id, 'new')).toEqual([])
    expect(service.database.vectorSearch({
      knowledgeBaseId: library.id,
      provider: embeddingStorageProvider(provider),
      model: provider.model,
      vector: [1, 0],
      limit: 1
    })[0]?.chunk.id).toBe(oldChunk.id)
    expect(service.snapshot(library.id).evidence).toEqual(oldEvidence)
  })

  it('serializes a rebuild and chunk edit so the latest mutation wins', async () => {
    let releaseParser: (() => void) | undefined
    let parserStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      parserStarted = resolve
    })
    let blockParser = false
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-knowledge-service-')
    )
    temporaryDirectories.push(directory)
    const service = new KnowledgeService({
      databasePath: join(directory, 'knowledge.sqlite'),
      managedRoot: join(directory, 'managed'),
      parseDocument: async (name, buffer) => {
        if (blockParser) {
          parserStarted?.()
          await new Promise<void>((resolve) => {
            releaseParser = resolve
          })
        }
        const content = blockParser
          ? 'rebuilt content'
          : buffer.toString('utf8')
        return {
          title: name,
          content,
          sourceFormat: 'text',
          sections: [{
            locator: '全文',
            content
          }],
          warnings: []
        }
      }
    })
    await service.initialize()
    services.push(service)
    const sourcePath = join(directory, 'mutation-gate.txt')
    await writeFile(sourcePath, 'initial content', 'utf8')
    const library = service.createLibrary({
      name: 'Mutation gate',
      storageMode: 'reference',
      graphEnabled: false
    })
    await service.importPaths(library.id, [sourcePath])
    const document = service.snapshot(library.id).documents[0]!
    const originalChunk = service.database
      .listChunks(document.id)
      .find((chunk) => chunk.role !== 'parent')!
    blockParser = true
    await writeFile(sourcePath, 'rebuilt source bytes', 'utf8')

    const rebuilding = service.rebuildDocument({
      knowledgeBaseId: library.id,
      documentId: document.id
    })
    await started
    const editing = service.updateChunk({
      knowledgeBaseId: library.id,
      documentId: document.id,
      chunkId: originalChunk.id,
      content: 'manual latest content'
    })
    releaseParser?.()
    await rebuilding
    await expect(editing).rejects.toThrow(
      'Chunk must belong to the requested document'
    )
    expect(service.search(library.id, 'rebuilt')).toHaveLength(1)
    expect(service.search(library.id, 'manual')).toEqual([])
  })

  it('aborts standalone document rebuild work and keeps child capabilities honest', async () => {
    let parserSignal: AbortSignal | undefined
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-knowledge-service-')
    )
    temporaryDirectories.push(directory)
    const service = new KnowledgeService({
      databasePath: join(directory, 'knowledge.sqlite'),
      managedRoot: join(directory, 'managed'),
      parseDocument: async (_name, _buffer, _purpose, signal) => {
        parserSignal = signal
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true
          })
        })
      }
    })
    await service.initialize()
    services.push(service)
    const sourcePath = join(directory, 'cancel-rebuild.txt')
    await writeFile(sourcePath, 'initial content', 'utf8')
    const library = service.createLibrary({
      name: 'Cancel rebuild',
      storageMode: 'reference',
      graphEnabled: false
    })
    const source = service.database.upsertSource({
      knowledgeBaseId: library.id,
      type: 'file',
      location: sourcePath,
      displayName: 'cancel-rebuild.txt',
      status: 'ready'
    })
    const document = service.database.upsertDocument(
      {
        knowledgeBaseId: library.id,
        sourceId: source.id,
        externalId: 'cancel-rebuild.txt',
        title: 'Cancel rebuild',
        sourceLocation: sourcePath
      },
      [{ ordinal: 0, content: 'old content' }]
    )

    const rebuilding = service.rebuildDocument({
      knowledgeBaseId: library.id,
      documentId: document.id
    })
    await vi.waitFor(() => expect(parserSignal).toBeDefined())
    const task = service
      .snapshot(library.id)
      .tasks.find((candidate) => candidate.kind === 'document-rebuild')!
    expect(task.canCancel).toBe(true)
    expect(await service.cancelTask(task.id)).toBe(true)
    await expect(rebuilding).rejects.toBeDefined()
    expect(parserSignal?.aborted).toBe(true)
    expect(service.database.getKnowledgeTask(task.id)).toMatchObject({
      status: 'cancelled',
      canCancel: false,
      canRetry: true
    })
  })

  it('deduplicates concurrent standalone document rebuild execution', async () => {
    let releaseParser: (() => void) | undefined
    const parserStarted = vi.fn()
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-knowledge-service-')
    )
    temporaryDirectories.push(directory)
    const service = new KnowledgeService({
      databasePath: join(directory, 'knowledge.sqlite'),
      managedRoot: join(directory, 'managed'),
      parseDocument: async (name) => {
        parserStarted()
        await new Promise<void>((resolve) => {
          releaseParser = resolve
        })
        return {
          title: name,
          content: 'rebuilt once',
          sourceFormat: 'text',
          sections: [],
          warnings: []
        }
      }
    })
    await service.initialize()
    services.push(service)
    const sourcePath = join(directory, 'dedupe-rebuild.txt')
    await writeFile(sourcePath, 'initial content', 'utf8')
    const library = service.createLibrary({
      name: 'Dedupe rebuild',
      storageMode: 'reference',
      graphEnabled: false
    })
    const source = service.database.upsertSource({
      knowledgeBaseId: library.id,
      type: 'file',
      location: sourcePath,
      displayName: 'dedupe-rebuild.txt',
      status: 'ready'
    })
    const document = service.database.upsertDocument(
      {
        knowledgeBaseId: library.id,
        sourceId: source.id,
        externalId: 'dedupe-rebuild.txt',
        title: 'Dedupe rebuild',
        sourceLocation: sourcePath
      },
      [{ ordinal: 0, content: 'old content' }]
    )

    const first = service.rebuildDocument({
      knowledgeBaseId: library.id,
      documentId: document.id
    })
    await vi.waitFor(() => expect(parserStarted).toHaveBeenCalledTimes(1))
    const second = service.rebuildDocument({
      knowledgeBaseId: library.id,
      documentId: document.id
    })
    expect(
      service
        .snapshot(library.id)
        .tasks.filter((task) => task.kind === 'document-rebuild')
    ).toHaveLength(1)
    releaseParser?.()

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.id).toBe(document.id)
    expect(secondResult.id).toBe(document.id)
    expect(parserStarted).toHaveBeenCalledTimes(1)
  })

  it('cancels and awaits active source sync before removing the source', async () => {
    let importerSignal: AbortSignal | undefined
    const importer = {
      import: vi.fn((_input: string, signal: AbortSignal) => {
        importerSignal = signal
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true
          })
        })
      })
    } as unknown as UrlImporter
    const { service } = await createService(importer)
    const library = service.createLibrary({
      name: 'Delete syncing source',
      storageMode: 'managed',
      graphEnabled: false
    })
    const source = service.database.upsertSource({
      knowledgeBaseId: library.id,
      type: 'url',
      location: 'https://example.com/syncing',
      displayName: 'Syncing URL',
      status: 'ready'
    })

    const syncing = service.syncSource(source.id)
    void syncing.catch(() => undefined)
    await vi.waitFor(() => expect(importerSignal).toBeDefined())
    await expect(service.removeSource(source.id)).resolves.toBe(true)
    await expect(syncing).rejects.toBeDefined()
    expect(importerSignal?.aborted).toBe(true)
    expect(service.database.getSource(source.id)).toBeUndefined()
  })

  it('leaves a paused source paused after aborting its active sync', async () => {
    let importerSignal: AbortSignal | undefined
    const importer = {
      import: vi.fn((_input: string, signal: AbortSignal) => {
        importerSignal = signal
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true
          })
        })
      })
    } as unknown as UrlImporter
    const { service } = await createService(importer)
    const library = service.createLibrary({
      name: 'Pause syncing source',
      storageMode: 'managed',
      graphEnabled: false
    })
    const source = service.database.upsertSource({
      knowledgeBaseId: library.id,
      type: 'url',
      location: 'https://example.com/pausing',
      displayName: 'Pausing URL',
      status: 'ready'
    })

    const syncing = service.syncSource(source.id)
    void syncing.catch(() => undefined)
    await vi.waitFor(() => expect(importerSignal).toBeDefined())
    service.pauseSource(source.id)
    await expect(syncing).rejects.toBeDefined()
    expect(service.database.getSource(source.id)).toMatchObject({
      status: 'paused',
      lastError: undefined
    })
  })

  it('marks an existing URL source failed when refresh fails before parsing', async () => {
    const importer = {
      import: vi.fn(async () => {
        throw new Error('URL refresh unavailable')
      })
    } as unknown as UrlImporter
    const { service } = await createService(importer)
    const library = service.createLibrary({
      name: 'Failed URL refresh',
      storageMode: 'managed',
      graphEnabled: false
    })
    const source = service.database.upsertSource({
      knowledgeBaseId: library.id,
      type: 'url',
      location: 'https://example.com/failure',
      displayName: 'Existing URL',
      status: 'ready'
    })

    await expect(service.syncSource(source.id)).rejects.toThrow(
      'URL refresh unavailable'
    )
    expect(service.database.getSource(source.id)).toMatchObject({
      status: 'error',
      lastError: 'URL refresh unavailable'
    })
  })

  it('preserves refreshed URL metadata when later indexing fails', async () => {
    const importer = {
      import: vi.fn(async () => ({
        url: 'https://example.com/redirected',
        title: 'Redirected title',
        contentType: 'text/html',
        etag: 'fresh-etag',
        lastModified: undefined,
        discoveredUrls: [],
        document: {
          title: 'Redirected title',
          sourceFormat: '.html',
          content: 'refreshed content',
          sections: [{
            locator: '网页正文',
            content: 'refreshed content'
          }],
          warnings: []
        }
      }))
    } as unknown as UrlImporter
    const { service } = await createService(importer)
    const library = service.createLibrary({
      name: 'Failed refreshed URL',
      storageMode: 'managed',
      graphEnabled: false
    })
    const source = service.database.upsertSource({
      knowledgeBaseId: library.id,
      type: 'url',
      location: 'https://example.com/original',
      displayName: 'Original title',
      status: 'ready'
    })
    vi.spyOn(service.database, 'publishDocument').mockImplementationOnce(
      () => {
        throw new Error('synthetic indexing failure')
      }
    )

    await expect(service.syncSource(source.id)).rejects.toThrow(
      'synthetic indexing failure'
    )
    expect(service.database.getSource(source.id)).toMatchObject({
      location: 'https://example.com/redirected',
      displayName: 'Redirected title',
      status: 'error',
      metadata: expect.objectContaining({ etag: 'fresh-etag' })
    })
  })

  it('serializes background embedding reindexes and awaits the rerun on disposal', async () => {
    const resolvers: Array<() => void> = []
    let activeEmbeddings = 0
    let maximumActiveEmbeddings = 0
    const provider: EmbeddingProvider = {
      provider: 'serial-background-provider',
      model: 'serial-background-model',
      embed: vi.fn(async () => {
        activeEmbeddings += 1
        maximumActiveEmbeddings = Math.max(
          maximumActiveEmbeddings,
          activeEmbeddings
        )
        await new Promise<void>((resolve) => {
          resolvers.push(resolve)
        })
        activeEmbeddings -= 1
        return [[1, 0]]
      })
    }
    const { directory, service } = await createService()
    const sourcePath = join(directory, 'serial-background.txt')
    await writeFile(sourcePath, 'initial content', 'utf8')
    const library = service.createLibrary({
      name: 'Serialized background embeddings',
      storageMode: 'reference',
      graphEnabled: false
    })
    await service.importPaths(library.id, [sourcePath])
    await service.setEmbeddingProvider(provider)
    const document = service.snapshot(library.id).documents[0]!
    const chunk = service.database.listChunks(document.id, 1)[0]!

    await service.updateChunk({
      knowledgeBaseId: library.id,
      documentId: document.id,
      chunkId: chunk.id,
      content: 'first edit'
    })
    await vi.waitFor(() => expect(resolvers).toHaveLength(1))
    await service.updateChunk({
      knowledgeBaseId: library.id,
      documentId: document.id,
      chunkId: chunk.id,
      content: 'second edit'
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(maximumActiveEmbeddings).toBe(1)

    resolvers.shift()?.()
    await vi.waitFor(() => expect(resolvers).toHaveLength(1))
    const disposing = service.dispose()
    let disposed = false
    void disposing.then(() => {
      disposed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(disposed).toBe(false)
    resolvers.shift()?.()
    await disposing
    expect(maximumActiveEmbeddings).toBe(1)
  })

  it('cancels and awaits active graph work before deleting a library', async () => {
    let extractionSignal: AbortSignal | undefined
    const extractStructured: ExtractStructured = (_prompt, signal) => {
      extractionSignal = signal
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), {
          once: true
        })
      })
    }
    const { directory, service } = await createService(
      undefined,
      undefined,
      extractStructured
    )
    const sourcePath = join(directory, 'delete-library-graph.md')
    await writeFile(sourcePath, 'GoodBuddy depends on Electron.', 'utf8')
    const library = service.createLibrary({
      name: 'Delete active graph library',
      storageMode: 'reference',
      graphEnabled: false,
      graphStrategy: 'model'
    })
    await service.importPaths(library.id, [sourcePath])
    service.database.updateKnowledgeBase(library.id, { graphEnabled: true })

    const rebuilding = service.reextractGraph(library.id)
    void rebuilding.catch(() => undefined)
    await vi.waitFor(() => expect(extractionSignal).toBeDefined())
    await expect(service.deleteLibrary(library.id)).resolves.toBe(true)
    await expect(rebuilding).rejects.toBeDefined()
    expect(extractionSignal?.aborted).toBe(true)
    expect(service.database.getKnowledgeBase(library.id)).toBeUndefined()
  })

  it('retries source sync with one top-level lineage row and linked children', async () => {
    const { directory, service } = await createService()
    const sourcePath = join(directory, 'retry-source.txt')
    await writeFile(sourcePath, 'retry source content', 'utf8')
    const library = service.createLibrary({
      name: 'Retry source',
      storageMode: 'reference',
      graphEnabled: false
    })
    await service.importPaths(library.id, [sourcePath])
    const source = service.snapshot(library.id).sources[0]!
    const original = service.database.createKnowledgeTask({
      libraryId: library.id,
      sourceId: source.id,
      documentName: source.displayName,
      scope: 'source',
      kind: 'source-sync',
      status: 'failed',
      error: { message: 'synthetic retryable failure' }
    })

    await service.retryTask(original.id)

    const tasks = service.snapshot(library.id).tasks
    const retries = tasks.filter(
      (task) =>
        task.kind === 'source-sync' && task.retryOfTaskId === original.id
    )
    expect(retries).toHaveLength(1)
    expect(retries[0]).toMatchObject({
      attempt: original.attempt + 1,
      status: 'succeeded'
    })
    expect(
      tasks.filter((task) => task.parentTaskId === retries[0]?.id).length
    ).toBeGreaterThan(0)
    expect(
      tasks
        .filter((task) => task.parentTaskId)
        .every((task) => !task.canCancel && !task.canRetry)
    ).toBe(true)
  })

  it('deduplicates a source retry against an active manual sync', async () => {
    let releaseImport: (() => void) | undefined
    const importer = {
      import: vi.fn(
        async () => {
          await new Promise<void>((resolve) => {
            releaseImport = resolve
          })
          throw new Error('synthetic sync failure')
        }
      )
    } as unknown as UrlImporter
    const { service } = await createService(importer)
    const library = service.createLibrary({
      name: 'Dedupe source retry',
      storageMode: 'managed',
      graphEnabled: false
    })
    const source = service.database.upsertSource({
      knowledgeBaseId: library.id,
      type: 'url',
      location: 'https://example.com/dedupe',
      displayName: 'Dedupe URL',
      status: 'ready'
    })
    const failed = service.database.createKnowledgeTask({
      libraryId: library.id,
      sourceId: source.id,
      documentName: source.displayName,
      scope: 'source',
      kind: 'source-sync',
      status: 'failed',
      error: { message: 'retry me' }
    })

    const syncing = service.syncSource(source.id)
    void syncing.catch(() => undefined)
    await vi.waitFor(() => expect(importer.import).toHaveBeenCalledOnce())
    const retrying = service.retryTask(failed.id)
    void retrying.catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(importer.import).toHaveBeenCalledOnce()

    releaseImport?.()
    await expect(syncing).rejects.toThrow('synthetic sync failure')
    await expect(retrying).rejects.toThrow('synthetic sync failure')
  })

  it('reconciles embedding task status during ordinary snapshots', async () => {
    let resolveEmbedding: ((value: number[][]) => void) | undefined
    const provider: EmbeddingProvider = {
      provider: 'snapshot-provider',
      model: 'snapshot-model',
      embed: () =>
        new Promise<number[][]>((resolve) => {
          resolveEmbedding = resolve
        })
    }
    const { directory, service } = await createService()
    const sourcePath = join(directory, 'snapshot-embedding.txt')
    await writeFile(sourcePath, 'snapshot embedding content', 'utf8')
    const library = service.createLibrary({
      name: 'Snapshot embedding',
      storageMode: 'reference',
      graphEnabled: false
    })
    await service.importPaths(library.id, [sourcePath])
    await service.setEmbeddingProvider(provider)
    await service.rebuildEmbeddingIndex(library.id, {
      provider: provider.provider,
      model: provider.model,
      credentialConfigured: false
    })
    await vi.waitFor(() => expect(resolveEmbedding).toBeDefined())
    expect(
      service
        .snapshot(library.id)
        .tasks.find((task) => task.kind === 'embedding-rebuild')
    ).toMatchObject({ status: 'running', canCancel: true })
    resolveEmbedding?.([[1, 0]])
    await vi.waitFor(() => {
      expect(
        service
          .snapshot(library.id)
          .tasks.find((task) => task.kind === 'embedding-rebuild')
      ).toMatchObject({ status: 'succeeded', progress: 100 })
    })
  })
})
