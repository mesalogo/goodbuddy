import {
  activityHistoryPageRequestSchema,
  activityHistoryReconcileRequestSchema,
  activityHistorySnapshotSchema,
  activityHistorySummaryRequestSchema,
  activityHistoryUpdateSchema,
  activityRecordSchema,
  type ActivityHistoryPage,
  type ActivityHistorySnapshot,
  type ActivityHistorySummary,
  type ActivityHistoryUpdateResult,
  type ActivityRecord
} from '../../shared/assistant-contracts'
import {
  activityRecordKey,
  isActivityHistoryPlanEmpty,
  parseActivityHistorySnapshot,
  planActivityHistoryReplace,
  type ActivityHistoryPlan,
  type ActivityHistoryState
} from './activity-history-plan'

/**
 * The connection the repository runs on; AssistantDatabase owns and passes
 * it, so this module does not import node:sqlite itself (PERF-16 allowlist).
 */
type SqlValue = string | number | bigint | null | Uint8Array
type Connection = {
  readonly isTransaction: boolean
  exec: (sql: string) => void
  prepare: (sql: string) => {
    all: (...args: SqlValue[]) => unknown[]
    get: (...args: SqlValue[]) => unknown
    run: (...args: SqlValue[]) => { changes: number | bigint }
  }
}

/**
 * Activity history storage (PERF-15). Every record is one row of
 * activity_history_records:
 * - `record_key` = JSON `[id, occurrence]`: legacy history may hold an ID more
 *   than once; only occurrence 0 (the first in list order) is shown.
 * - `order_seq`: list position, newer = larger. A move to the front assigns a
 *   new maximum, so no order list is rewritten.
 * - `record_id`, `occurrence`, `status`, `status_group`, `kind`,
 *   `request_id`, `conversation_id`, `project_id`, `created_at`: stored
 *   columns generated from the key and JSON, indexed for pages, counts and
 *   updates; they cannot disagree with the record.
 * The singleton activity_history row keeps only the legacy-incomplete flag.
 */
const recordsTableSql = (name: string): string => `
  CREATE TABLE ${name} (
    record_key TEXT PRIMARY KEY NOT NULL,
    record_json TEXT NOT NULL,
    order_seq INTEGER NOT NULL,
    record_id TEXT GENERATED ALWAYS AS (json_extract(record_key, '$[0]')) STORED,
    occurrence INTEGER GENERATED ALWAYS AS (json_extract(record_key, '$[1]')) STORED,
    status TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.status')) STORED,
    status_group TEXT GENERATED ALWAYS AS (CASE json_extract(record_json, '$.status')
      WHEN 'pending' THEN 'active' WHEN 'running' THEN 'active'
      WHEN 'completed' THEN 'other' ELSE 'failed' END) STORED,
    kind TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.kind')) STORED,
    request_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.requestId')) STORED,
    conversation_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.conversationId')) STORED,
    project_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.scope.projectId')) STORED,
    created_at REAL GENERATED ALWAYS AS (json_extract(record_json, '$.createdAt')) STORED
  )`

/** Schema 57: order and indexed columns; replaces the record_order_json list. */
export function migrateActivityHistoryOrder(database: Connection): void {
  const columns = database.prepare(
    "SELECT name FROM pragma_table_xinfo('activity_history_records')"
  ).all() as Array<{ name: string }>
  // Re-running the migration (a lowered user_version) changes nothing.
  if (columns.some((column) => column.name === 'status_group')) return
  // Tables created by the schema-44 migration of this version already carry the order.
  const hasOrder = columns.some((column) => column.name === 'order_seq')
  const header = database.prepare(
    'SELECT record_order_json FROM activity_history WHERE singleton = 1'
  ).get() as { record_order_json: string } | undefined
  database.exec(recordsTableSql('activity_history_records_v57'))
  if (hasOrder) {
    database.exec(`INSERT INTO activity_history_records_v57 (record_key, record_json, order_seq)
      SELECT record_key, record_json, order_seq FROM activity_history_records`)
  } else {
    // The stored order lists every row once; rows outside it were never shown.
    database.prepare(`
      INSERT INTO activity_history_records_v57 (record_key, record_json, order_seq)
      SELECT records.record_key, records.record_json, json_array_length(?1) - CAST(ordering.key AS INTEGER)
      FROM json_each(?1) AS ordering
      JOIN activity_history_records AS records ON records.record_key = ordering.value
    `).run(header?.record_order_json ?? '[]')
  }
  database.exec(`
    DROP TABLE activity_history_records;
    ALTER TABLE activity_history_records_v57 RENAME TO activity_history_records;
    UPDATE activity_history SET record_order_json = '[]' WHERE singleton = 1;
    CREATE INDEX activity_history_records_order ON activity_history_records(occurrence, order_seq);
    CREATE INDEX activity_history_records_group ON activity_history_records(occurrence, status_group, order_seq);
    CREATE INDEX activity_history_records_conversation ON activity_history_records(conversation_id, occurrence,
      order_seq, kind, status, request_id, created_at, record_key);
    CREATE INDEX activity_history_records_project ON activity_history_records(project_id, occurrence, order_seq);
    CREATE INDEX activity_history_records_request ON activity_history_records(request_id, kind);
    CREATE INDEX activity_history_records_id ON activity_history_records(record_id);
  `)
}
type SummaryRow = {
  conversation_id: string
  kind: ActivityRecord['kind']
  status: ActivityRecord['status']
  request_id: string
  created_at: number
  record_key: string
}

/**
 * Title (first request in list order) and status (the latest request's
 * latest result, else the latest result, else the latest record) of one
 * conversation; `rows` are newest first, so createdAt ties resolve to the
 * record nearer the front, as the former full-list computation did.
 */
function summarizeConversation(
  rows: readonly SummaryRow[],
  titles: ReadonlyMap<string, string>
): { title?: string; status: ActivityRecord['status'] } {
  const latest = (match: (row: SummaryRow) => boolean): SummaryRow | undefined => {
    let best: SummaryRow | undefined
    for (const row of rows) if (match(row) && (!best || row.created_at > best.created_at)) best = row
    return best
  }
  const firstRequest = rows.find((row) => row.kind === 'request')
  const title = firstRequest ? titles.get(firstRequest.record_key) : undefined
  const request = latest((row) => row.kind === 'request')
  const status = request
    ? (latest((row) => row.kind === 'result' && row.request_id === request.request_id)?.status ?? request.status)
    : (latest((row) => row.kind === 'result')?.status ?? latest(() => true)?.status ?? 'completed')
  return { ...(title === undefined ? {} : { title }), status }
}

function parseRow(json: string): ActivityRecord {
  return activityRecordSchema.parse(JSON.parse(json))
}

export class ActivityHistoryRepository {
  /** Validated rows of the last committed replace, reused by the next one. */
  private replaceCache?: { state: ActivityHistoryState; dataVersion: number }

  constructor(private readonly database: Connection) {}

  /** Drops cached rows after writes that bypass the repository. */
  invalidate(): void {
    this.replaceCache = undefined
  }

  /** The whole stored list, every occurrence, newest first. */
  snapshot(): ActivityHistorySnapshot {
    const rows = this.database.prepare(
      'SELECT record_json FROM activity_history_records ORDER BY order_seq DESC, record_key'
    ).all() as Array<{ record_json: string }>
    return activityHistorySnapshotSchema.parse({
      records: rows.map((row) => JSON.parse(row.record_json) as unknown),
      legacyHistoryMayBeIncomplete: this.readIncomplete()
    })
  }

  /** One page of shown records, newest first, by index. */
  page(input: unknown): ActivityHistoryPage {
    const request = activityHistoryPageRequestSchema.parse(input)
    const where = ['occurrence = 0']
    const args: Array<string | number> = []
    if (request.before !== undefined) {
      where.push('order_seq < ?')
      args.push(request.before)
    }
    if (request.filter && request.filter !== 'all') {
      where.push('status_group = ?')
      args.push(request.filter)
    }
    if (request.projectId) {
      where.push('project_id = ?')
      args.push(request.projectId)
    }
    if (request.conversationId) {
      where.push('conversation_id = ?')
      args.push(request.conversationId)
    }
    const rows = this.database.prepare(
      `SELECT order_seq, record_json FROM activity_history_records
       WHERE ${where.join(' AND ')} ORDER BY order_seq DESC LIMIT ?`
    ).all(...args, request.limit + 1) as Array<{ order_seq: number; record_json: string }>
    const more = rows.length > request.limit
    const shown = more ? rows.slice(0, request.limit) : rows
    return {
      records: shown.map((row) => parseRow(row.record_json)),
      ...(more ? { nextBefore: shown.at(-1)!.order_seq } : {})
    }
  }

  /** What the Activity page derives from the whole history. */
  summary(input: unknown): ActivityHistorySummary {
    const request = activityHistorySummaryRequestSchema.parse(input)
    const groupRows = this.database.prepare(
      `SELECT status_group AS status_group, COUNT(*) AS count FROM activity_history_records
       WHERE occurrence = 0 GROUP BY status_group`
    ).all() as Array<{ status_group: 'active' | 'failed' | 'other'; count: number }>
    const counts = { all: 0, active: 0, failed: 0 }
    for (const { status_group: group, count } of groupRows) {
      counts.all += count
      if (group !== 'other') counts[group] += count
    }
    // One indexed read of the requested conversations' rows, newest first.
    const rows = this.database.prepare(
      `SELECT conversation_id, kind, status, request_id, created_at, record_key
       FROM activity_history_records
       WHERE conversation_id IN (SELECT value FROM json_each(?)) AND occurrence = 0
       ORDER BY conversation_id, order_seq DESC`
    ).all(JSON.stringify([...new Set(request.conversationIds)])) as SummaryRow[]
    const byConversation = new Map<string, SummaryRow[]>()
    for (const row of rows) {
      const own = byConversation.get(row.conversation_id)
      if (own) own.push(row)
      else byConversation.set(row.conversation_id, [row])
    }
    // Titles come from the first request row of each conversation only.
    const titleKeys = [...byConversation.values()].flatMap((own) => {
      const first = own.find((row) => row.kind === 'request')
      return first ? [first.record_key] : []
    })
    const titles = new Map((this.database.prepare(
      `SELECT record_key, json_extract(record_json, '$.title') AS title FROM activity_history_records
       WHERE record_key IN (SELECT value FROM json_each(?))`
    ).all(JSON.stringify(titleKeys)) as Array<{ record_key: string; title: string }>)
      .map((row) => [row.record_key, row.title]))
    const conversations: ActivityHistorySummary['conversations'] = {}
    for (const conversationId of new Set(request.conversationIds)) {
      conversations[conversationId] = summarizeConversation(byConversation.get(conversationId) ?? [], titles)
    }
    return { counts, conversations, legacyHistoryMayBeIncomplete: this.readIncomplete() }
  }

  /**
   * Ends pending/running records whose request is not running in this
   * window: without a task they become interrupted (with the given localized
   * line appended); with a finished task they take its status, except that
   * tool, approval and subagent records of a completed task become
   * interrupted. Returns the number of changed records.
   */
  reconcile(input: unknown): number {
    const request = activityHistoryReconcileRequestSchema.parse(input)
    return this.write(() => {
      const result = this.database.prepare(`
        WITH candidates AS (
          SELECT records.record_key,
            CASE
              WHEN tasks.id IS NULL THEN 'interrupted'
              WHEN tasks.status IN ('completed', 'failed', 'cancelled', 'interrupted') THEN tasks.status
            END AS terminal
          FROM activity_history_records AS records
          LEFT JOIN tasks ON tasks.id = records.request_id AND tasks.visible = 1
          WHERE records.occurrence = 0 AND records.status_group = 'active'
            AND records.request_id NOT IN (SELECT value FROM json_each(?1))
        )
        UPDATE activity_history_records SET record_json = json_set(record_json,
          '$.status', CASE
            WHEN candidates.terminal = 'completed' AND activity_history_records.kind IN ('tool', 'approval', 'subagent')
              THEN 'interrupted'
            ELSE candidates.terminal END,
          '$.detail', CASE
            WHEN candidates.terminal = 'interrupted'
              THEN json_extract(record_json, '$.detail') || char(10) || ?2
            ELSE json_extract(record_json, '$.detail') END)
        FROM candidates
        WHERE activity_history_records.record_key = candidates.record_key AND candidates.terminal IS NOT NULL
      `).run(JSON.stringify(request.activeRequestIds), request.interruptedDetail)
      return Number(result.changes)
    })
  }

  /**
   * Applies incremental changes in one transaction, without reading the
   * history. Returns the stored record of every upsert-call, which keeps
   * the id and createdAt of an earlier record of the call the renderer may
   * not have loaded.
   */
  update(input: unknown): ActivityHistoryUpdateResult {
    const update = activityHistoryUpdateSchema.parse(input)
    const calls: ActivityRecord[] = []
    this.write(() => {
      const database = this.database
      const nextSeq = database.prepare(
        'SELECT COALESCE(MAX(order_seq), 0) + 1 AS seq FROM activity_history_records'
      )
      const exists = database.prepare('SELECT 1 FROM activity_history_records WHERE record_key = ?')
      const insert = database.prepare(
        'INSERT INTO activity_history_records (record_key, record_json, order_seq) VALUES (?, ?, ?)'
      )
      const moveToFront = database.prepare(
        'UPDATE activity_history_records SET record_json = ?, order_seq = ? WHERE record_key = ?'
      )
      const replaceInPlace = database.prepare(
        'UPDATE activity_history_records SET record_json = ? WHERE record_key = ? AND record_json != ?'
      )
      const remove = database.prepare('DELETE FROM activity_history_records WHERE record_id = ?')
      const seq = (): number => (nextSeq.get() as { seq: number }).seq
      // Shown rows (first occurrences) a content-matched change applies to, newest first.
      type Row = { record_key: string; order_seq: number; record: ActivityRecord }
      const select = (where: string, limit: number, ...args: SqlValue[]): Row[] =>
        (database.prepare(
          `SELECT record_key, order_seq, record_json FROM activity_history_records
           WHERE occurrence = 0 AND ${where} ORDER BY order_seq DESC LIMIT ${limit}`
        ).all(...args) as Array<{ record_key: string; order_seq: number; record_json: string }>)
          .map((row) => ({ record_key: row.record_key, order_seq: row.order_seq, record: parseRow(row.record_json) }))
      const frontSeq = database.prepare(
        'SELECT MAX(order_seq) AS seq FROM activity_history_records WHERE occurrence = 0'
      )
      const rewrite = (key: string, record: ActivityRecord): void => {
        const json = JSON.stringify(activityRecordSchema.parse(record))
        replaceInPlace.run(json, key, json)
      }
      for (const change of update.changes) {
        switch (change.type) {
          case 'remove-duplicates':
            database.exec('DELETE FROM activity_history_records WHERE occurrence != 0')
            break
          case 'remove':
            remove.run(change.id)
            break
          case 'upsert': {
            // The first occurrence stays first when moved to the front, so its key is stable.
            const key = activityRecordKey(change.record.id, 0)
            const json = JSON.stringify(change.record)
            if (!exists.get(key)) insert.run(key, json, seq())
            else if (change.position === 'front') moveToFront.run(json, seq(), key)
            else replaceInPlace.run(json, key, json)
            break
          }
          case 'upsert-call': {
            const incoming = change.record
            const [existing] = select(
              "request_id = ? AND kind = ? AND json_extract(record_json, '$.callId') = ?", 1,
              incoming.requestId, incoming.kind, incoming.callId!
            )
            if (!existing) {
              insert.run(activityRecordKey(incoming.id, 0), JSON.stringify(incoming), seq())
              calls.push(incoming)
              break
            }
            const before = existing.record
            const unchanged = before.conversationId === incoming.conversationId && before.title === incoming.title &&
              before.detail === incoming.detail && before.status === incoming.status
            const front = existing.order_seq === (frontSeq.get() as { seq: number }).seq
            const next = unchanged ? before : { ...incoming, id: before.id, createdAt: before.createdAt, scope: before.scope }
            calls.push(next)
            if (unchanged && front) break
            moveToFront.run(JSON.stringify(activityRecordSchema.parse(next)), seq(), existing.record_key)
            break
          }
          case 'update-request':
            for (const row of select("request_id = ? AND kind = 'request'", -1, change.requestId)) {
              rewrite(row.record_key, { ...row.record, status: change.status, detail: change.detail ?? row.record.detail })
            }
            break
          case 'resolve-approval': {
            const [row] = select("conversation_id = ? AND kind = 'approval' AND status = 'pending'", 1,
              change.conversationId)
            if (row) {
              rewrite(row.record_key, { ...row.record, status: change.status, detail: `${row.record.detail}\n${change.detailLine}` })
            }
            break
          }
          case 'settle-request':
            for (const row of select("request_id = ? AND kind != 'request' AND status_group = 'active'", -1,
              change.requestId)) {
              rewrite(row.record_key, { ...row.record, status: change.status, detail: `${row.record.detail}\n${change.detailLine}` })
            }
            break
          case 'remove-request':
            for (const row of select('request_id = ?', -1, change.requestId)) remove.run(row.record.id)
            break
          case 'remove-call':
            for (const row of select(
              "request_id = ? AND kind = 'tool' AND json_extract(record_json, '$.callId') = ?", -1,
              change.requestId, change.callId
            )) remove.run(row.record.id)
            break
        }
      }
      if (update.legacyHistoryMayBeIncomplete !== undefined) {
        this.writeIncomplete(update.legacyHistoryMayBeIncomplete)
      }
    })
    return { calls }
  }

  /**
   * Persists a whole newest-first list (legacy migration). Unchanged records
   * are neither re-validated, re-serialized nor written; a fully unchanged
   * snapshot does not open a write transaction.
   */
  replace(input: unknown): void {
    // Reuse is safe even from a stale cache: cached records are validated copies.
    const { items, incomplete } = parseActivityHistorySnapshot(input, this.replaceCache?.state)
    const committed = this.committedState()
    const planned = committed && planActivityHistoryReplace(items, incomplete, committed)
    if (planned && isActivityHistoryPlanEmpty(planned)) return
    let result: ActivityHistoryPlan | undefined
    this.write(() => {
      const previous = committed && planned ? committed : this.readState()
      result = previous === committed && planned ? planned : planActivityHistoryReplace(items, incomplete, previous)
      this.applyPlan(result)
    })
    // Publish only committed records; a failed save must remain retryable.
    this.replaceCache = { state: result!.next, dataVersion: this.dataVersion() }
  }

  /** Writes a parsed legacy snapshot into empty tables (schema migrations). */
  writeSnapshot(snapshot: ActivityHistorySnapshot, onProgress?: (processed: number) => void): void {
    this.applyPlan(planActivityHistoryReplace(
      snapshot.records.map((record) => ({ record })), snapshot.legacyHistoryMayBeIncomplete,
      { entries: new Map(), incomplete: !snapshot.legacyHistoryMayBeIncomplete }, onProgress))
  }

  /** Deletes the whole history in one transaction. */
  clear(): void {
    this.write(() => {
      this.database.exec('DELETE FROM activity_history_records')
      this.writeIncomplete(false)
    })
  }

  private write<T>(body: () => T): T {
    const database = this.database
    this.replaceCache = undefined
    if (database.isTransaction) return body()
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = body()
      database.exec('COMMIT')
      return result
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  private dataVersion(): number {
    return (this.database.prepare('PRAGMA data_version').get() as { data_version: number }).data_version
  }

  /** The cached committed state, when no other connection committed since. */
  private committedState(): ActivityHistoryState | undefined {
    const cache = this.replaceCache
    if (!cache || this.database.isTransaction) return undefined
    return cache.dataVersion === this.dataVersion() ? cache.state : undefined
  }

  private readState(): ActivityHistoryState {
    const rows = this.database.prepare(
      'SELECT record_key, record_json, order_seq FROM activity_history_records'
    ).all() as Array<{ record_key: string; record_json: string; order_seq: number }>
    return {
      entries: new Map(rows.map((row) => [row.record_key, { json: row.record_json, seq: row.order_seq }])),
      incomplete: this.readIncomplete()
    }
  }

  private applyPlan(plan: ActivityHistoryPlan): void {
    const database = this.database
    if (plan.removes.length > 0) {
      const remove = database.prepare('DELETE FROM activity_history_records WHERE record_key = ?')
      for (const key of plan.removes) remove.run(key)
    }
    if (plan.upserts.length > 0) {
      const upsert = database.prepare(
        `INSERT INTO activity_history_records (record_key, record_json, order_seq) VALUES (?, ?, ?)
         ON CONFLICT(record_key) DO UPDATE SET record_json = excluded.record_json, order_seq = excluded.order_seq`
      )
      for (const [key, json, seq] of plan.upserts) upsert.run(key, json, seq)
    }
    if (plan.headerChanged) this.writeIncomplete(plan.next.incomplete)
  }

  private readIncomplete(): boolean {
    const row = this.database.prepare(
      'SELECT legacy_history_may_be_incomplete AS value FROM activity_history WHERE singleton = 1'
    ).get() as { value: number } | undefined
    return row?.value === 1
  }

  private writeIncomplete(value: boolean): void {
    this.database.prepare(
      'UPDATE activity_history SET legacy_history_may_be_incomplete = ? WHERE singleton = 1'
    ).run(Number(value))
  }
}
