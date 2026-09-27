import type {
  KnowledgeLibrary as SharedKnowledgeLibrary,
  KnowledgeSourceItem as SharedKnowledgeSource,
  KnowledgeDocumentItem as SharedKnowledgeDocumentItem,
  KnowledgeGraphNode as SharedKnowledgeGraphNode,
  KnowledgeGraphRelation as SharedKnowledgeGraphRelation,
  KnowledgeEvidence as SharedKnowledgeEvidence,
  KnowledgeTaskItem as SharedKnowledgeTaskItem,
  KnowledgeSnapshot
} from '../../../shared/contracts'
import type { ExternalKnowledgeInstanceSummary } from '../../../shared/external-knowledge-contracts'
import type { AppNotificationInput } from '../notifications'
import type {
  KnowledgeRetrievalSettings,
  KnowledgeRetrievalResponse,
  KnowledgeChunkingSettings,
  KnowledgeChunkPage,
  KnowledgeChunkUpdateInput
} from '../../../shared/knowledge-contracts'
import type { KnowledgeOntologySettings } from '../../../shared/knowledge-ontology'
import type { KnowledgeEmbeddingIndexSnapshot } from '../../../shared/embedding-contracts'

export type KnowledgeLibrary = SharedKnowledgeLibrary

export type KnowledgeStorageMode = KnowledgeLibrary['storageMode']

export type KnowledgeGraphStrategy = KnowledgeLibrary['graphStrategy']

export type KnowledgeSource = SharedKnowledgeSource

export type KnowledgeSourceKind = KnowledgeSource['kind']

export type KnowledgeSourceStatus = KnowledgeSource['status']

export type KnowledgeDocumentItem = SharedKnowledgeDocumentItem

export type KnowledgeDocumentStatus = KnowledgeDocumentItem['status']

export type CreateKnowledgeLibraryInput = {
  name: string
  description: string
  storageMode: KnowledgeStorageMode
  graphEnabled: boolean
  graphStrategy: KnowledgeGraphStrategy
}

export type KnowledgeGraphNode = SharedKnowledgeGraphNode

export type KnowledgeGraphRelation = SharedKnowledgeGraphRelation

export type KnowledgeEvidence = SharedKnowledgeEvidence

export type KnowledgeTaskItem = SharedKnowledgeTaskItem

export type KnowledgeEntityUpdate = {
  label: string
  type: string
  description: string
  aliases: string[]
}

export type KnowledgeRelationInput = {
  sourceId: string
  targetId: string
  type: string
  description: string
}

export type KnowledgeWorkspaceProps = {
  externalInstances?: ExternalKnowledgeInstanceSummary[]
  onExternalChanged?: (snapshot?: KnowledgeSnapshot, createdId?: string) => void | Promise<void>
  notify?: (input: AppNotificationInput) => void
  libraries: readonly KnowledgeLibrary[]
  selectedLibraryId?: string
  sources: readonly KnowledgeSource[]
  documents: readonly KnowledgeDocumentItem[]
  graphNodes: readonly KnowledgeGraphNode[]
  graphRelations: readonly KnowledgeGraphRelation[]
  evidence: readonly KnowledgeEvidence[]
  tasks?: readonly KnowledgeTaskItem[]
  loading?: boolean
  loadError?: string
  onRetryLoad: () => void | Promise<void>
  onSelectLibrary: (libraryId: string) => void
  onCreateLibrary: (
    input: CreateKnowledgeLibraryInput
  ) => void | Promise<void>
  onDeleteLibrary: (libraryId: string) => void | Promise<void>
  onUpdateLibrary: (
    libraryId: string,
    update: {
      name?: string
      description?: string
      graphEnabled?: boolean
      graphStrategy?: KnowledgeGraphStrategy
    }
  ) => void | Promise<void>
  onReextractGraph: (libraryId: string) => void | Promise<void>
  onImportFiles: (
    libraryId: string,
    files: File[],
    graphStrategy?: Exclude<KnowledgeGraphStrategy, 'ask'>
  ) => void | Promise<void>
  onImportDirectory: (
    libraryId: string,
    files: File[],
    graphStrategy?: Exclude<KnowledgeGraphStrategy, 'ask'>
  ) => void | Promise<void>
  onImportUrl: (
    libraryId: string,
    url: string,
    graphStrategy?: Exclude<KnowledgeGraphStrategy, 'ask'>
  ) => void | Promise<void>
  onSyncSource: (sourceId: string) => void | Promise<void>
  onPauseSource: (sourceId: string) => void | Promise<void>
  onRetrySource: (sourceId: string) => void | Promise<void>
  onRemoveSource: (sourceId: string) => void | Promise<void>
  onRetrieve: (
    libraryId: string,
    query: string,
    settings: KnowledgeRetrievalSettings
  ) => Promise<KnowledgeRetrievalResponse>
  onUpdateKnowledgeSettings: (
    libraryId: string,
    settings: {
      retrieval?: KnowledgeRetrievalSettings
      chunking?: KnowledgeChunkingSettings
      ontology?: KnowledgeOntologySettings
    }
  ) => void | Promise<void>
  onListChunks: (input: {
    libraryId: string
    documentId: string
    page: number
    pageSize: number
    search?: string
  }) => Promise<KnowledgeChunkPage>
  onUpdateChunk: (
    input: KnowledgeChunkUpdateInput
  ) => void | Promise<void>
  onDeleteChunk: (input: {
    knowledgeBaseId: string
    documentId: string
    chunkId: string
  }) => void | Promise<void>
  onRebuildDocument: (
    libraryId: string,
    documentId: string
  ) => void | Promise<void>
  onOpenDocumentSource: (
    libraryId: string,
    documentId: string
  ) => void | Promise<void>
  onRebuildLibrary: (libraryId: string) => void | Promise<void>
  onCancelRebuild: (libraryId: string) => void | Promise<void>
  onGetEmbeddingIndex: (
    libraryId: string
  ) =>
    | KnowledgeEmbeddingIndexSnapshot
    | Promise<KnowledgeEmbeddingIndexSnapshot>
  onRebuildEmbeddingIndex: (
    libraryId: string
  ) => Promise<KnowledgeEmbeddingIndexSnapshot>
  onCancelTask: (taskId: string) => void | Promise<void>
  onRetryTask: (taskId: string) => void | Promise<void>
  onOpenReferenceSource: (input: {
    knowledgeBaseId: string
    documentId: string
    chunkId: string
  }) => void | Promise<void>
  onUseInChat: (libraryId: string) => void
  onOpenModelSettings: () => void
  onMoveNode: (
    nodeId: string,
    position: { x: number; y: number }
  ) => void
  onCreateEntity: (
    input: KnowledgeEntityUpdate
  ) => void | Promise<void>
  onUpdateEntity: (
    nodeId: string,
    update: KnowledgeEntityUpdate
  ) => void | Promise<void>
  onDeleteEntity: (nodeId: string) => void | Promise<void>
  onMergeEntities: (
    sourceNodeId: string,
    targetNodeId: string
  ) => void | Promise<void>
  onCreateRelation: (
    relation: KnowledgeRelationInput
  ) => void | Promise<void>
  onUpdateRelation: (
    relationId: string,
    relation: KnowledgeRelationInput
  ) => void | Promise<void>
  onDeleteRelation: (relationId: string) => void | Promise<void>
  onOpenEvidence?: (evidence: KnowledgeEvidence) => void
}
