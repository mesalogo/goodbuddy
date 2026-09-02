import { randomBytes } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server as McpProtocolServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
  type CallToolResult,
  type Tool
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
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
import {
  createMcpTransport
} from '../capabilities/mcp-client-transport'
import type {
  ResolvedMcpServer
} from '../capabilities/capability-service'
import {
  createMcpToolName,
  isValidMcpToolName,
  listAllMcpTools,
  normalizeMcpToolSchema
} from './mcp-tool-utils'
import type { LaunchEnvironmentProvider } from '../local-tool-environment'

const MAX_REQUEST_BODY_BYTES = 64 * 1024
const MAX_RESULT_BYTES = 128 * 1024
const MAX_CUSTOM_MCP_RESULT_BYTES = 256 * 1024
const MAX_CUSTOM_MCP_SERVERS = 16
const MAX_CUSTOM_MCP_TOOLS = 100
const MAX_DOWNSTREAM_MCP_SESSIONS_PER_CAPABILITY = 8
const CUSTOM_MCP_TIMEOUT_MS = 30_000
const CUSTOM_MCP_MAX_TOTAL_TIMEOUT_MS = 5 * 60_000
const CUSTOM_MCP_TASK_CANCEL_TIMEOUT_MS = 5_000
const DEFAULT_CAPABILITY_TTL_MS = 10 * 60_000
const MAX_CAPABILITY_TTL_MS = 15 * 60_000
const customMcpJsonSchemaValidator = new AjvJsonSchemaValidator()

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
  brokerController: AbortController
  customMcpServers: readonly ResolvedMcpServer[]
  customMcpConnections?: Promise<CustomMcpConnection[]>
  references: Map<string, KnowledgeSearchReference>
  removeAbortListener: () => void
}

type CustomMcpBinding = {
  client: Client
  server: ResolvedMcpServer
  originalName: string
  exposedTool: Tool
  taskSupport?: 'forbidden' | 'optional' | 'required'
  outputValidator?: JsonSchemaValidator<Record<string, unknown>>
}

type CustomMcpConnection = {
  client: Client
  server: ResolvedMcpServer
  bindings: CustomMcpBinding[]
  dynamicToolsSupported: boolean
  dynamicToolsChanged: boolean
  dynamicToolsChangeVersion: number
  dynamicToolsRefresh?: Promise<void>
}

type DownstreamMcpSession = {
  id?: string
  registryKey: string
  token: string
  mcp: McpProtocolServer
  transport: StreamableHTTPServerTransport
  initialized: boolean
  listedTools: boolean
  closing?: Promise<void>
}

export type KnowledgeMcpGatewayOptions = {
  capabilityTtlMs?: number
  maximumBodyBytes?: number
  now?: () => number
  magicNotesDatabase?: MagicNotesDatabase
  configService?: GoodBuddyConfigService
  launchEnvironmentProvider?: LaunchEnvironmentProvider
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

function ensureBoundedCustomMcpResult(result: unknown): CallToolResult {
  const normalized =
    result &&
    typeof result === 'object' &&
    'toolResult' in result
      ? {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                (result as { toolResult: unknown }).toolResult
              )
            }
          ]
        }
      : result
  const parsed = CallToolResultSchema.parse(normalized)
  let serialized: string
  try {
    serialized = JSON.stringify(parsed)
  } catch (error) {
    throw new Error('MCP 工具结果无法序列化', { cause: error })
  }
  if (
    !serialized ||
    Buffer.byteLength(serialized) > MAX_CUSTOM_MCP_RESULT_BYTES
  ) {
    throw new Error('MCP 工具结果超过 256KB 安全限制')
  }
  return parsed
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
  private readonly downstreamMcpSessions = new Map<
    string,
    DownstreamMcpSession
  >()
  private readonly downstreamMcpCleanups = new Set<Promise<void>>()
  private readonly customMcpCleanups = new Set<Promise<void>>()
  private readonly now: () => number
  private readonly capabilityTtlMs: number
  private readonly maximumBodyBytes: number
  private readonly magicNotesDatabase?: MagicNotesDatabase
  private readonly configService?: GoodBuddyConfigService
  private readonly launchEnvironmentProvider?: LaunchEnvironmentProvider
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
    this.launchEnvironmentProvider = options.launchEnvironmentProvider
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
    return this.storeCapability({
      requestId,
      libraryIds: Object.freeze([...new Set(authorizedLibraryIds)]),
      magicNotesAccess: effectiveMagicNotesAccess,
      configAccess: effectiveConfigAccess,
      ...(effectiveConfigAccess !== 'none'
        ? {
            configWorkspacePath: config?.workspacePath,
            authorizeConfigApply: config?.authorizeApply
          }
        : {}),
      signal,
      customMcpServers: []
    })
  }

  grantCustomMcp(
    requestId: string,
    servers: readonly ResolvedMcpServer[],
    signal: AbortSignal
  ): string | undefined {
    if (servers.length === 0) {
      return undefined
    }
    if (servers.length > MAX_CUSTOM_MCP_SERVERS) {
      throw new Error(
        `Agent Runtime 最多可加载 ${MAX_CUSTOM_MCP_SERVERS} 个 MCP Server`
      )
    }
    if (
      servers.some(
        (server) =>
          !server.enabled ||
          server.assignments.length === 0
      )
    ) {
      throw new Error('Agent Runtime MCP 授权包含无效 Server')
    }
    return this.storeCapability({
      requestId,
      libraryIds: [],
      magicNotesAccess: 'none',
      configAccess: 'none',
      signal,
      customMcpServers: Object.freeze([...servers])
    })
  }

  private storeCapability(
    value: Omit<
      Capability,
      | 'expiresAt'
      | 'references'
      | 'removeAbortListener'
      | 'brokerController'
      | 'customMcpConnections'
    >
  ): string {
    value.signal.throwIfAborted()
    const token = randomBytes(32).toString('base64url')
    const brokerController = new AbortController()
    const abort = (): void => {
      this.revoke(token)
    }
    value.signal.addEventListener('abort', abort, { once: true })
    this.capabilities.set(token, {
      ...value,
      expiresAt: this.now() + this.capabilityTtlMs,
      brokerController,
      references: new Map(),
      removeAbortListener: () =>
        value.signal.removeEventListener('abort', abort)
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
    capability.brokerController.abort(
      new Error('MCP capability was revoked')
    )
    for (const session of this.downstreamMcpSessions.values()) {
      if (session.token === token) {
        void this.closeDownstreamMcpSession(session)
      }
    }
    if (capability.configAccess !== 'none') {
      this.configService?.revokeRequest(capability.requestId)
    }
    const cleanup = this.closeCustomMcpConnections(capability)
    this.customMcpCleanups.add(cleanup)
    void cleanup.finally(() => {
      this.customMcpCleanups.delete(cleanup)
    })
  }

  private closeDownstreamMcpSession(
    session: DownstreamMcpSession
  ): Promise<void> {
    if (session.closing) {
      return session.closing
    }
    this.downstreamMcpSessions.delete(session.registryKey)
    const cleanup = session.mcp
      .close()
      .catch(() => undefined)
      .finally(() => {
        this.downstreamMcpCleanups.delete(cleanup)
      })
    session.closing = cleanup
    this.downstreamMcpCleanups.add(cleanup)
    return cleanup
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

  private createCustomMcpBindings(
    client: Client,
    server: ResolvedMcpServer,
    tools: Awaited<ReturnType<Client['listTools']>>['tools']
  ): CustomMcpBinding[] {
    if (tools.length > MAX_CUSTOM_MCP_TOOLS) {
      throw new Error(
        `MCP Server「${server.name}」提供的工具数量超过安全限制`
      )
    }
    return tools.map((tool) => {
      if (!isValidMcpToolName(tool.name)) {
        throw new Error(
          `MCP Server「${server.name}」返回了无效工具名称`
        )
      }
      return {
        client,
        server,
        originalName: tool.name,
        taskSupport: tool.execution?.taskSupport,
        outputValidator: tool.outputSchema
          ? customMcpJsonSchemaValidator.getValidator<
              Record<string, unknown>
            >(normalizeMcpToolSchema(tool.outputSchema))
          : undefined,
        exposedTool: {
          name: createMcpToolName(server.id, tool.name),
          title: `${server.name} / ${tool.name}`.slice(0, 200),
          description: [
            `GoodBuddy 代理的自定义 MCP Server「${server.name}」工具。`,
            tool.description
          ]
            .filter(Boolean)
            .join(' ')
            .slice(0, 1_000),
          inputSchema: normalizeMcpToolSchema(tool.inputSchema),
          annotations: tool.annotations
        }
      }
    })
  }

  private async listAllCustomMcpTools(
    client: Client,
    server: ResolvedMcpServer,
    signal: AbortSignal
  ): Promise<Awaited<ReturnType<Client['listTools']>>['tools']> {
    return listAllMcpTools(client, server.name, signal, {
      maximumTools: MAX_CUSTOM_MCP_TOOLS,
      pageTimeoutMs: CUSTOM_MCP_TIMEOUT_MS,
      totalTimeoutMs: CUSTOM_MCP_MAX_TOTAL_TIMEOUT_MS
    })
  }

  private async publishCustomMcpToolListChanged(
    capability: Capability
  ): Promise<void> {
    const token = [...this.capabilities.entries()].find(
      ([, value]) => value === capability
    )?.[0]
    if (!token) {
      return
    }
    const sessions = [...this.downstreamMcpSessions.values()].filter(
      (session) =>
        session.token === token &&
        session.initialized &&
        session.listedTools
    )
    await Promise.allSettled(
      sessions.map((session) => session.mcp.sendToolListChanged())
    )
  }

  private scheduleDynamicToolsRefresh(
    capability: Capability,
    connection: CustomMcpConnection
  ): void {
    void this.refreshDynamicTools(capability, connection).catch(
      () => undefined
    )
  }

  private refreshDynamicTools(
    capability: Capability,
    connection: CustomMcpConnection,
    signal?: AbortSignal
  ): Promise<void> {
    if (connection.dynamicToolsRefresh) {
      return connection.dynamicToolsRefresh
    }
    const effectiveSignal = signal
      ? AbortSignal.any([
          signal,
          capability.signal,
          capability.brokerController.signal
        ])
      : AbortSignal.any([
          capability.signal,
          capability.brokerController.signal
        ])
    const changeVersion = connection.dynamicToolsChangeVersion
    let refreshSucceeded = false
    const refresh = (async () => {
      try {
        const tools = await this.listAllCustomMcpTools(
          connection.client,
          connection.server,
          effectiveSignal
        )
        const bindings = this.createCustomMcpBindings(
          connection.client,
          connection.server,
          tools
        )
        connection.bindings = bindings
        connection.dynamicToolsChanged =
          connection.dynamicToolsChangeVersion !== changeVersion
        refreshSucceeded = true
        await this.publishCustomMcpToolListChanged(capability)
      } catch (error) {
        connection.dynamicToolsChanged = true
        if (effectiveSignal.aborted) {
          throw effectiveSignal.reason
        }
        throw new Error(
          `无法刷新 MCP Server「${connection.server.name}」的工具`,
          { cause: error }
        )
      }
    })()
    connection.dynamicToolsRefresh = refresh
    void refresh.finally(() => {
      connection.dynamicToolsRefresh = undefined
      if (
        refreshSucceeded &&
        connection.dynamicToolsChanged &&
        !capability.signal.aborted &&
        !capability.brokerController.signal.aborted
      ) {
        this.scheduleDynamicToolsRefresh(capability, connection)
      }
    }).catch(() => undefined)
    return refresh
  }

  private async connectCustomMcpServer(
    capability: Capability,
    server: ResolvedMcpServer
  ): Promise<CustomMcpConnection> {
    let connection: CustomMcpConnection | undefined
    let dynamicToolsChangeVersion = 0
    const client = new Client(
      {
        name: 'goodbuddy-main-mcp-broker',
        version: '1.0.0'
      },
      server.allowDynamicTools
        ? {
            listChanged: {
              tools: {
                autoRefresh: false,
                debounceMs: 0,
                onChanged: (error) => {
                  if (!error) {
                    dynamicToolsChangeVersion += 1
                    if (connection) {
                      connection.dynamicToolsChangeVersion =
                        dynamicToolsChangeVersion
                      connection.dynamicToolsChanged = true
                      this.scheduleDynamicToolsRefresh(
                        capability,
                        connection
                      )
                    }
                  }
                }
              }
            }
          }
        : undefined
    )
    const signal = AbortSignal.any([
      capability.signal,
      capability.brokerController.signal
    ])
    try {
      await client.connect(
        createMcpTransport(server, this.launchEnvironmentProvider),
        {
        timeout: CUSTOM_MCP_TIMEOUT_MS,
        signal
        }
      )
      const listedAtChangeVersion = dynamicToolsChangeVersion
      const tools = await this.listAllCustomMcpTools(
        client,
        server,
        signal
      )
      connection = {
        client,
        server,
        bindings: this.createCustomMcpBindings(
          client,
          server,
          tools
        ),
        dynamicToolsSupported:
          server.allowDynamicTools &&
          client.getServerCapabilities()?.tools?.listChanged === true,
        dynamicToolsChanged:
          dynamicToolsChangeVersion !== listedAtChangeVersion,
        dynamicToolsChangeVersion
      }
      if (connection.dynamicToolsChanged) {
        this.scheduleDynamicToolsRefresh(capability, connection)
      }
      return connection
    } catch (error) {
      await client.close().catch(() => undefined)
      throw new Error(
        `无法加载 MCP Server「${server.name}」的工具`,
        { cause: error }
      )
    }
  }

  private async getCustomMcpBindings(
    token: string,
    signal?: AbortSignal,
    refreshDynamic = true
  ): Promise<Map<string, CustomMcpBinding>> {
    const capability = this.getCapability(token)
    if (capability.customMcpServers.length === 0) {
      return new Map()
    }
    if (!capability.customMcpConnections) {
      capability.customMcpConnections = (async () => {
        const results = await Promise.allSettled(
          capability.customMcpServers.map((server) =>
            this.connectCustomMcpServer(capability, server)
          )
        )
        const connections = results.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : []
        )
        const failure = results.find(
          (result) => result.status === 'rejected'
        )
        if (failure?.status === 'rejected') {
          await Promise.allSettled(
            connections.map((connection) => connection.client.close())
          )
          throw failure.reason
        }
        return connections
      })()
    }
    let connections: CustomMcpConnection[]
    try {
      connections = await capability.customMcpConnections
    } catch (error) {
      capability.customMcpConnections = undefined
      throw error
    }
    if (refreshDynamic) {
      for (const connection of connections) {
        if (
          !connection.dynamicToolsSupported ||
          (!connection.dynamicToolsChanged &&
            !connection.dynamicToolsRefresh)
        ) {
          continue
        }
        await this.refreshDynamicTools(
          capability,
          connection,
          signal
        )
      }
    }
    const bindings = new Map<string, CustomMcpBinding>()
    for (const connection of connections) {
      for (const binding of connection.bindings) {
        if (bindings.size >= MAX_CUSTOM_MCP_TOOLS) {
          throw new Error('Agent Runtime MCP 工具总数超过 100 个安全限制')
        }
        if (bindings.has(binding.exposedTool.name)) {
          throw new Error('Agent Runtime MCP 工具名称发生冲突')
        }
        bindings.set(binding.exposedTool.name, binding)
      }
    }
    return bindings
  }

  async prepareCustomMcpTools(
    token: string,
    signal?: AbortSignal
  ): Promise<Tool[]> {
    return [
      ...(await this.getCustomMcpBindings(token, signal)).values()
    ].map((binding) => binding.exposedTool)
  }

  private async callCustomMcpTool(
    token: string,
    binding: CustomMcpBinding,
    argumentsValue: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<CallToolResult> {
    const capability = this.getCapability(token)
    const effectiveSignal = AbortSignal.any([
      signal,
      capability.signal,
      capability.brokerController.signal
    ])
    const params = {
      name: binding.originalName,
      arguments: argumentsValue
    }
    const options = {
      timeout: CUSTOM_MCP_TIMEOUT_MS,
      signal: effectiveSignal,
      onprogress: () => undefined,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: CUSTOM_MCP_MAX_TOTAL_TIMEOUT_MS
    }
    try {
      if (binding.taskSupport !== 'required') {
        return this.validateCustomMcpResult(
          binding,
          await binding.client.callTool(params, undefined, options)
        )
      }
      let taskId: string | undefined
      try {
        for await (const message of binding.client.experimental.tasks.callToolStream(
          params,
          undefined,
          {
            ...options,
            task: {}
          }
        )) {
          if (
            (message.type === 'taskCreated' ||
              message.type === 'taskStatus') &&
            typeof message.task.taskId === 'string'
          ) {
            taskId = message.task.taskId
          } else if (message.type === 'result') {
            return this.validateCustomMcpResult(
              binding,
              message.result
            )
          } else if (message.type === 'error') {
            throw message.error
          }
        }
        throw new Error('MCP 任务工具未返回最终结果')
      } catch (error) {
        if (taskId) {
          await binding.client.experimental.tasks
            .cancelTask(taskId, {
              timeout: CUSTOM_MCP_TASK_CANCEL_TIMEOUT_MS,
              maxTotalTimeout: CUSTOM_MCP_TASK_CANCEL_TIMEOUT_MS
            })
            .catch(() => undefined)
        }
        throw error
      }
    } catch (error) {
      if (effectiveSignal.aborted) {
        throw effectiveSignal.reason
      }
      throw new Error(
        `MCP Server「${binding.server.name}」工具调用失败`,
        { cause: error }
      )
    }
  }

  private validateCustomMcpResult(
    binding: CustomMcpBinding,
    result: unknown
  ): CallToolResult {
    const bounded = ensureBoundedCustomMcpResult(result)
    if (!binding.outputValidator) {
      return bounded
    }
    if (!bounded.structuredContent) {
      if (!bounded.isError) {
        throw new Error(
          `MCP 工具「${binding.originalName}」未返回结构化结果`
        )
      }
      return bounded
    }
    const validation = binding.outputValidator(
      bounded.structuredContent
    )
    if (!validation.valid) {
      throw new Error(
        `MCP 工具「${binding.originalName}」返回结果不符合声明结构：${validation.errorMessage.slice(0, 500)}`
      )
    }
    return bounded
  }

  private async closeCustomMcpConnections(
    capability: Capability
  ): Promise<void> {
    const pending = capability.customMcpConnections
    capability.customMcpConnections = undefined
    if (!pending) {
      return
    }
    const connections = await pending.catch(() => [])
    await Promise.allSettled(
      connections.map((connection) => connection.client.close())
    )
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

  private createDownstreamMcpSession(
    token: string,
    availableScopedTools: ReadonlySet<ScopedDataToolName>
  ): DownstreamMcpSession {
    const mcp = new McpProtocolServer(
      {
        name: 'goodbuddy-request-scoped-capabilities',
        version: '1.0.0'
      },
      {
        capabilities: {
          tools: {
            listChanged: true
          }
        }
      }
    )
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomBytes(32).toString('base64url'),
      onsessioninitialized: (sessionId) => {
        this.downstreamMcpSessions.delete(session.registryKey)
        session.id = sessionId
        session.registryKey = sessionId
        this.downstreamMcpSessions.set(sessionId, session)
      },
      onsessionclosed: (sessionId) => {
        this.downstreamMcpSessions.delete(sessionId)
      }
    })
    const session: DownstreamMcpSession = {
      registryKey: randomBytes(32).toString('base64url'),
      token,
      mcp,
      transport,
      initialized: false,
      listedTools: false
    }
    transport.onclose = () => {
      this.downstreamMcpSessions.delete(session.registryKey)
    }
    mcp.oninitialized = () => {
      session.initialized = true
    }
    mcp.setRequestHandler(
      ListToolsRequestSchema,
      async (_request, extra) => {
        const customBindings = await this.getCustomMcpBindings(
          token,
          extra.signal
        )
        const scopedTools = [...availableScopedTools].flatMap(
          (name): Tool[] => {
            const definition = scopedDataToolByName.get(name)
            if (!definition) {
              return []
            }
            const inputSchema = z.toJSONSchema(
              definition.inputSchema,
              { target: 'draft-7' }
            ) as Tool['inputSchema'] & { $schema?: string }
            Reflect.deleteProperty(inputSchema, '$schema')
            return [
              {
                name,
                title: definition.title,
                description: definition.description,
                inputSchema,
                annotations: {
                  readOnlyHint: definition.access === 'read',
                  destructiveHint:
                    name === 'goodbuddy_config_apply' ||
                    name === 'note_delete' ||
                    name === 'note_entry_delete'
                }
              }
            ]
          }
        )
        session.listedTools = true
        return {
          tools: [
            ...scopedTools,
            ...[...customBindings.values()].map(
              (binding) => binding.exposedTool
            )
          ]
        }
      }
    )
    mcp.setRequestHandler(
      CallToolRequestSchema,
      async (call, extra) => {
        const name = call.params.name
        const input = call.params.arguments ?? {}
        if (availableScopedTools.has(name as ScopedDataToolName)) {
          const definition = scopedDataToolByName.get(
            name as ScopedDataToolName
          )
          if (!definition) {
            throw new Error('GoodBuddy 工具不存在')
          }
          const parsedInput = definition.inputSchema.parse(input)
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  await this.callScopedTool(
                    token,
                    name as ScopedDataToolName,
                    parsedInput
                  )
                )
              }
            ]
          }
        }
        const binding = (
          await this.getCustomMcpBindings(token, extra.signal)
        ).get(name)
        if (!binding) {
          throw new Error('GoodBuddy MCP 工具不存在或已失效')
        }
        return this.callCustomMcpTool(
          token,
          binding,
          input,
          extra.signal
        )
      }
    )
    return session
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (request.url !== '/mcp') {
      sendJson(response, 404, { error: 'Not found' })
      return
    }
    if (
      request.method !== 'POST' &&
      request.method !== 'GET' &&
      request.method !== 'DELETE'
    ) {
      response.setHeader('allow', 'POST, GET, DELETE')
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
    if (request.method === 'POST') {
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
    }

    const sessionId = request.headers['mcp-session-id']
    let createdSession = false
    let session =
      typeof sessionId === 'string'
        ? this.downstreamMcpSessions.get(sessionId)
        : undefined
    if (session && session.token !== token) {
      session = undefined
    }
    if (!session) {
      if (
        request.method !== 'POST' ||
        !isInitializeRequest(body) ||
        typeof sessionId === 'string'
      ) {
        sendJson(response, typeof sessionId === 'string' ? 404 : 400, {
          jsonrpc: '2.0',
          error: {
            code:
              typeof sessionId === 'string' ? -32001 : -32000,
            message:
              typeof sessionId === 'string'
                ? 'Session not found'
                : 'Bad Request: No valid session ID provided'
          },
          id: null
        })
        return
      }
      const sessionCount = [
        ...this.downstreamMcpSessions.values()
      ].filter((candidate) => candidate.token === token).length
      if (
        sessionCount >=
        MAX_DOWNSTREAM_MCP_SESSIONS_PER_CAPABILITY
      ) {
        sendJson(response, 429, {
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Too many MCP sessions'
          },
          id: null
        })
        return
      }
      const availableScopedTools = new Set(
        this.getAvailableToolNames(token)
      )
      session = this.createDownstreamMcpSession(
        token,
        availableScopedTools
      )
      createdSession = true
      this.downstreamMcpSessions.set(session.registryKey, session)
      await session.mcp.connect(session.transport)
    }
    try {
      await session.transport.handleRequest(request, response, body)
    } finally {
      if (createdSession && session.id === undefined) {
        await this.closeDownstreamMcpSession(session)
      }
    }
  }

  async dispose(): Promise<void> {
    for (const token of [...this.capabilities.keys()]) {
      this.revoke(token)
    }
    await Promise.allSettled([...this.downstreamMcpCleanups])
    await Promise.allSettled([...this.customMcpCleanups])
    const server = this.server
    this.server = undefined
    this.endpoint = undefined
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
