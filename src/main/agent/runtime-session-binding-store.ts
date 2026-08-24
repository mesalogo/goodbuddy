import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import {
  runtimeSessionBindingSchema,
  type RuntimeSessionBinding
} from '../../shared/remote-agent-contracts'
import { openPrivateSqliteDatabase } from './private-sqlite-database'

export type RuntimeSessionBindingListOptions = {
  limit?: number
  afterBindingId?: string
}

export type RuntimeSessionBindingStoreOptions = {
  maximumRows?: number
}

export type RuntimeSessionTransportIdentity = Pick<
  RuntimeSessionBinding,
  'controllerGeneration' | 'daemonBootIdAtOpen' | 'channelEpoch'
>

const defaultMaximumRows = 10_000
const maximumPageSize = 1_000
const maximumPruneBatch = 1_000

function boundedPositiveInteger(
  value: number,
  maximum: number,
  name: string
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be between 1 and ${maximum}`)
  }
  return value
}

function resolveMaximumRows(options?: RuntimeSessionBindingStoreOptions): number {
  return boundedPositiveInteger(
    options?.maximumRows ?? defaultMaximumRows,
    1_000_000,
    'maximumRows'
  )
}

function resolveListOptions(
  options?: RuntimeSessionBindingListOptions
): Required<RuntimeSessionBindingListOptions> {
  return {
    limit: boundedPositiveInteger(
      options?.limit ?? maximumPageSize,
      maximumPageSize,
      'limit'
    ),
    afterBindingId: options?.afterBindingId ?? ''
  }
}

/**
 * Durable Main-side index for ACP session ownership. Implementations must make
 * each put atomic; callers never mutate an object returned by this interface.
 */
export interface RuntimeSessionBindingStore {
  getByConversation(
    conversationId: string
  ): Promise<RuntimeSessionBinding | undefined>
  getById(bindingId: string): Promise<RuntimeSessionBinding | undefined>
  /**
   * Atomically claims a Runtime-returned ACP session identity for this live
   * binding. A session identity cannot be shared by live bindings, even when
   * new/load/resume complete concurrently.
   */
  claimAcpSession(
    bindingId: string,
    acpSessionId: string
  ): Promise<RuntimeSessionBinding>
  /**
   * Atomically moves an idle durable ACP session onto a newly opened
   * transport epoch. Prompt identity and ACP session ownership remain fixed;
   * transport cursors restart at zero for the new epoch.
   */
  rotateReadyTransport(
    bindingId: string,
    expected: RuntimeSessionTransportIdentity,
    next: RuntimeSessionTransportIdentity
  ): Promise<RuntimeSessionBinding>
  put(binding: RuntimeSessionBinding): Promise<void>
  pruneClosed(limit?: number): Promise<number>
  listByController(
    controllerId: string,
    options?: RuntimeSessionBindingListOptions
  ): Promise<RuntimeSessionBinding[]>
}

export class RuntimeSessionClaimConflictError extends Error {
  readonly code = 'runtime-session-claim-conflict'

  constructor(readonly acpSessionId: string) {
    super('Runtime ACP session identity is already owned by another live binding')
    this.name = 'RuntimeSessionClaimConflictError'
  }
}

export class RuntimeSessionBindingConflictError extends Error {
  readonly code = 'runtime-session-binding-conflict'

  constructor(message: string) {
    super(message)
    this.name = 'RuntimeSessionBindingConflictError'
  }
}

export class RuntimeSessionBindingCorruptionError extends Error {
  readonly code = 'runtime-session-binding-corruption'

  constructor(readonly bindingId: string, options?: ErrorOptions) {
    super(`Persisted Runtime binding ${bindingId} is malformed`, options)
    this.name = 'RuntimeSessionBindingCorruptionError'
  }
}

const immutableBindingKeys = [
  'bindingId',
  'controllerId',
  'controllerGeneration',
  'conversationId',
  'hostId',
  'hostRevision',
  'hostKeyGeneration',
  'workspaceIdentity',
  'agentInstallationId',
  'daemonBootIdAtOpen',
  'runtimeId',
  'runtimeBundleDigest',
  'runtimeAdapterDigest',
  'modelBridgeVersion',
  'acpCapabilitiesDigest',
  'channelEpoch'
] as const

const monotonicCursorKeys = [
  'lastOutboundJournaledSequence',
  'lastOutboundDeliveredSequence',
  'lastInboundJournaledSequence',
  'lastMainAckSequence'
] as const

type RuntimeSessionBindingState = RuntimeSessionBinding['state']

const allowedStateTransitions: Readonly<
  Record<
    RuntimeSessionBindingState,
    ReadonlySet<RuntimeSessionBindingState>
  >
> = {
  opening: new Set([
    'opening',
    'ready',
    'prompt-running',
    'interrupted',
    'closed'
  ]),
  ready: new Set(['ready', 'prompt-running', 'interrupted', 'closed']),
  'prompt-running': new Set([
    'prompt-running',
    'ready',
    'outcome-unknown',
    'interrupted',
    'closed'
  ]),
  reconciling: new Set([
    'reconciling',
    'ready',
    'outcome-unknown',
    'interrupted',
    'closed'
  ]),
  'outcome-unknown': new Set([
    'outcome-unknown',
    'reconciling',
    'ready',
    'closed'
  ]),
  interrupted: new Set(['interrupted', 'closed']),
  closed: new Set(['closed'])
}

function assertBindingUpdateAllowed(
  previous: RuntimeSessionBinding,
  next: RuntimeSessionBinding
): void {
  for (const key of immutableBindingKeys) {
    if (previous[key] !== next[key]) {
      throw new RuntimeSessionBindingConflictError(
        `Runtime binding ${key} is immutable`
      )
    }
  }
  if (
    !isDeepStrictEqual(
      previous.modelBridgePolicy,
      next.modelBridgePolicy
    )
  ) {
    throw new RuntimeSessionBindingConflictError(
      'Runtime binding model bridge policy is immutable'
    )
  }
  if (previous.acpSessionId !== next.acpSessionId) {
    throw new RuntimeSessionBindingConflictError(
      'ACP session identity must be changed through atomic claim'
    )
  }
  for (const key of monotonicCursorKeys) {
    if (BigInt(next[key]) < BigInt(previous[key])) {
      throw new RuntimeSessionBindingConflictError(
        `Runtime binding ${key} cannot regress`
      )
    }
  }
  if (
    previous.activePromptOperationId !== undefined &&
    next.activePromptOperationId !== undefined &&
    previous.activePromptOperationId !==
      next.activePromptOperationId
  ) {
    throw new RuntimeSessionBindingConflictError(
      'Active prompt operation identity cannot change before terminalization'
    )
  }
  const startingPrompt =
    previous.activePromptOperationId === undefined &&
    next.activePromptOperationId !== undefined
  const expectedPromptSequence = startingPrompt
    ? previous.state === 'opening'
      ? previous.promptSequence
      : previous.promptSequence + 1
    : previous.promptSequence
  if (
    !Number.isSafeInteger(expectedPromptSequence) ||
    next.promptSequence !== expectedPromptSequence
  ) {
    throw new RuntimeSessionBindingConflictError(
      'Runtime binding prompt sequence is not the next allowed value'
    )
  }
  if (!allowedStateTransitions[previous.state].has(next.state)) {
    throw new RuntimeSessionBindingConflictError(
      `Runtime binding cannot transition from ${previous.state} to ${next.state}`
    )
  }
}

function rotateReadyBinding(
  current: RuntimeSessionBinding,
  bindingId: string,
  expected: RuntimeSessionTransportIdentity,
  next: RuntimeSessionTransportIdentity
): RuntimeSessionBinding {
  if (
    current.bindingId !== bindingId ||
    current.state !== 'ready' ||
    current.activePromptOperationId !== undefined
  ) {
    throw new RuntimeSessionBindingConflictError(
      'Only an idle ready Runtime binding can rotate transport'
    )
  }
  if (
    current.controllerGeneration !== expected.controllerGeneration ||
    current.daemonBootIdAtOpen !== expected.daemonBootIdAtOpen ||
    current.channelEpoch !== expected.channelEpoch
  ) {
    throw new RuntimeSessionBindingConflictError(
      'Runtime binding transport changed before rotation'
    )
  }
  if (
    expected.controllerGeneration === next.controllerGeneration &&
    expected.daemonBootIdAtOpen === next.daemonBootIdAtOpen &&
    expected.channelEpoch === next.channelEpoch
  ) {
    return structuredClone(current)
  }
  return runtimeSessionBindingSchema.parse({
    ...current,
    ...next,
    lastOutboundJournaledSequence: '0',
    lastOutboundDeliveredSequence: '0',
    lastInboundJournaledSequence: '0',
    lastMainAckSequence: '0'
  })
}

type PersistedBindingRow = {
  binding_id: string
  controller_id: string
  conversation_id: string
  acp_session_id: string
  state: string
  binding_json: string
}

const liveBindingPredicate = "state <> 'closed'"

/**
 * Durable Runtime binding index. The duplicated, constrained identity columns
 * are intentional: they let SQLite enforce live ownership while the complete
 * strict contract remains the canonical JSON payload.
 */
export class SqliteRuntimeSessionBindingStore
  implements RuntimeSessionBindingStore
{
  private database?: DatabaseSync
  private readonly maximumRows: number

  constructor(
    databasePath: string,
    options?: RuntimeSessionBindingStoreOptions
  ) {
    this.maximumRows = resolveMaximumRows(options)
    const database = openPrivateSqliteDatabase(databasePath)
    try {
      database.exec('PRAGMA journal_mode = WAL')
      database.exec('PRAGMA synchronous = FULL')
      database.exec('PRAGMA foreign_keys = ON')
      database.exec(`
        CREATE TABLE IF NOT EXISTS runtime_session_bindings (
          binding_id TEXT PRIMARY KEY
            CHECK(length(binding_id) BETWEEN 1 AND 128),
          controller_id TEXT NOT NULL
            CHECK(length(controller_id) BETWEEN 1 AND 128),
          conversation_id TEXT NOT NULL
            CHECK(length(conversation_id) BETWEEN 1 AND 128),
          acp_session_id TEXT NOT NULL
            CHECK(length(acp_session_id) BETWEEN 1 AND 128),
          state TEXT NOT NULL CHECK(state IN (
            'opening',
            'ready',
            'prompt-running',
            'reconciling',
            'closed',
            'interrupted',
            'outcome-unknown'
          )),
          binding_json TEXT NOT NULL
            CHECK(length(binding_json) BETWEEN 2 AND 32768)
        ) STRICT;

        CREATE UNIQUE INDEX IF NOT EXISTS
          runtime_session_bindings_live_conversation
          ON runtime_session_bindings(conversation_id)
          WHERE ${liveBindingPredicate};
        CREATE UNIQUE INDEX IF NOT EXISTS
          runtime_session_bindings_live_acp_session
          ON runtime_session_bindings(acp_session_id)
          WHERE ${liveBindingPredicate};
        CREATE INDEX IF NOT EXISTS
          runtime_session_bindings_controller
          ON runtime_session_bindings(controller_id, binding_id);
      `)
      this.database = database
      this.enforceExistingCapacity(database)
    } catch (error) {
      this.database = undefined
      database.close()
      throw error
    }
  }

  async getByConversation(
    conversationId: string
  ): Promise<RuntimeSessionBinding | undefined> {
    const rows = this.requireDatabase()
      .prepare(`
        SELECT binding_id, controller_id, conversation_id, acp_session_id,
               state, binding_json
        FROM runtime_session_bindings
        WHERE conversation_id = ? AND ${liveBindingPredicate}
      `)
      .all(conversationId) as PersistedBindingRow[]
    if (rows.length > 1) {
      throw new RuntimeSessionBindingCorruptionError(rows[0]!.binding_id)
    }
    return rows[0] ? this.decode(rows[0]) : undefined
  }

  async getById(
    bindingId: string
  ): Promise<RuntimeSessionBinding | undefined> {
    const row = this.selectById(bindingId)
    return row ? this.decode(row) : undefined
  }

  async put(binding: RuntimeSessionBinding): Promise<void> {
    const parsed = runtimeSessionBindingSchema.parse(structuredClone(binding))
    const database = this.requireDatabase()
    this.transaction(database, () => {
      const previousRow = this.selectById(parsed.bindingId)
      if (previousRow) {
        const previous = this.decode(previousRow)
        assertBindingUpdateAllowed(previous, parsed)
      } else {
        this.makeCapacityForInsert(database)
      }

      if (parsed.state !== 'closed') {
        this.assertConversationAvailable(
          parsed.conversationId,
          parsed.bindingId
        )
        this.assertSessionAvailable(parsed.acpSessionId, parsed.bindingId)
      }

      database
        .prepare(`
          INSERT INTO runtime_session_bindings (
            binding_id, controller_id, conversation_id, acp_session_id,
            state, binding_json
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(binding_id) DO UPDATE SET
            controller_id = excluded.controller_id,
            conversation_id = excluded.conversation_id,
            acp_session_id = excluded.acp_session_id,
            state = excluded.state,
            binding_json = excluded.binding_json
        `)
        .run(
          parsed.bindingId,
          parsed.controllerId,
          parsed.conversationId,
          parsed.acpSessionId,
          parsed.state,
          JSON.stringify(parsed)
        )
    })
  }

  async claimAcpSession(
    bindingId: string,
    acpSessionId: string
  ): Promise<RuntimeSessionBinding> {
    const database = this.requireDatabase()
    let result: RuntimeSessionBinding | undefined
    this.transaction(database, () => {
      const row = this.selectById(bindingId)
      if (!row) {
        throw new RuntimeSessionBindingConflictError(
          'Cannot claim an ACP session for an unknown binding'
        )
      }
      const current = this.decode(row)
      if (current.state === 'closed') {
        throw new RuntimeSessionBindingConflictError(
          'Cannot claim an ACP session for a closed binding'
        )
      }
      const claimed = runtimeSessionBindingSchema.parse({
        ...current,
        acpSessionId
      })
      this.assertSessionAvailable(claimed.acpSessionId, bindingId)
      database
        .prepare(`
          UPDATE runtime_session_bindings
          SET acp_session_id = ?, binding_json = ?
          WHERE binding_id = ?
        `)
        .run(
          claimed.acpSessionId,
          JSON.stringify(claimed),
          claimed.bindingId
        )
      result = structuredClone(claimed)
    })
    if (!result) {
      throw new RuntimeSessionBindingConflictError(
        'ACP session claim did not produce a binding'
      )
    }
    return structuredClone(result)
  }

  async rotateReadyTransport(
    bindingId: string,
    expected: RuntimeSessionTransportIdentity,
    next: RuntimeSessionTransportIdentity
  ): Promise<RuntimeSessionBinding> {
    const database = this.requireDatabase()
    let result: RuntimeSessionBinding | undefined
    this.transaction(database, () => {
      const row = this.selectById(bindingId)
      if (!row) {
        throw new RuntimeSessionBindingConflictError(
          'Cannot rotate transport for an unknown Runtime binding'
        )
      }
      const rotated = rotateReadyBinding(
        this.decode(row),
        bindingId,
        expected,
        next
      )
      database
        .prepare(`
          UPDATE runtime_session_bindings
          SET binding_json = ?
          WHERE binding_id = ?
        `)
        .run(JSON.stringify(rotated), rotated.bindingId)
      result = structuredClone(rotated)
    })
    if (!result) {
      throw new RuntimeSessionBindingConflictError(
        'Runtime binding transport rotation did not produce a binding'
      )
    }
    return structuredClone(result)
  }

  async listByController(
    controllerId: string,
    options?: RuntimeSessionBindingListOptions
  ): Promise<RuntimeSessionBinding[]> {
    const page = resolveListOptions(options)
    const rows = this.requireDatabase()
      .prepare(`
        SELECT binding_id, controller_id, conversation_id, acp_session_id,
               state, binding_json
        FROM runtime_session_bindings
        WHERE controller_id = ? AND binding_id > ?
        ORDER BY binding_id
        LIMIT ?
      `)
      .all(
        controllerId,
        page.afterBindingId,
        page.limit
      ) as PersistedBindingRow[]
    return rows.map((row) => this.decode(row))
  }

  async pruneClosed(limit = maximumPruneBatch): Promise<number> {
    const boundedLimit = boundedPositiveInteger(
      limit,
      maximumPruneBatch,
      'limit'
    )
    const database = this.requireDatabase()
    let deleted = 0
    this.transaction(database, () => {
      deleted = this.deleteClosed(database, boundedLimit)
    })
    return deleted
  }

  close(): void {
    this.database?.close()
    this.database = undefined
  }

  dispose(): void {
    this.close()
  }

  private selectById(bindingId: string): PersistedBindingRow | undefined {
    return this.requireDatabase()
      .prepare(`
        SELECT binding_id, controller_id, conversation_id, acp_session_id,
               state, binding_json
        FROM runtime_session_bindings
        WHERE binding_id = ?
      `)
      .get(bindingId) as PersistedBindingRow | undefined
  }

  private decode(row: PersistedBindingRow): RuntimeSessionBinding {
    try {
      const parsed = runtimeSessionBindingSchema.parse(
        JSON.parse(row.binding_json)
      )
      if (
        parsed.bindingId !== row.binding_id ||
        parsed.controllerId !== row.controller_id ||
        parsed.conversationId !== row.conversation_id ||
        parsed.acpSessionId !== row.acp_session_id ||
        parsed.state !== row.state
      ) {
        throw new Error('Indexed binding fields do not match payload')
      }
      return structuredClone(parsed)
    } catch (error) {
      throw new RuntimeSessionBindingCorruptionError(row.binding_id, {
        cause: error
      })
    }
  }

  private assertConversationAvailable(
    conversationId: string,
    bindingId: string
  ): void {
    const owner = this.requireDatabase()
      .prepare(`
        SELECT binding_id, controller_id, conversation_id, acp_session_id,
               state, binding_json
        FROM runtime_session_bindings
        WHERE conversation_id = ? AND binding_id <> ?
          AND ${liveBindingPredicate}
      `)
      .get(conversationId, bindingId) as PersistedBindingRow | undefined
    if (owner) {
      this.decode(owner)
      throw new RuntimeSessionBindingConflictError(
        'Conversation is already owned by another live Runtime binding'
      )
    }
  }

  private assertSessionAvailable(
    acpSessionId: string,
    bindingId: string
  ): void {
    const owner = this.requireDatabase()
      .prepare(`
        SELECT binding_id, controller_id, conversation_id, acp_session_id,
               state, binding_json
        FROM runtime_session_bindings
        WHERE acp_session_id = ? AND binding_id <> ?
          AND ${liveBindingPredicate}
      `)
      .get(acpSessionId, bindingId) as PersistedBindingRow | undefined
    if (owner) {
      this.decode(owner)
      throw new RuntimeSessionClaimConflictError(acpSessionId)
    }
  }

  private makeCapacityForInsert(database: DatabaseSync): void {
    const row = database
      .prepare(
        'SELECT COUNT(*) AS count FROM runtime_session_bindings'
      )
      .get() as { count: number }
    const required = row.count - this.maximumRows + 1
    if (required <= 0) {
      return
    }
    this.deleteClosed(database, required)
    const remaining = database
      .prepare(
        'SELECT COUNT(*) AS count FROM runtime_session_bindings'
      )
      .get() as { count: number }
    if (remaining.count >= this.maximumRows) {
      throw new RuntimeSessionBindingConflictError(
        'Runtime binding store capacity is exhausted by authoritative bindings'
      )
    }
  }

  private enforceExistingCapacity(database: DatabaseSync): void {
    const row = database
      .prepare(
        'SELECT COUNT(*) AS count FROM runtime_session_bindings'
      )
      .get() as { count: number }
    const excess = row.count - this.maximumRows
    if (excess <= 0) {
      return
    }
    this.transaction(database, () => {
      this.deleteClosed(database, excess)
      const remaining = database
        .prepare(
          'SELECT COUNT(*) AS count FROM runtime_session_bindings'
        )
        .get() as { count: number }
      if (remaining.count > this.maximumRows) {
        throw new RuntimeSessionBindingConflictError(
          'Runtime binding store exceeds capacity with authoritative bindings'
        )
      }
    })
  }

  private deleteClosed(database: DatabaseSync, limit: number): number {
    const rows = database
      .prepare(`
        SELECT binding_id, controller_id, conversation_id, acp_session_id,
               state, binding_json
        FROM runtime_session_bindings
        WHERE state = 'closed'
        ORDER BY binding_id
        LIMIT ?
      `)
      .all(limit) as PersistedBindingRow[]
    for (const row of rows) {
      const binding = this.decode(row)
      if (binding.state !== 'closed') {
        throw new RuntimeSessionBindingCorruptionError(binding.bindingId)
      }
    }
    const remove = database.prepare(
      'DELETE FROM runtime_session_bindings WHERE binding_id = ?'
    )
    let deleted = 0
    for (const row of rows) {
      deleted += Number(remove.run(row.binding_id).changes)
    }
    return deleted
  }

  private transaction(database: DatabaseSync, operation: () => void): void {
    database.exec('BEGIN IMMEDIATE')
    try {
      operation()
      database.exec('COMMIT')
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // Preserve the original domain, validation, or SQLite failure.
      }
      throw error
    }
  }

  private requireDatabase(): DatabaseSync {
    if (!this.database) {
      throw new Error('Runtime session binding store is closed')
    }
    return this.database
  }
}

/** A strict store useful for tests and non-persistent composition roots. */
export class MemoryRuntimeSessionBindingStore
  implements RuntimeSessionBindingStore
{
  private readonly bindings = new Map<string, RuntimeSessionBinding>()
  private readonly maximumRows: number

  constructor(options?: RuntimeSessionBindingStoreOptions) {
    this.maximumRows = resolveMaximumRows(options)
  }

  async getByConversation(
    conversationId: string
  ): Promise<RuntimeSessionBinding | undefined> {
    const binding = [...this.bindings.values()].find(
      (candidate) =>
        candidate.conversationId === conversationId &&
        candidate.state !== 'closed'
    )
    return binding ? structuredClone(binding) : undefined
  }

  async getById(
    bindingId: string
  ): Promise<RuntimeSessionBinding | undefined> {
    const binding = this.bindings.get(bindingId)
    return binding ? structuredClone(binding) : undefined
  }

  async put(binding: RuntimeSessionBinding): Promise<void> {
    const parsed = runtimeSessionBindingSchema.parse(binding)
    const previous = this.bindings.get(parsed.bindingId)
    if (previous) {
      assertBindingUpdateAllowed(previous, parsed)
    } else {
      this.makeCapacityForInsert()
    }
    if (parsed.state !== 'closed') {
      const conversationOwner = [...this.bindings.values()].find(
        (candidate) =>
          candidate.bindingId !== parsed.bindingId &&
          candidate.state !== 'closed' &&
          candidate.conversationId === parsed.conversationId
      )
      if (conversationOwner) {
        throw new RuntimeSessionBindingConflictError(
          'Conversation is already owned by another live Runtime binding'
        )
      }
      this.assertSessionAvailable(parsed.acpSessionId, parsed.bindingId)
    }
    this.bindings.set(parsed.bindingId, structuredClone(parsed))
  }

  async claimAcpSession(
    bindingId: string,
    acpSessionId: string
  ): Promise<RuntimeSessionBinding> {
    const current = this.bindings.get(bindingId)
    if (!current) {
      throw new RuntimeSessionBindingConflictError(
        'Cannot claim an ACP session for an unknown binding'
      )
    }
    if (current.state === 'closed') {
      throw new RuntimeSessionBindingConflictError(
        'Cannot claim an ACP session for a closed binding'
      )
    }
    this.assertSessionAvailable(acpSessionId, bindingId)
    const claimed = runtimeSessionBindingSchema.parse({
      ...current,
      acpSessionId
    })
    this.bindings.set(bindingId, structuredClone(claimed))
    return structuredClone(claimed)
  }

  async rotateReadyTransport(
    bindingId: string,
    expected: RuntimeSessionTransportIdentity,
    next: RuntimeSessionTransportIdentity
  ): Promise<RuntimeSessionBinding> {
    const current = this.bindings.get(bindingId)
    if (!current) {
      throw new RuntimeSessionBindingConflictError(
        'Cannot rotate transport for an unknown Runtime binding'
      )
    }
    const rotated = rotateReadyBinding(
      current,
      bindingId,
      expected,
      next
    )
    this.bindings.set(bindingId, structuredClone(rotated))
    return structuredClone(rotated)
  }

  private assertSessionAvailable(
    acpSessionId: string,
    bindingId: string
  ): void {
    const owner = [...this.bindings.values()].find(
      (candidate) =>
        candidate.bindingId !== bindingId &&
        candidate.state !== 'closed' &&
        candidate.acpSessionId === acpSessionId
    )
    if (owner) {
      throw new RuntimeSessionClaimConflictError(acpSessionId)
    }
  }

  async listByController(
    controllerId: string,
    options?: RuntimeSessionBindingListOptions
  ): Promise<RuntimeSessionBinding[]> {
    const page = resolveListOptions(options)
    return [...this.bindings.values()]
      .filter(
        (binding) =>
          binding.controllerId === controllerId &&
          binding.bindingId > page.afterBindingId
      )
      .sort((left, right) =>
        left.bindingId < right.bindingId
          ? -1
          : left.bindingId > right.bindingId
            ? 1
            : 0
      )
      .slice(0, page.limit)
      .map((binding) => structuredClone(binding))
  }

  async pruneClosed(limit = maximumPruneBatch): Promise<number> {
    const boundedLimit = boundedPositiveInteger(
      limit,
      maximumPruneBatch,
      'limit'
    )
    return this.deleteClosed(boundedLimit)
  }

  private makeCapacityForInsert(): void {
    const required = this.bindings.size - this.maximumRows + 1
    if (required <= 0) {
      return
    }
    this.deleteClosed(required)
    if (this.bindings.size >= this.maximumRows) {
      throw new RuntimeSessionBindingConflictError(
        'Runtime binding store capacity is exhausted by authoritative bindings'
      )
    }
  }

  private deleteClosed(limit: number): number {
    const closedIds = [...this.bindings.values()]
      .filter((binding) => binding.state === 'closed')
      .map((binding) => binding.bindingId)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .slice(0, limit)
    for (const bindingId of closedIds) {
      this.bindings.delete(bindingId)
    }
    return closedIds.length
  }
}
