import type {
  KnowledgeChunkingSettings,
  KnowledgeChunkRole,
  KnowledgeRetrievalSettings
} from '../../shared/knowledge-contracts'
import type { KnowledgeOntologySettings } from '../../shared/knowledge-ontology'

export type StorageMode = 'reference' | 'managed'
export type GraphStrategy = 'rules' | 'model' | 'hybrid' | 'ask'
export type KnowledgeSourceType = 'file' | 'directory' | 'url'
export type KnowledgeSourceStatus =
  | 'pending'
  | 'indexing'
  | 'ready'
  | 'paused'
  | 'error'

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export interface KnowledgeBase {
  id: string
  name: string
  description?: string
  storageMode: StorageMode
  graphEnabled: boolean
  graphStrategy: GraphStrategy
  retrievalSettings: KnowledgeRetrievalSettings
  chunkingSettings: KnowledgeChunkingSettings
  chunkingRebuildRequired: boolean
  ontologySettings: KnowledgeOntologySettings
  ontologyRebuildRequired: boolean
  createdAt: string
  updatedAt: string
}

export interface CreateKnowledgeBaseInput {
  id?: string
  name: string
  description?: string
  storageMode: StorageMode
  graphEnabled?: boolean
  graphStrategy?: GraphStrategy
}

export interface UpdateKnowledgeBaseInput {
  name?: string
  description?: string | null
  storageMode?: StorageMode
  graphEnabled?: boolean
  graphStrategy?: GraphStrategy
}

export interface KnowledgeSource {
  id: string
  knowledgeBaseId: string
  type: KnowledgeSourceType
  location: string
  displayName: string
  status: KnowledgeSourceStatus
  lastError?: string
  metadata: JsonObject
  createdAt: string
  updatedAt: string
}

export interface UpsertKnowledgeSourceInput {
  id?: string
  knowledgeBaseId: string
  type: KnowledgeSourceType
  location: string
  displayName: string
  status?: KnowledgeSourceStatus
  lastError?: string | null
  metadata?: JsonObject
}

export interface Document {
  id: string
  knowledgeBaseId: string
  sourceId: string
  externalId: string
  title: string
  mimeType?: string
  sourceLocation?: string
  checksum?: string
  metadata: JsonObject
  createdAt: string
  updatedAt: string
}

export interface UpsertDocumentInput {
  id?: string
  knowledgeBaseId: string
  sourceId: string
  externalId: string
  title: string
  mimeType?: string
  sourceLocation?: string
  checksum?: string
  metadata?: JsonObject
}

export interface Chunk {
  id: string
  knowledgeBaseId: string
  documentId: string
  ordinal: number
  content: string
  tokenCount?: number
  heading?: string
  location?: string
  metadata: JsonObject
  createdAt: string
  enabled: boolean
  role: KnowledgeChunkRole
  parentChunkId?: string
  manuallyEdited: boolean
  updatedAt?: string
}

export interface ReplaceChunkInput {
  id?: string
  ordinal: number
  content: string
  tokenCount?: number
  heading?: string
  location?: string
  metadata?: JsonObject
  enabled?: boolean
  role?: KnowledgeChunkRole
  parentChunkId?: string
  manuallyEdited?: boolean
}

export interface SearchOptions {
  knowledgeBaseId: string
  query: string
  limit?: number
}

export interface SearchResult {
  chunk: Chunk
  document: Document
  source: KnowledgeSource
  snippet: string
  rank: number
}

export interface EmbeddingProvider {
  readonly provider: string
  readonly model: string
  readonly fingerprint?: string
  embed(input: readonly string[], signal?: AbortSignal): Promise<number[][]>
  embedQuery?(
    input: readonly string[],
    signal?: AbortSignal
  ): Promise<number[][]>
  embedDocuments?(
    input: readonly string[],
    signal?: AbortSignal
  ): Promise<number[][]>
}

export interface RerankProviderResult {
  index: number
  relevanceScore: number
}

export interface RerankProvider {
  readonly provider: string
  readonly model: string
  readonly fingerprint?: string
  rerank(
    query: string,
    documents: readonly string[],
    topN: number,
    signal?: AbortSignal
  ): Promise<RerankProviderResult[]>
}

export interface ChunkEmbeddingInput {
  chunkId: string
  contentChecksum: string
  vector: readonly number[]
}

export interface EmbeddingIndexState {
  documentId: string
  knowledgeBaseId: string
  provider: string
  model: string
  dimensions?: number
  contentChecksum: string
  status: 'ready' | 'error'
  lastError?: string
  updatedAt: string
}

export interface EmbeddingIndexCoverage {
  total: number
  indexed: number
  missing: number
  error: number
}

export interface VectorSearchOptions {
  knowledgeBaseId: string
  provider: string
  model: string
  vector: readonly number[]
  limit?: number
  minimumSimilarity?: number
  signal?: AbortSignal
}

export interface HybridSearchOptions extends SearchOptions {
  provider?: string
  model?: string
  vector?: readonly number[]
  graphEnabled?: boolean
  vectorLimit?: number
  graphDepth?: number
  minimumVectorSimilarity?: number
  candidateMultiplier?: number
  ftsWeight?: number
  vectorWeight?: number
  graphWeight?: number
  signal?: AbortSignal
}

export interface RetrievalMetadata {
  score: number
  channels: Array<'fts' | 'vector' | 'graph'>
  lexicalRank?: number
  vectorRank?: number
  graphRank?: number
  similarity?: number
  evidenceIds: string[]
}

export interface HybridSearchResult extends SearchResult {
  retrieval: RetrievalMetadata
}

export interface GraphEntity {
  id: string
  knowledgeBaseId: string
  name: string
  type: string
  aliases: string[]
  description?: string
  properties: JsonObject
  locked: boolean
  createdAt: string
  updatedAt: string
}

export interface CreateGraphEntityInput {
  id?: string
  knowledgeBaseId: string
  name: string
  type: string
  aliases?: string[]
  description?: string
  properties?: JsonObject
  locked?: boolean
}

export interface UpdateGraphEntityInput {
  name?: string
  type?: string
  aliases?: string[]
  description?: string | null
  properties?: JsonObject
  locked?: boolean
}

export interface GraphRelation {
  id: string
  knowledgeBaseId: string
  sourceEntityId: string
  targetEntityId: string
  type: string
  label?: string
  properties: JsonObject
  locked: boolean
  createdAt: string
  updatedAt: string
}

export interface CreateGraphRelationInput {
  id?: string
  knowledgeBaseId: string
  sourceEntityId: string
  targetEntityId: string
  type: string
  label?: string
  properties?: JsonObject
  locked?: boolean
}

export interface UpdateGraphRelationInput {
  sourceEntityId?: string
  targetEntityId?: string
  type?: string
  label?: string | null
  properties?: JsonObject
  locked?: boolean
}

export interface Evidence {
  id: string
  knowledgeBaseId: string
  entityId?: string
  relationId?: string
  documentId: string
  chunkId?: string
  quote?: string
  location?: string
  start?: number
  end?: number
  confidence?: number
  source: 'rules' | 'model' | 'manual' | 'legacy'
  provenance: JsonObject
  createdAt: string
}

export interface CreateEvidenceInput {
  id?: string
  knowledgeBaseId: string
  entityId?: string
  relationId?: string
  documentId: string
  chunkId?: string
  quote?: string
  location?: string
  start?: number
  end?: number
  confidence?: number
  source?: 'rules' | 'model' | 'manual' | 'legacy'
  provenance?: JsonObject
}

export interface UpdateEvidenceInput {
  entityId?: string
  relationId?: string
  documentId?: string
  chunkId?: string | null
  quote?: string | null
  location?: string | null
}
