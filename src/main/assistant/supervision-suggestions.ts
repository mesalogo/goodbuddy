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
}

export type SuggestionPhrase = { ref: string; title: string; detail: string }

type SuggestionRow = {
  id: string; result_id: string | null; heartbeat_run_id: string | null; scope_json: string; kind: SupervisionSuggestionKind
  title: string; detail: string; source_reference_ids_json: string; entity_id: string | null; relation_id: string | null
  task_id: string | null; memory_id: string | null; status: SupervisionSuggestion['status']; created_at: string
}

// One heartbeat never produces an unbounded list; remaining facts stay in the graph.
export const maximumSuggestionsPerReview = 20

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
    taskId: row.task_id, status: row.status, createdAt: row.created_at
  }
}

export class SupervisionSuggestionStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Select rule-based candidates from the graph changes of one published result. */
  candidates(supervisionRunId: string): { resultId: string; scope: SupervisionRunRequest['scope']; candidates: SuggestionCandidate[] } | undefined {
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

    // Never repeat a pending suggestion. A handled one returns only with new evidence;
    // an accepted open item (now a task) or convention (now background) does not return.
    const previous = this.db.prepare(`SELECT status, evidence_key FROM supervision_suggestions
      WHERE scope_json = ? AND fingerprint = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    const candidates = found.filter(candidate => {
      const row = previous.get(JSON.stringify(scope), candidate.fingerprint) as { status: string; evidence_key: string } | undefined
      if (!row) return true
      if (row.status === 'pending' || row.evidence_key === candidate.evidenceKey) return false
      return !(row.status === 'accepted' && (candidate.kind === 'open_item' || candidate.kind === 'convention'))
    }).slice(0, maximumSuggestionsPerReview).map((candidate, index) => ({ ...candidate, ref: `c${index + 1}` }))
    return { resultId: result.id, scope, candidates }
  }

  save(input: { resultId: string; heartbeatRunId: string; scope: SupervisionRunRequest['scope']; candidates: SuggestionCandidate[]; phrases: SuggestionPhrase[] }): number {
    const phrases = new Map(input.phrases.map(phrase => [phrase.ref, phrase]))
    const insert = this.db.prepare(`INSERT INTO supervision_suggestions
      (id, result_id, heartbeat_run_id, scope_json, kind, fingerprint, title, detail, source_reference_ids_json,
       entity_id, relation_id, evidence_key, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
    const timestamp = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const candidate of input.candidates) {
        const phrase = phrases.get(candidate.ref)
        insert.run(randomUUID(), input.resultId, input.heartbeatRunId, JSON.stringify(input.scope), candidate.kind, candidate.fingerprint,
          (phrase?.title || candidate.title).slice(0, 200), phrase?.detail || candidate.detail, JSON.stringify(candidate.sourceIds),
          candidate.entityId ?? null, candidate.relationId ?? null, candidate.evidenceKey, timestamp, timestamp)
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
