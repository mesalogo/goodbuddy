import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, Network, RefreshCw } from 'lucide-react'
import { EmptyState } from './WorkspacePrimitives'
import type { AssistantProject } from '../../shared/assistant-contracts'
import { heartbeatScopeSchema } from '../../shared/assistant-contracts'
import {
  supervisionGraphViewSchema,
  supervisionResultViewSchema,
  type SupervisionGraphView,
  type SupervisionResultView,
  type SupervisionRunRequest
} from '../../shared/supervision-contracts'

type Selection = { kind: 'event' | 'entity' | 'relation'; id: string }
export type SupervisionGraphNavigation = { resultId: string; tab?: 'overview' | 'graph' }
type Props = {
  graphNavigation?: SupervisionGraphNavigation
  tab?: 'overview' | 'graph' | 'activity' | 'settings'
  projects?: AssistantProject[]
  onTabChange?: (tab: 'overview' | 'graph' | 'activity' | 'settings') => void
}
const emptyGraph: SupervisionGraphView = {
  storyLine: null,
  events: [],
  entities: [],
  relations: [],
  sources: [],
  eventEntities: [],
  eventSources: []
}
const point = (angle: number) => ({
  x: 380 + Math.cos(angle) * 290,
  y: 300 + Math.sin(angle) * 230
})
const shortLabel = (label: string) =>
  Array.from(label).length > 7
    ? `${Array.from(label).slice(0, 7).join('')}…`
    : label
const entityTone = (id: string) =>
  (Array.from(id).reduce((hash, char) => hash + char.codePointAt(0)!, 0) % 4) +
  1

export function SupervisorWorkspace({
  graphNavigation,
  tab = 'overview',
  projects = [],
  onTabChange
}: Props) {
  const { t, i18n } = useTranslation('heartbeat')
  const graphId = useId()
  const api = window.goodbuddy?.supervision
  const [results, setResults] = useState<SupervisionResultView[]>([])
  const [graph, setGraph] = useState(emptyGraph)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string>()
  const [pending, setPending] = useState<string>()
  const [error, setError] = useState<string>()
  const [errorAction, setErrorAction] = useState<'run' | 'source' | 'action'>()
  const [selection, setSelection] = useState<Selection>()
  const [source, setSource] = useState<{
    id: string
    title: string
    content: string
    occurredAt: string
  }>()
  const [projectId, setProjectId] = useState('global')
  const [days, setDays] = useState(7)
  const [lastRequest, setLastRequest] = useState<SupervisionRunRequest>()
  const [resultId, setResultId] = useState<string | undefined>(graphNavigation?.resultId)
  const [appliedNavigation, setAppliedNavigation] = useState(graphNavigation)
  if (appliedNavigation !== graphNavigation) {
    setAppliedNavigation(graphNavigation)
    setResultId(graphNavigation?.resultId)
    setGraph(emptyGraph)
    setLoading(true)
    setSource(undefined)
    setSelection(undefined)
    setPending(undefined)
    setError(undefined)
    setLoadError(undefined)
  }
  const selectedResult = useRef<string | undefined>(undefined)
  const requestedNavigation = useRef<SupervisionGraphNavigation | undefined>(undefined)
  const loadGeneration = useRef(0)
  const [confirmRemoval, setConfirmRemoval] = useState(false)
  const [revision, setRevision] = useState<string>()
  const errorText = (reason: unknown) =>
    reason instanceof Error ? reason.message : t('common.operationFailed')
  const date = (value: string) =>
    new Date(value).toLocaleString(i18n.resolvedLanguage)
  const shortDate = (value: string) =>
    new Date(value).toLocaleDateString(i18n.resolvedLanguage, {
      month: '2-digit',
      day: '2-digit'
    })
  const scopeText = (scope: SupervisionRunRequest['scope']) =>
    scope.kind === 'global'
      ? t('center.scope.global')
      : t('supervisor.projectScope', {
          names: scope.projectIds
            .map(
              (id) =>
                projects.find((project) => project.id === id)?.name ??
                t('settings.scope.unavailableProject')
            )
            .join(', ')
        })

  const refresh = useCallback(async (requestedId = selectedResult.current) => {
    if (!api) return
    const generation = ++loadGeneration.current
    selectedResult.current = requestedId
    setLoading(true)
    setGraph(emptyGraph)
    setResultId(requestedId)
    setSource(undefined)
    setConfirmRemoval(false)
    setRevision(undefined)
    setLoadError(undefined)
    try {
      const overview = (await api.overview()).map((item) => supervisionResultViewSchema.parse(item))
      if (generation !== loadGeneration.current) return
      if (requestedId && !overview.some((item) => item.id === requestedId)) {
        const selected = await api.overview({ resultId: requestedId })
        if (generation !== loadGeneration.current) return
        overview.push(...selected.map((item) => supervisionResultViewSchema.parse(item)))
      }
      const selected = requestedId ? overview.find((item) => item.id === requestedId) : overview[0]
      setResults(overview)
      const nextId = requestedId ?? selected?.id
      setResultId(nextId)
      selectedResult.current = nextId
      const nextGraph = nextId ? await api.graph({ resultId: nextId, storyLineId: selected?.storyLineId }) : emptyGraph
      if (generation !== loadGeneration.current) return
      const parsedGraph = supervisionGraphViewSchema.parse(nextGraph)
      if (parsedGraph.storyLine)
        heartbeatScopeSchema.parse(JSON.parse(parsedGraph.storyLine.scope_json))
      setGraph(parsedGraph)
      setSelection((current) => {
        const records =
          current?.kind === 'event'
            ? parsedGraph.events
            : current?.kind === 'entity'
              ? parsedGraph.entities
              : parsedGraph.relations
        if (current && records.some((item) => item.id === current.id))
          return current
        const latestEvent = [...parsedGraph.events].sort(
          (a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at)
        )[0]
        return latestEvent ? { kind: 'event', id: latestEvent.id } : undefined
      })
    } catch (reason) {
      if (generation !== loadGeneration.current) return
      setLoadError(
        reason instanceof Error ? reason.message : t('common.operationFailed')
      )
    } finally {
      if (generation === loadGeneration.current) setLoading(false)
    }
  }, [api, t])
  useEffect(() => {
    const invalidate = () => { loadGeneration.current++ }
    const requestedId = requestedNavigation.current !== graphNavigation
      ? graphNavigation?.resultId
      : selectedResult.current
    requestedNavigation.current = graphNavigation
    selectedResult.current = requestedId
    const task = window.setTimeout(() => void refresh(requestedId), 0)
    return () => { window.clearTimeout(task); invalidate() }
  }, [refresh, graphNavigation])

  const run = async () => {
    if (!api || pending || loading) return
    const generation = loadGeneration.current
    const to = new Date()
    const request: SupervisionRunRequest = {
      trigger: 'manual',
      scope:
        projectId === 'global'
          ? { kind: 'global' }
          : { kind: 'projects', projectIds: [projectId] },
      timeRange: {
        from: new Date(to.getTime() - days * 86400_000).toISOString(),
        to: to.toISOString()
      }
    }
    setLastRequest(request)
    setPending('run')
    setErrorAction('run')
    setError(undefined)
    try {
      await api.run(request)
      if (generation !== loadGeneration.current) return
      selectedResult.current = undefined
      setPending(undefined)
      await refresh()
    } catch (reason) {
      if (generation !== loadGeneration.current) return
      setError(errorText(reason))
    } finally {
      if (generation === loadGeneration.current) setPending(undefined)
    }
  }

  const layout = useMemo(() => {
    const times = graph.events.map((event) => Date.parse(event.occurred_at))
    const from = Math.min(...times)
    const to = Math.max(...times)
    const events = [...graph.events].sort(
      (a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at)
    )
    const selectedRelation =
      selection?.kind === 'relation'
        ? graph.relations.find((item) => item.id === selection.id)
        : undefined
    const linkedIds = new Set(
      selection?.kind === 'event'
        ? graph.eventEntities
            .filter((link) => link.event_id === selection.id)
            .map((link) => link.entity_id)
        : selectedRelation
          ? [selectedRelation.from_entity_id, selectedRelation.to_entity_id]
          : selection?.kind === 'entity'
            ? [selection.id]
            : []
    )
    const entities = graph.entities
    // Bound the canvas density; all records remain selectable in the list.
    const linkedEventId = graph.eventEntities.find((link) =>
      linkedIds.has(link.entity_id)
    )?.event_id
    const eventIndex =
      selection?.kind === 'event'
        ? events.findIndex((event) => event.id === selection.id)
        : linkedEventId
          ? events.findIndex((event) => event.id === linkedEventId)
          : events.length - 1
    const eventStart = Math.floor(Math.max(0, eventIndex) / 8) * 8
    const entityStart =
      Math.floor(
        Math.max(
          0,
          entities.findIndex(
            (entity) =>
              selection?.kind === 'entity' && entity.id === selection.id
          )
        ) / 6
      ) * 6
    const visibleEvents = events
      .slice(eventStart, eventStart + 8)
      .map((event, index, items) => ({
        ...event,
        ...point(
          Math.PI / 3 -
            ((index / Math.max(1, items.length - 1)) * Math.PI * 5) / 3
        )
      }))
    const entityBatch = entities.slice(entityStart, entityStart + 6)
    // Only replace the batch when linked endpoints lie outside it; keep positions stable otherwise.
    const batchIds = new Set(entityBatch.map((entity) => entity.id))
    const batch = [...linkedIds].every((id) => batchIds.has(id))
      ? entityBatch
      : [
          ...entities.filter((entity) => linkedIds.has(entity.id)),
          ...entities.filter((entity) => !linkedIds.has(entity.id))
        ]
          .slice(0, 6)
          .sort((a, b) => entities.indexOf(a) - entities.indexOf(b))
    const visibleEntities = batch.map((entity, index, items) => ({
      ...entity,
      x: items.length === 1 ? 380 : 245 + (index % 3) * 135,
      y: items.length <= 3 ? 300 : 235 + Math.floor(index / 3) * 130
    }))
    const visibleEventMap = new Map(
      visibleEvents.map((event) => [event.id, event])
    )
    const visibleEntityMap = new Map(
      visibleEntities.map((entity) => [entity.id, entity])
    )
    const eventMap = new Map(events.map((event) => [event.id, event]))
    const entityMap = new Map(entities.map((entity) => [entity.id, entity]))
    const selectedEventIds = new Set(
      selection?.kind === 'event'
        ? [selection.id]
        : selection?.kind === 'entity'
          ? graph.eventEntities
              .filter((link) => link.entity_id === selection.id)
              .map((link) => link.event_id)
          : []
    )
    const selectedEntityIds = new Set(
      selection?.kind === 'entity'
        ? [selection.id]
        : selection?.kind === 'event'
          ? graph.eventEntities
              .filter((link) => link.event_id === selection.id)
              .map((link) => link.entity_id)
          : []
    )
    const relation =
      selection?.kind === 'relation'
        ? graph.relations.find((item) => item.id === selection.id)
        : undefined
    if (relation) {
      selectedEntityIds.add(relation.from_entity_id)
      selectedEntityIds.add(relation.to_entity_id)
      graph.eventEntities
        .filter((link) => selectedEntityIds.has(link.entity_id))
        .forEach((link) => selectedEventIds.add(link.event_id))
    }
    const sourceIds = new Set(
      graph.eventSources
        .filter((link) => selectedEventIds.has(link.event_id))
        .map((link) => link.source_id)
    )
    return {
      events,
      entities,
      visibleEvents,
      visibleEntities,
      visibleEventMap,
      visibleEntityMap,
      eventMap,
      entityMap,
      selectedEventIds,
      selectedEntityIds,
      relation,
      sources: graph.sources.filter((item) => sourceIds.has(item.id)),
      from,
      to
    }
  }, [graph, selection])
  const selectedEvent =
    selection?.kind === 'event' ? layout.eventMap.get(selection.id) : undefined
  const selectedEntity =
    selection?.kind === 'entity'
      ? layout.entityMap.get(selection.id)
      : undefined
  const stage = selectedEvent
    ? layout.events.indexOf(selectedEvent)
    : layout.events.length - 1
  const stageEvent = layout.events[stage]
  const select = (next: Selection) => {
    setSelection(next)
    setSource(undefined)
    setConfirmRemoval(false)
    setRevision(undefined)
  }
  const selectStage = (index: number) => {
    const event = layout.events[index]
    if (event) select({ kind: 'event', id: event.id })
  }
  const action = async (kind: 'confirm' | 'revise' | 'revoke') => {
    if (!api || !selection || pending) return
    const generation = loadGeneration.current
    setPending('action')
    setError(undefined)
    setErrorAction('action')
    try {
      if (selection.kind === 'entity')
        await api.entityAction({
          entityId: selection.id,
          resultId,
          action: kind,
          ...(kind === 'revise' ? { label: revision } : {})
        })
      if (selection.kind === 'relation' && kind !== 'revise')
        await api.relationAction({ relationId: selection.id, resultId, action: kind })
      if (generation !== loadGeneration.current) return
      setPending(undefined)
      setConfirmRemoval(false)
      setRevision(undefined)
      if (kind === 'revoke') setSelection(undefined)
      await refresh()
    } catch (reason) {
      if (generation !== loadGeneration.current) return
      setError(errorText(reason))
    } finally {
      if (generation === loadGeneration.current) setPending(undefined)
    }
  }
  const openSource = async (id: string) => {
    if (!api || pending) return
    const generation = loadGeneration.current
    setPending('source')
    setError(undefined)
    setSource(undefined)
    setErrorAction('source')
    try {
      const item = await api.source(id)
      if (generation !== loadGeneration.current) return
      if (!item) throw new Error(t('supervisor.sourceMissing'))
      setSource({
        id,
        title: String(item.title),
        content: String(item.content),
        occurredAt: String(item.occurredAt)
      })
    } catch (reason) {
      if (generation !== loadGeneration.current) return
      setError(errorText(reason))
    } finally {
      if (generation === loadGeneration.current) setPending(undefined)
    }
  }
  const latest = resultId ? results.find((item) => item.id === resultId) : results[0]
  const graphScope = graph.storyLine
    ? (JSON.parse(graph.storyLine.scope_json) as SupervisionRunRequest['scope'])
    : undefined
  const busy = !!api && (loading || pending !== undefined)

  return (
    <div className="supervisor-workspace" aria-busy={busy}>
      {!api ? (
        <div role="alert">
          <EmptyState
            icon={<Network size={28} />}
            title={t('supervisor.unavailable')}
            description={t('supervisor.unavailableHint')}
          />
        </div>
      ) : (
        <>
          {loading && (
            <EmptyState
              variant="loading"
              icon={<RefreshCw size={28} />}
              title={t('supervisor.loading')}
              description={t('supervisor.loadingHint')}
            />
          )}
          {loadError && (
            <div className="supervisor-workspace__inline-error" role="alert">
              <strong>{t('center.loading.failedTitle')}</strong>
              <p>{loadError}</p>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => void refresh()}
              >
                {t('center.actions.retry')}
              </button>
            </div>
          )}
          {error && (
            <div className="supervisor-workspace__inline-error" role="alert">
              <strong>{t('common.operationFailed')}</strong>
              <p>{error}</p>
              {errorAction === 'run' && lastRequest && (
                <p>
                  {scopeText(lastRequest.scope)} ·{' '}
                  {date(lastRequest.timeRange.from)} –{' '}
                  {date(lastRequest.timeRange.to)}
                </p>
              )}
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  errorAction === 'run' ? void run() : setError(undefined)
                }
              >
                {errorAction === 'run'
                  ? t('supervisor.retryRun')
                  : t('supervisor.dismiss')}
              </button>
            </div>
          )}
          {tab === 'overview' && (
            <>
              <div className="supervisor-workspace__toolbar">
                <label>
                  {t('supervisor.scope')}
                  <select
                    value={projectId}
                    disabled={busy}
                    onChange={(event) => setProjectId(event.target.value)}
                  >
                    <option value="global">{t('center.scope.global')}</option>
                    {projects
                      .filter((project) => project.status === 'active')
                      .map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  {t('supervisor.period')}
                  <select
                    value={days}
                    disabled={busy}
                    onChange={(event) => setDays(Number(event.target.value))}
                  >
                    {[1, 7, 30].map((value) => (
                      <option key={value} value={value}>
                        {t('supervisor.days', { count: value })}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() => void run()}
                >
                  {pending === 'run'
                    ? t('supervisor.running')
                    : t('supervisor.run')}
                </button>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void refresh()}
                >
                  {t('center.actions.refresh')}
                </button>
              </div>
              <p className="supervisor-workspace__muted">
                {t('supervisor.sourcesHint')}
              </p>
              {latest ? (
                <article className="supervisor-workspace__recap">
                  <div className="supervisor-workspace__section-heading">
                    <h2>{t('supervisor.latest')}</h2>
                    <time>{date(latest.createdAt)}</time>
                  </div>
                  <p>
                    {scopeText(latest.scope)} · {date(latest.timeRange.from)} –{' '}
                    {date(latest.timeRange.to)}
                  </p>
                  <p className="supervisor-workspace__summary">
                    {latest.summary}
                  </p>
                  {latest.changeDigest && <p>{latest.changeDigest}</p>}
                  {latest.openItems.length > 0 && (
                    <>
                      <h3>{t('supervisor.openItems')}</h3>
                      <ul>
                        {latest.openItems.map((item, index) => (
                          <li key={index}>{item}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  <button
                    className="secondary-button"
                    onClick={() => onTabChange?.('graph')}
                  >
                    {t('supervisor.graph')}
                  </button>
                  {results.length > 1 && (
                    <label>
                      {t('supervisor.history')}
                      <select
                        value={latest.id}
                        disabled={pending !== undefined}
                        onChange={(event) => { setResultId(event.target.value); void refresh(event.target.value) }}
                      >
                        {results.map((item) => (
                          <option key={item.id} value={item.id}>
                            {date(item.createdAt)} · {scopeText(item.scope)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </article>
              ) : (
                !loading &&
                !loadError && (
                  <EmptyState
                    icon={<BookOpen size={28} />}
                    title={t('supervisor.empty')}
                    description={t('supervisor.emptyHint')}
                  />
                )
              )}
            </>
          )}
          {tab === 'graph' && (
            <>
              <div className="supervisor-workspace__action-bar">
                {(graphScope || latest) && <div>
                  {graphScope && (
                    <p>
                      {t('supervisor.graphScope')}: {scopeText(graphScope)}
                    </p>
                  )}
                  {latest && (
                    <p>
                      {date(latest.timeRange.from)} –{' '}
                      {date(latest.timeRange.to)} · {date(latest.createdAt)}
                    </p>
                  )}
                </div>}
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void refresh()}
                >
                  {t('center.actions.refresh')}
                </button>
              </div>
              {!loading && !loadError && !graph.events.length && (
                <EmptyState
                  icon={<Network size={28} />}
                  title={t('supervisor.graphEmpty')}
                  description={t('supervisor.emptyHint')}
                  action={
                    <button
                      className="secondary-button"
                      onClick={() => onTabChange?.('overview')}
                    >
                      {t('supervisor.recap')}
                    </button>
                  }
                />
              )}
              {graph.events.length > 0 && (
                <div className="supervisor-workspace__graph-layout">
                  <aside
                    className="supervisor-workspace__graph-list"
                    aria-label={t('supervisor.selection')}
                  >
                    <h3>
                      {t('supervisor.events')}
                      <span>{layout.events.length}</span>
                    </h3>
                    {layout.events.map((event, index) => (
                      <button
                        key={event.id}
                        aria-label={`${index + 1}. ${event.title} · ${date(event.occurred_at)}`}
                        aria-pressed={selection?.id === event.id}
                        onClick={() => select({ kind: 'event', id: event.id })}
                      >
                        <span className="supervisor-workspace__event-index">
                          {index + 1}.
                        </span>
                        <span className="supervisor-workspace__list-copy">
                          {event.title}
                          <small title={date(event.occurred_at)}>
                            {shortDate(event.occurred_at)}
                          </small>
                        </span>
                      </button>
                    ))}
                    <h3>
                      {t('supervisor.entities')}
                      <span>{layout.entities.length}</span>
                    </h3>
                    {layout.entities.map((entity) => (
                      <button
                        key={entity.id}
                        data-tone={entityTone(entity.id)}
                        aria-pressed={selection?.id === entity.id}
                        onClick={() =>
                          select({ kind: 'entity', id: entity.id })
                        }
                      >
                        <i
                          className="supervisor-workspace__entity-dot"
                          aria-hidden="true"
                        />
                        <span className="supervisor-workspace__list-copy">
                          {entity.canonical_label}
                        </span>
                      </button>
                    ))}
                    <h3>
                      {t('supervisor.relations')}
                      <span>{graph.relations.length}</span>
                    </h3>
                    {graph.relations.map((relation) => (
                      <button
                        key={relation.id}
                        aria-pressed={selection?.id === relation.id}
                        onClick={() =>
                          select({ kind: 'relation', id: relation.id })
                        }
                      >
                        {
                          layout.entityMap.get(relation.from_entity_id)
                            ?.canonical_label
                        }{' '}
                        →{' '}
                        {
                          layout.entityMap.get(relation.to_entity_id)
                            ?.canonical_label
                        }{' '}
                        ·{' '}
                        {t(
                          `supervisor.relationTypes.${relation.relation_type}`,
                          { defaultValue: relation.relation_type }
                        )}
                      </button>
                    ))}
                    <p className="supervisor-workspace__muted">
                      {t('supervisor.legend')}
                    </p>
                  </aside>
                  <section
                    className="supervisor-workspace__graph-canvas"
                    aria-label={t('supervisor.canvas')}
                  >
                    <div className="supervisor-workspace__canvas-heading">
                      <strong>{t('supervisor.canvasTitle')}</strong>
                      <span>
                        {t('supervisor.counts', {
                          events: layout.events.length,
                          entities: layout.entities.length
                        })}
                      </span>
                    </div>
                    <figure className="supervisor-workspace__figure">
                      <div
                        className="supervisor-workspace__map-scroll"
                        tabIndex={0}
                        role="region"
                        aria-label={t('supervisor.graph')}
                      >
                        <svg
                          className={`supervisor-workspace__map ${selection ? 'has-selection' : ''}`}
                          viewBox="0 0 760 620"
                          width="100%"
                          role="group"
                          aria-label={t('supervisor.graph')}
                          aria-describedby={`${graphId}-caption`}
                        >
                          <defs>
                            <marker
                              id={`${graphId}-arrow`}
                              viewBox="0 0 10 10"
                              refX="8"
                              refY="5"
                              markerWidth="6"
                              markerHeight="6"
                              orient="auto"
                            >
                              <path
                                className="supervisor-workspace__time-arrow"
                                d="M 0 0 L 10 5 L 0 10 z"
                              />
                            </marker>
                          </defs>
                          <ellipse
                            className="supervisor-workspace__time-boundary"
                            cx="380"
                            cy="300"
                            rx="290"
                            ry="230"
                          />
                          <path
                            className="supervisor-workspace__timeline-ring"
                            d="M 525 499.19 A 290 230 0 1 0 257.44 508.45"
                            markerEnd={`url(#${graphId}-arrow)`}
                          />
                          <text x="525" y="565" textAnchor="middle">
                            {t('supervisor.start')}
                          </text>
                          <text x="235" y="565" textAnchor="middle">
                            {t('supervisor.end')}
                          </text>
                          {graph.relations.map((relation) => {
                            const from = layout.visibleEntityMap.get(
                              relation.from_entity_id
                            )
                            const to = layout.visibleEntityMap.get(
                              relation.to_entity_id
                            )
                            const active =
                              selection?.id === relation.id ||
                              (layout.selectedEntityIds.has(
                                relation.from_entity_id
                              ) &&
                                layout.selectedEntityIds.has(
                                  relation.to_entity_id
                                ))
                            return from && to ? (
                              <path
                                key={relation.id}
                                data-relation={relation.id}
                                className={`supervisor-workspace__relation ${active ? 'is-selected' : ''}`}
                                d={`M ${from.x} ${from.y} Q ${(from.x + to.x) / 2} ${(from.y + to.y) / 2 - 36} ${to.x} ${to.y}`}
                              />
                            ) : null
                          })}
                          {graph.eventEntities.map((link) => {
                            const event = layout.visibleEventMap.get(
                              link.event_id
                            )
                            const entity = layout.visibleEntityMap.get(
                              link.entity_id
                            )
                            return event && entity ? (
                              <path
                                key={`${link.event_id}-${link.entity_id}`}
                                data-event-entity={`${link.event_id}:${link.entity_id}`}
                                data-tone={entityTone(entity.id)}
                                className={`supervisor-workspace__event-link ${layout.selectedEventIds.has(event.id) && layout.selectedEntityIds.has(entity.id) ? 'is-selected' : ''}`}
                                d={`M ${event.x} ${event.y} Q ${event.x} ${entity.y} ${entity.x} ${entity.y}`}
                              />
                            ) : null
                          })}
                          {layout.visibleEvents.map((event) => (
                            <g
                              key={event.id}
                              role="button"
                              tabIndex={0}
                              aria-label={event.title}
                              aria-pressed={selection?.id === event.id}
                              className={`supervisor-workspace__node ${layout.selectedEventIds.has(event.id) ? 'is-selected' : ''}`}
                              onClick={() =>
                                select({ kind: 'event', id: event.id })
                              }
                              onKeyDown={(key) => {
                                if (key.key === 'Enter' || key.key === ' ') {
                                  key.preventDefault()
                                  select({ kind: 'event', id: event.id })
                                }
                              }}
                            >
                              <rect
                                className="supervisor-workspace__hit-target"
                                x={event.x - 20}
                                y={event.y - 20}
                                width="40"
                                height="48"
                              />
                              <circle cx={event.x} cy={event.y} r="7" />
                              <text
                                x={event.x}
                                y={event.y + 25}
                                textAnchor="middle"
                              >
                                {shortLabel(event.title)}
                              </text>
                              <text
                                className="supervisor-workspace__node-date"
                                x={event.x}
                                y={event.y - 18}
                                textAnchor="middle"
                              >
                                {new Date(event.occurred_at).toLocaleDateString(
                                  i18n.resolvedLanguage,
                                  { month: '2-digit', day: '2-digit' }
                                )}
                              </text>
                              <title>
                                {date(event.occurred_at)} · {event.title}
                              </title>
                            </g>
                          ))}
                          {layout.visibleEntities.map((entity) => (
                            <g
                              key={entity.id}
                              data-tone={entityTone(entity.id)}
                              role="button"
                              tabIndex={0}
                              aria-label={entity.canonical_label}
                              aria-pressed={selection?.id === entity.id}
                              className={`supervisor-workspace__node supervisor-workspace__entity ${layout.selectedEntityIds.has(entity.id) ? 'is-selected' : ''}`}
                              onClick={() =>
                                select({ kind: 'entity', id: entity.id })
                              }
                              onKeyDown={(key) => {
                                if (key.key === 'Enter' || key.key === ' ') {
                                  key.preventDefault()
                                  select({ kind: 'entity', id: entity.id })
                                }
                              }}
                            >
                              <circle
                                className="supervisor-workspace__halo"
                                cx={entity.x}
                                cy={entity.y}
                                r="24"
                              />
                              <circle
                                className="supervisor-workspace__core"
                                cx={entity.x}
                                cy={entity.y}
                                r="9"
                              />
                              <text
                                x={entity.x}
                                y={entity.y + 43}
                                textAnchor="middle"
                              >
                                {shortLabel(entity.canonical_label)}
                              </text>
                              <title>{entity.canonical_label}</title>
                            </g>
                          ))}
                        </svg>
                      </div>
                      <div className="supervisor-workspace__canvas-note">
                        {t('supervisor.canvasNote')}
                      </div>
                      <details className="supervisor-workspace__reading-guide">
                        <summary>
                          {t('supervisor.readingGuide')} ·{' '}
                          {t('supervisor.visibleCounts', {
                            events: layout.visibleEvents.length,
                            entities: layout.visibleEntities.length
                          })}
                        </summary>
                        <p id={`${graphId}-caption`}>
                          {t('supervisor.canvasCaption')}
                        </p>
                      </details>
                    </figure>
                    <ul
                      className="supervisor-workspace__legend"
                      aria-label={t('supervisor.legendLabel')}
                    >
                      <li>
                        <i
                          className="supervisor-workspace__legend-event"
                          aria-hidden="true"
                        />
                        {t('supervisor.events')}
                      </li>
                      <li>
                        <i
                          className="supervisor-workspace__legend-entity"
                          aria-hidden="true"
                        />
                        {t('supervisor.entities')}
                      </li>
                      <li>
                        <i
                          className="supervisor-workspace__legend-link"
                          aria-hidden="true"
                        />
                        {t('supervisor.eventImpact')}
                      </li>
                      <li>
                        <i
                          className="supervisor-workspace__legend-relation"
                          aria-hidden="true"
                        />
                        {t('supervisor.relations')}
                      </li>
                      {selection && (
                        <li>
                          <button
                            className="link-button"
                            onClick={() => {
                              setSelection(undefined)
                              setSource(undefined)
                            }}
                          >
                            {t('supervisor.showAll')}
                          </button>
                        </li>
                      )}
                    </ul>
                    {stageEvent && (
                      <div className="supervisor-workspace__playback">
                        <div className="supervisor-workspace__section-heading">
                          <label htmlFor={`${graphId}-stage`}>
                            {t('supervisor.playback')}
                          </label>
                          <output htmlFor={`${graphId}-stage`}>
                            {stage + 1} / {layout.events.length} ·{' '}
                            {date(stageEvent.occurred_at)}
                          </output>
                        </div>
                        <input
                          id={`${graphId}-stage`}
                          type="range"
                          min="0"
                          max={layout.events.length - 1}
                          step="1"
                          value={stage}
                          disabled={layout.events.length < 2}
                          aria-valuetext={`${stage + 1}. ${stageEvent.title}`}
                          onChange={(event) =>
                            selectStage(Number(event.target.value))
                          }
                        />
                        <div className="supervisor-workspace__stage-actions">
                          <button
                            className="secondary-button"
                            disabled={stage <= 0}
                            onClick={() => selectStage(stage - 1)}
                          >
                            {t('supervisor.previousStage')}
                          </button>
                          <button
                            className="link-button"
                            onClick={() => selectStage(stage)}
                          >
                            {stageEvent.title}
                          </button>
                          <button
                            className="secondary-button"
                            disabled={stage >= layout.events.length - 1}
                            onClick={() => selectStage(stage + 1)}
                          >
                            {t('supervisor.nextStage')}
                          </button>
                        </div>
                      </div>
                    )}
                  </section>
                  <aside
                    className="supervisor-workspace__detail"
                    aria-label={t('supervisor.inspector')}
                  >
                    <h2>{t('supervisor.inspector')}</h2>
                    {selection ? (
                      <>
                        <div className="supervisor-workspace__detail-kicker">
                          {selectedEvent
                            ? t('supervisor.events')
                            : selectedEntity
                              ? t('supervisor.entities')
                              : t('supervisor.relations')}
                          {graphScope && ` · ${scopeText(graphScope)}`}
                        </div>
                        <h3>
                          {selectedEvent?.title ??
                            selectedEntity?.canonical_label ??
                            `${layout.entityMap.get(layout.relation?.from_entity_id ?? '')?.canonical_label} → ${layout.entityMap.get(layout.relation?.to_entity_id ?? '')?.canonical_label}`}
                        </h3>
                        <p className="supervisor-workspace__detail-copy">
                          {selectedEvent?.description ??
                            selectedEntity?.description ??
                            layout.relation?.reason}
                        </p>
                        {selectedEvent && (
                          <time>{date(selectedEvent.occurred_at)}</time>
                        )}
                        <div className="supervisor-workspace__related">
                          <h4>{t('supervisor.connections')}</h4>
                          {layout.entities
                            .filter(
                              (entity) =>
                                layout.selectedEntityIds.has(entity.id) &&
                                entity.id !== selection.id
                            )
                            .map((entity) => (
                              <button
                                className="link-button"
                                key={entity.id}
                                onClick={() =>
                                  select({ kind: 'entity', id: entity.id })
                                }
                              >
                                {entity.canonical_label} ↗
                              </button>
                            ))}
                          {selectedEntity &&
                            graph.relations
                              .filter(
                                (relation) =>
                                  relation.from_entity_id ===
                                    selectedEntity.id ||
                                  relation.to_entity_id === selectedEntity.id
                              )
                              .map((relation) => (
                                <button
                                  className="link-button"
                                  key={relation.id}
                                  onClick={() =>
                                    select({
                                      kind: 'relation',
                                      id: relation.id
                                    })
                                  }
                                >
                                  {
                                    layout.entityMap.get(
                                      relation.from_entity_id ===
                                        selectedEntity.id
                                        ? relation.to_entity_id
                                        : relation.from_entity_id
                                    )?.canonical_label
                                  }
                                  <small>
                                    {t(
                                      `supervisor.relationTypes.${relation.relation_type}`,
                                      { defaultValue: relation.relation_type }
                                    )}{' '}
                                    · {relation.reason}
                                  </small>
                                </button>
                              ))}
                          {!selectedEvent &&
                            layout.events
                              .filter((event) =>
                                layout.selectedEventIds.has(event.id)
                              )
                              .map((event) => (
                                <button
                                  className="link-button"
                                  key={event.id}
                                  onClick={() =>
                                    select({ kind: 'event', id: event.id })
                                  }
                                >
                                  {event.title}
                                </button>
                              ))}
                        </div>
                        {(selectedEntity || layout.relation) && (
                          <>
                            <p>
                              {t(
                                `supervisor.states.${selectedEntity?.confirmation_state ?? layout.relation?.confirmation_state}`,
                                {
                                  defaultValue:
                                    selectedEntity?.confirmation_state ??
                                    layout.relation?.confirmation_state
                                }
                              )}
                            </p>
                            <div className="supervisor-workspace__actions">
                              <button
                                className="secondary-button"
                                disabled={busy}
                                onClick={() => void action('confirm')}
                              >
                                {t('supervisor.confirm')}
                              </button>
                              {selectedEntity && (
                                <button
                                  className="secondary-button"
                                  disabled={busy}
                                  onClick={() =>
                                    setRevision(selectedEntity.canonical_label)
                                  }
                                >
                                  {t('supervisor.revise')}
                                </button>
                              )}
                              <button
                                className="danger-ghost"
                                disabled={busy}
                                onClick={() => setConfirmRemoval(true)}
                              >
                                {t('supervisor.remove')}
                              </button>
                            </div>
                          </>
                        )}
                        {revision !== undefined && (
                          <form
                            onSubmit={(event) => {
                              event.preventDefault()
                              void action('revise')
                            }}
                          >
                            <label>
                              {t('supervisor.label')}
                              <input
                                value={revision}
                                maxLength={240}
                                onChange={(event) =>
                                  setRevision(event.target.value)
                                }
                              />
                            </label>
                            <div className="supervisor-workspace__actions">
                              <button
                                className="secondary-button"
                                disabled={busy || !revision.trim()}
                              >
                                {t('supervisor.save')}
                              </button>
                              <button
                                className="secondary-button"
                                type="button"
                                disabled={busy}
                                onClick={() => setRevision(undefined)}
                              >
                                {t('supervisor.cancel')}
                              </button>
                            </div>
                          </form>
                        )}
                        {confirmRemoval && (
                          <div role="alert">
                            <p>{t('supervisor.removeHint')}</p>
                            <div className="supervisor-workspace__actions">
                              <button
                                className="secondary-button"
                                disabled={busy}
                                onClick={() => setConfirmRemoval(false)}
                              >
                                {t('supervisor.cancel')}
                              </button>
                              <button
                                className="danger-solid"
                                disabled={busy}
                                onClick={() => void action('revoke')}
                              >
                                {t('supervisor.remove')}
                              </button>
                            </div>
                          </div>
                        )}
                        <h4>
                          {selectedEvent
                            ? t('supervisor.sources')
                            : t('supervisor.eventSources')}
                        </h4>
                        {layout.sources.length ? (
                          layout.sources.map((item) => (
                            <button
                              className="link-button"
                              key={item.id}
                              disabled={busy}
                              onClick={() => void openSource(item.id)}
                            >
                              {item.title}
                              <small>{date(item.occurred_at)}</small>
                            </button>
                          ))
                        ) : (
                          <p>{t('supervisor.noSources')}</p>
                        )}
                      </>
                    ) : (
                      <p>{t('supervisor.selectHint')}</p>
                    )}
                    {source &&
                      layout.sources.some((item) => item.id === source.id) && (
                        <section className="supervisor-workspace__source">
                          <h4>{t('supervisor.sourceSnapshot')}</h4>
                          <p>{source.title}</p>
                          <time>{date(source.occurredAt)}</time>
                          <pre>{source.content}</pre>
                        </section>
                      )}
                  </aside>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
