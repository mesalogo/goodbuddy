import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { agentIdentifierSchema } from '../shared/agent-protocol/contracts'
import { openPrivateSqliteDatabase } from '../shared/node/private-sqlite-database'
import {
  parseSerializedLinuxRuntimeProcessIdentity,
  serializeLinuxRuntimeProcessIdentity,
  type LinuxRuntimeProcessIdentity
} from './runtime-process-identity'

export type RuntimeOwnerState = 'reserved' | 'running' | 'stopping'

export type RuntimeOwnerRecord = {
  ownerId: string
  launchId: string
  processId: string
  installationId: string
  ownerToken: string
  state: RuntimeOwnerState
  processIdentity?: LinuxRuntimeProcessIdentity
  createdAt: number
  updatedAt: number
}

type RuntimeOwnerRow = {
  owner_id: string
  launch_id: string
  process_id: string
  installation_id: string
  owner_token: string
  state: RuntimeOwnerState
  process_identity_json: string | null
  created_at: number
  updated_at: number
}

export class RuntimeOwnerRegistry {
  readonly #database: DatabaseSync
  readonly #now: () => number
  readonly #statements: {
    insert: StatementSync
    get: StatementSync
    listInstallation: StatementSync
    transition: StatementSync
    remove: StatementSync
  }

  constructor(path: string, options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now
    this.#database = openPrivateSqliteDatabase(path)
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS active_runtime_owners (
        owner_id TEXT PRIMARY KEY,
        launch_id TEXT NOT NULL UNIQUE,
        process_id TEXT NOT NULL UNIQUE,
        installation_id TEXT NOT NULL,
        owner_token TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('reserved', 'running', 'stopping')),
        process_identity_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS active_runtime_owners_installation
        ON active_runtime_owners(installation_id, created_at);
    `)
    this.#migrateLegacyRecords()
    this.#statements = {
      insert: this.#database.prepare(`
        INSERT INTO active_runtime_owners (
          owner_id, launch_id, process_id, installation_id, owner_token,
          state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)
      `),
      get: this.#database.prepare(
        'SELECT * FROM active_runtime_owners WHERE owner_id = ?'
      ),
      listInstallation: this.#database.prepare(`
        SELECT * FROM active_runtime_owners
        WHERE installation_id = ?
        ORDER BY created_at, owner_id
      `),
      transition: this.#database.prepare(`
        UPDATE active_runtime_owners
        SET state = ?, process_identity_json = ?, updated_at = ?
        WHERE owner_id = ? AND state = ?
      `),
      remove: this.#database.prepare(`
        DELETE FROM active_runtime_owners WHERE owner_id = ? AND state = ?
      `)
    }
  }

  reserve(input: Omit<
    RuntimeOwnerRecord,
    'state' | 'processIdentity' | 'createdAt' | 'updatedAt'
  >): RuntimeOwnerRecord {
    const record = validateReservation(input)
    const now = this.#now()
    this.#statements.insert.run(
      record.ownerId,
      record.launchId,
      record.processId,
      record.installationId,
      record.ownerToken,
      now,
      now
    )
    return { ...record, state: 'reserved', createdAt: now, updatedAt: now }
  }

  get(ownerIdInput: string): RuntimeOwnerRecord | undefined {
    const ownerId = agentIdentifierSchema.parse(ownerIdInput)
    const row = this.#statements.get.get(ownerId) as RuntimeOwnerRow | undefined
    return row === undefined ? undefined : decodeRow(row)
  }

  listForInstallation(installationIdInput: string): RuntimeOwnerRecord[] {
    const installationId = agentIdentifierSchema.parse(installationIdInput)
    return (
      this.#statements.listInstallation.all(installationId) as RuntimeOwnerRow[]
    ).map(decodeRow)
  }

  markRunning(
    ownerId: string,
    identity: LinuxRuntimeProcessIdentity
  ): RuntimeOwnerRecord {
    return this.#transition(ownerId, 'reserved', 'running', identity)
  }

  markStopping(ownerId: string): RuntimeOwnerRecord {
    return this.#transition(ownerId, 'running', 'stopping')
  }

  remove(ownerIdInput: string, from: RuntimeOwnerState): void {
    const ownerId = agentIdentifierSchema.parse(ownerIdInput)
    if (this.#statements.remove.run(ownerId, from).changes !== 1) {
      throw new Error(`Runtime owner transition conflict: expected ${from}`)
    }
  }

  close(): void {
    this.#database.close()
  }

  #transition(
    ownerIdInput: string,
    from: RuntimeOwnerState,
    to: RuntimeOwnerState,
    identity?: LinuxRuntimeProcessIdentity
  ): RuntimeOwnerRecord {
    const ownerId = agentIdentifierSchema.parse(ownerIdInput)
    const existing = this.get(ownerId)
    if (existing === undefined || existing.state !== from) {
      throw new Error(`Runtime owner transition conflict: expected ${from}`)
    }
    const processIdentity = identity ?? existing.processIdentity
    if (
      this.#statements.transition.run(
        to,
        processIdentity === undefined
          ? null
          : serializeLinuxRuntimeProcessIdentity(processIdentity),
        this.#now(),
        ownerId,
        from
      ).changes !== 1
    ) {
      throw new Error('Runtime owner transition conflict')
    }
    return this.get(ownerId)!
  }

  #migrateLegacyRecords(): void {
    const legacy = this.#database.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'runtime_process_owners'
    `).get()
    if (legacy === undefined) return
    this.#database.exec(`
      BEGIN IMMEDIATE;
      INSERT OR IGNORE INTO active_runtime_owners (
        owner_id, launch_id, process_id, installation_id, owner_token,
        state, process_identity_json, created_at, updated_at
      )
      SELECT owner_id, launch_id, process_id, installation_id, owner_token,
        state, process_identity_json, created_at, updated_at
      FROM runtime_process_owners
      WHERE state IN ('reserved', 'running', 'stopping');
      DROP TABLE runtime_process_owners;
      COMMIT;
    `)
  }
}

function validateReservation(
  input: Omit<
    RuntimeOwnerRecord,
    'state' | 'processIdentity' | 'createdAt' | 'updatedAt'
  >
): typeof input {
  agentIdentifierSchema.parse(input.ownerId)
  agentIdentifierSchema.parse(input.launchId)
  agentIdentifierSchema.parse(input.processId)
  agentIdentifierSchema.parse(input.installationId)
  if (!/^[a-f0-9]{32}$/u.test(input.ownerToken)) {
    throw new Error('Runtime owner token marker is malformed')
  }
  return { ...input }
}

function decodeRow(row: RuntimeOwnerRow): RuntimeOwnerRecord {
  return {
    ownerId: row.owner_id,
    launchId: row.launch_id,
    processId: row.process_id,
    installationId: row.installation_id,
    ownerToken: row.owner_token,
    state: row.state,
    ...(row.process_identity_json === null
      ? {}
      : {
          processIdentity: parseSerializedLinuxRuntimeProcessIdentity(
            row.process_identity_json
          )
        }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}
