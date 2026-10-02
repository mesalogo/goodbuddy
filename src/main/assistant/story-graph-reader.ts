import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { HeartbeatScope } from '../../shared/assistant-contracts'
import { storyGraphContextSchema, storyGraphSearchSchema, storyGraphSourceSchema, type StoryGraphToolName } from '../../shared/story-graph-tools'
import type { SupervisionEvidence, SupervisionSummaryOutput } from '../../shared/supervision-contracts'
import { SupervisionExperienceStore } from './supervision-experiences'
import { SupervisionStoryStore } from './supervision-stories'

type Row = Record<string, unknown>
type Fact = {
  object_ref: { type: string; id: string }
  object_revision: string
  result_id: string | null
  scope: HeartbeatScope
  event_time: string | null
  review_generated_at: string | null
  recorded_at: string | null
  confirmation_state: string
  validity: 'unknown'
  source_reference_ids: string[]
  data: Row
}
/** Upper bound on projected objects per read (PERF-15). Normal scopes are far below it. */
export const STORY_GRAPH_MAX_FACTS = 50_000
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const cursorSchema = z.object({ key: z.string(), revision: z.string(), index: z.number().int().nonnegative(), offset: z.number().int().nonnegative() }).strict()
const normalizeScope = (scope: HeartbeatScope): HeartbeatScope => scope.kind === 'global' ? scope : { kind: 'projects', projectIds: [...new Set(scope.projectIds)].sort() }
const timestamp = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
const bounded = (output: Row): Row => {
  if (Buffer.byteLength(JSON.stringify(output)) > 100_000) throw new Error('response_too_large: retry with a smaller page_size')
  return output
}

/** Words split on spaces and punctuation; CJK runs become overlapping pairs, so "回顾调度" matches "回顾" and "调度". */
export function queryTerms(query: string): string[] {
  const terms = new Set<string>()
  for (const word of query.toLowerCase().split(/[\s\p{P}\p{S}]+/u)) {
    if (!word) continue
    for (const run of word.split(/(\p{Script=Han}+)/u)) {
      if (!run) continue
      if (/^\p{Script=Han}+$/u.test(run)) {
        const chars = Array.from(run)
        if (chars.length === 1) terms.add(run)
        for (let i = 0; i + 1 < chars.length; i++) terms.add(chars[i]! + chars[i + 1]!)
      } else if (run.length >= 2 || /\d/.test(run)) terms.add(run)
    }
  }
  return [...terms]
}

// This is a projection of existing storage, not a second graph or a historical state store.
export function readStoryGraph(db: DatabaseSync, name: StoryGraphToolName, input: unknown, projectId?: string, signal?: AbortSignal,
  maxFacts = STORY_GRAPH_MAX_FACTS): Record<string, unknown> {
  signal?.throwIfAborted()
  if (input && typeof input === 'object' && ('as_of' in input || ('mode' in input && input.mode === 'as_of'))) throw new Error('unsupported_mode: as_of is not supported')
  const args = name === 'story_graph_search' ? storyGraphSearchSchema.parse(input)
    : name === 'story_graph_get_context' ? storyGraphContextSchema.parse(input) : storyGraphSourceSchema.parse(input)
  const requested = args.scope ?? (projectId ? { kind: 'projects' as const, projectIds: [projectId] } : undefined)
  if (!requested) throw new Error('scope_required: no current project; specify scope explicitly')
  const scope = normalizeScope(requested)
  if (scope.kind === 'projects') for (const id of scope.projectIds) {
    if (!db.prepare("SELECT id FROM projects WHERE id = ? AND status = 'active'").get(id)) throw new Error('scope_unavailable: project does not exist or is inactive')
  }
  const base = { requested_scope: args.scope ?? 'current_project', resolved_scope: scope, read_at: new Date().toISOString(),
    coverage: { status: 'unknown', semantic_completeness: 'unknown', unprocessed_sources: 'unknown', historical_reconstruction: false,
      note: 'Exact stored scope only. Saved results and fragments do not establish complete source or semantic coverage.' } }
  const key = digest({ name, ...args, scope, cursor: undefined })
  let cursor: z.infer<typeof cursorSchema> | undefined
  if (args.cursor) {
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8'))) }
    catch { throw new Error('invalid_cursor') }
    if (cursor.key !== key) throw new Error('invalid_cursor: repeat the original filters and page sizes')
  }
  const page = (revision: string, index: number, offset: number, more: boolean, count: number, total: number) => ({
    returned_count: count, total_count: total, has_more: more, complete: !more,
    next_cursor: more ? Buffer.from(JSON.stringify({ key, revision, index, offset })).toString('base64url') : null,
    limit_reason: more ? 'page_size' : null
  })
  const checkRevision = (revision: string): void => { if (cursor && cursor.revision !== revision) throw new Error('stale_cursor: stored evidence changed; restart the query') }
  const sameScope = (value: unknown): boolean => JSON.stringify(normalizeScope(JSON.parse(String(value)))) === JSON.stringify(scope)
  if (name === 'story_graph_read_source') {
    const sourceArgs = storyGraphSourceSchema.parse(input)
    const source = db.prepare(`SELECT s.*, sr.scope_json, r.created_at AS generated_at FROM supervision_sources s
      JOIN supervision_results r ON r.id = s.result_id JOIN supervision_runs sr ON sr.id = r.run_id WHERE s.id = ?`).get(sourceArgs.source_reference_id)
    if (!source) throw new Error('source_not_found')
    const locator = source.locator_json ? JSON.parse(String(source.locator_json)) as Row : {}
    // Sources belong to the shared timeline: readable from the run's scope, from global,
    // or from a project scope containing the source's own project.
    const inScope = sameScope(source.scope_json) || scope.kind === 'global'
      || (typeof locator.projectId === 'string' && scope.projectIds.includes(locator.projectId))
    if (!inScope) throw new Error('scope_mismatch')
    const version = typeof locator.revision === 'string' ? locator.revision : 'unknown'
    if (sourceArgs.content_kind === 'version' && !sourceArgs.source_version) throw new Error('source_version_required')
    let body = String(source.content)
    let returnedVersion = version
    let location = locator
    let originalLength: unknown = source.source_type === 'knowledge' ? 'unknown' : locator.length ?? 'unknown'
    if (sourceArgs.content_kind !== 'snapshot') {
      // Resolve only an exact saved locator. Never replace a missing historical original with a snapshot.
      const sourceKey = typeof locator.source === 'string' ? locator.source
        : source.source_type === 'conversation' && typeof locator.messageId === 'string' ? `message:${locator.messageId}`
          : source.source_type === 'task' ? `task:${source.source_id}` : ''
      const kind = sourceKey.slice(0, sourceKey.indexOf(':'))
      const key = sourceKey.slice(sourceKey.indexOf(':') + 1)
      const separator = key.lastIndexOf(':')
      const current = sourceKey ? db.prepare(`SELECT body, locator, project_id, context
        FROM supervision_review_current WHERE record_id = ? AND reference_index = ? AND type = ?`).get(
          kind === 'knowledge' ? key.slice(0, separator) : key,
          kind === 'knowledge' ? Number(key.slice(separator + 1)) : 0,
          kind === 'message' ? 'conversation' : kind) : undefined
      if (current && scope.kind === 'projects' && !scope.projectIds.includes(String(current.project_id))) throw new Error('scope_mismatch: source moved out of the requested scope')
      const currentRevision = current ? createHash('sha256').update(String(current.context)).digest('hex') : undefined
      if (!current || (sourceArgs.content_kind === 'version' && currentRevision !== sourceArgs.source_version)) {
        return { ...base, error: sourceArgs.content_kind === 'version' ? 'historical_version_unavailable' : 'current_source_unavailable',
          original_source_availability: current ? 'available' : 'unavailable', available_content_kinds: current ? ['snapshot', 'current'] : ['snapshot'] }
      }
      body = String(current.body)
      returnedVersion = currentRevision!
      location = JSON.parse(String(current.locator)) as Row
      originalLength = source.source_type === 'knowledge' ? 'unknown' : Array.from(body).length
    }
    const content = Array.from(body)
    const revision = digest({ source, body, returnedVersion, location })
    checkRevision(revision)
    const start = cursor?.offset ?? 0
    if (start > content.length) throw new Error('invalid_cursor')
    const end = Math.min(content.length, start + sourceArgs.page_size)
    signal?.throwIfAborted()
    return bounded({ ...base, source_reference_id: source.id, result_id: source.result_id, original_source_id: source.source_id,
      source_type: source.source_type, content_kind: sourceArgs.content_kind, requested_version: sourceArgs.source_version ?? null,
      content_extent: sourceArgs.content_kind === 'snapshot' ? 'saved_fragment' : source.source_type === 'knowledge' ? 'current_reference_fragment' : 'source_record',
      source_version: returnedVersion, reference_version: version, differs_from_reference: version === 'unknown' ? 'unknown' : returnedVersion !== version,
      object_revision: revision, source_location: location, availability: source.availability,
      original_source_availability: sourceArgs.content_kind === 'snapshot' ? 'unknown' : 'available', source_record_time: source.occurred_at, event_time: null,
      review_generated_at: source.generated_at, recorded_at: source.generated_at,
      content: content.slice(start, end).join(''), position: { start, end, unit: 'unicode_code_point' },
      saved_fragment: { start: locator.start ?? 'unknown', end: locator.end ?? 'unknown', length: Array.from(String(source.content)).length },
      reviewed_source_length: locator.length ?? 'unknown',
      original_source_length: originalLength,
      page: page(revision, 0, end, end < content.length, end - start, content.length) })
  }
  const facts: Fact[] = []
  const results = new Map<string, Row>()
  // SQL prefilter on the scope kind and project membership (a superset of exact
  // matches); the exact normalized comparison still runs in JS.
  const stories = db.prepare(`SELECT * FROM story_lines
    WHERE json_extract(scope_json, '$.kind') = ?
      AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM json_each(?) requested
        WHERE requested.value NOT IN (SELECT value FROM json_each(story_lines.scope_json, '$.projectIds'))))
    ORDER BY id`).all(scope.kind, scope.kind === 'projects' ? 1 : null, scope.kind === 'projects' ? JSON.stringify(scope.projectIds) : '[]')
    .filter(row => sameScope(row.scope_json))
  const add = (type: string, data: Row, result?: Row, sources?: string[]): void => {
    // Bound the in-memory projection; a scope this large must be narrowed rather than truncated,
    // since a partial projection would yield misleading revisions and cursors.
    if (facts.length >= maxFacts) throw new Error(`scan_limit_exceeded: more than ${maxFacts} stored objects in scope; narrow the scope`)
    facts.push({ object_ref: { type, id: String(data.id) }, object_revision: digest(data), result_id: result ? String(result.id) : null, scope,
      event_time: type === 'event' ? timestamp(data.occurred_at) : null,
      review_generated_at: result ? timestamp(result.created_at) : null,
      recorded_at: result ? timestamp(result.created_at) : type === 'story_line' ? timestamp(data.created_at) : null,
      confirmation_state: String(data.confirmation_state ?? 'automatic'), validity: 'unknown',
      source_reference_ids: sources ?? (data.source_reference_ids_json ? JSON.parse(String(data.source_reference_ids_json)) : []), data })
  }
  for (const story of stories) {
    signal?.throwIfAborted()
    add('story_line', story)
    for (const row of db.prepare(`SELECT r.*, sr.time_range_json FROM supervision_results r JOIN supervision_runs sr ON sr.id = r.run_id WHERE sr.scope_json = ? ORDER BY r.id`).all(String(story.scope_json))) {
      if (results.has(String(row.id))) continue
      results.set(String(row.id), row)
      const { graph_snapshot_json, ...summary } = row
      add('summary', summary, row)
      const snapshot = JSON.parse(String(graph_snapshot_json)) as { entities: Row[]; relations: Row[] }
      for (const entity of snapshot.entities) add('entity', entity, row)
      for (const relation of snapshot.relations) add('relation', relation, row)
      const sources = db.prepare('SELECT * FROM supervision_sources WHERE result_id = ? ORDER BY id').all(String(row.id))
      for (const source of sources) add('source_reference', source, row, [String(source.id)])
      for (const change of db.prepare('SELECT * FROM supervision_entity_changes WHERE result_id = ? ORDER BY id').all(String(row.id))) add('entity_change', change, row)
      // Full successful leaves retain descriptions that the navigation summary and identity projection can omit.
      for (const leaf of db.prepare('SELECT id, output_json, evidence_json FROM supervision_review_batches WHERE run_id = ? ORDER BY id').all(String(row.run_id))) {
        const output = JSON.parse(String(leaf.output_json)) as SupervisionSummaryOutput
        const evidence = JSON.parse(String(leaf.evidence_json)) as SupervisionEvidence[]
        const refs = new Map(evidence.map(item => [item.id, sources.filter(source => source.source_type === item.sourceType &&
          source.source_id === item.sourceId && source.content === item.content && source.locator_json === (item.locator ? JSON.stringify(item.locator) : null)).map(source => String(source.id))]))
        const references = (ids: string[]) => [...new Set(ids.flatMap(id => refs.get(id) ?? []))]
        add('summary', { id: `leaf:${leaf.id}`, summary: output.summary, change_digest: output.changeDigest,
          open_items: output.openItems, content_kind: 'successful_leaf' }, row, references(evidence.map(item => item.id)))
        // Persisted IDs are explicit identity evidence; local model IDs are namespaced to the saved leaf.
        for (const entity of output.entities) add('entity', { id: `leaf:${leaf.id}:${entity.id}`,
          canonical_label: entity.label, description: entity.description, persisted_entity_id: entity.persistedId ?? null,
          content_kind: 'successful_leaf', leaf_id: leaf.id }, row, references(entity.sourceReferenceIds))
        for (const relation of output.relations) add('relation', { id: `leaf:${leaf.id}:${digest(relation)}`,
          from_entity_id: `leaf:${leaf.id}:${relation.fromEntityId}`, to_entity_id: `leaf:${leaf.id}:${relation.toEntityId}`,
          relation_type: relation.relationType, reason: relation.reason, content_kind: 'successful_leaf' }, row, references(relation.sourceReferenceIds))
      }
    }
    for (const entity of db.prepare('SELECT * FROM supervision_entities WHERE story_line_id = ? ORDER BY id').all(String(story.id))) add('entity', entity)
    for (const relation of db.prepare('SELECT * FROM supervision_relations WHERE story_line_id = ? ORDER BY id').all(String(story.id))) add('relation', relation)
  }
  // Events come from the one shared timeline: current events of the requested projects,
  // whichever scope's review extracted them. Re-extracted, superseded events are omitted.
  const projects = scope.kind === 'projects' ? JSON.stringify(scope.projectIds) : null
  const storyIds = JSON.stringify(stories.map(story => String(story.id)))
  for (const event of db.prepare(`SELECT * FROM supervision_events WHERE superseded_by IS NULL
      AND (? IS NULL OR project_id IN (SELECT value FROM json_each(?))
        OR (COALESCE(project_id, '') = '' AND story_line_id IN (SELECT value FROM json_each(?)))) ORDER BY id`).all(projects, projects, storyIds)) {
    signal?.throwIfAborted()
    const sources = db.prepare('SELECT source_id FROM supervision_event_sources WHERE event_id = ? ORDER BY source_id').all(String(event.id)).map(row => String(row.source_id))
    const entities = db.prepare('SELECT entity_id FROM supervision_event_entities WHERE event_id = ? ORDER BY entity_id').all(String(event.id)).map(row => String(row.entity_id))
    const result = results.get(String(event.result_id)) ?? db.prepare('SELECT * FROM supervision_results WHERE id = ?').get(String(event.result_id))
    add('event', { ...event, entity_ids: entities }, result, sources)
  }
  // Long-lived stories and experiences of the shared timeline (storyline model). Stories follow the
  // requested projects; experiences are global and kept when formed or applied in a requested project.
  const storyList = new SupervisionStoryStore(db).list(scope)
  for (const story of storyList) {
    signal?.throwIfAborted()
    const { events, ...rest } = story
    // A feature's own events plus those of its threads; a cross story's linked events.
    const own = events.filter(event => event.primary || story.level === 'cross').map(event => event.id)
    const threads = storyList.filter(child => child.parentId === story.id).flatMap(child => child.events.filter(event => event.primary).map(event => event.id))
    add('story', { ...rest, event_ids: [...new Set([...own, ...threads])], thread_ids: storyList.filter(child => child.parentId === story.id).map(child => child.id), event_count: own.length + threads.length },
      undefined, [])
    const fact = facts[facts.length - 1]!
    fact.event_time = timestamp(story.startedAt)
    fact.confirmation_state = story.userEdited ? 'user_edited' : 'automatic'
  }
  for (const experience of new SupervisionExperienceStore(db).list(scope.kind === 'projects' ? scope.projectIds : undefined)) {
    signal?.throwIfAborted()
    add('experience', { ...experience, event_ids: experience.events.map(event => event.id) }, undefined, [])
    const fact = facts[facts.length - 1]!
    fact.event_time = timestamp(experience.events.find(event => event.role === 'formed')?.at)
    fact.confirmation_state = experience.userEdited ? 'user_edited' : 'automatic'
  }  const revision = digest(facts)
  checkRevision(revision)
  const timed = args as z.infer<typeof storyGraphSearchSchema>
  const matchesTime = (fact: Fact): boolean => !timed.time_range || Boolean(fact[timed.time_basis] &&
    Date.parse(fact[timed.time_basis]!) >= Date.parse(timed.time_range.from) && Date.parse(fact[timed.time_basis]!) <= Date.parse(timed.time_range.to))
  const metadata = { ...base, coverage: { ...base.coverage, published_result_count: results.size }, time_basis: timed.time_basis,
    time_range: timed.time_range ? { from: timestamp(timed.time_range.from), to: timestamp(timed.time_range.to) } : null,
    interpretation: 'Stored claims within the selected evidence scope; no inferred supersession, completion, or historical state.' }
  const query = 'query' in args ? args.query.toLowerCase() : ''
  // Agents phrase queries as several words ("监督者回顾调度", "review pause 300s"), so match terms, not the whole string.
  const terms = queryTerms(query)
  const textOf = new Map<Fact, string>()
  const lower = (fact: Fact) => { let text = textOf.get(fact); if (text === undefined) { text = JSON.stringify(fact.data).toLowerCase(); textOf.set(fact, text) } return text }
  const hits = (text: string) => terms.filter(term => text.includes(term)).length
  // A fact matches the whole query, or at least half its terms (and at least one).
  const matches = (fact: Fact) => { const text = lower(fact); return text.includes(query) || hits(text) >= Math.max(1, Math.ceil(terms.length / 2)) }
  let selected: Fact[]
  if (name === 'story_graph_search') {
    const search = storyGraphSearchSchema.parse(input)
    selected = facts.filter(fact => (!search.object_types || search.object_types.includes(fact.object_ref.type as typeof search.object_types[number])) && matches(fact))
  } else {
    const context = storyGraphContextSchema.parse(input)
    const targets = facts.filter(fact => fact.object_ref.type === context.object_ref.type && fact.object_ref.id === context.object_ref.id)
    if (!targets.length) {
      const tables = { story_line: 'story_lines', story: 'supervision_stories', experience: 'supervision_experiences', event: 'supervision_events', entity: 'supervision_entities',
        entity_change: 'supervision_entity_changes', relation: 'supervision_relations', summary: 'supervision_results', source_reference: 'supervision_sources' }
      const leafId = context.object_ref.id.startsWith('leaf:') ? context.object_ref.id.split(':')[1] : undefined
      const exists = leafId ? db.prepare('SELECT id FROM supervision_review_batches WHERE id = ?').get(leafId)
        : db.prepare(`SELECT id FROM ${tables[context.object_ref.type]} WHERE id = ?`).get(context.object_ref.id)
      throw new Error(exists ? 'scope_mismatch: object is outside the requested scope' : 'object_not_found')
    }
    const related = facts.filter(fact => targets.includes(fact) || (context.object_ref.type === 'entity' &&
      (fact.data.entity_id === context.object_ref.id || fact.data.persisted_entity_id === context.object_ref.id || fact.data.from_entity_id === context.object_ref.id || fact.data.to_entity_id === context.object_ref.id || (Array.isArray(fact.data.entity_ids) && fact.data.entity_ids.includes(context.object_ref.id)))))
    const targetSources = new Set(related.flatMap(fact => fact.source_reference_ids))
    const entityIds = new Set(related.flatMap(fact => [fact.data.entity_id, fact.data.from_entity_id, fact.data.to_entity_id, ...(Array.isArray(fact.data.entity_ids) ? fact.data.entity_ids : [])]).filter((id): id is string => typeof id === 'string'))
    const targetResults = new Set(targets.flatMap(fact => fact.result_id ? [fact.result_id] : []))
    selected = facts.filter(fact => {
      if (context.object_ref.type === 'story_line') return true
      // A story or experience brings its own events; their sources stay one get_context or read_source away.
      if (context.object_ref.type === 'story' || context.object_ref.type === 'experience') {
        const ids = new Set(targets.flatMap(target => Array.isArray(target.data.event_ids) ? target.data.event_ids : []))
        return targets.includes(fact) || (fact.object_ref.type === 'event' && ids.has(fact.object_ref.id))
      }
      if (related.includes(fact) || (fact.object_ref.type === 'entity' && entityIds.has(fact.object_ref.id))) return true
      if (context.object_ref.type === 'summary') return fact.result_id !== null && targetResults.has(fact.result_id)
      return fact.source_reference_ids.some(id => targetSources.has(id))
    })
  }
  const unknownExcluded = timed.time_range ? selected.filter(fact => !fact[timed.time_basis]).length : 0
  selected = selected.filter(matchesTime)
  const score = (fact: Fact): number => {
    if (name !== 'story_graph_search') return 0
    // Whole-query hits first, then term hits; named fields weigh more. Stories and experiences lead ties.
    return Object.entries(fact.data).reduce((sum, [field, value]) => {
      const text = JSON.stringify(value).toLowerCase()
      const weight = ['title', 'canonical_label', 'summary', 'name', 'statement'].includes(field) ? 3 : 1
      return sum + (text.includes(query) ? weight * (terms.length + 1) : 0) + hits(text) * weight
    }, 0) + (fact.object_ref.type === 'story' || fact.object_ref.type === 'experience' ? 0.5 : 0)
  }
  selected.sort((a, b) => score(b) - score(a) || (name === 'story_graph_get_context' && 'mode' in args && args.mode === 'timeline'
    ? (a.event_time ?? '\uffff').localeCompare(b.event_time ?? '\uffff') : 0) ||
    a.object_ref.type.localeCompare(b.object_ref.type) || a.object_ref.id.localeCompare(b.object_ref.id) || (a.result_id ?? '').localeCompare(b.result_id ?? ''))
  let index = cursor?.index ?? 0
  let offset = cursor?.offset ?? 0
  if (index > selected.length) throw new Error('invalid_cursor')
  const items: Row[] = []
  for (; index < selected.length && items.length < args.page_size; index++) {
    signal?.throwIfAborted()
    const { data, ...fact } = selected[index]!
    const text = Array.from(JSON.stringify(data))
    if (name === 'story_graph_search') {
      const fields = Object.keys(data).filter(field => { const text = JSON.stringify(data[field]).toLowerCase(); return text.includes(query) || hits(text) > 0 })
      // Readable fields first, so the model sees what the object says, not its IDs.
      const readable = ['name', 'statement', 'title', 'canonical_label', 'summary', 'description', 'conditions', 'boundaries', 'event_type', 'level',
        'project_name', 'projectName', 'started_at', 'startedAt', 'occurred_at', 'content'].filter(field => typeof data[field] === 'string' && data[field])
      const preview = Array.from(readable.length ? readable.map(field => `${field}: ${String(data[field])}`).join(' | ') : JSON.stringify(data))
      items.push({ ...fact, matched_fields: fields, preview: preview.slice(0, 400).join(''), preview_is_excerpt: preview.length > 400 || readable.length > 0 })
    } else {
      const size = storyGraphContextSchema.parse(input).content_page_size
      const end = Math.min(text.length, offset + size)
      items.push({ ...fact, content: text.slice(offset, end).join(''), content_format: 'json_fragment', position: { start: offset, end, length: text.length, unit: 'unicode_code_point' } })
      if (end < text.length) { offset = end; break }
      offset = 0
    }
    // Fail explicitly rather than allowing a downstream runtime to truncate metadata.
    if (Buffer.byteLength(JSON.stringify(items)) > 90_000) throw new Error('response_too_large: retry with a smaller page_size')
  }
  const output = { ...metadata, unknown_time_excluded_count: unknownExcluded, ...('mode' in args ? { mode: args.mode } : {}), items, page: page(revision, index, offset, index < selected.length, items.length, selected.length) }
  return bounded(output)
}
