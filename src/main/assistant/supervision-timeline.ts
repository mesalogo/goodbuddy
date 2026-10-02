import type { DatabaseSync } from 'node:sqlite'
import type { SupervisionAttentionSlot } from '../../shared/supervision-contracts'
import { TIMELINE_CHECKPOINT_SCOPE } from './supervision-review-store'

/*
 * One shared timeline for every review scope (storyline model SL-6, SL-7):
 * - an event's span and project come from its source records, never from the model;
 * - a source version re-extracted later supersedes earlier events from it, so
 *   overlapping or repeated reviews do not duplicate events;
 * - attention density is counted from the source messages themselves.
 */

/** Adds timeline columns and folds released per-scope data into the shared timeline. */
export function migrateSupervisionTimeline(db: DatabaseSync): void {
  const columns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name))
  const events = columns('supervision_events')
  for (const column of ['started_at', 'ended_at', 'project_id', 'superseded_by']) {
    if (!events.has(column)) db.exec(`ALTER TABLE supervision_events ADD COLUMN ${column} TEXT`)
  }
  const sources = columns('supervision_sources')
  for (const column of ['source_key', 'source_revision']) {
    if (!sources.has(column)) db.exec(`ALTER TABLE supervision_sources ADD COLUMN ${column} TEXT`)
  }
  db.exec(`
    UPDATE supervision_sources SET source_key = json_extract(locator_json, '$.source'),
      source_revision = json_extract(locator_json, '$.revision')
      WHERE locator_json IS NOT NULL AND json_valid(locator_json);
    CREATE INDEX IF NOT EXISTS supervision_sources_key ON supervision_sources(source_key, source_revision);
    CREATE INDEX IF NOT EXISTS supervision_events_timeline ON supervision_events(project_id, started_at) WHERE superseded_by IS NULL;
    INSERT INTO review_checkpoints (stage, scope, source, revision, processed_offset, source_length)
      SELECT stage, '${TIMELINE_CHECKPOINT_SCOPE}', source, revision, processed_offset, source_length
      FROM review_checkpoints WHERE stage = 'supervisor' AND scope != '${TIMELINE_CHECKPOINT_SCOPE}'
      ORDER BY processed_offset
      ON CONFLICT(stage, scope, source) DO UPDATE SET revision = excluded.revision,
        processed_offset = excluded.processed_offset, source_length = excluded.source_length;
    DELETE FROM review_checkpoints WHERE stage = 'supervisor' AND scope != '${TIMELINE_CHECKPOINT_SCOPE}';
  `)
  const results = db.prepare('SELECT id FROM supervision_results ORDER BY rowid').all() as Array<{ id: string }>
  for (const { id } of results) {
    placeTimelineEvents(db, id)
    supersedeReextractedEvents(db, id)
  }
}

/** Derives span and project for a result's events from their linked source records. */
export function placeTimelineEvents(db: DatabaseSync, resultId: string): void {
  db.prepare(`UPDATE supervision_events SET
      started_at = COALESCE((SELECT MIN(s.occurred_at) FROM supervision_event_sources es JOIN supervision_sources s ON s.id = es.source_id WHERE es.event_id = supervision_events.id), occurred_at),
      ended_at = COALESCE((SELECT MAX(s.occurred_at) FROM supervision_event_sources es JOIN supervision_sources s ON s.id = es.source_id WHERE es.event_id = supervision_events.id), occurred_at),
      project_id = (SELECT CASE WHEN COUNT(DISTINCT COALESCE(json_extract(s.locator_json, '$.projectId'), '')) = 1
          THEN MAX(COALESCE(json_extract(s.locator_json, '$.projectId'), '')) END
        FROM supervision_event_sources es JOIN supervision_sources s ON s.id = es.source_id WHERE es.event_id = supervision_events.id)
    WHERE result_id = ?`).run(resultId)
}

/** Earlier events extracted from a source version this result re-extracted are no longer current. */
export function supersedeReextractedEvents(db: DatabaseSync, resultId: string): void {
  db.prepare(`UPDATE supervision_events SET superseded_by = ?
    WHERE superseded_by IS NULL AND result_id != ?
      AND (SELECT rowid FROM supervision_results WHERE id = supervision_events.result_id) < (SELECT rowid FROM supervision_results WHERE id = ?)
      AND EXISTS (
      SELECT 1 FROM supervision_event_sources es JOIN supervision_sources old ON old.id = es.source_id
        JOIN supervision_sources fresh ON fresh.result_id = ? AND fresh.source_key = old.source_key
          AND fresh.source_revision = old.source_revision
          AND COALESCE(json_extract(fresh.locator_json, '$.start'), 0) < COALESCE(json_extract(old.locator_json, '$.end'), 1e18)
          AND COALESCE(json_extract(old.locator_json, '$.start'), 0) < COALESCE(json_extract(fresh.locator_json, '$.end'), 1e18)
      WHERE es.event_id = supervision_events.id AND old.source_key IS NOT NULL)`).run(resultId, resultId, resultId, resultId)
}

/**
 * Entities an event in `projectId` may join. With cross-project off, only knowledge
 * already seen in the same project is offered, so separate projects never merge silently.
 */
export function timelineCandidates(db: DatabaseSync, projectId: string, crossProject: boolean): Array<{ id: string; label: string; description: string }> {
  return db.prepare(`SELECT e.id, e.canonical_label AS label, e.description FROM supervision_entities e
    WHERE e.confirmation_state != 'revoked' AND (? = 1 OR EXISTS (
      SELECT 1 FROM supervision_event_entities ee JOIN supervision_events ev ON ev.id = ee.event_id
      WHERE ee.entity_id = e.id AND ev.superseded_by IS NULL AND COALESCE(ev.project_id, '') = ?))
    ORDER BY e.updated_at DESC, e.id LIMIT 100`).all(crossProject ? 1 : 0, projectId) as Array<{ id: string; label: string; description: string }>
}

/** Hourly message turns and text volume; density is counted, not judged by a model. */
export function supervisionAttention(db: DatabaseSync, projectIds: string[] | undefined, from: string, to: string): SupervisionAttentionSlot[] {
  return db.prepare(`SELECT strftime('%Y-%m-%dT%H:00:00.000Z', m.created_at) AS start, COUNT(*) AS turns, SUM(length(m.content)) AS characters
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.role IN ('user', 'assistant') AND m.created_at >= ? AND m.created_at <= ?
      AND (? IS NULL OR c.project_id IN (SELECT value FROM json_each(?)))
    GROUP BY start ORDER BY start`).all(from, to, projectIds ? 1 : null, JSON.stringify(projectIds ?? []))
    .map(row => ({ start: String(row.start), turns: Number(row.turns), characters: Number(row.characters) }))
}
