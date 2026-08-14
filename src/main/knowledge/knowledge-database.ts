import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import {
  embeddingIndexJobSchema,
  type EmbeddingIndexJob
} from '../../shared/embedding-contracts'
import {
  defaultKnowledgeChunkingSettings,
  defaultKnowledgeRetrievalSettings,
  knowledgeChunkingSettingsSchema,
  knowledgeChunkRoleSchema,
  knowledgeRetrievalSettingsSchema,
  type KnowledgeChunkRole,
  type KnowledgeChunksListInput,
  type KnowledgeSettingsUpdateInput
} from '../../shared/knowledge-contracts'
import {
  defaultKnowledgeOntologySettings,
  isRelationEndpointAllowed,
  knowledgeOntologySettingsSchema,
  normalizeEntityTypeAlias,
  normalizeOntologyAlias,
  normalizeRelationTypeAlias
} from '../../shared/knowledge-ontology'
import type {
  KnowledgeTaskError,
  KnowledgeTaskItem,
  KnowledgeTaskKind,
  KnowledgeTaskScope,
  KnowledgeTaskStage,
  KnowledgeTaskStatus
} from '../../shared/knowledge-task-contracts'
import {
  knowledgeTaskKindSchema,
  knowledgeTaskScopeSchema,
  knowledgeTaskStageSchema,
  knowledgeTaskStatusSchema
} from '../../shared/knowledge-task-contracts'
import type {
  EmbeddingIndexDocument
} from './embedding-index-coordinator'
import {
  containsHanText,
  contextualIndexText,
  createCjkSearchText,
  knowledgeRetrievalTerms
} from './retrieval-text'
import { normalizeEntityAlias } from './graph-extractor'
import type {
  Chunk,
  ChunkEmbeddingInput,
  CreateEvidenceInput,
  CreateGraphEntityInput,
  CreateGraphRelationInput,
  CreateKnowledgeBaseInput,
  Document,
  EmbeddingIndexCoverage,
  Evidence,
  EmbeddingIndexState,
  GraphEntity,
  GraphRelation,
  GraphStrategy,
  HybridSearchOptions,
  HybridSearchResult,
  JsonObject,
  KnowledgeBase,
  KnowledgeSource,
  KnowledgeSourceStatus,
  KnowledgeSourceType,
  ReplaceChunkInput,
  SearchOptions,
  SearchResult,
  StorageMode,
  UpdateEvidenceInput,
  UpdateGraphEntityInput,
  UpdateGraphRelationInput,
  UpdateKnowledgeBaseInput,
  UpsertDocumentInput,
  UpsertKnowledgeSourceInput,
  VectorSearchOptions
} from './types'

const DATABASE_VERSION = 11
const MAX_ID_LENGTH = 128
const MAX_NAME_LENGTH = 512
const MAX_LOCATION_LENGTH = 8192
const MAX_CONTENT_LENGTH = 2_000_000
const MAX_JSON_LENGTH = 131_072
const MAX_CHUNKS = 10_000
const MAX_CHUNK_BATCH_CONTENT = 32_000_000
const MAX_ALIASES = 100
const MAX_LIST_LIMIT = 500
const maximumFilesPerSourceDatabaseLimit = 2_000
const MAX_JSON_ARRAY_ITEMS = 1_000
const MAX_JSON_DEPTH = 20
const MAX_JSON_NODES = 10_000
const MAX_JSON_STRING_LENGTH = 32_768
const MAX_EMBEDDING_DIMENSIONS = 8_192
const MAX_EMBEDDING_BATCH = 256
const MAX_EMBEDDING_PROVIDER_LENGTH = 128
const MAX_EMBEDDING_MODEL_LENGTH = 512
const MAX_EMBEDDING_ERROR_LENGTH = 2_000
const MAX_TASK_TEXT_LENGTH = 1_000
const MAX_TASK_DEDUPE_KEY_LENGTH = 512
const MAX_TASK_JOB_ID_LENGTH = 256
const MAX_TERMINAL_TASKS_PER_LIBRARY = 500
const MAX_GRAPH_DEPTH = 3
const RRF_CONSTANT = 60

type ScoredSearchResult = {
  result: SearchResult
  similarity?: number
  evidenceIds?: string[]
}

export type HybridSearchResultPage = {
  results: HybridSearchResult[]
  vectorScannedCount: number
}

export type PreparedEmbeddingReplacement = {
  replacementId: string
  provider: string
  model: string
}

export type DocumentPublicationOptions = {
  embeddingReplacement?: PreparedEmbeddingReplacement
  embeddingError?: {
    provider: string
    model: string
    message: string
  }
  afterChunksInserted?: (document: Document) => void
}

type Row = Record<string, null | number | bigint | string | Uint8Array>

const taskScopes = knowledgeTaskScopeSchema.options
const taskKinds = knowledgeTaskKindSchema.options
const taskStages = knowledgeTaskStageSchema.options
const taskStatuses = knowledgeTaskStatusSchema.options
const activeTaskStatuses: readonly KnowledgeTaskStatus[] = [
  'queued',
  'running'
]
const terminalTaskStatuses: readonly KnowledgeTaskStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
  'interrupted'
]

export type CreateKnowledgeTaskInput = {
  id?: string
  libraryId: string
  parentTaskId?: string
  retryOfTaskId?: string
  sourceId?: string
  documentId?: string
  documentName: string
  scope: KnowledgeTaskScope
  kind: KnowledgeTaskKind
  stage?: KnowledgeTaskStage
  status?: KnowledgeTaskStatus
  progress?: number
  completedItems?: number
  totalItems?: number
  message?: string
  error?: KnowledgeTaskError
  attempt?: number
  dedupeKey?: string
  embeddingJobId?: string
}

export type UpdateKnowledgeTaskInput = {
  sourceId?: string | null
  documentId?: string | null
  documentName?: string
  stage?: KnowledgeTaskStage
  status?: KnowledgeTaskStatus
  progress?: number
  completedItems?: number | null
  totalItems?: number | null
  message?: string | null
  error?: KnowledgeTaskError | null
  embeddingJobId?: string | null
}

function requiredString(
  value: string,
  field: string,
  maximum: number,
  trim = true
): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a string`)
  }
  const normalized = trim ? value.trim() : value
  if (normalized.trim().length === 0) {
    throw new RangeError(`${field} must not be empty`)
  }
  if (normalized.length > maximum) {
    throw new RangeError(`${field} must be at most ${maximum} characters`)
  }
  return normalized
}

function optionalString(
  value: string | null | undefined,
  field: string,
  maximum: number,
  trim = true
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  return requiredString(value, field, maximum, trim)
}

function truncatedOptionalString(
  value: string | null | undefined,
  maximum: number
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  const normalized = String(value).trim()
  return normalized ? normalized.slice(0, maximum) : undefined
}

function boundedInteger(
  value: number,
  field: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${field} must be an integer between ${minimum} and ${maximum}`
    )
  }
  return value
}

function enumValue<T extends string>(
  value: T,
  field: string,
  values: readonly T[]
): T {
  if (!values.includes(value)) {
    throw new RangeError(`${field} has an unsupported value`)
  }
  return value
}

function validateJsonValue(
  value: unknown,
  field: string,
  seen: WeakSet<object>,
  depth: number,
  state: { nodes: number }
): void {
  state.nodes += 1
  if (state.nodes > MAX_JSON_NODES) {
    throw new RangeError(`${field} contains too many values`)
  }
  if (value === null || typeof value === 'boolean') {
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${field} must contain only finite numbers`)
    }
    return
  }
  if (typeof value === 'string') {
    if (value.length > MAX_JSON_STRING_LENGTH) {
      throw new RangeError(
        `${field} strings must be at most ${MAX_JSON_STRING_LENGTH} characters`
      )
    }
    return
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${field} contains an unsupported value`)
  }
  if (depth >= MAX_JSON_DEPTH) {
    throw new RangeError(`${field} must be at most ${MAX_JSON_DEPTH} levels deep`)
  }
  if (seen.has(value)) {
    throw new TypeError(`${field} must not contain circular references`)
  }
  seen.add(value)
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY_ITEMS) {
      throw new RangeError(
        `${field} arrays must contain at most ${MAX_JSON_ARRAY_ITEMS} items`
      )
    }
    for (const item of value) {
      validateJsonValue(item, field, seen, depth + 1, state)
    }
    seen.delete(value)
    return
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${field} must contain only plain objects`)
  }
  for (const [key, item] of Object.entries(value)) {
    requiredString(key, `${field} key`, 256, false)
    if (key.replaceAll(/[_\-\s]/g, '').toLowerCase() === 'apikey') {
      throw new Error(`${field} must not contain API keys`)
    }
    validateJsonValue(item, field, seen, depth + 1, state)
  }
  seen.delete(value)
}

function jsonObject(value: JsonObject | undefined, field: string): string {
  const object = value ?? {}
  if (
    typeof object !== 'object' ||
    object === null ||
    Array.isArray(object)
  ) {
    throw new TypeError(`${field} must be an object`)
  }
  validateJsonValue(object, field, new WeakSet(), 0, { nodes: 0 })
  const serialized = JSON.stringify(object)
  if (serialized.length > MAX_JSON_LENGTH) {
    throw new RangeError(
      `${field} must serialize to at most ${MAX_JSON_LENGTH} characters`
    )
  }
  return serialized
}

function stringArray(
  value: string[] | undefined,
  field: string
): string[] {
  const items = value ?? []
  if (!Array.isArray(items) || items.length > MAX_ALIASES) {
    throw new RangeError(`${field} must contain at most ${MAX_ALIASES} items`)
  }
  return [
    ...new Set(
      items.map((item, index) =>
        requiredString(item, `${field}[${index}]`, MAX_NAME_LENGTH)
      )
    )
  ]
}

function parseObject(value: string): JsonObject {
  return JSON.parse(value) as JsonObject
}

function parseSettings<T>(
  value: string | null | number | bigint | Uint8Array | undefined,
  schema: { parse(input: unknown): T },
  fallback: T
): T {
  if (typeof value !== 'string') {
    return fallback
  }
  try {
    return schema.parse(JSON.parse(value))
  } catch {
    return fallback
  }
}

function parseStringArray(value: string): string[] {
  return JSON.parse(value) as string[]
}

function asString(row: Row, key: string): string {
  return row[key] as string
}

function asOptionalString(row: Row, key: string): string | undefined {
  const value = row[key]
  return value === null ? undefined : (value as string)
}

function asNumber(row: Row, key: string): number {
  return row[key] as number
}

function asBytes(row: Row, key: string): Uint8Array {
  return row[key] as Uint8Array
}

function contentChecksum(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function normalizedChecksum(value: string, field: string): string {
  const checksum = requiredString(value, field, 64).toLowerCase()
  if (!/^[a-f0-9]{64}$/u.test(checksum)) {
    throw new RangeError(`${field} must be a SHA-256 checksum`)
  }
  return checksum
}

function normalizeVector(
  value: readonly number[],
  field: string
): {
  bytes: Buffer
  dimensions: number
  magnitude: number
  values: number[]
} {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_EMBEDDING_DIMENSIONS
  ) {
    throw new RangeError(
      `${field} must contain between 1 and ${MAX_EMBEDDING_DIMENSIONS} dimensions`
    )
  }
  const bytes = Buffer.allocUnsafe(value.length * Float32Array.BYTES_PER_ELEMENT)
  const values: number[] = []
  let magnitudeSquared = 0
  for (let index = 0; index < value.length; index += 1) {
    const component = value[index]
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      throw new TypeError(`${field} must contain only finite numbers`)
    }
    const storedComponent = Math.fround(component)
    if (!Number.isFinite(storedComponent)) {
      throw new RangeError(`${field} components must fit in Float32`)
    }
    bytes.writeFloatLE(
      storedComponent,
      index * Float32Array.BYTES_PER_ELEMENT
    )
    values.push(storedComponent)
    magnitudeSquared += storedComponent * storedComponent
  }
  const magnitude = Math.sqrt(magnitudeSquared)
  if (!Number.isFinite(magnitude) || magnitude <= 0) {
    throw new RangeError(`${field} must have a finite non-zero norm`)
  }
  return { bytes, dimensions: value.length, magnitude, values }
}

function cosineSimilarity(
  left: readonly number[],
  leftMagnitude: number,
  rightBytes: Uint8Array,
  dimensions: number,
  rightMagnitude: number
): number | undefined {
  if (
    left.length !== dimensions ||
    rightBytes.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT ||
    !Number.isFinite(rightMagnitude) ||
    rightMagnitude <= 0
  ) {
    return undefined
  }
  const buffer = Buffer.from(
    rightBytes.buffer,
    rightBytes.byteOffset,
    rightBytes.byteLength
  )
  let dot = 0
  for (let index = 0; index < dimensions; index += 1) {
    const component = buffer.readFloatLE(
      index * Float32Array.BYTES_PER_ELEMENT
    )
    if (!Number.isFinite(component)) {
      return undefined
    }
    dot += (left[index] ?? 0) * component
  }
  const similarity = dot / (leftMagnitude * rightMagnitude)
  return Number.isFinite(similarity)
    ? Math.max(-1, Math.min(1, similarity))
    : undefined
}

function mapKnowledgeBase(row: Row): KnowledgeBase {
  return {
    id: asString(row, 'id'),
    name: asString(row, 'name'),
    description: asOptionalString(row, 'description'),
    storageMode: asString(row, 'storage_mode') as StorageMode,
    graphEnabled: asNumber(row, 'graph_enabled') === 1,
    graphStrategy: asString(row, 'graph_strategy') as GraphStrategy,
    retrievalSettings: parseSettings(
      row.retrieval_settings,
      knowledgeRetrievalSettingsSchema,
      defaultKnowledgeRetrievalSettings
    ),
    chunkingSettings: parseSettings(
      row.chunking_settings,
      knowledgeChunkingSettingsSchema,
      defaultKnowledgeChunkingSettings
    ),
    chunkingRebuildRequired:
      row.chunking_rebuild_required === undefined
        ? false
        : asNumber(row, 'chunking_rebuild_required') === 1,
    ontologySettings: parseSettings(
      row.ontology_settings,
      knowledgeOntologySettingsSchema,
      defaultKnowledgeOntologySettings
    ),
    ontologyRebuildRequired:
      row.ontology_rebuild_required === undefined
        ? false
        : asNumber(row, 'ontology_rebuild_required') === 1,
    createdAt: asString(row, 'created_at'),
    updatedAt: asString(row, 'updated_at')
  }
}

function mapSource(row: Row): KnowledgeSource {
  return {
    id: asString(row, 'id'),
    knowledgeBaseId: asString(row, 'knowledge_base_id'),
    type: asString(row, 'type') as KnowledgeSourceType,
    location: asString(row, 'location'),
    displayName: asString(row, 'display_name'),
    status: asString(row, 'status') as KnowledgeSourceStatus,
    lastError: asOptionalString(row, 'last_error'),
    metadata: parseObject(asString(row, 'metadata')),
    createdAt: asString(row, 'created_at'),
    updatedAt: asString(row, 'updated_at')
  }
}

function mapDocument(row: Row): Document {
  return {
    id: asString(row, 'id'),
    knowledgeBaseId: asString(row, 'knowledge_base_id'),
    sourceId: asString(row, 'source_id'),
    externalId: asString(row, 'external_id'),
    title: asString(row, 'title'),
    mimeType: asOptionalString(row, 'mime_type'),
    sourceLocation: asOptionalString(row, 'source_location'),
    checksum: asOptionalString(row, 'checksum'),
    metadata: parseObject(asString(row, 'metadata')),
    createdAt: asString(row, 'created_at'),
    updatedAt: asString(row, 'updated_at')
  }
}

function mapChunk(row: Row): Chunk {
  return {
    id: asString(row, 'id'),
    knowledgeBaseId: asString(row, 'knowledge_base_id'),
    documentId: asString(row, 'document_id'),
    ordinal: asNumber(row, 'ordinal'),
    content: asString(row, 'content'),
    tokenCount:
      row.token_count === null ? undefined : asNumber(row, 'token_count'),
    heading: asOptionalString(row, 'heading'),
    location: asOptionalString(row, 'location'),
    metadata: parseObject(asString(row, 'metadata')),
    createdAt: asString(row, 'created_at'),
    enabled: row.enabled === undefined ? true : asNumber(row, 'enabled') === 1,
    role:
      row.role === undefined
        ? 'standalone'
        : knowledgeChunkRoleSchema.parse(asString(row, 'role')),
    parentChunkId:
      row.parent_chunk_id === undefined
        ? undefined
        : asOptionalString(row, 'parent_chunk_id'),
    manuallyEdited:
      row.manually_edited === undefined
        ? false
        : asNumber(row, 'manually_edited') === 1,
    updatedAt:
      row.updated_at === undefined
        ? undefined
        : asOptionalString(row, 'updated_at')
  }
}

function chunkIndexContent(
  content: string,
  metadata: JsonObject
): string {
  return contextualIndexText(content, metadata.contextPrefix)
}

function mapEntity(row: Row): GraphEntity {
  return {
    id: asString(row, 'id'),
    knowledgeBaseId: asString(row, 'knowledge_base_id'),
    name: asString(row, 'name'),
    type: asString(row, 'type'),
    aliases: parseStringArray(asString(row, 'aliases')),
    description: asOptionalString(row, 'description'),
    properties: parseObject(asString(row, 'properties')),
    locked: asNumber(row, 'locked') === 1,
    createdAt: asString(row, 'created_at'),
    updatedAt: asString(row, 'updated_at')
  }
}

function mapRelation(row: Row): GraphRelation {
  return {
    id: asString(row, 'id'),
    knowledgeBaseId: asString(row, 'knowledge_base_id'),
    sourceEntityId: asString(row, 'source_entity_id'),
    targetEntityId: asString(row, 'target_entity_id'),
    type: asString(row, 'type'),
    label: asOptionalString(row, 'label'),
    properties: parseObject(asString(row, 'properties')),
    locked: asNumber(row, 'locked') === 1,
    createdAt: asString(row, 'created_at'),
    updatedAt: asString(row, 'updated_at')
  }
}

function mapEvidence(row: Row): Evidence {
  return {
    id: asString(row, 'id'),
    knowledgeBaseId: asString(row, 'knowledge_base_id'),
    entityId: asOptionalString(row, 'entity_id'),
    relationId: asOptionalString(row, 'relation_id'),
    documentId: asString(row, 'document_id'),
    chunkId: asOptionalString(row, 'chunk_id'),
    quote: asOptionalString(row, 'quote'),
    location: asOptionalString(row, 'location'),
    start:
      row.start_offset === undefined || row.start_offset === null
        ? undefined
        : asNumber(row, 'start_offset'),
    end:
      row.end_offset === undefined || row.end_offset === null
        ? undefined
        : asNumber(row, 'end_offset'),
    confidence:
      row.confidence === undefined || row.confidence === null
        ? undefined
        : asNumber(row, 'confidence'),
    source:
      row.source === undefined
        ? 'legacy'
        : (asString(row, 'source') as Evidence['source']),
    provenance:
      row.provenance === undefined
        ? {}
        : parseObject(asString(row, 'provenance')),
    createdAt: asString(row, 'created_at')
  }
}

function mapEmbeddingIndexState(row: Row): EmbeddingIndexState {
  return {
    documentId: asString(row, 'document_id'),
    knowledgeBaseId: asString(row, 'knowledge_base_id'),
    provider: asString(row, 'provider'),
    model: asString(row, 'model'),
    dimensions:
      row.dimensions === null ? undefined : asNumber(row, 'dimensions'),
    contentChecksum: asString(row, 'content_checksum'),
    status: asString(row, 'status') as EmbeddingIndexState['status'],
    lastError: asOptionalString(row, 'last_error'),
    updatedAt: asString(row, 'updated_at')
  }
}

function mapKnowledgeTask(row: Row): KnowledgeTaskItem {
  const status = asString(row, 'status') as KnowledgeTaskStatus
  const kind = asString(row, 'kind') as KnowledgeTaskKind
  const topLevel = row.parent_task_id === null
  const sourceId = asOptionalString(row, 'source_id')
  const documentId = asOptionalString(row, 'document_id')
  const message = asOptionalString(row, 'message')
  const errorMessage = asOptionalString(row, 'error_message')
  return {
    id: asString(row, 'id'),
    libraryId: asString(row, 'library_id'),
    parentTaskId: asOptionalString(row, 'parent_task_id'),
    retryOfTaskId: asOptionalString(row, 'retry_of_task_id'),
    sourceId,
    documentId,
    documentName: asString(row, 'document_name'),
    scope: asString(row, 'scope') as KnowledgeTaskScope,
    kind,
    stage: asString(row, 'stage') as KnowledgeTaskStage,
    status,
    progress: asNumber(row, 'progress'),
    completedItems:
      row.completed_items === null
        ? undefined
        : asNumber(row, 'completed_items'),
    totalItems:
      row.total_items === null ? undefined : asNumber(row, 'total_items'),
    message,
    error: errorMessage
      ? {
          message: errorMessage,
          remedy: asOptionalString(row, 'error_remedy')
        }
      : undefined,
    attempt: asNumber(row, 'attempt'),
    canCancel:
      topLevel &&
      activeTaskStatuses.includes(status) &&
      [
        'source-sync',
        'document-process',
        'document-rebuild',
        'library-rebuild',
        'embedding-rebuild',
        'graph-rebuild'
      ].includes(kind),
    canRetry:
      topLevel &&
      ['failed', 'cancelled', 'interrupted'].includes(status) &&
      [
        'source-sync',
        'document-rebuild',
        'library-rebuild',
        'embedding-rebuild',
        'graph-rebuild'
      ].includes(kind) &&
      (kind !== 'source-sync' || sourceId !== undefined) &&
      (kind !== 'document-rebuild' || documentId !== undefined),
    embeddingJobId: asOptionalString(row, 'embedding_job_id'),
    createdAt: asString(row, 'created_at'),
    startedAt: asOptionalString(row, 'started_at'),
    completedAt: asOptionalString(row, 'completed_at'),
    updatedAt: asString(row, 'updated_at')
  }
}

export class KnowledgeDatabase {
  private database?: DatabaseSync
  private readonly taskPrunedLibraries = new Set<string>()
  private readonly taskPrunePending = new Set<string>()

  constructor(private readonly databasePath: string) {
    requiredString(databasePath, 'databasePath', MAX_LOCATION_LENGTH, false)
  }

  initialize(): void {
    if (this.database) {
      return
    }

    const database = new DatabaseSync(this.databasePath, {
      enableForeignKeyConstraints: true,
      timeout: 5_000
    })
    try {
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
      `)
      this.assertFts5(database)
      this.migrate(database)
      this.database = database
      this.interruptActiveKnowledgeTasks()
      database
        .prepare('DELETE FROM embedding_rebuild_staging')
        .run()
    } catch (error) {
      this.database = undefined
      database.close()
      throw error
    }
  }

  close(): void {
    if (!this.database) {
      return
    }
    this.database.close()
    this.database = undefined
    this.taskPrunedLibraries.clear()
    this.taskPrunePending.clear()
  }

  createKnowledgeBase(input: CreateKnowledgeBaseInput): KnowledgeBase {
    const database = this.requireDatabase()
    const id = optionalString(input.id, 'id', MAX_ID_LENGTH) ?? randomUUID()
    const name = requiredString(input.name, 'name', MAX_NAME_LENGTH)
    const description = optionalString(
      input.description,
      'description',
      MAX_CONTENT_LENGTH
    )
    const storageMode = enumValue(input.storageMode, 'storageMode', [
      'reference',
      'managed'
    ])
    const graphStrategy = enumValue(
      input.graphStrategy ?? 'hybrid',
      'graphStrategy',
      ['rules', 'model', 'hybrid', 'ask']
    )
    const now = new Date().toISOString()
    database
      .prepare(
        `INSERT INTO knowledge_bases
          (id, name, description, storage_mode, graph_enabled, graph_strategy,
           retrieval_settings, chunking_settings, chunking_rebuild_required,
           ontology_settings, ontology_rebuild_required, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?)`
      )
      .run(
        id,
        name,
        description ?? null,
        storageMode,
        input.graphEnabled === true ? 1 : 0,
        graphStrategy,
        JSON.stringify(defaultKnowledgeRetrievalSettings),
        JSON.stringify(defaultKnowledgeChunkingSettings),
        JSON.stringify(defaultKnowledgeOntologySettings),
        now,
        now
      )
    return this.getKnowledgeBase(id) as KnowledgeBase
  }

  listKnowledgeBases(limit = MAX_LIST_LIMIT): KnowledgeBase[] {
    boundedInteger(limit, 'limit', 1, MAX_LIST_LIMIT)
    return this.requireDatabase()
      .prepare(
        `SELECT * FROM knowledge_bases
         ORDER BY created_at ASC, id ASC LIMIT ?`
      )
      .all(limit)
      .map(mapKnowledgeBase)
  }

  getKnowledgeBaseCounts(): Map<
    string,
    {
      sourceCount: number
      documentCount: number
      indexedDocumentCount: number
    }
  > {
    const rows = this.requireDatabase()
      .prepare(
        `SELECT kb.id,
           COUNT(DISTINCT s.id) AS source_count,
           COUNT(DISTINCT d.id) AS document_count,
           COUNT(DISTINCT CASE
             WHEN COALESCE(json_extract(d.metadata, '$.status'), 'ready')
               <> 'failed'
             THEN d.id END) AS indexed_document_count
         FROM knowledge_bases kb
         LEFT JOIN knowledge_sources s ON s.knowledge_base_id = kb.id
         LEFT JOIN documents d ON d.knowledge_base_id = kb.id
         GROUP BY kb.id`
      )
      .all()
    return new Map(
      rows.map((row) => [
        asString(row, 'id'),
        {
          sourceCount: asNumber(row, 'source_count'),
          documentCount: asNumber(row, 'document_count'),
          indexedDocumentCount: asNumber(
            row,
            'indexed_document_count'
          )
        }
      ])
    )
  }

  getKnowledgeBase(id: string): KnowledgeBase | undefined {
    const normalizedId = requiredString(id, 'id', MAX_ID_LENGTH)
    const row = this.requireDatabase()
      .prepare('SELECT * FROM knowledge_bases WHERE id = ?')
      .get(normalizedId)
    return row ? mapKnowledgeBase(row) : undefined
  }

  updateKnowledgeBase(
    id: string,
    input: UpdateKnowledgeBaseInput
  ): KnowledgeBase {
    const current = this.requiredKnowledgeBase(id)
    const name =
      input.name === undefined
        ? current.name
        : requiredString(input.name, 'name', MAX_NAME_LENGTH)
    const description =
      input.description === undefined
        ? current.description
        : optionalString(input.description, 'description', MAX_CONTENT_LENGTH)
    const storageMode =
      input.storageMode === undefined
        ? current.storageMode
        : enumValue(input.storageMode, 'storageMode', ['reference', 'managed'])
    const graphStrategy =
      input.graphStrategy === undefined
        ? current.graphStrategy
        : enumValue(input.graphStrategy, 'graphStrategy', [
            'rules',
            'model',
            'hybrid',
            'ask'
          ])
    const graphEnabled = input.graphEnabled ?? current.graphEnabled
    const enablingGraph = !current.graphEnabled && graphEnabled
    const graphConfigurationChanged =
      graphEnabled &&
      (
        enablingGraph ||
        graphStrategy !== current.graphStrategy
      )
    this.requireDatabase()
      .prepare(
        `UPDATE knowledge_bases
         SET name = ?, description = ?, storage_mode = ?, graph_enabled = ?,
             graph_strategy = ?,
             ontology_rebuild_required = CASE
               WHEN ? = 1 THEN 1 ELSE ontology_rebuild_required END,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        name,
        description ?? null,
        storageMode,
        graphEnabled ? 1 : 0,
        graphStrategy,
        graphConfigurationChanged ? 1 : 0,
        new Date().toISOString(),
        current.id
      )
    return this.requiredKnowledgeBase(current.id)
  }

  updateKnowledgeSettings(
    input: KnowledgeSettingsUpdateInput
  ): KnowledgeBase {
    const current = this.requiredKnowledgeBase(input.knowledgeBaseId)
    const retrieval = input.retrieval
      ? knowledgeRetrievalSettingsSchema.parse(input.retrieval)
      : current.retrievalSettings
    const chunking = input.chunking
      ? knowledgeChunkingSettingsSchema.parse(input.chunking)
      : current.chunkingSettings
    const ontology = input.ontology
      ? knowledgeOntologySettingsSchema.parse(input.ontology)
      : current.ontologySettings
    const chunkingChanged =
      input.chunking !== undefined &&
      JSON.stringify(chunking) !== JSON.stringify(current.chunkingSettings)
    const ontologyChanged =
      input.ontology !== undefined &&
      JSON.stringify(ontology) !== JSON.stringify(current.ontologySettings)
    this.requireDatabase()
      .prepare(
        `UPDATE knowledge_bases
         SET retrieval_settings = ?, chunking_settings = ?,
             chunking_rebuild_required = CASE
               WHEN NOT EXISTS (
                 SELECT 1 FROM documents
                 WHERE documents.knowledge_base_id = knowledge_bases.id
               ) THEN 0
               WHEN ? = 1 THEN 1 ELSE chunking_rebuild_required END,
             ontology_settings = ?,
             ontology_rebuild_required = CASE
               WHEN ? = 1 THEN 1 ELSE ontology_rebuild_required END,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        JSON.stringify(retrieval),
        JSON.stringify(chunking),
        chunkingChanged ? 1 : 0,
        JSON.stringify(ontology),
        ontologyChanged ? 1 : 0,
        new Date().toISOString(),
        current.id
      )
    return this.requiredKnowledgeBase(current.id)
  }

  markKnowledgeChunkingRebuilt(knowledgeBaseId: string): void {
    this.requireDatabase()
      .prepare(
        `UPDATE knowledge_bases SET chunking_rebuild_required = 0,
           updated_at = ? WHERE id = ?`
      )
      .run(
        new Date().toISOString(),
        requiredString(knowledgeBaseId, 'knowledgeBaseId', MAX_ID_LENGTH)
      )
  }

  markKnowledgeOntologyRebuilt(knowledgeBaseId: string): void {
    this.requireDatabase()
      .prepare(
        `UPDATE knowledge_bases SET ontology_rebuild_required = 0,
           updated_at = ? WHERE id = ?`
      )
      .run(
        new Date().toISOString(),
        requiredString(knowledgeBaseId, 'knowledgeBaseId', MAX_ID_LENGTH)
      )
  }

  deleteKnowledgeBase(id: string): boolean {
    const normalizedId = requiredString(id, 'id', MAX_ID_LENGTH)
    const deleted =
      this.requireDatabase()
        .prepare('DELETE FROM knowledge_bases WHERE id = ?')
        .run(normalizedId).changes > 0
    if (deleted) {
      this.taskPrunedLibraries.delete(normalizedId)
      this.taskPrunePending.delete(normalizedId)
    }
    return deleted
  }

  createKnowledgeTask(input: CreateKnowledgeTaskInput): KnowledgeTaskItem {
    const database = this.requireDatabase()
    const id = optionalString(input.id, 'id', MAX_ID_LENGTH) ?? randomUUID()
    const libraryId = requiredString(
      input.libraryId,
      'libraryId',
      MAX_ID_LENGTH
    )
    const parentTaskId = optionalString(
      input.parentTaskId,
      'parentTaskId',
      MAX_ID_LENGTH
    )
    const retryOfTaskId = optionalString(
      input.retryOfTaskId,
      'retryOfTaskId',
      MAX_ID_LENGTH
    )
    const sourceId = optionalString(input.sourceId, 'sourceId', MAX_ID_LENGTH)
    const documentId = optionalString(
      input.documentId,
      'documentId',
      MAX_ID_LENGTH
    )
    const documentName = requiredString(
      input.documentName,
      'documentName',
      MAX_NAME_LENGTH
    )
    const scope = enumValue(input.scope, 'scope', taskScopes)
    const kind = enumValue(input.kind, 'kind', taskKinds)
    const status = enumValue(input.status ?? 'queued', 'status', taskStatuses)
    const stage = enumValue(input.stage ?? 'queued', 'stage', taskStages)
    const progress = boundedInteger(
      input.progress ??
        (status === 'succeeded' || status === 'skipped' ? 100 : 0),
      'progress',
      0,
      100
    )
    const completedItems =
      input.completedItems === undefined
        ? undefined
        : boundedInteger(
            input.completedItems,
            'completedItems',
            0,
            Number.MAX_SAFE_INTEGER
          )
    const totalItems =
      input.totalItems === undefined
        ? undefined
        : boundedInteger(
            input.totalItems,
            'totalItems',
            0,
            Number.MAX_SAFE_INTEGER
          )
    if (
      completedItems !== undefined &&
      totalItems !== undefined &&
      completedItems > totalItems
    ) {
      throw new RangeError('completedItems must not exceed totalItems')
    }
    const message = optionalString(
      input.message,
      'message',
      MAX_TASK_TEXT_LENGTH
    )
    const errorMessage = optionalString(
      input.error?.message,
      'error.message',
      MAX_TASK_TEXT_LENGTH
    )
    const errorRemedy = optionalString(
      input.error?.remedy,
      'error.remedy',
      MAX_TASK_TEXT_LENGTH
    )
    if (status === 'failed' && !errorMessage) {
      throw new Error('Failed tasks must include an error')
    }
    if (status === 'succeeded' && progress !== 100) {
      throw new Error('Succeeded tasks must report 100 percent')
    }
    const attempt = boundedInteger(
      input.attempt ?? 1,
      'attempt',
      1,
      Number.MAX_SAFE_INTEGER
    )
    const dedupeKey = optionalString(
      input.dedupeKey,
      'dedupeKey',
      MAX_TASK_DEDUPE_KEY_LENGTH
    )
    const embeddingJobId = optionalString(
      input.embeddingJobId,
      'embeddingJobId',
      MAX_TASK_JOB_ID_LENGTH
    )
    const now = new Date().toISOString()
    const terminal = terminalTaskStatuses.includes(status)
    try {
      database
        .prepare(
          `INSERT INTO knowledge_tasks
            (id, library_id, parent_task_id, retry_of_task_id, source_id,
             document_id, document_name, scope, kind, stage, status, progress,
             completed_items, total_items, message, error_message,
             error_remedy, attempt, dedupe_key, embedding_job_id, created_at,
             started_at, completed_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          libraryId,
          parentTaskId ?? null,
          retryOfTaskId ?? null,
          sourceId ?? null,
          documentId ?? null,
          documentName,
          scope,
          kind,
          stage,
          status,
          progress,
          completedItems ?? null,
          totalItems ?? null,
          message ?? null,
          errorMessage ?? null,
          errorRemedy ?? null,
          attempt,
          dedupeKey ?? null,
          embeddingJobId ?? null,
          now,
          status === 'running' ? now : null,
          terminal ? now : null,
          now
        )
    } catch (error) {
      if (
        dedupeKey &&
        error instanceof Error &&
        error.message.includes('UNIQUE constraint failed')
      ) {
        const existing = this.getActiveKnowledgeTaskByDedupeKey(
          libraryId,
          dedupeKey
        )
        if (existing) {
          return existing
        }
      }
      throw error
    }
    if (terminal) {
      this.taskPrunePending.add(libraryId)
    }
    return this.requiredKnowledgeTask(id)
  }

  getKnowledgeTask(id: string): KnowledgeTaskItem | undefined {
    const row = this.requireDatabase()
      .prepare('SELECT * FROM knowledge_tasks WHERE id = ?')
      .get(requiredString(id, 'id', MAX_ID_LENGTH))
    return row ? mapKnowledgeTask(row) : undefined
  }

  getActiveKnowledgeTaskByDedupeKey(
    libraryId: string,
    dedupeKey: string
  ): KnowledgeTaskItem | undefined {
    const row = this.requireDatabase()
      .prepare(
        `SELECT * FROM knowledge_tasks
         WHERE library_id = ? AND dedupe_key = ?
           AND status IN ('queued', 'running') LIMIT 1`
      )
      .get(
        requiredString(libraryId, 'libraryId', MAX_ID_LENGTH),
        requiredString(
          dedupeKey,
          'dedupeKey',
          MAX_TASK_DEDUPE_KEY_LENGTH
        )
      )
    return row ? mapKnowledgeTask(row) : undefined
  }

  getKnowledgeTaskByEmbeddingJobId(
    libraryId: string,
    embeddingJobId: string
  ): KnowledgeTaskItem | undefined {
    const row = this.requireDatabase()
      .prepare(
        `SELECT * FROM knowledge_tasks
         WHERE library_id = ? AND embedding_job_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`
      )
      .get(
        requiredString(libraryId, 'libraryId', MAX_ID_LENGTH),
        requiredString(
          embeddingJobId,
          'embeddingJobId',
          MAX_TASK_JOB_ID_LENGTH
        )
      )
    return row ? mapKnowledgeTask(row) : undefined
  }

  listKnowledgeTasks(
    libraryId: string,
    limit = MAX_LIST_LIMIT
  ): KnowledgeTaskItem[] {
    boundedInteger(limit, 'limit', 1, MAX_LIST_LIMIT)
    const normalizedLibraryId = requiredString(
      libraryId,
      'libraryId',
      MAX_ID_LENGTH
    )
    if (
      !this.taskPrunedLibraries.has(normalizedLibraryId) ||
      this.taskPrunePending.has(normalizedLibraryId)
    ) {
      this.pruneKnowledgeTasks(normalizedLibraryId)
    }
    return this.requireDatabase()
      .prepare(
        `WITH RECURSIVE retained(id) AS (
           SELECT id FROM (
             SELECT id FROM knowledge_tasks
             WHERE library_id = ?
               AND status NOT IN ('queued', 'running')
             ORDER BY created_at DESC, id DESC LIMIT ?
           )
           UNION
           SELECT task.parent_task_id
           FROM knowledge_tasks task
           JOIN retained ON task.id = retained.id
           WHERE task.parent_task_id IS NOT NULL
           UNION
           SELECT task.retry_of_task_id
           FROM knowledge_tasks task
           JOIN retained ON task.id = retained.id
           WHERE task.retry_of_task_id IS NOT NULL
         )
         SELECT * FROM knowledge_tasks
         WHERE library_id = ? AND status IN ('queued', 'running')
         UNION ALL
         SELECT task.* FROM knowledge_tasks task
         JOIN retained ON task.id = retained.id
         WHERE task.status NOT IN ('queued', 'running')
         ORDER BY created_at DESC, id DESC`
      )
      .all(normalizedLibraryId, limit, normalizedLibraryId)
      .map(mapKnowledgeTask)
  }

  listActiveKnowledgeTasks(libraryId?: string): KnowledgeTaskItem[] {
    const database = this.requireDatabase()
    const rows = libraryId
      ? database
          .prepare(
            `SELECT * FROM knowledge_tasks
             WHERE library_id = ? AND status IN ('queued', 'running')
             ORDER BY created_at ASC, id ASC`
          )
          .all(requiredString(libraryId, 'libraryId', MAX_ID_LENGTH))
      : database
          .prepare(
            `SELECT * FROM knowledge_tasks
             WHERE status IN ('queued', 'running')
             ORDER BY created_at ASC, id ASC`
          )
          .all()
    return rows.map(mapKnowledgeTask)
  }

  updateKnowledgeTask(
    id: string,
    update: UpdateKnowledgeTaskInput
  ): KnowledgeTaskItem | undefined {
    const current = this.getKnowledgeTask(id)
    if (!current || terminalTaskStatuses.includes(current.status)) {
      return current
    }
    const status = enumValue(
      update.status ?? current.status,
      'status',
      taskStatuses
    )
    const stage = enumValue(
      update.stage ?? current.stage,
      'stage',
      taskStages
    )
    const progress = boundedInteger(
      status === 'succeeded' || status === 'skipped'
        ? 100
        : update.progress ?? current.progress,
      'progress',
      0,
      100
    )
    const completedItems =
      update.completedItems === null
        ? undefined
        : update.completedItems === undefined
          ? current.completedItems
          : boundedInteger(
              update.completedItems,
              'completedItems',
              0,
              Number.MAX_SAFE_INTEGER
            )
    const totalItems =
      update.totalItems === null
        ? undefined
        : update.totalItems === undefined
          ? current.totalItems
          : boundedInteger(
              update.totalItems,
              'totalItems',
              0,
              Number.MAX_SAFE_INTEGER
            )
    if (
      completedItems !== undefined &&
      totalItems !== undefined &&
      completedItems > totalItems
    ) {
      throw new RangeError('completedItems must not exceed totalItems')
    }
    const message =
      update.message === null
        ? undefined
        : update.message === undefined
          ? current.message
          : truncatedOptionalString(update.message, MAX_TASK_TEXT_LENGTH)
    const error =
      update.error === null
        ? undefined
        : update.error === undefined
          ? current.error
          : {
              message:
                truncatedOptionalString(
                  update.error.message,
                  MAX_TASK_TEXT_LENGTH
                ) ?? '任务失败',
              remedy: truncatedOptionalString(
                update.error.remedy,
                MAX_TASK_TEXT_LENGTH
              )
            }
    if (status === 'failed' && !error) {
      throw new Error('Failed tasks must include an error')
    }
    const sourceId =
      update.sourceId === null
        ? undefined
        : update.sourceId === undefined
          ? current.sourceId
          : requiredString(update.sourceId, 'sourceId', MAX_ID_LENGTH)
    const documentId =
      update.documentId === null
        ? undefined
        : update.documentId === undefined
          ? current.documentId
          : requiredString(update.documentId, 'documentId', MAX_ID_LENGTH)
    const documentName =
      update.documentName === undefined
        ? current.documentName
        : requiredString(
            update.documentName,
            'documentName',
            MAX_NAME_LENGTH
          )
    const embeddingJobId =
      update.embeddingJobId === null
        ? undefined
        : update.embeddingJobId === undefined
          ? current.embeddingJobId
          : requiredString(
              update.embeddingJobId,
              'embeddingJobId',
              MAX_TASK_JOB_ID_LENGTH
            )
    const now = new Date().toISOString()
    const terminal = terminalTaskStatuses.includes(status)
    const changes = this.requireDatabase()
      .prepare(
        `UPDATE knowledge_tasks SET
           source_id = ?, document_id = ?, document_name = ?, stage = ?,
           status = ?, progress = ?, completed_items = ?, total_items = ?,
           message = ?, error_message = ?, error_remedy = ?,
           embedding_job_id = ?,
           started_at = CASE
             WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at
           END,
           completed_at = CASE
             WHEN ? = 1 THEN COALESCE(completed_at, ?) ELSE completed_at
           END,
           updated_at = ?
         WHERE id = ? AND status IN ('queued', 'running')`
      )
      .run(
        sourceId ?? null,
        documentId ?? null,
        documentName,
        stage,
        status,
        progress,
        completedItems ?? null,
        totalItems ?? null,
        message ?? null,
        error?.message ?? null,
        error?.remedy ?? null,
        embeddingJobId ?? null,
        status,
        now,
        terminal ? 1 : 0,
        now,
        now,
        current.id
      ).changes
    if (changes > 0 && terminal) {
      this.taskPrunePending.add(current.libraryId)
    }
    return this.getKnowledgeTask(current.id)
  }

  cancelKnowledgeTask(
    id: string,
    message = '任务已取消'
  ): boolean {
    const current = this.getKnowledgeTask(id)
    if (!current || !activeTaskStatuses.includes(current.status)) {
      return false
    }
    return (
      this.updateKnowledgeTask(current.id, {
        status: 'cancelled',
        message,
        error: null
      })?.status === 'cancelled'
    )
  }

  interruptActiveKnowledgeTasks(
    message = '应用重启，任务已中断'
  ): number {
    if (!this.database) {
      return 0
    }
    const normalizedMessage = requiredString(
      message,
      'message',
      MAX_TASK_TEXT_LENGTH
    )
    const now = new Date().toISOString()
    return Number(
      this.database
        .prepare(
          `UPDATE knowledge_tasks
           SET status = 'interrupted', message = ?, error_message = ?,
               error_remedy = '请重试该任务。', completed_at = ?,
               updated_at = ?
           WHERE status IN ('queued', 'running')`
        )
        .run(normalizedMessage, normalizedMessage, now, now).changes
    )
  }

  pruneKnowledgeTasks(libraryId: string): number {
    const normalizedLibraryId = requiredString(
      libraryId,
      'libraryId',
      MAX_ID_LENGTH
    )
    const changes = Number(
      this.requireDatabase()
        .prepare(
          `WITH RECURSIVE retained(id) AS (
             SELECT id FROM (
               SELECT id FROM knowledge_tasks
               WHERE library_id = ?
                 AND status NOT IN ('queued', 'running')
               ORDER BY created_at DESC, id DESC LIMIT ?
             )
             UNION
             SELECT task.parent_task_id
             FROM knowledge_tasks task
             JOIN retained ON task.id = retained.id
             WHERE task.parent_task_id IS NOT NULL
             UNION
             SELECT task.retry_of_task_id
             FROM knowledge_tasks task
             JOIN retained ON task.id = retained.id
             WHERE task.retry_of_task_id IS NOT NULL
           )
           DELETE FROM knowledge_tasks
           WHERE library_id = ? AND status NOT IN ('queued', 'running')
             AND id NOT IN (SELECT id FROM retained)`
        )
        .run(
          normalizedLibraryId,
          MAX_TERMINAL_TASKS_PER_LIBRARY,
          normalizedLibraryId
        ).changes
    )
    this.taskPrunedLibraries.add(normalizedLibraryId)
    this.taskPrunePending.delete(normalizedLibraryId)
    return changes
  }

  upsertSource(input: UpsertKnowledgeSourceInput): KnowledgeSource {
    const database = this.requireDatabase()
    const knowledgeBaseId = requiredString(
      input.knowledgeBaseId,
      'knowledgeBaseId',
      MAX_ID_LENGTH
    )
    const type = enumValue(input.type, 'type', ['file', 'directory', 'url'])
    const location = requiredString(
      input.location,
      'location',
      MAX_LOCATION_LENGTH,
      false
    )
    const requestedId = optionalString(input.id, 'id', MAX_ID_LENGTH)
    const naturalMatch = requestedId
      ? undefined
      : database
          .prepare(
            `SELECT * FROM knowledge_sources
             WHERE knowledge_base_id = ? AND type = ? AND location = ?`
          )
          .get(knowledgeBaseId, type, location)
    const id =
      requestedId ??
      (naturalMatch ? asString(naturalMatch, 'id') : randomUUID())
    const existing = database
      .prepare('SELECT * FROM knowledge_sources WHERE id = ?')
      .get(id)
    if (
      existing &&
      asString(existing, 'knowledge_base_id') !== knowledgeBaseId
    ) {
      throw new Error('A knowledge source cannot move between knowledge bases')
    }
    const displayName = requiredString(
      input.displayName,
      'displayName',
      MAX_NAME_LENGTH
    )
    const status = enumValue(input.status ?? 'pending', 'status', [
      'pending',
      'indexing',
      'ready',
      'paused',
      'error'
    ])
    const lastError = optionalString(
      input.lastError,
      'lastError',
      MAX_CONTENT_LENGTH
    )
    const metadata = jsonObject(input.metadata, 'metadata')
    const now = new Date().toISOString()

    database
      .prepare(
        `INSERT INTO knowledge_sources
          (id, knowledge_base_id, type, location, display_name, status,
           last_error, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           type = excluded.type,
           location = excluded.location,
           display_name = excluded.display_name,
           status = excluded.status,
           last_error = excluded.last_error,
           metadata = excluded.metadata,
           updated_at = excluded.updated_at`
      )
      .run(
        id,
        knowledgeBaseId,
        type,
        location,
        displayName,
        status,
        lastError ?? null,
        metadata,
        now,
        now
      )
    return this.requiredSource(id)
  }

  listSources(
    knowledgeBaseId: string,
    limit = MAX_LIST_LIMIT
  ): KnowledgeSource[] {
    const normalizedId = requiredString(
      knowledgeBaseId,
      'knowledgeBaseId',
      MAX_ID_LENGTH
    )
    boundedInteger(limit, 'limit', 1, MAX_LIST_LIMIT)
    return this.requireDatabase()
      .prepare(
        `SELECT * FROM knowledge_sources
         WHERE knowledge_base_id = ?
         ORDER BY created_at ASC, id ASC LIMIT ?`
      )
      .all(normalizedId, limit)
      .map(mapSource)
  }

  listSourcesForSnapshot(knowledgeBaseId: string): KnowledgeSource[] {
    const normalizedId = requiredString(
      knowledgeBaseId,
      'knowledgeBaseId',
      MAX_ID_LENGTH
    )
    return this.requireDatabase()
      .prepare(
        `SELECT * FROM knowledge_sources
         WHERE knowledge_base_id = ?
         ORDER BY created_at ASC, id ASC`
      )
      .all(normalizedId)
      .map(mapSource)
  }

  getSource(id: string): KnowledgeSource | undefined {
    const row = this.requireDatabase()
      .prepare('SELECT * FROM knowledge_sources WHERE id = ?')
      .get(requiredString(id, 'id', MAX_ID_LENGTH))
    return row ? mapSource(row) : undefined
  }

  removeSource(id: string): boolean {
    const normalizedId = requiredString(id, 'id', MAX_ID_LENGTH)
    return (
      this.requireDatabase()
        .prepare('DELETE FROM knowledge_sources WHERE id = ?')
        .run(normalizedId).changes > 0
    )
  }

  upsertDocument(
    input: UpsertDocumentInput,
    chunks: ReplaceChunkInput[]
  ): Document {
    return this.publishDocument(input, chunks)
  }

  publishDocument(
    input: UpsertDocumentInput,
    chunks: ReplaceChunkInput[],
    options: DocumentPublicationOptions = {}
  ): Document {
    if (!Array.isArray(chunks) || chunks.length > MAX_CHUNKS) {
      throw new RangeError(`chunks must contain at most ${MAX_CHUNKS} items`)
    }
    const database = this.requireDatabase()
    const normalizedChunks = this.normalizeChunks(chunks)
    const knowledgeBaseId = requiredString(
      input.knowledgeBaseId,
      'knowledgeBaseId',
      MAX_ID_LENGTH
    )
    const sourceId = requiredString(
      input.sourceId,
      'sourceId',
      MAX_ID_LENGTH
    )
    const externalId = requiredString(
      input.externalId,
      'externalId',
      MAX_LOCATION_LENGTH,
      false
    )
    const source = database
      .prepare(
        'SELECT knowledge_base_id FROM knowledge_sources WHERE id = ?'
      )
      .get(sourceId)
    if (!source || asString(source, 'knowledge_base_id') !== knowledgeBaseId) {
      throw new Error(
        'Document source must belong to the document knowledge base'
      )
    }
    const requestedId = optionalString(input.id, 'id', MAX_ID_LENGTH)
    const naturalMatch = requestedId
      ? undefined
      : database
          .prepare(
            'SELECT id FROM documents WHERE source_id = ? AND external_id = ?'
          )
          .get(sourceId, externalId)
    const id =
      requestedId ??
      (naturalMatch ? asString(naturalMatch, 'id') : randomUUID())
    const existing = database
      .prepare('SELECT knowledge_base_id FROM documents WHERE id = ?')
      .get(id)
    if (
      existing &&
      asString(existing, 'knowledge_base_id') !== knowledgeBaseId
    ) {
      throw new Error('A document cannot move between knowledge bases')
    }
    const title = requiredString(input.title, 'title', MAX_NAME_LENGTH)
    const mimeType = optionalString(input.mimeType, 'mimeType', 256)
    const sourceLocation = optionalString(
      input.sourceLocation,
      'sourceLocation',
      MAX_LOCATION_LENGTH,
      false
    )
    const checksum = optionalString(input.checksum, 'checksum', 512)
    const metadata = jsonObject(input.metadata, 'metadata')
    const embeddingReplacement = options.embeddingReplacement
      ? {
          replacementId: requiredString(
            options.embeddingReplacement.replacementId,
            'embeddingReplacement.replacementId',
            MAX_ID_LENGTH
          ),
          provider: requiredString(
            options.embeddingReplacement.provider,
            'embeddingReplacement.provider',
            MAX_EMBEDDING_PROVIDER_LENGTH
          ),
          model: requiredString(
            options.embeddingReplacement.model,
            'embeddingReplacement.model',
            MAX_EMBEDDING_MODEL_LENGTH
          )
        }
      : undefined
    const embeddingError = options.embeddingError
      ? {
          provider: requiredString(
            options.embeddingError.provider,
            'embeddingError.provider',
            MAX_EMBEDDING_PROVIDER_LENGTH
          ),
          model: requiredString(
            options.embeddingError.model,
            'embeddingError.model',
            MAX_EMBEDDING_MODEL_LENGTH
          ),
          message: requiredString(
            options.embeddingError.message,
            'embeddingError.message',
            MAX_EMBEDDING_ERROR_LENGTH,
            false
          )
        }
      : undefined
    if (embeddingReplacement && embeddingError) {
      throw new Error(
        'Document publication cannot include embeddings and an embedding error'
      )
    }
    if (embeddingReplacement) {
      this.validatePreparedDocumentEmbeddings(
        database,
        embeddingReplacement,
        id,
        normalizedChunks
      )
    }
    const now = new Date().toISOString()

    this.transaction(database, () => {
      database
        .prepare(
          `INSERT INTO documents
            (id, knowledge_base_id, source_id, external_id, title, mime_type,
             source_location, checksum, metadata, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             source_id = excluded.source_id,
             external_id = excluded.external_id,
             title = excluded.title,
             mime_type = excluded.mime_type,
             source_location = excluded.source_location,
             checksum = excluded.checksum,
             metadata = excluded.metadata,
             updated_at = excluded.updated_at`
        )
        .run(
          id,
          knowledgeBaseId,
          sourceId,
          externalId,
          title,
          mimeType ?? null,
          sourceLocation ?? null,
          checksum ?? null,
          metadata,
          now,
          now
        )
      database
        .prepare('DELETE FROM graph_evidence WHERE document_id = ?')
        .run(id)
      database.prepare('DELETE FROM chunks WHERE document_id = ?').run(id)
      const insertChunk = database.prepare(
        `INSERT INTO chunks
          (id, knowledge_base_id, document_id, ordinal, content, token_count,
           heading, location, metadata, created_at, enabled, role,
           parent_chunk_id, manually_edited, updated_at, cjk_search,
           index_content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const chunksInForeignKeyOrder = [...normalizedChunks].sort(
        (left, right) =>
          Number(left.role === 'child') -
            Number(right.role === 'child') ||
          left.ordinal - right.ordinal
      )
      for (const chunk of chunksInForeignKeyOrder) {
        const chunkMetadata = parseObject(chunk.metadata)
        const indexContent = chunkIndexContent(
          chunk.content,
          chunkMetadata
        )
        insertChunk.run(
          chunk.id,
          knowledgeBaseId,
          id,
          chunk.ordinal,
          chunk.content,
          chunk.tokenCount ?? null,
          chunk.heading ?? null,
          chunk.location ?? null,
          chunk.metadata,
          now,
          chunk.enabled ? 1 : 0,
          chunk.role,
          chunk.parentChunkId ?? null,
          chunk.manuallyEdited ? 1 : 0,
          now,
          createCjkSearchText(
            `${chunk.heading ?? ''}\n${indexContent}`
          ),
          indexContent
        )
      }
      options.afterChunksInserted?.(this.requiredDocument(id))
      database
        .prepare(
          'DELETE FROM embedding_index_state WHERE document_id = ?'
        )
        .run(id)
      if (embeddingReplacement) {
        this.publishPreparedDocumentEmbeddings(
          database,
          embeddingReplacement,
          id,
          knowledgeBaseId,
          now
        )
      } else if (embeddingError) {
        this.recordEmbeddingIndexError(
          id,
          embeddingError.provider,
          embeddingError.model,
          embeddingError.message
        )
      }
      this.pruneUnreferencedGeneratedGraph(knowledgeBaseId)
    })
    return this.requiredDocument(id)
  }

  getDocument(id: string): Document | undefined {
    const normalizedId = requiredString(id, 'id', MAX_ID_LENGTH)
    const row = this.requireDatabase()
      .prepare('SELECT * FROM documents WHERE id = ?')
      .get(normalizedId)
    return row ? mapDocument(row) : undefined
  }

  listDocuments(
    knowledgeBaseId: string,
    limit = MAX_LIST_LIMIT
  ): Document[] {
    const normalizedId = requiredString(
      knowledgeBaseId,
      'knowledgeBaseId',
      MAX_ID_LENGTH
    )
    boundedInteger(limit, 'limit', 1, MAX_LIST_LIMIT)
    return this.requireDatabase()
      .prepare(
        `SELECT * FROM documents WHERE knowledge_base_id = ?
         ORDER BY created_at ASC, id ASC LIMIT ?`
      )
      .all(normalizedId, limit)
      .map(mapDocument)
  }

  listDocumentsForSource(sourceId: string): Document[] {
    const normalizedId = requiredString(sourceId, 'sourceId', MAX_ID_LENGTH)
    return this.requireDatabase()
      .prepare(
        `SELECT * FROM documents WHERE source_id = ?
         ORDER BY created_at ASC, id ASC LIMIT ?`
      )
      .all(normalizedId, maximumFilesPerSourceDatabaseLimit)
      .map(mapDocument)
  }

  listDocumentsForLibraryRebuild(knowledgeBaseId: string): Document[] {
    const normalizedId = requiredString(
      knowledgeBaseId,
      'knowledgeBaseId',
      MAX_ID_LENGTH
    )
    return this.requireDatabase()
      .prepare(
        `SELECT * FROM documents WHERE knowledge_base_id = ?
         ORDER BY source_id ASC, created_at ASC, id ASC`
      )
      .all(normalizedId)
      .map(mapDocument)
  }

  listDocumentsForSnapshot(knowledgeBaseId: string): Document[] {
    return this.listDocumentsForLibraryRebuild(knowledgeBaseId)
  }

  getDocumentChunkCounts(knowledgeBaseId: string): Map<string, number> {
    const normalizedId = requiredString(
      knowledgeBaseId,
      'knowledgeBaseId',
      MAX_ID_LENGTH
    )
    return new Map(
      this.requireDatabase()
        .prepare(
          `SELECT document_id, COUNT(*) AS chunk_count
           FROM chunks WHERE knowledge_base_id = ?
           GROUP BY document_id`
        )
        .all(normalizedId)
        .map((row) => [
          asString(row, 'document_id'),
          asNumber(row, 'chunk_count')
        ])
    )
  }

  removeDocument(id: string): boolean {
    const normalizedId = requiredString(id, 'id', MAX_ID_LENGTH)
    return (
      this.requireDatabase()
        .prepare('DELETE FROM documents WHERE id = ?')
        .run(normalizedId).changes > 0
    )
  }

  removeEvidenceForDocument(documentId: string): number {
    const normalizedId = requiredString(
      documentId,
      'documentId',
      MAX_ID_LENGTH
    )
    return Number(
      this.requireDatabase()
      .prepare('DELETE FROM graph_evidence WHERE document_id = ?')
      .run(normalizedId).changes
    )
  }

  replaceEvidenceForDocument(
    documentId: string,
    operation: () => void
  ): void {
    const normalizedId = requiredString(
      documentId,
      'documentId',
      MAX_ID_LENGTH
    )
    const database = this.requireDatabase()
    this.transaction(database, () => {
      database
        .prepare('DELETE FROM graph_evidence WHERE document_id = ?')
        .run(normalizedId)
      operation()
    })
  }

  pruneUnreferencedGeneratedGraph(knowledgeBaseId: string): {
    entities: number
    relations: number
  } {
    const normalizedId = requiredString(
      knowledgeBaseId,
      'knowledgeBaseId',
      MAX_ID_LENGTH
    )
    const database = this.requireDatabase()
    let entities = 0
    let relations = 0
    this.transaction(database, () => {
      relations = Number(
        database
          .prepare(
            `DELETE FROM graph_relations
             WHERE knowledge_base_id = ?
               AND locked = 0
               AND NOT EXISTS (
                 SELECT 1 FROM graph_evidence
                 WHERE relation_id = graph_relations.id
               )`
          )
          .run(normalizedId).changes
      )
      entities = Number(
        database
          .prepare(
            `DELETE FROM graph_entities
             WHERE knowledge_base_id = ?
               AND locked = 0
               AND NOT EXISTS (
                 SELECT 1 FROM graph_evidence
                 WHERE entity_id = graph_entities.id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM graph_relations
                 WHERE source_entity_id = graph_entities.id
                    OR target_entity_id = graph_entities.id
               )`
          )
          .run(normalizedId).changes
      )
    })
    return { entities, relations }
  }

  listChunks(documentId: string, limit = MAX_LIST_LIMIT): Chunk[] {
    const normalizedId = requiredString(
      documentId,
      'documentId',
      MAX_ID_LENGTH
    )
    boundedInteger(limit, 'limit', 1, MAX_CHUNKS)
    return this.requireDatabase()
      .prepare(
        `SELECT * FROM chunks WHERE document_id = ?
         ORDER BY ordinal ASC LIMIT ?`
      )
      .all(normalizedId, limit)
      .map(mapChunk)
  }

  listChunksPage(input: KnowledgeChunksListInput): {
    items: Chunk[]
    total: number
    page: number
    pageSize: number
  } {
    const document = this.getDocument(input.documentId)
    if (!document || document.knowledgeBaseId !== input.knowledgeBaseId) {
      throw new Error('Document must belong to the requested knowledge base')
    }
    const page = boundedInteger(input.page, 'page', 1, 1_000_000)
    const pageSize = boundedInteger(input.pageSize, 'pageSize', 1, 200)
    const search = optionalString(input.search, 'search', 1_000)
    const pattern = search
      ? `%${search.replaceAll('\\', '\\\\').replaceAll('%', '\\%')
        .replaceAll('_', '\\_')}%`
      : undefined
    const database = this.requireDatabase()
    const where = pattern
      ? `document_id = ? AND
         (content LIKE ? ESCAPE '\\' OR heading LIKE ? ESCAPE '\\'
          OR location LIKE ? ESCAPE '\\')`
      : 'document_id = ?'
    const parameters = pattern
      ? [document.id, pattern, pattern, pattern]
      : [document.id]
    const count = database
      .prepare(`SELECT COUNT(*) AS count FROM chunks WHERE ${where}`)
      .get(...parameters)
    const items = database
      .prepare(
        `SELECT * FROM chunks WHERE ${where}
         ORDER BY ordinal ASC, id ASC LIMIT ? OFFSET ?`
      )
      .all(
        ...parameters,
        pageSize,
        (page - 1) * pageSize
      )
      .map(mapChunk)
    return {
      items,
      total: count ? asNumber(count, 'count') : 0,
      page,
      pageSize
    }
  }

  getChunkForReference(
    knowledgeBaseId: string,
    documentId: string,
    chunkId: string
  ): { chunk: Chunk; document: Document; source: KnowledgeSource } | undefined {
    const row = this.requireDatabase()
      .prepare(
        `SELECT c.*,
           d.id AS d_id, d.knowledge_base_id AS d_knowledge_base_id,
           d.source_id AS d_source_id, d.external_id AS d_external_id,
           d.title AS d_title, d.mime_type AS d_mime_type,
           d.source_location AS d_source_location, d.checksum AS d_checksum,
           d.metadata AS d_metadata, d.created_at AS d_created_at,
           d.updated_at AS d_updated_at,
           s.id AS s_id, s.knowledge_base_id AS s_knowledge_base_id,
           s.type AS s_type, s.location AS s_location,
           s.display_name AS s_display_name, s.status AS s_status,
           s.last_error AS s_last_error, s.metadata AS s_metadata,
           s.created_at AS s_created_at, s.updated_at AS s_updated_at
         FROM chunks c JOIN documents d ON d.id = c.document_id
         JOIN knowledge_sources s ON s.id = d.source_id
         WHERE c.id = ? AND c.document_id = ? AND c.knowledge_base_id = ?
           AND d.knowledge_base_id = ? AND s.knowledge_base_id = ?`
      )
      .get(
        requiredString(chunkId, 'chunkId', MAX_ID_LENGTH),
        requiredString(documentId, 'documentId', MAX_ID_LENGTH),
        requiredString(knowledgeBaseId, 'knowledgeBaseId', MAX_ID_LENGTH),
        knowledgeBaseId,
        knowledgeBaseId
      )
    return row
      ? {
          chunk: mapChunk(row),
          document: mapDocument(this.prefixedRow(row, 'd_')),
          source: mapSource(this.prefixedRow(row, 's_'))
        }
      : undefined
  }

  updateChunk(input: {
    knowledgeBaseId: string
    documentId: string
    chunkId: string
    content?: string
    enabled?: boolean
  }): Chunk {
    const current = this.getChunkForReference(
      input.knowledgeBaseId,
      input.documentId,
      input.chunkId
    )
    if (!current) {
      throw new Error('Chunk must belong to the requested document and library')
    }
    const content =
      input.content === undefined
        ? current.chunk.content
        : requiredString(input.content, 'content', MAX_CONTENT_LENGTH, false)
    const enabled = input.enabled ?? current.chunk.enabled
    const indexContent = chunkIndexContent(
      content,
      current.chunk.metadata
    )
    const changed =
      content !== current.chunk.content || enabled !== current.chunk.enabled
    if (!changed) {
      return current.chunk
    }
    const database = this.requireDatabase()
    const now = new Date().toISOString()
    this.transaction(database, () => {
      if (content !== current.chunk.content) {
        database
          .prepare('DELETE FROM graph_evidence WHERE chunk_id = ?')
          .run(current.chunk.id)
      }
      database
        .prepare(
          `UPDATE chunks SET content = ?, enabled = ?, manually_edited = 1,
             updated_at = ?, cjk_search = ?, index_content = ? WHERE id = ?`
        )
        .run(
          content,
          enabled ? 1 : 0,
          now,
          createCjkSearchText(
            `${current.chunk.heading ?? ''}\n${indexContent}`
          ),
          indexContent,
          current.chunk.id
        )
      database
        .prepare('DELETE FROM chunk_embeddings WHERE chunk_id = ?')
        .run(current.chunk.id)
      database
        .prepare('DELETE FROM embedding_index_state WHERE document_id = ?')
        .run(current.document.id)
    })
    return this.getChunkForReference(
      input.knowledgeBaseId,
      input.documentId,
      input.chunkId
    )!.chunk
  }

  deleteChunk(input: {
    knowledgeBaseId: string
    documentId: string
    chunkId: string
  }): boolean {
    const current = this.getChunkForReference(
      input.knowledgeBaseId,
      input.documentId,
      input.chunkId
    )
    if (!current) {
      return false
    }
    const database = this.requireDatabase()
    let deleted = false
    this.transaction(database, () => {
      database
        .prepare('DELETE FROM graph_evidence WHERE chunk_id = ?')
        .run(current.chunk.id)
      database
        .prepare('DELETE FROM embedding_index_state WHERE document_id = ?')
        .run(current.document.id)
      deleted =
        database
          .prepare('DELETE FROM chunks WHERE id = ?')
          .run(current.chunk.id).changes > 0
    })
    return deleted
  }

  listContextChunks(chunk: Chunk, adjacentCount: number): Chunk[] {
    boundedInteger(adjacentCount, 'adjacentCount', 0, 2)
    const database = this.requireDatabase()
    if (chunk.parentChunkId) {
      const parent = database
        .prepare(
          `SELECT * FROM chunks WHERE id = ? AND document_id = ?
             AND enabled = 1 AND role = 'parent'`
        )
        .get(chunk.parentChunkId, chunk.documentId)
      if (parent) {
        return [mapChunk(parent)]
      }
    }
    return database
      .prepare(
        `SELECT * FROM chunks WHERE document_id = ? AND enabled = 1
           AND role <> 'parent' AND ordinal BETWEEN ? AND ?
         ORDER BY ordinal ASC, id ASC`
      )
      .all(
        chunk.documentId,
        Math.max(0, chunk.ordinal - adjacentCount),
        chunk.ordinal + adjacentCount
      )
      .map(mapChunk)
  }

  replaceDocumentEmbeddings(
    documentId: string,
    provider: string,
    model: string,
    embeddings: readonly ChunkEmbeddingInput[]
  ): EmbeddingIndexState {
    const normalizedDocumentId = requiredString(
      documentId,
      'documentId',
      MAX_ID_LENGTH
    )
    const normalizedProvider = requiredString(
      provider,
      'provider',
      MAX_EMBEDDING_PROVIDER_LENGTH
    )
    const normalizedModel = requiredString(
      model,
      'model',
      MAX_EMBEDDING_MODEL_LENGTH
    )
    if (!Array.isArray(embeddings) || embeddings.length > MAX_CHUNKS) {
      throw new RangeError(`embeddings must contain at most ${MAX_CHUNKS} items`)
    }
    const database = this.requireDatabase()
    const document = database
      .prepare('SELECT id, knowledge_base_id FROM documents WHERE id = ?')
      .get(normalizedDocumentId)
    if (!document) {
      throw new Error(`Document not found: ${normalizedDocumentId}`)
    }
    const chunks = database
      .prepare(
        `SELECT id, index_content FROM chunks
         WHERE document_id = ? AND enabled = 1 AND role <> 'parent'
         ORDER BY ordinal ASC, id ASC`
      )
      .all(normalizedDocumentId)
    if (embeddings.length !== chunks.length) {
      throw new Error('Embeddings must cover every current document chunk')
    }
    const chunksById = new Map(
      chunks.map((row) => [
        asString(row, 'id'),
        asString(row, 'index_content')
      ])
    )
    const seen = new Set<string>()
    let dimensions: number | undefined
    const normalized = embeddings.map((embedding, index) => {
      const chunkId = requiredString(
        embedding.chunkId,
        `embeddings[${index}].chunkId`,
        MAX_ID_LENGTH
      )
      const content = chunksById.get(chunkId)
      if (content === undefined || seen.has(chunkId)) {
        throw new Error('Embeddings must reference unique chunks in the document')
      }
      seen.add(chunkId)
      const checksum = normalizedChecksum(
        embedding.contentChecksum,
        `embeddings[${index}].contentChecksum`
      )
      if (checksum !== contentChecksum(content)) {
        throw new Error('Embedding content checksum does not match the chunk')
      }
      const vector = normalizeVector(
        embedding.vector,
        `embeddings[${index}].vector`
      )
      if (dimensions === undefined) {
        dimensions = vector.dimensions
      } else if (dimensions !== vector.dimensions) {
        throw new Error('Document embeddings must have consistent dimensions')
      }
      return { chunkId, checksum, ...vector }
    })
    const indexChecksum = createHash('sha256')
      .update(
        normalized
          .map((item) => `${item.chunkId}\0${item.checksum}`)
          .sort()
          .join('\n')
      )
      .digest('hex')
    const now = new Date().toISOString()
    this.transaction(database, () => {
      database
        .prepare(
          `DELETE FROM chunk_embeddings
           WHERE provider = ? AND model = ? AND chunk_id IN
             (SELECT id FROM chunks WHERE document_id = ?)`
        )
        .run(normalizedProvider, normalizedModel, normalizedDocumentId)
      const insert = database.prepare(
        `INSERT INTO chunk_embeddings
          (chunk_id, knowledge_base_id, provider, model, dimensions,
           content_checksum, vector, magnitude, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const item of normalized) {
        insert.run(
          item.chunkId,
          asString(document, 'knowledge_base_id'),
          normalizedProvider,
          normalizedModel,
          item.dimensions,
          item.checksum,
          item.bytes,
          item.magnitude,
          now,
          now
        )
      }
      database
        .prepare(
          `INSERT INTO embedding_index_state
            (document_id, knowledge_base_id, provider, model, dimensions,
             content_checksum, status, last_error, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'ready', NULL, ?)
           ON CONFLICT(document_id, provider, model) DO UPDATE SET
             knowledge_base_id = excluded.knowledge_base_id,
             dimensions = excluded.dimensions,
             content_checksum = excluded.content_checksum,
             status = 'ready',
             last_error = NULL,
             updated_at = excluded.updated_at`
        )
        .run(
          normalizedDocumentId,
          asString(document, 'knowledge_base_id'),
          normalizedProvider,
          normalizedModel,
          dimensions ?? null,
          indexChecksum,
          now
        )
    })
    return this.requiredEmbeddingIndexState(
      normalizedDocumentId,
      normalizedProvider,
      normalizedModel
    )
  }

  beginDocumentEmbeddingReplacement(
    documentId: string,
    provider: string,
    model: string
  ): string {
    const normalizedDocumentId = requiredString(
      documentId,
      'documentId',
      MAX_ID_LENGTH
    )
    requiredString(
      provider,
      'provider',
      MAX_EMBEDDING_PROVIDER_LENGTH
    )
    requiredString(
      model,
      'model',
      MAX_EMBEDDING_MODEL_LENGTH
    )
    const database = this.requireDatabase()
    if (
      !database
        .prepare('SELECT 1 FROM documents WHERE id = ?')
        .get(normalizedDocumentId)
    ) {
      throw new Error(`Document not found: ${normalizedDocumentId}`)
    }
    return randomUUID()
  }

  beginPreparedDocumentEmbeddingReplacement(
    documentId: string,
    provider: string,
    model: string
  ): string {
    requiredString(documentId, 'documentId', MAX_ID_LENGTH)
    requiredString(provider, 'provider', MAX_EMBEDDING_PROVIDER_LENGTH)
    requiredString(model, 'model', MAX_EMBEDDING_MODEL_LENGTH)
    return randomUUID()
  }

  appendDocumentEmbeddingBatch(
    replacementId: string,
    documentId: string,
    provider: string,
    model: string,
    embeddings: readonly ChunkEmbeddingInput[]
  ): void {
    const normalizedReplacementId = requiredString(
      replacementId,
      'replacementId',
      MAX_ID_LENGTH
    )
    const normalizedDocumentId = requiredString(
      documentId,
      'documentId',
      MAX_ID_LENGTH
    )
    const normalizedProvider = requiredString(
      provider,
      'provider',
      MAX_EMBEDDING_PROVIDER_LENGTH
    )
    const normalizedModel = requiredString(
      model,
      'model',
      MAX_EMBEDDING_MODEL_LENGTH
    )
    if (
      !Array.isArray(embeddings) ||
      embeddings.length < 1 ||
      embeddings.length > MAX_EMBEDDING_BATCH
    ) {
      throw new RangeError(
        `embeddings must contain between 1 and ${MAX_EMBEDDING_BATCH} items`
      )
    }
    const database = this.requireDatabase()
    const chunkIds = embeddings.map((embedding, index) =>
      requiredString(
        embedding.chunkId,
        `embeddings[${index}].chunkId`,
        MAX_ID_LENGTH
      )
    )
    if (new Set(chunkIds).size !== chunkIds.length) {
      throw new Error('Embedding chunk IDs must be unique within a batch')
    }
    const placeholders = chunkIds.map(() => '?').join(', ')
    const chunksById = new Map(
      database
        .prepare(
          `SELECT id, index_content FROM chunks
           WHERE document_id = ? AND enabled = 1 AND role <> 'parent'
             AND id IN (${placeholders})`
        )
        .all(normalizedDocumentId, ...chunkIds)
        .map((row) => [
          asString(row, 'id'),
          asString(row, 'index_content')
        ])
    )
    if (chunksById.size !== chunkIds.length) {
      throw new Error(
        'Embeddings must reference chunks in the document'
      )
    }
    const existingDimensions = database
      .prepare(
        `SELECT dimensions FROM embedding_rebuild_staging
         WHERE replacement_id = ? LIMIT 1`
      )
      .get(normalizedReplacementId)
    let dimensions = existingDimensions
      ? asNumber(existingDimensions, 'dimensions')
      : undefined
    const normalized = embeddings.map((embedding, index) => {
      const chunkId = chunkIds[index]!
      const chunkContent = chunksById.get(chunkId)!
      const checksum = normalizedChecksum(
        embedding.contentChecksum,
        `embeddings[${index}].contentChecksum`
      )
      if (checksum !== contentChecksum(chunkContent)) {
        throw new Error(
          'Embedding content checksum does not match the chunk'
        )
      }
      const vector = normalizeVector(
        embedding.vector,
        `embeddings[${index}].vector`
      )
      if (dimensions === undefined) {
        dimensions = vector.dimensions
      } else if (dimensions !== vector.dimensions) {
        throw new Error(
          'Document embeddings must have consistent dimensions'
        )
      }
      return { chunkId, checksum, ...vector }
    })
    this.insertEmbeddingReplacementBatch(database, {
      replacementId: normalizedReplacementId,
      documentId: normalizedDocumentId,
      provider: normalizedProvider,
      model: normalizedModel,
      embeddings: normalized
    })
  }

  appendPreparedDocumentEmbeddingBatch(
    replacementId: string,
    documentId: string,
    provider: string,
    model: string,
    embeddings: readonly ChunkEmbeddingInput[]
  ): void {
    const normalizedReplacementId = requiredString(
      replacementId,
      'replacementId',
      MAX_ID_LENGTH
    )
    const normalizedDocumentId = requiredString(
      documentId,
      'documentId',
      MAX_ID_LENGTH
    )
    const normalizedProvider = requiredString(
      provider,
      'provider',
      MAX_EMBEDDING_PROVIDER_LENGTH
    )
    const normalizedModel = requiredString(
      model,
      'model',
      MAX_EMBEDDING_MODEL_LENGTH
    )
    if (
      !Array.isArray(embeddings) ||
      embeddings.length < 1 ||
      embeddings.length > MAX_EMBEDDING_BATCH
    ) {
      throw new RangeError(
        `embeddings must contain between 1 and ${MAX_EMBEDDING_BATCH} items`
      )
    }
    const database = this.requireDatabase()
    const existingDimensions = database
      .prepare(
        `SELECT dimensions FROM embedding_rebuild_staging
         WHERE replacement_id = ? LIMIT 1`
      )
      .get(normalizedReplacementId)
    let dimensions = existingDimensions
      ? asNumber(existingDimensions, 'dimensions')
      : undefined
    const seen = new Set<string>()
    const normalized = embeddings.map((embedding, index) => {
      const chunkId = requiredString(
        embedding.chunkId,
        `embeddings[${index}].chunkId`,
        MAX_ID_LENGTH
      )
      if (seen.has(chunkId)) {
        throw new Error('Embedding chunk IDs must be unique within a batch')
      }
      seen.add(chunkId)
      const checksum = normalizedChecksum(
        embedding.contentChecksum,
        `embeddings[${index}].contentChecksum`
      )
      const vector = normalizeVector(
        embedding.vector,
        `embeddings[${index}].vector`
      )
      if (dimensions === undefined) {
        dimensions = vector.dimensions
      } else if (dimensions !== vector.dimensions) {
        throw new Error(
          'Document embeddings must have consistent dimensions'
        )
      }
      return { chunkId, checksum, ...vector }
    })
    this.insertEmbeddingReplacementBatch(database, {
      replacementId: normalizedReplacementId,
      documentId: normalizedDocumentId,
      provider: normalizedProvider,
      model: normalizedModel,
      embeddings: normalized
    })
  }

  finishDocumentEmbeddingReplacement(
    replacementId: string,
    documentId: string,
    provider: string,
    model: string
  ): EmbeddingIndexState {
    const normalizedReplacementId = requiredString(
      replacementId,
      'replacementId',
      MAX_ID_LENGTH
    )
    const normalizedDocumentId = requiredString(
      documentId,
      'documentId',
      MAX_ID_LENGTH
    )
    const normalizedProvider = requiredString(
      provider,
      'provider',
      MAX_EMBEDDING_PROVIDER_LENGTH
    )
    const normalizedModel = requiredString(
      model,
      'model',
      MAX_EMBEDDING_MODEL_LENGTH
    )
    const database = this.requireDatabase()
    const document = database
      .prepare('SELECT knowledge_base_id FROM documents WHERE id = ?')
      .get(normalizedDocumentId)
    if (!document) {
      throw new Error(`Document not found: ${normalizedDocumentId}`)
    }
    const counts = database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM chunks WHERE document_id = ?
              AND enabled = 1 AND role <> 'parent') AS chunks,
           (SELECT COUNT(*) FROM embedding_rebuild_staging
             WHERE replacement_id = ? AND document_id = ?
               AND provider = ? AND model = ?) AS embeddings`
      )
      .get(
        normalizedDocumentId,
        normalizedReplacementId,
        normalizedDocumentId,
        normalizedProvider,
        normalizedModel
      )
    if (
      !counts ||
      asNumber(counts, 'chunks') !== asNumber(counts, 'embeddings')
    ) {
      throw new Error('Embeddings must cover every current document chunk')
    }
    const stagedRows = database
      .prepare(
        `SELECT
           staged.content_checksum AS staged_checksum,
           current.index_content AS current_content
         FROM embedding_rebuild_staging staged
         LEFT JOIN chunks current
           ON current.id = staged.chunk_id
          AND current.document_id = staged.document_id
          AND current.enabled = 1
          AND current.role <> 'parent'
         WHERE staged.replacement_id = ?
           AND staged.document_id = ?
           AND staged.provider = ?
           AND staged.model = ?`
      )
      .all(
        normalizedReplacementId,
        normalizedDocumentId,
        normalizedProvider,
        normalizedModel
      )
    if (
      stagedRows.some((row) => {
        const currentContent = asOptionalString(row, 'current_content')
        return (
          currentContent === undefined ||
          asString(row, 'staged_checksum') !==
            contentChecksum(currentContent)
        )
      })
    ) {
      throw new Error('Embedding content changed during replacement')
    }
    const indexHash = createHash('sha256')
    let dimensions: number | undefined
    let firstChecksum = true
    for (const row of database
      .prepare(
        `SELECT chunk_id, content_checksum, dimensions
         FROM embedding_rebuild_staging
         WHERE replacement_id = ? ORDER BY chunk_id`
      )
      .iterate(normalizedReplacementId)) {
      const chunkId = asString(row, 'chunk_id')
      const checksum = asString(row, 'content_checksum')
      if (!firstChecksum) {
        indexHash.update('\n')
      }
      indexHash.update(`${chunkId}\0${checksum}`)
      firstChecksum = false
      const rowDimensions = asNumber(row, 'dimensions')
      if (dimensions === undefined) {
        dimensions = rowDimensions
      } else if (dimensions !== rowDimensions) {
        throw new Error(
          'Document embeddings must have consistent dimensions'
        )
      }
    }
    const now = new Date().toISOString()
    this.transaction(database, () => {
      database
        .prepare(
          `DELETE FROM chunk_embeddings
           WHERE provider = ? AND model = ? AND chunk_id IN
             (SELECT id FROM chunks WHERE document_id = ?)`
        )
        .run(normalizedProvider, normalizedModel, normalizedDocumentId)
      database
        .prepare(
          `INSERT INTO chunk_embeddings
            (chunk_id, knowledge_base_id, provider, model, dimensions,
             content_checksum, vector, magnitude, created_at, updated_at)
           SELECT chunk_id, ?, provider, model, dimensions,
             content_checksum, vector, magnitude, ?, ?
           FROM embedding_rebuild_staging
           WHERE replacement_id = ?`
        )
        .run(
          asString(document, 'knowledge_base_id'),
          now,
          now,
          normalizedReplacementId
        )
      database
        .prepare(
          `INSERT INTO embedding_index_state
            (document_id, knowledge_base_id, provider, model, dimensions,
             content_checksum, status, last_error, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'ready', NULL, ?)
           ON CONFLICT(document_id, provider, model) DO UPDATE SET
             knowledge_base_id = excluded.knowledge_base_id,
             dimensions = excluded.dimensions,
             content_checksum = excluded.content_checksum,
             status = 'ready',
             last_error = NULL,
             updated_at = excluded.updated_at`
        )
        .run(
          normalizedDocumentId,
          asString(document, 'knowledge_base_id'),
          normalizedProvider,
          normalizedModel,
          dimensions ?? null,
          indexHash.digest('hex'),
          now
        )
      database
        .prepare(
          `DELETE FROM embedding_rebuild_staging
           WHERE replacement_id = ?`
        )
        .run(normalizedReplacementId)
    })
    return this.requiredEmbeddingIndexState(
      normalizedDocumentId,
      normalizedProvider,
      normalizedModel
    )
  }

  discardDocumentEmbeddingReplacement(replacementId: string): void {
    this.requireDatabase()
      .prepare(
        `DELETE FROM embedding_rebuild_staging
         WHERE replacement_id = ?`
      )
      .run(
        requiredString(
          replacementId,
          'replacementId',
          MAX_ID_LENGTH
        )
      )
  }

  recordEmbeddingIndexError(
    documentId: string,
    provider: string,
    model: string,
    error: string
  ): EmbeddingIndexState {
    const normalizedDocumentId = requiredString(
      documentId,
      'documentId',
      MAX_ID_LENGTH
    )
    const normalizedProvider = requiredString(
      provider,
      'provider',
      MAX_EMBEDDING_PROVIDER_LENGTH
    )
    const normalizedModel = requiredString(
      model,
      'model',
      MAX_EMBEDDING_MODEL_LENGTH
    )
    const normalizedError = requiredString(
      error,
      'error',
      MAX_EMBEDDING_ERROR_LENGTH,
      false
    )
    const database = this.requireDatabase()
    const document = database
      .prepare('SELECT knowledge_base_id FROM documents WHERE id = ?')
      .get(normalizedDocumentId)
    if (!document) {
      throw new Error(`Document not found: ${normalizedDocumentId}`)
    }
    database
      .prepare(
        `INSERT INTO embedding_index_state
          (document_id, knowledge_base_id, provider, model, dimensions,
           content_checksum, status, last_error, updated_at)
         VALUES (?, ?, ?, ?, NULL, '', 'error', ?, ?)
         ON CONFLICT(document_id, provider, model) DO UPDATE SET
           status = CASE
             WHEN embedding_index_state.status = 'ready' THEN 'ready'
             ELSE 'error' END,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`
      )
      .run(
        normalizedDocumentId,
        asString(document, 'knowledge_base_id'),
        normalizedProvider,
        normalizedModel,
        normalizedError,
        new Date().toISOString()
      )
    return this.requiredEmbeddingIndexState(
      normalizedDocumentId,
      normalizedProvider,
      normalizedModel
    )
  }

  getEmbeddingIndexState(
    documentId: string,
    provider: string,
    model: string
  ): EmbeddingIndexState | undefined {
    const row = this.requireDatabase()
      .prepare(
        `SELECT * FROM embedding_index_state
         WHERE document_id = ? AND provider = ? AND model = ?`
      )
      .get(
        requiredString(documentId, 'documentId', MAX_ID_LENGTH),
        requiredString(
          provider,
          'provider',
          MAX_EMBEDDING_PROVIDER_LENGTH
        ),
        requiredString(model, 'model', MAX_EMBEDDING_MODEL_LENGTH)
      )
    return row ? mapEmbeddingIndexState(row) : undefined
  }

  getLastEmbeddingIndexJob(
    knowledgeBaseId: string
  ): EmbeddingIndexJob | null {
    const row = this.requireDatabase()
      .prepare(
        `SELECT status_json FROM embedding_index_job
         WHERE knowledge_base_id = ?`
      )
      .get(
        requiredString(
          knowledgeBaseId,
          'knowledgeBaseId',
          MAX_ID_LENGTH
        )
      )
    if (!row) {
      return null
    }
    try {
      return embeddingIndexJobSchema.parse(
        JSON.parse(asString(row, 'status_json'))
      )
    } catch {
      return null
    }
  }

  saveEmbeddingIndexJob(
    knowledgeBaseId: string,
    job: EmbeddingIndexJob | null
  ): void {
    const database = this.requireDatabase()
    const normalizedKnowledgeBaseId = requiredString(
      knowledgeBaseId,
      'knowledgeBaseId',
      MAX_ID_LENGTH
    )
    if (!job) {
      database
        .prepare(
          'DELETE FROM embedding_index_job WHERE knowledge_base_id = ?'
        )
        .run(normalizedKnowledgeBaseId)
      return
    }
    const normalized = embeddingIndexJobSchema.parse(job)
    database
      .prepare(
        `INSERT INTO embedding_index_job
          (knowledge_base_id, status_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(knowledge_base_id) DO UPDATE SET
           status_json = excluded.status_json,
           updated_at = excluded.updated_at`
      )
      .run(
        normalizedKnowledgeBaseId,
        JSON.stringify(normalized),
        new Date().toISOString()
      )
  }

  listEmbeddingIndexDocumentIds(
    knowledgeBaseId: string
  ): string[] {
    return this.requireDatabase()
      .prepare(
        `SELECT d.id
         FROM documents d
         WHERE d.knowledge_base_id = ?
           AND (json_extract(d.metadata, '$.status') IS NULL
             OR json_extract(d.metadata, '$.status') = 'ready')
         ORDER BY d.id`
      )
      .all(
        requiredString(
          knowledgeBaseId,
          'knowledgeBaseId',
          MAX_ID_LENGTH
        )
      )
      .map((document) => asString(document, 'id'))
  }

  countEmbeddingIndexDocuments(knowledgeBaseId: string): number {
    const row = this.requireDatabase()
      .prepare(
        `SELECT COUNT(*) AS count
         FROM documents d
         WHERE d.knowledge_base_id = ?
           AND (json_extract(d.metadata, '$.status') IS NULL
             OR json_extract(d.metadata, '$.status') = 'ready')`
      )
      .get(
        requiredString(
          knowledgeBaseId,
          'knowledgeBaseId',
          MAX_ID_LENGTH
        )
      )
    return row ? asNumber(row, 'count') : 0
  }

  getEmbeddingIndexCoverage(
    knowledgeBaseId: string,
    provider: string,
    model: string
  ): EmbeddingIndexCoverage {
    const row = this.requireDatabase()
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(
             CASE WHEN eis.status = 'ready' THEN 1 ELSE 0 END
           ), 0) AS indexed,
           COALESCE(SUM(
             CASE WHEN eis.status = 'error' THEN 1 ELSE 0 END
           ), 0) AS error
         FROM documents d
         LEFT JOIN embedding_index_state eis
           ON eis.document_id = d.id
          AND eis.provider = ?
          AND eis.model = ?
         WHERE d.knowledge_base_id = ?
           AND (json_extract(d.metadata, '$.status') IS NULL
             OR json_extract(d.metadata, '$.status') = 'ready')`
      )
      .get(
        requiredString(
          provider,
          'provider',
          MAX_EMBEDDING_PROVIDER_LENGTH
        ),
        requiredString(model, 'model', MAX_EMBEDDING_MODEL_LENGTH),
        requiredString(
          knowledgeBaseId,
          'knowledgeBaseId',
          MAX_ID_LENGTH
        )
      )
    const total = row ? asNumber(row, 'total') : 0
    const indexed = row ? asNumber(row, 'indexed') : 0
    const error = row ? asNumber(row, 'error') : 0
    return {
      total,
      indexed,
      error,
      missing: total - indexed - error
    }
  }

  getEmbeddingIndexDocument(
    documentId: string
  ): EmbeddingIndexDocument | undefined {
    const database = this.requireDatabase()
    const normalizedDocumentId = requiredString(
      documentId,
      'documentId',
      MAX_ID_LENGTH
    )
    const document = database
      .prepare(
        `SELECT d.id
         FROM documents d
         WHERE d.id = ?
           AND (json_extract(d.metadata, '$.status') IS NULL
             OR json_extract(d.metadata, '$.status') = 'ready')`
      )
      .get(normalizedDocumentId)
    if (!document) {
      return undefined
    }
    const chunks = database.prepare(
      `SELECT id, content, metadata, index_content FROM chunks
       WHERE document_id = ? AND enabled = 1 AND role <> 'parent'
       ORDER BY ordinal ASC, id ASC`
    )
    return {
      id: normalizedDocumentId,
      items: chunks.all(normalizedDocumentId).map((row) => {
        const content =
          row.index_content === undefined
            ? chunkIndexContent(
                asString(row, 'content'),
                parseObject(asString(row, 'metadata'))
              )
            : asString(row, 'index_content')
        return {
          id: asString(row, 'id'),
          content,
          contentChecksum: contentChecksum(content)
        }
      })
    }
  }

  vectorSearch(options: VectorSearchOptions): SearchResult[] {
    return this.vectorSearchScored(options).map((item) => item.result)
  }

  graphSearch(
    knowledgeBaseId: string,
    query: string,
    limit = 20,
    maximumDepth = 1
  ): HybridSearchResult[] {
    boundedInteger(limit, 'limit', 1, 100)
    boundedInteger(maximumDepth, 'maximumDepth', 0, MAX_GRAPH_DEPTH)
    return this.graphSearchScored(
      requiredString(knowledgeBaseId, 'knowledgeBaseId', MAX_ID_LENGTH),
      requiredString(query, 'query', 512),
      limit,
      maximumDepth
    ).map((item, index) => ({
      ...item.result,
      retrieval: {
        score: 1 / (RRF_CONSTANT + index + 1),
        channels: ['graph'],
        graphRank: index + 1,
        evidenceIds: item.evidenceIds ?? []
      }
    }))
  }

  hybridSearch(options: HybridSearchOptions): HybridSearchResult[] {
    return this.hybridSearchWithDiagnostics(options).results
  }

  hybridSearchWithDiagnostics(
    options: HybridSearchOptions
  ): HybridSearchResultPage {
    const knowledgeBaseId = requiredString(
      options.knowledgeBaseId,
      'knowledgeBaseId',
      MAX_ID_LENGTH
    )
    const query = requiredString(options.query, 'query', 4_000)
    const limit = options.limit ?? 20
    boundedInteger(limit, 'limit', 1, 100)
    const candidateMultiplier = boundedInteger(
      options.candidateMultiplier ?? 4,
      'candidateMultiplier',
      1,
      10
    )
    const candidateLimit = Math.min(100, limit * candidateMultiplier)
    const ftsWeight = this.validateWeight(options.ftsWeight ?? 1, 'ftsWeight')
    const vectorWeight = this.validateWeight(
      options.vectorWeight ?? 1,
      'vectorWeight'
    )
    const graphWeight = this.validateWeight(
      options.graphWeight ?? 0.8,
      'graphWeight'
    )
    const lexical =
      ftsWeight === 0
        ? []
        : this.search({ knowledgeBaseId, query, limit: candidateLimit })
    const vectorPage =
      vectorWeight > 0 && options.vector && options.provider && options.model
        ? this.vectorSearchScoredWithCount({
            knowledgeBaseId,
            provider: options.provider,
            model: options.model,
            vector: options.vector,
            limit: options.vectorLimit ?? candidateLimit,
            minimumSimilarity: options.minimumVectorSimilarity,
            signal: options.signal
          })
        : { results: [], scannedCount: 0 }
    const vector = vectorPage.results
    const graph = options.graphEnabled === false || graphWeight === 0
      ? []
      : this.graphSearchScored(
          knowledgeBaseId,
          query,
          candidateLimit,
          boundedInteger(
            options.graphDepth ?? 1,
            'graphDepth',
            0,
            MAX_GRAPH_DEPTH
          )
        )
    const fused = new Map<
      string,
      {
        result: SearchResult
        score: number
        channels: Set<'fts' | 'vector' | 'graph'>
        lexicalRank?: number
        vectorRank?: number
        graphRank?: number
        similarity?: number
        evidenceIds: Set<string>
      }
    >()
    const add = (
      channel: 'fts' | 'vector' | 'graph',
      candidates: readonly ScoredSearchResult[],
      weight: number
    ): void => {
      candidates.forEach((candidate, index) => {
        const current = fused.get(candidate.result.chunk.id) ?? {
          result: candidate.result,
          score: 0,
          channels: new Set<'fts' | 'vector' | 'graph'>(),
          evidenceIds: new Set<string>()
        }
        current.score += weight / (RRF_CONSTANT + index + 1)
        current.channels.add(channel)
        if (channel === 'fts') {
          current.lexicalRank = index + 1
        } else if (channel === 'vector') {
          current.vectorRank = index + 1
          current.similarity = candidate.similarity
        } else {
          current.graphRank = index + 1
          for (const evidenceId of candidate.evidenceIds ?? []) {
            current.evidenceIds.add(evidenceId)
          }
        }
        fused.set(candidate.result.chunk.id, current)
      })
    }
    add(
      'fts',
      lexical.map((result) => ({ result })),
      ftsWeight
    )
    add('vector', vector, vectorWeight)
    add('graph', graph, graphWeight)
    return {
      results: [...fused.values()]
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.result.chunk.id.localeCompare(right.result.chunk.id)
        )
        .slice(0, limit)
        .map((item) => ({
          ...item.result,
          rank: -item.score,
          retrieval: {
            score: item.score,
            channels: [...item.channels],
            lexicalRank: item.lexicalRank,
            vectorRank: item.vectorRank,
            graphRank: item.graphRank,
            similarity: item.similarity,
            evidenceIds: [...item.evidenceIds]
          }
        })),
      vectorScannedCount: vectorPage.scannedCount
    }
  }

  search(options: SearchOptions): SearchResult[] {
    const knowledgeBaseId = requiredString(
      options.knowledgeBaseId,
      'knowledgeBaseId',
      MAX_ID_LENGTH
    )
    const query = requiredString(options.query, 'query', 4_000)
    const limit = options.limit ?? 20
    boundedInteger(limit, 'limit', 1, 100)
    const literalQuery = query
      .split(/\s+/u)
      .filter(Boolean)
      .map((term) => `"${term.replaceAll('"', '""')}"`)
      .join(' OR ')
    let rows = this.requireDatabase()
      .prepare(
        `SELECT
           c.*,
           substr(c.content, 1, 600) AS snippet,
           bm25(chunks_fts) AS rank,
           d.id AS d_id, d.knowledge_base_id AS d_knowledge_base_id,
           d.source_id AS d_source_id, d.external_id AS d_external_id,
           d.title AS d_title, d.mime_type AS d_mime_type,
           d.source_location AS d_source_location, d.checksum AS d_checksum,
           d.metadata AS d_metadata, d.created_at AS d_created_at,
           d.updated_at AS d_updated_at,
           s.id AS s_id, s.knowledge_base_id AS s_knowledge_base_id,
           s.type AS s_type, s.location AS s_location,
           s.display_name AS s_display_name, s.status AS s_status,
           s.last_error AS s_last_error, s.metadata AS s_metadata,
           s.created_at AS s_created_at, s.updated_at AS s_updated_at
         FROM chunks_fts
         JOIN chunks c ON c.rowid = chunks_fts.rowid
         JOIN documents d ON d.id = c.document_id
         JOIN knowledge_sources s ON s.id = d.source_id
         WHERE chunks_fts MATCH ? AND c.knowledge_base_id = ?
           AND c.enabled = 1 AND c.role <> 'parent'
         ORDER BY rank ASC LIMIT ?`
      )
      .all(literalQuery, knowledgeBaseId, limit) as Row[]

    if (containsHanText(query)) {
      const terms = knowledgeRetrievalTerms(query, 64)
      const cjkQuery = terms
        .map((term) => `"${term.replaceAll('"', '""')}"`)
        .join(' OR ')
      const cjkRows = cjkQuery
        ? this.requireDatabase()
        .prepare(
          `SELECT
             c.*, substr(c.content, 1, 600) AS snippet,
             bm25(chunks_cjk) AS rank,
             d.id AS d_id, d.knowledge_base_id AS d_knowledge_base_id,
             d.source_id AS d_source_id, d.external_id AS d_external_id,
             d.title AS d_title, d.mime_type AS d_mime_type,
             d.source_location AS d_source_location,
             d.checksum AS d_checksum, d.metadata AS d_metadata,
             d.created_at AS d_created_at, d.updated_at AS d_updated_at,
             s.id AS s_id, s.knowledge_base_id AS s_knowledge_base_id,
             s.type AS s_type, s.location AS s_location,
             s.display_name AS s_display_name, s.status AS s_status,
             s.last_error AS s_last_error, s.metadata AS s_metadata,
             s.created_at AS s_created_at, s.updated_at AS s_updated_at
           FROM chunks_cjk
           JOIN chunks c ON c.rowid = chunks_cjk.rowid
           JOIN documents d ON d.id = c.document_id
           JOIN knowledge_sources s ON s.id = d.source_id
           WHERE chunks_cjk MATCH ? AND c.knowledge_base_id = ?
             AND c.enabled = 1 AND c.role <> 'parent'
           ORDER BY rank ASC, c.id ASC LIMIT ?`
        )
        .all(cjkQuery, knowledgeBaseId, limit)
        : []
      const byChunkId = new Map<string, Row>()
      for (const row of [...rows, ...cjkRows]) {
        const id = asString(row, 'id')
        const current = byChunkId.get(id)
        if (!current || asNumber(row, 'rank') < asNumber(current, 'rank')) {
          byChunkId.set(id, row)
        }
      }
      rows = [...byChunkId.values()]
        .sort(
          (left, right) =>
            asNumber(left, 'rank') - asNumber(right, 'rank') ||
            asString(left, 'id').localeCompare(asString(right, 'id'))
        )
        .slice(0, limit)
    }

    return rows.map((row) => ({
      chunk: mapChunk(row),
      document: mapDocument(this.prefixedRow(row, 'd_')),
      source: mapSource(this.prefixedRow(row, 's_')),
      snippet: asString(row, 'snippet'),
      rank: asNumber(row, 'rank')
    }))
  }

  createEntity(input: CreateGraphEntityInput): GraphEntity {
    const database = this.requireDatabase()
    const id = optionalString(input.id, 'id', MAX_ID_LENGTH) ?? randomUUID()
    const knowledgeBaseId = requiredString(
      input.knowledgeBaseId,
      'knowledgeBaseId',
      MAX_ID_LENGTH
    )
    const name = requiredString(input.name, 'name', MAX_NAME_LENGTH)
    const ontology = this.requiredKnowledgeBase(knowledgeBaseId).ontologySettings
    const requestedType = requiredString(input.type, 'type', MAX_NAME_LENGTH)
    const type = normalizeEntityTypeAlias(requestedType, ontology)
    if (
      input.locked &&
      type === 'CONCEPT' &&
      !ontology.entityTypes.some(
        (definition) =>
          [definition.id, ...definition.aliases].some(
            (value) => normalizeOntologyAlias(value) ===
              normalizeOntologyAlias(requestedType)
          )
      )
    ) {
      throw new Error('Entity type is not defined by the library ontology')
    }
    const aliases = JSON.stringify(stringArray(input.aliases, 'aliases'))
    const description = optionalString(
      input.description,
      'description',
      MAX_CONTENT_LENGTH
    )
    const properties = jsonObject(input.properties, 'properties')
    const now = new Date().toISOString()
    database
      .prepare(
        `INSERT INTO graph_entities
          (id, knowledge_base_id, name, type, aliases, description, properties,
           locked, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        knowledgeBaseId,
        name,
        type,
        aliases,
        description ?? null,
        properties,
        input.locked ? 1 : 0,
        now,
        now
      )
    return this.requiredEntity(id)
  }

  getEntity(id: string): GraphEntity | undefined {
    const normalizedId = requiredString(id, 'id', MAX_ID_LENGTH)
    const row = this.requireDatabase()
      .prepare('SELECT * FROM graph_entities WHERE id = ?')
      .get(normalizedId)
    return row ? mapEntity(row) : undefined
  }

  listEntities(
    knowledgeBaseId: string,
    limit = MAX_LIST_LIMIT
  ): GraphEntity[] {
    const normalizedId = requiredString(
      knowledgeBaseId,
      'knowledgeBaseId',
      MAX_ID_LENGTH
    )
    boundedInteger(limit, 'limit', 1, MAX_LIST_LIMIT)
    return this.requireDatabase()
      .prepare(
        `SELECT * FROM graph_entities WHERE knowledge_base_id = ?
         ORDER BY name COLLATE NOCASE ASC, id ASC LIMIT ?`
      )
      .all(normalizedId, limit)
      .map(mapEntity)
  }

  findEntityByCanonicalName(
    knowledgeBaseId: string,
    type: string,
    name: string
  ): GraphEntity | undefined {
    requiredString(knowledgeBaseId, 'knowledgeBaseId', MAX_ID_LENGTH)
    const normalizedType = requiredString(type, 'type', MAX_NAME_LENGTH)
    const normalizedName = normalizeEntityAlias(name)
    if (!normalizedName) {
      return undefined
    }
    return this.listEntitiesForIdentity(knowledgeBaseId)
      .find(
        (candidate) =>
          candidate.type === normalizedType &&
          (
            normalizeEntityAlias(candidate.name) === normalizedName ||
            candidate.aliases.some(
              (alias) => normalizeEntityAlias(alias) === normalizedName
            )
          )
      )
  }

  listEntitiesForIdentity(knowledgeBaseId: string): GraphEntity[] {
    const normalizedId = requiredString(
      knowledgeBaseId,
      'knowledgeBaseId',
      MAX_ID_LENGTH
    )
    return this.requireDatabase()
      .prepare(
        `SELECT * FROM graph_entities WHERE knowledge_base_id = ?
         ORDER BY name COLLATE NOCASE ASC, id ASC`
      )
      .all(normalizedId)
      .map(mapEntity)
  }

  updateEntity(id: string, input: UpdateGraphEntityInput): GraphEntity {
    const current = this.requiredEntity(id)
    const ontology =
      this.requiredKnowledgeBase(current.knowledgeBaseId).ontologySettings
    const requestedType =
      input.type === undefined
        ? undefined
        : requiredString(input.type, 'type', MAX_NAME_LENGTH)
    const nextType =
      requestedType === undefined
        ? current.type
        : normalizeEntityTypeAlias(requestedType, ontology)
    if (
      input.locked === true &&
      requestedType !== undefined &&
      nextType === 'CONCEPT' &&
      !ontology.entityTypes.some((definition) =>
        [definition.id, ...definition.aliases].some(
          (value) =>
            normalizeOntologyAlias(value) ===
            normalizeOntologyAlias(requestedType)
        )
      )
    ) {
      throw new Error('Entity type is not defined by the library ontology')
    }
    this.requireDatabase()
      .prepare(
        `UPDATE graph_entities
         SET name = ?, type = ?, aliases = ?, description = ?, properties = ?,
             locked = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.name === undefined
          ? current.name
          : requiredString(input.name, 'name', MAX_NAME_LENGTH),
        nextType,
        JSON.stringify(
          input.aliases === undefined
            ? current.aliases
            : stringArray(input.aliases, 'aliases')
        ),
        input.description === undefined
          ? (current.description ?? null)
          : (optionalString(
              input.description,
              'description',
              MAX_CONTENT_LENGTH
            ) ?? null),
        input.properties === undefined
          ? JSON.stringify(current.properties)
          : jsonObject(input.properties, 'properties'),
        (input.locked ?? current.locked) ? 1 : 0,
        new Date().toISOString(),
        current.id
      )
    return this.requiredEntity(current.id)
  }

  deleteEntity(id: string): boolean {
    const normalizedId = requiredString(id, 'id', MAX_ID_LENGTH)
    return (
      this.requireDatabase()
        .prepare('DELETE FROM graph_entities WHERE id = ?')
        .run(normalizedId).changes > 0
    )
  }

  createRelation(input: CreateGraphRelationInput): GraphRelation {
    const database = this.requireDatabase()
    const id = optionalString(input.id, 'id', MAX_ID_LENGTH) ?? randomUUID()
    const knowledgeBaseId = requiredString(
      input.knowledgeBaseId,
      'knowledgeBaseId',
      MAX_ID_LENGTH
    )
    const sourceEntityId = requiredString(
      input.sourceEntityId,
      'sourceEntityId',
      MAX_ID_LENGTH
    )
    const targetEntityId = requiredString(
      input.targetEntityId,
      'targetEntityId',
      MAX_ID_LENGTH
    )
    const ontology = this.requiredKnowledgeBase(knowledgeBaseId).ontologySettings
    const type = normalizeRelationTypeAlias(
      requiredString(input.type, 'type', MAX_NAME_LENGTH),
      ontology
    )
    if (!type) {
      throw new Error('Relation type is not defined by the library ontology')
    }
    const label = optionalString(input.label, 'label', MAX_NAME_LENGTH)
    const properties = jsonObject(input.properties, 'properties')
    const now = new Date().toISOString()
    this.assertRelationEntities(
      database,
      knowledgeBaseId,
      sourceEntityId,
      targetEntityId
    )
    this.assertOntologyRelation(
      database,
      knowledgeBaseId,
      sourceEntityId,
      targetEntityId,
      type
    )
    database
      .prepare(
        `INSERT INTO graph_relations
          (id, knowledge_base_id, source_entity_id, target_entity_id, type,
           label, properties, locked, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        knowledgeBaseId,
        sourceEntityId,
        targetEntityId,
        type,
        label ?? null,
        properties,
        input.locked ? 1 : 0,
        now,
        now
      )
    return this.requiredRelation(id)
  }

  getRelation(id: string): GraphRelation | undefined {
    const normalizedId = requiredString(id, 'id', MAX_ID_LENGTH)
    const row = this.requireDatabase()
      .prepare('SELECT * FROM graph_relations WHERE id = ?')
      .get(normalizedId)
    return row ? mapRelation(row) : undefined
  }

  listRelations(
    knowledgeBaseId: string,
    limit = MAX_LIST_LIMIT
  ): GraphRelation[] {
    const normalizedId = requiredString(
      knowledgeBaseId,
      'knowledgeBaseId',
      MAX_ID_LENGTH
    )
    boundedInteger(limit, 'limit', 1, MAX_LIST_LIMIT)
    return this.requireDatabase()
      .prepare(
        `SELECT * FROM graph_relations WHERE knowledge_base_id = ?
         ORDER BY created_at ASC, id ASC LIMIT ?`
      )
      .all(normalizedId, limit)
      .map(mapRelation)
  }

  findRelationByIdentity(
    knowledgeBaseId: string,
    sourceEntityId: string,
    targetEntityId: string,
    type: string
  ): GraphRelation | undefined {
    const row = this.requireDatabase()
      .prepare(
        `SELECT * FROM graph_relations
         WHERE knowledge_base_id = ? AND source_entity_id = ?
           AND target_entity_id = ? AND type = ?
         ORDER BY created_at ASC, id ASC LIMIT 1`
      )
      .get(
        requiredString(
          knowledgeBaseId,
          'knowledgeBaseId',
          MAX_ID_LENGTH
        ),
        requiredString(sourceEntityId, 'sourceEntityId', MAX_ID_LENGTH),
        requiredString(targetEntityId, 'targetEntityId', MAX_ID_LENGTH),
        requiredString(type, 'type', MAX_NAME_LENGTH)
      )
    return row ? mapRelation(row) : undefined
  }

  updateRelation(
    id: string,
    input: UpdateGraphRelationInput
  ): GraphRelation {
    const current = this.requiredRelation(id)
    const sourceEntityId =
      input.sourceEntityId === undefined
        ? current.sourceEntityId
        : requiredString(
            input.sourceEntityId,
            'sourceEntityId',
            MAX_ID_LENGTH
          )
    const targetEntityId =
      input.targetEntityId === undefined
        ? current.targetEntityId
        : requiredString(
            input.targetEntityId,
            'targetEntityId',
            MAX_ID_LENGTH
          )
    const database = this.requireDatabase()
    this.assertRelationEntities(
      database,
      current.knowledgeBaseId,
      sourceEntityId,
      targetEntityId
    )
    const ontology =
      this.requiredKnowledgeBase(current.knowledgeBaseId).ontologySettings
    const type =
      input.type === undefined
        ? current.type
        : normalizeRelationTypeAlias(
            requiredString(input.type, 'type', MAX_NAME_LENGTH),
            ontology
          )
    if (!type) {
      throw new Error('Relation type is not defined by the library ontology')
    }
    this.assertOntologyRelation(
      database,
      current.knowledgeBaseId,
      sourceEntityId,
      targetEntityId,
      type
    )
    database
      .prepare(
        `UPDATE graph_relations
         SET source_entity_id = ?, target_entity_id = ?, type = ?, label = ?,
             properties = ?, locked = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        sourceEntityId,
        targetEntityId,
        type,
        input.label === undefined
          ? (current.label ?? null)
          : (optionalString(input.label, 'label', MAX_NAME_LENGTH) ?? null),
        input.properties === undefined
          ? JSON.stringify(current.properties)
          : jsonObject(input.properties, 'properties'),
        (input.locked ?? current.locked) ? 1 : 0,
        new Date().toISOString(),
        current.id
      )
    return this.requiredRelation(current.id)
  }

  deleteRelation(id: string): boolean {
    const normalizedId = requiredString(id, 'id', MAX_ID_LENGTH)
    return (
      this.requireDatabase()
        .prepare('DELETE FROM graph_relations WHERE id = ?')
        .run(normalizedId).changes > 0
    )
  }

  createEvidence(input: CreateEvidenceInput): Evidence {
    const database = this.requireDatabase()
    const id = optionalString(input.id, 'id', MAX_ID_LENGTH) ?? randomUUID()
    const knowledgeBaseId = requiredString(
      input.knowledgeBaseId,
      'knowledgeBaseId',
      MAX_ID_LENGTH
    )
    const entityId = optionalString(
      input.entityId,
      'entityId',
      MAX_ID_LENGTH
    )
    const relationId = optionalString(
      input.relationId,
      'relationId',
      MAX_ID_LENGTH
    )
    const documentId = requiredString(
      input.documentId,
      'documentId',
      MAX_ID_LENGTH
    )
    const chunkId = optionalString(input.chunkId, 'chunkId', MAX_ID_LENGTH)
    const quote = optionalString(
      input.quote,
      'quote',
      32_768,
      false
    )
    const location = optionalString(
      input.location,
      'location',
      MAX_LOCATION_LENGTH,
      false
    )
    const start =
      input.start === undefined
        ? undefined
        : boundedInteger(input.start, 'start', 0, MAX_CONTENT_LENGTH)
    const end =
      input.end === undefined
        ? undefined
        : boundedInteger(input.end, 'end', 0, MAX_CONTENT_LENGTH)
    if (
      (start === undefined) !== (end === undefined) ||
      (start !== undefined && end !== undefined && start >= end)
    ) {
      throw new RangeError('Evidence offsets must form a non-empty range')
    }
    const confidence = input.confidence
    if (
      confidence !== undefined &&
      (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    ) {
      throw new RangeError('Evidence confidence must be between 0 and 1')
    }
    const source = enumValue(
      input.source ?? 'manual',
      'source',
      ['rules', 'model', 'manual', 'legacy'] as const
    )
    const provenance = jsonObject(input.provenance, 'provenance')
    this.assertEvidenceTargets(database, {
      knowledgeBaseId,
      entityId,
      relationId,
      documentId,
      chunkId
    })
    database
      .prepare(
        `INSERT INTO graph_evidence
          (id, knowledge_base_id, entity_id, relation_id, document_id, chunk_id,
           quote, location, created_at, start_offset, end_offset, confidence,
           source, provenance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        knowledgeBaseId,
        entityId ?? null,
        relationId ?? null,
        documentId,
        chunkId ?? null,
        quote ?? null,
        location ?? null,
        new Date().toISOString(),
        start ?? null,
        end ?? null,
        confidence ?? null,
        source,
        provenance
      )
    return this.requiredEvidence(id)
  }

  listEvidence(
    knowledgeBaseId: string,
    limit = MAX_LIST_LIMIT
  ): Evidence[] {
    const normalizedId = requiredString(
      knowledgeBaseId,
      'knowledgeBaseId',
      MAX_ID_LENGTH
    )
    boundedInteger(limit, 'limit', 1, MAX_LIST_LIMIT)
    return this.requireDatabase()
      .prepare(
        `SELECT * FROM graph_evidence WHERE knowledge_base_id = ?
         ORDER BY created_at ASC, id ASC LIMIT ?`
      )
      .all(normalizedId, limit)
      .map(mapEvidence)
  }

  listGraphSnapshot(knowledgeBaseId: string): {
    entities: GraphEntity[]
    relations: GraphRelation[]
    evidence: Evidence[]
  } {
    const normalizedId = requiredString(
      knowledgeBaseId,
      'knowledgeBaseId',
      MAX_ID_LENGTH
    )
    const database = this.requireDatabase()
    return {
      entities: database
        .prepare(
          `SELECT * FROM graph_entities WHERE knowledge_base_id = ?
           ORDER BY name COLLATE NOCASE ASC, id ASC`
        )
        .all(normalizedId)
        .map(mapEntity),
      relations: database
        .prepare(
          `SELECT * FROM graph_relations WHERE knowledge_base_id = ?
           ORDER BY created_at ASC, id ASC`
        )
        .all(normalizedId)
        .map(mapRelation),
      evidence: database
        .prepare(
          `SELECT * FROM graph_evidence WHERE knowledge_base_id = ?
           ORDER BY created_at ASC, id ASC`
        )
        .all(normalizedId)
        .map(mapEvidence)
    }
  }

  updateEvidence(id: string, input: UpdateEvidenceInput): Evidence {
    const current = this.requiredEvidence(id)
    const next = {
      knowledgeBaseId: current.knowledgeBaseId,
      entityId:
        input.entityId === undefined
          ? current.entityId
          : optionalString(input.entityId, 'entityId', MAX_ID_LENGTH),
      relationId:
        input.relationId === undefined
          ? current.relationId
          : optionalString(input.relationId, 'relationId', MAX_ID_LENGTH),
      documentId:
        input.documentId === undefined
          ? current.documentId
          : requiredString(input.documentId, 'documentId', MAX_ID_LENGTH),
      chunkId:
        input.chunkId === undefined
          ? current.chunkId
          : optionalString(input.chunkId, 'chunkId', MAX_ID_LENGTH)
    }
    const database = this.requireDatabase()
    this.assertEvidenceTargets(database, next)
    database
      .prepare(
        `UPDATE graph_evidence
         SET entity_id = ?, relation_id = ?, document_id = ?, chunk_id = ?,
             quote = ?, location = ?
         WHERE id = ?`
      )
      .run(
        next.entityId ?? null,
        next.relationId ?? null,
        next.documentId,
        next.chunkId ?? null,
        input.quote === undefined
          ? (current.quote ?? null)
          : (optionalString(input.quote, 'quote', 32_768, false) ?? null),
        input.location === undefined
          ? (current.location ?? null)
          : (optionalString(
              input.location,
              'location',
              MAX_LOCATION_LENGTH,
              false
            ) ?? null),
        current.id
      )
    return this.requiredEvidence(current.id)
  }

  deleteEvidence(id: string): boolean {
    const normalizedId = requiredString(id, 'id', MAX_ID_LENGTH)
    return (
      this.requireDatabase()
        .prepare('DELETE FROM graph_evidence WHERE id = ?')
        .run(normalizedId).changes > 0
    )
  }

  mergeEntities(targetEntityId: string, sourceEntityId: string): GraphEntity {
    const target = this.requiredEntity(targetEntityId)
    const source = this.requiredEntity(sourceEntityId)
    if (target.id === source.id) {
      throw new Error('Cannot merge an entity into itself')
    }
    if (target.knowledgeBaseId !== source.knowledgeBaseId) {
      throw new Error('Entities must belong to the same knowledge base')
    }
    if (
      target.type !== source.type &&
      (target.locked || source.locked)
    ) {
      throw new Error('Entities with different ontology types cannot be merged')
    }

    const aliases = stringArray(
      [
        ...target.aliases,
        source.name,
        ...source.aliases.filter((alias) => alias !== target.name)
      ],
      'merged aliases'
    )
    const properties = { ...source.properties, ...target.properties }
    const database = this.requireDatabase()
    this.transaction(database, () => {
      database
        .prepare(
          `UPDATE graph_relations SET source_entity_id = ?
           WHERE source_entity_id = ?`
        )
        .run(target.id, source.id)
      database
        .prepare(
          `UPDATE graph_relations SET target_entity_id = ?
           WHERE target_entity_id = ?`
        )
        .run(target.id, source.id)
      database
        .prepare(
          `UPDATE graph_evidence SET entity_id = ? WHERE entity_id = ?`
        )
        .run(target.id, source.id)
      database
        .prepare(
          `UPDATE graph_entities
           SET aliases = ?, description = ?, properties = ?, locked = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(
          JSON.stringify(aliases),
          target.description ?? source.description ?? null,
          jsonObject(properties, 'merged properties'),
          target.locked || source.locked ? 1 : 0,
          new Date().toISOString(),
          target.id
        )
      database
        .prepare('DELETE FROM graph_entities WHERE id = ?')
        .run(source.id)
    })
    return this.requiredEntity(target.id)
  }

  private vectorSearchScored(
    options: VectorSearchOptions
  ): ScoredSearchResult[] {
    return this.vectorSearchScoredWithCount(options).results
  }

  private vectorSearchScoredWithCount(
    options: VectorSearchOptions
  ): {
    results: ScoredSearchResult[]
    scannedCount: number
  } {
    const knowledgeBaseId = requiredString(
      options.knowledgeBaseId,
      'knowledgeBaseId',
      MAX_ID_LENGTH
    )
    const provider = requiredString(
      options.provider,
      'provider',
      MAX_EMBEDDING_PROVIDER_LENGTH
    )
    const model = requiredString(
      options.model,
      'model',
      MAX_EMBEDDING_MODEL_LENGTH
    )
    const queryVector = normalizeVector(options.vector, 'vector')
    const limit = options.limit ?? 20
    boundedInteger(limit, 'limit', 1, 100)
    const minimumSimilarity = options.minimumSimilarity ?? -1
    if (
      typeof minimumSimilarity !== 'number' ||
      !Number.isFinite(minimumSimilarity) ||
      minimumSimilarity < -1 ||
      minimumSimilarity > 1
    ) {
      throw new RangeError('minimumSimilarity must be between -1 and 1')
    }
    const rows = this.requireDatabase()
      .prepare(
        `SELECT
           ce.chunk_id, ce.vector AS embedding_vector,
           ce.dimensions AS embedding_dimensions,
           ce.magnitude AS embedding_magnitude
         FROM chunk_embeddings ce
         JOIN embedding_index_state eis
           ON eis.knowledge_base_id = ce.knowledge_base_id
          AND eis.provider = ce.provider
          AND eis.model = ce.model
          AND eis.dimensions = ce.dimensions
          AND eis.status = 'ready'
         JOIN chunks c
           ON c.id = ce.chunk_id
          AND c.document_id = eis.document_id
          AND c.knowledge_base_id = ce.knowledge_base_id
         WHERE ce.knowledge_base_id = ?
           AND ce.provider = ? AND ce.model = ? AND ce.dimensions = ?
           AND length(ce.vector) = ce.dimensions * 4
           AND ce.content_checksum <> ''
           AND c.enabled = 1 AND c.role <> 'parent'
         ORDER BY ce.chunk_id ASC`
      )
      .iterate(
        knowledgeBaseId,
        provider,
        model,
        queryVector.dimensions
      )
    const winners: Array<{ chunkId: string; similarity: number }> = []
    let scanned = 0
    for (const row of rows) {
      scanned += 1
      if (scanned % 256 === 0) {
        options.signal?.throwIfAborted()
      }
      const similarity = cosineSimilarity(
        queryVector.values,
        queryVector.magnitude,
        asBytes(row, 'embedding_vector'),
        asNumber(row, 'embedding_dimensions'),
        asNumber(row, 'embedding_magnitude')
      )
      if (similarity === undefined || similarity < minimumSimilarity) {
        continue
      }
      const candidate = {
        chunkId: asString(row, 'chunk_id'),
        similarity
      }
      let insertionIndex = 0
      while (
        insertionIndex < winners.length &&
        (winners[insertionIndex]!.similarity > candidate.similarity ||
          (winners[insertionIndex]!.similarity === candidate.similarity &&
            winners[insertionIndex]!.chunkId.localeCompare(
              candidate.chunkId
            ) < 0))
      ) {
        insertionIndex += 1
      }
      if (insertionIndex < limit) {
        winners.splice(insertionIndex, 0, candidate)
        if (winners.length > limit) {
          winners.pop()
        }
      }
    }
    if (winners.length === 0) {
      return { results: [], scannedCount: scanned }
    }
    const placeholders = winners.map(() => '?').join(', ')
    const hydratedRows = this.requireDatabase()
      .prepare(
        `SELECT
           c.*, substr(c.content, 1, 600) AS snippet,
           d.id AS d_id, d.knowledge_base_id AS d_knowledge_base_id,
           d.source_id AS d_source_id, d.external_id AS d_external_id,
           d.title AS d_title, d.mime_type AS d_mime_type,
           d.source_location AS d_source_location, d.checksum AS d_checksum,
           d.metadata AS d_metadata, d.created_at AS d_created_at,
           d.updated_at AS d_updated_at,
           s.id AS s_id, s.knowledge_base_id AS s_knowledge_base_id,
           s.type AS s_type, s.location AS s_location,
           s.display_name AS s_display_name, s.status AS s_status,
           s.last_error AS s_last_error, s.metadata AS s_metadata,
           s.created_at AS s_created_at, s.updated_at AS s_updated_at
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         JOIN knowledge_sources s ON s.id = d.source_id
         WHERE c.id IN (${placeholders})
           AND c.knowledge_base_id = ?
           AND d.knowledge_base_id = ?
           AND s.knowledge_base_id = ?`
      )
      .all(
        ...winners.map((winner) => winner.chunkId),
        knowledgeBaseId,
        knowledgeBaseId,
        knowledgeBaseId
      ) as Row[]
    const rowsByChunkId = new Map(
      hydratedRows.map((row) => [asString(row, 'id'), row])
    )
    return {
      results: winners.flatMap((winner) => {
        const row = rowsByChunkId.get(winner.chunkId)
        return row
          ? [
              {
                similarity: winner.similarity,
                result: {
                  chunk: mapChunk(row),
                  document: mapDocument(this.prefixedRow(row, 'd_')),
                  source: mapSource(this.prefixedRow(row, 's_')),
                  snippet: asString(row, 'snippet'),
                  rank: -winner.similarity
                }
              }
            ]
          : []
      }),
      scannedCount: scanned
    }
  }

  private graphSearchScored(
    knowledgeBaseId: string,
    query: string,
    limit: number,
    maximumDepth: number
  ): ScoredSearchResult[] {
    const terms = [
      ...new Set(
        [query, ...query.split(/[^\p{L}\p{N}_.$/@-]+/u)]
          .map((term) => term.normalize('NFKC').trim().toLowerCase())
          .filter((term) => term.length > 1)
      )
    ]
      .sort((left, right) => right.length - left.length)
      .slice(0, 8)
    if (terms.length === 0) {
      return []
    }
    const conditions = terms
      .map(
        () =>
          `(lower(ge.name) LIKE ? ESCAPE '\\' OR lower(ge.aliases) LIKE ? ESCAPE '\\' OR lower(ge.type) LIKE ? ESCAPE '\\')`
      )
      .join(' OR ')
    const patterns = terms.flatMap((term) => {
      const escaped = term.replaceAll('\\', '\\\\').replaceAll('%', '\\%')
        .replaceAll('_', '\\_')
      return [`%${escaped}%`, `%${escaped}%`, `%${escaped}%`]
    })
    const rows = this.requireDatabase()
      .prepare(
        `WITH RECURSIVE
         seed(id, depth) AS (
           SELECT ge.id, 0
           FROM graph_entities ge
           WHERE ge.knowledge_base_id = ? AND (${conditions})
             AND EXISTS (
               SELECT 1 FROM graph_evidence ev
               JOIN chunks ec ON ec.id = ev.chunk_id
               WHERE ev.entity_id = ge.id
                 AND ev.knowledge_base_id = ge.knowledge_base_id
                 AND ec.knowledge_base_id = ge.knowledge_base_id
                 AND ec.document_id = ev.document_id
                 AND ec.enabled = 1
                 AND ec.role <> 'parent'
             )
           ORDER BY ge.name COLLATE NOCASE ASC, ge.id ASC
           LIMIT 24
         ),
         reachable(id, depth) AS (
           SELECT id, depth FROM seed
           UNION
           SELECT
             CASE
               WHEN gr.source_entity_id = reachable.id
                 THEN gr.target_entity_id
               ELSE gr.source_entity_id
             END,
             reachable.depth + 1
           FROM reachable
           JOIN graph_relations gr
             ON gr.knowledge_base_id = ?
            AND (gr.source_entity_id = reachable.id
                 OR gr.target_entity_id = reachable.id)
           WHERE reachable.depth < ?
             AND EXISTS (
               SELECT 1 FROM graph_evidence rev
               JOIN chunks rc ON rc.id = rev.chunk_id
               WHERE rev.relation_id = gr.id
                 AND rev.knowledge_base_id = gr.knowledge_base_id
                 AND rc.knowledge_base_id = gr.knowledge_base_id
                 AND rc.document_id = rev.document_id
                 AND rc.enabled = 1
                 AND rc.role <> 'parent'
             )
             AND EXISTS (
               SELECT 1 FROM graph_evidence nev
               JOIN chunks nc ON nc.id = nev.chunk_id
               WHERE nev.entity_id = CASE
                 WHEN gr.source_entity_id = reachable.id
                   THEN gr.target_entity_id
                 ELSE gr.source_entity_id
               END
                 AND nev.knowledge_base_id = gr.knowledge_base_id
                 AND nc.knowledge_base_id = gr.knowledge_base_id
                 AND nc.document_id = nev.document_id
                 AND nc.enabled = 1
                 AND nc.role <> 'parent'
             )
         ),
         reached(id, depth) AS (
           SELECT id, MIN(depth) FROM reachable GROUP BY id
         ),
         backed_evidence AS (
           SELECT ev.*, reached.depth AS graph_depth
           FROM graph_evidence ev
           JOIN reached ON reached.id = ev.entity_id
           WHERE ev.knowledge_base_id = ? AND ev.chunk_id IS NOT NULL
           UNION ALL
           SELECT ev.*, MAX(source.depth, target.depth) AS graph_depth
           FROM graph_evidence ev
           JOIN graph_relations gr ON gr.id = ev.relation_id
           JOIN reached source ON source.id = gr.source_entity_id
           JOIN reached target ON target.id = gr.target_entity_id
           WHERE ev.knowledge_base_id = ? AND gr.knowledge_base_id = ?
             AND ev.chunk_id IS NOT NULL
         )
         SELECT
           c.*, substr(c.content, 1, 600) AS snippet,
           200 + MIN(backed_evidence.graph_depth) AS rank,
           group_concat(DISTINCT backed_evidence.id) AS evidence_ids,
           d.id AS d_id, d.knowledge_base_id AS d_knowledge_base_id,
           d.source_id AS d_source_id, d.external_id AS d_external_id,
           d.title AS d_title, d.mime_type AS d_mime_type,
           d.source_location AS d_source_location, d.checksum AS d_checksum,
           d.metadata AS d_metadata, d.created_at AS d_created_at,
           d.updated_at AS d_updated_at,
           s.id AS s_id, s.knowledge_base_id AS s_knowledge_base_id,
           s.type AS s_type, s.location AS s_location,
           s.display_name AS s_display_name, s.status AS s_status,
           s.last_error AS s_last_error, s.metadata AS s_metadata,
           s.created_at AS s_created_at, s.updated_at AS s_updated_at
         FROM backed_evidence
         JOIN chunks c
           ON c.id = backed_evidence.chunk_id
          AND c.document_id = backed_evidence.document_id
         JOIN documents d ON d.id = c.document_id
         JOIN knowledge_sources s ON s.id = d.source_id
         WHERE c.knowledge_base_id = ? AND d.knowledge_base_id = ?
           AND s.knowledge_base_id = ?
           AND c.enabled = 1 AND c.role <> 'parent'
         GROUP BY c.id
         ORDER BY MIN(backed_evidence.graph_depth) ASC, c.id ASC
         LIMIT ?`
      )
      .all(
        knowledgeBaseId,
        ...patterns,
        knowledgeBaseId,
        maximumDepth,
        knowledgeBaseId,
        knowledgeBaseId,
        knowledgeBaseId,
        knowledgeBaseId,
        knowledgeBaseId,
        knowledgeBaseId,
        limit
      )
    return rows.map((row) => ({
      evidenceIds: asString(row, 'evidence_ids').split(','),
      result: {
        chunk: mapChunk(row),
        document: mapDocument(this.prefixedRow(row, 'd_')),
        source: mapSource(this.prefixedRow(row, 's_')),
        snippet: asString(row, 'snippet'),
        rank: asNumber(row, 'rank')
      }
    }))
  }

  private assertFts5(database: DatabaseSync): void {
    try {
      database.exec(`
        CREATE VIRTUAL TABLE temp.goodbuddy_fts5_probe USING fts5(value);
        DROP TABLE temp.goodbuddy_fts5_probe;
      `)
    } catch (error) {
      throw new Error(
        'GoodBuddy knowledge database requires SQLite with FTS5 support',
        { cause: error }
      )
    }
  }

  private migrate(database: DatabaseSync): void {
    const migrationTable = database
      .prepare(
        `SELECT 1 AS found FROM sqlite_schema
         WHERE type = 'table' AND name = 'schema_migrations'`
      )
      .get()
    if (migrationTable) {
      const versions = database
        .prepare(
          `SELECT
             (SELECT COALESCE(MAX(version), 0) FROM schema_migrations)
               AS migration_version,
             user_version
           FROM pragma_user_version`
        )
        .get()
      if (
        versions &&
        asNumber(versions, 'migration_version') === DATABASE_VERSION &&
        asNumber(versions, 'user_version') === DATABASE_VERSION
      ) {
        return
      }
    }

    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
      `)
      const row = database
        .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
        .get()
      const currentVersion = row ? asNumber(row, 'version') : 0
      if (currentVersion > DATABASE_VERSION) {
        throw new Error(
          `Knowledge database version ${currentVersion} is newer than supported version ${DATABASE_VERSION}`
        )
      }
      const userVersionRow = database
        .prepare('PRAGMA user_version')
        .get()
      const userVersion = userVersionRow
        ? asNumber(userVersionRow, 'user_version')
        : 0
      if (userVersion > DATABASE_VERSION) {
        throw new Error(
          `Knowledge database user version ${userVersion} is newer than supported version ${DATABASE_VERSION}`
        )
      }
      if (currentVersion < 1) {
        this.migrateToVersion1(database)
        database
          .prepare(
            'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
          )
          .run(1, new Date().toISOString())
      }
      if (currentVersion < 2) {
        this.migrateToVersion2(database)
        database
          .prepare(
            'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
          )
          .run(2, new Date().toISOString())
      }
      if (currentVersion < 3) {
        this.migrateToVersion3(database)
        database
          .prepare(
            'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
          )
          .run(3, new Date().toISOString())
      }
      if (currentVersion < 4) {
        this.migrateToVersion4(database)
        database
          .prepare(
            'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
          )
          .run(4, new Date().toISOString())
      }
      if (currentVersion < 5) {
        this.migrateToVersion5(database)
        database
          .prepare(
            'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
          )
          .run(5, new Date().toISOString())
      }
      if (currentVersion < 6) {
        this.migrateToVersion6(database)
        database
          .prepare(
            'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
          )
          .run(6, new Date().toISOString())
      }
      if (currentVersion < 7) {
        this.migrateToVersion7(database)
        database
          .prepare(
            'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
          )
          .run(7, new Date().toISOString())
      }
      if (currentVersion < 8) {
        this.migrateToVersion8(database)
        database
          .prepare(
            'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
          )
          .run(8, new Date().toISOString())
      }
      if (currentVersion < 9) {
        this.migrateToVersion9(database)
        database
          .prepare(
            'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
          )
          .run(9, new Date().toISOString())
      }
      if (currentVersion < 10) {
        this.migrateToVersion10(database)
        database
          .prepare(
            'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
          )
          .run(10, new Date().toISOString())
      }
      if (currentVersion < 11) {
        this.migrateToVersion11(database)
        database
          .prepare(
            'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
          )
          .run(11, new Date().toISOString())
      }
      database.exec(`PRAGMA user_version = ${DATABASE_VERSION}`)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  private migrateToVersion1(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE knowledge_bases (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        storage_mode TEXT NOT NULL CHECK (storage_mode IN ('reference', 'managed')),
        graph_enabled INTEGER NOT NULL CHECK (graph_enabled IN (0, 1)),
        graph_strategy TEXT NOT NULL CHECK (graph_strategy IN ('rules', 'model', 'hybrid', 'ask')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE knowledge_sources (
        id TEXT PRIMARY KEY,
        knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('file', 'directory', 'url')),
        location TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'indexing', 'ready', 'paused', 'error')),
        last_error TEXT,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (knowledge_base_id, type, location)
      );
      CREATE INDEX knowledge_sources_base_idx
        ON knowledge_sources(knowledge_base_id);

      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        mime_type TEXT,
        source_location TEXT,
        checksum TEXT,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (source_id, external_id)
      );
      CREATE INDEX documents_base_idx ON documents(knowledge_base_id);

      CREATE TABLE chunks (
        id TEXT PRIMARY KEY,
        knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        content TEXT NOT NULL,
        token_count INTEGER CHECK (token_count IS NULL OR token_count >= 0),
        heading TEXT,
        location TEXT,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (document_id, ordinal)
      );
      CREATE INDEX chunks_base_idx ON chunks(knowledge_base_id);

      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        content,
        content='chunks',
        content_rowid='rowid',
        tokenize='unicode61'
      );
      CREATE TRIGGER chunks_after_insert AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER chunks_after_delete AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content)
          VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER chunks_after_update AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content)
          VALUES ('delete', old.rowid, old.content);
        INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TABLE graph_entities (
        id TEXT PRIMARY KEY,
        knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        aliases TEXT NOT NULL,
        description TEXT,
        properties TEXT NOT NULL,
        locked INTEGER NOT NULL CHECK (locked IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX graph_entities_base_idx
        ON graph_entities(knowledge_base_id);

      CREATE TABLE graph_relations (
        id TEXT PRIMARY KEY,
        knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        source_entity_id TEXT NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
        target_entity_id TEXT NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        label TEXT,
        properties TEXT NOT NULL,
        locked INTEGER NOT NULL CHECK (locked IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX graph_relations_base_idx
        ON graph_relations(knowledge_base_id);

      CREATE TABLE graph_evidence (
        id TEXT PRIMARY KEY,
        knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        entity_id TEXT REFERENCES graph_entities(id) ON DELETE CASCADE,
        relation_id TEXT REFERENCES graph_relations(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        chunk_id TEXT REFERENCES chunks(id) ON DELETE SET NULL,
        quote TEXT,
        location TEXT,
        created_at TEXT NOT NULL,
        CHECK (entity_id IS NOT NULL OR relation_id IS NOT NULL)
      );
      CREATE INDEX graph_evidence_base_idx
        ON graph_evidence(knowledge_base_id);
    `)
  }

  private migrateToVersion2(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE chunk_embeddings (
        chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
        knowledge_base_id TEXT NOT NULL
          REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL
          CHECK (dimensions >= 1 AND dimensions <= 8192),
        content_checksum TEXT NOT NULL
          CHECK (length(content_checksum) = 64),
        vector BLOB NOT NULL
          CHECK (length(vector) = dimensions * 4),
        magnitude REAL NOT NULL CHECK (magnitude > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chunk_id, provider, model)
      );
      CREATE INDEX chunk_embeddings_lookup_idx
        ON chunk_embeddings(
          knowledge_base_id, provider, model, dimensions, chunk_id
        );

      CREATE TABLE embedding_index_state (
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        knowledge_base_id TEXT NOT NULL
          REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER
          CHECK (dimensions IS NULL OR
                 (dimensions >= 1 AND dimensions <= 8192)),
        content_checksum TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ready', 'error')),
        last_error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (document_id, provider, model)
      );
      CREATE INDEX embedding_index_state_lookup_idx
        ON embedding_index_state(
          knowledge_base_id, provider, model, status, document_id
        );
    `)
  }

  private migrateToVersion3(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE embedding_index_job (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        status_json TEXT NOT NULL CHECK (length(status_json) <= 32768),
        updated_at TEXT NOT NULL
      );
    `)
  }

  private migrateToVersion4(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE embedding_rebuild_staging (
        replacement_id TEXT NOT NULL,
        document_id TEXT NOT NULL
          REFERENCES documents(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        chunk_id TEXT NOT NULL
          REFERENCES chunks(id) ON DELETE CASCADE,
        dimensions INTEGER NOT NULL
          CHECK (dimensions >= 1 AND dimensions <= 8192),
        content_checksum TEXT NOT NULL
          CHECK (length(content_checksum) = 64),
        vector BLOB NOT NULL,
        magnitude REAL NOT NULL CHECK (magnitude > 0),
        PRIMARY KEY (replacement_id, chunk_id)
      );
      CREATE INDEX embedding_rebuild_staging_document_idx
        ON embedding_rebuild_staging(
          document_id, provider, model, replacement_id
        );
    `)
  }

  private migrateToVersion5(database: DatabaseSync): void {
    const addColumn = (
      table: 'knowledge_bases' | 'chunks',
      name: string,
      definition: string
    ): void => {
      const exists = database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((row) => asString(row, 'name') === name)
      if (!exists) {
        database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
      }
    }
    addColumn(
      'knowledge_bases',
      'retrieval_settings',
      `retrieval_settings TEXT NOT NULL
       DEFAULT '{"version":1,"topK":6,"minimumVectorSimilarity":0,"ftsWeight":1,"vectorWeight":1,"graphWeight":0.8,"candidateMultiplier":4,"contextMaxCharacters":16000,"adjacentChunkCount":0,"localRerankEnabled":false}'`
    )
    addColumn(
      'knowledge_bases',
      'chunking_settings',
      `chunking_settings TEXT NOT NULL
       DEFAULT '{"version":1,"mode":"structure","targetCharacters":1600,"overlapCharacters":160,"parentCharacters":4800,"childCharacters":900}'`
    )
    addColumn(
      'knowledge_bases',
      'chunking_rebuild_required',
      `chunking_rebuild_required INTEGER NOT NULL DEFAULT 0
       CHECK (chunking_rebuild_required IN (0, 1))`
    )
    addColumn(
      'chunks',
      'enabled',
      'enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))'
    )
    addColumn(
      'chunks',
      'role',
      `role TEXT NOT NULL DEFAULT 'standalone'
       CHECK (role IN ('standalone', 'parent', 'child'))`
    )
    addColumn(
      'chunks',
      'parent_chunk_id',
      'parent_chunk_id TEXT REFERENCES chunks(id) ON DELETE SET NULL'
    )
    addColumn(
      'chunks',
      'manually_edited',
      `manually_edited INTEGER NOT NULL DEFAULT 0
       CHECK (manually_edited IN (0, 1))`
    )
    addColumn('chunks', 'updated_at', 'updated_at TEXT')
    addColumn(
      'chunks',
      'cjk_search',
      `cjk_search TEXT NOT NULL DEFAULT ''`
    )
    database.exec(`
      CREATE INDEX IF NOT EXISTS chunks_document_state_idx
        ON chunks(document_id, enabled, role, ordinal, id);
      CREATE INDEX IF NOT EXISTS chunks_parent_idx ON chunks(parent_chunk_id);

      DROP TRIGGER IF EXISTS chunks_after_insert;
      DROP TRIGGER IF EXISTS chunks_after_delete;
      DROP TRIGGER IF EXISTS chunks_after_update;
      DROP TRIGGER IF EXISTS chunks_cjk_after_insert;
      DROP TRIGGER IF EXISTS chunks_cjk_after_delete;
      DROP TRIGGER IF EXISTS chunks_cjk_after_update;
    `)
    const update = database.prepare(
      'UPDATE chunks SET cjk_search = ?, updated_at = created_at WHERE id = ?'
    )
    for (const row of database
      .prepare('SELECT id, content, heading FROM chunks ORDER BY rowid')
      .iterate()) {
      update.run(
        createCjkSearchText(
          `${asOptionalString(row, 'heading') ?? ''}\n${asString(row, 'content')}`
        ),
        asString(row, 'id')
      )
    }
    database.exec(`
      CREATE TRIGGER chunks_after_insert AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, content)
          SELECT new.rowid, new.content
          WHERE new.enabled = 1 AND new.role <> 'parent';
      END;
      CREATE TRIGGER chunks_after_delete AFTER DELETE ON chunks
        WHEN old.enabled = 1 AND old.role <> 'parent' BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content)
          VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER chunks_after_update AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content)
          SELECT 'delete', old.rowid, old.content
          WHERE old.enabled = 1 AND old.role <> 'parent';
        INSERT INTO chunks_fts(rowid, content)
          SELECT new.rowid, new.content
          WHERE new.enabled = 1 AND new.role <> 'parent';
      END;

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_cjk USING fts5(
        cjk_search,
        content='chunks',
        content_rowid='rowid',
        tokenize='unicode61'
      );
      CREATE TRIGGER chunks_cjk_after_insert AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_cjk(rowid, cjk_search)
          SELECT new.rowid, new.cjk_search
          WHERE new.enabled = 1 AND new.role <> 'parent';
      END;
      CREATE TRIGGER chunks_cjk_after_delete AFTER DELETE ON chunks
        WHEN old.enabled = 1 AND old.role <> 'parent' BEGIN
        INSERT INTO chunks_cjk(chunks_cjk, rowid, cjk_search)
          VALUES ('delete', old.rowid, old.cjk_search);
      END;
      CREATE TRIGGER chunks_cjk_after_update AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_cjk(chunks_cjk, rowid, cjk_search)
          SELECT 'delete', old.rowid, old.cjk_search
          WHERE old.enabled = 1 AND old.role <> 'parent';
        INSERT INTO chunks_cjk(rowid, cjk_search)
          SELECT new.rowid, new.cjk_search
          WHERE new.enabled = 1 AND new.role <> 'parent';
      END;
      INSERT INTO chunks_cjk(chunks_cjk) VALUES ('rebuild');
    `)
  }

  private migrateToVersion6(database: DatabaseSync): void {
    database.exec(`
      ALTER TABLE embedding_index_job RENAME TO embedding_index_job_global;
      CREATE TABLE embedding_index_job (
        knowledge_base_id TEXT PRIMARY KEY
          REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        status_json TEXT NOT NULL CHECK (length(status_json) <= 32768),
        updated_at TEXT NOT NULL
      );
      INSERT INTO embedding_index_job
        (knowledge_base_id, status_json, updated_at)
      SELECT kb.id, legacy.status_json, legacy.updated_at
      FROM embedding_index_job_global legacy
      CROSS JOIN (SELECT id FROM knowledge_bases LIMIT 1) kb
      WHERE (SELECT COUNT(*) FROM knowledge_bases) = 1;
      DROP TABLE embedding_index_job_global;
    `)
  }

  private migrateToVersion7(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE knowledge_tasks (
        id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL
          REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        parent_task_id TEXT
          REFERENCES knowledge_tasks(id) ON DELETE SET NULL,
        retry_of_task_id TEXT
          REFERENCES knowledge_tasks(id) ON DELETE SET NULL,
        source_id TEXT
          REFERENCES knowledge_sources(id) ON DELETE SET NULL,
        document_id TEXT
          REFERENCES documents(id) ON DELETE SET NULL,
        document_name TEXT NOT NULL
          CHECK (length(document_name) BETWEEN 1 AND 512),
        scope TEXT NOT NULL
          CHECK (scope IN ('library', 'source', 'document')),
        kind TEXT NOT NULL CHECK (kind IN (
          'source-sync', 'document-process', 'document-rebuild',
          'library-rebuild', 'embedding-rebuild', 'graph-rebuild',
          'parsing', 'embedding', 'graph'
        )),
        stage TEXT NOT NULL CHECK (stage IN (
          'queued', 'syncing', 'reading', 'parsing', 'chunking', 'indexing',
          'embedding', 'graph', 'finalizing'
        )),
        status TEXT NOT NULL CHECK (status IN (
          'queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped',
          'interrupted'
        )),
        progress INTEGER NOT NULL CHECK (progress BETWEEN 0 AND 100),
        completed_items INTEGER CHECK (completed_items IS NULL OR completed_items >= 0),
        total_items INTEGER CHECK (total_items IS NULL OR total_items >= 0),
        message TEXT CHECK (message IS NULL OR length(message) <= 1000),
        error_message TEXT
          CHECK (error_message IS NULL OR length(error_message) BETWEEN 1 AND 1000),
        error_remedy TEXT
          CHECK (error_remedy IS NULL OR length(error_remedy) BETWEEN 1 AND 1000),
        attempt INTEGER NOT NULL CHECK (attempt >= 1),
        dedupe_key TEXT
          CHECK (dedupe_key IS NULL OR length(dedupe_key) BETWEEN 1 AND 512),
        embedding_job_id TEXT
          CHECK (embedding_job_id IS NULL OR length(embedding_job_id) BETWEEN 1 AND 256),
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        CHECK (
          completed_items IS NULL OR total_items IS NULL
          OR completed_items <= total_items
        ),
        CHECK (status <> 'failed' OR error_message IS NOT NULL),
        CHECK (status <> 'succeeded' OR progress = 100),
        CHECK (
          status IN ('queued', 'running') OR completed_at IS NOT NULL
        )
      );
      CREATE UNIQUE INDEX knowledge_tasks_active_dedupe_idx
        ON knowledge_tasks(library_id, dedupe_key)
        WHERE dedupe_key IS NOT NULL
          AND status IN ('queued', 'running');
      CREATE INDEX knowledge_tasks_library_list_idx
        ON knowledge_tasks(library_id, created_at DESC, id DESC);
      CREATE INDEX knowledge_tasks_parent_idx
        ON knowledge_tasks(parent_task_id, created_at ASC, id ASC);
      CREATE INDEX knowledge_tasks_retry_idx
        ON knowledge_tasks(retry_of_task_id);
      CREATE INDEX knowledge_tasks_embedding_job_idx
        ON knowledge_tasks(embedding_job_id)
        WHERE embedding_job_id IS NOT NULL;
    `)
  }

  private migrateToVersion8(database: DatabaseSync): void {
    const ontology = JSON.stringify(defaultKnowledgeOntologySettings)
      .replaceAll("'", "''")
    const addColumn = (
      table: 'knowledge_bases' | 'graph_evidence',
      name: string,
      definition: string
    ): void => {
      const exists = database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((row) => asString(row, 'name') === name)
      if (!exists) {
        database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
      }
    }
    addColumn(
      'knowledge_bases',
      'ontology_settings',
      `ontology_settings TEXT NOT NULL DEFAULT '${ontology}'`
    )
    addColumn(
      'knowledge_bases',
      'ontology_rebuild_required',
      `ontology_rebuild_required INTEGER NOT NULL DEFAULT 0
       CHECK (ontology_rebuild_required IN (0, 1))`
    )
    addColumn(
      'graph_evidence',
      'start_offset',
      'start_offset INTEGER CHECK (start_offset IS NULL OR start_offset >= 0)'
    )
    addColumn(
      'graph_evidence',
      'end_offset',
      'end_offset INTEGER CHECK (end_offset IS NULL OR end_offset >= 0)'
    )
    addColumn(
      'graph_evidence',
      'confidence',
      `confidence REAL CHECK (
        confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
      )`
    )
    addColumn(
      'graph_evidence',
      'source',
      `source TEXT NOT NULL DEFAULT 'legacy'
       CHECK (source IN ('rules', 'model', 'manual', 'legacy'))`
    )
    addColumn(
      'graph_evidence',
      'provenance',
      `provenance TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(provenance))`
    )
  }

  private migrateToVersion9(database: DatabaseSync): void {
    const hasIndexContent = database
      .prepare('PRAGMA table_info(chunks)')
      .all()
      .some((row) => asString(row, 'name') === 'index_content')
    if (!hasIndexContent) {
      database.exec(
        `ALTER TABLE chunks ADD COLUMN index_content TEXT NOT NULL DEFAULT ''`
      )
    }
    database.exec(`
      DROP TRIGGER IF EXISTS chunks_after_insert;
      DROP TRIGGER IF EXISTS chunks_after_delete;
      DROP TRIGGER IF EXISTS chunks_after_update;
      DROP TRIGGER IF EXISTS chunks_cjk_after_insert;
      DROP TRIGGER IF EXISTS chunks_cjk_after_delete;
      DROP TRIGGER IF EXISTS chunks_cjk_after_update;
      DROP TABLE IF EXISTS chunks_fts;
    `)
    const update = database.prepare(
      `UPDATE chunks SET index_content = ?, cjk_search = ? WHERE id = ?`
    )
    const selectPage = database.prepare(
      `SELECT rowid, id, content, heading, metadata
       FROM chunks WHERE rowid > ? ORDER BY rowid LIMIT 500`
    )
    let lastRowId = 0
    while (true) {
      const rows = selectPage.all(lastRowId)
      if (rows.length === 0) {
        break
      }
      for (const row of rows) {
        const content = chunkIndexContent(
          asString(row, 'content'),
          parseObject(asString(row, 'metadata'))
        )
        update.run(
          content,
          createCjkSearchText(
            `${asOptionalString(row, 'heading') ?? ''}\n${content}`
          ),
          asString(row, 'id')
        )
      }
      lastRowId = asNumber(rows.at(-1)!, 'rowid')
    }
    database.exec(`
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        index_content,
        content='chunks',
        content_rowid='rowid',
        tokenize='unicode61'
      );
      CREATE TRIGGER chunks_after_insert AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, index_content)
          SELECT new.rowid, new.index_content
          WHERE new.enabled = 1 AND new.role <> 'parent';
      END;
      CREATE TRIGGER chunks_after_delete AFTER DELETE ON chunks
        WHEN old.enabled = 1 AND old.role <> 'parent' BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, index_content)
          VALUES ('delete', old.rowid, old.index_content);
      END;
      CREATE TRIGGER chunks_after_update AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, index_content)
          SELECT 'delete', old.rowid, old.index_content
          WHERE old.enabled = 1 AND old.role <> 'parent';
        INSERT INTO chunks_fts(rowid, index_content)
          SELECT new.rowid, new.index_content
          WHERE new.enabled = 1 AND new.role <> 'parent';
      END;

      CREATE TRIGGER chunks_cjk_after_insert AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_cjk(rowid, cjk_search)
          SELECT new.rowid, new.cjk_search
          WHERE new.enabled = 1 AND new.role <> 'parent';
      END;
      CREATE TRIGGER chunks_cjk_after_delete AFTER DELETE ON chunks
        WHEN old.enabled = 1 AND old.role <> 'parent' BEGIN
        INSERT INTO chunks_cjk(chunks_cjk, rowid, cjk_search)
          VALUES ('delete', old.rowid, old.cjk_search);
      END;
      CREATE TRIGGER chunks_cjk_after_update AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_cjk(chunks_cjk, rowid, cjk_search)
          SELECT 'delete', old.rowid, old.cjk_search
          WHERE old.enabled = 1 AND old.role <> 'parent';
        INSERT INTO chunks_cjk(rowid, cjk_search)
          SELECT new.rowid, new.cjk_search
          WHERE new.enabled = 1 AND new.role <> 'parent';
      END;

      INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild');
      INSERT INTO chunks_cjk(chunks_cjk) VALUES ('rebuild');

      UPDATE knowledge_bases
      SET chunking_rebuild_required = CASE
        WHEN EXISTS (
          SELECT 1 FROM documents
          WHERE documents.knowledge_base_id = knowledge_bases.id
        ) THEN 1
        ELSE 0
      END
      WHERE json_extract(
        chunking_settings,
        '$.contextualIndexingEnabled'
      ) = 1;
    `)
  }

  private migrateToVersion10(database: DatabaseSync): void {
    database.exec(`
      CREATE INDEX IF NOT EXISTS graph_evidence_chunk_idx
        ON graph_evidence(knowledge_base_id, chunk_id);
      CREATE INDEX IF NOT EXISTS graph_evidence_entity_idx
        ON graph_evidence(knowledge_base_id, entity_id);
      CREATE INDEX IF NOT EXISTS graph_evidence_relation_idx
        ON graph_evidence(knowledge_base_id, relation_id);
      CREATE INDEX IF NOT EXISTS graph_relations_source_idx
        ON graph_relations(knowledge_base_id, source_entity_id);
      CREATE INDEX IF NOT EXISTS graph_relations_target_idx
        ON graph_relations(knowledge_base_id, target_entity_id);
    `)
  }

  private migrateToVersion11(database: DatabaseSync): void {
    database.exec('DROP TABLE embedding_rebuild_staging;')
    database.exec(`
      CREATE TABLE embedding_rebuild_staging (
        replacement_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL
          CHECK (dimensions >= 1 AND dimensions <= 8192),
        content_checksum TEXT NOT NULL
          CHECK (length(content_checksum) = 64),
        vector BLOB NOT NULL,
        magnitude REAL NOT NULL CHECK (magnitude > 0),
        PRIMARY KEY (replacement_id, chunk_id)
      );
      CREATE INDEX embedding_rebuild_staging_document_idx
        ON embedding_rebuild_staging(
          document_id, provider, model, replacement_id
        );
    `)
  }

  private validatePreparedDocumentEmbeddings(
    database: DatabaseSync,
    replacement: PreparedEmbeddingReplacement,
    documentId: string,
    chunks: ReturnType<KnowledgeDatabase['normalizeChunks']>
  ): void {
    const indexableChunks = chunks.filter(
      (chunk) => chunk.enabled && chunk.role !== 'parent'
    )
    if (indexableChunks.length === 0) {
      throw new Error(
        'Prepared embedding replacement requires indexable chunks'
      )
    }
    const stagedRows = database
      .prepare(
        `SELECT chunk_id, content_checksum, dimensions
         FROM embedding_rebuild_staging
         WHERE replacement_id = ? AND document_id = ?
           AND provider = ? AND model = ?
         ORDER BY chunk_id`
      )
      .all(
        replacement.replacementId,
        documentId,
        replacement.provider,
        replacement.model
      )
    if (stagedRows.length !== indexableChunks.length) {
      throw new Error('Embeddings must cover every candidate document chunk')
    }
    const chunksById = new Map(
      indexableChunks.map((chunk) => [
        chunk.id,
        contentChecksum(
          chunkIndexContent(chunk.content, parseObject(chunk.metadata))
        )
      ])
    )
    let dimensions: number | undefined
    for (const row of stagedRows) {
      const chunkId = asString(row, 'chunk_id')
      const checksum = chunksById.get(chunkId)
      if (
        checksum === undefined ||
        checksum !== asString(row, 'content_checksum')
      ) {
        throw new Error('Prepared embedding content does not match the chunk')
      }
      chunksById.delete(chunkId)
      const rowDimensions = asNumber(row, 'dimensions')
      if (dimensions === undefined) {
        dimensions = rowDimensions
      } else if (dimensions !== rowDimensions) {
        throw new Error(
          'Document embeddings must have consistent dimensions'
        )
      }
    }
    if (chunksById.size > 0) {
      throw new Error('Embeddings must cover every candidate document chunk')
    }
  }

  private publishPreparedDocumentEmbeddings(
    database: DatabaseSync,
    replacement: PreparedEmbeddingReplacement,
    documentId: string,
    knowledgeBaseId: string,
    now: string
  ): void {
    let dimensions: number | undefined
    const indexHash = createHash('sha256')
    let firstChecksum = true
    for (const row of database
      .prepare(
        `SELECT chunk_id, content_checksum, dimensions
         FROM embedding_rebuild_staging
         WHERE replacement_id = ? AND document_id = ?
           AND provider = ? AND model = ?
         ORDER BY chunk_id`
      )
      .iterate(
        replacement.replacementId,
        documentId,
        replacement.provider,
        replacement.model
      )) {
      const chunkId = asString(row, 'chunk_id')
      const checksum = asString(row, 'content_checksum')
      if (!firstChecksum) {
        indexHash.update('\n')
      }
      indexHash.update(`${chunkId}\0${checksum}`)
      firstChecksum = false
      dimensions ??= asNumber(row, 'dimensions')
    }
    database
      .prepare(
        `INSERT INTO chunk_embeddings
          (chunk_id, knowledge_base_id, provider, model, dimensions,
           content_checksum, vector, magnitude, created_at, updated_at)
         SELECT chunk_id, ?, provider, model, dimensions,
           content_checksum, vector, magnitude, ?, ?
         FROM embedding_rebuild_staging
         WHERE replacement_id = ? AND document_id = ?
           AND provider = ? AND model = ?`
      )
      .run(
        knowledgeBaseId,
        now,
        now,
        replacement.replacementId,
        documentId,
        replacement.provider,
        replacement.model
      )
    database
      .prepare(
        `INSERT INTO embedding_index_state
          (document_id, knowledge_base_id, provider, model, dimensions,
           content_checksum, status, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ready', NULL, ?)`
      )
      .run(
        documentId,
        knowledgeBaseId,
        replacement.provider,
        replacement.model,
        dimensions ?? null,
        indexHash.digest('hex'),
        now
      )
    database
      .prepare(
        'DELETE FROM embedding_rebuild_staging WHERE replacement_id = ?'
      )
      .run(replacement.replacementId)
  }

  private insertEmbeddingReplacementBatch(
    database: DatabaseSync,
    input: {
      replacementId: string
      documentId: string
      provider: string
      model: string
      embeddings: ReadonlyArray<{
        chunkId: string
        checksum: string
        bytes: Buffer
        dimensions: number
        magnitude: number
      }>
    }
  ): void {
    const insert = database.prepare(
      `INSERT INTO embedding_rebuild_staging
        (replacement_id, document_id, provider, model, chunk_id,
         dimensions, content_checksum, vector, magnitude)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    this.transaction(database, () => {
      const existingTarget = database
        .prepare(
          `SELECT document_id, provider, model
           FROM embedding_rebuild_staging
           WHERE replacement_id = ? LIMIT 1`
        )
        .get(input.replacementId)
      if (
        existingTarget &&
        (
          asString(existingTarget, 'document_id') !== input.documentId ||
          asString(existingTarget, 'provider') !== input.provider ||
          asString(existingTarget, 'model') !== input.model
        )
      ) {
        throw new Error(
          'Embedding replacement target cannot change between batches'
        )
      }
      for (const item of input.embeddings) {
        insert.run(
          input.replacementId,
          input.documentId,
          input.provider,
          input.model,
          item.chunkId,
          item.dimensions,
          item.checksum,
          item.bytes,
          item.magnitude
        )
      }
    })
  }

  private normalizeChunks(chunks: ReplaceChunkInput[]): Array<{
    id: string
    ordinal: number
    content: string
    tokenCount?: number
    heading?: string
    location?: string
    metadata: string
    enabled: boolean
    role: KnowledgeChunkRole
    parentChunkId?: string
    manuallyEdited: boolean
  }> {
    let totalContent = 0
    const ordinals = new Set<number>()
    const ids = new Set<string>()
    const normalized = chunks.map((chunk, index) => {
      const id =
        optionalString(chunk.id, `chunks[${index}].id`, MAX_ID_LENGTH) ??
        randomUUID()
      if (ids.has(id)) {
        throw new Error('Chunk IDs must be unique')
      }
      ids.add(id)
      const ordinal = boundedInteger(
        chunk.ordinal,
        `chunks[${index}].ordinal`,
        0,
        MAX_CHUNKS - 1
      )
      if (ordinals.has(ordinal)) {
        throw new Error('Chunk ordinals must be unique')
      }
      ordinals.add(ordinal)
      const content = requiredString(
        chunk.content,
        `chunks[${index}].content`,
        MAX_CONTENT_LENGTH,
        false
      )
      totalContent += content.length
      if (totalContent > MAX_CHUNK_BATCH_CONTENT) {
        throw new RangeError(
          `chunk content must total at most ${MAX_CHUNK_BATCH_CONTENT} characters`
        )
      }
      return {
        id,
        ordinal,
        content,
        tokenCount:
          chunk.tokenCount === undefined
            ? undefined
            : boundedInteger(
                chunk.tokenCount,
                `chunks[${index}].tokenCount`,
                0,
                100_000_000
              ),
        heading: optionalString(
          chunk.heading,
          `chunks[${index}].heading`,
          MAX_NAME_LENGTH
        ),
        location: optionalString(
          chunk.location,
          `chunks[${index}].location`,
          MAX_LOCATION_LENGTH,
          false
        ),
        metadata: jsonObject(chunk.metadata, `chunks[${index}].metadata`),
        enabled: chunk.enabled ?? true,
        role: knowledgeChunkRoleSchema.parse(chunk.role ?? 'standalone'),
        parentChunkId: optionalString(
          chunk.parentChunkId,
          `chunks[${index}].parentChunkId`,
          MAX_ID_LENGTH
        ),
        manuallyEdited: chunk.manuallyEdited ?? false
      }
    })
    const byId = new Map(normalized.map((chunk) => [chunk.id, chunk]))
    for (const chunk of normalized) {
      if (chunk.role === 'child') {
        const parent = chunk.parentChunkId
          ? byId.get(chunk.parentChunkId)
          : undefined
        if (!parent || parent.role !== 'parent') {
          throw new Error('Child chunks must reference a parent chunk in the batch')
        }
      } else if (chunk.parentChunkId !== undefined) {
        throw new Error('Only child chunks may reference a parent chunk')
      }
    }
    return normalized
  }

  private assertRelationEntities(
    database: DatabaseSync,
    knowledgeBaseId: string,
    sourceEntityId: string,
    targetEntityId: string
  ): void {
    const count = database
      .prepare(
        `SELECT COUNT(*) AS count FROM graph_entities
         WHERE knowledge_base_id = ? AND id IN (?, ?)`
      )
      .get(knowledgeBaseId, sourceEntityId, targetEntityId)
    const expected = sourceEntityId === targetEntityId ? 1 : 2
    if (!count || asNumber(count, 'count') !== expected) {
      throw new Error('Relation entities must belong to the relation knowledge base')
    }
  }

  private assertOntologyRelation(
    database: DatabaseSync,
    knowledgeBaseId: string,
    sourceEntityId: string,
    targetEntityId: string,
    relationType: string
  ): void {
    if (sourceEntityId === targetEntityId) {
      throw new Error('Knowledge graph relations cannot target the same entity')
    }
    const rows = database
      .prepare(
        `SELECT id, type FROM graph_entities
         WHERE knowledge_base_id = ? AND id IN (?, ?)`
      )
      .all(knowledgeBaseId, sourceEntityId, targetEntityId)
    const types = new Map(
      rows.map((row) => [asString(row, 'id'), asString(row, 'type')])
    )
    const sourceType = types.get(sourceEntityId)
    const targetType = types.get(targetEntityId)
    if (
      !sourceType ||
      !targetType ||
      !isRelationEndpointAllowed(
        relationType,
        sourceType,
        targetType,
        this.requiredKnowledgeBase(knowledgeBaseId).ontologySettings
      )
    ) {
      throw new Error(
        'Relation endpoints are not allowed by the library ontology'
      )
    }
  }

  private assertEvidenceTargets(
    database: DatabaseSync,
    value: {
      knowledgeBaseId: string
      entityId?: string
      relationId?: string
      documentId: string
      chunkId?: string
    }
  ): void {
    if (!value.entityId && !value.relationId) {
      throw new Error('Evidence must reference an entity or relation')
    }
    const matches = (
      statement: StatementSync,
      id: string | undefined
    ): boolean =>
      id === undefined ||
      asNumber(
        statement.get(id, value.knowledgeBaseId) as Row,
        'count'
      ) === 1
    const chunkMatches =
      value.chunkId === undefined ||
      asNumber(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM chunks
             WHERE id = ? AND knowledge_base_id = ? AND document_id = ?`
          )
          .get(value.chunkId, value.knowledgeBaseId, value.documentId) as Row,
        'count'
      ) === 1
    if (
      !matches(
        database.prepare(
          'SELECT COUNT(*) AS count FROM graph_entities WHERE id = ? AND knowledge_base_id = ?'
        ),
        value.entityId
      ) ||
      !matches(
        database.prepare(
          'SELECT COUNT(*) AS count FROM graph_relations WHERE id = ? AND knowledge_base_id = ?'
        ),
        value.relationId
      ) ||
      !matches(
        database.prepare(
          'SELECT COUNT(*) AS count FROM documents WHERE id = ? AND knowledge_base_id = ?'
        ),
        value.documentId
      ) ||
      !chunkMatches
    ) {
      throw new Error('Evidence targets must belong to the evidence knowledge base')
    }
  }

  private prefixedRow(row: Row, prefix: string): Row {
    const result: Row = {}
    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith(prefix)) {
        result[key.slice(prefix.length)] = value
      }
    }
    return result
  }

  private validateWeight(value: number, field: string): number {
    if (!Number.isFinite(value) || value < 0 || value > 2) {
      throw new RangeError(`${field} must be between 0 and 2`)
    }
    return value
  }

  private transaction(database: DatabaseSync, operation: () => void): void {
    if (database.isTransaction) {
      operation()
      return
    }
    database.exec('BEGIN IMMEDIATE')
    try {
      operation()
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  private requireDatabase(): DatabaseSync {
    if (!this.database) {
      throw new Error('Knowledge database is not initialized')
    }
    return this.database
  }

  private requiredKnowledgeBase(id: string): KnowledgeBase {
    const value = this.getKnowledgeBase(id)
    if (!value) {
      throw new Error(`Knowledge base not found: ${id}`)
    }
    return value
  }

  private requiredSource(id: string): KnowledgeSource {
    const normalizedId = requiredString(id, 'id', MAX_ID_LENGTH)
    const row = this.requireDatabase()
      .prepare('SELECT * FROM knowledge_sources WHERE id = ?')
      .get(normalizedId)
    if (!row) {
      throw new Error(`Knowledge source not found: ${normalizedId}`)
    }
    return mapSource(row)
  }

  private requiredDocument(id: string): Document {
    const value = this.getDocument(id)
    if (!value) {
      throw new Error(`Document not found: ${id}`)
    }
    return value
  }

  private requiredEntity(id: string): GraphEntity {
    const value = this.getEntity(id)
    if (!value) {
      throw new Error(`Graph entity not found: ${id}`)
    }
    return value
  }

  private requiredRelation(id: string): GraphRelation {
    const value = this.getRelation(id)
    if (!value) {
      throw new Error(`Graph relation not found: ${id}`)
    }
    return value
  }

  private requiredEvidence(id: string): Evidence {
    const normalizedId = requiredString(id, 'id', MAX_ID_LENGTH)
    const row = this.requireDatabase()
      .prepare('SELECT * FROM graph_evidence WHERE id = ?')
      .get(normalizedId)
    if (!row) {
      throw new Error(`Graph evidence not found: ${normalizedId}`)
    }
    return mapEvidence(row)
  }

  private requiredEmbeddingIndexState(
    documentId: string,
    provider: string,
    model: string
  ): EmbeddingIndexState {
    const value = this.getEmbeddingIndexState(documentId, provider, model)
    if (!value) {
      throw new Error(`Embedding index state not found: ${documentId}`)
    }
    return value
  }

  private requiredKnowledgeTask(id: string): KnowledgeTaskItem {
    const value = this.getKnowledgeTask(id)
    if (!value) {
      throw new Error(`Knowledge task not found: ${id}`)
    }
    return value
  }
}
