import type { DatabaseSync } from 'node:sqlite'
import { openPrivateSqliteDatabase } from '../shared/node/private-sqlite-database'
import {
  REMOTE_SEMANTIC_TRANSCRIPT_LIMITS,
  remoteOwnedPromptStartResultSchema,
  remoteSemanticTranscriptAckResultSchema,
  remoteSemanticTranscriptEventSchema,
  remoteSemanticTranscriptPageResultSchema,
  type RemoteOwnedPromptStartResult,
  type RemoteSemanticTranscriptEvent
} from '../shared/remote-agent-contracts'

type OperationRow = {
  binding_id: string
  operation_id: string
  request_id: string
  controller_id: string
  preparation_digest: string
  start_digest: string | null
  prompt_sequence: number
  state: string
  session_id: string | null
  latest_sequence: number
  acknowledged_sequence: number
  transcript_bytes: number
  created_at: number
  updated_at: number
}

type EventRow = {
  sequence: number
  kind: RemoteSemanticTranscriptEvent['kind']
  payload_json: string
  payload_bytes: number
  created_at: number
}

export class SemanticPromptStoreError extends Error {
  constructor(
    message: string,
    readonly code: 'capacity' | 'conflict' | 'not-found' | 'state'
  ) {
    super(message)
    this.name = 'SemanticPromptStoreError'
  }
}

/**
 * Durable semantic recovery authority. Credentials, prompts, provider
 * requests, raw ACP bytes, and model responses are intentionally absent from
 * this database.
 */
export class SemanticPromptStore {
  readonly #database: DatabaseSync
  readonly #now: () => number
  readonly #maximumEventsPerPrompt: number
  readonly #maximumTranscriptBytes: number
  readonly #maximumRetainedAcknowledgedOperations: number
  #closed = false

  constructor(
    path: string,
    options: {
      now?: () => number
      maximumEventsPerPrompt?: number
      maximumTranscriptBytes?: number
      maximumRetainedAcknowledgedOperations?: number
    } = {}
  ) {
    this.#now = options.now ?? Date.now
    this.#maximumEventsPerPrompt =
      options.maximumEventsPerPrompt ??
      REMOTE_SEMANTIC_TRANSCRIPT_LIMITS.maximumEventsPerPrompt
    this.#maximumTranscriptBytes =
      options.maximumTranscriptBytes ??
      REMOTE_SEMANTIC_TRANSCRIPT_LIMITS.maximumTranscriptBytes
    this.#maximumRetainedAcknowledgedOperations =
      options.maximumRetainedAcknowledgedOperations ?? 4_096
    if (
      !Number.isSafeInteger(this.#maximumEventsPerPrompt) ||
      this.#maximumEventsPerPrompt < 2 ||
      !Number.isSafeInteger(this.#maximumTranscriptBytes) ||
      this.#maximumTranscriptBytes <=
        REMOTE_SEMANTIC_TRANSCRIPT_LIMITS.maximumEventBytes ||
      !Number.isSafeInteger(
        this.#maximumRetainedAcknowledgedOperations
      ) ||
      this.#maximumRetainedAcknowledgedOperations < 1
    ) {
      throw new SemanticPromptStoreError(
        'Semantic prompt retention limit is invalid',
        'state'
      )
    }
    this.#database = openPrivateSqliteDatabase(path)
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS semantic_prompt_operations (
        binding_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        controller_id TEXT NOT NULL,
        preparation_digest TEXT NOT NULL,
        start_digest TEXT,
        prompt_sequence INTEGER NOT NULL CHECK (prompt_sequence >= 0),
        state TEXT NOT NULL CHECK (state IN (
          'starting', 'running', 'completed', 'failed', 'cancelled',
          'outcome-unknown'
        )),
        session_id TEXT,
        latest_sequence INTEGER NOT NULL DEFAULT 0 CHECK (latest_sequence >= 0),
        acknowledged_sequence INTEGER NOT NULL DEFAULT 0
          CHECK (acknowledged_sequence >= 0),
        transcript_bytes INTEGER NOT NULL DEFAULT 0 CHECK (transcript_bytes >= 0),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        PRIMARY KEY (binding_id, operation_id),
        CHECK (acknowledged_sequence <= latest_sequence)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS semantic_prompt_events (
        binding_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        kind TEXT NOT NULL CHECK (kind IN (
          'session-update', 'permission-decision', 'prompt-terminal'
        )),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        payload_bytes INTEGER NOT NULL CHECK (payload_bytes > 0),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        PRIMARY KEY (binding_id, operation_id, sequence),
        FOREIGN KEY (binding_id, operation_id)
          REFERENCES semantic_prompt_operations(binding_id, operation_id)
          ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS semantic_prompt_events_page
        ON semantic_prompt_events(binding_id, operation_id, sequence);
      CREATE INDEX IF NOT EXISTS semantic_prompt_operations_retention
        ON semantic_prompt_operations(updated_at DESC)
        WHERE state NOT IN ('starting', 'running')
          AND acknowledged_sequence = latest_sequence;
    `)
    const orphaned = this.#database
      .prepare(
        `SELECT binding_id, operation_id
         FROM semantic_prompt_operations
         WHERE state IN ('starting', 'running')`
      )
      .all() as Array<{
      binding_id: string
      operation_id: string
    }>
    for (const operation of orphaned) {
      this.append({
        bindingId: operation.binding_id,
        operationId: operation.operation_id,
        kind: 'prompt-terminal',
        payload: {
          status: 'outcome-unknown',
          error: {
            name: 'AgentRestarted',
            message:
              'Agent restarted before the prompt reached a durable terminal state'
          }
        },
        terminalState: 'outcome-unknown'
      })
    }
    this.#pruneAcknowledgedOperations()
  }

  #pruneAcknowledgedOperations(protectedOperation?: {
    bindingId: string
    operationId: string
  }): void {
    if (protectedOperation === undefined) {
      this.#database.prepare(`
        DELETE FROM semantic_prompt_operations
        WHERE (binding_id, operation_id) IN (
          SELECT binding_id, operation_id
          FROM semantic_prompt_operations
          WHERE state NOT IN ('starting', 'running')
            AND acknowledged_sequence = latest_sequence
          ORDER BY updated_at DESC, created_at DESC,
                   binding_id DESC, operation_id DESC
          LIMIT -1 OFFSET ?
        );
      `).run(this.#maximumRetainedAcknowledgedOperations)
      return
    }
    this.#database.prepare(`
      DELETE FROM semantic_prompt_operations
      WHERE (binding_id, operation_id) IN (
        SELECT binding_id, operation_id
        FROM semantic_prompt_operations
        WHERE state NOT IN ('starting', 'running')
          AND acknowledged_sequence = latest_sequence
          AND NOT (binding_id = ? AND operation_id = ?)
        ORDER BY updated_at DESC, created_at DESC,
                 binding_id DESC, operation_id DESC
        LIMIT -1 OFFSET ?
      );
    `).run(
      protectedOperation.bindingId,
      protectedOperation.operationId,
      this.#maximumRetainedAcknowledgedOperations - 1
    )
  }

  prepare(input: {
    bindingId: string
    operationId: string
    requestId: string
    controllerId: string
    preparationDigest: string
    promptSequence: number
  }): { created: boolean } {
    this.#assertOpen()
    const existing = this.#get(input.bindingId, input.operationId)
    if (existing !== undefined) {
      if (
        existing.request_id !== input.requestId ||
        existing.controller_id !== input.controllerId ||
        existing.preparation_digest !== input.preparationDigest ||
        existing.prompt_sequence !== input.promptSequence
      ) {
        throw new SemanticPromptStoreError(
          'Prompt operation is already bound to different preparation',
          'conflict'
        )
      }
      return { created: false }
    }
    const now = this.#timestamp()
    this.#database.prepare(`
      INSERT INTO semantic_prompt_operations (
        binding_id, operation_id, request_id, controller_id,
        preparation_digest, prompt_sequence, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?)
    `).run(
      input.bindingId,
      input.operationId,
      input.requestId,
      input.controllerId,
      input.preparationDigest,
      input.promptSequence,
      now,
      now
    )
    return { created: true }
  }

  begin(input: {
    bindingId: string
    operationId: string
    startDigest: string
    sessionId: string
  }): { created: boolean; result: RemoteOwnedPromptStartResult } {
    return this.#transaction(() => {
      const row = this.#require(input.bindingId, input.operationId)
      if (row.start_digest !== null) {
        if (
          row.start_digest !== input.startDigest ||
          row.session_id !== input.sessionId
        ) {
          throw new SemanticPromptStoreError(
            'Prompt start identity conflicts with the existing operation',
            'conflict'
          )
        }
        return { created: false, result: rowToStartResult(row) }
      }
      const now = this.#timestamp()
      const result = this.#database.prepare(`
        UPDATE semantic_prompt_operations
        SET start_digest = ?, session_id = ?, state = 'running',
            updated_at = ?
        WHERE binding_id = ? AND operation_id = ?
          AND start_digest IS NULL AND state = 'starting'
      `).run(
        input.startDigest,
        input.sessionId,
        now,
        input.bindingId,
        input.operationId
      )
      if (Number(result.changes) !== 1) {
        throw new SemanticPromptStoreError(
          'Prompt operation cannot transition to running',
          'state'
        )
      }
      return {
        created: true,
        result: rowToStartResult(
          this.#require(input.bindingId, input.operationId)
        )
      }
    })
  }

  append(input: {
    bindingId: string
    operationId: string
    kind: RemoteSemanticTranscriptEvent['kind']
    payload: unknown
    terminalState?: 'completed' | 'failed' | 'cancelled' | 'outcome-unknown'
  }): RemoteSemanticTranscriptEvent {
    const payloadJson = JSON.stringify(input.payload)
    const payloadBytes = Buffer.byteLength(payloadJson, 'utf8')
    if (
      payloadBytes < 1 ||
      payloadBytes > REMOTE_SEMANTIC_TRANSCRIPT_LIMITS.maximumEventBytes
    ) {
      throw new SemanticPromptStoreError(
        'Semantic transcript event exceeds its byte limit',
        'capacity'
      )
    }
    return this.#transaction(() => {
      const row = this.#require(input.bindingId, input.operationId)
      const terminal = input.terminalState !== undefined
      if (
        (
          terminal
            ? row.latest_sequence >= this.#maximumEventsPerPrompt
            : row.latest_sequence >= this.#maximumEventsPerPrompt - 1
        ) ||
        row.transcript_bytes + payloadBytes >
          (
            terminal
              ? this.#maximumTranscriptBytes
              : this.#maximumTranscriptBytes -
                REMOTE_SEMANTIC_TRANSCRIPT_LIMITS.maximumEventBytes
          )
      ) {
        throw new SemanticPromptStoreError(
          'Semantic transcript prompt quota reached',
          'capacity'
        )
      }
      if (!['starting', 'running'].includes(row.state)) {
        throw new SemanticPromptStoreError(
          'Semantic events cannot follow terminal evidence',
          'state'
        )
      }
      const sequence = row.latest_sequence + 1
      const now = this.#timestamp()
      const kind =
        remoteSemanticTranscriptEventSchema.shape.kind.parse(input.kind)
      const payload =
        remoteSemanticTranscriptEventSchema.shape.payload.parse(input.payload)
      this.#database.prepare(`
        INSERT INTO semantic_prompt_events (
          binding_id, operation_id, sequence, kind, payload_json,
          payload_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.bindingId,
        input.operationId,
        sequence,
        kind,
        payloadJson,
        payloadBytes,
        now
      )
      this.#database.prepare(`
        UPDATE semantic_prompt_operations
        SET latest_sequence = ?, transcript_bytes = transcript_bytes + ?,
            state = COALESCE(?, state),
            updated_at = ?
        WHERE binding_id = ? AND operation_id = ?
      `).run(
        sequence,
        payloadBytes,
        input.terminalState ?? null,
        now,
        input.bindingId,
        input.operationId
      )
      return remoteSemanticTranscriptEventSchema.parse({
        sequence: String(sequence),
        kind,
        payload,
        createdAt: now
      })
    })
  }

  attach(
    bindingId: string,
    operationId: string,
    controllerId: string
  ): RemoteOwnedPromptStartResult {
    const row = this.#require(bindingId, operationId)
    this.#assertController(row, controllerId)
    if (row.session_id === null) {
      throw new SemanticPromptStoreError(
        'Prompt session has not started',
        'state'
      )
    }
    return rowToStartResult(row)
  }

  findStarted(input: {
    bindingId: string
    operationId: string
    controllerId: string
    startDigest: string
  }): RemoteOwnedPromptStartResult | undefined {
    const row = this.#get(input.bindingId, input.operationId)
    if (row === undefined || row.start_digest === null) {
      return undefined
    }
    this.#assertController(row, input.controllerId)
    if (row.start_digest !== input.startDigest) {
      throw new SemanticPromptStoreError(
        'Duplicate prompt start has different canonical content',
        'conflict'
      )
    }
    return rowToStartResult(row)
  }

  page(input: {
    bindingId: string
    operationId: string
    controllerId: string
    afterSequence: string
    limit: number
  }) {
    const row = this.#require(input.bindingId, input.operationId)
    this.#assertController(row, input.controllerId)
    const after = Number(BigInt(input.afterSequence))
    const rows = this.#database.prepare(`
      SELECT sequence, kind, payload_json, payload_bytes, created_at
      FROM semantic_prompt_events
      WHERE binding_id = ? AND operation_id = ? AND sequence > ?
      ORDER BY sequence ASC LIMIT ?
    `).iterate(
      input.bindingId,
      input.operationId,
      after,
      input.limit + 1
    ) as unknown as IterableIterator<EventRow>
    const events: EventRow[] = []
    let pageBytes = 1_024
    let hasMore = false
    for (const event of rows) {
      const estimatedBytes = event.payload_bytes + 1_024
      if (
        events.length >= input.limit ||
        (events.length > 0 &&
          pageBytes + estimatedBytes >
            REMOTE_SEMANTIC_TRANSCRIPT_LIMITS.maximumPageBytes)
      ) {
        hasMore = true
        break
      }
      events.push(event)
      pageBytes += estimatedBytes
    }
    return remoteSemanticTranscriptPageResultSchema.parse({
      bindingId: input.bindingId,
      operationId: input.operationId,
      events: events.map(rowToEvent),
      latestSequence: String(row.latest_sequence),
      acknowledgedSequence: String(row.acknowledged_sequence),
      state: row.state,
      ...(row.session_id === null ? {} : { sessionId: row.session_id }),
      hasMore
    })
  }

  acknowledge(input: {
    bindingId: string
    operationId: string
    controllerId: string
    acknowledgedSequence: string
  }) {
    return this.#transaction(() => {
      const row = this.#require(input.bindingId, input.operationId)
      this.#assertController(row, input.controllerId)
      const sequence = Number(BigInt(input.acknowledgedSequence))
      if (sequence > row.latest_sequence) {
        throw new SemanticPromptStoreError(
          'Semantic transcript ACK exceeds committed output',
          'conflict'
        )
      }
      if (sequence > row.acknowledged_sequence) {
        this.#database.prepare(`
          UPDATE semantic_prompt_operations
          SET acknowledged_sequence = ?, updated_at = ?
          WHERE binding_id = ? AND operation_id = ?
        `).run(
          sequence,
          this.#timestamp(),
          input.bindingId,
          input.operationId
        )
        this.#database.prepare(`
          DELETE FROM semantic_prompt_events
          WHERE binding_id = ? AND operation_id = ? AND sequence <= ?
        `).run(
          input.bindingId,
          input.operationId,
          sequence
        )
        if (
          sequence === row.latest_sequence &&
          !['starting', 'running'].includes(row.state)
        ) {
          this.#pruneAcknowledgedOperations({
            bindingId: input.bindingId,
            operationId: input.operationId
          })
        }
      }
      return remoteSemanticTranscriptAckResultSchema.parse({
        bindingId: input.bindingId,
        operationId: input.operationId,
        acknowledgedSequence: String(
          Math.max(sequence, row.acknowledged_sequence)
        )
      })
    })
  }

  close(): void {
    if (!this.#closed) {
      this.#database.close()
      this.#closed = true
    }
  }

  #get(bindingId: string, operationId: string): OperationRow | undefined {
    return this.#database.prepare(`
      SELECT * FROM semantic_prompt_operations
      WHERE binding_id = ? AND operation_id = ?
    `).get(bindingId, operationId) as OperationRow | undefined
  }

  #require(bindingId: string, operationId: string): OperationRow {
    this.#assertOpen()
    const row = this.#get(bindingId, operationId)
    if (row === undefined) {
      throw new SemanticPromptStoreError(
        'Semantic prompt operation does not exist',
        'not-found'
      )
    }
    return row
  }

  #assertController(row: OperationRow, controllerId: string): void {
    if (row.controller_id !== controllerId) {
      throw new SemanticPromptStoreError(
        'Semantic prompt belongs to another controller',
        'conflict'
      )
    }
  }

  #transaction<T>(action: () => T): T {
    this.#assertOpen()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.#database.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK')
      } catch {
        // Preserve the original state transition error.
      }
      throw error
    }
  }

  #timestamp(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SemanticPromptStoreError('Clock is invalid', 'state')
    }
    return value
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new SemanticPromptStoreError(
        'Semantic prompt store is closed',
        'state'
      )
    }
  }
}

function rowToStartResult(row: OperationRow): RemoteOwnedPromptStartResult {
  if (row.session_id === null) {
    throw new SemanticPromptStoreError(
      'Prompt session has not started',
      'state'
    )
  }
  return remoteOwnedPromptStartResultSchema.parse({
    bindingId: row.binding_id,
    operationId: row.operation_id,
    requestId: row.request_id,
    sessionId: row.session_id,
    state: row.state,
    latestSemanticSequence: String(row.latest_sequence)
  })
}

function rowToEvent(row: EventRow): RemoteSemanticTranscriptEvent {
  return remoteSemanticTranscriptEventSchema.parse({
    sequence: String(row.sequence),
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as unknown,
    createdAt: row.created_at
  })
}
