import { randomBytes } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { KnowledgeSearchReference } from '../../shared/contracts'
import { stripKnowledgeHighlightTags } from '../../shared/knowledge-text'
import {
  knowledgeToolNames,
  knowledgeScopedDataToolCatalog,
  goodbuddyConfigReadToolNames,
  goodbuddyConfigWriteToolNames,
  magicNoteScopedDataToolCatalog,
  magicNoteReadToolNames,
  magicNoteWriteToolNames,
  maximumScopedToolCount,
  scopedDataToolByName,
  scopedReadToolNames,
  type GoodBuddyConfigToolName,
  type ScopedDataToolName
} from '../../shared/scoped-data-tools'
import type { KnowledgeService } from '../knowledge/knowledge-service'
import type {
  MagicNoteDetail,
  MagicNoteEntry,
  MagicNoteRichContent,
  MagicNoteSearchResult,
  MagicNoteSummary
} from '../../shared/magic-notes-contracts'
import {
  magicNotePlainText,
  validateMagicNoteRichContent
} from '../magic-notes/rich-content'
import type {
  GoodBuddyConfigApplyAuthorizer,
  GoodBuddyConfigService
} from '../goodbuddy-config-service'

const MAX_REQUEST_BODY_BYTES = 64 * 1024
const MAX_RESULT_BYTES = 128 * 1024
const DEFAULT_CAPABILITY_TTL_MS = 10 * 60_000
const MAX_CAPABILITY_TTL_MS = 15 * 60_000

export {
  knowledgeToolNames,
  magicNoteReadToolNames,
  magicNoteWriteToolNames,
  maximumScopedToolCount,
  scopedReadToolNames
}

const {
  knowledge_list: knowledgeListTool,
  knowledge_search: knowledgeSearchTool
} = knowledgeScopedDataToolCatalog
const {
  note_list: magicNoteListTool,
  note_get: magicNoteGetTool,
  note_search: magicNoteSearchTool,
  note_create: magicNoteCreateTool,
  note_update: magicNoteUpdateTool,
  note_entry_create: magicNoteEntryCreateTool,
  note_entry_update: magicNoteEntryUpdateTool,
  note_entry_delete: magicNoteEntryDeleteTool,
  note_delete: magicNoteDeleteTool
} = magicNoteScopedDataToolCatalog

export type MagicNotesDatabase = {
  listMagicNotes(): MagicNoteSummary[]
  getMagicNote(noteId: string): MagicNoteDetail
  getMagicNoteEntry(entryId: string): MagicNoteEntry
  searchMagicNotes(query: string, limit: number): MagicNoteSearchResult[]
  createMagicNote(input: {
    title: string
    content?: MagicNoteRichContent
  }): MagicNoteDetail
  updateMagicNote(input: {
    noteId: string
    title?: string
    pinned?: boolean
    expectedRevision: number
  }): MagicNoteDetail
  deleteMagicNote(noteId: string): void
  createMagicNoteEntry(input: {
    noteId: string
    content: MagicNoteRichContent
    plainText: string
  }): MagicNoteDetail
  updateMagicNoteEntry(input: {
    entryId: string
    content: MagicNoteRichContent
    plainText: string
    expectedRevision: number
  }): MagicNoteDetail
  deleteMagicNoteEntry(entryId: string): MagicNoteDetail
}

export type MagicNotesCapabilityAccess = 'none' | 'read' | 'write'

export type MagicNoteToolSummary = {
  id: string
  title: string
  preview: string
  entryCount: number
  pinned: boolean
  revision: number
  createdAt: string
  updatedAt: string
}

export type MagicNoteToolEntry = {
  id: string
  content: string
  revision: number
  createdAt: string
  updatedAt: string
}

export type MagicNoteToolDetail = MagicNoteToolSummary & {
  entries: MagicNoteToolEntry[]
  truncated: boolean
}

export type KnowledgeLibraryListItem = {
  id: string
  name: string
  description?: string
}

type Capability = {
  requestId: string
  libraryIds: readonly string[]
  magicNotesAccess: MagicNotesCapabilityAccess
  configAccess: MagicNotesCapabilityAccess
  configWorkspacePath?: string
  authorizeConfigApply?: GoodBuddyConfigApplyAuthorizer
  expiresAt: number
  signal: AbortSignal
  references: Map<string, KnowledgeSearchReference>
  removeAbortListener: () => void
}

export type KnowledgeMcpGatewayOptions = {
  capabilityTtlMs?: number
  maximumBodyBytes?: number
  now?: () => number
  magicNotesDatabase?: MagicNotesDatabase
  configService?: GoodBuddyConfigService
}

function toMagicNoteToolSummary(
  note: MagicNoteSummary
): MagicNoteToolSummary {
  return {
    id: note.id,
    title: note.title.slice(0, 100),
    preview: note.preview.slice(0, 500),
    entryCount: note.entryCount,
    pinned: note.pinned,
    revision: note.revision,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt
  }
}

function textContent(value: string): MagicNoteRichContent {
  return validateMagicNoteRichContent({
    version: 1,
    ops: [{ insert: value.endsWith('\n') ? value : `${value}\n` }]
  })
}

function referenceKey(reference: KnowledgeSearchReference): string {
  return [
    reference.libraryId,
    reference.documentId,
    reference.chunkId ?? '',
    reference.locator ?? '',
    reference.snippet
  ].join('\0')
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown
): void {
  if (response.headersSent) {
    response.end()
    return
  }
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  })
  response.end(body)
}

async function readBoundedJson(
  request: IncomingMessage,
  maximumBytes: number
): Promise<unknown> {
  const declaredLength = Number(request.headers['content-length'])
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maximumBytes
  ) {
    throw new RangeError('request body too large')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maximumBytes) {
      throw new RangeError('request body too large')
    }
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    throw new SyntaxError('invalid JSON', { cause: error })
  }
}

export class KnowledgeMcpGateway {
  private readonly capabilities = new Map<string, Capability>()
  private readonly now: () => number
  private readonly capabilityTtlMs: number
  private readonly maximumBodyBytes: number
  private readonly magicNotesDatabase?: MagicNotesDatabase
  private readonly configService?: GoodBuddyConfigService
  private server?: Server
  private endpoint?: string

  constructor(
    private readonly knowledgeService: KnowledgeService,
    options: KnowledgeMcpGatewayOptions = {}
  ) {
    const ttl = options.capabilityTtlMs ?? DEFAULT_CAPABILITY_TTL_MS
    if (
      !Number.isSafeInteger(ttl) ||
      ttl < 1 ||
      ttl > MAX_CAPABILITY_TTL_MS
    ) {
      throw new RangeError('Knowledge capability TTL is invalid')
    }
    this.capabilityTtlMs = ttl
    this.maximumBodyBytes =
      options.maximumBodyBytes ?? MAX_REQUEST_BODY_BYTES
    this.now = options.now ?? Date.now
    this.magicNotesDatabase = options.magicNotesDatabase
    this.configService = options.configService
  }

  async start(): Promise<void> {
    if (this.server) {
      return
    }
    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch(() => {
        sendJson(response, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        })
      })
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, '127.0.0.1')
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      throw new Error('Knowledge MCP gateway did not bind a TCP port')
    }
    this.server = server
    this.endpoint = `http://127.0.0.1:${address.port}/mcp`
  }

  getEndpoint(): string | undefined {
    return this.endpoint
  }

  grant(
    requestId: string,
    authorizedLibraryIds: readonly string[],
    signal: AbortSignal,
    magicNotesAccess: MagicNotesCapabilityAccess = 'none',
    config?: {
      access: MagicNotesCapabilityAccess
      workspacePath: string
      authorizeApply?: GoodBuddyConfigApplyAuthorizer
    }
  ): string | undefined {
    const effectiveMagicNotesAccess = this.magicNotesDatabase
      ? magicNotesAccess
      : 'none'
    const effectiveConfigAccess = this.configService
      ? config?.access ?? 'none'
      : 'none'
    if (
      authorizedLibraryIds.length === 0 &&
      effectiveMagicNotesAccess === 'none' &&
      effectiveConfigAccess === 'none'
    ) {
      return undefined
    }
    signal.throwIfAborted()
    const libraryIds = Object.freeze([...new Set(authorizedLibraryIds)])
    const token = randomBytes(32).toString('base64url')
    const abort = (): void => {
      this.revoke(token)
    }
    signal.addEventListener('abort', abort, { once: true })
    this.capabilities.set(token, {
      requestId,
      libraryIds,
      magicNotesAccess: effectiveMagicNotesAccess,
      configAccess: effectiveConfigAccess,
      ...(effectiveConfigAccess !== 'none'
        ? {
            configWorkspacePath: config?.workspacePath,
            authorizeConfigApply: config?.authorizeApply
          }
        : {}),
      expiresAt: this.now() + this.capabilityTtlMs,
      signal,
      references: new Map(),
      removeAbortListener: () =>
        signal.removeEventListener('abort', abort)
    })
    return token
  }

  revoke(token: string | undefined): void {
    if (!token) {
      return
    }
    const capability = this.capabilities.get(token)
    if (!capability) {
      return
    }
    capability.removeAbortListener()
    this.capabilities.delete(token)
    this.configService?.revokeRequest(capability.requestId)
  }

  drainReferences(
    token: string | undefined
  ): KnowledgeSearchReference[] {
    if (!token) {
      return []
    }
    const capability = this.capabilities.get(token)
    if (!capability) {
      return []
    }
    const references = [...capability.references.values()]
    capability.references.clear()
    return references
  }

  private getCapability(token: string): Capability {
    const capability = this.capabilities.get(token)
    if (
      !capability ||
      capability.signal.aborted ||
      capability.expiresAt <= this.now()
    ) {
      this.revoke(token)
      throw new Error('Knowledge capability is unavailable or expired')
    }
    return capability
  }

  async search(
    token: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<KnowledgeSearchReference[]> {
    const capability = this.getCapability(token)
    const { query, limit } = knowledgeSearchTool.inputSchema.parse(
      input
    )
    const effectiveSignal = signal
      ? AbortSignal.any([signal, capability.signal])
      : capability.signal
    effectiveSignal.throwIfAborted()
    const libraries = this.knowledgeService.database.listKnowledgeBases(500)
    const libraryNames = new Map(
      libraries.map((library) => [library.id, library.name])
    )
    const results = await this.knowledgeService.searchHybridMany(
      capability.libraryIds,
      query,
      limit,
      effectiveSignal
    )
    const references: KnowledgeSearchReference[] = []
    const seen = new Set<string>()
    for (const { knowledgeBaseId, result } of results.sort(
      (left, right) => left.result.rank - right.result.rank
    )) {
      if (references.length >= limit) {
        break
      }
      const reference: KnowledgeSearchReference = {
        libraryId: knowledgeBaseId,
        libraryName: libraryNames.get(knowledgeBaseId) ?? '知识库',
        documentId: result.document.id,
        chunkId: result.chunk.id,
        documentName: result.document.title.slice(0, 500),
        sourceName: result.source.displayName.slice(0, 500),
        locator: result.chunk.location?.slice(0, 1_000),
        snippet: stripKnowledgeHighlightTags(result.snippet).slice(0, 12_000),
        rank: result.rank,
        score: result.retrieval.score,
        lexicalRank: result.retrieval.lexicalRank,
        vectorRank: result.retrieval.vectorRank,
        graphRank: result.retrieval.graphRank,
        similarity: result.retrieval.similarity,
        retrievalChannels: result.retrieval.channels,
        evidenceIds: result.retrieval.evidenceIds?.slice(0, 100)
      }
      const key = referenceKey(reference)
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      const candidate = [...references, reference]
      if (
        Buffer.byteLength(JSON.stringify({ references: candidate })) >
        MAX_RESULT_BYTES
      ) {
        break
      }
      references.push(reference)
      capability.references.set(key, reference)
    }
    return references
  }

  listLibraries(
    token: string,
    input: unknown = {}
  ): KnowledgeLibraryListItem[] {
    const capability = this.getCapability(token)
    knowledgeListTool.inputSchema.parse(input)
    const librariesById = new Map(
      this.knowledgeService.database
        .listKnowledgeBases(500)
        .map((library) => [library.id, library])
    )
    const libraries: KnowledgeLibraryListItem[] = []
    for (const libraryId of capability.libraryIds) {
      const library = librariesById.get(libraryId)
      if (!library) {
        continue
      }
      const item: KnowledgeLibraryListItem = {
        id: library.id,
        name: library.name.slice(0, 500),
        ...(library.description
          ? { description: library.description.slice(0, 4_000) }
          : {})
      }
      const candidate = [...libraries, item]
      if (
        Buffer.byteLength(JSON.stringify({ libraries: candidate })) >
        MAX_RESULT_BYTES
      ) {
        break
      }
      libraries.push(item)
    }
    return libraries
  }

  getAvailableToolNames(token: string): ScopedDataToolName[] {
    const capability = this.getCapability(token)
    return [
      ...(capability.libraryIds.length > 0
        ? knowledgeToolNames
        : []),
      ...(capability.magicNotesAccess !== 'none'
        ? magicNoteReadToolNames
        : []),
      ...(capability.magicNotesAccess === 'write'
        ? magicNoteWriteToolNames
        : []),
      ...(capability.configAccess !== 'none'
        ? goodbuddyConfigReadToolNames
        : []),
      ...(capability.configAccess === 'write'
        ? goodbuddyConfigWriteToolNames
        : [])
    ]
  }

  private requireConfig(
    token: string,
    requiredAccess: Exclude<MagicNotesCapabilityAccess, 'none'>
  ): {
    capability: Capability
    service: GoodBuddyConfigService
    workspacePath: string
  } {
    const capability = this.getCapability(token)
    const allowed =
      capability.configAccess === 'write' ||
      (requiredAccess === 'read' && capability.configAccess === 'read')
    if (
      !allowed ||
      !this.configService ||
      !capability.configWorkspacePath
    ) {
      throw new Error('GoodBuddy configuration capability is unavailable')
    }
    return {
      capability,
      service: this.configService,
      workspacePath: capability.configWorkspacePath
    }
  }

  async callGoodBuddyConfigTool(
    token: string,
    name: GoodBuddyConfigToolName,
    input: unknown,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const requiredAccess =
      name === 'goodbuddy_config_apply' ? 'write' : 'read'
    const { capability, service, workspacePath } =
      this.requireConfig(token, requiredAccess)
    const effectiveSignal = signal
      ? AbortSignal.any([signal, capability.signal])
      : capability.signal
    effectiveSignal.throwIfAborted()
    switch (name) {
      case 'goodbuddy_config_capabilities':
        return { capabilities: service.getCapabilities(input) }
      case 'goodbuddy_config_get':
        return { config: await service.getSnapshot(input) }
      case 'goodbuddy_config_plan':
        return {
          plan: await service.plan(
            capability.requestId,
            workspacePath,
            input
          )
        }
      case 'goodbuddy_config_apply':
        return {
          result: await service.apply(
            capability.requestId,
            input,
            effectiveSignal,
            capability.authorizeConfigApply
          )
        }
    }
  }

  private requireMagicNotes(
    token: string,
    requiredAccess: Exclude<MagicNotesCapabilityAccess, 'none'>
  ): { capability: Capability; database: MagicNotesDatabase } {
    const capability = this.getCapability(token)
    const allowed =
      capability.magicNotesAccess === 'write' ||
      (requiredAccess === 'read' &&
        capability.magicNotesAccess === 'read')
    if (!allowed || !this.magicNotesDatabase) {
      throw new Error('Magic Notes capability is unavailable')
    }
    return { capability, database: this.magicNotesDatabase }
  }

  listMagicNotes(
    token: string,
    input: unknown = {}
  ): MagicNoteToolSummary[] {
    const { database } = this.requireMagicNotes(token, 'read')
    const { limit } = magicNoteListTool.inputSchema.parse(input)
    const notes: MagicNoteToolSummary[] = []
    for (const note of database.listMagicNotes().slice(0, limit)) {
      const item = toMagicNoteToolSummary(note)
      if (
        Buffer.byteLength(JSON.stringify({ notes: [...notes, item] })) >
        MAX_RESULT_BYTES
      ) {
        break
      }
      notes.push(item)
    }
    return notes
  }

  getMagicNote(token: string, input: unknown): MagicNoteToolDetail {
    const { database } = this.requireMagicNotes(token, 'read')
    const { noteId } = magicNoteGetTool.inputSchema.parse(input)
    const detail = database.getMagicNote(noteId)
    const result: MagicNoteToolDetail = {
      ...toMagicNoteToolSummary(detail),
      entries: [],
      truncated: false
    }
    for (const entry of detail.entries) {
      const item: MagicNoteToolEntry = {
        id: entry.id,
        content: entry.plainText.slice(0, 12_000),
        revision: entry.revision,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt
      }
      if (
        Buffer.byteLength(
          JSON.stringify({
            note: { ...result, entries: [...result.entries, item] }
          })
        ) > MAX_RESULT_BYTES
      ) {
        result.truncated = true
        break
      }
      result.entries.push(item)
    }
    if (result.entries.length < detail.entries.length) {
      result.truncated = true
    }
    return result
  }

  searchMagicNotes(
    token: string,
    input: unknown,
    signal?: AbortSignal
  ): MagicNoteSearchResult[] {
    const { capability, database } = this.requireMagicNotes(token, 'read')
    const { query, limit } = magicNoteSearchTool.inputSchema.parse(input)
    const effectiveSignal = signal
      ? AbortSignal.any([signal, capability.signal])
      : capability.signal
    effectiveSignal.throwIfAborted()
    const notes = database.searchMagicNotes(query, limit)
    const bounded: MagicNoteSearchResult[] = []
    for (const note of notes) {
      const candidate = [...bounded, note]
      if (
        Buffer.byteLength(JSON.stringify({ notes: candidate })) >
        MAX_RESULT_BYTES
      ) {
        break
      }
      bounded.push(note)
    }
    return bounded
  }

  createMagicNote(token: string, input: unknown): MagicNoteToolDetail {
    const { database } = this.requireMagicNotes(token, 'write')
    const parsed = magicNoteCreateTool.inputSchema.parse(input)
    const content =
      typeof parsed.content === 'string'
        ? textContent(parsed.content)
        : undefined
    return this.getMagicNote(
      token,
      {
        noteId: database.createMagicNote({
          title: parsed.title,
          ...(content ? { content } : {})
        }).id
      }
    )
  }

  updateMagicNote(token: string, input: unknown): MagicNoteToolDetail {
    const { database } = this.requireMagicNotes(token, 'write')
    const parsed = magicNoteUpdateTool.inputSchema.parse(input)
    database.updateMagicNote(parsed)
    return this.getMagicNote(token, { noteId: parsed.noteId })
  }

  createMagicNoteEntry(
    token: string,
    input: unknown
  ): MagicNoteToolDetail {
    const { database } = this.requireMagicNotes(token, 'write')
    const parsed = magicNoteEntryCreateTool.inputSchema.parse(input)
    const content = textContent(parsed.content)
    database.createMagicNoteEntry({
      noteId: parsed.noteId,
      content,
      plainText: magicNotePlainText(content)
    })
    return this.getMagicNote(token, { noteId: parsed.noteId })
  }

  updateMagicNoteEntry(
    token: string,
    input: unknown
  ): MagicNoteToolDetail {
    const { database } = this.requireMagicNotes(token, 'write')
    const parsed = magicNoteEntryUpdateTool.inputSchema.parse(input)
    const content = textContent(parsed.content)
    const detail = database.updateMagicNoteEntry({
      entryId: parsed.entryId,
      content,
      plainText: magicNotePlainText(content),
      expectedRevision: parsed.expectedRevision
    })
    return this.getMagicNote(token, { noteId: detail.id })
  }

  deleteMagicNoteEntry(
    token: string,
    input: unknown
  ): MagicNoteToolDetail {
    const { database } = this.requireMagicNotes(token, 'write')
    const parsed = magicNoteEntryDeleteTool.inputSchema.parse(input)
    const entry = database.getMagicNoteEntry(parsed.entryId)
    if (entry.revision !== parsed.expectedRevision) {
      throw new Error('记录已被更新，请重新读取后重试')
    }
    const detail = database.deleteMagicNoteEntry(parsed.entryId)
    return this.getMagicNote(token, { noteId: detail.id })
  }

  deleteMagicNote(
    token: string,
    input: unknown
  ): { deleted: true; noteId: string } {
    const { database } = this.requireMagicNotes(token, 'write')
    const parsed = magicNoteDeleteTool.inputSchema.parse(input)
    const note = database.getMagicNote(parsed.noteId)
    if (note.revision !== parsed.expectedRevision) {
      throw new Error('笔记已被更新，请重新读取后重试')
    }
    database.deleteMagicNote(parsed.noteId)
    return { deleted: true, noteId: parsed.noteId }
  }

  private async callScopedTool(
    token: string,
    name: ScopedDataToolName,
    input: unknown
  ): Promise<Record<string, unknown>> {
    switch (name) {
      case 'knowledge_list':
        return { libraries: this.listLibraries(token, input) }
      case 'knowledge_search':
        return { references: await this.search(token, input) }
      case 'note_list':
        return { notes: this.listMagicNotes(token, input) }
      case 'note_get':
        return { note: this.getMagicNote(token, input) }
      case 'note_search':
        return { notes: this.searchMagicNotes(token, input) }
      case 'note_create':
        return { note: this.createMagicNote(token, input) }
      case 'note_update':
        return { note: this.updateMagicNote(token, input) }
      case 'note_entry_create':
        return { note: this.createMagicNoteEntry(token, input) }
      case 'note_entry_update':
        return { note: this.updateMagicNoteEntry(token, input) }
      case 'note_entry_delete':
        return { note: this.deleteMagicNoteEntry(token, input) }
      case 'note_delete':
        return this.deleteMagicNote(token, input)
      case 'goodbuddy_config_capabilities':
      case 'goodbuddy_config_get':
      case 'goodbuddy_config_plan':
      case 'goodbuddy_config_apply':
        return this.callGoodBuddyConfigTool(token, name, input)
    }
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (request.url !== '/mcp') {
      sendJson(response, 404, { error: 'Not found' })
      return
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST')
      sendJson(response, 405, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed' },
        id: null
      })
      return
    }
    const authorization = request.headers.authorization
    if (
      typeof authorization !== 'string' ||
      !authorization.startsWith('Bearer ')
    ) {
      sendJson(response, 401, { error: 'Unauthorized' })
      return
    }
    const token = authorization.slice('Bearer '.length)
    try {
      this.getCapability(token)
    } catch {
      sendJson(response, 401, { error: 'Unauthorized' })
      return
    }

    let body: unknown
    try {
      body = await readBoundedJson(request, this.maximumBodyBytes)
    } catch (error) {
      sendJson(response, error instanceof RangeError ? 413 : 400, {
        error:
          error instanceof RangeError
            ? 'Request body too large'
            : 'Invalid JSON'
      })
      return
    }

    const mcp = new McpServer({
      name: 'goodbuddy-scoped-knowledge',
      version: '1.0.0'
    })
    const availableTools = this.getAvailableToolNames(token)
    for (const name of availableTools) {
      const definition = scopedDataToolByName.get(name)
      if (!definition) {
        continue
      }
      mcp.registerTool(
        name,
        {
          title: definition.title,
          description: definition.description,
          inputSchema: definition.inputSchema,
          annotations: {
            readOnlyHint: definition.access === 'read',
            destructiveHint:
              name === 'goodbuddy_config_apply' ||
              name === 'note_delete' ||
              name === 'note_entry_delete'
          }
        },
        async (input: Record<string, unknown>) => ({
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(await this.callScopedTool(token, name, input))
            }
          ]
        })
      )
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    })
    const close = (): void => {
      void Promise.allSettled([transport.close(), mcp.close()])
    }
    response.once('close', close)
    try {
      await mcp.connect(transport)
      await transport.handleRequest(request, response, body)
    } finally {
      if (response.writableFinished) {
        response.off('close', close)
        close()
      }
    }
  }

  async dispose(): Promise<void> {
    for (const token of [...this.capabilities.keys()]) {
      this.revoke(token)
    }
    const server = this.server
    this.server = undefined
    this.endpoint = undefined
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
