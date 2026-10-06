import { dialog, shell, type BrowserWindow, type ipcMain } from 'electron'
import { lstat, realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  externalKnowledgeInstanceInputSchema,
  externalKnowledgeInstanceEnabledInputSchema,
  externalKnowledgeInstanceSaveInputSchema,
  externalKnowledgeCatalogListInputSchema,
  externalKnowledgeCatalogGetInputSchema,
  externalKnowledgeBindingSaveInputSchema,
  externalKnowledgeBindingUpdateInputSchema,
  externalKnowledgeBindingTestInputSchema
} from '../../shared/external-knowledge-contracts'
import { knowledgeReferenceKey, toKnowledgeReference } from '../../shared/knowledge-reference'
import {
  knowledgeCreateSchema,
  knowledgeEntityUpdateSchema,
  knowledgeIdSchema,
  knowledgeImportPathsSchema,
  knowledgeRelationInputSchema,
  knowledgeUpdateLibrarySchema,
  knowledgeUrlImportSchema,
  type KnowledgeSnapshot
} from '../../shared/contracts'
import {
  knowledgeChunkDeleteInputSchema,
  knowledgeChunkPageSchema,
  knowledgeChunksListInputSchema,
  knowledgeChunkUpdateInputSchema,
  knowledgeDocumentOpenInputSchema,
  knowledgeDocumentRebuildInputSchema,
  knowledgeLibraryRebuildInputSchema,
  knowledgeReferenceContextInputSchema,
  knowledgeReferenceContextSchema,
  knowledgeReferenceOpenInputSchema,
  knowledgeRetrieveInputSchema,
  knowledgeRetrievalResponseSchema,
  knowledgeSettingsUpdateInputSchema
} from '../../shared/knowledge-contracts'
import {
  knowledgeTaskActionInputSchema,
  knowledgeTaskItemSchema
} from '../../shared/knowledge-task-contracts'
import {
  knowledgeEmbeddingIndexCancelRequestSchema,
  knowledgeEmbeddingIndexRequestSchema,
  knowledgeEmbeddingIndexSnapshotSchema
} from '../../shared/embedding-contracts'
import { ipcChannels } from '../../shared/ipc-channels'
import { assertTrustedSender } from '../trusted-ipc-sender'
import type { RuntimeSettingsStore } from '../runtime-settings-store'
import type { KnowledgeService } from './knowledge-service'
import { supportedDocumentExtensions } from './document-parser'

const knowledgeSearchSchema = z
  .object({
    libraryIds: z.array(knowledgeIdSchema).max(20),
    query: z.string().trim().min(1).max(512)
  })
  .strict()
const knowledgeSelectionSchema = z
  .object({
    libraryId: knowledgeIdSchema,
    graphStrategy: z.enum(['rules', 'model', 'hybrid']).optional()
  })
  .strict()
const knowledgeEntityPayloadSchema = z
  .object({
    entityId: knowledgeIdSchema,
    update: knowledgeEntityUpdateSchema
  })
  .strict()
const knowledgeCreateEntitySchema = z
  .object({
    libraryId: knowledgeIdSchema,
    input: knowledgeEntityUpdateSchema
  })
  .strict()
const knowledgeMoveEntitySchema = z
  .object({
    entityId: knowledgeIdSchema,
    position: z
      .object({
        x: z.number().finite().min(-100_000).max(100_000),
        y: z.number().finite().min(-100_000).max(100_000)
      })
      .strict()
  })
  .strict()
const knowledgeMergeSchema = z
  .object({
    sourceEntityId: knowledgeIdSchema,
    targetEntityId: knowledgeIdSchema
  })
  .strict()
const knowledgeCreateRelationSchema = z
  .object({
    libraryId: knowledgeIdSchema,
    input: knowledgeRelationInputSchema
  })
  .strict()
const knowledgeUpdateRelationSchema = z
  .object({
    relationId: knowledgeIdSchema,
    input: knowledgeRelationInputSchema
  })
  .strict()

async function getKnowledgeSnapshot(
  service: KnowledgeService,
  selectedLibraryId?: string
): Promise<KnowledgeSnapshot> {
  const snapshot = await service.snapshot(selectedLibraryId)
  const activeLibraryId =
    selectedLibraryId ?? snapshot.libraries[0]?.id
  const documentsById = new Map(
    snapshot.documents.map((document) => [document.id, document])
  )
  const evidenceByEntity = new Map<string, string[]>()
  const evidenceByRelation = new Map<string, string[]>()
  for (const item of snapshot.evidence) {
    if (item.entityId) {
      evidenceByEntity.set(item.entityId, [
        ...(evidenceByEntity.get(item.entityId) ?? []),
        item.id
      ])
    }
    if (item.relationId) {
      evidenceByRelation.set(item.relationId, [
        ...(evidenceByRelation.get(item.relationId) ?? []),
        item.id
      ])
    }
  }
  const bindingsByLibraryId = new Map(
    ((await service.database.externalStore
      .listBindings())
      .map((binding) => [binding.knowledgeBaseId, binding]))
  )
  return {
    libraries: snapshot.libraries.map((library) => ({
      kind: bindingsByLibraryId.has(library.id) ? 'external' : 'local',
      external: bindingsByLibraryId.get(library.id),
      id: library.id,
      name: library.name,
      description: library.description ?? '',
      storageMode: library.storageMode,
      graphEnabled: library.graphEnabled,
      graphStrategy: library.graphStrategy,
      sourceCount: library.sourceCount,
      documentCount: library.documentCount,
      indexedDocumentCount: library.indexedDocumentCount,
      processingDocumentCount: library.processingDocumentCount,
      failedDocumentCount: library.failedDocumentCount,
      retrievalSettings: library.retrievalSettings,
      chunkingSettings: library.chunkingSettings,
      chunkingRebuildRequired: library.chunkingRebuildRequired,
      ontologySettings: library.ontologySettings,
      ontologyRebuildRequired: library.ontologyRebuildRequired,
      updatedAt: library.updatedAt
    })),
    selectedLibraryId: activeLibraryId,
    sources: snapshot.sources.map((source) => ({
      id: source.id,
      libraryId: source.knowledgeBaseId,
      name: source.displayName,
      kind: source.type,
      location: source.location,
      status:
        source.status === 'pending'
          ? 'queued'
          : source.status === 'indexing'
            ? 'syncing'
            : source.status === 'error'
              ? 'failed'
              : source.status,
      progress: source.progress,
      documentCount: source.documentCount,
      lastSyncedAt: source.lastSyncedAt,
      error: source.lastError
    })),
    documents: snapshot.documents.map((document) => ({
      id: document.id,
      libraryId: document.knowledgeBaseId,
      sourceId: document.sourceId,
      name: document.title,
      resultId: typeof document.metadata.parsedResultId === 'string' ? document.metadata.parsedResultId : undefined,
      path: document.sourceLocation,
      status: document.status,
      textIndexStatus: document.textIndexStatus,
      vectorIndexStatus: document.vectorIndexStatus,
      graphIndexStatus: document.graphIndexStatus,
      indexProgress: document.status === 'ready' ? 100 : 0,
      chunkCount: document.chunkCount,
      size: document.size,
      updatedAt: document.updatedAt,
      error: document.error
    })),
    graphNodes: snapshot.entities.map((entity, index) => ({
      id: entity.id,
      label: entity.name,
      type: entity.type,
      description: entity.description,
      aliases: entity.aliases,
      x:
        typeof entity.properties.x === 'number'
          ? entity.properties.x
          : 120 + (index % 5) * 150,
      y:
        typeof entity.properties.y === 'number'
          ? entity.properties.y
          : 100 + Math.floor(index / 5) * 120,
      evidenceIds: evidenceByEntity.get(entity.id)
    })),
    graphRelations: snapshot.relations.map((relation) => ({
      id: relation.id,
      sourceId: relation.sourceEntityId,
      targetId: relation.targetEntityId,
      type: relation.type,
      description: relation.label,
      evidenceIds: evidenceByRelation.get(relation.id)
    })),
    evidence: snapshot.evidence.map((item) => ({
      id: item.id,
      documentId: item.documentId,
      documentName:
        documentsById.get(item.documentId)?.title ?? '未知文档',
      excerpt: item.quote ?? '',
      location: item.location
    })),
    tasks: snapshot.tasks.map((task) => knowledgeTaskItemSchema.parse(task))
  }
}

export function registerKnowledgeIpcHandlers(
  registerHandler: typeof ipcMain.handle,
  window: BrowserWindow,
  knowledgeService: KnowledgeService,
  settingsStore: RuntimeSettingsStore
): void {
  registerHandler(ipcChannels.externalInstancesList, async (event) => {assertTrustedSender(event,window);return await knowledgeService.external.listInstances()})
  registerHandler(ipcChannels.externalInstancesSave, async (event,input:unknown) => {assertTrustedSender(event,window);return await knowledgeService.external.saveInstance(externalKnowledgeInstanceSaveInputSchema.parse(input))})
  registerHandler(ipcChannels.externalInstancesTest, (event,input:unknown) => {assertTrustedSender(event,window);return knowledgeService.external.testInstance(externalKnowledgeInstanceInputSchema.parse(input).instanceId)})
  registerHandler(ipcChannels.externalInstancesSetEnabled, async (event,input:unknown) => {assertTrustedSender(event,window);const value=externalKnowledgeInstanceEnabledInputSchema.parse(input);return await knowledgeService.external.setEnabled(value.instanceId,value.enabled)})
  registerHandler(ipcChannels.externalInstancesDelete, async (event,input:unknown) => {assertTrustedSender(event,window);return await knowledgeService.external.deleteInstance(externalKnowledgeInstanceInputSchema.parse(input).instanceId)})
  registerHandler(ipcChannels.externalCatalogList, (event,input:unknown) => {assertTrustedSender(event,window);return knowledgeService.external.listCatalog(externalKnowledgeCatalogListInputSchema.parse(input))})
  registerHandler(ipcChannels.externalCatalogGet, (event,input:unknown) => {assertTrustedSender(event,window);return knowledgeService.external.getCatalog(externalKnowledgeCatalogGetInputSchema.parse(input))})
  registerHandler(ipcChannels.externalRetrievalTest, (event,input:unknown) => {assertTrustedSender(event,window);return knowledgeService.external.testRetrieval(externalKnowledgeBindingTestInputSchema.parse(input))})
  registerHandler(ipcChannels.externalBindingsCreate, async (event,input:unknown) => {assertTrustedSender(event,window);await knowledgeService.external.saveBinding(externalKnowledgeBindingSaveInputSchema.parse(input));return await getKnowledgeSnapshot(knowledgeService)})
  registerHandler(ipcChannels.externalBindingsUpdate, async (event,input:unknown) => {assertTrustedSender(event,window);await knowledgeService.external.saveBinding(externalKnowledgeBindingUpdateInputSchema.parse(input));return await getKnowledgeSnapshot(knowledgeService)})
  registerHandler(ipcChannels.knowledgeSnapshot, async (event, input: unknown) => {
    assertTrustedSender(event, window)
    const libraryId =
      input === undefined ? undefined : knowledgeIdSchema.parse(input)
    return await getKnowledgeSnapshot(knowledgeService, libraryId)
  })

  registerHandler(
    ipcChannels.knowledgeCreateLibrary,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const value = knowledgeCreateSchema.parse(input)
      const library = await knowledgeService.createLibrary(value)
      const created = (await getKnowledgeSnapshot(
        knowledgeService,
        library.id
      )).libraries.find((item) => item.id === library.id)
      if (!created) {
        throw new Error('知识库创建失败')
      }
      return created
    }
  )

  registerHandler(
    ipcChannels.knowledgeDeleteLibrary,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      await knowledgeService.deleteLibrary(knowledgeIdSchema.parse(input))
    }
  )

  registerHandler(
    ipcChannels.knowledgeUpdateLibrary,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const value = knowledgeUpdateLibrarySchema.parse(input)
      await knowledgeService.database.updateKnowledgeBase(value.libraryId, {
        name: value.name,
        description: value.description,
        graphEnabled: value.graphEnabled,
        graphStrategy: value.graphStrategy
      })
    }
  )

  registerHandler(
    ipcChannels.knowledgeReextractGraph,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      return knowledgeService.reextractGraph(knowledgeIdSchema.parse(input))
    }
  )

  registerHandler(
    ipcChannels.knowledgeSelectFiles,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const selection = knowledgeSelectionSchema.parse(input)
      const result = await dialog.showOpenDialog(window, {
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: '支持的知识文档',
            extensions: supportedDocumentExtensions.map((extension) =>
              extension.slice(1)
            )
          }
        ]
      })
      if (!result.canceled) {
        await knowledgeService.importPaths(
          selection.libraryId,
          result.filePaths,
          selection.graphStrategy
        )
      }
    }
  )

  registerHandler(
    ipcChannels.knowledgeSelectDirectory,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const selection = knowledgeSelectionSchema.parse(input)
      const result = await dialog.showOpenDialog(window, {
        properties: ['openDirectory']
      })
      if (!result.canceled && result.filePaths[0]) {
        await knowledgeService.importPaths(
          selection.libraryId,
          [result.filePaths[0]],
          selection.graphStrategy
        )
      }
    }
  )

  registerHandler(
    ipcChannels.knowledgeImportPaths,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const value = knowledgeImportPathsSchema.parse(input)
      await knowledgeService.importPaths(
        value.libraryId,
        value.paths,
        value.graphStrategy
      )
    }
  )

  registerHandler(
    ipcChannels.knowledgeImportUrl,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const value = knowledgeUrlImportSchema.parse(input)
      await knowledgeService.importUrl(
        value.libraryId,
        value.url,
        new AbortController().signal,
        undefined,
        value.graphStrategy
      )
    }
  )

  for (const [channel, action] of [
    [
      ipcChannels.knowledgeSyncSource,
      (id: string) => knowledgeService.syncSource(id)
    ],
    [
      ipcChannels.knowledgePauseSource,
      async (id: string) => (await knowledgeService.pauseSource(id))
    ],
    [
      ipcChannels.knowledgeRetrySource,
      (id: string) => knowledgeService.retrySource(id)
    ],
    [
      ipcChannels.knowledgeRemoveSource,
      (id: string) => knowledgeService.removeSource(id)
    ]
  ] as const) {
    registerHandler(channel, async (event, input: unknown) => {
      assertTrustedSender(event, window)
      await action(knowledgeIdSchema.parse(input))
    })
  }

  registerHandler(ipcChannels.knowledgeSearch, async (event, input: unknown) => {
    assertTrustedSender(event, window)
    const value = knowledgeSearchSchema.parse(input)
    if (value.libraryIds.length === 0) {
      return []
    }
    const availableLibraries =
      await knowledgeService.database.listKnowledgeBases(100)
    const libraries = [...new Set(value.libraryIds)]
    const names = new Map(
      availableLibraries.map((library) => [library.id, library.name])
    )
    const results =
      await knowledgeService.retrieveMany(
        libraries,
        value.query
      )

    const failures = results.flatMap(item => item.response.diagnostics.failure ? [item.response.diagnostics.failure] : [])
    if (failures.length === results.length) throw new Error(failures.join('; '))
    const references = results.flatMap(({ knowledgeBaseId, response }) => response.results.map(result => ({
      ...toKnowledgeReference(result, names.get(knowledgeBaseId) ?? '知识库'),
      ...(failures.length ? { warnings: failures } : {})
    })))
    if (!references.length && failures.length) throw new Error(failures.join('; '))
    return [...new Map(references.map(reference => [knowledgeReferenceKey(reference), reference])).values()]
      .sort((left, right) => left.rank - right.rank)
      .slice(0, 8)
  })

  registerHandler(
    ipcChannels.knowledgeRetrieve,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const response = await knowledgeService.retrieve(
        knowledgeRetrieveInputSchema.parse(input)
      )
      return knowledgeRetrievalResponseSchema.parse(response)
    }
  )

  registerHandler(
    ipcChannels.knowledgeUpdateSettings,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const value = knowledgeSettingsUpdateInputSchema.parse(input)
      await knowledgeService.updateSettings(value)
      const library = (await getKnowledgeSnapshot(
        knowledgeService,
        value.knowledgeBaseId
      )).libraries.find((item) => item.id === value.knowledgeBaseId)
      if (!library) {
        throw new Error('知识库不存在')
      }
      return library
    }
  )

  registerHandler(
    ipcChannels.knowledgeListChunks,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const page = await knowledgeService.listChunks(
        knowledgeChunksListInputSchema.parse(input)
      )
      return knowledgeChunkPageSchema.parse({
        items: page.items.map((chunk) => ({
          id: chunk.id,
          ordinal: chunk.ordinal,
          role: chunk.role,
          parentChunkId: chunk.parentChunkId,
          heading: chunk.heading,
          locator: chunk.location,
          characterCount: chunk.content.length,
          enabled: chunk.enabled,
          content: chunk.content,
          manuallyEdited: chunk.manuallyEdited,
          updatedAt: chunk.updatedAt
        })),
        page: page.page,
        pageSize: page.pageSize,
        totalItems: page.total
      })
    }
  )

  registerHandler(
    ipcChannels.knowledgeUpdateChunk,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      await knowledgeService.updateChunk(
        knowledgeChunkUpdateInputSchema.parse(input)
      )
    }
  )

  registerHandler(
    ipcChannels.knowledgeDeleteChunk,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const deleted = await knowledgeService.deleteChunk(
        knowledgeChunkDeleteInputSchema.parse(input)
      )
      if (!deleted) {
        throw new Error('知识分块不存在')
      }
    }
  )

  registerHandler(
    ipcChannels.knowledgeRebuildDocument,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const value = knowledgeDocumentRebuildInputSchema.parse(input)
      await knowledgeService.rebuildDocument(value)
      return await getKnowledgeSnapshot(
        knowledgeService,
        value.knowledgeBaseId
      )
    }
  )

  registerHandler(
    ipcChannels.knowledgeRebuildLibrary,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const value = knowledgeLibraryRebuildInputSchema.parse(input)
      return knowledgeService.rebuildLibrary(value)
    }
  )

  registerHandler(
    ipcChannels.knowledgeCancelRebuild,
    (event, input: unknown) => {
      assertTrustedSender(event, window)
      const knowledgeBaseId = knowledgeIdSchema.parse(input)
      return knowledgeService.cancelLibraryRebuild(knowledgeBaseId)
    }
  )

  registerHandler(
    ipcChannels.knowledgeTaskCancel,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const { taskId } = knowledgeTaskActionInputSchema.parse(input)
      return knowledgeService.cancelTask(taskId)
    }
  )

  registerHandler(
    ipcChannels.knowledgeTaskRetry,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const { taskId } = knowledgeTaskActionInputSchema.parse(input)
      await knowledgeService.retryTask(taskId)
    }
  )

  const embeddingConfiguration = async () => {
    const settings = await settingsStore.getPublicSettings()
    const connection = settings.embeddingConnections?.find(
      (candidate) =>
        candidate.id === settings.activeEmbeddingConnectionId
    )
    return connection?.kind === 'builtin'
      ? {
          provider: 'builtin',
          model: 'granite-embedding-97m-multilingual-r2',
          credentialConfigured: false
        }
      : {
          provider: 'openai-compatible',
          model:
            connection?.modelName ??
            settings.knowledgeEmbeddingModel,
          endpoint:
            connection?.baseUrl ??
            settings.knowledgeEmbeddingBaseUrl,
          credentialConfigured:
            connection?.apiKeyConfigured ??
            settings.knowledgeEmbeddingApiKeyConfigured
        }
  }

  registerHandler(
    ipcChannels.knowledgeEmbeddingIndexGet,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const { knowledgeBaseId } =
        knowledgeEmbeddingIndexRequestSchema.parse(input)
      const settings = await settingsStore.getResolvedSettings()
      return knowledgeEmbeddingIndexSnapshotSchema.parse(
        await knowledgeService.getEmbeddingIndexSnapshot(
          knowledgeBaseId,
          settings.knowledgeEmbeddingEnabled
            ? await embeddingConfiguration()
            : undefined
        )
      )
    }
  )

  registerHandler(
    ipcChannels.knowledgeEmbeddingIndexRebuild,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const { knowledgeBaseId } =
        knowledgeEmbeddingIndexRequestSchema.parse(input)
      const snapshot = await knowledgeService.rebuildEmbeddingIndex(
        knowledgeBaseId,
        await embeddingConfiguration()
      )
      return knowledgeEmbeddingIndexSnapshotSchema.parse(snapshot)
    }
  )

  registerHandler(
    ipcChannels.knowledgeEmbeddingIndexCancel,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const { knowledgeBaseId, jobId } =
        knowledgeEmbeddingIndexCancelRequestSchema.parse(input)
      return knowledgeService.cancelEmbeddingIndex(
        knowledgeBaseId,
        jobId
      )
    }
  )

  registerHandler(
    ipcChannels.knowledgeOpenDocumentSource,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const value = knowledgeDocumentOpenInputSchema.parse(input)
      const reference = await knowledgeService.getDocumentSource(value)
      if (!reference) {
        throw new Error('文档来源不存在')
      }
      if (reference.source.type === 'url') {
        const target = new URL(reference.source.location)
        if (!['http:', 'https:'].includes(target.protocol)) {
          throw new Error('文档来源 URL 协议不受支持')
        }
        await shell.openExternal(target.href)
        return
      }
      const storedPath =
        reference.document.sourceLocation ?? reference.source.location
      if (!isAbsolute(storedPath)) {
        throw new Error('文档来源路径无效')
      }
      if ((await lstat(storedPath)).isSymbolicLink()) {
        throw new Error('文档来源不能是符号链接')
      }
      const targetPath = await realpath(storedPath)
      if (!(await stat(targetPath)).isFile()) {
        throw new Error('文档来源不是可打开的文件')
      }
      const openError = await shell.openPath(targetPath)
      if (openError) {
        throw new Error('无法打开文档来源')
      }
    }
  )

  registerHandler(
    ipcChannels.knowledgeReferenceContext,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const value = knowledgeReferenceContextInputSchema.parse(input)
      const reference = await knowledgeService.getReferenceContext(value)
      if (!reference) {
        throw new Error('引用上下文不存在或已停用')
      }
      const fullContext = reference.contextChunks
        .map((chunk) => chunk.content)
        .join('\n\n')
      return knowledgeReferenceContextSchema.parse({
        knowledgeBaseId: value.knowledgeBaseId,
        documentId: value.documentId,
        chunkId: value.chunkId,
        documentTitle: reference.document.title,
        sourceDisplayName: reference.source.displayName,
        locator: reference.chunk.location,
        matchedContent: reference.chunk.content.slice(0, 48_000),
        contextContent: fullContext.slice(0, 48_000),
        contextChunkIds: reference.contextChunks.map((chunk) => chunk.id),
        truncated:
          reference.chunk.content.length > 48_000 ||
          fullContext.length > 48_000
      })
    }
  )

  registerHandler(
    ipcChannels.knowledgeOpenReferenceSource,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const value = knowledgeReferenceOpenInputSchema.parse(input)
      const reference = await knowledgeService.getReferenceContext(value)
      if (!reference) {
        throw new Error('引用来源不存在或已停用')
      }
      if (reference.source.type === 'url') {
        const target = new URL(reference.source.location)
        if (!['http:', 'https:'].includes(target.protocol)) {
          throw new Error('引用来源 URL 协议不受支持')
        }
        await shell.openExternal(target.href)
        return
      }
      const storedPath =
        reference.document.sourceLocation ?? reference.source.location
      if (!isAbsolute(storedPath)) {
        throw new Error('引用来源路径无效')
      }
      if ((await lstat(storedPath)).isSymbolicLink()) {
        throw new Error('引用来源不能是符号链接')
      }
      const targetPath = await realpath(storedPath)
      const targetStat = await stat(targetPath)
      if (!targetStat.isFile() && !targetStat.isDirectory()) {
        throw new Error('引用来源不是可打开的文件或目录')
      }
      const openError = await shell.openPath(targetPath)
      if (openError) {
        throw new Error('无法打开引用来源')
      }
    }
  )

  registerHandler(
    ipcChannels.knowledgeCreateEntity,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const value = knowledgeCreateEntitySchema.parse(input)
      await knowledgeService.database.createEntity({
        knowledgeBaseId: value.libraryId,
        name: value.input.label,
        type: value.input.type,
        description: value.input.description || undefined,
        aliases: value.input.aliases,
        locked: true
      })
    }
  )

  registerHandler(
    ipcChannels.knowledgeUpdateEntity,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const value = knowledgeEntityPayloadSchema.parse(input)
      await knowledgeService.database.updateEntity(value.entityId, {
        name: value.update.label,
        type: value.update.type,
        description: value.update.description || null,
        aliases: value.update.aliases,
        locked: true
      })
    }
  )

  registerHandler(
    ipcChannels.knowledgeMoveEntity,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const value = knowledgeMoveEntitySchema.parse(input)
      const entity = await knowledgeService.database.getEntity(value.entityId)
      if (!entity) {
        throw new Error('图谱实体不存在')
      }
      await knowledgeService.database.updateEntity(entity.id, {
        properties: {
          ...entity.properties,
          x: value.position.x,
          y: value.position.y
        }
      })
    }
  )

  registerHandler(
    ipcChannels.knowledgeDeleteEntity,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      await knowledgeService.database.deleteEntity(knowledgeIdSchema.parse(input))
    }
  )

  registerHandler(
    ipcChannels.knowledgeMergeEntities,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const value = knowledgeMergeSchema.parse(input)
      await knowledgeService.database.mergeEntities(
        value.targetEntityId,
        value.sourceEntityId
      )
    }
  )

  registerHandler(
    ipcChannels.knowledgeCreateRelation,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const value = knowledgeCreateRelationSchema.parse(input)
      await knowledgeService.database.createRelation({
        knowledgeBaseId: value.libraryId,
        sourceEntityId: value.input.sourceId,
        targetEntityId: value.input.targetId,
        type: value.input.type,
        label: value.input.description || undefined,
        locked: true
      })
    }
  )

  registerHandler(
    ipcChannels.knowledgeUpdateRelation,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      const value = knowledgeUpdateRelationSchema.parse(input)
      await knowledgeService.database.updateRelation(value.relationId, {
        sourceEntityId: value.input.sourceId,
        targetEntityId: value.input.targetId,
        type: value.input.type,
        label: value.input.description || null,
        locked: true
      })
    }
  )

  registerHandler(
    ipcChannels.knowledgeDeleteRelation,
    async (event, input: unknown) => {
      assertTrustedSender(event, window)
      await knowledgeService.database.deleteRelation(knowledgeIdSchema.parse(input))
    }
  )
}
