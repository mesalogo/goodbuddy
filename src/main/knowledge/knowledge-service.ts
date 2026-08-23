import {
  cp,
  lstat,
  mkdir,
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
  join,
  relative,
  resolve
} from 'node:path'
import {
  buildChunkContextPrefix,
  chunkDocumentAdvanced,
  parseDocument,
  supportedDocumentExtensions,
  type ParsedDocument
} from './document-parser'
import {
  knowledgeChunkDeleteInputSchema,
  knowledgeChunksListInputSchema,
  knowledgeChunkUpdateInputSchema,
  knowledgeDocumentRebuildInputSchema,
  knowledgeLibraryRebuildInputSchema,
  knowledgeReferenceContextInputSchema,
  knowledgeRetrieveInputSchema,
  knowledgeSettingsUpdateInputSchema,
  type KnowledgeChunkDeleteInput,
  type KnowledgeChunksListInput,
  type KnowledgeChunkUpdateInput,
  type KnowledgeDocumentRebuildInput,
  type KnowledgeLibraryRebuildInput,
  type KnowledgeReferenceContextInput,
  type KnowledgeRetrievalResponse,
  type KnowledgeSettingsUpdateInput
} from '../../shared/knowledge-contracts'
import type {
  KnowledgeTaskItem,
  KnowledgeTaskKind,
  KnowledgeTaskScope,
  KnowledgeTaskStage,
  KnowledgeTaskStatus
} from '../../shared/knowledge-task-contracts'
import type { RerankExecutionDiagnostics } from '../../shared/rerank-contracts'
import { classifyEmbeddingError } from './embedding-errors'
import { classifyRerankError } from './rerank-errors'
import { embeddingStorageProvider } from './embedding-provider-key'
import {
  EmbeddingIndexCoordinator,
  type EmbeddingIndexProvider
} from './embedding-index-coordinator'
import { KnowledgeEmbeddingIndexRepository } from './knowledge-embedding-index-repository'
import type {
  EmbeddingIndexJob,
  EmbeddingConfigurationSummary,
  KnowledgeEmbeddingIndexSnapshot
} from '../../shared/embedding-contracts'
import {
  extractKnowledgeGraph,
  normalizeEntityAlias,
  type ExtractStructured,
  type GraphChunk,
  type GraphExtractionResult
} from './graph-extractor'
import {
  KnowledgeDatabase,
  type PreparedEmbeddingReplacement
} from './knowledge-database'
import {
  containsHanText,
  contextualIndexText,
  knowledgeRetrievalTerms
} from './retrieval-text'
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
  RerankProvider,
  ReplaceChunkInput,
  SearchResult
} from './types'
import { UrlImporter } from './url-importer'
import { mimeTypeFromFileName } from '../file-media-type'
import {
  isPathInside,
  readBoundedFile
} from '../workspace-file-access'

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

export type KnowledgeTaskSnapshot = KnowledgeTaskItem

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
  rerankProvider?: RerankProvider
  embeddingBatchSize?: number
  parseDocument?: (
    name: string,
    buffer: Buffer,
    purpose: 'knowledge-index',
    signal?: AbortSignal
  ) => Promise<ParsedDocument>
}

const supportedExtensions = new Set<string>(supportedDocumentExtensions)
const maximumFileBytes = 20 * 1024 * 1024
const maximumSourceBytes = 500 * 1024 * 1024
const maximumFilesPerSource = 2_000
const maximumEmbeddingChunksPerBatch = 32

type PreparedDocumentPublication = {
  input: Parameters<KnowledgeDatabase['publishDocument']>[0]
  chunks: ReplaceChunkInput[]
  graph?: GraphExtractionResult
  embeddingReplacement?: PreparedEmbeddingReplacement
  embeddingFailure?: {
    provider: string
    model: string
    message: string
  }
  embeddingTaskId: string
  graphTaskId: string
}

interface PreparedQueryEmbedding {
  provider?: EmbeddingProvider
  providerStorageKey?: string
  vector?: readonly number[]
  durationMs: number
  degradationReason?: string
}

function embedKnowledgeDocuments(
  provider: EmbeddingProvider,
  input: readonly string[],
  signal?: AbortSignal
): Promise<number[][]> {
  return provider.embedDocuments
    ? provider.embedDocuments(input, signal)
    : provider.embed(input, signal)
}

function embedKnowledgeQuery(
  provider: EmbeddingProvider,
  input: readonly string[],
  signal?: AbortSignal
): Promise<number[][]> {
  return provider.embedQuery
    ? provider.embedQuery(input, signal)
    : provider.embed(input, signal)
}

export class KnowledgeService {
  readonly database: KnowledgeDatabase
  private readonly managedRoot: string
  private readonly extractStructured?: ExtractStructured
  private readonly urlImporter: UrlImporter
  private readonly documentParser: NonNullable<
    KnowledgeServiceOptions['parseDocument']
  >
  private embeddingProvider?: EmbeddingProvider
  private rerankProvider?: RerankProvider
  private readonly embeddingBatchSize: number
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly syncTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly embeddingEditTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >()
  private readonly activeSyncs = new Map<string, Promise<void>>()
  private readonly activeDocumentRebuilds = new Map<
    string,
    Promise<Document>
  >()
  private readonly documentMutationTails = new Map<string, Promise<void>>()
  private readonly backgroundEmbeddingReindexes = new Map<
    string,
    Promise<void>
  >()
  private readonly pendingEmbeddingReindexes = new Set<string>()
  private readonly backgroundGraphReindexes = new Map<
    string,
    Promise<void>
  >()
  private readonly pendingGraphReindexes = new Set<string>()
  private readonly taskControllers = new Map<string, AbortController>()
  private readonly taskOperations = new Map<string, Promise<unknown>>()
  private readonly sourceSyncTaskIds = new Map<string, string>()
  private readonly libraryRebuildControllers = new Map<
    string,
    AbortController
  >()
  private readonly embeddingIndexCoordinators = new Map<
    string,
    EmbeddingIndexCoordinator
  >()
  private readonly lifecycleController = new AbortController()

  constructor(options: KnowledgeServiceOptions) {
    this.database = new KnowledgeDatabase(options.databasePath)
    this.managedRoot = resolve(options.managedRoot)
    this.extractStructured = options.extractStructured
    this.urlImporter = options.urlImporter ?? new UrlImporter()
    this.documentParser =
      options.parseDocument ??
      ((name, buffer) => parseDocument(name, buffer))
    this.embeddingProvider = options.embeddingProvider
    this.rerankProvider = options.rerankProvider
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
      for (const source of this.database.listSourcesForSnapshot(library.id)) {
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
    this.database.interruptActiveKnowledgeTasks('应用关闭，任务已中断')
    for (const controller of this.taskControllers.values()) {
      controller.abort(new Error('Knowledge task cancelled during shutdown'))
    }
    for (const controller of this.libraryRebuildControllers.values()) {
      controller.abort(new Error('Knowledge rebuild cancelled during shutdown'))
    }
    for (const timer of this.syncTimers.values()) {
      clearTimeout(timer)
    }
    this.syncTimers.clear()
    for (const timer of this.embeddingEditTimers.values()) {
      clearTimeout(timer)
    }
    this.embeddingEditTimers.clear()
    this.pendingEmbeddingReindexes.clear()
    for (const watcher of this.watchers.values()) {
      watcher.close()
    }
    this.watchers.clear()
    const embeddingCompletions = [
      ...this.embeddingIndexCoordinators.values()
    ].map((coordinator) => {
      coordinator.cancel()
      return coordinator.waitForCompletion()
    })
    await Promise.allSettled([
      ...this.activeSyncs.values(),
      ...this.activeDocumentRebuilds.values(),
      ...this.documentMutationTails.values(),
      ...this.backgroundEmbeddingReindexes.values(),
      ...this.backgroundGraphReindexes.values(),
      ...this.taskOperations.values(),
      ...embeddingCompletions
    ])
    this.taskControllers.clear()
    this.taskOperations.clear()
    this.sourceSyncTaskIds.clear()
    this.libraryRebuildControllers.clear()
    this.documentMutationTails.clear()
    this.database.close()
  }

  setEmbeddingProvider(provider?: EmbeddingProvider): Promise<void> {
    const previous = this.embeddingProvider
    if (
      previous &&
      (!provider ||
        embeddingStorageProvider(previous) !==
          embeddingStorageProvider(provider) ||
        previous.model !== provider.model)
    ) {
      for (const coordinator of this.embeddingIndexCoordinators.values()) {
        coordinator.cancel()
      }
    }
    this.embeddingProvider = provider
    return Promise.resolve()
  }

  setRerankProvider(provider?: RerankProvider): Promise<void> {
    this.rerankProvider = provider
    return Promise.resolve()
  }

  async getEmbeddingIndexSnapshot(
    knowledgeBaseId: string,
    configuration?: EmbeddingConfigurationSummary
  ): Promise<KnowledgeEmbeddingIndexSnapshot> {
    const library = this.requireLibrary(knowledgeBaseId)
    const provider = this.embeddingProvider
    const coordinator =
      await this.getEmbeddingIndexCoordinator(library.id)
    const fallbackTotal = provider
      ? 0
      : this.database.countEmbeddingIndexDocuments(library.id)
    this.reconcileEmbeddingTask(library.id, coordinator.status().job)
    return {
      knowledgeBaseId: library.id,
      enabled: Boolean(provider),
      ...(provider && configuration ? { configuration } : {}),
      coverage: provider
        ? this.database.getEmbeddingIndexCoverage(
            library.id,
            embeddingStorageProvider(provider),
            provider.model
          )
        : {
            total: fallbackTotal,
            indexed: 0,
            missing: fallbackTotal,
            error: 0
          },
      indexStatus: coordinator.status()
    }
  }

  async rebuildEmbeddingIndex(
    knowledgeBaseId: string,
    configuration: EmbeddingConfigurationSummary,
    retryOfTaskId?: string
  ): Promise<KnowledgeEmbeddingIndexSnapshot> {
    const provider = this.embeddingProvider
    if (!provider) {
      throw new Error('请先启用并保存向量模型设置')
    }
    const coordinator =
      await this.getEmbeddingIndexCoordinator(knowledgeBaseId)
    const job = coordinator.startRebuild(provider as EmbeddingIndexProvider)
    this.createKnowledgeTask({
      libraryId: knowledgeBaseId,
      retryOfTaskId,
      documentName: this.requireLibrary(knowledgeBaseId).name,
      scope: 'library',
      kind: 'embedding-rebuild',
      stage: 'queued',
      message: '等待重建向量索引',
      dedupeKey: `embedding-rebuild:${knowledgeBaseId}`,
      embeddingJobId: job.id,
      attempt:
        retryOfTaskId
          ? (this.database.getKnowledgeTask(retryOfTaskId)?.attempt ?? 0) + 1
          : 1,
      totalItems: job.progress.total
    })
    return this.getEmbeddingIndexSnapshot(
      knowledgeBaseId,
      configuration
    )
  }

  async cancelEmbeddingIndex(
    knowledgeBaseId: string,
    jobId: string
  ): Promise<boolean> {
    this.requireLibrary(knowledgeBaseId)
    const coordinator =
      await this.getEmbeddingIndexCoordinator(knowledgeBaseId)
    return coordinator.cancel(jobId)
  }

  private async getEmbeddingIndexCoordinator(
    knowledgeBaseId: string
  ): Promise<EmbeddingIndexCoordinator> {
    const existing = this.embeddingIndexCoordinators.get(knowledgeBaseId)
    if (existing) {
      return existing
    }
    const coordinator = new EmbeddingIndexCoordinator(
      new KnowledgeEmbeddingIndexRepository(
        this.database,
        knowledgeBaseId
      )
    )
    await coordinator.initialize()
    const concurrent = this.embeddingIndexCoordinators.get(knowledgeBaseId)
    if (concurrent) {
      return concurrent
    }
    this.embeddingIndexCoordinators.set(knowledgeBaseId, coordinator)
    return coordinator
  }

  private createKnowledgeTask(input: {
    libraryId: string
    parentTaskId?: string
    retryOfTaskId?: string
    sourceId?: string
    documentId?: string
    documentName: string
    scope?: KnowledgeTaskScope
    kind: KnowledgeTaskKind
    stage?: KnowledgeTaskStage
    status?: KnowledgeTaskStatus
    progress?: number
    completedItems?: number
    totalItems?: number
    message?: string
    error?: KnowledgeTaskItem['error']
    attempt?: number
    dedupeKey?: string
    embeddingJobId?: string
  }): KnowledgeTaskItem {
    return this.database.createKnowledgeTask({
      ...input,
      scope:
        input.scope ??
        (input.documentId
          ? 'document'
          : input.sourceId
            ? 'source'
            : 'library')
    })
  }

  private updateKnowledgeTask(
    taskId: string,
    update: {
      status?: KnowledgeTaskSnapshot['status']
      progress?: number
      message?: string
      documentId?: string
      documentName?: string
      stage?: KnowledgeTaskStage
      completedItems?: number
      totalItems?: number
      embeddingJobId?: string
    }
  ): void {
    this.database.updateKnowledgeTask(taskId, {
      ...update,
      progress:
        update.progress === undefined
          ? undefined
          : Math.max(0, Math.min(100, Math.round(update.progress)))
    })
  }

  private static taskErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : '任务失败'
    return message.slice(0, 1_000) || '任务失败'
  }

  private failKnowledgeTask(taskId: string, error: unknown): void {
    const current = this.database.getKnowledgeTask(taskId)
    if (
      current?.status === 'succeeded' ||
      current?.status === 'skipped'
    ) {
      return
    }
    const message = KnowledgeService.taskErrorMessage(error)
    this.database.updateKnowledgeTask(taskId, {
      status: 'failed',
      message,
      error: { message }
    })
  }

  private registerTaskController(
    taskId: string,
    controller: AbortController
  ): void {
    this.taskControllers.set(taskId, controller)
  }

  private releaseTaskController(
    taskId: string,
    controller: AbortController
  ): void {
    if (this.taskControllers.get(taskId) === controller) {
      this.taskControllers.delete(taskId)
    }
  }

  private trackTaskOperation<T>(
    taskId: string,
    operation: Promise<T>
  ): Promise<T> {
    this.taskOperations.set(taskId, operation)
    void operation
      .finally(() => {
        if (this.taskOperations.get(taskId) === operation) {
          this.taskOperations.delete(taskId)
        }
      })
      .catch(() => undefined)
    return operation
  }

  private async cancelTasks(
    tasks: readonly KnowledgeTaskItem[],
    reason: string
  ): Promise<void> {
    const operations = new Set<Promise<unknown>>()
    const pending = [...tasks]
    const visited = new Set<string>()
    while (pending.length > 0) {
      const task = pending.pop()
      if (!task || visited.has(task.id)) {
        continue
      }
      visited.add(task.id)
      const controller = this.taskControllers.get(task.id)
      if (controller && !controller.signal.aborted) {
        controller.abort(new Error(reason))
      }
      const operation = this.taskOperations.get(task.id)
      if (operation) {
        operations.add(operation)
      }
      if (task.parentTaskId) {
        const parent = this.database.getKnowledgeTask(task.parentTaskId)
        if (parent) {
          pending.push(parent)
        }
      }
    }
    await Promise.allSettled(operations)
  }

  private async withDocumentMutation<T>(
    documentId: string,
    operation: () => Promise<T> | T,
    signal?: AbortSignal
  ): Promise<T> {
    const previous = this.documentMutationTails.get(documentId)
    let release: (() => void) | undefined
    const tail = new Promise<void>((resolve) => {
      release = resolve
    })
    this.documentMutationTails.set(documentId, tail)
    try {
      await previous
      signal?.throwIfAborted()
      this.lifecycleController.signal.throwIfAborted()
      return await operation()
    } finally {
      release?.()
      if (this.documentMutationTails.get(documentId) === tail) {
        this.documentMutationTails.delete(documentId)
      }
    }
  }

  private async prepareDocumentEmbeddings(
    documentId: string,
    chunks: readonly ReplaceChunkInput[],
    signal?: AbortSignal
  ): Promise<PreparedEmbeddingReplacement | undefined> {
    const provider = this.embeddingProvider
    if (!provider) {
      return undefined
    }
    const effectiveSignal = signal
      ? AbortSignal.any([signal, this.lifecycleController.signal])
      : this.lifecycleController.signal
    const providerStorageKey = embeddingStorageProvider(provider)
    const indexableChunks = chunks.filter(
      (chunk) =>
        (chunk.enabled ?? true) &&
        (chunk.role ?? 'standalone') !== 'parent'
    )
    const replacementId =
      this.database.beginPreparedDocumentEmbeddingReplacement(
        documentId,
        providerStorageKey,
        provider.model
      )
    try {
      let expectedDimensions: number | undefined
      for (
        let offset = 0;
        offset < indexableChunks.length;
        offset += this.embeddingBatchSize
      ) {
        effectiveSignal.throwIfAborted()
        const batch = indexableChunks.slice(
          offset,
          offset + this.embeddingBatchSize
        )
        const contents = batch.map((chunk) =>
          contextualIndexText(
            chunk.content,
            chunk.metadata?.contextPrefix
          )
        )
        const vectors = await embedKnowledgeDocuments(
          provider,
          contents,
          effectiveSignal
        )
        effectiveSignal.throwIfAborted()
        if (vectors.length !== batch.length) {
          throw new Error('Embedding provider returned an invalid result count')
        }
        const embeddings = batch.map((chunk, index) => {
          const vector = vectors[index]
          if (!vector) {
            throw new Error('Embedding provider returned an incomplete batch')
          }
          if (expectedDimensions === undefined) {
            expectedDimensions = vector.length
          } else if (vector.length !== expectedDimensions) {
            throw new Error(
              'Embedding provider returned inconsistent dimensions'
            )
          }
          return {
            chunkId: chunk.id!,
            contentChecksum: createHash('sha256')
              .update(contents[index]!)
              .digest('hex'),
            vector
          }
        })
        this.database.appendPreparedDocumentEmbeddingBatch(
          replacementId,
          documentId,
          providerStorageKey,
          provider.model,
          embeddings
        )
      }
      effectiveSignal.throwIfAborted()
      if (this.embeddingProvider !== provider) {
        throw new Error('向量模型配置已变化')
      }
      return {
        replacementId,
        provider: providerStorageKey,
        model: provider.model
      }
    } catch (error) {
      this.database.discardDocumentEmbeddingReplacement(replacementId)
      throw error
    }
  }

  private async prepareDocumentPublication(
    input: PreparedDocumentPublication['input'],
    parsed: ParsedDocument,
    library: KnowledgeBase,
    signal?: AbortSignal,
    parentTaskId?: string
  ): Promise<PreparedDocumentPublication> {
    signal?.throwIfAborted()
    const documentId = input.id ?? randomUUID()
    const chunks = this.createDocumentChunks(parsed, library)
    let embeddingReplacement: PreparedEmbeddingReplacement | undefined
    let embeddingFailure: PreparedDocumentPublication['embeddingFailure']
    const embeddingProvider = this.embeddingProvider
    const embeddingTask = this.createKnowledgeTask({
      libraryId: library.id,
      parentTaskId,
      sourceId: input.sourceId,
      documentName: input.title,
      scope: 'document',
      kind: 'embedding'
    })
    if (!embeddingProvider) {
      this.updateKnowledgeTask(embeddingTask.id, {
        status: 'skipped',
        message: '未启用向量化'
      })
    } else {
      this.updateKnowledgeTask(embeddingTask.id, {
        status: 'running',
        stage: 'embedding',
        progress: 5,
        message: '正在生成候选向量索引'
      })
    }
    try {
      embeddingReplacement = await this.prepareDocumentEmbeddings(
        documentId,
        chunks,
        signal
      )
      if (embeddingReplacement) {
        this.updateKnowledgeTask(embeddingTask.id, {
          progress: 90,
          message: `已生成 ${chunks.length} 个候选分块向量`
        })
      }
    } catch (error) {
      if (signal?.aborted) {
        this.database.cancelKnowledgeTask(embeddingTask.id, '文档处理已取消')
        throw signal.reason
      }
      const safeError = classifyEmbeddingError(error)
      if (embeddingProvider) {
        this.failKnowledgeTask(embeddingTask.id, safeError)
        embeddingFailure = {
          provider: embeddingStorageProvider(embeddingProvider),
          model: embeddingProvider.model,
          message: safeError.message
        }
      } else {
        this.updateKnowledgeTask(embeddingTask.id, {
          status: 'skipped',
          message: '未启用向量化'
        })
      }
    }
    let graph: GraphExtractionResult | undefined
    const graphTask = this.createKnowledgeTask({
      libraryId: library.id,
      parentTaskId,
      sourceId: input.sourceId,
      documentName: input.title,
      scope: 'document',
      kind: 'graph'
    })
    try {
      signal?.throwIfAborted()
      if (library.graphEnabled && library.graphStrategy !== 'ask') {
        this.updateKnowledgeTask(graphTask.id, {
          status: 'running',
          stage: 'graph',
          progress: 10,
          message: '正在抽取候选知识图谱'
        })
        graph = await this.extractGraphChunks(library, chunks, signal)
        this.updateKnowledgeTask(graphTask.id, {
          progress: 90,
          message: `已生成 ${graph.entities.length} 个候选实体、${graph.relations.length} 条候选关系`
        })
      } else {
        this.updateKnowledgeTask(graphTask.id, {
          status: 'skipped',
          message: library.graphEnabled
            ? '按需询问策略不自动抽取'
            : '知识图谱未启用'
        })
      }
      signal?.throwIfAborted()
    } catch (error) {
      if (embeddingReplacement) {
        this.database.discardDocumentEmbeddingReplacement(
          embeddingReplacement.replacementId
        )
        if (signal?.aborted) {
          this.database.cancelKnowledgeTask(
            embeddingTask.id,
            '文档处理已取消'
          )
        } else {
          this.updateKnowledgeTask(embeddingTask.id, {
            status: 'skipped',
            message: '因文档发布前处理失败而未保存向量'
          })
        }
      } else if (
        !embeddingFailure &&
        !['skipped', 'failed'].includes(
          this.database.getKnowledgeTask(embeddingTask.id)?.status ?? ''
        )
      ) {
        if (signal?.aborted) {
          this.database.cancelKnowledgeTask(
            embeddingTask.id,
            '文档处理已取消'
          )
        } else {
          this.updateKnowledgeTask(embeddingTask.id, {
            status: 'skipped',
            message: '因文档发布前处理失败而未保存向量'
          })
        }
      }
      if (signal?.aborted) {
        this.database.cancelKnowledgeTask(graphTask.id, '文档处理已取消')
      } else {
        this.failKnowledgeTask(graphTask.id, error)
      }
      throw error
    }
    return {
      input: { ...input, id: documentId },
      chunks,
      graph,
      embeddingReplacement,
      embeddingFailure,
      embeddingTaskId: embeddingTask.id,
      graphTaskId: graphTask.id
    }
  }

  private publishPreparedDocument(
    library: KnowledgeBase,
    prepared: PreparedDocumentPublication
  ): Document {
    try {
      const document = this.database.publishDocument(
        prepared.input,
        prepared.chunks,
        {
          embeddingReplacement: prepared.embeddingReplacement,
          embeddingError: prepared.embeddingFailure,
          afterChunksInserted: prepared.graph
            ? (document) => {
                this.storeExtractedGraph(library, document, prepared.graph!)
              }
            : undefined
        }
      )
      if (prepared.embeddingReplacement) {
        this.updateKnowledgeTask(prepared.embeddingTaskId, {
          documentId: document.id,
          documentName: document.title,
          status: 'succeeded',
          message: `已发布 ${prepared.chunks.length} 个分块向量`
        })
      } else {
        this.updateKnowledgeTask(prepared.embeddingTaskId, {
          documentId: document.id,
          documentName: document.title
        })
      }
      if (prepared.graph) {
        this.updateKnowledgeTask(prepared.graphTaskId, {
          documentId: document.id,
          documentName: document.title,
          status: 'succeeded',
          message: `已发布 ${prepared.graph.entities.length} 个实体、${prepared.graph.relations.length} 条关系`
        })
      } else {
        this.updateKnowledgeTask(prepared.graphTaskId, {
          documentId: document.id,
          documentName: document.title
        })
      }
      return document
    } catch (error) {
      const currentEmbeddingTask =
        this.database.getKnowledgeTask(prepared.embeddingTaskId)
      if (prepared.embeddingReplacement) {
        try {
          this.database.discardDocumentEmbeddingReplacement(
            prepared.embeddingReplacement.replacementId
          )
        } catch {
          // The enclosing database transaction may already have rolled back.
        }
        this.failKnowledgeTask(prepared.embeddingTaskId, error)
      } else if (
        currentEmbeddingTask?.status === 'queued' ||
        currentEmbeddingTask?.status === 'running'
      ) {
        this.updateKnowledgeTask(prepared.embeddingTaskId, {
          status: 'skipped',
          message: '因文档发布失败而未保存向量'
        })
      }
      if (prepared.graph) {
        this.failKnowledgeTask(prepared.graphTaskId, error)
      }
      throw error
    }
  }

  private reconcileEmbeddingTask(
    libraryId: string,
    job: EmbeddingIndexJob | null
  ): void {
    if (!job) {
      return
    }
    const task =
      this.database.getKnowledgeTaskByEmbeddingJobId(libraryId, job.id) ??
      this.createKnowledgeTask({
        libraryId,
        documentName: this.requireLibrary(libraryId).name,
        scope: 'library',
        kind: 'embedding-rebuild',
        stage: job.status === 'queued' ? 'queued' : 'embedding',
        status:
          job.status === 'completed'
            ? 'succeeded'
            : job.status === 'failed'
              ? 'failed'
              : job.status,
        progress: Math.round(job.progress.percent),
        completedItems: job.progress.completed,
        totalItems: job.progress.total,
        message: '向量索引重建',
        error:
          job.status === 'failed'
            ? { message: job.error?.message ?? '向量索引重建失败' }
            : undefined,
        embeddingJobId: job.id
      })
    const status: KnowledgeTaskStatus =
      job.status === 'completed'
        ? 'succeeded'
        : job.status === 'failed'
          ? 'failed'
          : job.status
    const stage = status === 'succeeded' ? 'finalizing' : 'embedding'
    const progress = Math.round(job.progress.percent)
    const message =
      status === 'succeeded'
        ? '向量索引重建完成'
        : status === 'cancelled'
          ? '向量索引重建已取消'
          : '正在重建向量索引'
    const error =
      status === 'failed'
        ? {
            message: job.error?.message ?? '向量索引重建失败',
            remedy: job.error?.remedy
          }
        : undefined
    if (
      task.status === status &&
      task.stage === stage &&
      task.progress === progress &&
      task.completedItems === job.progress.completed &&
      task.totalItems === job.progress.total &&
      task.message === message &&
      task.error?.message === error?.message &&
      task.error?.remedy === error?.remedy
    ) {
      return
    }
    this.database.updateKnowledgeTask(task.id, {
      status,
      stage,
      progress,
      completedItems: job.progress.completed,
      totalItems: job.progress.total,
      message,
      error: error ?? null
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
    for (const source of this.database.listSourcesForSnapshot(id)) {
      this.stopWatcher(source.id)
    }
    await this.cancelTasks(
      this.database.listActiveKnowledgeTasks(id),
      'Knowledge library deleted'
    )
    const embeddingCoordinator = this.embeddingIndexCoordinators.get(id)
    embeddingCoordinator?.cancel()
    await embeddingCoordinator?.waitForCompletion()
    this.embeddingIndexCoordinators.delete(id)
    const deleted = this.database.deleteKnowledgeBase(id)
    if (deleted && library.storageMode === 'managed') {
      const path = join(this.managedRoot, id)
      if (isPathInside(this.managedRoot, path)) {
        await rm(path, { recursive: true, force: true })
      }
    }
    return deleted
  }

  snapshot(selectedLibraryId?: string): KnowledgeSnapshot {
    const libraryCounts = this.database.getKnowledgeBaseCounts()
    const libraries = this.database.listKnowledgeBases().map((library) => {
      const counts = libraryCounts.get(library.id) ?? {
        sourceCount: 0,
        documentCount: 0,
        indexedDocumentCount: 0
      }
      return {
        ...library,
        ...counts
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
    const embeddingCoordinator =
      this.embeddingIndexCoordinators.get(libraryId)
    if (embeddingCoordinator) {
      this.reconcileEmbeddingTask(
        libraryId,
        embeddingCoordinator.status().job
      )
    }
    const libraryDocuments =
      this.database.listDocumentsForSnapshot(libraryId)
    const documentCountsBySource = new Map<string, number>()
    for (const document of libraryDocuments) {
      documentCountsBySource.set(
        document.sourceId,
        (documentCountsBySource.get(document.sourceId) ?? 0) + 1
      )
    }
    const sources = this.database
      .listSourcesForSnapshot(libraryId)
      .map((source) => ({
      ...source,
      documentCount: documentCountsBySource.get(source.id) ?? 0,
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
    const chunkCounts = this.database.getDocumentChunkCounts(libraryId)
    const documents = libraryDocuments.map((document) => {
      const status =
        typeof document.metadata.status === 'string' &&
        ['queued', 'parsing', 'indexing', 'ready', 'failed'].includes(
          document.metadata.status
        )
          ? (document.metadata.status as KnowledgeDocumentSnapshot['status'])
          : 'ready'
      return {
        ...document,
        chunkCount: chunkCounts.get(document.id) ?? 0,
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
    const graph = this.database.listGraphSnapshot(libraryId)
    return {
      libraries,
      sources,
      documents,
      entities: graph.entities,
      relations: graph.relations,
      evidence: graph.evidence,
      tasks: this.database.listKnowledgeTasks(libraryId)
    }
  }

  search(knowledgeBaseId: string, query: string, limit = 6): SearchResult[] {
    return this.database.search({
      knowledgeBaseId,
      query,
      limit
    })
  }

  async retrieve(
    rawInput: unknown,
    signal?: AbortSignal,
    preparedQueryEmbedding?: PreparedQueryEmbedding
  ): Promise<KnowledgeRetrievalResponse> {
    const input = knowledgeRetrieveInputSchema.parse(rawInput)
    const library = this.requireLibrary(input.knowledgeBaseId)
    const settings = input.settings ?? library.retrievalSettings
    const hasHanQuery = containsHanText(input.query)
    const startedAt = Date.now()
    const requestedChannels: Array<'fts' | 'cjk' | 'vector' | 'graph'> = []
    if (settings.ftsWeight > 0) {
      requestedChannels.push('fts')
      if (hasHanQuery) {
        requestedChannels.push('cjk')
      }
    }
    if (settings.vectorWeight > 0) {
      requestedChannels.push('vector')
    }
    if (settings.graphWeight > 0) {
      requestedChannels.push('graph')
    }
    const degradedChannels: Array<{
      channel: 'fts' | 'cjk' | 'vector' | 'graph'
      reason: string
    }> = []
    const preparedEmbedding =
      settings.vectorWeight > 0
        ? preparedQueryEmbedding ??
          await this.prepareQueryEmbedding(input.query, signal)
        : { durationMs: 0 }
    const {
      provider,
      providerStorageKey,
      vector,
      durationMs: vectorDurationMs
    } = preparedEmbedding
    if (settings.vectorWeight > 0) {
      if (preparedEmbedding.degradationReason) {
        degradedChannels.push({
          channel: 'vector',
          reason: preparedEmbedding.degradationReason
        })
      }
    }
    if (settings.graphWeight > 0 && !library.graphEnabled) {
      degradedChannels.push({
        channel: 'graph',
        reason: '知识图谱未启用。'
      })
    }

    const retrievalStartedAt = Date.now()
    const candidateLimit = Math.min(
      100,
      settings.topK * settings.candidateMultiplier
    )
    const searchPage = this.database.hybridSearchWithDiagnostics({
      knowledgeBaseId: library.id,
      query: input.query,
      limit: candidateLimit,
      provider: vector ? providerStorageKey : undefined,
      model: vector ? provider?.model : undefined,
      vector,
      graphEnabled: library.graphEnabled,
      minimumVectorSimilarity: settings.minimumVectorSimilarity,
      candidateMultiplier: 1,
      ftsWeight: settings.ftsWeight,
      vectorWeight: settings.vectorWeight,
      graphWeight: settings.graphWeight,
      signal
    })
    const candidates = searchPage.results
    const vectorScannedCount = searchPage.vectorScannedCount
    if (
      settings.vectorWeight > 0 &&
      provider &&
      providerStorageKey &&
      vector &&
      vectorScannedCount === 0
    ) {
      degradedChannels.push({
        channel: 'vector',
        reason: '当前向量模型没有可用的兼容索引。'
      })
    }
    const retrievalDurationMs = Date.now() - retrievalStartedAt
    const maximumScore = Math.max(
      ...candidates.map((candidate) => candidate.retrieval.score),
      0.000_001
    )
    const queryTerms = knowledgeRetrievalTerms(input.query, 64)
    const documentOccurrences = new Map<string, number>()
    type ScoredCandidate = {
      candidate: HybridSearchResult
      relevance: number
      coverage: number
      phrase: boolean
      duplicatePenalty: number
      preRerankRank: number
      rerankScore?: number
    }
    let scored: ScoredCandidate[] = candidates.map((candidate, index) => {
      const indexContent =
        contextualIndexText(
          candidate.chunk.content,
          candidate.chunk.metadata.contextPrefix
        )
          .normalize('NFKC')
          .toLowerCase()
      const matched = queryTerms.filter((term) =>
        indexContent.includes(term)
      ).length
      const coverage =
        queryTerms.length === 0 ? 0 : matched / queryTerms.length
      const phrase = indexContent.includes(
        input.query.normalize('NFKC').trim().toLowerCase()
      )
      const titleAndPath = `${candidate.document.title}\n${candidate.source.location}`
        .normalize('NFKC')
        .toLowerCase()
      const metadataMatch = queryTerms.some((term) =>
        titleAndPath.includes(term)
      )
      const duplicateIndex =
        documentOccurrences.get(candidate.document.id) ?? 0
      documentOccurrences.set(candidate.document.id, duplicateIndex + 1)
      const base = candidate.retrieval.score / maximumScore
      const similarity =
        candidate.retrieval.similarity === undefined
          ? 0
          : (candidate.retrieval.similarity + 1) / 2
      const duplicatePenalty = Math.min(0.3, duplicateIndex * 0.08)
      const localRelevance = Math.max(
        0,
        Math.min(
          1,
          base * 0.4 +
            coverage * 0.3 +
            (phrase ? 0.12 : 0) +
            (metadataMatch ? 0.08 : 0) +
            similarity * 0.1 -
            duplicatePenalty
        )
      )
      const relevance =
        settings.rerankMode === 'none'
          ? Math.max(0, Math.min(1, base))
          : localRelevance
      return {
        candidate,
        relevance,
        coverage,
        phrase,
        duplicatePenalty,
        preRerankRank: index + 1
      }
    })
    const localRerank = (): void => {
      scored.sort(
        (left, right) =>
          right.relevance - left.relevance ||
          left.preRerankRank - right.preRerankRank ||
          left.candidate.chunk.id.localeCompare(right.candidate.chunk.id)
      )
    }
    let rerankDiagnostics: RerankExecutionDiagnostics = {
      requested: settings.rerankMode,
      used: 'none',
      status: 'skipped',
      candidateCount: candidates.length,
      durationMs: 0
    }
    if (settings.rerankMode === 'local') {
      const rerankStartedAt = Date.now()
      localRerank()
      rerankDiagnostics = {
        requested: 'local',
        used: 'local',
        status: 'applied',
        candidateCount: candidates.length,
        durationMs: Date.now() - rerankStartedAt
      }
    } else if (settings.rerankMode === 'learned') {
      const rerankStartedAt = Date.now()
      const rerankProvider = this.rerankProvider
      if (!rerankProvider || scored.length === 0) {
        const reason = rerankProvider
          ? '没有可供重排的候选。'
          : '未配置可用的学习型重排模型。'
        if (scored.length > 0) {
          localRerank()
          rerankDiagnostics = {
            requested: 'learned',
            used: 'local',
            status: 'fallback',
            candidateCount: candidates.length,
            durationMs: Date.now() - rerankStartedAt,
            reason
          }
        } else {
          rerankDiagnostics = {
            requested: 'learned',
            used: 'none',
            status: scored.length === 0 ? 'skipped' : 'fallback',
            candidateCount: candidates.length,
            durationMs: Date.now() - rerankStartedAt,
            reason
          }
        }
      } else {
        const effectiveSignal = signal
          ? AbortSignal.any([signal, this.lifecycleController.signal])
          : this.lifecycleController.signal
        try {
          const reranked = await rerankProvider.rerank(
            input.query,
            scored.map((item) =>
              `${item.candidate.document.title}\n${
                item.candidate.chunk.heading ?? ''
              }\n${item.candidate.chunk.content}`.slice(0, 8_000)
            ),
            Math.min(settings.topK, scored.length),
            effectiveSignal
          )
          effectiveSignal.throwIfAborted()
          const byIndex = new Map(
            reranked.map((result) => [result.index, result.relevanceScore])
          )
          scored = scored
            .map((item, index) => ({
              ...item,
              relevance: byIndex.get(index) ?? item.relevance,
              rerankScore: byIndex.get(index)
            }))
            .sort((left, right) => {
              const leftScore = left.rerankScore
              const rightScore = right.rerankScore
              if (leftScore === undefined && rightScore !== undefined) {
                return 1
              }
              if (leftScore !== undefined && rightScore === undefined) {
                return -1
              }
              return (
                (rightScore ?? 0) - (leftScore ?? 0) ||
                left.preRerankRank - right.preRerankRank
              )
            })
          rerankDiagnostics = {
            requested: 'learned',
            used: 'learned',
            status: 'applied',
            candidateCount: candidates.length,
            durationMs: Date.now() - rerankStartedAt,
            model: rerankProvider.model
          }
        } catch (error) {
          if (effectiveSignal.aborted) {
            throw effectiveSignal.reason
          }
          const safeError = classifyRerankError(error)
          localRerank()
          rerankDiagnostics = {
            requested: 'learned',
            used: 'local',
            status: 'fallback',
            candidateCount: candidates.length,
            durationMs: Date.now() - rerankStartedAt,
            reason: safeError.message
          }
        }
      }
    }
    const selected = scored.slice(0, settings.topK)
    const usedChannels = new Set<'fts' | 'cjk' | 'vector' | 'graph'>()
    const results = selected.map((item, index) => {
      const channels = item.candidate.retrieval.channels.flatMap((channel) => {
        if (channel === 'fts' && hasHanQuery) {
          return ['fts', 'cjk'] as const
        }
        return [channel]
      })
      for (const channel of channels) {
        usedChannels.add(channel)
      }
      return {
        knowledgeBaseId: library.id,
        documentId: item.candidate.document.id,
        sourceId: item.candidate.source.id,
        chunkId: item.candidate.chunk.id,
        parentChunkId: item.candidate.chunk.parentChunkId,
        documentTitle: item.candidate.document.title,
        sourceDisplayName: item.candidate.source.displayName,
        sourceType: item.candidate.source.type,
        heading: item.candidate.chunk.heading,
        location: item.candidate.chunk.location,
        snippet: item.candidate.snippet.slice(0, 8_000),
        relevance: item.relevance,
        rank: index + 1,
        preRerankRank: rerankDiagnostics.used !== 'none'
          ? item.preRerankRank
          : undefined,
        channels: [...new Set(channels)],
        scores: {
          ftsRank: item.candidate.retrieval.lexicalRank,
          cjkRank: hasHanQuery
            ? item.candidate.retrieval.lexicalRank
            : undefined,
          vectorRank: item.candidate.retrieval.vectorRank,
          graphRank: item.candidate.retrieval.graphRank,
          vectorSimilarity: item.candidate.retrieval.similarity,
          fusedScore: item.candidate.retrieval.score,
          phraseMatch: item.phrase,
          tokenCoverage: item.coverage,
          duplicatePenalty: item.duplicatePenalty,
          rerankScore: item.rerankScore
        }
      }
    })
    if (
      library.graphEnabled &&
      settings.graphWeight > 0 &&
      !usedChannels.has('graph')
    ) {
      degradedChannels.push({
        channel: 'graph',
        reason: '知识图谱没有找到可用证据。'
      })
    }

    let remaining = settings.contextMaxCharacters
    let contextTruncated = false
    let filteredByBudgetCount = 0
    const emittedChunks = new Set<string>()
    const groups: KnowledgeRetrievalResponse['context']['groups'] = []
    for (const result of results) {
      const reference = this.database.getChunkForReference(
        result.knowledgeBaseId,
        result.documentId,
        result.chunkId
      )
      if (!reference) {
        continue
      }
      const chunks = this.database
        .listContextChunks(reference.chunk, settings.adjacentChunkCount)
        .filter((chunk) => !emittedChunks.has(chunk.id))
      if (chunks.length === 0) {
        continue
      }
      const fullContent = chunks.map((chunk) => chunk.content).join('\n\n')
      if (remaining <= 0) {
        filteredByBudgetCount += 1
        contextTruncated = true
        continue
      }
      const content =
        fullContent.length <= remaining
          ? fullContent
          : this.truncateContext(fullContent, remaining)
      const truncated = content.length < fullContent.length
      if (truncated) {
        contextTruncated = true
      }
      for (const chunk of chunks) {
        emittedChunks.add(chunk.id)
      }
      groups.push({
        resultChunkId: result.chunkId,
        chunkIds: chunks.map((chunk) => chunk.id),
        documentId: result.documentId,
        content,
        characterCount: content.length,
        truncated
      })
      remaining -= content.length
    }
    const lexicalCandidates = candidates.filter((candidate) =>
      candidate.retrieval.channels.includes('fts')
    ).length
    const vectorCandidates = candidates.filter((candidate) =>
      candidate.retrieval.channels.includes('vector')
    ).length
    const graphCandidates = candidates.filter((candidate) =>
      candidate.retrieval.channels.includes('graph')
    ).length
    return {
      query: input.query,
      durationMs: Date.now() - startedAt,
      settings,
      diagnostics: {
        requestedChannels,
        usedChannels: [...usedChannels],
        degradedChannels,
        candidateCounts: {
          fts: lexicalCandidates,
          cjk: hasHanQuery ? lexicalCandidates : undefined,
          vector: vectorCandidates,
          graph: graphCandidates
        },
        channelDurationMs: {
          fts: retrievalDurationMs,
          cjk: hasHanQuery ? retrievalDurationMs : undefined,
          vector: vectorDurationMs,
          graph: retrievalDurationMs
        },
        vectorScannedCount,
        filteredByThresholdCount: Math.max(
          0,
          vectorScannedCount - vectorCandidates
        ),
        filteredByBudgetCount,
        rerank: rerankDiagnostics
      },
      results,
      context: {
        characterCount:
          settings.contextMaxCharacters - remaining,
        truncated: contextTruncated,
        groups
      }
    }
  }

  async retrieveMany(
    knowledgeBaseIds: readonly string[],
    query: string,
    signal?: AbortSignal
  ): Promise<
    Array<{
      knowledgeBaseId: string
      response: KnowledgeRetrievalResponse
    }>
  > {
    const libraries = knowledgeBaseIds.map((id) =>
      this.requireLibrary(id)
    )
    const preparedEmbedding = libraries.some(
      (library) => library.retrievalSettings.vectorWeight > 0
    )
      ? await this.prepareQueryEmbedding(query, signal)
      : undefined
    signal?.throwIfAborted()
    return Promise.all(
      libraries.map(async (library) => ({
        knowledgeBaseId: library.id,
        response: await this.retrieve(
          {
            knowledgeBaseId: library.id,
            query
          },
          signal,
          preparedEmbedding
        )
      }))
    )
  }

  updateSettings(rawInput: KnowledgeSettingsUpdateInput): KnowledgeBase {
    const input = knowledgeSettingsUpdateInputSchema.parse(rawInput)
    return this.database.updateKnowledgeSettings(input)
  }

  listChunks(input: KnowledgeChunksListInput) {
    return this.database.listChunksPage(
      knowledgeChunksListInputSchema.parse(input)
    )
  }

  async updateChunk(
    rawInput: KnowledgeChunkUpdateInput
  ): Promise<ReturnType<KnowledgeDatabase['updateChunk']>> {
    const input = knowledgeChunkUpdateInputSchema.parse(rawInput)
    return this.withDocumentMutation(input.documentId, async () => {
      const current = this.database.getChunkForReference(
        input.knowledgeBaseId,
        input.documentId,
        input.chunkId
      )?.chunk
      const chunk = this.database.updateChunk(input)
      if (
        current &&
        (
          (input.content !== undefined &&
            input.content !== current.content) ||
          (input.enabled !== undefined &&
            input.enabled !== current.enabled)
        )
      ) {
        this.scheduleEmbeddingReindex(input.documentId)
        const library = this.requireLibrary(input.knowledgeBaseId)
        if (library.graphEnabled && library.graphStrategy !== 'ask') {
          this.scheduleGraphReindex(input.documentId)
        }
      }
      this.database.pruneUnreferencedGeneratedGraph(input.knowledgeBaseId)
      return chunk
    })
  }

  async deleteChunk(rawInput: KnowledgeChunkDeleteInput): Promise<boolean> {
    const input = knowledgeChunkDeleteInputSchema.parse(rawInput)
    return this.withDocumentMutation(input.documentId, async () => {
      const deleted = this.database.deleteChunk(input)
      if (deleted) {
        this.scheduleEmbeddingReindex(input.documentId)
        const library = this.requireLibrary(input.knowledgeBaseId)
        if (library.graphEnabled && library.graphStrategy !== 'ask') {
          this.scheduleGraphReindex(input.documentId)
        }
        this.database.pruneUnreferencedGeneratedGraph(
          input.knowledgeBaseId
        )
      }
      return deleted
    })
  }

  getReferenceContext(rawInput: KnowledgeReferenceContextInput) {
    const input = knowledgeReferenceContextInputSchema.parse(rawInput)
    const reference = this.database.getChunkForReference(
      input.knowledgeBaseId,
      input.documentId,
      input.chunkId
    )
    if (!reference || !reference.chunk.enabled) {
      return undefined
    }
    return {
      ...reference,
      contextChunks: this.database.listContextChunks(reference.chunk, 2)
    }
  }

  async searchHybrid(
    knowledgeBaseId: string,
    query: string,
    limit = 6,
    signal?: AbortSignal
  ): Promise<HybridSearchResult[]> {
    const library = this.requireLibrary(knowledgeBaseId)
    const settings = library.retrievalSettings
    const vector = await this.embedQuery(query, signal)
    return this.database.hybridSearch({
      knowledgeBaseId,
      query,
      limit: Math.min(limit, settings.topK),
      provider:
        vector && this.embeddingProvider
          ? embeddingStorageProvider(this.embeddingProvider)
          : undefined,
      model: vector ? this.embeddingProvider?.model : undefined,
      vector,
      graphEnabled: library.graphEnabled,
      minimumVectorSimilarity: settings.minimumVectorSimilarity,
      candidateMultiplier: settings.candidateMultiplier,
      ftsWeight: settings.ftsWeight,
      vectorWeight: settings.vectorWeight,
      graphWeight: settings.graphWeight,
      signal
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
      const settings = library.retrievalSettings
      return this.database
        .hybridSearch({
          knowledgeBaseId,
          query,
          limit: limitPerLibrary,
          provider:
            vector && this.embeddingProvider
              ? embeddingStorageProvider(this.embeddingProvider)
              : undefined,
          model: vector ? this.embeddingProvider?.model : undefined,
          vector,
          graphEnabled: library.graphEnabled,
          minimumVectorSimilarity: settings.minimumVectorSimilarity,
          candidateMultiplier: settings.candidateMultiplier,
          ftsWeight: settings.ftsWeight,
          vectorWeight: settings.vectorWeight,
          graphWeight: settings.graphWeight,
          signal
        })
        .map((result) => ({ knowledgeBaseId, result }))
    }).sort(
      (left, right) =>
        right.result.retrieval.score - left.result.retrieval.score ||
        left.result.chunk.id.localeCompare(right.result.chunk.id)
    ).slice(0, limitPerLibrary)
  }

  private async embedQuery(
    query: string,
    signal?: AbortSignal
  ): Promise<readonly number[] | undefined> {
    return (await this.prepareQueryEmbedding(query, signal)).vector
  }

  private async prepareQueryEmbedding(
    query: string,
    signal?: AbortSignal
  ): Promise<PreparedQueryEmbedding> {
    const provider = this.embeddingProvider
    if (!provider) {
      return {
        durationMs: 0,
        degradationReason: '未配置向量模型，已使用本地全文检索。'
      }
    }
    const startedAt = Date.now()
    const effectiveSignal = signal
      ? AbortSignal.any([signal, this.lifecycleController.signal])
      : this.lifecycleController.signal
    try {
      const result = await embedKnowledgeQuery(
        provider,
        [query],
        effectiveSignal
      )
      const vector = result.length === 1 ? result[0] : undefined
      if (
        !vector ||
        vector.length === 0 ||
        vector.some((value) => !Number.isFinite(value)) ||
        vector.every((value) => value === 0)
      ) {
        return {
          provider,
          providerStorageKey: embeddingStorageProvider(provider),
          durationMs: Date.now() - startedAt,
          degradationReason: '向量服务返回了无效的查询向量。'
        }
      }
      return {
        provider,
        providerStorageKey: embeddingStorageProvider(provider),
        vector,
        durationMs: Date.now() - startedAt
      }
    } catch (error) {
      if (effectiveSignal.aborted) {
        throw effectiveSignal.reason
      }
      return {
        provider,
        providerStorageKey: embeddingStorageProvider(provider),
        durationMs: Date.now() - startedAt,
        degradationReason: classifyEmbeddingError(error).message
      }
    }
  }

  async importPaths(
    knowledgeBaseId: string,
    selectedPaths: string[],
    graphStrategy?: Exclude<GraphStrategy, 'ask'>
  ): Promise<void> {
    const library = this.requireLibrary(knowledgeBaseId)
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
      const sourceTask = this.createKnowledgeTask({
        libraryId: library.id,
        sourceId: source.id,
        documentName: source.displayName,
        scope: 'source',
        kind: 'source-sync',
        stage: 'syncing',
        status: 'running',
        progress: 0,
        message: '正在导入知识来源',
        dedupeKey: `source-sync:${source.id}`
      })
      const controller = new AbortController()
      this.registerTaskController(sourceTask.id, controller)
      this.sourceSyncTaskIds.set(source.id, sourceTask.id)
      const effectiveSignal = AbortSignal.any([
        controller.signal,
        this.lifecycleController.signal
      ])
      const operation = (async (): Promise<void> => {
        try {
          effectiveSignal.throwIfAborted()
          if (library.storageMode === 'managed') {
            await this.copySupportedSource(canonicalPath, target)
            effectiveSignal.throwIfAborted()
          }
          await this.indexSource(
            library,
            source,
            effectiveSignal,
            sourceTask.id,
            graphStrategy
          )
          effectiveSignal.throwIfAborted()
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
          this.updateKnowledgeTask(sourceTask.id, {
            status: 'succeeded',
            stage: 'finalizing',
            message: '知识来源导入完成'
          })
        } catch (error) {
          if (effectiveSignal.aborted) {
            this.database.cancelKnowledgeTask(
              sourceTask.id,
              '知识来源导入已取消'
            )
          } else {
            this.failKnowledgeTask(sourceTask.id, error)
          }
          if (this.database.getSource(source.id)) {
            this.database.upsertSource({
              ...source,
              status: effectiveSignal.aborted ? 'paused' : 'error',
              lastError:
                effectiveSignal.aborted
                  ? null
                  : error instanceof Error
                    ? error.message.slice(0, 1_000)
                    : '来源导入失败',
              metadata: {
                ...source.metadata,
                progress: 0
              }
            })
          }
          throw error
        }
      })()
      this.trackTaskOperation(sourceTask.id, operation)
      try {
        await operation
      } finally {
        this.releaseTaskController(sourceTask.id, controller)
        if (this.sourceSyncTaskIds.get(source.id) === sourceTask.id) {
          this.sourceSyncTaskIds.delete(source.id)
        }
      }
    }
  }

  private trackStandaloneUrlImport(
    taskId: string,
    operation: Promise<void>,
    controller?: AbortController
  ): Promise<void> {
    if (!controller) {
      return operation
    }
    return this.trackTaskOperation(taskId, operation)
  }

  async importUrl(
    knowledgeBaseId: string,
    input: string,
    signal: AbortSignal,
    sourceId?: string,
    graphStrategy?: Exclude<GraphStrategy, 'ask'>,
    parentTaskId?: string,
    mutationDocumentId?: string,
    documentMutationHeld = false
  ): Promise<void> {
    const library = this.requireLibrary(knowledgeBaseId)
    const parsingTask = this.createKnowledgeTask({
      libraryId: library.id,
      parentTaskId,
      sourceId,
      documentName: new URL(input).hostname,
      scope: sourceId ? 'document' : 'source',
      kind: 'document-process'
    })
    const controller = parentTaskId ? undefined : new AbortController()
    if (controller) {
      this.registerTaskController(parsingTask.id, controller)
    }
    const effectiveSignal = AbortSignal.any([
      signal,
      this.lifecycleController.signal,
      AbortSignal.timeout(60_000),
      ...(controller ? [controller.signal] : [])
    ])
    const operation = (async (): Promise<void> => {
      let result: Awaited<ReturnType<UrlImporter['import']>>
      try {
        effectiveSignal.throwIfAborted()
        this.updateKnowledgeTask(parsingTask.id, {
          status: 'running',
          stage: 'reading',
          progress: 10,
          message: '正在抓取并解析网页'
        })
        result = await this.urlImporter.import(input, effectiveSignal)
        effectiveSignal.throwIfAborted()
        this.updateKnowledgeTask(parsingTask.id, {
          stage: 'indexing',
          progress: 70,
          message: '正在保存网页内容'
        })
      } catch (error) {
        if (effectiveSignal.aborted) {
          this.database.cancelKnowledgeTask(parsingTask.id, '网页处理已取消')
        } else {
          this.failKnowledgeTask(parsingTask.id, error)
        }
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
        effectiveSignal.throwIfAborted()
        const effectiveLibrary = this.resolveImportLibrary(
          knowledgeBaseId,
          graphStrategy
        )
        const previousDocument = mutationDocumentId
          ? this.database.getDocument(mutationDocumentId)
          : this.database
              .listDocumentsForSource(source.id)
              .find((document) => document.externalId === result.url)
        const documentId =
          mutationDocumentId ?? previousDocument?.id ?? randomUUID()
        const publish = async (): Promise<Document> => {
            const prepared = await this.prepareDocumentPublication(
              {
                id: documentId,
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
              result.document,
              effectiveLibrary,
              effectiveSignal,
              parsingTask.id
            )
            return this.publishPreparedDocument(effectiveLibrary, prepared)
        }
        const document = documentMutationHeld
          ? await publish()
          : await this.withDocumentMutation(
              documentId,
              publish,
              effectiveSignal
            )
        this.updateKnowledgeTask(parsingTask.id, {
          documentId: document.id,
          documentName: document.title,
          stage: 'finalizing',
          progress: 92,
          message: '网页解析与索引完成'
        })
        effectiveSignal.throwIfAborted()
        source = this.database.upsertSource({
          ...source,
          status: 'ready',
          metadata: {
            ...source.metadata,
            progress: 100,
            lastSyncedAt: new Date().toISOString()
          }
        })
        this.updateKnowledgeTask(parsingTask.id, {
          status: 'succeeded',
          stage: 'finalizing',
          message: '网页处理完成'
        })
      } catch (error) {
        if (effectiveSignal.aborted) {
          this.database.cancelKnowledgeTask(parsingTask.id, '网页处理已取消')
        } else {
          this.failKnowledgeTask(parsingTask.id, error)
        }
        if (!effectiveSignal.aborted) {
          this.database.upsertSource({
            ...source,
            status: 'error',
            lastError:
              error instanceof Error
                ? error.message.slice(0, 1_000)
                : 'URL 导入失败'
          })
        }
        throw error
      }
    })()
    this.trackStandaloneUrlImport(parsingTask.id, operation, controller)
    try {
      await operation
    } finally {
      if (controller) {
        this.releaseTaskController(parsingTask.id, controller)
      }
    }
  }

  pauseSource(sourceId: string): void {
    const source = this.requireSource(sourceId)
    this.stopWatcher(sourceId)
    const taskId = this.sourceSyncTaskIds.get(sourceId)
    const controller = taskId
      ? this.taskControllers.get(taskId)
      : undefined
    controller?.abort(new Error('Knowledge source paused'))
    this.database.upsertSource({
      ...source,
      status: 'paused'
    })
  }

  async syncSource(sourceId: string): Promise<void> {
    return this.syncSourceOperation(sourceId)
  }

  private async syncSourceOperation(
    sourceId: string,
    retryOfTaskId?: string
  ): Promise<void> {
    const existing = this.activeSyncs.get(sourceId)
    if (existing) {
      return existing
    }
    const operation = this.performSyncSource(
      sourceId,
      retryOfTaskId
    ).finally(() => {
      if (this.activeSyncs.get(sourceId) === operation) {
        this.activeSyncs.delete(sourceId)
      }
    })
    this.activeSyncs.set(sourceId, operation)
    return operation
  }

  async retrySource(sourceId: string): Promise<void> {
    return this.syncSource(sourceId)
  }

  async rebuildDocument(
    rawInput: KnowledgeDocumentRebuildInput,
    signal?: AbortSignal,
    parentTaskId?: string,
    retryOfTaskId?: string
  ): Promise<Document> {
    const input = knowledgeDocumentRebuildInputSchema.parse(rawInput)
    const existing = this.activeDocumentRebuilds.get(input.documentId)
    if (existing) {
      return existing
    }
    const operation = this.performRebuildDocument(
      input,
      signal,
      parentTaskId,
      retryOfTaskId
    ).finally(() => {
      if (this.activeDocumentRebuilds.get(input.documentId) === operation) {
        this.activeDocumentRebuilds.delete(input.documentId)
      }
    })
    this.activeDocumentRebuilds.set(input.documentId, operation)
    return operation
  }

  private async performRebuildDocument(
    input: KnowledgeDocumentRebuildInput,
    signal?: AbortSignal,
    parentTaskId?: string,
    retryOfTaskId?: string
  ): Promise<Document> {
    return this.withDocumentMutation(
      input.documentId,
      () =>
        this.performRebuildDocumentMutation(
          input,
          signal,
          parentTaskId,
          retryOfTaskId
        ),
      signal
    )
  }

  private async performRebuildDocumentMutation(
    input: KnowledgeDocumentRebuildInput,
    signal?: AbortSignal,
    parentTaskId?: string,
    retryOfTaskId?: string
  ): Promise<Document> {
    const document = this.database.getDocument(input.documentId)
    if (!document || document.knowledgeBaseId !== input.knowledgeBaseId) {
      throw new Error('文档不属于指定知识库')
    }
    const library = this.requireLibrary(input.knowledgeBaseId)
    const source = this.database.getSource(document.sourceId)
    if (!source) {
      throw new Error('知识来源不存在')
    }
    const task = this.createKnowledgeTask({
      libraryId: library.id,
      parentTaskId,
      retryOfTaskId,
      sourceId: source.id,
      documentId: document.id,
      documentName: document.title,
      scope: 'document',
      kind: 'document-rebuild',
      dedupeKey: parentTaskId
        ? undefined
        : `document-rebuild:${document.id}`,
      attempt:
        retryOfTaskId
          ? (this.database.getKnowledgeTask(retryOfTaskId)?.attempt ?? 0) + 1
          : 1
    })
    const ownController = parentTaskId ? undefined : new AbortController()
    if (ownController) {
      this.registerTaskController(task.id, ownController)
    }
    const signals = [this.lifecycleController.signal]
    if (signal) {
      signals.push(signal)
    }
    if (ownController) {
      signals.push(ownController.signal)
    }
    const effectiveSignal = AbortSignal.any(signals)
    const operation = (async (): Promise<Document> => {
      effectiveSignal.throwIfAborted()
      if (source.type === 'url') {
        this.updateKnowledgeTask(task.id, {
          status: 'running',
          stage: 'reading',
          progress: 5,
          message: '正在重新抓取网页'
        })
        await this.importUrl(
          library.id,
          source.location,
          effectiveSignal,
          source.id,
          undefined,
          task.id,
          document.id,
          true
        )
        effectiveSignal.throwIfAborted()
        const rebuilt = this.database.getDocument(document.id) ?? document
        this.updateKnowledgeTask(task.id, {
          status: 'succeeded',
          stage: 'finalizing',
          message: '文档重建完成'
        })
        return rebuilt
      }
      const location = document.sourceLocation
      if (!location) {
        throw new Error('文档没有可重建的原始文件位置')
      }
      const fileStat = await lstat(location)
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw new Error('原始文件不存在或不是普通文件')
      }
      this.updateKnowledgeTask(task.id, {
        status: 'running',
        stage: 'reading',
        progress: 5,
        message: '正在读取文档'
      })
      const buffer = await readBoundedFile(
        location,
        maximumFileBytes,
        '文件超过 20MB',
        '文件不是普通文件'
      )
      effectiveSignal.throwIfAborted()
      this.updateKnowledgeTask(task.id, {
        stage: 'parsing',
        progress: 20,
        message: '正在解析文档'
      })
      const parsed = await this.documentParser(
        basename(location),
        buffer,
        'knowledge-index',
        effectiveSignal
      )
      effectiveSignal.throwIfAborted()
      this.updateKnowledgeTask(task.id, {
        stage: 'chunking',
        progress: 45,
        message: '正在切分文档'
      })
      const prepared = await this.prepareDocumentPublication(
        {
          ...document,
          checksum: createHash('sha256').update(buffer).digest('hex'),
          metadata: {
            ...document.metadata,
            status: 'ready',
            size: fileStat.size
          }
        },
        parsed,
        library,
        effectiveSignal,
        task.id
      )
      this.updateKnowledgeTask(task.id, {
        stage: 'finalizing',
        progress: 92,
        message: '正在发布重建结果'
      })
      effectiveSignal.throwIfAborted()
      const rebuilt = this.publishPreparedDocument(library, prepared)
      this.updateKnowledgeTask(task.id, {
        status: 'succeeded',
        stage: 'finalizing',
        message: '文档重建完成'
      })
      return rebuilt
    })()
    this.trackTaskOperation(task.id, operation)
    try {
      return await operation
    } catch (error) {
      if (effectiveSignal.aborted) {
        this.database.cancelKnowledgeTask(task.id, '文档重建已取消')
      } else {
        this.failKnowledgeTask(task.id, error)
      }
      throw error
    } finally {
      if (ownController) {
        this.releaseTaskController(task.id, ownController)
      }
    }
  }

  async rebuildLibrary(
    rawInput: KnowledgeLibraryRebuildInput,
    signal?: AbortSignal,
    retryOfTaskId?: string
  ): Promise<{ rebuilt: number; failed: number }> {
    const input = knowledgeLibraryRebuildInputSchema.parse(rawInput)
    const library = this.requireLibrary(input.knowledgeBaseId)
    const ownController = new AbortController()
    const previous = this.libraryRebuildControllers.get(library.id)
    if (previous) {
      throw new Error('知识库重建已在进行中')
    }
    this.libraryRebuildControllers.set(library.id, ownController)
    const effectiveSignal = signal
      ? AbortSignal.any([
          signal,
          ownController.signal,
          this.lifecycleController.signal
        ])
      : AbortSignal.any([ownController.signal, this.lifecycleController.signal])
    const documents = this.database.listDocumentsForLibraryRebuild(library.id)
    const task = this.createKnowledgeTask({
      libraryId: library.id,
      retryOfTaskId,
      documentName: library.name,
      scope: 'library',
      kind: 'library-rebuild',
      stage: 'queued',
      totalItems: documents.length,
      message: '等待重建知识库',
      dedupeKey: `library-rebuild:${library.id}`,
      attempt:
        retryOfTaskId
          ? (this.database.getKnowledgeTask(retryOfTaskId)?.attempt ?? 0) + 1
          : 1
    })
    this.registerTaskController(task.id, ownController)
    let rebuilt = 0
    let failed = 0
    const operation = (async (): Promise<{
      rebuilt: number
      failed: number
    }> => {
      this.updateKnowledgeTask(task.id, {
        status: 'running',
        stage: 'parsing',
        message: '正在重建知识库'
      })
      for (const document of documents) {
        effectiveSignal.throwIfAborted()
        try {
          await this.rebuildDocument(
            {
              knowledgeBaseId: library.id,
              documentId: document.id
            },
            effectiveSignal,
            task.id
          )
          rebuilt += 1
        } catch {
          if (effectiveSignal.aborted) {
            throw effectiveSignal.reason
          }
          failed += 1
        }
        this.updateKnowledgeTask(task.id, {
          progress: ((rebuilt + failed) / Math.max(documents.length, 1)) * 100,
          completedItems: rebuilt + failed,
          totalItems: documents.length,
          message: `已处理 ${rebuilt + failed}/${documents.length} 个文档`
        })
      }
      if (failed === 0) {
        this.database.markKnowledgeChunkingRebuilt(library.id)
        if (library.graphEnabled && library.graphStrategy !== 'ask') {
          this.database.markKnowledgeOntologyRebuilt(library.id)
        }
      }
      if (failed === 0) {
        this.updateKnowledgeTask(task.id, {
          status: 'succeeded',
          stage: 'finalizing',
          message: `已重建 ${rebuilt} 个文档`
        })
      } else {
        this.database.updateKnowledgeTask(task.id, {
          status: 'failed',
          stage: 'finalizing',
          message: `${failed} 个文档重建失败`,
          error: { message: `${failed} 个文档重建失败` }
        })
      }
      return { rebuilt, failed }
    })()
    this.trackTaskOperation(task.id, operation)
    try {
      return await operation
    } catch (error) {
      if (effectiveSignal.aborted) {
        this.database.cancelKnowledgeTask(task.id, '知识库重建已取消')
      } else {
        this.failKnowledgeTask(task.id, error)
      }
      throw error
    } finally {
      this.releaseTaskController(task.id, ownController)
      if (this.libraryRebuildControllers.get(library.id) === ownController) {
        this.libraryRebuildControllers.delete(library.id)
      }
    }
  }

  cancelLibraryRebuild(knowledgeBaseId: string): boolean {
    const controller = this.libraryRebuildControllers.get(knowledgeBaseId)
    if (!controller || controller.signal.aborted) {
      return false
    }
    controller.abort(new Error('Knowledge library rebuild cancelled'))
    return true
  }

  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.database.getKnowledgeTask(taskId)
    if (!task || !task.canCancel) {
      return false
    }
    if (task.kind === 'embedding-rebuild' && task.embeddingJobId) {
      const coordinator =
        await this.getEmbeddingIndexCoordinator(task.libraryId)
      const cancelled = coordinator.cancel(task.embeddingJobId)
      if (cancelled) {
        this.database.cancelKnowledgeTask(task.id, '向量索引重建已取消')
      }
      return cancelled
    }
    if (
      task.kind === 'library-rebuild' &&
      this.cancelLibraryRebuild(task.libraryId)
    ) {
      this.database.cancelKnowledgeTask(task.id, '知识库重建已取消')
      return true
    }
    const controller = this.taskControllers.get(task.id)
    if (controller && !controller.signal.aborted) {
      controller.abort(new Error('Knowledge task cancelled'))
      this.database.cancelKnowledgeTask(task.id)
      return true
    }
    return false
  }

  async retryTask(taskId: string): Promise<void> {
    const task = this.database.getKnowledgeTask(taskId)
    if (!task || !task.canRetry) {
      throw new Error('该任务当前不可重试')
    }
    switch (task.kind) {
      case 'source-sync': {
        if (!task.sourceId) {
          throw new Error('任务缺少知识来源')
        }
        await this.syncSourceOperation(task.sourceId, task.id)
        return
      }
      case 'document-rebuild': {
        if (!task.documentId) {
          throw new Error('任务缺少文档')
        }
        await this.rebuildDocument(
          {
            knowledgeBaseId: task.libraryId,
            documentId: task.documentId
          },
          undefined,
          undefined,
          task.id
        )
        return
      }
      case 'library-rebuild':
        await this.rebuildLibrary(
          { knowledgeBaseId: task.libraryId },
          undefined,
          task.id
        )
        return
      case 'graph-rebuild':
        await this.reextractGraph(task.libraryId, task.id)
        return
      case 'embedding-rebuild': {
        const provider = this.embeddingProvider
        if (!provider) {
          throw new Error('请先启用并保存向量模型设置')
        }
        await this.rebuildEmbeddingIndex(
          task.libraryId,
          {
            provider: provider.provider,
            model: provider.model,
            credentialConfigured: false
          },
          task.id
        )
        return
      }
      default:
        throw new Error('该任务类型不支持重试')
    }
  }

  async reextractGraph(
    knowledgeBaseId: string,
    retryOfTaskId?: string
  ): Promise<void> {
    const existing = this.database.getActiveKnowledgeTaskByDedupeKey(
      knowledgeBaseId,
      `graph-rebuild:${knowledgeBaseId}`
    )
    const existingOperation = existing
      ? this.taskOperations.get(existing.id)
      : undefined
    if (existingOperation) {
      await existingOperation
      return
    }
    await this.performReextractGraph(knowledgeBaseId, retryOfTaskId)
  }

  private async performReextractGraph(
    knowledgeBaseId: string,
    retryOfTaskId?: string
  ): Promise<void> {
    const library = this.requireLibrary(knowledgeBaseId)
    if (!library.graphEnabled) {
      throw new Error('请先启用知识图谱')
    }
    if (library.graphStrategy === 'ask') {
      throw new Error('按需询问策略不会自动抽取，请在设置中选择其他策略')
    }
    const documents =
      this.database.listDocumentsForLibraryRebuild(library.id)
    const parentTask = this.createKnowledgeTask({
      libraryId: library.id,
      retryOfTaskId,
      documentName: library.name,
      scope: 'library',
      kind: 'graph-rebuild',
      stage: 'graph',
      status: 'running',
      totalItems: documents.length,
      message: '正在重建知识图谱',
      dedupeKey: `graph-rebuild:${library.id}`,
      attempt:
        retryOfTaskId
          ? (this.database.getKnowledgeTask(retryOfTaskId)?.attempt ?? 0) + 1
          : 1
    })
    const controller = new AbortController()
    this.registerTaskController(parentTask.id, controller)
    const effectiveSignal = AbortSignal.any([
      controller.signal,
      this.lifecycleController.signal
    ])
    const tasks: KnowledgeTaskItem[] = []
    const operation = (async (): Promise<void> => {
      for (let index = 0; index < documents.length; index += 1) {
        effectiveSignal.throwIfAborted()
        const document = documents[index]
        if (!document) {
          continue
        }
        const task = this.createKnowledgeTask({
          libraryId: library.id,
          parentTaskId: parentTask.id,
          sourceId: document.sourceId,
          documentId: document.id,
          documentName: document.title,
          kind: 'graph',
          message: '等待重新抽取'
        })
        tasks.push(task)
        try {
          await this.withDocumentMutation(
            document.id,
            async () => {
              this.updateKnowledgeTask(task.id, {
                status: 'running',
                progress: 10,
                message: '正在重新抽取知识图谱'
              })
              const result = await this.extractGraphResult(
                library,
                document,
                effectiveSignal
              )
              effectiveSignal.throwIfAborted()
              this.updateKnowledgeTask(task.id, {
                progress: 85,
                message: '正在保存实体和关系'
              })
              this.database.replaceEvidenceForDocument(document.id, () => {
                this.storeExtractedGraph(library, document, result)
              })
              effectiveSignal.throwIfAborted()
              this.updateKnowledgeTask(task.id, {
                status: 'succeeded',
                message: `已抽取 ${result.entities.length} 个实体、${result.relations.length} 条关系`
              })
            },
            effectiveSignal
          )
          this.updateKnowledgeTask(parentTask.id, {
            progress: ((index + 1) / Math.max(documents.length, 1)) * 100,
            completedItems: index + 1,
            totalItems: documents.length,
            message: `已处理 ${index + 1}/${documents.length} 个文档`
          })
        } catch (error) {
          if (effectiveSignal.aborted) {
            this.database.cancelKnowledgeTask(
              task.id,
              '知识图谱重建已取消'
            )
          } else {
            this.failKnowledgeTask(task.id, error)
          }
          throw error
        }
      }
      effectiveSignal.throwIfAborted()
      this.database.pruneUnreferencedGeneratedGraph(library.id)
      this.database.markKnowledgeOntologyRebuilt(library.id)
      this.updateKnowledgeTask(parentTask.id, {
        status: 'succeeded',
        stage: 'finalizing',
        message: `已重建 ${documents.length} 个文档的知识图谱`
      })
    })()
    this.trackTaskOperation(parentTask.id, operation)
    try {
      await operation
    } catch (error) {
      if (effectiveSignal.aborted) {
        this.database.cancelKnowledgeTask(
          parentTask.id,
          '知识图谱重建已取消'
        )
      } else {
        this.failKnowledgeTask(parentTask.id, error)
      }
      for (const childTask of tasks) {
        const current = this.database.getKnowledgeTask(childTask.id)
        if (current?.status === 'queued' || current?.status === 'running') {
          if (effectiveSignal.aborted) {
            this.database.cancelKnowledgeTask(
              childTask.id,
              '知识图谱重建已取消'
            )
          } else {
            this.updateKnowledgeTask(childTask.id, {
              status: 'skipped',
              message: '因前序图谱任务失败而未执行'
            })
          }
        }
      }
      throw error
    } finally {
      this.releaseTaskController(parentTask.id, controller)
    }
  }

  async removeSource(sourceId: string): Promise<boolean> {
    const source = this.requireSource(sourceId)
    const library = this.requireLibrary(source.knowledgeBaseId)
    this.stopWatcher(sourceId)
    const sourceTaskId = this.sourceSyncTaskIds.get(sourceId)
    await this.cancelTasks(
      this.database
        .listActiveKnowledgeTasks(library.id)
        .filter(
          (task) =>
            task.sourceId === sourceId ||
            (sourceTaskId !== undefined && task.id === sourceTaskId)
        ),
      'Knowledge source deleted'
    )
    const removed = this.database.removeSource(sourceId)
    if (removed) {
      this.database.pruneUnreferencedGeneratedGraph(library.id)
    }
    if (
      removed &&
      library.storageMode === 'managed' &&
      source.type !== 'url' &&
      isPathInside(this.managedRoot, source.location)
    ) {
      await rm(
        join(this.managedRoot, library.id, source.id),
        { recursive: true, force: true }
      )
    }
    return removed
  }

  private async performSyncSource(
    sourceId: string,
    retryOfTaskId?: string
  ): Promise<void> {
    let source = this.requireSource(sourceId)
    const library = this.requireLibrary(source.knowledgeBaseId)
    const task = this.createKnowledgeTask({
      libraryId: library.id,
      sourceId: source.id,
      documentName: source.displayName,
      scope: 'source',
      kind: 'source-sync',
      stage: 'syncing',
      status: 'running',
      message: '正在同步知识来源',
      dedupeKey: `source-sync:${source.id}`,
      retryOfTaskId,
      attempt:
        retryOfTaskId
          ? (this.database.getKnowledgeTask(retryOfTaskId)?.attempt ?? 0) + 1
          : 1
    })
    const controller = new AbortController()
    this.registerTaskController(task.id, controller)
    this.sourceSyncTaskIds.set(source.id, task.id)
    const effectiveSignal = AbortSignal.any([
      controller.signal,
      this.lifecycleController.signal
    ])
    const operation = (async (): Promise<void> => {
      if (source.type === 'url') {
        await this.importUrl(
          library.id,
          source.location,
          effectiveSignal,
          source.id,
          undefined,
          task.id
        )
        this.updateKnowledgeTask(task.id, {
          status: 'succeeded',
          stage: 'finalizing',
          message: '知识来源同步完成'
        })
        return
      }
      source = this.database.upsertSource({
        ...source,
        status: 'indexing',
        lastError: null,
        metadata: { ...source.metadata, progress: 0 }
      })
      await this.indexSource(library, source, effectiveSignal, task.id)
      effectiveSignal.throwIfAborted()
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
      this.updateKnowledgeTask(task.id, {
        status: 'succeeded',
        stage: 'finalizing',
        message: '知识来源同步完成'
      })
    })()
    this.trackTaskOperation(task.id, operation)
    try {
      await operation
    } catch (error) {
      if (effectiveSignal.aborted) {
        this.database.cancelKnowledgeTask(task.id, '知识来源同步已取消')
        if (this.database.getSource(source.id)) {
          this.database.upsertSource({
            ...source,
            status: 'paused',
            lastError: null
          })
        }
      } else {
        this.failKnowledgeTask(task.id, error)
      }
      if (!effectiveSignal.aborted) {
        const currentSource = this.database.getSource(source.id)
        if (currentSource) {
          this.database.upsertSource({
            ...currentSource,
            status: 'error',
            lastError:
              error instanceof Error
                ? error.message.slice(0, 1_000)
                : '同步失败'
          })
        }
      }
      throw error
    } finally {
      this.releaseTaskController(task.id, controller)
      if (this.sourceSyncTaskIds.get(source.id) === task.id) {
        this.sourceSyncTaskIds.delete(source.id)
      }
    }
  }

  private async indexSource(
    library: KnowledgeBase,
    source: KnowledgeSource,
    signal: AbortSignal,
    parentTaskId?: string,
    graphStrategy?: Exclude<GraphStrategy, 'ask'>
  ): Promise<void> {
    signal.throwIfAborted()
    const files = await this.scanSource(source.location)
    signal.throwIfAborted()
    const existing = this.database
      .listDocumentsForSource(source.id)
    const currentExternalIds = new Set(files.map((file) => file.relativePath))
    for (const document of existing) {
      signal.throwIfAborted()
      if (!currentExternalIds.has(document.externalId)) {
        await this.withDocumentMutation(
          document.id,
          () => {
            this.cancelScheduledEmbeddingReindex(document.id)
            return this.database.removeDocument(document.id)
          },
          signal
        )
      }
    }
    if (existing.some(
      (document) => !currentExternalIds.has(document.externalId)
    )) {
      this.database.pruneUnreferencedGeneratedGraph(library.id)
    }

    const failures: string[] = []
    for (let index = 0; index < files.length; index += 1) {
      signal.throwIfAborted()
      const file = files[index]
      if (!file) {
        continue
      }
      const parsingTask = this.createKnowledgeTask({
        libraryId: library.id,
        parentTaskId,
        sourceId: source.id,
        documentName: file.relativePath,
        scope: 'document',
        kind: 'parsing'
      })
      try {
        this.updateKnowledgeTask(parsingTask.id, {
          status: 'running',
          stage: 'reading',
          progress: 10,
          message: '正在读取文档'
        })
        const buffer = await readBoundedFile(
          file.absolutePath,
          maximumFileBytes,
          '文件超过 20MB',
          '文件不是普通文件'
        )
        signal.throwIfAborted()
        this.updateKnowledgeTask(parsingTask.id, {
          stage: 'parsing',
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
        const parsed = await this.documentParser(
          basename(file.absolutePath),
          buffer,
          'knowledge-index',
          signal
        )
        signal.throwIfAborted()
        this.updateKnowledgeTask(parsingTask.id, {
          stage: 'indexing',
          progress: 75,
          message: '正在保存解析结果'
        })
        const effectiveLibrary = this.resolveImportLibrary(
          library.id,
          graphStrategy
        )
        const documentId = previous?.id ?? randomUUID()
        const document = await this.withDocumentMutation(
          documentId,
          async () => {
            const prepared = await this.prepareDocumentPublication(
              {
                id: documentId,
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
              parsed,
              effectiveLibrary,
              signal,
              parsingTask.id
            )
            return this.publishPreparedDocument(effectiveLibrary, prepared)
          },
          signal
        )
        this.updateKnowledgeTask(parsingTask.id, {
          documentId: document.id,
          documentName: document.title,
          stage: 'finalizing',
          progress: 92,
          message: '文档解析与索引完成'
        })
        signal.throwIfAborted()
        this.updateKnowledgeTask(parsingTask.id, {
          status: 'succeeded',
          stage: 'finalizing',
          message: '文档处理完成'
        })
      } catch (error) {
        if (signal.aborted) {
          this.database.cancelKnowledgeTask(
            parsingTask.id,
            '文档处理已取消'
          )
          throw signal.reason
        }
        this.failKnowledgeTask(parsingTask.id, error)
        failures.push(
          `${file.relativePath}: ${
            KnowledgeService.taskErrorMessage(error)
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
      const detail = failures.slice(0, 5).join('；')
      throw new Error(
        `${failures.length} 个文件处理失败：${detail}`.slice(0, 1_000)
      )
    }
  }

  private scheduleEmbeddingReindex(documentId: string): void {
    const existing = this.embeddingEditTimers.get(documentId)
    if (existing) {
      clearTimeout(existing)
    }
    const timer = setTimeout(() => {
      this.embeddingEditTimers.delete(documentId)
      if (this.backgroundEmbeddingReindexes.has(documentId)) {
        this.pendingEmbeddingReindexes.add(documentId)
        return
      }
      this.startBackgroundEmbeddingReindex(documentId)
    }, 250)
    timer.unref?.()
    this.embeddingEditTimers.set(documentId, timer)
  }

  private startBackgroundEmbeddingReindex(documentId: string): void {
    if (
      this.backgroundEmbeddingReindexes.has(documentId) ||
      this.lifecycleController.signal.aborted
    ) {
      return
    }
    const operation = (async () => {
      do {
        this.pendingEmbeddingReindexes.delete(documentId)
        const document = this.database.getDocument(documentId)
        if (
          !document ||
          !this.embeddingProvider ||
          this.lifecycleController.signal.aborted
        ) {
          return
        }
        await this.indexDocumentEmbeddings(document)
      } while (this.pendingEmbeddingReindexes.delete(documentId))
    })()
      .catch(() => undefined)
      .finally(() => {
        this.pendingEmbeddingReindexes.delete(documentId)
        if (
          this.backgroundEmbeddingReindexes.get(documentId) === operation
        ) {
          this.backgroundEmbeddingReindexes.delete(documentId)
        }
      })
    this.backgroundEmbeddingReindexes.set(documentId, operation)
  }

  private cancelScheduledEmbeddingReindex(documentId: string): void {
    const timer = this.embeddingEditTimers.get(documentId)
    if (timer) {
      clearTimeout(timer)
      this.embeddingEditTimers.delete(documentId)
    }
  }

  private scheduleGraphReindex(documentId: string): void {
    if (this.backgroundGraphReindexes.has(documentId)) {
      this.pendingGraphReindexes.add(documentId)
      return
    }
    const operation = (async () => {
      do {
        this.pendingGraphReindexes.delete(documentId)
        const document = this.database.getDocument(documentId)
        if (!document || this.lifecycleController.signal.aborted) {
          return
        }
        const library = this.database.getKnowledgeBase(
          document.knowledgeBaseId
        )
        if (
          !library?.graphEnabled ||
          library.graphStrategy === 'ask'
        ) {
          return
        }
        await this.extractGraphMutation(
          library,
          document,
          undefined,
          this.lifecycleController.signal
        )
      } while (this.pendingGraphReindexes.delete(documentId))
    })()
      .catch(() => undefined)
      .finally(() => {
        this.pendingGraphReindexes.delete(documentId)
        if (this.backgroundGraphReindexes.get(documentId) === operation) {
          this.backgroundGraphReindexes.delete(documentId)
        }
      })
    this.backgroundGraphReindexes.set(documentId, operation)
  }

  private async indexDocumentEmbeddings(
    document: Document,
    requestedProvider?: EmbeddingProvider,
    operationTaskId?: string,
    signal?: AbortSignal
  ): Promise<void> {
    this.cancelScheduledEmbeddingReindex(document.id)
    const provider = requestedProvider ?? this.embeddingProvider
    const task = operationTaskId
      ? this.createKnowledgeTask({
          libraryId: document.knowledgeBaseId,
          parentTaskId: operationTaskId,
          sourceId: document.sourceId,
          documentId: document.id,
          documentName: document.title,
          kind: 'embedding'
        })
      : this.createKnowledgeTask({
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
    const providerStorageKey = embeddingStorageProvider(provider)
    const effectiveSignal = signal
      ? AbortSignal.any([signal, this.lifecycleController.signal])
      : this.lifecycleController.signal
    let replacementId: string | undefined
    try {
      effectiveSignal.throwIfAborted()
      this.updateKnowledgeTask(task.id, {
        status: 'running',
        stage: 'embedding',
        progress: 5,
        message: '正在准备文档分块'
      })
      const chunks = this.database
        .getEmbeddingIndexDocument(document.id)?.items ?? []
      replacementId = this.database.beginDocumentEmbeddingReplacement(
        document.id,
        providerStorageKey,
        provider.model
      )
      let expectedDimensions: number | undefined
      for (
        let offset = 0;
        offset < chunks.length;
        offset += this.embeddingBatchSize
      ) {
        effectiveSignal.throwIfAborted()
        const batch = chunks.slice(offset, offset + this.embeddingBatchSize)
        const vectors = await embedKnowledgeDocuments(
          provider,
          batch.map((chunk) => chunk.content),
          effectiveSignal
        )
        effectiveSignal.throwIfAborted()
        if (vectors.length !== batch.length) {
          throw new Error('Embedding provider returned an invalid result count')
        }
        const embeddings: Array<{
          chunkId: string
          contentChecksum: string
          vector: readonly number[]
        }> = []
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
            contentChecksum:
              chunk.contentChecksum ??
              createHash('sha256').update(chunk.content).digest('hex'),
            vector
          })
        }
        this.database.appendDocumentEmbeddingBatch(
          replacementId,
          document.id,
          providerStorageKey,
          provider.model,
          embeddings
        )
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
      effectiveSignal.throwIfAborted()
      if (this.embeddingProvider !== provider) {
        this.database.discardDocumentEmbeddingReplacement(
          replacementId
        )
        replacementId = undefined
        this.updateKnowledgeTask(task.id, {
          status: 'skipped',
          message: '向量模型配置已变化'
        })
        return
      }
      this.database.finishDocumentEmbeddingReplacement(
        replacementId,
        document.id,
        providerStorageKey,
        provider.model
      )
      replacementId = undefined
      this.updateKnowledgeTask(task.id, {
        status: 'succeeded',
        message: `已向量化 ${chunks.length} 个分块`
      })
    } catch (error) {
      if (replacementId) {
        this.database.discardDocumentEmbeddingReplacement(
          replacementId
        )
      }
      if (effectiveSignal.aborted) {
        this.database.cancelKnowledgeTask(task.id, '向量化已取消')
        throw effectiveSignal.reason
      }
      const safeError = classifyEmbeddingError(error)
      this.failKnowledgeTask(task.id, safeError)
      try {
        this.database.recordEmbeddingIndexError(
          document.id,
          providerStorageKey,
          provider.model,
          safeError.message
        )
      } catch {
        // FTS indexing is authoritative; embedding diagnostics are best effort.
      }
    }
  }

  private async extractGraphMutation(
    library: KnowledgeBase,
    document: Document,
    operationTaskId?: string,
    signal?: AbortSignal
  ): Promise<void> {
    const task = operationTaskId
      ? this.createKnowledgeTask({
          libraryId: library.id,
          parentTaskId: operationTaskId,
          sourceId: document.sourceId,
          documentId: document.id,
          documentName: document.title,
          kind: 'graph'
        })
      : this.createKnowledgeTask({
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
      signal?.throwIfAborted()
      this.updateKnowledgeTask(task.id, {
        status: 'running',
        stage: 'graph',
        progress: 10,
        message: '正在准备图谱抽取'
      })
      const result = await this.extractGraphResult(
        library,
        document,
        signal
      )
      signal?.throwIfAborted()
      this.updateKnowledgeTask(task.id, {
        progress: 85,
        message: '正在保存实体和关系'
      })
      this.database.replaceEvidenceForDocument(document.id, () => {
        this.storeExtractedGraph(library, document, result)
      })
      this.database.pruneUnreferencedGeneratedGraph(library.id)
      signal?.throwIfAborted()
      this.updateKnowledgeTask(task.id, {
        status: 'succeeded',
        message: `已抽取 ${result.entities.length} 个实体、${result.relations.length} 条关系`
      })
    } catch (error) {
      if (signal?.aborted) {
        this.database.cancelKnowledgeTask(task.id, '知识图谱处理已取消')
      } else {
        this.failKnowledgeTask(task.id, error)
      }
      throw error
    }
  }

  private async extractGraphResult(
    library: KnowledgeBase,
    document: Document,
    signal?: AbortSignal
  ): Promise<GraphExtractionResult> {
    return this.extractGraphChunks(
      library,
      this.database.listChunks(document.id, 10_000),
      signal
    )
  }

  private extractGraphChunks(
    library: KnowledgeBase,
    chunks: readonly Pick<ReplaceChunkInput, 'id' | 'content' | 'enabled' | 'role'>[],
    signal?: AbortSignal
  ): Promise<GraphExtractionResult> {
    return extractKnowledgeGraph(
      chunks
        .filter(
          (chunk) =>
            (chunk.enabled ?? true) &&
            (chunk.role ?? 'standalone') !== 'parent'
        )
        .map((chunk): GraphChunk => ({
          id: chunk.id!,
          content: chunk.content
        })),
      {
        strategy: library.graphStrategy,
        ontology: library.ontologySettings,
        extractStructured: this.extractStructured,
        signal
      }
    )
  }

  private storeExtractedGraph(
    library: KnowledgeBase,
    document: Document,
    result: GraphExtractionResult
  ): void {
    const chunksById = new Map(
      this.database
        .listChunks(document.id)
        .map((chunk) => [chunk.id, chunk])
    )
    const entityIds = new Map<string, string>()
    const existingEntitiesByIdentity = new Map<string, GraphEntity>()
    for (const entity of this.database.listEntitiesForIdentity(library.id)) {
      for (const name of [entity.name, ...entity.aliases]) {
        existingEntitiesByIdentity.set(
          `${entity.type}\0${normalizeEntityAlias(name)}`,
          entity
        )
      }
    }
    for (const entity of result.entities) {
      const identity = `${entity.type}\0${normalizeEntityAlias(entity.name)}`
      const existing = existingEntitiesByIdentity.get(identity)
      const stored = existing
        ? existing.locked
          ? existing
          : this.database.updateEntity(existing.id, {
              aliases: [...new Set([...existing.aliases, ...entity.aliases])]
            })
        : this.database.createEntity({
            knowledgeBaseId: library.id,
            name: entity.name,
            type: entity.type,
            aliases: entity.aliases,
            locked: false
          })
      for (const name of [stored.name, ...stored.aliases]) {
        existingEntitiesByIdentity.set(
          `${stored.type}\0${normalizeEntityAlias(name)}`,
          stored
        )
      }
      entityIds.set(entity.id, stored.id)
      for (const evidence of entity.evidence) {
        this.database.createEvidence({
          knowledgeBaseId: library.id,
          entityId: stored.id,
          documentId: document.id,
          chunkId: evidence.chunkId,
          quote: evidence.quote,
          location: chunksById.get(evidence.chunkId)?.location,
          start: evidence.start,
          end: evidence.end,
          confidence: evidence.confidence,
          source: evidence.source,
          provenance: {
            strategy: result.strategy,
            ontologyVersion: library.ontologySettings.version
          }
        })
      }
    }
    for (const relation of result.relations) {
      const sourceEntityId = entityIds.get(relation.sourceId)
      const targetEntityId = entityIds.get(relation.targetId)
      if (!sourceEntityId || !targetEntityId) {
        continue
      }
      const existing = this.database.findRelationByIdentity(
        library.id,
        sourceEntityId,
        targetEntityId,
        relation.type
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
          location: chunksById.get(evidence.chunkId)?.location,
          start: evidence.start,
          end: evidence.end,
          confidence: evidence.confidence,
          source: evidence.source,
          provenance: {
            strategy: result.strategy,
            ontologyVersion: library.ontologySettings.version
          }
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
      if (!isPathInside(targetPath, target)) {
        throw new Error('来源目录包含越界路径')
      }
      await mkdir(resolve(target, '..'), { recursive: true })
      await cp(file.absolutePath, target, {
        force: false,
        errorOnExist: true
      })
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

  private createDocumentChunks(
    parsed: ParsedDocument,
    library: KnowledgeBase
  ): ReplaceChunkInput[] {
    const chunks = chunkDocumentAdvanced(parsed, library.chunkingSettings)
    const ids = chunks.map(() => randomUUID())
    return chunks.map((chunk) => ({
      id: ids[chunk.position],
      ordinal: chunk.position,
      content: chunk.content,
      heading: chunk.heading,
      location: chunk.locator,
      role: chunk.role ?? 'standalone',
      metadata: {
        ...(chunk.pageNumber === undefined
          ? {}
          : { pageNumber: chunk.pageNumber }),
        ...(chunk.headingPath
          ? { headingPath: chunk.headingPath }
          : {}),
        ...(chunk.blockKind ? { blockKind: chunk.blockKind } : {}),
        ...(library.chunkingSettings.contextualIndexingEnabled
          ? {
              contextPrefix: buildChunkContextPrefix(parsed.title, chunk)
            }
          : {})
      },
      parentChunkId:
        chunk.parentPosition === undefined
          ? undefined
          : ids[chunk.parentPosition]
    }))
  }

  private resolveImportLibrary(
    knowledgeBaseId: string,
    graphStrategy?: Exclude<GraphStrategy, 'ask'>
  ): KnowledgeBase {
    const library = this.requireLibrary(knowledgeBaseId)
    return graphStrategy
      ? { ...library, graphStrategy }
      : library
  }

  private truncateContext(value: string, maximum: number): string {
    if (value.length <= maximum) {
      return value
    }
    if (maximum <= 0) {
      return ''
    }
    const candidate = value.slice(0, maximum)
    const minimumBoundary = Math.floor(maximum * 0.7)
    const boundary = Math.max(
      candidate.lastIndexOf('\n\n'),
      candidate.lastIndexOf('\n'),
      candidate.lastIndexOf('。'),
      candidate.lastIndexOf('. ')
    )
    return boundary >= minimumBoundary
      ? candidate.slice(0, boundary + 1).trimEnd()
      : candidate
  }

  private requireLibrary(id: string): KnowledgeBase {
    const library = this.database.getKnowledgeBase(id)
    if (!library) {
      throw new Error('知识库不存在')
    }
    return library
  }

  private requireSource(id: string): KnowledgeSource {
    const source = this.database.getSource(id)
    if (source) {
      return source
    }
    throw new Error('知识来源不存在')
  }
}
