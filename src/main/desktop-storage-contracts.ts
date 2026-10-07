import type { AssistantDatabase, SshProjectWrite } from './assistant/assistant-database'
import type { KnowledgeDatabase } from './knowledge/knowledge-database'
import type { AssistantStorageProgress } from '../shared/assistant-storage-contracts'
import type { GraphExtractionResult } from './knowledge/graph-extractor'
import type { JsonValue } from './knowledge/types'
import type { DesktopFileStorageDomains } from './desktop-storage-files'
import type { DesktopStorageRuntimeOperations } from './desktop-storage-runtime-operations'
import type { replaceDocumentGraph } from './desktop-storage-knowledge-operations'
export { storageDataBytes } from '../shared/storage-data-size'

// Explicit domain allowlists, not a SQL endpoint or a proxy for arbitrary objects.
export const assistantStorageMethods = [
  'hasAttachmentOwner', 'clearAssistantData', 'listProjects', 'ensureChannelProjects',
  'createProject', 'updateProject', 'createSshProject', 'updateSshProject', 'listProjectsReferencingSshHost',
  'listSshHostProjectReferences', 'deleteProjectsReferencingSshHost', 'setProjectArchived',
  'deleteProject', 'listConversations', 'listConversationSummaries', 'searchConversations',
  'getConversation', 'setConversationPinned', 'isConversationStoryGraphEnabled',
  'setConversationStoryGraphEnabled', 'repairConversationRuntimeSelections',
  'replaceConversations', 'saveLocalConversations', 'branchLocalConversation',
  'deleteLocalConversation', 'getOrCreateRemoteConversation', 'appendConversationMessage',
  'appendRemoteConversationMessage', 'claimChannelEvent', 'releaseChannelEvent',
  'enqueueChannelResult', 'markChannelResult', 'listUndeliveredChannelResults',
  'listMagicNotes', 'listMagicNoteTags', 'renameMagicNoteTag', 'deleteMagicNoteTag',
  'getMagicNote', 'getMagicNoteContext', 'createMagicNote', 'updateMagicNote',
  'deleteMagicNote', 'createMagicNoteEntry', 'updateMagicNoteEntry', 'deleteMagicNoteEntry',
  'getMagicNoteEntry', 'saveMagicNoteAnalysis', 'listMagicTodos', 'getMagicTodoStatus',
  'searchMagicNoteSummaries', 'searchMagicNotes', 'getMagicTodo', 'updateMagicTodo',
  'saveMagicTodoAnalysis', 'listPendingDelegationResults', 'getDelegationDeliveryStatus',
  'saveDelegationResult', 'markDelegationDelivered', 'listTasks', 'getExecutionStats',
  'startExecutionTiming', 'endExecutionTiming', 'getActivityHistory', 'replaceActivityHistory',
  'updateActivityHistory', 'clearActivityHistory', 'getActivityHistoryPage',
  'getActivityHistorySummary', 'reconcileActivityHistory', 'createTask',
  'listRecoverableRemoteTasks', 'recordRemoteTaskQuestionArrival', 'recordRemoteTaskQuestionAnswer',
  'endRecoverableRemoteTask', 'upsertModelUsageCall', 'recordSystemModelUsage',
  'getTokenUsageSummary', 'updateTaskStatus', 'resolveAssistantSuggestionTask', 'appendTaskEvent',
  'appendRemoteTaskEventOnce', 'appendRemoteTaskEventsOnce', 'appendRemoteConversationTaskEventOnce',
  'appendRemoteConversationTaskEventsBatch', 'appendRemoteTaskEventsBatch',
  'getHighestCommittedRemoteTaskEventSequence', 'getHighestCommittedRemoteTaskEventSequenceForTask',
  'hasRemoteResponseTextAfterToolFailure', 'getRemoteTaskActivityStates', 'persistComputerControlAudit',
  'listRecentComputerControlAudit', 'listArtifacts', 'getArtifact', 'createTextArtifact',
  'saveConversationImageOperation', 'saveConversationImageSources',
  'markUnfinishedImageOperationsUnconfirmed', 'createImageArtifact', 'createInlineArtifact',
  'listMemories', 'createMemory', 'setMemoryStatus', 'removeMemory', 'listConversationQueueItems',
  'listPendingScheduleQueueConversationIds', 'listPendingConversationQueueIds',
  'getConversationQueueItem', 'getConversationUserQueuePayloadJson',
  'isConversationUserQueueItemDispatching', 'enqueueConversationUserInput',
  'claimConversationQueueItem', 'completeConversationUserQueueItem', 'releaseConversationUserQueueItem',
  'removeConversationUserQueueItem', 'cancelConversationQueueItem', 'listSchedules',
  'createSchedule', 'setScheduleEnabled', 'removeSchedule', 'queueDueSchedules',
  'queueScheduleNow', 'completeTaskScheduleRun', 'completeScheduleRun', 'listHeartbeatConfigs',
  'getHeartbeatConfig', 'createHeartbeatConfig', 'updateHeartbeatConfig', 'setHeartbeatPaused',
  'removeHeartbeatConfig', 'listHeartbeatRuns', 'getHeartbeatRun', 'listHeartbeatEntries',
  'claimDueHeartbeats', 'claimHeartbeatNow', 'renewHeartbeatLease', 'buildHeartbeatInput',
  'collectIncrementalReview', 'resolveReviewScope', 'reviewSummary', 'reviewBackground',
  'noChangeSupervisionRun', 'noChangeHeartbeatRun', 'completeHeartbeatTrigger',
  'markHeartbeatNoChange', 'setHeartbeatSuggestionStatus', 'supervisionRunForHeartbeat',
  'getHeartbeatEntry', 'listSupervisionCandidates', 'startSupervisionRun', 'failSupervisionRun',
  'setHeartbeatProjection', 'listSupervisionActivity', 'saveSupervisionResult', 'readStoryGraph',
  'getSupervisionResult', 'getSupervisionStories', 'listSupervisionResults', 'getSupervisionGraph',
  'getSupervisionSource', 'applySupervisionEntityAction', 'applySupervisionRelationAction',
  'completeHeartbeatRun', 'failHeartbeatRun', 'pruneHeartbeatHistory', 'listExperts',
  'createExpert', 'updateExpert', 'removeExpert', 'getExpert', 'getProject', 'getTask',
  'resolveSupervisionSuggestion'
] as const satisfies readonly (keyof AssistantDatabase)[]

export const knowledgeStorageMethods = [
  'createKnowledgeBase', 'listKnowledgeBases', 'getKnowledgeBaseCounts', 'getKnowledgeBase',
  'saveExternalBinding', 'updateKnowledgeBase', 'updateKnowledgeSettings',
  'markKnowledgeChunkingRebuilt', 'markKnowledgeOntologyRebuilt', 'deleteKnowledgeBase',
  'createKnowledgeTask', 'getKnowledgeTask', 'getActiveKnowledgeTaskByDedupeKey',
  'getKnowledgeTaskByEmbeddingJobId', 'listKnowledgeTasks', 'listActiveKnowledgeTasks',
  'updateKnowledgeTask', 'cancelKnowledgeTask', 'interruptActiveKnowledgeTasks', 'pruneKnowledgeTasks',
  'upsertSource', 'listSources', 'listSourcesForSnapshot', 'getSource', 'removeSource',
  'upsertDocument', 'getDocumentByParsedResultId', 'getDocument', 'listDocuments',
  'listDocumentsForSource', 'listDocumentsForLibraryRebuild', 'listDocumentsForSnapshot',
  'getDocumentChunkCounts', 'removeDocument', 'removeEvidenceForDocument',
  'pruneUnreferencedGeneratedGraph', 'listChunks', 'listChunksPage', 'getChunkForReference',
  'updateChunk', 'deleteChunk', 'listContextChunks', 'replaceDocumentEmbeddings',
  'beginDocumentEmbeddingReplacement', 'beginPreparedDocumentEmbeddingReplacement',
  'appendDocumentEmbeddingBatch', 'appendPreparedDocumentEmbeddingBatch',
  'finishDocumentEmbeddingReplacement', 'discardDocumentEmbeddingReplacement',
  'recordEmbeddingIndexError', 'getEmbeddingIndexState', 'getLastEmbeddingIndexJob',
  'saveEmbeddingIndexJob', 'listEmbeddingIndexDocumentIds', 'countEmbeddingIndexDocuments',
  'getEmbeddingIndexCoverage', 'getEmbeddingIndexDocument', 'vectorSearch', 'graphSearch',
  'hybridSearch', 'hybridSearchWithDiagnostics', 'search', 'createEntity', 'getEntity',
  'listEntities', 'findEntityByCanonicalName', 'listEntitiesForIdentity', 'updateEntity',
  'deleteEntity', 'createRelation', 'getRelation', 'listRelations', 'findRelationByIdentity',
  'updateRelation', 'deleteRelation', 'createEvidence', 'listEvidence', 'listGraphSnapshot',
  'updateEvidence', 'deleteEvidence', 'mergeEntities'
] as const satisfies readonly (keyof KnowledgeDatabase)[]

export const repositoryStorageMethods = {
  review: ['initialize', 'resume', 'load', 'unfinished', 'pause', 'cancel', 'setPhase', 'setStories',
    'groups', 'chunk', 'save', 'hasSources', 'batches', 'progress', 'assertComplete', 'omitDeletedConversations', 'navigation', 'saveNavigation'],
  stories: ['pending', 'candidates', 'otherFeatures', 'crossMembers', 'directCounts', 'splitInput', 'split', 'apply', 'list', 'unassignedCount', 'act', 'canUndo'],
  experiences: ['candidates', 'markSmall', 'existing', 'apply', 'list', 'snapshot', 'act', 'restore'],
  suggestions: ['candidates', 'save', 'list', 'get', 'countForHeartbeat'],
  external: ['getInstance', 'listInstances', 'saveInstance', 'deleteInstance', 'getBinding', 'hasBinding', 'getBindingsForInstance', 'listBindings', 'saveBinding']
} as const

export type PublishDocumentOptions = Omit<NonNullable<Parameters<KnowledgeDatabase['publishDocument']>[2]>, 'afterChunksInserted'> & {
  graph?: GraphExtractionResult
}

// AbortSignals are transport options; callbacks and live handles are never data.
export type StorageData<T> = T extends AbortSignal ? never
  : T extends (...args: never[]) => unknown ? never
  // JSON is already a serializable recursive type; do not instantiate it again.
  : T extends JsonValue ? T
  : T extends Date | Uint8Array ? T
  : T extends Map<infer K, infer V> ? Map<StorageData<K>, StorageData<V>>
  : T extends Set<infer V> ? Set<StorageData<V>>
  : T extends object ? { [K in keyof T]: StorageData<T[K]> } : T

export type DesktopStorageDomains = {
  assistant: Omit<Pick<AssistantDatabase, typeof assistantStorageMethods[number]>, 'createSshProject' | 'updateSshProject'> & {
    supervisionContext(request: Parameters<AssistantDatabase['listSupervisionCandidates']>[0], signal?: AbortSignal): {
      summary: ReturnType<AssistantDatabase['reviewSummary']>; background: ReturnType<AssistantDatabase['reviewBackground']>
    }
    createSshProject(write: Omit<SshProjectWrite, 'assertCurrent'>): ReturnType<AssistantDatabase['createSshProject']>
    updateSshProject(projectId: string, expectedUpdatedAt: string, write: Omit<SshProjectWrite, 'assertCurrent'>): ReturnType<AssistantDatabase['updateSshProject']>
  }
  knowledge: Pick<KnowledgeDatabase, typeof knowledgeStorageMethods[number]> & {
    publishDocument(input: Parameters<KnowledgeDatabase['publishDocument']>[0], chunks: Parameters<KnowledgeDatabase['publishDocument']>[1], options?: PublishDocumentOptions): ReturnType<KnowledgeDatabase['publishDocument']>
    replaceDocumentGraph(...args: Parameters<typeof replaceDocumentGraph> extends [unknown, ...infer A] ? A : never): void
  }
  review: Pick<ReturnType<AssistantDatabase['supervisionReviewStore']>, typeof repositoryStorageMethods.review[number]>
  stories: Pick<ReturnType<AssistantDatabase['supervisionStories']>, typeof repositoryStorageMethods.stories[number]>
  experiences: Pick<ReturnType<AssistantDatabase['supervisionExperiences']>, typeof repositoryStorageMethods.experiences[number]>
  suggestions: Pick<ReturnType<AssistantDatabase['supervisionSuggestions']>, typeof repositoryStorageMethods.suggestions[number]>
  external: Pick<KnowledgeDatabase['externalStore'], typeof repositoryStorageMethods.external[number]>
  runtime: DesktopStorageRuntimeOperations
} & DesktopFileStorageDomains
export type StorageDomain = keyof DesktopStorageDomains
export type StorageMethod<D extends StorageDomain> = keyof DesktopStorageDomains[D] & string
export type StorageArgs<D extends StorageDomain, M extends StorageMethod<D>> =
  DesktopStorageDomains[D][M] extends (...args: infer A) => unknown ? StorageData<A> : never
export type StorageResult<D extends StorageDomain, M extends StorageMethod<D>> =
  DesktopStorageDomains[D][M] extends (...args: never[]) => infer R ? StorageData<Awaited<R>> : never

export interface DesktopStorageOptions {
  assistantPath: string
  knowledgePath: string
  defaultRootPath: string
  userDataPath: string
  /** Defaults to packaged sibling entries. Paths are supplied only by Main. */
  readerWorkerPath?: string
  upgradeWorkerPath?: string
  /** In-memory decision retained across an explicit startup retry, never a write receipt. */
  confirmedUpgrade?: { migrateNotes: boolean; reclaimSpace: boolean }
}
export type StorageChange = 'magicNotes' | 'magicTodos' | 'modelUsage' | 'executionStats'
export type StorageError = { name: string; message: string; code?: string; issues?: unknown; cause?: StorageError }
export type StorageRequest =
  | { type: 'open'; options: DesktopStorageOptions }
  | { type: 'call'; id: number; domain: StorageDomain; method: string; args: unknown[] }
  | { type: 'cancel'; id: number }
  | { type: 'close' }
export type StorageResponse =
  | { type: 'ready' }
  | { type: 'progress'; progress: AssistantStorageProgress }
  | { type: 'upgrade'; upgrade?: DesktopStorageOptions['confirmedUpgrade'] }
  | { type: 'changed'; domain: StorageChange }
  | { type: 'result'; id: number; result: unknown }
  | { type: 'error'; id: number; error: StorageError }
  | { type: 'failed'; error: StorageError }
  | { type: 'closed' }

/** Per-batch payload guidance for domain writers that split large saves. */
export const STORAGE_MAX_BYTES = 32 * 1024 * 1024
