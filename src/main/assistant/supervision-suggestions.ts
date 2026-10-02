import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  SupervisionRunRequest,
  SupervisionSuggestion,
  SupervisionSuggestionKind,
  SupervisionSummaryOutput
} from '../../shared/supervision-contracts'

/**
 * A suggestion candidate selected by rules from one published review. The
 * model only phrases candidates; it never reads original sources here.
 */
export type SuggestionCandidate = {
  ref: string
  kind: SupervisionSuggestionKind
  fingerprint: string
  evidenceKey: string
  title: string
  detail: string
  sourceIds: string[]
  entityId?: string
  relationId?: string
  storyId?: string
  experienceId?: string
}

export type StoryCandidateOptions = { stalledDays?: number; now?: string }

export type SuggestionPhrase = { ref: string; title: string; detail: string }

type SuggestionRow = {
  id: string; result_id: string | null; heartbeat_run_id: string | null; scope_json: string; kind: SupervisionSuggestionKind
  title: string; detail: string; source_reference_ids_json: string; entity_id: string | null; relation_id: string | null
  task_id: string | null; memory_id: string | null; status: SupervisionSuggestion['status']; created_at: string
  story_id?: string | null; experience_id?: string | null
}

// One heartbeat never produces an unbounded list; remaining facts stay in the graph.
export const maximumSuggestionsPerReview = 20
// Stalled stories are offered a few at a time, largest first; the rest wait for later heartbeats.
export const maximumStalledPerReview = 3
export const maximumExperiencePerReview = 3
// Entities seen in more stories than this are too general to indicate where an experience applies.
export const maximumEntityStories = 4

const normalize = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)
const parseIds = (value: unknown): string[] => {
  try {
    const ids = JSON.parse(String(value ?? '[]')) as unknown
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
  } catch { return [] }
}

export function toSupervisionSuggestion(row: SuggestionRow): SupervisionSuggestion {
  return {
    id: row.id, resultId: row.result_id, heartbeatRunId: row.heartbeat_run_id,
    scope: JSON.parse(row.scope_json) as SupervisionRunRequest['scope'], kind: row.kind, title: row.title, detail: row.detail,
    sourceIds: parseIds(row.source_reference_ids_json), entityId: row.entity_id, relationId: row.relation_id,
    taskId: row.task_id, status: row.status, createdAt: row.created_at,
    storyId: row.story_id ?? null, experienceId: row.experience_id ?? null
  }
}

export class SupervisionSuggestionStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Select rule-based candidates from the graph changes of one published result. */
  candidates(supervisionRunId: string, options: StoryCandidateOptions = {}): { resultId: string; scope: SupervisionRunRequest['scope']; candidates: SuggestionCandidate[] } | undefined {
    const result = this.db.prepare(`SELECT r.id, r.open_items_json, r.graph_snapshot_json, s.scope_json FROM supervision_results r
      JOIN supervision_runs s ON s.id = r.run_id WHERE r.run_id = ? ORDER BY r.created_at DESC LIMIT 1`).get(supervisionRunId) as
      { id: string; open_items_json: string; graph_snapshot_json: string | null; scope_json: string } | undefined
    if (!result) return undefined
    const scope = JSON.parse(result.scope_json) as SupervisionRunRequest['scope']
    const found: SuggestionCandidate[] = []
    const sources = this.db.prepare('SELECT id, source_type, source_id, locator_json, content FROM supervision_sources WHERE result_id = ?')
      .all(result.id) as Array<{ id: string; source_type: string; source_id: string; locator_json: string | null; content: string }>
    // Source row IDs are new for every result; evidence identity is the original source and its content.
    const stable = new Map(sources.map(source => [source.id, `${source.source_type}:${source.source_id}:${hash(source.content)}`]))
    const evidenceKey = (ids: string[]) => hash([...new Set(ids.map(id => stable.get(id) ?? id))].sort())
    const sourceKey = (type: string, id: string, locator: unknown) => JSON.stringify([type, id, locator ?? null])
    const sourceByEvidence = new Map(sources.map(source => [
      sourceKey(source.source_type, source.source_id, source.locator_json ? JSON.parse(source.locator_json) as unknown : null), source.id]))

    // Open items stay attributed to the batch that raised them.
    const openItems = new Map<string, { text: string; sources: Set<string> }>()
    const addOpenItem = (text: string, sourceIds: string[]) => {
      const key = normalize(text)
      if (!key) return
      const item = openItems.get(key) ?? { text, sources: new Set<string>() }
      for (const id of sourceIds) item.sources.add(id)
      openItems.set(key, item)
    }
    const batches = this.db.prepare('SELECT evidence_json, output_json FROM supervision_review_batches WHERE run_id = ? ORDER BY rowid')
      .all(supervisionRunId) as Array<{ evidence_json: string; output_json: string }>
    for (const batch of batches) {
      const output = JSON.parse(batch.output_json) as SupervisionSummaryOutput
      const evidence = JSON.parse(batch.evidence_json) as Array<{ sourceType: string; sourceId: string; locator?: unknown }>
      const sourceIds = evidence.flatMap(item => sourceByEvidence.get(sourceKey(item.sourceType, item.sourceId, item.locator)) ?? [])
      for (const text of output.openItems) addOpenItem(text, sourceIds)
    }
    if (!batches.length) for (const text of parseIds(result.open_items_json)) addOpenItem(text, sources.map(source => source.id))
    for (const [key, item] of openItems) {
      const sourceIds = [...item.sources].sort()
      found.push({ ref: '', kind: 'open_item', fingerprint: `open_item:${hash(key)}`, evidenceKey: evidenceKey(sourceIds),
        title: item.text.slice(0, 200), detail: item.text, sourceIds })
    }

    const revisions = this.db.prepare(`SELECT c.entity_id, c.description, c.source_reference_ids_json, e.canonical_label
      FROM supervision_entity_changes c JOIN supervision_entities e ON e.id = c.entity_id
      WHERE c.result_id = ? AND c.change_type = 'revised' AND e.confirmation_state != 'revoked'`).all(result.id) as
      Array<{ entity_id: string; description: string; source_reference_ids_json: string; canonical_label: string }>
    for (const revision of revisions) {
      const sourceIds = parseIds(revision.source_reference_ids_json).sort()
      found.push({ ref: '', kind: 'revision', fingerprint: `revision:${revision.entity_id}`, evidenceKey: evidenceKey(sourceIds),
        title: revision.canonical_label.slice(0, 200), detail: revision.description, sourceIds, entityId: revision.entity_id })
    }

    const snapshot = result.graph_snapshot_json ? JSON.parse(result.graph_snapshot_json) as {
      entities?: Array<{ id: string; canonical_label: string; description: string; confirmation_state: string }>
      relations?: Array<{ id: string; from_entity_id: string; to_entity_id: string; relation_type: string; reason: string; confirmation_state: string; source_reference_ids_json?: string }>
    } : {}
    const labels = new Map((snapshot.entities ?? []).map(entity => [entity.id, entity.canonical_label]))
    for (const relation of snapshot.relations ?? []) {
      if (relation.relation_type !== 'contrasts' || relation.confirmation_state === 'revoked') continue
      const sourceIds = parseIds(relation.source_reference_ids_json).sort()
      const title = `${labels.get(relation.from_entity_id) ?? ''} / ${labels.get(relation.to_entity_id) ?? ''}`.slice(0, 200)
      found.push({ ref: '', kind: 'conflict', fingerprint: `conflict:${relation.id}`, evidenceKey: evidenceKey(sourceIds),
        title, detail: relation.reason, sourceIds, relationId: relation.id })
    }

    // Supported by at least three distinct original sources without being confirmed:
    // a candidate long-term convention or preference. Re-reviewing one source does not count.
    for (const entity of snapshot.entities ?? []) {
      if (entity.confirmation_state !== 'automatic') continue
      const repeated = this.db.prepare(`SELECT COUNT(DISTINCT s.source_type || ':' || s.source_id) AS count FROM supervision_event_entities ee
        JOIN supervision_event_sources es ON es.event_id = ee.event_id JOIN supervision_sources s ON s.id = es.source_id WHERE ee.entity_id = ?`)
        .get(entity.id) as { count: number }
      if (Number(repeated.count) < 3) continue
      const sourceIds = parseIds(this.db.prepare('SELECT source_reference_ids_json FROM supervision_entities WHERE id = ?')
        .get(entity.id)?.source_reference_ids_json).sort()
      found.push({ ref: '', kind: 'convention', fingerprint: `convention:${entity.id}`, evidenceKey: evidenceKey(sourceIds),
        title: entity.canonical_label.slice(0, 200), detail: entity.description, sourceIds, entityId: entity.id })
    }

    // Story-level candidates are few and come first, so a long list of open items cannot crowd them out.
    found.unshift(...this.storyCandidates(result.id, scope, options))

    // Never repeat a pending suggestion. A handled one returns only with new evidence;
    // an accepted open item (now a task) or convention (now background) does not return.
    const previous = this.db.prepare(`SELECT status, evidence_key FROM supervision_suggestions
      WHERE scope_json = ? AND fingerprint = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    const candidates = found.filter(candidate => {
      const row = previous.get(JSON.stringify(scope), candidate.fingerprint) as { status: string; evidence_key: string } | undefined
      if (!row) return true
      if (row.status === 'pending' || row.evidence_key === candidate.evidenceKey) return false
      return !(row.status === 'accepted' && (candidate.kind === 'open_item' || candidate.kind === 'convention' || candidate.kind === 'experience'))
    }).slice(0, maximumSuggestionsPerReview).map((candidate, index) => ({ ...candidate, ref: `c${index + 1}` }))
    return { resultId: result.id, scope, candidates }
  }

  /**
   * Story-level candidates, by rules only:
   * - stalled: an active feature or thread of the scope whose latest event is older than `stalledDays`.
   *   Quiet is never treated as finished; the suggestion only asks the user to look.
   * - experience: an experience formed in one story whose formation events share an entity with an
   *   event this review placed in a different story, where the experience was not applied yet.
   */
  private storyCandidates(resultId: string, scope: SupervisionRunRequest['scope'], options: StoryCandidateOptions): SuggestionCandidate[] {
    const found: SuggestionCandidate[] = []
    const projects = scope.kind === 'projects' ? JSON.stringify(scope.projectIds) : null
    const now = Date.parse(options.now ?? new Date().toISOString())
    const stalledDays = options.stalledDays ?? 14
    const stories = this.db.prepare(`SELECT s.id, s.name, s.description, MAX(COALESCE(e.ended_at, e.occurred_at)) AS last_at,
        COUNT(*) AS events, (SELECT x.id FROM supervision_event_stories xs JOIN supervision_events x ON x.id = xs.event_id
          WHERE xs.story_id = s.id AND xs.is_primary = 1 AND x.superseded_by IS NULL ORDER BY COALESCE(x.ended_at, x.occurred_at) DESC, x.id DESC LIMIT 1) AS last_event
      FROM supervision_stories s JOIN supervision_event_stories es ON es.story_id = s.id AND es.is_primary = 1
      JOIN supervision_events e ON e.id = es.event_id AND e.superseded_by IS NULL
      WHERE s.status = 'current' AND s.state = 'active' AND s.level IN ('feature', 'thread')
        AND (? IS NULL OR s.project_id IN (SELECT value FROM json_each(?)))
      GROUP BY s.id HAVING COUNT(*) >= 3 ORDER BY last_at`).all(projects, projects) as Array<{ id: string; name: string; description: string; last_at: string; events: number; last_event: string }>
    const quiet = stories.filter(story => Math.floor((now - Date.parse(story.last_at)) / 86_400_000) >= stalledDays)
    // Already pending or handled without new events: not counted against the cap.
    const seen = this.db.prepare("SELECT 1 FROM supervision_suggestions WHERE fingerprint = ? AND (status = 'pending' OR evidence_key = ?) LIMIT 1")
    const fresh = quiet.filter(story => !seen.get(`stalled:${story.id}`, hash(story.last_event)))
      .sort((a, b) => b.events - a.events || a.last_at.localeCompare(b.last_at)).slice(0, maximumStalledPerReview)
    for (const story of fresh) {
      const days = Math.floor((now - Date.parse(story.last_at)) / 86_400_000)
      if (!Number.isFinite(days) || days < stalledDays) continue
      const sourceIds = this.eventSources([story.last_event])
      found.push({ ref: '', kind: 'stalled', fingerprint: `stalled:${story.id}`, evidenceKey: hash(story.last_event),
        title: story.name.slice(0, 200), detail: `${story.name}: ${days} days without new events since ${story.last_at.slice(0, 10)}. ${story.description}`.trim(),
        sourceIds, storyId: story.id })
    }
    const placed = this.db.prepare(`SELECT e.id, es.story_id, s.name AS story_name FROM supervision_events e
      JOIN supervision_event_stories es ON es.event_id = e.id AND es.is_primary = 1 JOIN supervision_stories s ON s.id = es.story_id
      WHERE e.result_id = ? AND e.superseded_by IS NULL`).all(resultId) as Array<{ id: string; story_id: string; story_name: string }>
    if (!placed.length) return found
    const experiences = this.db.prepare("SELECT id, statement, conditions FROM supervision_experiences WHERE status = 'current'").all() as Array<{ id: string; statement: string; conditions: string }>
    const links = this.db.prepare(`SELECT x.event_id, x.role, es.story_id FROM supervision_experience_events x
      LEFT JOIN supervision_event_stories es ON es.event_id = x.event_id AND es.is_primary = 1 WHERE x.experience_id = ?`)
    const entitiesOf = this.db.prepare('SELECT entity_id FROM supervision_event_entities WHERE event_id = ?')
    // An entity that spans many stories (such as a product name) says nothing about where a lesson applies.
    const spread = this.db.prepare(`SELECT COUNT(DISTINCT es.story_id) AS n FROM supervision_event_entities ee
      JOIN supervision_event_stories es ON es.event_id = ee.event_id AND es.is_primary = 1 WHERE ee.entity_id = ?`)
    const specific = new Map<string, boolean>()
    const isSpecific = (id: string) => {
      if (!specific.has(id)) specific.set(id, Number((spread.get(id) as { n: number }).n) <= maximumEntityStories)
      return specific.get(id)!
    }
    const proposals: SuggestionCandidate[] = []
    for (const experience of experiences) {
      const rows = links.all(experience.id) as Array<{ event_id: string; role: string; story_id: string | null }>
      const usedStories = new Set(rows.map(row => row.story_id))
      const formedEntities = new Set(rows.filter(row => row.role === 'formed')
        .flatMap(row => entitiesOf.all(row.event_id).map(item => String(item.entity_id))).filter(isSpecific))
      if (!formedEntities.size) continue
      const matches = new Map<string, { name: string; events: string[] }>()
      for (const event of placed) {
        if (usedStories.has(event.story_id)) continue
        if (!entitiesOf.all(event.id).some(item => formedEntities.has(String(item.entity_id)))) continue
        const match = matches.get(event.story_id) ?? { name: event.story_name, events: [] }
        match.events.push(event.id)
        matches.set(event.story_id, match)
      }
      // One target per experience: the story with the most matching events.
      const best = [...matches].sort((a, b) => b[1].events.length - a[1].events.length || a[0].localeCompare(b[0]))[0]
      if (!best) continue
      const [storyId, match] = best
      const candidate: SuggestionCandidate = { ref: '', kind: 'experience', fingerprint: `experience:${experience.id}:${storyId}`, evidenceKey: hash(match.events.sort()),
        title: experience.statement.slice(0, 200),
        detail: `May apply to "${match.name}". ${experience.conditions ? `Applies when: ${experience.conditions}` : ''}`.trim(),
        sourceIds: this.eventSources(match.events), storyId, experienceId: experience.id }
      if (!seen.get(candidate.fingerprint, candidate.evidenceKey)) proposals.push(candidate)
    }
    const weight = (candidate: SuggestionCandidate) => candidate.sourceIds.length
    found.push(...proposals.sort((a, b) => weight(b) - weight(a)).slice(0, maximumExperiencePerReview))
    return found
  }

  private eventSources(eventIds: string[]): string[] {
    return (this.db.prepare(`SELECT DISTINCT source_id FROM supervision_event_sources WHERE event_id IN (SELECT value FROM json_each(?)) ORDER BY source_id`)
      .all(JSON.stringify(eventIds)) as Array<{ source_id: string }>).map(row => String(row.source_id))
  }

  save(input: { resultId: string; heartbeatRunId: string; scope: SupervisionRunRequest['scope']; candidates: SuggestionCandidate[]; phrases: SuggestionPhrase[] }): number {
    const phrases = new Map(input.phrases.map(phrase => [phrase.ref, phrase]))
    const insert = this.db.prepare(`INSERT INTO supervision_suggestions
      (id, result_id, heartbeat_run_id, scope_json, kind, fingerprint, title, detail, source_reference_ids_json,
       entity_id, relation_id, evidence_key, status, created_at, updated_at, story_id, experience_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
    const timestamp = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const candidate of input.candidates) {
        const phrase = phrases.get(candidate.ref)
        insert.run(randomUUID(), input.resultId, input.heartbeatRunId, JSON.stringify(input.scope), candidate.kind, candidate.fingerprint,
          (phrase?.title || candidate.title).slice(0, 200), phrase?.detail || candidate.detail, JSON.stringify(candidate.sourceIds),
          candidate.entityId ?? null, candidate.relationId ?? null, candidate.evidenceKey, timestamp, timestamp,
          candidate.storyId ?? null, candidate.experienceId ?? null)
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return input.candidates.length
  }

  list(status: 'pending' | 'all', limit: number, offset: number): SupervisionSuggestion[] {
    return (this.db.prepare(`SELECT * FROM supervision_suggestions WHERE (? = 'all' OR status = 'pending')
      ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(status, limit, offset) as SuggestionRow[]).map(toSupervisionSuggestion)
  }

  get(id: string): (SupervisionSuggestion & { memoryId: string | null }) | undefined {
    const row = this.db.prepare('SELECT * FROM supervision_suggestions WHERE id = ?').get(id) as SuggestionRow | undefined
    return row ? { ...toSupervisionSuggestion(row), memoryId: row.memory_id } : undefined
  }

  resolve(id: string, status: 'accepted' | 'dismissed', links: { taskId?: string; memoryId?: string } = {}): void {
    const changed = this.db.prepare(`UPDATE supervision_suggestions SET status = ?, task_id = COALESCE(?, task_id),
      memory_id = COALESCE(?, memory_id), updated_at = ? WHERE id = ? AND status = 'pending'`)
      .run(status, links.taskId ?? null, links.memoryId ?? null, new Date().toISOString(), id)
    if (!changed.changes) throw new Error('此建议已处理或不存在')
  }

  countForHeartbeat(heartbeatRunId: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS count FROM supervision_suggestions WHERE heartbeat_run_id = ?').get(heartbeatRunId) as { count: number }).count)
  }
}
