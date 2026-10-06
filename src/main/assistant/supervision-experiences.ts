import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ExperienceExtractionOutput } from './experience-extraction-service'
import type { SupervisionExperience, SupervisionExperienceAction } from '../../shared/supervision-story-contracts'

/*
 * Experience extraction (storyline model step 4, SL-4, SL-5).
 * - Candidates are chosen by rules, without a model: stories (features or threads) that gained
 *   decision, change or milestone events since the last pass and hold at least `minEvents` events.
 * - One bounded model call per chunk of candidate stories reads event titles/descriptions only,
 *   never original sources, and proposes experiences with the events they formed from, plus
 *   later events where an existing or new experience was applied.
 * - Every evidence event must be an input event with saved sources; applications that do not come
 *   after the experience formed are dropped. Experiences are usable immediately and marked automatic; user edits are
 *   protected and removed experiences are not recreated from the same evidence.
 */

export const supervisionExperiencesMigration = `
  CREATE TABLE IF NOT EXISTS supervision_experiences (
    id TEXT PRIMARY KEY,
    statement TEXT NOT NULL,
    conditions TEXT NOT NULL DEFAULT '',
    boundaries TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'merged', 'removed')),
    merged_into TEXT,
    user_edited INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS supervision_experience_events (
    experience_id TEXT NOT NULL REFERENCES supervision_experiences(id),
    event_id TEXT NOT NULL REFERENCES supervision_events(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('formed', 'applied')),
    note TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (experience_id, event_id, role)
  );
  CREATE INDEX IF NOT EXISTS supervision_experience_events_event ON supervision_experience_events(event_id);
  -- Events already offered to extraction, so a quiet story costs no call on the next review.
  CREATE TABLE IF NOT EXISTS supervision_experience_seen (
    event_id TEXT PRIMARY KEY REFERENCES supervision_events(id) ON DELETE CASCADE
  );
`

type Row = Record<string, unknown>
type CandidateEvent = { id: string; story_id: string; at: string; event_type: string; title: string; description: string }
type Candidate = { story: Row; events: CandidateEvent[] }

const signalTypes = "('decision', 'change', 'milestone')"

const statementKey = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]+/gu, '')

export class SupervisionExperienceStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Stories with unseen signal events and enough history, each with its current events oldest first. */
  candidates(minEvents: number): Candidate[] {
    const stories = this.db.prepare(`SELECT s.id, s.name, s.description, s.level, (SELECT name FROM projects p WHERE p.id = s.project_id) AS project
      FROM supervision_stories s WHERE s.status = 'current' AND s.level IN ('feature', 'thread')
        AND EXISTS (SELECT 1 FROM supervision_event_stories es JOIN supervision_events e ON e.id = es.event_id
          WHERE es.story_id = s.id AND es.is_primary = 1 AND e.superseded_by IS NULL AND e.event_type IN ${signalTypes}
            AND NOT EXISTS (SELECT 1 FROM supervision_experience_seen seen WHERE seen.event_id = e.id))
      ORDER BY s.project_id, s.name`).all()
    const events = this.db.prepare(`SELECT e.id, es.story_id, COALESCE(e.started_at, e.occurred_at) AS at, e.event_type, e.title, e.description
      FROM supervision_event_stories es JOIN supervision_events e ON e.id = es.event_id
      WHERE es.story_id = ? AND es.is_primary = 1 AND e.superseded_by IS NULL
        AND EXISTS (SELECT 1 FROM supervision_event_sources src WHERE src.event_id = e.id)
      ORDER BY at, e.id`)
    return stories.map(story => ({ story, events: events.all(String(story.id)) as CandidateEvent[] }))
      .filter(candidate => candidate.events.length >= minEvents)
  }

  /** Unseen signal events of stories too small to be candidates; marked so they are not reconsidered every review. */
  markSmall(minEvents: number): void {
    this.db.prepare(`INSERT OR IGNORE INTO supervision_experience_seen (event_id)
      SELECT e.id FROM supervision_event_stories es JOIN supervision_events e ON e.id = es.event_id
      WHERE es.is_primary = 1 AND e.superseded_by IS NULL AND e.event_type IN ${signalTypes}
        AND (SELECT COUNT(*) FROM supervision_event_stories x JOIN supervision_events xe ON xe.id = x.event_id
          WHERE x.story_id = es.story_id AND x.is_primary = 1 AND xe.superseded_by IS NULL) < ?`).run(minEvents)
  }

  existing(): Row[] {
    return this.db.prepare("SELECT id, statement, conditions FROM supervision_experiences WHERE status = 'current' ORDER BY created_at, rowid").all()
  }

  /** Applies one validated answer in a single transaction and marks the chunk's events as seen. */
  apply(events: CandidateEvent[], existing: Row[], output: ExperienceExtractionOutput): { created: number; applied: number } {
    const refs = new Map(events.map((event, index) => [`e_${index + 1}`, event]))
    const xRefs = new Map(existing.map((row, index) => [`x_${index + 1}`, row]))
    const keys = new Map(output.experiences.map(item => [item.key, item]))
    if (keys.size !== output.experiences.length) throw new Error('经验整理的新经验键重复')
    const formedAt = new Map<string, string>()
    for (const item of output.experiences) {
      for (const ref of item.formed) if (!refs.has(ref)) throw new Error(`经验 ${item.key} 引用了未知事件 ${ref}`)
      formedAt.set(item.key, item.formed.map(ref => refs.get(ref)!.at).sort()[0]!)
    }
    const earliest = this.db.prepare(`SELECT MIN(COALESCE(e.started_at, e.occurred_at)) AS at FROM supervision_experience_events x
      JOIN supervision_events e ON e.id = x.event_id WHERE x.experience_id = ? AND x.role = 'formed'`)
    for (const [ref, row] of xRefs) { const at = earliest.get(String(row.id))?.at; if (at) formedAt.set(ref, String(at)) }
    for (const application of output.applications) {
      if (!refs.has(application.event)) throw new Error(`经验应用引用了未知事件 ${application.event}`)
      if (!keys.has(application.experience) && !xRefs.has(application.experience)) throw new Error(`经验应用引用了未知经验 ${application.experience}`)
    }
    // An application must come after the experience formed; the real model sometimes cites earlier events. Those
    // citations are dropped, the rest of the answer is kept.
    // An application must also touch the same knowledge as the formation: share an entity with one of its
    // formation events. The real model otherwise records loosely related events as applications.
    const entitiesOf = this.db.prepare('SELECT entity_id FROM supervision_event_entities WHERE event_id = ?')
    const formedEvents = new Map<string, string[]>()
    for (const item of output.experiences) formedEvents.set(item.key, item.formed.map(ref => refs.get(ref)!.id))
    const formedOf = this.db.prepare("SELECT event_id FROM supervision_experience_events WHERE experience_id = ? AND role = 'formed'")
    for (const [ref, row] of xRefs) formedEvents.set(ref, formedOf.all(String(row.id)).map(item => String(item.event_id)))
    const related = (experience: string, eventId: string) => {
      const formed = new Set((formedEvents.get(experience) ?? []).flatMap(id => entitiesOf.all(id).map(item => String(item.entity_id))))
      return entitiesOf.all(eventId).some(item => formed.has(String(item.entity_id)))
    }
    const timely = output.applications.filter(application => {
      const since = formedAt.get(application.experience)
      return (!since || refs.get(application.event)!.at > since) && related(application.experience, refs.get(application.event)!.id)
    })
    const removed = this.db.prepare("SELECT id, statement FROM supervision_experiences WHERE status = 'removed'").all()
    const removedStatements = new Set(removed.map(row => statementKey(String(row.statement))))
    const removedEvidence = this.db.prepare(`SELECT experience_id, event_id FROM supervision_experience_events
      WHERE role = 'formed' AND experience_id IN (SELECT id FROM supervision_experiences WHERE status = 'removed')`).all()
    const evidenceOf = new Map<string, Set<string>>()
    for (const row of removedEvidence) evidenceOf.set(String(row.experience_id), (evidenceOf.get(String(row.experience_id)) ?? new Set()).add(String(row.event_id)))
    const current = new Map(existing.map(row => [statementKey(String(row.statement)), String(row.id)]))
    const now = new Date().toISOString()
    const ids = new Map<string, string | null>()
    for (const [ref, row] of xRefs) ids.set(ref, String(row.id))
    let created = 0, applied = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const link = this.db.prepare('INSERT OR IGNORE INTO supervision_experience_events (experience_id, event_id, role, note) VALUES (?, ?, ?, ?)')
      for (const item of output.experiences) {
        const key = statementKey(item.statement)
        const formed = item.formed.map(ref => refs.get(ref)!.id)
        // A removed experience stays removed: same statement, or no evidence beyond what it had.
        if (removedStatements.has(key) || [...evidenceOf.values()].some(set => formed.every(id => set.has(id)))) { ids.set(item.key, null); continue }
        let id = current.get(key)
        if (!id) {
          id = randomUUID()
          this.db.prepare(`INSERT INTO supervision_experiences (id, statement, conditions, boundaries, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(id, item.statement, item.conditions, item.boundaries, now, now)
          current.set(key, id)
          created++
        }
        ids.set(item.key, id)
        for (const eventId of formed) link.run(id, eventId, 'formed', '')
      }
      for (const application of timely) {
        const id = ids.get(application.experience)
        if (id) applied += Number(link.run(id, refs.get(application.event)!.id, 'applied', application.note).changes)
      }
      const seen = this.db.prepare('INSERT OR IGNORE INTO supervision_experience_seen (event_id) VALUES (?)')
      for (const event of events) seen.run(event.id)
      this.db.exec('COMMIT')
      return { created, applied }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  list(projectIds?: string[]): SupervisionExperience[] {
    const rows = this.db.prepare(`SELECT * FROM supervision_experiences WHERE status = 'current'
      AND id IN (SELECT x.experience_id FROM supervision_experience_events x JOIN supervision_events e ON e.id = x.event_id
        WHERE x.role = 'formed' AND e.superseded_by IS NULL)
      AND (? IS NULL OR id IN (SELECT x.experience_id FROM supervision_experience_events x JOIN supervision_events e ON e.id = x.event_id
        WHERE e.superseded_by IS NULL AND e.project_id != '' AND e.project_id IN (SELECT value FROM json_each(?))))
      ORDER BY created_at, rowid`).all(projectIds ? 1 : null, JSON.stringify(projectIds ?? []))
    if (!rows.length) return []
    // Scope selects experiences, not their links: cross-project context remains complete.
    const links = this.db.prepare(`SELECT x.experience_id, x.event_id, x.role, x.note, e.title, e.project_id,
        COALESCE(e.started_at, e.occurred_at) AS at, s.id AS story_id, s.name AS story_name
      FROM supervision_experience_events x JOIN supervision_events e ON e.id = x.event_id
        LEFT JOIN supervision_event_stories es ON es.event_id = e.id AND es.is_primary = 1
        LEFT JOIN supervision_stories s ON s.id = es.story_id
      WHERE x.experience_id IN (SELECT value FROM json_each(?)) AND e.superseded_by IS NULL
      ORDER BY x.experience_id, at, e.id, x.role`).all(JSON.stringify(rows.map(row => row.id)))
    const byExperience = new Map<string, SupervisionExperience['events']>()
    for (const link of links) {
      const id = String(link.experience_id)
      const events = byExperience.get(id) ?? []
      events.push({ id: String(link.event_id), role: link.role as 'formed' | 'applied', note: String(link.note),
        title: String(link.title), projectId: link.project_id ? String(link.project_id) : null, at: String(link.at),
        storyId: link.story_id ? String(link.story_id) : null, storyName: link.story_name ? String(link.story_name) : null })
      byExperience.set(id, events)
    }
    return rows.map(row => ({ id: String(row.id), statement: String(row.statement), conditions: String(row.conditions), boundaries: String(row.boundaries),
      userEdited: row.user_edited === 1, events: byExperience.get(String(row.id)) ?? [] }))
  }

  /** Snapshot of the experiences and links an adjustment changes, for undo. */
  snapshot(ids: string[]): string {
    return JSON.stringify({
      experiences: this.db.prepare('SELECT * FROM supervision_experiences WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)),
      links: this.db.prepare('SELECT * FROM supervision_experience_events WHERE experience_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids))
    })
  }

  /** Runs inside the caller's transaction. */
  act(action: SupervisionExperienceAction, now: string): void {
    const row = this.db.prepare("SELECT id FROM supervision_experiences WHERE id = ? AND status = 'current'").get(action.experienceId)
    if (!row) throw new Error('经验不存在或已被调整')
    if (action.action === 'experience-edit') {
      this.db.prepare('UPDATE supervision_experiences SET statement = ?, conditions = ?, boundaries = ?, user_edited = 1, updated_at = ? WHERE id = ?')
        .run(action.statement, action.conditions, action.boundaries, now, action.experienceId)
    } else if (action.action === 'experience-merge') {
      if (action.intoId === action.experienceId || !this.db.prepare("SELECT 1 FROM supervision_experiences WHERE id = ? AND status = 'current'").get(action.intoId)) throw new Error('只能合并到另一条现有经验')
      this.db.prepare('INSERT OR IGNORE INTO supervision_experience_events (experience_id, event_id, role, note) SELECT ?, event_id, role, note FROM supervision_experience_events WHERE experience_id = ?')
        .run(action.intoId, action.experienceId)
      this.db.prepare("UPDATE supervision_experiences SET status = 'merged', merged_into = ?, updated_at = ? WHERE id = ?").run(action.intoId, now, action.experienceId)
      this.db.prepare('UPDATE supervision_experiences SET user_edited = 1, updated_at = ? WHERE id = ?').run(now, action.intoId)
    } else {
      this.db.prepare("UPDATE supervision_experiences SET status = 'removed', updated_at = ? WHERE id = ?").run(now, action.experienceId)
    }
  }

  /** Restores a snapshot taken by `snapshot`. Runs inside the caller's transaction. */
  restore(before: { experiences: Row[]; links: Row[] }): void {
    const ids = JSON.stringify(before.experiences.map(row => String(row.id)))
    for (const row of before.experiences) {
      this.db.prepare('UPDATE supervision_experiences SET statement = ?, conditions = ?, boundaries = ?, status = ?, merged_into = ?, user_edited = ?, updated_at = ? WHERE id = ?')
        .run(String(row.statement), String(row.conditions), String(row.boundaries), String(row.status), row.merged_into == null ? null : String(row.merged_into),
          Number(row.user_edited), String(row.updated_at), String(row.id))
    }
    this.db.prepare('DELETE FROM supervision_experience_events WHERE experience_id IN (SELECT value FROM json_each(?))').run(ids)
    const insert = this.db.prepare('INSERT OR IGNORE INTO supervision_experience_events (experience_id, event_id, role, note) VALUES (?, ?, ?, ?)')
    for (const link of before.links) insert.run(String(link.experience_id), String(link.event_id), String(link.role), String(link.note))
  }
}
