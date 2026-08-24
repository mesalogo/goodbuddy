import { DatabaseSync, type StatementSync } from 'node:sqlite'
import {
  completeModelCallEvidenceSchema,
  failModelCallEvidenceSchema,
  modelCallDispatchMetadataSchema,
  modelCallIdentitySchema,
  modelCallListOptionsSchema,
  modelCallRecordSchema,
  modelCallStatusSchema,
  prepareModelCallSchema,
  unknownModelCallEvidenceSchema,
  type CompleteModelCallEvidence,
  type FailModelCallEvidence,
  type ModelCallDispatchMetadata,
  type ModelCallListOptions,
  type ModelCallOperationPage,
  type ModelCallRecord,
  type ModelCallStatus,
  type PrepareModelCall,
  type UnknownModelCallEvidence
} from '../../shared/model-call-operation-contracts'
import { openPrivateSqliteDatabase } from './private-sqlite-database'

type ModelCallRow = {
  call_operation_id: string
  binding_id: string
  prompt_operation_id: string
  round_index: number
  identity_json: string
  request_digest: string
  model_profile_digest: string
  maximum_output_tokens: number
  status: string
  dispatch_metadata_json: string | null
  terminal_evidence_json: string | null
  prepared_at: number
  updated_at: number
  dispatched_at: number | null
  terminal_at: number | null
  response_delivered_at: number | null
}

type PromptAuthorityRow = {
  binding_id: string
  prompt_operation_id: string
  model_profile_digest: string
  provider: string
  profile: string
  model: string
  protocol: string
  high_water_round: number
  latest_call_operation_id: string
  latest_status: string
  latest_response_delivered: number
}

type PromptHighWaterRow = {
  finalized_prompt_sequence: number
}

const LEGACY_UNBOUNDED_QUOTA = Number.MAX_SAFE_INTEGER

export class ModelCallConflictError extends Error {
  constructor(message = 'Model call operation is bound to different identity or evidence') {
    super(message)
    this.name = 'ModelCallConflictError'
  }
}

export class ModelCallStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelCallStateError'
  }
}

export class ModelCallCapacityError extends Error {
  constructor(message = 'Model call operation ledger capacity reached') {
    super(message)
    this.name = 'ModelCallCapacityError'
  }
}

export type ModelCallOperationStoreOptions = {
  now?: () => number
  maximumRecords?: number
  maximumAuthorities?: number
}

/**
 * Durable Main-owned model-call authority. Only identities, policy digests,
 * token reservations, bounded provider metadata, and state transitions are
 * persisted. Provider endpoints, credentials, requests, and responses are not.
 */
export class ModelCallOperationStore {
  readonly #database: DatabaseSync
  readonly #now: () => number
  readonly #maximumRecords: number
  readonly #maximumAuthorities: number
  #closed = false
  readonly #statements: {
    get: StatementSync
    getAuthority: StatementSync
    insert: StatementSync
    insertAuthority: StatementSync
    advanceAuthority: StatementSync
    claim: StatementSync
    markAuthorityDispatched: StatementSync
    terminal: StatementSync
    markAuthorityTerminal: StatementSync
    deliver: StatementSync
    markAuthorityDelivered: StatementSync
    unresolved: StatementSync
    count: StatementSync
    countAuthorities: StatementSync
    getPromptHighWater: StatementSync
    advancePromptHighWater: StatementSync
    deleteAuthority: StatementSync
    pruneTerminal: StatementSync
    pruneTerminalOlderThan: StatementSync
  }

  constructor(path: string, options: ModelCallOperationStoreOptions = {}) {
    this.#maximumRecords = maximumRecordsSchema.parse(
      options.maximumRecords ?? 10_000
    )
    this.#maximumAuthorities = maximumRecordsSchema.parse(
      options.maximumAuthorities ??
        Math.max(10_000, this.#maximumRecords)
    )
    this.#now = options.now ?? Date.now
    const database = openPrivateSqliteDatabase(path)
    try {
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS model_prompt_authorities (
          binding_id TEXT NOT NULL CHECK (length(binding_id) BETWEEN 1 AND 128),
          prompt_operation_id TEXT NOT NULL
            CHECK (length(prompt_operation_id) BETWEEN 1 AND 128),
          model_profile_digest TEXT NOT NULL CHECK (
            length(model_profile_digest) = 71 AND
            substr(model_profile_digest, 1, 7) = 'sha256:'
          ),
          provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 256),
          profile TEXT NOT NULL CHECK (length(profile) BETWEEN 1 AND 256),
          model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 256),
          protocol TEXT NOT NULL CHECK (length(protocol) BETWEEN 1 AND 256),
          maximum_model_calls INTEGER NOT NULL CHECK (maximum_model_calls > 0),
          maximum_total_output_tokens INTEGER NOT NULL
            CHECK (maximum_total_output_tokens > 0),
          reserved_output_tokens INTEGER NOT NULL CHECK (
            reserved_output_tokens > 0 AND
            reserved_output_tokens <= maximum_total_output_tokens
          ),
          high_water_round INTEGER NOT NULL CHECK (high_water_round >= 0),
          latest_call_operation_id TEXT NOT NULL
            CHECK (length(latest_call_operation_id) BETWEEN 1 AND 128),
          latest_status TEXT NOT NULL CHECK (
            latest_status IN (
              'prepared', 'dispatched', 'completed',
              'failed-definitive', 'outcome-unknown'
            )
          ),
          latest_response_delivered INTEGER NOT NULL DEFAULT 0 CHECK (
            latest_response_delivered IN (0, 1) AND
            (latest_response_delivered = 0 OR latest_status = 'completed')
          ),
          updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
          PRIMARY KEY (binding_id, prompt_operation_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS model_call_operations (
          call_operation_id TEXT PRIMARY KEY
            CHECK (length(call_operation_id) BETWEEN 1 AND 128),
          binding_id TEXT NOT NULL CHECK (length(binding_id) BETWEEN 1 AND 128),
          prompt_operation_id TEXT NOT NULL
            CHECK (length(prompt_operation_id) BETWEEN 1 AND 128),
          round_index INTEGER NOT NULL CHECK (round_index >= 0),
          identity_json TEXT NOT NULL
            CHECK (length(identity_json) BETWEEN 1 AND 8192)
            CHECK (json_valid(identity_json)),
          request_digest TEXT NOT NULL CHECK (
            length(request_digest) = 71 AND
            substr(request_digest, 1, 7) = 'sha256:'
          ),
          model_profile_digest TEXT NOT NULL CHECK (
            length(model_profile_digest) = 71 AND
            substr(model_profile_digest, 1, 7) = 'sha256:'
          ),
          maximum_model_calls INTEGER NOT NULL CHECK (maximum_model_calls > 0),
          maximum_total_output_tokens INTEGER NOT NULL
            CHECK (maximum_total_output_tokens > 0),
          maximum_output_tokens INTEGER NOT NULL CHECK (
            maximum_output_tokens > 0 AND
            maximum_output_tokens <= maximum_total_output_tokens
          ),
          status TEXT NOT NULL CHECK (
            status IN (
              'prepared', 'dispatched', 'completed',
              'failed-definitive', 'outcome-unknown'
            )
          ),
          dispatch_metadata_json TEXT CHECK (
            dispatch_metadata_json IS NULL OR (
              length(dispatch_metadata_json) BETWEEN 2 AND 4096 AND
              json_valid(dispatch_metadata_json)
            )
          ),
          terminal_evidence_json TEXT CHECK (
            terminal_evidence_json IS NULL OR (
              length(terminal_evidence_json) BETWEEN 2 AND 8192 AND
              json_valid(terminal_evidence_json)
            )
          ),
          prepared_at INTEGER NOT NULL CHECK (prepared_at >= 0),
          updated_at INTEGER NOT NULL CHECK (updated_at >= prepared_at),
          dispatched_at INTEGER,
          terminal_at INTEGER,
          response_delivered_at INTEGER,
          UNIQUE (binding_id, prompt_operation_id, round_index),
          CHECK (dispatched_at IS NULL OR dispatched_at >= prepared_at),
          CHECK (terminal_at IS NULL OR (
            dispatched_at IS NOT NULL AND terminal_at >= dispatched_at
          )),
          CHECK (response_delivered_at IS NULL OR (
            status = 'completed' AND terminal_at IS NOT NULL AND
            response_delivered_at >= terminal_at
          )),
          CHECK (dispatched_at IS NULL OR updated_at >= dispatched_at),
          CHECK (terminal_at IS NULL OR updated_at >= terminal_at),
          CHECK (
            response_delivered_at IS NULL OR updated_at >= response_delivered_at
          ),
          CHECK (
            (status = 'prepared' AND dispatch_metadata_json IS NULL AND
              terminal_evidence_json IS NULL AND dispatched_at IS NULL AND
              terminal_at IS NULL AND response_delivered_at IS NULL) OR
            (status = 'dispatched' AND dispatch_metadata_json IS NOT NULL AND
              terminal_evidence_json IS NULL AND dispatched_at IS NOT NULL AND
              terminal_at IS NULL AND response_delivered_at IS NULL) OR
            (status IN ('completed', 'failed-definitive', 'outcome-unknown') AND
              dispatch_metadata_json IS NOT NULL AND
              terminal_evidence_json IS NOT NULL AND
              dispatched_at IS NOT NULL AND terminal_at IS NOT NULL)
          )
        ) STRICT;
        CREATE INDEX IF NOT EXISTS model_call_operations_status_cursor
          ON model_call_operations(status, updated_at, call_operation_id);
        CREATE INDEX IF NOT EXISTS model_call_operations_delivery_cursor
          ON model_call_operations(
            response_delivered_at, updated_at, call_operation_id
          );
        CREATE TABLE IF NOT EXISTS model_binding_prompt_high_water (
          binding_id TEXT PRIMARY KEY
            CHECK (length(binding_id) BETWEEN 1 AND 128),
          finalized_prompt_sequence INTEGER NOT NULL
            CHECK (finalized_prompt_sequence >= 0),
          updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
        ) STRICT;
      `)
      this.#statements = {
        get: database.prepare(
          'SELECT * FROM model_call_operations WHERE call_operation_id = ?'
        ),
        getAuthority: database.prepare(
          `SELECT * FROM model_prompt_authorities
           WHERE binding_id = ? AND prompt_operation_id = ?`
        ),
        insert: database.prepare(
          `INSERT INTO model_call_operations (
            call_operation_id, binding_id, prompt_operation_id, round_index,
            identity_json, request_digest, model_profile_digest,
            maximum_model_calls, maximum_total_output_tokens,
            maximum_output_tokens, status, prepared_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`
        ),
        insertAuthority: database.prepare(
          `INSERT INTO model_prompt_authorities (
            binding_id, prompt_operation_id, model_profile_digest, provider,
            profile, model, protocol, maximum_model_calls,
            maximum_total_output_tokens, reserved_output_tokens,
            high_water_round, latest_call_operation_id, latest_status,
            latest_response_delivered, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 0, ?)`
        ),
        advanceAuthority: database.prepare(
          `UPDATE model_prompt_authorities
           SET high_water_round = ?, latest_call_operation_id = ?,
               latest_status = 'prepared', latest_response_delivered = 0,
               updated_at = ?
           WHERE binding_id = ? AND prompt_operation_id = ?
             AND high_water_round = ? AND latest_status = 'completed'
             AND latest_response_delivered = 1`
        ),
        claim: database.prepare(
          `UPDATE model_call_operations
           SET status = 'dispatched', dispatch_metadata_json = ?,
               dispatched_at = ?, updated_at = ?
           WHERE call_operation_id = ? AND status = 'prepared'`
        ),
        markAuthorityDispatched: database.prepare(
          `UPDATE model_prompt_authorities
           SET latest_status = 'dispatched', updated_at = ?
           WHERE binding_id = ? AND prompt_operation_id = ?
             AND latest_call_operation_id = ? AND latest_status = 'prepared'`
        ),
        terminal: database.prepare(
          `UPDATE model_call_operations
           SET status = ?, terminal_evidence_json = ?,
               terminal_at = ?, updated_at = ?
           WHERE call_operation_id = ? AND status = 'dispatched'`
        ),
        markAuthorityTerminal: database.prepare(
          `UPDATE model_prompt_authorities
           SET latest_status = ?, latest_response_delivered = 0, updated_at = ?
           WHERE binding_id = ? AND prompt_operation_id = ?
             AND latest_call_operation_id = ? AND latest_status = 'dispatched'`
        ),
        deliver: database.prepare(
          `UPDATE model_call_operations
           SET response_delivered_at = ?, updated_at = ?
           WHERE call_operation_id = ? AND status = 'completed'
             AND response_delivered_at IS NULL`
        ),
        markAuthorityDelivered: database.prepare(
          `UPDATE model_prompt_authorities
           SET latest_response_delivered = 1, updated_at = ?
           WHERE binding_id = ? AND prompt_operation_id = ?
             AND latest_call_operation_id = ? AND latest_status = 'completed'
             AND latest_response_delivered = 0`
        ),
        unresolved: database.prepare(
          `SELECT * FROM model_call_operations
           WHERE status IN ('prepared', 'dispatched', 'outcome-unknown')
           ORDER BY updated_at ASC, call_operation_id ASC LIMIT ?`
        ),
        count: database.prepare(
          'SELECT COUNT(*) AS count FROM model_call_operations'
        ),
        countAuthorities: database.prepare(
          'SELECT COUNT(*) AS count FROM model_prompt_authorities'
        ),
        getPromptHighWater: database.prepare(
          `SELECT finalized_prompt_sequence
           FROM model_binding_prompt_high_water WHERE binding_id = ?`
        ),
        advancePromptHighWater: database.prepare(
          `INSERT INTO model_binding_prompt_high_water (
             binding_id, finalized_prompt_sequence, updated_at
           ) VALUES (?, ?, ?)
           ON CONFLICT(binding_id) DO UPDATE SET
             finalized_prompt_sequence = excluded.finalized_prompt_sequence,
             updated_at = excluded.updated_at
           WHERE model_binding_prompt_high_water.finalized_prompt_sequence =
             excluded.finalized_prompt_sequence - 1`
        ),
        deleteAuthority: database.prepare(
          `DELETE FROM model_prompt_authorities
           WHERE binding_id = ? AND prompt_operation_id = ?`
        ),
        pruneTerminal: database.prepare(
          `DELETE FROM model_call_operations
           WHERE call_operation_id IN (
             SELECT call_operation_id FROM model_call_operations
             WHERE status = 'failed-definitive'
                OR (status = 'completed' AND response_delivered_at IS NOT NULL)
             ORDER BY terminal_at ASC, call_operation_id ASC LIMIT ?
           )`
        ),
        pruneTerminalOlderThan: database.prepare(
          `DELETE FROM model_call_operations
           WHERE call_operation_id IN (
             SELECT call_operation_id FROM model_call_operations
             WHERE (status = 'failed-definitive'
                OR (status = 'completed' AND response_delivered_at IS NOT NULL))
               AND terminal_at < ?
             ORDER BY terminal_at ASC, call_operation_id ASC LIMIT ?
           )`
        )
      }
      this.#database = database
    } catch (error) {
      try {
        database.close()
      } catch {
        // Preserve the initialization error while still attempting cleanup.
      }
      throw error
    }
  }

  prepare(input: PrepareModelCall): {
    created: boolean
    record: ModelCallRecord
  } {
    this.#assertOpen()
    const parsed = prepareModelCallSchema.parse(input)
    const identityJson = JSON.stringify(parsed.identity)
    return this.#transaction(() => {
      const existing = this.#getRow(parsed.identity.callOperationId)
      if (existing) {
        if (!samePreparation(existing, parsed, identityJson)) {
          throw new ModelCallConflictError()
        }
        return { created: false, record: rowToRecord(existing) }
      }

      const authority = this.#getAuthority(
        parsed.identity.bindingId,
        parsed.identity.promptOperationId
      )
      const finalizedPromptSequence = this.#getPromptHighWater(
        parsed.identity.bindingId
      )
      if (authority) {
        assertPinnedAuthority(authority, parsed)
        if (parsed.identity.roundIndex <= authority.high_water_round) {
          throw new ModelCallConflictError(
            'Model call round was already reserved with different evidence'
          )
        }
        if (parsed.identity.roundIndex !== authority.high_water_round + 1) {
          throw new ModelCallStateError('Model call rounds cannot be skipped')
        }
        if (
          authority.latest_status !== 'completed' ||
          authority.latest_response_delivered !== 1
        ) {
          throw new ModelCallStateError(
            'Previous model response has not been completed and delivered'
          )
        }
      } else if (parsed.identity.roundIndex !== 0) {
        throw new ModelCallStateError('First model call round must be zero')
      }

      if (!authority) {
        const expectedPromptSequence =
          finalizedPromptSequence === undefined
            ? 0
            : finalizedPromptSequence + 1
        if (
          parsed.identity.promptSequence !== expectedPromptSequence
        ) {
          throw new ModelCallConflictError(
            parsed.identity.promptSequence <=
              (finalizedPromptSequence ?? -1)
              ? 'Model prompt sequence was already finalized'
              : 'Model prompt sequences cannot be skipped'
          )
        }
      }

      if (!authority) {
        const authorityCount = this.#statements.countAuthorities.get() as
          | { count: number }
          | undefined
        if (
          !authorityCount ||
          !Number.isSafeInteger(authorityCount.count) ||
          authorityCount.count < 0
        ) {
          throw new ModelCallStateError(
            'Model prompt authority count is corrupt'
          )
        }
        if (authorityCount.count >= this.#maximumAuthorities) {
          throw new ModelCallCapacityError(
            'Model prompt authority capacity reached'
          )
        }
      }
      this.#ensureCapacityForPrepare()
      const now = this.#timestamp()
      this.#statements.insert.run(
        parsed.identity.callOperationId,
        parsed.identity.bindingId,
        parsed.identity.promptOperationId,
        parsed.identity.roundIndex,
        identityJson,
        parsed.requestDigest,
        parsed.modelProfileDigest,
        LEGACY_UNBOUNDED_QUOTA,
        LEGACY_UNBOUNDED_QUOTA,
        LEGACY_UNBOUNDED_QUOTA,
        now,
        now
      )
      if (authority) {
        const advanced = this.#statements.advanceAuthority.run(
          parsed.identity.roundIndex,
          parsed.identity.callOperationId,
          now,
          parsed.identity.bindingId,
          parsed.identity.promptOperationId,
          authority.high_water_round
        )
        if (Number(advanced.changes) !== 1) {
          throw new ModelCallStateError(
            'Concurrent model call round reservation rejected'
          )
        }
      } else {
        this.#statements.insertAuthority.run(
          parsed.identity.bindingId,
          parsed.identity.promptOperationId,
          parsed.modelProfileDigest,
          parsed.identity.provider,
          parsed.identity.profile,
          parsed.identity.model,
          parsed.identity.protocol,
          LEGACY_UNBOUNDED_QUOTA,
          LEGACY_UNBOUNDED_QUOTA,
          LEGACY_UNBOUNDED_QUOTA,
          parsed.identity.roundIndex,
          parsed.identity.callOperationId,
          now
        )
      }
      return {
        created: true,
        record: rowToRecord(this.#requireRow(parsed.identity.callOperationId))
      }
    })
  }

  get(callOperationId: string): ModelCallRecord | undefined {
    this.#assertOpen()
    const id = modelCallIdentitySchema.shape.callOperationId.parse(callOperationId)
    const row = this.#getRow(id)
    return row ? rowToRecord(row) : undefined
  }

  beginDispatch(
    callOperationId: string,
    metadata: ModelCallDispatchMetadata = {}
  ): { permitted: boolean; record: ModelCallRecord } {
    this.#assertOpen()
    const id = modelCallIdentitySchema.shape.callOperationId.parse(callOperationId)
    const metadataJson = JSON.stringify(
      modelCallDispatchMetadataSchema.parse(metadata)
    )
    return this.#transaction(() => {
      const existing = this.#requireRow(id)
      if (modelCallStatusSchema.parse(existing.status) !== 'prepared') {
        return { permitted: false, record: rowToRecord(existing) }
      }
      const now = this.#timestamp()
      if (
        Number(this.#statements.claim.run(metadataJson, now, now, id).changes) !==
        1
      ) {
        return { permitted: false, record: rowToRecord(this.#requireRow(id)) }
      }
      if (
        Number(
          this.#statements.markAuthorityDispatched.run(
            now,
            existing.binding_id,
            existing.prompt_operation_id,
            id
          ).changes
        ) !== 1
      ) {
        throw new ModelCallStateError('Prompt dispatch authority is inconsistent')
      }
      return { permitted: true, record: rowToRecord(this.#requireRow(id)) }
    })
  }

  complete(
    callOperationId: string,
    evidence: CompleteModelCallEvidence
  ): ModelCallRecord {
    return this.#finish(
      callOperationId,
      'completed',
      completeModelCallEvidenceSchema.parse(evidence)
    )
  }

  failDefinitive(
    callOperationId: string,
    evidence: FailModelCallEvidence
  ): ModelCallRecord {
    return this.#finish(
      callOperationId,
      'failed-definitive',
      failModelCallEvidenceSchema.parse(evidence)
    )
  }

  markOutcomeUnknown(
    callOperationId: string,
    evidence: UnknownModelCallEvidence
  ): ModelCallRecord {
    return this.#finish(
      callOperationId,
      'outcome-unknown',
      unknownModelCallEvidenceSchema.parse(evidence)
    )
  }

  markResponseDelivered(callOperationId: string): ModelCallRecord {
    this.#assertOpen()
    const id = modelCallIdentitySchema.shape.callOperationId.parse(callOperationId)
    return this.#transaction(() => {
      const existing = this.#requireRow(id)
      if (existing.status !== 'completed') {
        throw new ModelCallStateError(
          'Only completed model responses can be marked delivered'
        )
      }
      if (existing.response_delivered_at !== null) {
        return rowToRecord(existing)
      }
      const now = this.#timestamp()
      if (
        Number(this.#statements.deliver.run(now, now, id).changes) !== 1 ||
        Number(
          this.#statements.markAuthorityDelivered.run(
            now,
            existing.binding_id,
            existing.prompt_operation_id,
            id
          ).changes
        ) !== 1
      ) {
        throw new ModelCallStateError(
          'Concurrent response delivery transition rejected'
        )
      }
      return rowToRecord(this.#requireRow(id))
    })
  }

  finalizePrompt(input: {
    bindingId: string
    promptOperationId: string
    promptSequence: number
  }): void {
    this.#assertOpen()
    const bindingId =
      modelCallIdentitySchema.shape.bindingId.parse(input.bindingId)
    const promptOperationId =
      modelCallIdentitySchema.shape.promptOperationId.parse(
        input.promptOperationId
      )
    const promptSequence =
      modelCallIdentitySchema.shape.promptSequence.parse(
        input.promptSequence
      )
    this.#transaction(() => {
      const finalized = this.#getPromptHighWater(bindingId)
      if (finalized !== undefined) {
        if (finalized === promptSequence) {
          return
        }
        if (finalized > promptSequence) {
          throw new ModelCallConflictError(
            'Model prompt sequence was already finalized'
          )
        }
        if (promptSequence !== finalized + 1) {
          throw new ModelCallStateError(
            'Model prompt sequences cannot be finalized out of order'
          )
        }
      } else if (promptSequence !== 0) {
        throw new ModelCallStateError(
          'First finalized model prompt sequence must be zero'
        )
      }

      const authority = this.#getAuthority(
        bindingId,
        promptOperationId
      )
      if (authority !== undefined) {
        if (
          authority.latest_status !== 'completed' ||
          authority.latest_response_delivered !== 1
        ) {
          throw new ModelCallStateError(
            'Only a fully delivered model prompt can be finalized'
          )
        }
      }
      const now = this.#timestamp()
      if (
        Number(
          this.#statements.advancePromptHighWater.run(
            bindingId,
            promptSequence,
            now
          ).changes
        ) !== 1
      ) {
        throw new ModelCallStateError(
          'Concurrent model prompt finalization rejected'
        )
      }
      if (
        authority !== undefined &&
        Number(
          this.#statements.deleteAuthority.run(
            bindingId,
            promptOperationId
          ).changes
        ) !== 1
      ) {
        throw new ModelCallStateError(
          'Model prompt authority finalization is inconsistent'
        )
      }
    })
  }

  list(options: ModelCallListOptions = {}): ModelCallOperationPage {
    this.#assertOpen()
    const parsed = modelCallListOptionsSchema.parse(options)
    const clauses: string[] = []
    const parameters: Array<string | number> = []
    if (parsed.statuses) {
      clauses.push(
        `status IN (${parsed.statuses.map(() => '?').join(', ')})`
      )
      parameters.push(...parsed.statuses)
    }
    if (parsed.delivery === 'pending-response') {
      clauses.push("status = 'completed' AND response_delivered_at IS NULL")
    } else if (parsed.delivery === 'delivered') {
      clauses.push("status = 'completed' AND response_delivered_at IS NOT NULL")
    }
    if (parsed.cursor) {
      clauses.push(
        '(updated_at > ? OR (updated_at = ? AND call_operation_id > ?))'
      )
      parameters.push(
        parsed.cursor.updatedAt,
        parsed.cursor.updatedAt,
        parsed.cursor.callOperationId
      )
    }
    const rows = this.#database
      .prepare(
        `SELECT * FROM model_call_operations
         ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
         ORDER BY updated_at ASC, call_operation_id ASC LIMIT ?`
      )
      .all(...parameters, parsed.limit + 1) as unknown as ModelCallRow[]
    return makePage(rows, parsed.limit)
  }

  listStartupRecords(
    options: Pick<ModelCallListOptions, 'cursor' | 'limit'> = {}
  ): ModelCallOperationPage {
    this.#assertOpen()
    const parsed = modelCallListOptionsSchema
      .pick({ cursor: true, limit: true })
      .parse(options)
    const parameters: Array<string | number> = []
    let cursorClause = ''
    if (parsed.cursor) {
      cursorClause =
        'AND (updated_at > ? OR (updated_at = ? AND call_operation_id > ?))'
      parameters.push(
        parsed.cursor.updatedAt,
        parsed.cursor.updatedAt,
        parsed.cursor.callOperationId
      )
    }
    const rows = this.#database
      .prepare(
        `SELECT * FROM model_call_operations
         WHERE (
           status = 'prepared' OR status = 'dispatched' OR
           status = 'outcome-unknown' OR
           (status = 'completed' AND response_delivered_at IS NULL)
         ) ${cursorClause}
         ORDER BY updated_at ASC, call_operation_id ASC LIMIT ?`
      )
      .all(...parameters, parsed.limit + 1) as unknown as ModelCallRow[]
    return makePage(rows, parsed.limit)
  }

  listUnresolved(limit = 100): ModelCallRecord[] {
    this.#assertOpen()
    const parsedLimit = modelCallListLimitSchema.parse(limit)
    return (
      this.#statements.unresolved.all(parsedLimit) as unknown as ModelCallRow[]
    ).map(rowToRecord)
  }

  pruneTerminal(limit: number, olderThan?: number): number {
    this.#assertOpen()
    const parsedLimit = pruneLimitSchema.parse(limit)
    const parsedOlderThan =
      olderThan === undefined ? undefined : timestampSchema.parse(olderThan)
    return this.#transaction(() => {
      const result =
        parsedOlderThan === undefined
          ? this.#statements.pruneTerminal.run(parsedLimit)
          : this.#statements.pruneTerminalOlderThan.run(
              parsedOlderThan,
              parsedLimit
            )
      return Number(result.changes)
    })
  }

  close(): void {
    if (!this.#closed) {
      this.#database.close()
      this.#closed = true
    }
  }

  dispose(): void {
    this.close()
  }

  #finish(
    callOperationId: string,
    status: Exclude<ModelCallStatus, 'prepared' | 'dispatched'>,
    evidence:
      | CompleteModelCallEvidence
      | FailModelCallEvidence
      | UnknownModelCallEvidence
  ): ModelCallRecord {
    this.#assertOpen()
    const id = modelCallIdentitySchema.shape.callOperationId.parse(callOperationId)
    if (evidence.status !== status) {
      throw new ModelCallStateError('Terminal evidence status does not match')
    }
    const evidenceJson = JSON.stringify(evidence)
    return this.#transaction(() => {
      const existing = this.#requireRow(id)
      const currentStatus = modelCallStatusSchema.parse(existing.status)
      if (currentStatus === status) {
        if (existing.terminal_evidence_json !== evidenceJson) {
          throw new ModelCallConflictError('Terminal evidence does not match')
        }
        return rowToRecord(existing)
      }
      if (currentStatus !== 'dispatched') {
        throw new ModelCallStateError(
          `Cannot transition model call from ${currentStatus} to ${status}`
        )
      }
      const now = this.#timestamp()
      if (
        Number(
          this.#statements.terminal.run(
            status,
            evidenceJson,
            now,
            now,
            id
          ).changes
        ) !== 1 ||
        Number(
          this.#statements.markAuthorityTerminal.run(
            status,
            now,
            existing.binding_id,
            existing.prompt_operation_id,
            id
          ).changes
        ) !== 1
      ) {
        throw new ModelCallStateError(
          'Concurrent model call transition rejected'
        )
      }
      return rowToRecord(this.#requireRow(id))
    })
  }

  #getRow(callOperationId: string): ModelCallRow | undefined {
    return this.#statements.get.get(callOperationId) as
      | ModelCallRow
      | undefined
  }

  #requireRow(callOperationId: string): ModelCallRow {
    const row = this.#getRow(callOperationId)
    if (!row) {
      throw new ModelCallStateError('Model call operation does not exist')
    }
    return row
  }

  #getAuthority(
    bindingId: string,
    promptOperationId: string
  ): PromptAuthorityRow | undefined {
    return this.#statements.getAuthority.get(
      bindingId,
      promptOperationId
    ) as PromptAuthorityRow | undefined
  }

  #getPromptHighWater(bindingId: string): number | undefined {
    const row = this.#statements.getPromptHighWater.get(
      bindingId
    ) as PromptHighWaterRow | undefined
    if (row === undefined) {
      return undefined
    }
    if (
      !Number.isSafeInteger(row.finalized_prompt_sequence) ||
      row.finalized_prompt_sequence < 0
    ) {
      throw new ModelCallStateError(
        'Model prompt sequence high-water is corrupt'
      )
    }
    return row.finalized_prompt_sequence
  }

  #timestamp(): number {
    return timestampSchema.parse(this.#now())
  }

  #ensureCapacityForPrepare(): void {
    const row = this.#statements.count.get() as { count: number } | undefined
    if (!row || !Number.isSafeInteger(row.count) || row.count < 0) {
      throw new ModelCallStateError('Model call operation count is corrupt')
    }
    const recordsToRemove = row.count - this.#maximumRecords + 1
    if (recordsToRemove <= 0) {
      return
    }
    const removed = Number(
      this.#statements.pruneTerminal.run(recordsToRemove).changes
    )
    if (removed !== recordsToRemove) {
      throw new ModelCallCapacityError()
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
        // Preserve the action or commit error that caused the rollback.
      }
      throw error
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ModelCallStateError('Model call operation store is closed')
    }
  }
}

const timestampSchema = modelCallRecordSchema.shape.updatedAt
const modelCallListLimitSchema = modelCallRecordSchema.shape.preparedAt
  .positive()
  .max(1_000)
const maximumRecordsSchema = modelCallRecordSchema.shape.preparedAt
  .positive()
  .max(1_000_000)
const pruneLimitSchema = modelCallRecordSchema.shape.preparedAt
  .positive()
  .max(1_000)

function samePreparation(
  row: ModelCallRow,
  input: PrepareModelCall,
  identityJson: string
): boolean {
  return (
    row.identity_json === identityJson &&
    row.request_digest === input.requestDigest &&
    row.model_profile_digest === input.modelProfileDigest
  )
}

function assertPinnedAuthority(
  authority: PromptAuthorityRow,
  input: PrepareModelCall
): void {
  const identity = input.identity
  if (
    authority.model_profile_digest !== input.modelProfileDigest ||
    authority.provider !== identity.provider ||
    authority.profile !== identity.profile ||
    authority.model !== identity.model ||
    authority.protocol !== identity.protocol
  ) {
    throw new ModelCallConflictError(
      'Prompt model profile or budget authority cannot change'
    )
  }
}

function makePage(rows: ModelCallRow[], limit: number): ModelCallOperationPage {
  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const records = pageRows.map(rowToRecord)
  const last = pageRows.at(-1)
  return {
    records,
    ...(hasMore && last
      ? {
          nextCursor: {
            updatedAt: last.updated_at,
            callOperationId: last.call_operation_id
          }
        }
      : {})
  }
}

function rowToRecord(row: ModelCallRow): ModelCallRecord {
  try {
    return modelCallRecordSchema.parse({
      identity: decodeJson(row.identity_json, 'identity'),
      requestDigest: row.request_digest,
      modelProfileDigest: row.model_profile_digest,
      status: row.status,
      ...(row.dispatch_metadata_json === null
        ? {}
        : {
            dispatchMetadata: decodeJson(
              row.dispatch_metadata_json,
              'dispatch metadata'
            )
          }),
      ...(row.terminal_evidence_json === null
        ? {}
        : {
            terminalEvidence: decodeJson(
              row.terminal_evidence_json,
              'terminal evidence'
            )
          }),
      preparedAt: row.prepared_at,
      updatedAt: row.updated_at,
      ...(row.dispatched_at === null
        ? {}
        : { dispatchedAt: row.dispatched_at }),
      ...(row.terminal_at === null ? {} : { terminalAt: row.terminal_at }),
      ...(row.response_delivered_at === null
        ? {}
        : { responseDeliveredAt: row.response_delivered_at })
    })
  } catch {
    throw new ModelCallStateError('Stored model call record is corrupt')
  }
}

function decodeJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new ModelCallStateError(`Stored model call ${label} is corrupt`)
  }
}
