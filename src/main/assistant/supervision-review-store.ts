import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { isIncrementalReview, type SupervisionEvidence, type SupervisionRunRequest, type SupervisionSummaryOutput } from '../../shared/supervision-contracts'
import type { SupervisionReviewBatch, SupervisionReviewProgress, SupervisionReviewSettings } from '../../shared/supervision-review-contracts'
import { setImmediate as yieldTurn } from 'node:timers/promises'
/**
 * Supervisor progress is one shared timeline: each source version is extracted once,
 * whichever scope reviewed it. Scopes only filter what a review reads and shows.
 */
export const TIMELINE_CHECKPOINT_SCOPE = 'timeline'

export type ReviewConfiguration = SupervisionReviewSettings & { timeoutSeconds: number; concurrency: number; version: 1 }
export type ReviewState = { request: SupervisionRunRequest; config: ReviewConfiguration; initializing?: boolean; restartRequired?: boolean; omittedSources?: number; phase?: SupervisionReviewProgress['phase']; stories?: SupervisionReviewProgress['stories'] }

export class ReviewSourcesOmitted extends Error {}

export type ReviewManifestRow = {
  source: string; revision: string; project_id: string; conversation_id: string;
  sequence: number; length: number; initial_offset: number
}
export type ReviewRevisionRow = Pick<ReviewManifestRow, 'source' | 'revision'>
/** Only read operations cross to the existing read worker. All writes stay here. */
export interface ReviewManifestReader {
  scan(state: ReviewState, signal?: AbortSignal): Promise<void>
  page(offset: number, signal?: AbortSignal): Promise<ReviewManifestRow[]>
  release(): Promise<void>
  changedSource(rows: ReviewRevisionRow[], signal?: AbortSignal): Promise<string | undefined>
}

// Only the manifest is materialized. Source bodies are read in bounded substrings.
export const supervisionReviewMigration = `
  CREATE TABLE supervision_review_runs (
    run_id TEXT PRIMARY KEY REFERENCES supervision_runs(id) ON DELETE CASCADE,
    state_json TEXT NOT NULL
  );
  CREATE TABLE supervision_review_sources (
    run_id TEXT NOT NULL REFERENCES supervision_review_runs(run_id) ON DELETE CASCADE,
    source TEXT NOT NULL, revision TEXT NOT NULL, project_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL, sequence INTEGER NOT NULL, length INTEGER NOT NULL,
    initial_offset INTEGER NOT NULL, processed_offset INTEGER NOT NULL,
    PRIMARY KEY(run_id, source)
  );
  CREATE INDEX supervision_review_pending ON supervision_review_sources(run_id, project_id, conversation_id, sequence, source);
  CREATE TABLE supervision_review_batches (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES supervision_review_runs(run_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    evidence_json TEXT NOT NULL, output_json TEXT NOT NULL, characters INTEGER NOT NULL
  );
  CREATE INDEX supervision_review_batch_run ON supervision_review_batches(run_id, project_id, conversation_id);
  CREATE TABLE supervision_review_navigation (
    run_id TEXT NOT NULL REFERENCES supervision_review_runs(run_id) ON DELETE CASCADE,
    id TEXT NOT NULL, children_json TEXT NOT NULL, output_json TEXT NOT NULL,
    PRIMARY KEY(run_id, id)
  );
  CREATE VIEW supervision_review_current AS
    SELECT 'message:' || m.id AS source, m.id AS record_id, 0 AS reference_index, 'conversation' AS type, c.id AS owner,
      c.project_id AS project_id, c.id AS conversation_id, m.sequence AS sequence,
      c.title AS title, m.created_at AS occurred, m.created_at AS alternate_time,
      m.content AS body,
      json_array(m.review_revision, c.project_id, c.title, m.role, m.created_at) AS context,
      json_object('messageId', m.id, 'conversationId', c.id, 'projectId', c.project_id, 'role', m.role, 'sequence', m.sequence) AS locator
    FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN projects p ON p.id = c.project_id
    WHERE c.status = 'active' AND p.status = 'active' AND m.role IN ('user', 'assistant')
    UNION ALL
    SELECT 'task:' || t.id, t.id, 0, 'task', t.id, COALESCE(t.project_id, ''), '', 0, t.title,
      t.created_at, COALESCE(t.completed_at, t.created_at),
      json_object('title', t.title, 'status', t.status, 'createdAt', t.created_at, 'completedAt', t.completed_at),
      json_array(t.project_id, t.title, t.status, t.created_at, t.completed_at), json_object('projectId', t.project_id)
    FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.visible = 1 AND (t.project_id IS NULL OR p.status = 'active')
    UNION ALL
    SELECT 'knowledge:' || m.id || ':' || ref.key, m.id, ref.key, 'knowledge',
      COALESCE(json_extract(ref.value, '$.chunkId'), json_extract(ref.value, '$.documentId'),
        json_extract(ref.value, '$.external.sourceUrl'), json_extract(ref.value, '$.libraryId')),
      c.project_id, c.id, m.sequence,
      COALESCE(json_extract(ref.value, '$.documentName'), json_extract(ref.value, '$.sourceName'), ''),
      m.created_at, m.created_at, COALESCE(json_extract(ref.value, '$.snippet'), ''),
      json_array(c.project_id, ref.value, m.created_at),
      json_patch(ref.value, json_object('messageId', m.id, 'conversationId', c.id, 'projectId', c.project_id, 'referenceIndex', ref.key))
    FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN projects p ON p.id = c.project_id
      JOIN json_each(m.metadata_json, '$.sourceReferences') ref
    WHERE c.status = 'active' AND p.status = 'active' AND m.role IN ('user', 'assistant');
`

export class SupervisionReviewStore {
  constructor(private readonly db: DatabaseSync, signal?: AbortSignal) {
    db.function('review_revision', { deterministic: true }, value => {
      signal?.throwIfAborted()
      return createHash('sha256').update(String(value)).digest('hex')
    })
  }

  prepareInitialization(runId: string, state: ReviewState): void {
    this.db.prepare('INSERT INTO supervision_review_runs VALUES (?, ?)').run(runId, JSON.stringify({ ...state, initializing: true }))
  }

  initialize(runId: string, state: ReviewState, signal?: AbortSignal): void {
    this.prepareInitialization(runId, state)
    this.initializeSources(runId, state, signal)
  }

  initializeSources(runId: string, state: ReviewState, signal?: AbortSignal): void {
    this.createSourceManifest(state, signal)
    try {
      while (this.clearSourceBatch(runId)) signal?.throwIfAborted()
      for (let offset = 0;; offset += 200) {
        signal?.throwIfAborted()
        const rows = this.sourceManifestPage(offset)
        if (!rows.length) break
        this.appendSourceBatch(runId, rows)
      }
      signal?.throwIfAborted()
      this.finishInitialization(runId)
    } finally { this.releaseSourceManifest() }
  }

  /** Read-worker-only temporary data. This never mutates the business database. */
  createSourceManifest(state: ReviewState, signal?: AbortSignal): void {
    const { request } = state
    signal?.throwIfAborted()
    if (request.scope.kind === 'projects') {
      for (const id of request.scope.projectIds) {
        if (!this.db.prepare("SELECT id FROM projects WHERE id = ? AND status = 'active'").get(id)) {
          throw new Error('Review projects must exist and be active')
        }
      }
    }
    // Scan once into connection-local metadata, under a read snapshot. No live
    // writer lock is held while the source view parses potentially large JSON.
    this.db.exec('DROP TABLE IF EXISTS temp.review_manifest; BEGIN')
    try {
      this.db.prepare(`CREATE TEMP TABLE review_manifest AS
        SELECT s.source, review_revision(s.context) AS revision, s.project_id,
          CASE WHEN s.type = 'task' THEN COALESCE((SELECT t.conversation_id FROM tasks t JOIN conversations c ON c.id = t.conversation_id WHERE t.id = s.record_id), '') ELSE s.conversation_id END AS conversation_id, s.sequence,
          length(s.body) AS length, CASE WHEN c.revision = review_revision(s.context) THEN c.processed_offset ELSE 0 END AS initial_offset
        FROM supervision_review_current s LEFT JOIN review_checkpoints c
          ON ? = 1 AND c.stage = 'supervisor' AND c.scope = '${TIMELINE_CHECKPOINT_SCOPE}' AND c.source = s.source
        WHERE ((s.occurred >= ? AND s.occurred <= ?) OR (s.alternate_time >= ? AND s.alternate_time <= ?))
          AND (? = 'global' OR s.project_id IN (SELECT value FROM json_each(?)))
          AND length(s.body) > 0
          AND (c.revision IS NULL OR c.revision != review_revision(s.context) OR c.processed_offset < length(s.body))`)
        .run(isIncrementalReview(request) ? 1 : 0, request.timeRange.from, request.timeRange.to,
          request.timeRange.from, request.timeRange.to, request.scope.kind,
          JSON.stringify(request.scope.kind === 'projects' ? request.scope.projectIds : []))
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); this.releaseSourceManifest(); throw error }
  }

  sourceManifestPage(offset: number): ReviewManifestRow[] {
    return this.db.prepare('SELECT * FROM temp.review_manifest WHERE rowid > ? AND rowid <= ? ORDER BY rowid')
      .all(offset, offset + 200) as ReviewManifestRow[]
  }

  releaseSourceManifest(): void { this.db.exec('DROP TABLE IF EXISTS temp.review_manifest') }

  private clearSourceBatch(runId: string): boolean {
    return this.db.prepare(`DELETE FROM supervision_review_sources WHERE run_id = ? AND source IN
      (SELECT source FROM supervision_review_sources WHERE run_id = ? LIMIT 200)`).run(runId, runId).changes > 0
  }

  private appendSourceBatch(runId: string, rows: ReviewManifestRow[]): void {
    if (rows.length > 200) throw new RangeError('Review manifest batch exceeds 200 rows')
    const insert = this.db.prepare('INSERT INTO supervision_review_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) insert.run(runId, row.source, row.revision, row.project_id, row.conversation_id,
        row.sequence, row.length, row.initial_offset, row.initial_offset)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private finishInitialization(runId: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare("UPDATE supervision_review_runs SET state_json = json_remove(state_json, '$.initializing') WHERE run_id = ?").run(runId)
      this.omitDeletedConversations(runId)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  async initializeWithReader(runId: string, state: ReviewState, reader: ReviewManifestReader, signal?: AbortSignal): Promise<void> {
    this.prepareInitialization(runId, state)
    await this.initializeSourcesWithReader(runId, state, reader, signal)
  }

  private checkRunning(runId: string, signal?: AbortSignal): void {
    signal?.throwIfAborted()
    if (this.db.prepare('SELECT status FROM supervision_runs WHERE id = ?').get(runId)?.status !== 'running') {
      throw new Error('Review stopped during manifest processing')
    }
  }

  private async initializeSourcesWithReader(runId: string, state: ReviewState, reader: ReviewManifestReader, signal?: AbortSignal): Promise<void> {
    this.checkRunning(runId, signal)
    try {
      await reader.scan(state, signal)
      for (;;) {
        this.checkRunning(runId, signal)
        if (!this.clearSourceBatch(runId)) break
        await yieldTurn()
      }
      for (let offset = 0;; offset += 200) {
        this.checkRunning(runId, signal)
        const rows = await reader.page(offset, signal)
        this.checkRunning(runId, signal)
        if (!rows.length) break
        this.appendSourceBatch(runId, rows)
        await yieldTurn()
      }
    } finally {
      // Uncancelled cleanup settles the scan connection before releasing its slot.
      await reader.release()
    }
    this.checkRunning(runId, signal)
    this.finishInitialization(runId)
  }

  changedSource(rows: ReviewRevisionRow[], signal?: AbortSignal): string | undefined {
    if (rows.length > 200) throw new RangeError('Review revision batch exceeds 200 rows')
    for (const row of rows) {
      signal?.throwIfAborted()
      if (this.currentSource(row.source, 0, 0)?.current_revision !== row.revision) return row.source
    }
    return undefined
  }

  load(runId: string): ReviewState {
    const row = this.db.prepare('SELECT state_json FROM supervision_review_runs WHERE run_id = ?').get(runId)
    if (!row) throw new Error('Review cannot be resumed: no saved configuration')
    const state = JSON.parse(String(row.state_json)) as ReviewState
    if (state.config.version !== 1) throw new Error('Review algorithm changed; start a new review')
    return state
  }

  unfinished(request: SupervisionRunRequest): string | undefined {
    return this.db.prepare(`SELECT s.id FROM supervision_runs s JOIN supervision_review_runs r ON r.run_id = s.id
      WHERE s.trigger = 'heartbeat' AND s.scope_json = ? AND s.status IN ('failed', 'running')
        AND (COALESCE(json_extract(r.state_json, '$.restartRequired'), 0) = 0 OR EXISTS (
          SELECT 1 FROM supervision_review_sources source WHERE source.run_id = s.id AND source.conversation_id != ''
            AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = source.conversation_id)
            AND instr(s.error, '(' || source.source || ');') > 0))
      ORDER BY s.created_at LIMIT 1`).get(JSON.stringify(request.scope))?.id as string | undefined
  }

  resume(runId: string, signal?: AbortSignal): void {
    const state = this.prepareResume(runId)
    if (state.initializing) { this.initializeSources(runId, state, signal); return }
    // Existing sources must still match their frozen versions.
    let after = ''
    for (;;) {
      const rows = this.resumePage(runId, after)
      if (!rows.length) break
      const changed = this.changedSource(rows, signal)
      if (changed) {
        if (this.omitDeletedConversations(runId)) return this.resume(runId, signal)
        this.sourceChanged(runId, changed)
      }
      after = rows.at(-1)!.source
    }
  }

  private prepareResume(runId: string): ReviewState {
    const status = this.db.prepare('SELECT status FROM supervision_runs WHERE id = ?').get(runId)?.status
    if (status === 'cancelled') throw new Error('SUPERVISION_REVIEW_CANCELLED: 此回顾已取消，不能继续。请开始新的回顾。')
    this.omitDeletedConversations(runId)
    if (this.load(runId).restartRequired) throw new Error('Review source changed or was removed; start a new review')
    const changed = this.db.prepare(`UPDATE supervision_runs SET status = 'running', error = NULL, completed_at = NULL
      WHERE id = ? AND status IN ('paused', 'failed', 'running')`).run(runId)
    if (!changed.changes) throw new Error('SUPERVISION_REVIEW_NOT_RESUMABLE: 此回顾已完成或不存在，请开始新的回顾。')
    return this.load(runId)
  }

  private resumePage(runId: string, after: string): ReviewRevisionRow[] {
    return this.db.prepare('SELECT source, revision FROM supervision_review_sources WHERE run_id = ? AND source > ? ORDER BY source LIMIT 200')
      .all(runId, after) as ReviewRevisionRow[]
  }

  async resumeWithReader(runId: string, reader: ReviewManifestReader, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const state = this.prepareResume(runId)
    if (state.initializing) { await this.initializeSourcesWithReader(runId, state, reader, signal); return }
    let after = ''
    for (;;) {
      this.checkRunning(runId, signal)
      const rows = this.resumePage(runId, after)
      if (!rows.length) break
      const changed = await reader.changedSource(rows, signal)
      this.checkRunning(runId, signal)
      if (changed) {
        if (this.omitDeletedConversations(runId)) { after = ''; continue }
        this.sourceChanged(runId, changed)
      }
      after = rows.at(-1)!.source
      await yieldTurn()
    }
  }

  pause(runId: string, reason: string): void {
    this.db.prepare("UPDATE supervision_runs SET status = 'paused', error = ?, completed_at = ? WHERE id = ? AND status = 'running'")
      .run(reason, new Date().toISOString(), runId)
  }

  cancel(runId: string): void {
    const changed = this.db.prepare(`UPDATE supervision_runs SET status = 'cancelled', error = NULL,
      completed_at = CASE WHEN status = 'cancelled' THEN completed_at ELSE ? END
      WHERE id = ? AND status IN ('running', 'paused', 'failed', 'cancelled')`)
      .run(new Date().toISOString(), runId)
    if (!changed.changes) throw new Error('SUPERVISION_REVIEW_NOT_CANCELLABLE: 此回顾已完成或不存在，无需取消。')
  }

  setPhase(runId: string, phase: NonNullable<SupervisionReviewProgress['phase']>): void {
    this.db.prepare("UPDATE supervision_review_runs SET state_json = json_set(state_json, '$.phase', ?) WHERE run_id = ?").run(phase, runId)
  }

  setStories(runId: string, stories: NonNullable<SupervisionReviewProgress['stories']>): void {
    this.db.prepare("UPDATE supervision_review_runs SET state_json = json_set(state_json, '$.stories', json(?)) WHERE run_id = ?").run(JSON.stringify(stories), runId)
  }

  groups(runId: string, limit: number): Array<{ projectId: string; conversationId: string }> {
    // One group per project per round before a second conversation from that project.
    return this.db.prepare(`WITH groups AS (
      SELECT s.project_id, s.conversation_id,
        (SELECT COUNT(*) FROM supervision_review_batches b WHERE b.run_id = s.run_id AND b.project_id = s.project_id AND b.conversation_id = s.conversation_id) AS turns,
        (SELECT COUNT(*) FROM supervision_review_batches b WHERE b.run_id = s.run_id AND b.project_id = s.project_id) AS project_turns
      FROM supervision_review_sources s WHERE s.run_id = ? AND s.processed_offset < s.length
      GROUP BY s.project_id, s.conversation_id
    ), ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY turns, conversation_id) AS rank FROM groups)
      SELECT project_id AS projectId, conversation_id AS conversationId FROM ranked
      ORDER BY rank, project_turns, project_id, turns, conversation_id LIMIT ?`).all(runId, limit) as Array<{ projectId: string; conversationId: string }>
  }

  chunk(runId: string, projectId: string, conversationId: string, config: ReviewConfiguration): SupervisionEvidence[] {
    this.omitDeletedConversations(runId)
    const { request } = this.load(runId)
    const evidence: SupervisionEvidence[] = []
    let remaining = config.batchCharacters
    let afterSequence = -1
    let afterSource = ''
    const messageIds = new Set<string>()
    for (;;) {
      const rows = this.db.prepare(`SELECT * FROM supervision_review_sources
        WHERE run_id = ? AND project_id = ? AND conversation_id = ? AND processed_offset < length
          AND (sequence > ? OR (sequence = ? AND source > ?))
        ORDER BY sequence, source LIMIT ?`).all(runId, projectId, conversationId,
          afterSequence, afterSequence, afterSource, config.pageSize) as Array<{
            source: string; revision: string; processed_offset: number; length: number; sequence: number
          }>
      if (!rows.length) break
      for (const metadata of rows) {
        const current = this.currentSource(metadata.source, metadata.processed_offset, Math.min(remaining, 8000))
        if (!current || current.current_revision !== metadata.revision) {
          if (this.omitDeletedConversations(runId)) return this.chunk(runId, projectId, conversationId, config)
          this.sourceChanged(runId, metadata.source)
        }
        const row = { ...metadata, ...current }
        const locator = JSON.parse(row.locator) as Record<string, unknown>
        const messageId = String(locator.messageId ?? row.source)
        if (!messageIds.has(messageId) && messageIds.size >= config.batchMessages) return evidence
        let content = '', points = 0
        for (const point of row.content) {
          if (content.length + point.length > Math.min(remaining, 8000)) break
          content += point
          points++
        }
        if (!points) return evidence
        const end = row.processed_offset + points
        evidence.push({ id: `${row.source}:${row.processed_offset}:${end}`, sourceType: row.type,
          sourceId: row.owner, title: row.title,
          occurredAt: row.type === 'task' && row.alternate_time >= request.timeRange.from && row.alternate_time <= request.timeRange.to ? row.alternate_time : row.occurred, content,
          locator: { ...locator, source: row.source, revision: row.revision, start: row.processed_offset, end, length: row.length } })
        messageIds.add(messageId)
        remaining -= content.length
        if (remaining < 2 || end < row.length || evidence.length >= 50) return evidence
        afterSequence = row.sequence
        afterSource = row.source
      }
    }
    return evidence
  }

  private currentSource(source: string, offset: number, characters: number) {
    const separator = source.indexOf(':')
    const kind = source.slice(0, separator)
    const key = source.slice(separator + 1)
    const last = key.lastIndexOf(':')
    const id = kind === 'knowledge' ? key.slice(0, last) : key
    const reference = kind === 'knowledge' ? Number(key.slice(last + 1)) : 0
    // The view predicate pushes record_id into each branch's message/task primary-key lookup.
    return this.db.prepare(`SELECT type, owner, substr(title, 1, 240) AS title, occurred, alternate_time,
      locator, review_revision(context) AS current_revision, substr(body, ? + 1, ?) AS content
      FROM supervision_review_current WHERE record_id = ? AND reference_index = ? AND type = ?`).get(
        offset, characters, id, reference, kind === 'message' ? 'conversation' : kind) as {
          type: SupervisionEvidence['sourceType']; owner: string; title: string; occurred: string;
          alternate_time: string; locator: string; current_revision: string; content: string
        } | undefined
  }

  private sourceChanged(runId: string, source: string): never {
    this.db.prepare("UPDATE supervision_review_runs SET state_json = json_set(state_json, '$.restartRequired', json('true')) WHERE run_id = ?").run(runId)
    throw new Error(`Review source changed or was removed (${source}); start a new review`)
  }

  save(runId: string, projectId: string, conversationId: string, evidence: SupervisionEvidence[], output: SupervisionSummaryOutput): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.omitDeletedConversations(runId)
      if (!this.hasSources(runId, evidence)) { this.db.exec('COMMIT'); return }
      const advance = this.db.prepare(`UPDATE supervision_review_sources SET processed_offset = ?
        WHERE run_id = ? AND source = ? AND revision = ? AND processed_offset = ?`)
      for (const item of evidence) {
        const locator = item.locator!
        if (this.currentSource(String(locator.source), 0, 0)?.current_revision !== locator.revision) this.sourceChanged(runId, String(locator.source))
        if (advance.run(Number(locator.end), runId, String(locator.source), String(locator.revision), Number(locator.start)).changes !== 1) {
          throw new Error('Review coverage has a gap or duplicate batch')
        }
      }
      this.db.prepare('INSERT INTO supervision_review_batches VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        randomUUID(), runId, projectId, conversationId, JSON.stringify(evidence), JSON.stringify(output),
        evidence.reduce((sum, item) => sum + Number(item.locator!.end) - Number(item.locator!.start), 0))
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  hasSources(runId: string, evidence: SupervisionEvidence[]): boolean {
    const source = this.db.prepare('SELECT 1 FROM supervision_review_sources WHERE run_id = ? AND source = ?')
    return evidence.every(item => source.get(runId, String(item.locator!.source)))
  }

  batches(runId: string, limit = 10, offset = 0): SupervisionReviewBatch[] {
    return this.db.prepare(`SELECT * FROM supervision_review_batches WHERE run_id = ? ORDER BY project_id, conversation_id, rowid LIMIT ? OFFSET ?`)
      .all(runId, limit, offset).map(row => ({ id: String(row.id), projectId: String(row.project_id), conversationId: String(row.conversation_id),
        evidence: JSON.parse(String(row.evidence_json)), output: JSON.parse(String(row.output_json)) }))
  }

  progress(runId: string): SupervisionReviewProgress {
    const sources = this.db.prepare(`SELECT COUNT(*) AS sources, COALESCE(SUM(processed_offset < length), 0) AS remaining
      FROM supervision_review_sources WHERE run_id = ?`).get(runId)!
    const batches = this.db.prepare(`SELECT COUNT(*) AS batches, COALESCE(SUM(characters), 0) AS characters
      FROM supervision_review_batches WHERE run_id = ?`).get(runId)!
    const state = this.load(runId)
    const error = String(this.db.prepare('SELECT error FROM supervision_runs WHERE id = ?').get(runId)?.error ?? '')
    const failedSource = /Review source changed or was removed \((.+)\);/.exec(error)?.[1]
    const deletedFailure = failedSource && this.db.prepare(`SELECT 1 FROM supervision_review_sources s
      WHERE s.run_id = ? AND s.source = ? AND s.conversation_id != ''
        AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = s.conversation_id)`).get(runId, failedSource)
    const navigation = this.db.prepare('SELECT COUNT(*) AS count FROM supervision_review_navigation WHERE run_id = ?').get(runId)!
    return { runId, omittedSources: state.omittedSources, phase: state.phase, stories: state.stories, navigationNodes: Number(navigation.count), settings: state.config, restartRequired: deletedFailure ? false : state.restartRequired, batches: Number(batches.batches), characters: Number(batches.characters), sources: Number(sources.sources),
      remainingSources: Number(sources.remaining), complete: this.db.prepare("SELECT id FROM supervision_runs WHERE id = ? AND status IN ('completed', 'no_change')").get(runId) !== undefined }
  }

  assertComplete(runId: string, expectedOmissions?: number): void {
    if (this.omitDeletedConversations(runId) || (expectedOmissions !== undefined && (this.load(runId).omittedSources ?? 0) !== expectedOmissions)) {
      throw new ReviewSourcesOmitted('Deleted conversation sources omitted; rebuild review navigation')
    }
    if (this.load(runId).initializing) throw new Error('Cannot publish an incomplete source manifest')
    if (this.progress(runId).remainingSources) throw new Error('Cannot publish incomplete coverage')
  }

  /** Only unpublished staging is disposable. No source bodies are read or restored here. */
  omitDeletedConversations(runId: string): boolean {
    if (!this.db.prepare("SELECT id FROM supervision_runs WHERE id = ? AND status IN ('running', 'paused', 'failed')").get(runId)) return false
    if (this.load(runId).initializing) return false
    const deleted = this.db.prepare(`SELECT s.source FROM supervision_review_sources s
      WHERE s.run_id = ? AND s.conversation_id != ''
        AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = s.conversation_id)`).all(runId)
    if (!deleted.length) return false
    this.db.exec('SAVEPOINT omit_review_sources')
    try {
      const removed = new Set(deleted.map(row => String(row.source)))
      const affected = new Set(removed)
      const invalid = new Set<string>()
      // A mixed leaf cannot be filtered safely: its prose may combine every input.
      // Reset its surviving sources and discard their other leaves to avoid duplicate coverage.
      let changed = true
      while (changed) {
        changed = false
        for (let offset = 0;; offset += 10) {
          const batches = this.db.prepare(`SELECT b.id, json_group_array(json_extract(item.value, '$.locator.source')) AS sources
            FROM (SELECT id, evidence_json FROM supervision_review_batches WHERE run_id = ? ORDER BY rowid LIMIT 10 OFFSET ?) b,
              json_each(b.evidence_json) item GROUP BY b.id`).all(runId, offset)
          if (!batches.length) break
          for (const batch of batches) {
            const sources = JSON.parse(String(batch.sources)) as string[]
            if (invalid.has(String(batch.id)) || !sources.some(source => affected.has(source))) continue
            invalid.add(String(batch.id))
            for (const source of sources) affected.add(source)
            changed = true
          }
        }
      }
      const invalidIds = JSON.stringify([...invalid])
      this.db.prepare(`WITH RECURSIVE invalid(id) AS (
        SELECT value FROM json_each(?) UNION
        SELECT n.id FROM supervision_review_navigation n, json_each(n.children_json) child
          JOIN invalid i ON i.id = child.value WHERE n.run_id = ?
      ) DELETE FROM supervision_review_navigation WHERE run_id = ? AND id IN (SELECT id FROM invalid)`)
        .run(invalidIds, runId, runId)
      this.db.prepare('DELETE FROM supervision_review_batches WHERE run_id = ? AND id IN (SELECT value FROM json_each(?))').run(runId, invalidIds)
      for (const source of affected) this.db.prepare('UPDATE supervision_review_sources SET processed_offset = initial_offset WHERE run_id = ? AND source = ?').run(runId, source)
      for (const source of removed) this.db.prepare('DELETE FROM supervision_review_sources WHERE run_id = ? AND source = ?').run(runId, source)
      const error = String(this.db.prepare('SELECT error FROM supervision_runs WHERE id = ?').get(runId)?.error ?? '')
      const failedSource = /Review source changed or was removed \((.+)\);/.exec(error)?.[1]
      if (failedSource && removed.has(failedSource)) this.db.prepare("UPDATE supervision_review_runs SET state_json = json_remove(state_json, '$.restartRequired') WHERE run_id = ?").run(runId)
      this.db.prepare(`UPDATE supervision_review_runs SET state_json = json_set(state_json,
        '$.omittedSources', COALESCE(json_extract(state_json, '$.omittedSources'), 0) + ?, '$.phase', 'extracting') WHERE run_id = ?`).run(removed.size, runId)
      this.db.exec('RELEASE omit_review_sources')
      return true
    } catch (error) { this.db.exec('ROLLBACK TO omit_review_sources; RELEASE omit_review_sources'); throw error }
  }

  commitCheckpoints(runId: string, request: SupervisionRunRequest): void {
    this.assertComplete(runId)
    if (!this.db.isTransaction) throw new Error('Review publication must be transactional')
    if (!isIncrementalReview(request)) return
    this.db.prepare(`INSERT INTO review_checkpoints (stage, scope, source, revision, processed_offset, source_length)
      SELECT 'supervisor', ?, source, revision, processed_offset, length FROM supervision_review_sources WHERE run_id = ?
      ON CONFLICT(stage, scope, source) DO UPDATE SET revision = excluded.revision,
        processed_offset = CASE WHEN review_checkpoints.revision = excluded.revision
          THEN MAX(review_checkpoints.processed_offset, excluded.processed_offset) ELSE excluded.processed_offset END,
        source_length = excluded.source_length`).run(TIMELINE_CHECKPOINT_SCOPE, runId)
  }

  navigation(runId: string, id: string): SupervisionSummaryOutput | undefined {
    const row = this.db.prepare('SELECT output_json FROM supervision_review_navigation WHERE run_id = ? AND id = ?').get(runId, id)
    return row ? JSON.parse(String(row.output_json)) as SupervisionSummaryOutput : undefined
  }

  saveNavigation(runId: string, id: string, children: string[], output: SupervisionSummaryOutput): void {
    this.db.prepare('INSERT INTO supervision_review_navigation VALUES (?, ?, ?, ?)').run(runId, id, JSON.stringify(children), JSON.stringify(output))
  }
}
