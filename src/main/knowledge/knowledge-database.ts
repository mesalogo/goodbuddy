import { randomUUID } from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type {
  Chunk,
  CreateEvidenceInput,
  CreateGraphEntityInput,
  CreateGraphRelationInput,
  CreateKnowledgeBaseInput,
  Document,
  Evidence,
  GraphEntity,
  GraphRelation,
  GraphStrategy,
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
  UpsertKnowledgeSourceInput
} from './types'

const DATABASE_VERSION = 1
const MAX_ID_LENGTH = 128
const MAX_NAME_LENGTH = 512
const MAX_LOCATION_LENGTH = 8192
const MAX_CONTENT_LENGTH = 2_000_000
const MAX_JSON_LENGTH = 131_072
const MAX_CHUNKS = 10_000
const MAX_CHUNK_BATCH_CONTENT = 32_000_000
const MAX_ALIASES = 100
const MAX_LIST_LIMIT = 500
const MAX_JSON_ARRAY_ITEMS = 1_000
const MAX_JSON_DEPTH = 20
const MAX_JSON_NODES = 10_000
const MAX_JSON_STRING_LENGTH = 32_768

type Row = Record<string, null | number | bigint | string | Uint8Array>

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

function mapKnowledgeBase(row: Row): KnowledgeBase {
  return {
    id: asString(row, 'id'),
    name: asString(row, 'name'),
    description: asOptionalString(row, 'description'),
    storageMode: asString(row, 'storage_mode') as StorageMode,
    graphEnabled: asNumber(row, 'graph_enabled') === 1,
    graphStrategy: asString(row, 'graph_strategy') as GraphStrategy,
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
    createdAt: asString(row, 'created_at')
  }
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
    createdAt: asString(row, 'created_at')
  }
}

export class KnowledgeDatabase {
  private database?: DatabaseSync

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
    } catch (error) {
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
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        name,
        description ?? null,
        storageMode,
        input.graphEnabled === false ? 0 : 1,
        graphStrategy,
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
    this.requireDatabase()
      .prepare(
        `UPDATE knowledge_bases
         SET name = ?, description = ?, storage_mode = ?, graph_enabled = ?,
             graph_strategy = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        name,
        description ?? null,
        storageMode,
        graphEnabled ? 1 : 0,
        graphStrategy,
        new Date().toISOString(),
        current.id
      )
    return this.requiredKnowledgeBase(current.id)
  }

  deleteKnowledgeBase(id: string): boolean {
    const normalizedId = requiredString(id, 'id', MAX_ID_LENGTH)
    return (
      this.requireDatabase()
        .prepare('DELETE FROM knowledge_bases WHERE id = ?')
        .run(normalizedId).changes > 0
    )
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
      database.prepare('DELETE FROM chunks WHERE document_id = ?').run(id)
      const insertChunk = database.prepare(
        `INSERT INTO chunks
          (id, knowledge_base_id, document_id, ordinal, content, token_count,
           heading, location, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const chunk of normalizedChunks) {
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
          now
        )
      }
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

  listChunks(documentId: string, limit = MAX_LIST_LIMIT): Chunk[] {
    const normalizedId = requiredString(
      documentId,
      'documentId',
      MAX_ID_LENGTH
    )
    boundedInteger(limit, 'limit', 1, MAX_LIST_LIMIT)
    return this.requireDatabase()
      .prepare(
        `SELECT * FROM chunks WHERE document_id = ?
         ORDER BY ordinal ASC LIMIT ?`
      )
      .all(normalizedId, limit)
      .map(mapChunk)
  }

  search(options: SearchOptions): SearchResult[] {
    const knowledgeBaseId = requiredString(
      options.knowledgeBaseId,
      'knowledgeBaseId',
      MAX_ID_LENGTH
    )
    const query = requiredString(options.query, 'query', 512)
    const limit = options.limit ?? 20
    boundedInteger(limit, 'limit', 1, 100)
    const literalQuery = query
      .split(/\s+/u)
      .map((term) => `"${term.replaceAll('"', '""')}"`)
      .join(' ')
    let rows = this.requireDatabase()
      .prepare(
        `SELECT
           c.*,
           snippet(chunks_fts, 0, '<mark>', '</mark>', ' … ', 24) AS snippet,
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
         ORDER BY rank ASC LIMIT ?`
      )
      .all(literalQuery, knowledgeBaseId, limit)

    if (rows.length === 0 && /\p{Script=Han}/u.test(query)) {
      const terms = [
        ...new Set(
          [...query].filter((character) => /\p{Script=Han}/u.test(character))
        )
      ].slice(0, 24)
      const conditions = terms.map(() => 'c.content LIKE ?').join(' AND ')
      rows = this.requireDatabase()
        .prepare(
          `SELECT
             c.*, substr(c.content, 1, 600) AS snippet, 100 AS rank,
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
           FROM chunks c
           JOIN documents d ON d.id = c.document_id
           JOIN knowledge_sources s ON s.id = d.source_id
           WHERE c.knowledge_base_id = ? AND ${conditions}
           ORDER BY d.updated_at DESC, c.ordinal ASC LIMIT ?`
        )
        .all(
          knowledgeBaseId,
          ...terms.map((term) => `%${term}%`),
          limit
        )
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
    const type = requiredString(input.type, 'type', MAX_NAME_LENGTH)
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

  updateEntity(id: string, input: UpdateGraphEntityInput): GraphEntity {
    const current = this.requiredEntity(id)
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
        input.type === undefined
          ? current.type
          : requiredString(input.type, 'type', MAX_NAME_LENGTH),
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
    const type = requiredString(input.type, 'type', MAX_NAME_LENGTH)
    const label = optionalString(input.label, 'label', MAX_NAME_LENGTH)
    const properties = jsonObject(input.properties, 'properties')
    const now = new Date().toISOString()
    this.assertRelationEntities(
      database,
      knowledgeBaseId,
      sourceEntityId,
      targetEntityId
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
        input.type === undefined
          ? current.type
          : requiredString(input.type, 'type', MAX_NAME_LENGTH),
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
           quote, location, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        new Date().toISOString()
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
      if (currentVersion < 1) {
        this.migrateToVersion1(database)
        database
          .prepare(
            'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
          )
          .run(1, new Date().toISOString())
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

  private normalizeChunks(chunks: ReplaceChunkInput[]): Array<{
    id: string
    ordinal: number
    content: string
    tokenCount?: number
    heading?: string
    location?: string
    metadata: string
  }> {
    let totalContent = 0
    const ordinals = new Set<number>()
    const ids = new Set<string>()
    return chunks.map((chunk, index) => {
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
        metadata: jsonObject(chunk.metadata, `chunks[${index}].metadata`)
      }
    })
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
      !matches(
        database.prepare(
          'SELECT COUNT(*) AS count FROM chunks WHERE id = ? AND knowledge_base_id = ?'
        ),
        value.chunkId
      )
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

  private transaction(database: DatabaseSync, operation: () => void): void {
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
}
