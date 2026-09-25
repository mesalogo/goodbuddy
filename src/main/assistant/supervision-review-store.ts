import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { SupervisionEvidence, SupervisionRunRequest, SupervisionSummaryOutput } from '../../shared/supervision-contracts'
import type { SupervisionReviewBatch, SupervisionReviewProgress, SupervisionReviewSettings } from '../../shared/supervision-review-contracts'
import { reviewScope } from './review-checkpoint'

export type ReviewConfiguration = SupervisionReviewSettings & { timeoutSeconds: number; concurrency: number; version: 1 }
export type ReviewState = { request: SupervisionRunRequest; config: ReviewConfiguration; restartRequired?: boolean; phase?: SupervisionReviewProgress['phase'] }

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
  constructor(private readonly db: DatabaseSync) {
    db.function('review_revision', { deterministic: true }, value => createHash('sha256').update(String(value)).digest('hex'))
  }

  initialize(runId: string, state: ReviewState): void {
    const { request } = state
    if (request.scope.kind === 'projects') {
      for (const id of request.scope.projectIds) {
        if (!this.db.prepare("SELECT id FROM projects WHERE id = ? AND status = 'active'").get(id)) {
          throw new Error('Review projects must exist and be active')
        }
      }
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO supervision_review_runs VALUES (?, ?)').run(runId, JSON.stringify(state))
      const insertPage = this.db.prepare(`INSERT INTO supervision_review_sources
        SELECT ?, s.source, review_revision(s.context), s.project_id, s.conversation_id, s.sequence,
          length(s.body), CASE WHEN c.revision = review_revision(s.context) THEN c.processed_offset ELSE 0 END,
          CASE WHEN c.revision = review_revision(s.context) THEN c.processed_offset ELSE 0 END
        FROM supervision_review_current s LEFT JOIN review_checkpoints c
          ON ? = 'heartbeat' AND c.stage = 'supervisor' AND c.scope = ? AND c.source = s.source
        WHERE ((s.occurred >= ? AND s.occurred <= ?) OR (s.alternate_time >= ? AND s.alternate_time <= ?))
          AND (? = 'global' OR s.project_id IN (SELECT value FROM json_each(?)))
          AND length(s.body) > 0
          AND (c.revision IS NULL OR c.revision != review_revision(s.context) OR c.processed_offset < length(s.body))
          AND (s.project_id, s.conversation_id, s.sequence, s.source) > (?, ?, ?, ?)
        ORDER BY s.project_id, s.conversation_id, s.sequence, s.source LIMIT ?`)
      let cursor: [string, string, number, string] = ['', '', -1, '']
      for (;;) {
        const page = insertPage.run(runId, request.trigger, reviewScope(request.scope), request.timeRange.from, request.timeRange.to,
          request.timeRange.from, request.timeRange.to, request.scope.kind,
          JSON.stringify(request.scope.kind === 'projects' ? request.scope.projectIds : []), ...cursor, state.config.pageSize)
        if (!page.changes) break
        const last = this.db.prepare(`SELECT project_id, conversation_id, sequence, source FROM supervision_review_sources
          WHERE run_id = ? ORDER BY project_id DESC, conversation_id DESC, sequence DESC, source DESC LIMIT 1`).get(runId)!
        cursor = [String(last.project_id), String(last.conversation_id), Number(last.sequence), String(last.source)]
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
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
      WHERE s.trigger = 'heartbeat' AND s.scope_json = ? AND s.status IN ('paused', 'failed', 'running')
        AND COALESCE(json_extract(r.state_json, '$.restartRequired'), 0) = 0
      ORDER BY s.created_at LIMIT 1`).get(JSON.stringify(request.scope))?.id as string | undefined
  }

  resume(runId: string): void {
    if (this.load(runId).restartRequired) throw new Error('Review source changed or was removed; start a new review')
    const changed = this.db.prepare(`UPDATE supervision_runs SET status = 'running', error = NULL, completed_at = NULL
      WHERE id = ? AND status IN ('paused', 'failed', 'running')`).run(runId)
    if (!changed.changes) throw new Error('Review is already complete or unavailable')
    // A changed/deleted source cannot be silently counted as covered. Saved facts remain accessible.
    let after = ''
    for (;;) {
      const rows = this.db.prepare('SELECT source, revision FROM supervision_review_sources WHERE run_id = ? AND source > ? ORDER BY source LIMIT 200').all(runId, after)
      if (!rows.length) break
      for (const row of rows) {
        if (this.currentSource(String(row.source), 0, 0)?.current_revision !== row.revision) {
          this.sourceChanged(runId, String(row.source))
        }
        after = String(row.source)
      }
    }
  }

  pause(runId: string, reason: string): void {
    this.db.prepare("UPDATE supervision_runs SET status = 'paused', error = ?, completed_at = ? WHERE id = ? AND status = 'running'")
      .run(reason, new Date().toISOString(), runId)
  }

  setPhase(runId: string, phase: NonNullable<SupervisionReviewProgress['phase']>): void {
    this.db.prepare("UPDATE supervision_review_runs SET state_json = json_set(state_json, '$.phase', ?) WHERE run_id = ?").run(phase, runId)
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
        if (!current || current.current_revision !== metadata.revision) this.sourceChanged(runId, metadata.source)
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
      const advance = this.db.prepare(`UPDATE supervision_review_sources SET processed_offset = ?
        WHERE run_id = ? AND source = ? AND revision = ? AND processed_offset = ?`)
      for (const item of evidence) {
        const locator = item.locator!
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
    const navigation = this.db.prepare('SELECT COUNT(*) AS count FROM supervision_review_navigation WHERE run_id = ?').get(runId)!
    return { runId, phase: state.phase, navigationNodes: Number(navigation.count), settings: state.config, restartRequired: state.restartRequired, batches: Number(batches.batches), characters: Number(batches.characters), sources: Number(sources.sources),
      remainingSources: Number(sources.remaining), complete: this.db.prepare("SELECT id FROM supervision_runs WHERE id = ? AND status IN ('completed', 'no_change')").get(runId) !== undefined }
  }

  assertComplete(runId: string): void {
    if (this.progress(runId).remainingSources) throw new Error('Cannot publish incomplete coverage')
  }

  commitCheckpoints(runId: string, request: SupervisionRunRequest): void {
    this.assertComplete(runId)
    if (!this.db.isTransaction) throw new Error('Review publication must be transactional')
    if (request.trigger !== 'heartbeat') return
    this.db.prepare(`INSERT INTO review_checkpoints (stage, scope, source, revision, processed_offset, source_length)
      SELECT 'supervisor', ?, source, revision, processed_offset, length FROM supervision_review_sources WHERE run_id = ?
      ON CONFLICT(stage, scope, source) DO UPDATE SET revision = excluded.revision,
        processed_offset = CASE WHEN review_checkpoints.revision = excluded.revision
          THEN MAX(review_checkpoints.processed_offset, excluded.processed_offset) ELSE excluded.processed_offset END,
        source_length = excluded.source_length`).run(reviewScope(request.scope), runId)
  }

  navigation(runId: string, id: string): SupervisionSummaryOutput | undefined {
    const row = this.db.prepare('SELECT output_json FROM supervision_review_navigation WHERE run_id = ? AND id = ?').get(runId, id)
    return row ? JSON.parse(String(row.output_json)) as SupervisionSummaryOutput : undefined
  }

  saveNavigation(runId: string, id: string, children: string[], output: SupervisionSummaryOutput): void {
    this.db.prepare('INSERT INTO supervision_review_navigation VALUES (?, ?, ?, ?)').run(runId, id, JSON.stringify(children), JSON.stringify(output))
  }
}
