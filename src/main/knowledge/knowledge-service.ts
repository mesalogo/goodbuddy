import {
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  stat
} from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve
} from 'node:path'
import { chunkDocument, parseDocument, supportedDocumentExtensions } from './document-parser'
import { classifyEmbeddingError } from './embedding-errors'
import {
  extractKnowledgeGraph,
  normalizeEntityAlias,
  type ExtractStructured,
  type GraphExtractionResult
} from './graph-extractor'
import { KnowledgeDatabase } from './knowledge-database'
import type {
  CreateKnowledgeBaseInput,
  Document,
  GraphStrategy,
  GraphEntity,
  GraphRelation,
  EmbeddingProvider,
  HybridSearchResult,
  KnowledgeBase,
  KnowledgeSource,
  SearchResult
} from './types'
import { UrlImporter } from './url-importer'
import { mimeTypeFromFileName } from '../file-media-type'

type ScannedFile = {
  absolutePath: string
  relativePath: string
  size: number
}

export type KnowledgeLibrarySnapshot = KnowledgeBase & {
  sourceCount: number
  documentCount: number
  indexedDocumentCount: number
}

export type KnowledgeSourceSnapshot = KnowledgeSource & {
  documentCount: number
  progress: number
  lastSyncedAt?: string
}

export type KnowledgeDocumentSnapshot = Document & {
  chunkCount: number
  status: 'queued' | 'parsing' | 'indexing' | 'ready' | 'failed'
  size?: number
  error?: string
}

export type KnowledgeTaskSnapshot = {
  id: string
  libraryId: string
  sourceId?: string
  documentId?: string
  documentName: string
  kind: 'parsing' | 'embedding' | 'graph'
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped'
  progress: number
  message?: string
  createdAt: string
  startedAt?: string
  completedAt?: string
}

export type KnowledgeSnapshot = {
  libraries: KnowledgeLibrarySnapshot[]
  sources: KnowledgeSourceSnapshot[]
  documents: KnowledgeDocumentSnapshot[]
  entities: GraphEntity[]
  relations: GraphRelation[]
  evidence: ReturnType<KnowledgeDatabase['listEvidence']>
  tasks: KnowledgeTaskSnapshot[]
}

export type KnowledgeServiceOptions = {
  databasePath: string
  managedRoot: string
  extractStructured?: ExtractStructured
  urlImporter?: UrlImporter
  embeddingProvider?: EmbeddingProvider
  embeddingBatchSize?: number
}

const supportedExtensions = new Set<string>(supportedDocumentExtensions)
const maximumFileBytes = 20 * 1024 * 1024
const maximumSourceBytes = 500 * 1024 * 1024
const maximumFilesPerSource = 2_000
const maximumEmbeddingChunksPerBatch = 32
const maximumKnowledgeTasks = 500

function isInside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate))
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

export class KnowledgeService {
  readonly database: KnowledgeDatabase
  private readonly managedRoot: string
  private readonly extractStructured?: ExtractStructured
  private readonly urlImporter: UrlImporter
  private embeddingProvider?: EmbeddingProvider
  private readonly embeddingBatchSize: number
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly syncTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly activeSyncs = new Map<string, Promise<void>>()
  private readonly tasks = new Map<string, KnowledgeTaskSnapshot>()
  private readonly lifecycleController = new AbortController()

  constructor(options: KnowledgeServiceOptions) {
    this.database = new KnowledgeDatabase(options.databasePath)
    this.managedRoot = resolve(options.managedRoot)
    this.extractStructured = options.extractStructured
    this.urlImporter = options.urlImporter ?? new UrlImporter()
    this.embeddingProvider = options.embeddingProvider
    const embeddingBatchSize = options.embeddingBatchSize ?? 16
    if (
      !Number.isSafeInteger(embeddingBatchSize) ||
      embeddingBatchSize < 1 ||
      embeddingBatchSize > maximumEmbeddingChunksPerBatch
    ) {
      throw new RangeError(
        `embeddingBatchSize must be between 1 and ${maximumEmbeddingChunksPerBatch}`
      )
    }
    this.embeddingBatchSize = embeddingBatchSize
  }

  async initialize(): Promise<void> {
    await mkdir(this.managedRoot, { recursive: true })
    this.database.initialize()
    for (const library of this.database.listKnowledgeBases()) {
      for (const source of this.database.listSources(library.id)) {
        if (
          library.storageMode === 'reference' &&
          source.type !== 'url' &&
          source.status === 'ready'
        ) {
          this.startWatcher(source)
        }
      }
    }
  }

  async dispose(): Promise<void> {
    this.lifecycleController.abort(
      new Error('Knowledge service is shutting down')
    )
    for (const timer of this.syncTimers.values()) {
      clearTimeout(timer)
    }
    this.syncTimers.clear()
    for (const watcher of this.watchers.values()) {
      watcher.close()
    }
    this.watchers.clear()
    await Promise.allSettled(this.activeSyncs.values())
    this.database.close()
  }

  setEmbeddingProvider(provider?: EmbeddingProvider): Promise<void> {
    this.embeddingProvider = provider
    return Promise.resolve()
  }

  private createKnowledgeTask(input: {
    libraryId: string
    sourceId?: string
    documentId?: string
    documentName: string
    kind: KnowledgeTaskSnapshot['kind']
    status?: KnowledgeTaskSnapshot['status']
    message?: string
  }): KnowledgeTaskSnapshot {
    while (this.tasks.size >= maximumKnowledgeTasks) {
      const oldestTaskId = this.tasks.keys().next().value as
        | string
        | undefined
      if (!oldestTaskId) {
        break
      }
      this.tasks.delete(oldestTaskId)
    }
    const now = new Date().toISOString()
    const status = input.status ?? 'queued'
    const task: KnowledgeTaskSnapshot = {
      id: randomUUID(),
      libraryId: input.libraryId,
      sourceId: input.sourceId,
      documentId: input.documentId,
      documentName: input.documentName.slice(0, 512),
      kind: input.kind,
      status,
      progress: status === 'succeeded' || status === 'skipped' ? 100 : 0,
      message: input.message?.slice(0, 1_000),
      createdAt: now,
      startedAt: status === 'running' ? now : undefined,
      completedAt:
        status === 'succeeded' ||
        status === 'failed' ||
        status === 'skipped'
          ? now
          : undefined
    }
    this.tasks.set(task.id, task)
    return task
  }

  private updateKnowledgeTask(
    taskId: string,
    update: {
      status?: KnowledgeTaskSnapshot['status']
      progress?: number
      message?: string
      documentId?: string
      documentName?: string
    }
  ): void {
    const current = this.tasks.get(taskId)
    if (!current) {
      return
    }
    const status = update.status ?? current.status
    const terminal =
      status === 'succeeded' ||
      status === 'failed' ||
      status === 'skipped'
    this.tasks.set(taskId, {
      ...current,
      status,
      documentId: update.documentId ?? current.documentId,
      documentName:
        update.documentName?.slice(0, 512) ?? current.documentName,
      progress:
        status === 'succeeded' || status === 'skipped'
          ? 100
          : update.progress === undefined
            ? current.progress
            : Math.max(0, Math.min(100, Math.round(update.progress))),
      message:
        update.message === undefined
          ? current.message
          : update.message.slice(0, 1_000),
      startedAt:
        status === 'running' && !current.startedAt
          ? new Date().toISOString()
          : current.startedAt,
      completedAt:
        terminal && !current.completedAt
          ? new Date().toISOString()
          : current.completedAt
    })
  }

  private failKnowledgeTask(taskId: string, error: unknown): void {
    const current = this.tasks.get(taskId)
    if (
      current?.status === 'succeeded' ||
      current?.status === 'skipped'
    ) {
      return
    }
    this.updateKnowledgeTask(taskId, {
      status: 'failed',
      message: error instanceof Error ? error.message : '任务失败'
    })
  }

  createLibrary(input: CreateKnowledgeBaseInput): KnowledgeBase {
    return this.database.createKnowledgeBase(input)
  }

  async deleteLibrary(id: string): Promise<boolean> {
    const library = this.database.getKnowledgeBase(id)
    if (!library) {
      return false
    }
    for (const source of this.database.listSources(id)) {
      this.stopWatcher(source.id)
    }
    for (const task of this.tasks.values()) {
      if (task.libraryId === id) {
        this.tasks.delete(task.id)
      }
    }
    const deleted = this.database.deleteKnowledgeBase(id)
    if (deleted && library.storageMode === 'managed') {
      const path = join(this.managedRoot, id)
      if (isInside(this.managedRoot, path)) {
        await rm(path, { recursive: true, force: true })
      }
    }
    return deleted
  }

  snapshot(selectedLibraryId?: string): KnowledgeSnapshot {
    const libraries = this.database.listKnowledgeBases().map((library) => {
      const sources = this.database.listSources(library.id)
      const documents = this.database.listDocuments(library.id)
      return {
        ...library,
        sourceCount: sources.length,
        documentCount: documents.length,
        indexedDocumentCount: documents.filter(
          (document) => document.metadata.status !== 'failed'
        ).length
      }
    })
    const libraryId = selectedLibraryId ?? libraries[0]?.id
    if (!libraryId) {
      return {
        libraries,
        sources: [],
        documents: [],
        entities: [],
        relations: [],
        evidence: [],
        tasks: []
      }
    }
    const sources = this.database.listSources(libraryId).map((source) => ({
      ...source,
      documentCount: this.database
        .listDocuments(libraryId)
        .filter((document) => document.sourceId === source.id).length,
      progress:
        typeof source.metadata.progress === 'number'
          ? source.metadata.progress
          : source.status === 'ready'
            ? 100
            : 0,
      lastSyncedAt:
        typeof source.metadata.lastSyncedAt === 'string'
          ? source.metadata.lastSyncedAt
          : undefined
    }))
    const documents = this.database.listDocuments(libraryId).map((document) => {
      const status =
        typeof document.metadata.status === 'string' &&
        ['queued', 'parsing', 'indexing', 'ready', 'failed'].includes(
          document.metadata.status
        )
          ? (document.metadata.status as KnowledgeDocumentSnapshot['status'])
          : 'ready'
      return {
        ...document,
        chunkCount: this.database.listChunks(document.id).length,
        status,
        size:
          typeof document.metadata.size === 'number'
            ? document.metadata.size
            : undefined,
        error:
          typeof document.metadata.error === 'string'
            ? document.metadata.error
            : undefined
      }
    })
    return {
      libraries,
      sources,
      documents,
      entities: this.database.listEntities(libraryId),
      relations: this.database.listRelations(libraryId),
      evidence: this.database.listEvidence(libraryId),
      tasks: [...this.tasks.values()]
        .filter((task) => task.libraryId === libraryId)
        .sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt)
        )
    }
  }

  search(knowledgeBaseId: string, query: string, limit = 6): SearchResult[] {
    return this.database.search({
      knowledgeBaseId,
      query,
      limit
    })
  }

  async searchHybrid(
    knowledgeBaseId: string,
    query: string,
    limit = 6,
    signal?: AbortSignal
  ): Promise<HybridSearchResult[]> {
    const library = this.requireLibrary(knowledgeBaseId)
    const vector = await this.embedQuery(query, signal)
    return this.database.hybridSearch({
      knowledgeBaseId,
      query,
      limit,
      provider: vector ? this.embeddingProvider?.provider : undefined,
      model: vector ? this.embeddingProvider?.model : undefined,
      vector,
      graphEnabled: library.graphEnabled
    })
  }

  async searchHybridMany(
    knowledgeBaseIds: readonly string[],
    query: string,
    limitPerLibrary = 6,
    signal?: AbortSignal
  ): Promise<
    Array<{ knowledgeBaseId: string; result: HybridSearchResult }>
  > {
    const vector = await this.embedQuery(query, signal)
    return knowledgeBaseIds.flatMap((knowledgeBaseId) => {
      const library = this.requireLibrary(knowledgeBaseId)
      return this.database
        .hybridSearch({
          knowledgeBaseId,
          query,
          limit: limitPerLibrary,
          provider: vector
            ? this.embeddingProvider?.provider
            : undefined,
          model: vector ? this.embeddingProvider?.model : undefined,
          vector,
          graphEnabled: library.graphEnabled
        })
        .map((result) => ({ knowledgeBaseId, result }))
    })
  }

  private async embedQuery(
    query: string,
    signal?: AbortSignal
  ): Promise<readonly number[] | undefined> {
    if (!this.embeddingProvider) {
      return undefined
    }
    const effectiveSignal = signal
      ? AbortSignal.any([signal, this.lifecycleController.signal])
      : this.lifecycleController.signal
    try {
      const result = await this.embeddingProvider.embed(
        [query],
        effectiveSignal
      )
      return result.length === 1 ? result[0] : undefined
    } catch {
      if (effectiveSignal.aborted) {
        throw effectiveSignal.reason
      }
      return undefined
    }
  }

  async importPaths(
    knowledgeBaseId: string,
    selectedPaths: string[],
    graphStrategy?: Exclude<GraphStrategy, 'ask'>
  ): Promise<void> {
    const library = this.requireLibrary(knowledgeBaseId)
    const effectiveLibrary = graphStrategy
      ? { ...library, graphStrategy }
      : library
    if (selectedPaths.length === 0 || selectedPaths.length > 20) {
      throw new Error('每次请选择 1 至 20 个文件或目录')
    }
    for (const selectedPath of selectedPaths) {
      const canonicalPath = await realpath(selectedPath)
      const fileStat = await lstat(canonicalPath)
      if (fileStat.isSymbolicLink()) {
        throw new Error('不能导入符号链接')
      }
      const sourceId = randomUUID()
      const sourceType = fileStat.isDirectory() ? 'directory' : 'file'
      const target =
        library.storageMode === 'managed'
          ? join(
              this.managedRoot,
              knowledgeBaseId,
              sourceId,
              basename(canonicalPath)
            )
          : canonicalPath
      let source = this.database.upsertSource({
        id: sourceId,
        knowledgeBaseId,
        type: sourceType,
        location: target,
        displayName: basename(canonicalPath),
        status: 'indexing',
        metadata: {
          originalLocation: canonicalPath,
          progress: 0
        }
      })
      try {
        if (library.storageMode === 'managed') {
          await this.copySupportedSource(canonicalPath, target)
        }
        await this.indexSource(effectiveLibrary, source)
        source = this.database.upsertSource({
          ...source,
          status: 'ready',
          metadata: {
            ...source.metadata,
            progress: 100,
            lastSyncedAt: new Date().toISOString()
          }
        })
        if (library.storageMode === 'reference') {
          this.startWatcher(source)
        }
      } catch (error) {
        this.database.upsertSource({
          ...source,
          status: 'error',
          lastError:
            error instanceof Error
              ? error.message.slice(0, 1_000)
              : '来源导入失败',
          metadata: {
            ...source.metadata,
            progress: 0
          }
        })
        throw error
      }
    }
  }

  async importUrl(
    knowledgeBaseId: string,
    input: string,
    signal: AbortSignal,
    sourceId?: string,
    graphStrategy?: Exclude<GraphStrategy, 'ask'>
  ): Promise<void> {
    const library = this.requireLibrary(knowledgeBaseId)
    const effectiveLibrary = graphStrategy
      ? { ...library, graphStrategy }
      : library
    const effectiveSignal = AbortSignal.any([
      signal,
      this.lifecycleController.signal,
      AbortSignal.timeout(60_000)
    ])
    const parsingTask = this.createKnowledgeTask({
      libraryId: library.id,
      sourceId,
      documentName: new URL(input).hostname,
      kind: 'parsing'
    })
    let result: Awaited<ReturnType<UrlImporter['import']>>
    try {
      this.updateKnowledgeTask(parsingTask.id, {
        status: 'running',
        progress: 10,
        message: '正在抓取并解析网页'
      })
      result = await this.urlImporter.import(input, effectiveSignal)
      this.updateKnowledgeTask(parsingTask.id, {
        progress: 70,
        message: '正在保存网页内容'
      })
    } catch (error) {
      this.failKnowledgeTask(parsingTask.id, error)
      throw error
    }
    let source = this.database.upsertSource({
      id: sourceId,
      knowledgeBaseId,
      type: 'url',
      location: result.url,
      displayName: result.title,
      status: 'indexing',
      metadata: {
        etag: result.etag ?? '',
        lastModified: result.lastModified ?? '',
        contentType: result.contentType,
        discoveredUrls: result.discoveredUrls
      }
    })
    try {
      const document = this.database.upsertDocument(
        {
          knowledgeBaseId,
          sourceId: source.id,
          externalId: result.url,
          title: result.title,
          mimeType: result.contentType,
          sourceLocation: result.url,
          checksum: createHash('sha256')
            .update(result.document.content)
            .digest('hex'),
          metadata: {
            status: 'ready',
            size: Buffer.byteLength(result.document.content)
          }
        },
        chunkDocument(result.document).map((chunk) => ({
          ordinal: chunk.position,
          content: chunk.content,
          location: chunk.locator
        }))
      )
      this.updateKnowledgeTask(parsingTask.id, {
        status: 'succeeded',
        documentId: document.id,
        documentName: document.title,
        message: '网页解析完成'
      })
      await this.indexDocumentEmbeddings(document)
      await this.extractGraph(effectiveLibrary, document)
      source = this.database.upsertSource({
        ...source,
        status: 'ready',
        metadata: {
          ...source.metadata,
          progress: 100,
          lastSyncedAt: new Date().toISOString()
        }
      })
    } catch (error) {
      this.failKnowledgeTask(parsingTask.id, error)
      this.database.upsertSource({
        ...source,
        status: 'error',
        lastError: error instanceof Error ? error.message.slice(0, 1_000) : 'URL 导入失败'
      })
      throw error
    }
  }

  pauseSource(sourceId: string): void {
    const source = this.requireSource(sourceId)
    this.stopWatcher(sourceId)
    this.database.upsertSource({
      ...source,
      status: 'paused'
    })
  }

  async syncSource(sourceId: string): Promise<void> {
    const existing = this.activeSyncs.get(sourceId)
    if (existing) {
      return existing
    }
    const operation = this.performSyncSource(sourceId).finally(() => {
      this.activeSyncs.delete(sourceId)
    })
    this.activeSyncs.set(sourceId, operation)
    return operation
  }

  async retrySource(sourceId: string): Promise<void> {
    return this.syncSource(sourceId)
  }

  async reextractGraph(knowledgeBaseId: string): Promise<void> {
    const library = this.requireLibrary(knowledgeBaseId)
    if (!library.graphEnabled) {
      throw new Error('请先启用知识图谱')
    }
    if (library.graphStrategy === 'ask') {
      throw new Error('按需询问策略不会自动抽取，请在设置中选择其他策略')
    }
    const documents = this.database.listDocuments(library.id)
    const tasks = documents.map((document) =>
      this.createKnowledgeTask({
        libraryId: library.id,
        sourceId: document.sourceId,
        documentId: document.id,
        documentName: document.title,
        kind: 'graph',
        message: '等待重新抽取'
      })
    )
    for (let index = 0; index < documents.length; index += 1) {
      const document = documents[index]
      const task = tasks[index]
      if (!document || !task) {
        continue
      }
      try {
        this.updateKnowledgeTask(task.id, {
          status: 'running',
          progress: 10,
          message: '正在重新抽取知识图谱'
        })
        const result = await this.extractGraphResult(library, document)
        this.updateKnowledgeTask(task.id, {
          progress: 85,
          message: '正在保存实体和关系'
        })
        this.database.removeEvidenceForDocument(document.id)
        this.storeExtractedGraph(library, document, result)
        this.updateKnowledgeTask(task.id, {
          status: 'succeeded',
          message: `已抽取 ${result.entities.length} 个实体、${result.relations.length} 条关系`
        })
      } catch (error) {
        this.failKnowledgeTask(task.id, error)
        for (const pendingTask of tasks.slice(index + 1)) {
          this.updateKnowledgeTask(pendingTask.id, {
            status: 'skipped',
            message: '因前序图谱任务失败而未执行'
          })
        }
        throw error
      }
    }
    this.database.pruneUnreferencedGeneratedGraph(library.id)
  }

  async removeSource(sourceId: string): Promise<boolean> {
    const source = this.requireSource(sourceId)
    const library = this.requireLibrary(source.knowledgeBaseId)
    this.stopWatcher(sourceId)
    const removed = this.database.removeSource(sourceId)
    if (
      removed &&
      library.storageMode === 'managed' &&
      source.type !== 'url' &&
      isInside(this.managedRoot, source.location)
    ) {
      await rm(
        join(this.managedRoot, library.id, source.id),
        { recursive: true, force: true }
      )
    }
    return removed
  }

  private async performSyncSource(sourceId: string): Promise<void> {
    let source = this.requireSource(sourceId)
    const library = this.requireLibrary(source.knowledgeBaseId)
    if (source.type === 'url') {
      await this.importUrl(
        library.id,
        source.location,
        this.lifecycleController.signal,
        source.id
      )
      return
    }
    source = this.database.upsertSource({
      ...source,
      status: 'indexing',
      lastError: null,
      metadata: { ...source.metadata, progress: 0 }
    })
    try {
      await this.indexSource(library, source)
      source = this.database.upsertSource({
        ...source,
        status: 'ready',
        metadata: {
          ...source.metadata,
          progress: 100,
          lastSyncedAt: new Date().toISOString()
        }
      })
      if (library.storageMode === 'reference') {
        this.startWatcher(source)
      }
    } catch (error) {
      this.database.upsertSource({
        ...source,
        status: 'error',
        lastError:
          error instanceof Error ? error.message.slice(0, 1_000) : '同步失败'
      })
      throw error
    }
  }

  private async indexSource(
    library: KnowledgeBase,
    source: KnowledgeSource
  ): Promise<void> {
    const files = await this.scanSource(source.location)
    const existing = this.database
      .listDocuments(library.id)
      .filter((document) => document.sourceId === source.id)
    const currentExternalIds = new Set(files.map((file) => file.relativePath))
    for (const document of existing) {
      if (!currentExternalIds.has(document.externalId)) {
        this.database.removeDocument(document.id)
      }
    }

    const failures: string[] = []
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      if (!file) {
        continue
      }
      const parsingTask = this.createKnowledgeTask({
        libraryId: library.id,
        sourceId: source.id,
        documentName: file.relativePath,
        kind: 'parsing'
      })
      try {
        this.updateKnowledgeTask(parsingTask.id, {
          status: 'running',
          progress: 10,
          message: '正在读取文档'
        })
        const buffer = await this.readBoundedFile(file.absolutePath)
        this.updateKnowledgeTask(parsingTask.id, {
          progress: 35,
          message: '正在解析文档内容'
        })
        const checksum = createHash('sha256').update(buffer).digest('hex')
        const previous = existing.find(
          (document) => document.externalId === file.relativePath
        )
        if (previous?.checksum === checksum) {
          this.updateKnowledgeTask(parsingTask.id, {
            status: 'skipped',
            message: '文档内容未发生变化'
          })
          continue
        }
        const parsed = await parseDocument(
          basename(file.absolutePath),
          buffer
        )
        this.updateKnowledgeTask(parsingTask.id, {
          progress: 75,
          message: '正在保存解析结果'
        })
        const document = this.database.upsertDocument(
          {
            knowledgeBaseId: library.id,
            sourceId: source.id,
            externalId: file.relativePath,
            title: parsed.title,
            mimeType: mimeTypeFromFileName(
              file.absolutePath,
              'text/plain'
            ),
            sourceLocation: file.absolutePath,
            checksum,
            metadata: {
              status: 'ready',
              size: file.size
            }
          },
          chunkDocument(parsed).map((chunk) => ({
            ordinal: chunk.position,
            content: chunk.content,
            location: chunk.locator
          }))
        )
        this.updateKnowledgeTask(parsingTask.id, {
          status: 'succeeded',
          documentId: document.id,
          documentName: document.title,
          message: '文档解析完成'
        })
        this.database.removeEvidenceForDocument(document.id)
        await this.indexDocumentEmbeddings(document)
        await this.extractGraph(library, document)
      } catch (error) {
        this.failKnowledgeTask(parsingTask.id, error)
        failures.push(
          `${file.relativePath}: ${
            error instanceof Error ? error.message : '解析失败'
          }`
        )
      }
      this.database.upsertSource({
        ...source,
        status: 'indexing',
        metadata: {
          ...source.metadata,
          progress: Math.round(((index + 1) / Math.max(files.length, 1)) * 100)
        }
      })
    }
    if (failures.length > 0) {
      throw new Error(
        `${failures.length} 个文件处理失败：${failures.slice(0, 5).join('；')}`
      )
    }
  }

  private async indexDocumentEmbeddings(
    document: Document,
    requestedProvider?: EmbeddingProvider
  ): Promise<void> {
    const provider = requestedProvider ?? this.embeddingProvider
    const task = this.createKnowledgeTask({
      libraryId: document.knowledgeBaseId,
      sourceId: document.sourceId,
      documentId: document.id,
      documentName: document.title,
      kind: 'embedding'
    })
    if (!provider) {
      this.updateKnowledgeTask(task.id, {
        status: 'skipped',
        message: '未启用向量化'
      })
      return
    }
    try {
      this.updateKnowledgeTask(task.id, {
        status: 'running',
        progress: 5,
        message: '正在准备文档分块'
      })
      const chunks = this.database.listChunks(document.id, 10_000)
      const embeddings: Array<{
        chunkId: string
        contentChecksum: string
        vector: readonly number[]
      }> = []
      let expectedDimensions: number | undefined
      for (
        let offset = 0;
        offset < chunks.length;
        offset += this.embeddingBatchSize
      ) {
        const batch = chunks.slice(offset, offset + this.embeddingBatchSize)
        const vectors = await provider.embed(
          batch.map((chunk) => chunk.content),
          this.lifecycleController.signal
        )
        if (vectors.length !== batch.length) {
          throw new Error('Embedding provider returned an invalid result count')
        }
        for (let index = 0; index < batch.length; index += 1) {
          const chunk = batch[index]
          const vector = vectors[index]
          if (!chunk || !vector) {
            throw new Error('Embedding provider returned an incomplete batch')
          }
          if (expectedDimensions === undefined) {
            expectedDimensions = vector.length
          } else if (vector.length !== expectedDimensions) {
            throw new Error('Embedding provider returned inconsistent dimensions')
          }
          embeddings.push({
            chunkId: chunk.id,
            contentChecksum: createHash('sha256')
              .update(chunk.content)
              .digest('hex'),
            vector
          })
        }
        this.updateKnowledgeTask(task.id, {
          progress:
            5 +
            ((offset + batch.length) / Math.max(chunks.length, 1)) * 85,
          message: `正在向量化 ${Math.min(
            offset + batch.length,
            chunks.length
          )}/${chunks.length} 个分块`
        })
      }
      if (this.embeddingProvider !== provider) {
        this.updateKnowledgeTask(task.id, {
          status: 'skipped',
          message: '向量模型配置已变化'
        })
        return
      }
      this.database.replaceDocumentEmbeddings(
        document.id,
        provider.provider,
        provider.model,
        embeddings
      )
      this.updateKnowledgeTask(task.id, {
        status: 'succeeded',
        message: `已向量化 ${chunks.length} 个分块`
      })
    } catch (error) {
      if (this.lifecycleController.signal.aborted) {
        this.failKnowledgeTask(task.id, new Error('向量化已取消'))
        return
      }
      const safeError = classifyEmbeddingError(error)
      this.failKnowledgeTask(task.id, safeError)
      try {
        this.database.recordEmbeddingIndexError(
          document.id,
          provider.provider,
          provider.model,
          safeError.message
        )
      } catch {
        // FTS indexing is authoritative; embedding diagnostics are best effort.
      }
    }
  }

  private async extractGraph(
    library: KnowledgeBase,
    document: Document
  ): Promise<void> {
    const task = this.createKnowledgeTask({
      libraryId: library.id,
      sourceId: document.sourceId,
      documentId: document.id,
      documentName: document.title,
      kind: 'graph'
    })
    if (!library.graphEnabled) {
      this.updateKnowledgeTask(task.id, {
        status: 'skipped',
        message: '知识图谱未启用'
      })
      return
    }
    if (library.graphStrategy === 'ask') {
      this.updateKnowledgeTask(task.id, {
        status: 'skipped',
        message: '按需询问策略不自动抽取'
      })
      return
    }
    try {
      this.updateKnowledgeTask(task.id, {
        status: 'running',
        progress: 10,
        message: '正在准备图谱抽取'
      })
      const result = await this.extractGraphResult(library, document)
      this.updateKnowledgeTask(task.id, {
        progress: 85,
        message: '正在保存实体和关系'
      })
      this.storeExtractedGraph(library, document, result)
      this.updateKnowledgeTask(task.id, {
        status: 'succeeded',
        message: `已抽取 ${result.entities.length} 个实体、${result.relations.length} 条关系`
      })
    } catch (error) {
      this.failKnowledgeTask(task.id, error)
      throw error
    }
  }

  private async extractGraphResult(
    library: KnowledgeBase,
    document: Document
  ): Promise<GraphExtractionResult> {
    const chunks = this.database.listChunks(document.id)
    return extractKnowledgeGraph(
      chunks.map((chunk) => ({
        id: chunk.id,
        content: chunk.content
      })),
      {
        strategy: library.graphStrategy,
        extractStructured: this.extractStructured
      }
    )
  }

  private storeExtractedGraph(
    library: KnowledgeBase,
    document: Document,
    result: GraphExtractionResult
  ): void {
    const existingEntities = this.database.listEntities(library.id)
    const entityIds = new Map<string, string>()
    for (const entity of result.entities) {
      const normalized = normalizeEntityAlias(entity.name)
      const existing = existingEntities.find(
        (candidate) =>
          normalizeEntityAlias(candidate.name) === normalized ||
          candidate.aliases.some(
            (alias) => normalizeEntityAlias(alias) === normalized
          )
      )
      const stored = existing
        ? this.database.updateEntity(existing.id, {
            aliases: [...new Set([...existing.aliases, ...entity.aliases])]
          })
        : this.database.createEntity({
            knowledgeBaseId: library.id,
            name: entity.name,
            type: entity.type,
            aliases: entity.aliases,
            locked: false
          })
      entityIds.set(entity.id, stored.id)
      for (const evidence of entity.evidence) {
        this.database.createEvidence({
          knowledgeBaseId: library.id,
          entityId: stored.id,
          documentId: document.id,
          chunkId: evidence.chunkId,
          quote: evidence.quote,
          location: this.database
            .listChunks(document.id)
            .find((chunk) => chunk.id === evidence.chunkId)?.location
        })
      }
    }
    const existingRelations = this.database.listRelations(library.id)
    for (const relation of result.relations) {
      const sourceEntityId = entityIds.get(relation.sourceId)
      const targetEntityId = entityIds.get(relation.targetId)
      if (!sourceEntityId || !targetEntityId) {
        continue
      }
      const existing = existingRelations.find(
        (candidate) =>
          candidate.sourceEntityId === sourceEntityId &&
          candidate.targetEntityId === targetEntityId &&
          candidate.type === relation.type
      )
      const stored =
        existing ??
        this.database.createRelation({
          knowledgeBaseId: library.id,
          sourceEntityId,
          targetEntityId,
          type: relation.type,
          locked: false
        })
      for (const evidence of relation.evidence) {
        this.database.createEvidence({
          knowledgeBaseId: library.id,
          relationId: stored.id,
          documentId: document.id,
          chunkId: evidence.chunkId,
          quote: evidence.quote,
          location: this.database
            .listChunks(document.id)
            .find((chunk) => chunk.id === evidence.chunkId)?.location
        })
      }
    }
  }

  private async scanSource(rootPath: string): Promise<ScannedFile[]> {
    const canonicalRoot = await realpath(rootPath)
    const rootStat = await lstat(canonicalRoot)
    const files: ScannedFile[] = []
    let totalBytes = 0
    const visit = async (path: string): Promise<void> => {
      const entries = await readdir(path, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          continue
        }
        const child = join(path, entry.name)
        if (entry.isDirectory()) {
          await visit(child)
        } else if (
          entry.isFile() &&
          supportedExtensions.has(extname(entry.name).toLowerCase())
        ) {
          const fileStat = await stat(child)
          if (fileStat.size > maximumFileBytes) {
            continue
          }
          totalBytes += fileStat.size
          if (
            files.length >= maximumFilesPerSource ||
            totalBytes > maximumSourceBytes
          ) {
            throw new Error('来源超过 2,000 个文件或 500MB 配额')
          }
          files.push({
            absolutePath: child,
            relativePath: relative(canonicalRoot, child) || basename(child),
            size: fileStat.size
          })
        }
      }
    }
    if (rootStat.isFile()) {
      if (!supportedExtensions.has(extname(canonicalRoot).toLowerCase())) {
        throw new Error('不支持该文档类型')
      }
      files.push({
        absolutePath: canonicalRoot,
        relativePath: basename(canonicalRoot),
        size: rootStat.size
      })
    } else if (rootStat.isDirectory()) {
      await visit(canonicalRoot)
    } else {
      throw new Error('来源必须是文件或目录')
    }
    if (files.length === 0) {
      throw new Error('来源中没有可索引的受支持文档')
    }
    return files
  }

  private async copySupportedSource(
    sourcePath: string,
    targetPath: string
  ): Promise<void> {
    const files = await this.scanSource(sourcePath)
    const sourceStat = await lstat(sourcePath)
    if (sourceStat.isFile()) {
      await mkdir(resolve(targetPath, '..'), { recursive: true })
      await cp(files[0]?.absolutePath ?? sourcePath, targetPath, {
        force: false,
        errorOnExist: true
      })
      return
    }
    for (const file of files) {
      const target = join(targetPath, file.relativePath)
      if (!isInside(targetPath, target)) {
        throw new Error('来源目录包含越界路径')
      }
      await mkdir(resolve(target, '..'), { recursive: true })
      await cp(file.absolutePath, target, {
        force: false,
        errorOnExist: true
      })
    }
  }

  private async readBoundedFile(path: string): Promise<Buffer> {
    const handle = await open(path, 'r')
    try {
      const fileStat = await handle.stat()
      if (!fileStat.isFile() || fileStat.size > maximumFileBytes) {
        throw new Error('文件超过 20MB 或不是普通文件')
      }
      const buffer = Buffer.alloc(fileStat.size + 1)
      const result = await handle.read(buffer, 0, buffer.length, 0)
      if (result.bytesRead > maximumFileBytes) {
        throw new Error('文件超过 20MB')
      }
      return buffer.subarray(0, result.bytesRead)
    } finally {
      await handle.close()
    }
  }

  private startWatcher(source: KnowledgeSource): void {
    this.stopWatcher(source.id)
    try {
      const watcher = watch(
        source.location,
        {
          recursive: source.type === 'directory',
          persistent: false
        },
        () => {
          const current = this.syncTimers.get(source.id)
          if (current) {
            clearTimeout(current)
          }
          this.syncTimers.set(
            source.id,
            setTimeout(() => {
              this.syncTimers.delete(source.id)
              void this.syncSource(source.id).catch(() => undefined)
            }, 800)
          )
        }
      )
      watcher.on('error', () => this.stopWatcher(source.id))
      this.watchers.set(source.id, watcher)
    } catch {
      this.stopWatcher(source.id)
    }
  }

  private stopWatcher(sourceId: string): void {
    this.watchers.get(sourceId)?.close()
    this.watchers.delete(sourceId)
    const timer = this.syncTimers.get(sourceId)
    if (timer) {
      clearTimeout(timer)
      this.syncTimers.delete(sourceId)
    }
  }

  private requireLibrary(id: string): KnowledgeBase {
    const library = this.database.getKnowledgeBase(id)
    if (!library) {
      throw new Error('知识库不存在')
    }
    return library
  }

  private requireSource(id: string): KnowledgeSource {
    for (const library of this.database.listKnowledgeBases()) {
      const source = this.database
        .listSources(library.id)
        .find((item) => item.id === id)
      if (source) {
        return source
      }
    }
    throw new Error('知识来源不存在')
  }
}
