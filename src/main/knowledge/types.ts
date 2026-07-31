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
}

export interface ReplaceChunkInput {
  id?: string
  ordinal: number
  content: string
  tokenCount?: number
  heading?: string
  location?: string
  metadata?: JsonObject
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
}

export interface UpdateEvidenceInput {
  entityId?: string
  relationId?: string
  documentId?: string
  chunkId?: string | null
  quote?: string | null
  location?: string | null
}
