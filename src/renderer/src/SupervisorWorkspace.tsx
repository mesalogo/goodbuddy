import { Component, lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import { BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, Ellipsis, Network, RefreshCw, X } from 'lucide-react'
import { InlineHelp } from './InlineHelp'
import { AnchoredMenu } from './AnchoredMenu'
import type { AppNotificationInput } from './notifications'
import { EmptyState, PageTabs, SegmentedControl } from './WorkspacePrimitives'
import { storyDigest } from './supervision-story-digest'
import { SupervisionDiscussion } from './SupervisionDiscussion'
import { SupervisionStoryDigest } from './SupervisionStoryDigest'
import { useFillHeight } from './use-fill-height'
import { SupervisorSelectionList } from './SupervisorSelectionList'
import { SupervisionEventStory, SupervisionExperienceDetail, SupervisionExperienceList, SupervisionStoryDetail, SupervisionStoryList, useSupervisionStories } from './SupervisionStories'
import type { AssistantProject } from '../../shared/assistant-contracts'
import { heartbeatScopeSchema } from '../../shared/assistant-contracts'
import {
  supervisionGraphViewSchema,
  supervisionResultViewSchema,
  type SupervisionGraphView,
  type SupervisionResultView,
  type SupervisionRunRequest
} from '../../shared/supervision-contracts'

// Three.js loads only when the spiral view is opened.
// A failed chunk load (busy disk or renderer, interrupted update) is retried once before reporting.
const StoryGraph3D = lazy(() => import('./StoryGraph3D').catch(() => new Promise<typeof import('./StoryGraph3D')>((resolve, reject) =>
  setTimeout(() => { import('./StoryGraph3D').then(resolve, reject) }, 800))))

/** Keeps a failure of the spiral view inside the canvas; the flat view, lists and page stay usable. */
class SpiralBoundary extends Component<{ children: ReactNode; fallback: (retry: () => void) => ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  componentDidCatch(error: unknown): void { console.error('GoodBuddy spiral view failed', error) }
  render(): ReactNode { return this.state.failed ? this.props.fallback(() => this.setState({ failed: false })) : this.props.children }
}
type Selection = { kind: 'event' | 'entity' | 'relation' | 'story' | 'experience'; id: string }
/** `focus` opens a story or experience in the graph lists, such as from a heartbeat suggestion. */
export type SupervisionGraphNavigation = { resultId: string; tab?: 'overview' | 'graph'; focus?: { kind: 'story' | 'experience'; id: string } }
type Props = {
  graphNavigation?: SupervisionGraphNavigation
  tab?: 'overview' | 'graph' | 'plans' | 'activity' | 'settings'
  projects?: AssistantProject[]
  onNotify?: (notification: AppNotificationInput) => void
  onOpenConversation?: (conversationId: string) => void
  onTabChange?: (tab: 'overview' | 'graph' | 'plans' | 'activity' | 'settings') => void
}
const GRAPH_MIN_HEIGHT = 660
// Stable empty value: a new array per render would rebuild the 3D scene on every refresh.
const noAttention: NonNullable<SupervisionGraphView['attention']> = []
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
  onTabChange,
  onNotify,
  onOpenConversation
}: Props) {
  const { t, i18n } = useTranslation('heartbeat')
  const graphId = useId()
  const api = window.goodbuddy?.supervision
  const [results, setResults] = useState<SupervisionResultView[]>([])
  const [graph, setGraph] = useState(emptyGraph)
  const [overviewLoading, setOverviewLoading] = useState(true)
  const [overviewError, setOverviewError] = useState<string>()
  const [graphResultId, setGraphResultId] = useState<string>()
  const [graphError, setGraphError] = useState<string>()
  const [pending, setPending] = useState<string>()
  const [selection, setSelection] = useState<Selection | undefined>(graphNavigation?.focus)
  const [listTab, setListTab] = useState<Selection['kind']>(graphNavigation?.focus?.kind ?? 'event')
  const [graphMode, setGraphMode] = useState<'flat' | 'spiral'>('flat')
  const [source, setSource] = useState<{
    id: string
    title: string
    content: string
    occurredAt: string
    conversationId?: string
  }>()
  const [projectId, setProjectId] = useState('global')
  const [period, setPeriod] = useState('7')
  const [customDays, setCustomDays] = useState('7')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [newReviewOpen, setNewReviewOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(Boolean(graphNavigation?.focus))
  const detailToggleRef = useRef<HTMLButtonElement>(null)
  const detailRef = useRef<HTMLElement>(null)
  const runPending = useRef(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const [moreOpen, setMoreOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const historyRef = useRef<HTMLButtonElement>(null)
  const historyId = useId()
  const [confirmReanalyze, setConfirmReanalyze] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  const moreId = useId()
  const [resultId, setResultId] = useState<string | undefined>(graphNavigation?.resultId)
  const [appliedNavigation, setAppliedNavigation] = useState(graphNavigation)
  if (appliedNavigation !== graphNavigation) {
    setAppliedNavigation(graphNavigation)
    setResultId(graphNavigation?.resultId)
    setGraph(emptyGraph)
    setGraphResultId(undefined)
    setGraphError(undefined)
    setOverviewLoading(true)
    setSource(undefined)
    setSelection(graphNavigation?.focus)
    setDetailOpen(Boolean(graphNavigation?.focus))
    if (graphNavigation?.focus) setListTab(graphNavigation.focus.kind)
    setPending(undefined)
    setOverviewError(undefined)
  }
  const selectedResult = useRef<string | undefined>(undefined)
  const requestedNavigation = useRef<SupervisionGraphNavigation | undefined>(undefined)
  const loadGeneration = useRef(0)
  const [confirmRemoval, setConfirmRemoval] = useState(false)
  const [revision, setRevision] = useState<string>()
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'
  }), [i18n.resolvedLanguage])
  const shortDateFormatter = useMemo(() => new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    month: '2-digit', day: '2-digit'
  }), [i18n.resolvedLanguage])
  const date = (value: string) => dateFormatter.format(new Date(value))
  const shortDate = (value: string) => shortDateFormatter.format(new Date(value))
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
    setPending(undefined)
    selectedResult.current = requestedId
    setOverviewLoading(true)
    setGraph(emptyGraph)
    setGraphResultId(undefined)
    setGraphError(undefined)
    setResultId(requestedId)
    setSource(undefined)
    setConfirmRemoval(false)
    setRevision(undefined)
    setOverviewError(undefined)
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
      if (requestedId && !selected) throw new Error('Requested supervision result is unavailable')
      const nextId = requestedId ?? selected?.id
      setResultId(nextId)
      selectedResult.current = nextId
    } catch {
      if (generation !== loadGeneration.current) return
      setOverviewError(t('supervisor.loadFailed'))
    } finally {
      if (generation === loadGeneration.current) setOverviewLoading(false)
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

  const latest = resultId ? results.find((item) => item.id === resultId) : results[0]
  const storyLineId = latest?.storyLineId
  // The selected result is the only graph cache. Refresh/navigation invalidate it;
  // switching tabs keeps it, and an obsolete in-flight read cannot refill it.
  useEffect(() => {
    if (!api || tab !== 'graph' || overviewLoading || overviewError || !resultId || graphResultId === resultId || graphError) return
    let active = true
    const generation = loadGeneration.current
    void api.graph({ resultId, storyLineId }).then(value => {
      if (!active || generation !== loadGeneration.current) return
      const parsed = supervisionGraphViewSchema.parse(value)
      if (parsed.storyLine) heartbeatScopeSchema.parse(JSON.parse(parsed.storyLine.scope_json))
      setGraph(parsed)
      setGraphResultId(resultId)
      setSelection(current => {
        if (current?.kind === 'story' || current?.kind === 'experience') return current
        const records = current?.kind === 'event' ? parsed.events : current?.kind === 'entity' ? parsed.entities : parsed.relations
        if (current && records.some(item => item.id === current.id)) return current
        const newest = parsed.events.reduce<SupervisionGraphView['events'][number] | undefined>((found, event) =>
          !found || Date.parse(event.occurred_at) > Date.parse(found.occurred_at) ? event : found, undefined)
        return newest ? { kind: 'event', id: newest.id } : undefined
      })
    }).catch(() => {
      if (active && generation === loadGeneration.current) setGraphError(t('supervisor.loadFailed'))
    })
    return () => { active = false }
  }, [api, tab, overviewLoading, overviewError, resultId, storyLineId, graphResultId, graphError, t])
  const loadError = overviewError ?? (tab === 'graph' ? graphError : undefined)
  const loading = overviewLoading || (tab === 'graph' && Boolean(resultId) && graphResultId !== resultId && !loadError)

  const resolvePeriod = (now: Date): { range?: SupervisionRunRequest['timeRange']; label?: string; error?: string } => {
    if (period === 'range') {
      const from = new Date(`${startDate}T00:00:00`)
      const end = new Date(`${endDate}T00:00:00`)
      const validDate = (value: string, parsed: Date) => /^\d{4}-\d{2}-\d{2}$/.test(value)
        && Number(value.slice(0, 4)) >= 1 && Number.isFinite(parsed.getTime())
        && parsed.getFullYear() === Number(value.slice(0, 4))
        && parsed.getMonth() + 1 === Number(value.slice(5, 7)) && parsed.getDate() === Number(value.slice(8, 10))
      if (!validDate(startDate, from) || !validDate(endDate, end)) return { error: t('supervisor.invalidDates') }
      if (from > now || end > now) return { error: t('supervisor.futureDates') }
      if (from > end) return { error: t('supervisor.reversedDates') }
      // The backend includes both endpoints. Advance by a local calendar day for DST.
      const to = new Date(end)
      to.setDate(to.getDate() + 1)
      to.setHours(0, 0, 0, -1)
      return { range: { from: from.toISOString(), to: new Date(Math.min(to.getTime(), now.getTime())).toISOString() },
        label: t('supervisor.dateRangeLabel', { from: startDate, to: endDate }) }
    }
    const value = period === 'custom' ? customDays : period
    const days = Number(value)
    const from = new Date(now.getTime() - days * 86400_000)
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(days) || days < 1
      || !Number.isFinite(from.getTime()) || from.getFullYear() < 1) return { error: t('supervisor.invalidDays') }
    return { range: { from: from.toISOString(), to: now.toISOString() }, label: t('supervisor.recentDays', { count: days }) }
  }
  const reviewPeriod = resolvePeriod(new Date())
  const today = new Date()
  const maxDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  // A review is incremental by default. Only an explicit re-analysis reads the whole interval again.
  const run = async (reanalyze = false) => {
    if (!api) return
    const { range } = resolvePeriod(new Date())
    if (!range) return
    setConfirmReanalyze(false)
    const notice = (message: string, tone: AppNotificationInput['tone'] = 'info') => {
      if (mounted.current) onNotify?.({ tone, message, dedupeKey: 'supervisor-review' })
    }
    if (runPending.current) {
      notice(t('supervisor.reviewBusy'))
      return
    }
    runPending.current = true
    const generation = loadGeneration.current
    const request: SupervisionRunRequest = {
      trigger: 'manual',
      ...(reanalyze ? { reanalyze: true } : {}),
      scope:
        projectId === 'global'
          ? { kind: 'global' }
          : { kind: 'projects', projectIds: [projectId] },
      timeRange: range
    }
    let submitted = false
    try {
      const current = await api.execution()
      if (!mounted.current) return
      if (current.active) {
        notice(t(current.stopping === 'cancelled' ? 'reviewSettings.cancelling' : current.stopping === 'paused' ? 'reviewSettings.pausing' : 'supervisor.reviewBusy'))
        return
      }
      submitted = true
      notice(t('supervisor.reviewStarted'))
      const outcome = await api.run(request) as { status?: string } | undefined
      if (!mounted.current) return
      switch (outcome?.status) {
        case 'paused': notice(t('reviewSettings.pausedHint')); break
        case 'cancelled': notice(t('supervisor.reviewCancelled')); break
        case 'no_change': notice(t('supervisor.reviewNoChange')); break
        case 'failed': notice(t('supervisor.reviewFailed'), 'error'); break
        default: notice(t('supervisor.reviewCompleted'), 'success')
      }
      // Refresh/navigation can invalidate result selection, but not operation feedback.
      if (generation !== loadGeneration.current) return
      selectedResult.current = undefined
      await refresh()
    } catch (reason) {
      if (/SUPERVISION_REVIEW_BUSY/.test(String(reason))) {
        notice(t('supervisor.reviewBusy'))
        return
      }
      notice(t(submitted ? 'supervisor.reviewFailed' : 'supervisor.reviewStartFailed'), 'error')
    } finally {
      runPending.current = false
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
    setDetailOpen(true)
    setListTab(next.kind)
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
    } catch {
      if (generation !== loadGeneration.current) return
      onNotify?.({ tone: 'error', message: t('common.operationFailed') })
    } finally {
      if (generation === loadGeneration.current) setPending(undefined)
    }
  }
  const openSource = async (id: string) => {
    if (!api || pending) return
    const generation = loadGeneration.current
    setPending('source')
    setSource(undefined)
    try {
      const item = await api.source(id)
      if (generation !== loadGeneration.current) return
      if (!item) {
        onNotify?.({ tone: 'error', message: t('supervisor.sourceMissing') })
        return
      }
      setSource({
        id,
        title: String(item.title),
        content: String(item.content),
        occurredAt: String(item.occurredAt),
        conversationId: item.sourceType === 'conversation' && typeof item.sourceId === 'string'
          ? item.sourceId : undefined
      })
    } catch {
      if (generation !== loadGeneration.current) return
      onNotify?.({ tone: 'error', message: t('supervisor.sourceLoadFailed') })
    } finally {
      if (generation === loadGeneration.current) setPending(undefined)
    }
  }
  const graphScope = useMemo(() => graph.storyLine
    ? (JSON.parse(graph.storyLine.scope_json) as SupervisionRunRequest['scope'])
    : undefined, [graph.storyLine])
  const storyState = useSupervisionStories(latest?.scope ?? graphScope, tab === 'graph' || tab === 'overview', results)
  const projectNames = useMemo(() => new Map(projects.map(project => [project.id, project.name])), [projects])
  const graphLayoutRef = useRef<HTMLDivElement>(null)
  // Flat labels need a taller minimum; the spiral can use short windows without that constraint.
  useFillHeight(graphLayoutRef, tab === 'graph' && graph.events.length > 0, 24, graphMode === 'spiral' ? 320 : GRAPH_MIN_HEIGHT)
  const graphEmptyRef = useRef<HTMLDivElement>(null)
  // Without a graph, the empty state takes the visible height so its message sits in the middle of the page.
  useFillHeight(graphEmptyRef, tab === 'graph' && !loading && !loadError && graph.events.length === 0, 24, 320)
  // The work review reads the selected result's own scope, so it matches the period shown.
  const digest = useMemo(() => latest && storyState.available ? storyDigest(storyState.view, latest.timeRange) : undefined,
    [latest, storyState.available, storyState.view])
  const hasDigest = digest && [digest.advanced, digest.started, digest.concluded, digest.experiences, digest.quiet].some(items => items.length > 0)
  const selectedStory = selection?.kind === 'story' ? storyState.view.stories.find((story) => story.id === selection.id) : undefined
  const selectedExperience = selection?.kind === 'experience' ? storyState.view.experiences.find((item) => item.id === selection.id) : undefined
  useEffect(() => {
    if (!detailOpen || !detailRef.current || !detailToggleRef.current || getComputedStyle(detailToggleRef.current).display === 'none') return
    detailRef.current.focus({ preventScroll: true })
    detailRef.current.scrollIntoView?.({ block: 'nearest' })
  }, [detailOpen, selection?.id, tab])
  const busy = !!api && (loading || pending !== undefined)
  const historyDetails = (item: SupervisionResultView) =>
    `${scopeText(item.scope)} · ${t('supervisor.period')}: ${date(item.timeRange.from)} – ${date(item.timeRange.to)}`
  const historySelector = results.length > 0 && <div className="supervisor-workspace__result-navigation">
    <span id={`${historyId}-label`}>{t('supervisor.history')}</span>
    <button ref={historyRef} type="button" className="model-button" value={resultId ?? ''} disabled={busy}
      aria-labelledby={`${historyId}-label`} aria-describedby={`${historyId}-context`}
      aria-haspopup="menu" aria-expanded={historyOpen && !busy} aria-controls={historyOpen && !busy ? historyId : undefined}
      onClick={() => setHistoryOpen(value => !value)}
      onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setHistoryOpen(true) } }}>
      <span className="model-button__label">{latest ? date(latest.createdAt) : t('supervisor.loading')}</span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    <span id={`${historyId}-context`} className="sr-only">{latest && `${t('supervisor.generatedAt', { time: date(latest.createdAt) })} · ${historyDetails(latest)}`}</span>
    {historyOpen && !busy && <AnchoredMenu anchorRef={historyRef} id={historyId} label={t('supervisor.history')}
      width={480} className="supervisor-workspace__history-menu" onClose={() => setHistoryOpen(false)}>
      {results.map(item => <button key={item.id} type="button" role="menuitemradio" value={item.id} aria-checked={item.id === resultId}
        onClick={() => { setHistoryOpen(false); historyRef.current?.focus(); setSelection(undefined); setSource(undefined); setDetailOpen(false); void refresh(item.id) }}>
        <span><span>{t('supervisor.generatedAt', { time: date(item.createdAt) })}</span><small>{historyDetails(item)}</small></span>
        {item.id === resultId && <Check size={16} aria-hidden="true" />}
      </button>)}
    </AnchoredMenu>}
  </div>
  const graphTools = <>
    {storyState.available && <div className="supervisor-workspace__graph-mode"><SegmentedControl ariaLabel={t('supervisor.graph3d.mode')}
      value={graphMode} onChange={setGraphMode} options={(['flat', 'spiral'] as const).map(value => ({ value, label: t(`supervisor.graph3d.modes.${value}`) }))} /></div>}
    <button ref={detailToggleRef} type="button" className="secondary-button supervisor-workspace__detail-toggle"
      aria-expanded={detailOpen} aria-controls={`${graphId}-detail`} onClick={() => setDetailOpen(value => !value)}>{t('supervisor.inspector')}</button>
  </>

  return (
    <div className="supervisor-workspace" data-view={tab} aria-busy={busy}>
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
          {(tab === 'overview' || tab === 'graph') && <div className="supervisor-workspace__review-context" role="group" aria-label={t('supervisor.recap')}>
            {historySelector}
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void refresh()}>{t('center.actions.refresh')}</button>
            <button type="button" className={newReviewOpen ? 'secondary-button' : 'primary-button'} aria-expanded={newReviewOpen} aria-controls={`${graphId}-new-review`}
              onClick={() => { setNewReviewOpen(value => !value); setConfirmReanalyze(false) }}>{t('supervisor.newReview')}</button>
          </div>}
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
          {newReviewOpen && (tab === 'overview' || tab === 'graph') && (
            <>
              <div id={`${graphId}-new-review`} className="supervisor-workspace__toolbar" role="group" aria-label={t('supervisor.newReview')}>
                <label>
                  <select
                    aria-label={t('supervisor.scope')}
                    value={projectId}
                    onChange={(event) => { setProjectId(event.target.value); setConfirmReanalyze(false) }}
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
                  <select
                    aria-label={t('supervisor.period')}
                    value={period}
                    onChange={(event) => { setPeriod(event.target.value); setConfirmReanalyze(false) }}
                  >
                    {[1, 7, 30].map((value) => (
                      <option key={value} value={value}>
                        {t('supervisor.days', { count: value })}
                      </option>
                    ))}
                    <option value="custom">{t('supervisor.customDays')}</option>
                    <option value="range">{t('supervisor.dateRange')}</option>
                  </select>
                </label>
                {period === 'custom' && <label className="supervisor-workspace__period-field">
                  <span>{t('supervisor.dayCount')}</span>
                  <input className="field-control" type="number" min={1} step={1} required value={customDays}
                    aria-invalid={Boolean(reviewPeriod.error)} aria-describedby={`${graphId}-period-help`}
                    onChange={event => { setCustomDays(event.target.value); setConfirmReanalyze(false) }} />
                </label>}
                {period === 'range' && <div className="supervisor-workspace__date-range">
                  <label><span>{t('supervisor.startDate')}</span>
                    <input className="field-control" type="date" min="0001-01-01" max={maxDate} required value={startDate}
                      aria-invalid={Boolean(reviewPeriod.error)} aria-describedby={`${graphId}-period-help`}
                      onChange={event => { setStartDate(event.target.value); setConfirmReanalyze(false) }} />
                  </label>
                  <label><span>{t('supervisor.endDate')}</span>
                    <input className="field-control" type="date" min={startDate || '0001-01-01'} max={maxDate} required value={endDate}
                      aria-invalid={Boolean(reviewPeriod.error)} aria-describedby={`${graphId}-period-help`}
                      onChange={event => { setEndDate(event.target.value); setConfirmReanalyze(false) }} />
                  </label>
                </div>}
                <button
                  className="primary-button"
                  disabled={!reviewPeriod.range}
                  onClick={() => void run()}
                >
                  {t('supervisor.run')}
                </button>
                <button ref={moreRef} type="button" className="icon-button" aria-label={t('supervisor.more')} title={t('supervisor.more')}
                  aria-haspopup="menu" aria-expanded={moreOpen} aria-controls={moreOpen ? moreId : undefined}
                  onClick={() => setMoreOpen(!moreOpen)}><Ellipsis size={16} aria-hidden="true" /></button>
                {moreOpen && <AnchoredMenu anchorRef={moreRef} id={moreId} label={t('supervisor.more')} width={220} onClose={() => setMoreOpen(false)}>
                  <button type="button" role="menuitem" disabled={!reviewPeriod.range} onClick={() => {
                    setMoreOpen(false)
                    moreRef.current?.focus()
                    setConfirmReanalyze(true)
                  }}>{t('supervisor.reanalyze')}</button>
                </AnchoredMenu>}
                {(period === 'custom' || period === 'range') && <p id={`${graphId}-period-help`}
                  className="supervisor-workspace__period-help" role={reviewPeriod.error ? 'alert' : undefined}>
                  {reviewPeriod.error ?? t(period === 'range' ? 'supervisor.dateRangeHelp' : 'supervisor.customDaysHelp')}
                </p>}
              </div>
              {confirmReanalyze && <div className="supervisor-workspace__confirm" role="alertdialog" aria-labelledby={`${moreId}-title`}
                aria-describedby={`${moreId}-description`} onKeyDown={(event) => { if (event.key === 'Escape') setConfirmReanalyze(false) }}>
                <strong id={`${moreId}-title`}>{t('supervisor.reanalyzeTitle')}</strong>
                <p id={`${moreId}-description`}>{t('supervisor.reanalyzeHint', { scope: projectId === 'global' ? t('center.scope.global')
                  : projects.find(project => project.id === projectId)?.name ?? '', period: reviewPeriod.label })}</p>
                <div>
                  <button type="button" className="secondary-button" autoFocus onClick={() => setConfirmReanalyze(false)}>{t('supervisor.cancel')}</button>
                  <button type="button" className="primary-button" disabled={!reviewPeriod.range} onClick={() => void run(true)}>{t('supervisor.reanalyzeConfirm')}</button>
                </div>
              </div>}
            </>
          )}
          {tab === 'overview' && (
            <>
              {latest ? (
                <article className="supervisor-workspace__recap" data-sidebar={Boolean(latest.openItems.length || hasDigest)}>
                  <div className="supervisor-workspace__prose">
                    <h3>{t('supervisor.summary')}</h3>
                    {latest.summary.split(/\r?\n\s*\r?\n/u).map((paragraph, index) => (
                      <p className="supervisor-workspace__summary" key={index}>{paragraph}</p>
                    ))}
                    {latest.changeDigest && <>
                      <h3>{t('supervisor.changes')}</h3>
                      <p className="supervisor-workspace__summary">{latest.changeDigest}</p>
                    </>}
                  </div>
                  {(latest.openItems.length > 0 || hasDigest) && <aside className="supervisor-workspace__recap-sidebar">
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
                    {hasDigest && <SupervisionStoryDigest digest={digest} date={date}
                      onOpen={(focus) => { select(focus); onTabChange?.('graph') }} />}
                  </aside>}
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
              {!loading && !loadError && !graph.events.length && (
                <div className="supervisor-workspace__graph-empty" ref={graphEmptyRef}>
                  <EmptyState
                    icon={<Network size={28} />}
                    title={t('supervisor.graphEmpty')}
                    description={t('supervisor.emptyHint')}
                    action={
                      <div className="supervisor-workspace__empty-actions">
                        <button
                          className="primary-button"
                          onClick={() => onTabChange?.('overview')}
                        >
                          {t('supervisor.recap')}
                        </button>
                      </div>
                    }
                  />
                </div>
              )}
              {graph.events.length > 0 && (
                <div className="supervisor-workspace__graph-layout" ref={graphLayoutRef} data-detail-open={detailOpen} data-mode={graphMode}>
                  <aside
                    className="supervisor-workspace__graph-list"
                    aria-label={t('supervisor.selection')}
                  >
                    <select className="field-control supervisor-workspace__category" aria-label={t('supervisor.selection')}
                      value={listTab} onChange={event => setListTab(event.target.value as Selection['kind'])}>
                      {(['event', 'entity', 'relation', ...(storyState.available ? ['story', 'experience'] as const : [])] as const).map(kind =>
                        <option key={kind} value={kind}>{t(`supervisor.listTabs.${kind}`)} {kind === 'event' ? layout.events.length : kind === 'entity' ? layout.entities.length : kind === 'relation' ? graph.relations.length : kind === 'story' ? storyState.view.stories.length : storyState.view.experiences.length}</option>)}
                    </select>
                    <PageTabs
                      ariaLabel={t('supervisor.selection')}
                      idPrefix={`${graphId}-list`}
                      value={listTab}
                      onChange={setListTab}
                      tabs={[
                        { id: 'event', label: `${t('supervisor.listTabs.event')} ${layout.events.length}` },
                        { id: 'entity', label: `${t('supervisor.listTabs.entity')} ${layout.entities.length}` },
                        { id: 'relation', label: `${t('supervisor.listTabs.relation')} ${graph.relations.length}` },
                        ...(storyState.available ? [{ id: 'story' as const, label: `${t('supervisor.listTabs.story')} ${storyState.view.stories.length}` },
                          { id: 'experience' as const, label: `${t('supervisor.listTabs.experience')} ${storyState.view.experiences.length}` }] : [])
                      ]}
                    />
                    {listTab === 'event' || listTab === 'entity' || listTab === 'relation' ? <SupervisorSelectionList
                      key={`${resultId}:${listTab}`} kind={listTab} events={layout.events} entities={layout.entities} relations={graph.relations}
                      entityMap={layout.entityMap} selectedId={selection?.kind === listTab ? selection.id : undefined}
                      onSelect={select} date={date} shortDate={shortDate} entityTone={entityTone}
                      id={`${graphId}-list-panel-${listTab}`} labelledBy={`${graphId}-list-tab-${listTab}`} /> : <div
                      key={listTab}
                      className="supervisor-workspace__list-panel"
                      role="tabpanel"
                      id={`${graphId}-list-panel-${listTab}`}
                      aria-labelledby={`${graphId}-list-tab-${listTab}`}
                      tabIndex={0}
                    >
                    {listTab === 'story' && <>
                      {storyState.error && <p role="alert">{storyState.error}</p>}
                      {!storyState.view.stories.length && <p className="supervisor-workspace__muted">{t('supervisor.stories.empty')}</p>}
                      <SupervisionStoryList stories={storyState.view.stories} selectedId={selectedStory?.id} date={shortDate}
                        onSelect={(id) => select({ kind: 'story', id })} />
                      {storyState.view.unassigned > 0 && <p className="supervisor-workspace__muted">
                        {t('supervisor.stories.unassigned', { count: storyState.view.unassigned })}</p>}
                    </>}
                    {listTab === 'experience' && <>
                      {storyState.error && <p role="alert">{storyState.error}</p>}
                      {!storyState.view.experiences.length && <p className="supervisor-workspace__muted">{t('supervisor.experiences.empty')}</p>}
                      <SupervisionExperienceList experiences={storyState.view.experiences} selectedId={selectedExperience?.id}
                        onSelect={(id) => select({ kind: 'experience', id })} />
                    </>}
                    </div>}
                    <p className="supervisor-workspace__muted">
                      {t('supervisor.legend')}
                    </p>
                  </aside>
                  <section
                    className="supervisor-workspace__graph-canvas"
                    aria-label={t('supervisor.canvas')}
                  >
                    {graphMode === 'flat' && <div className="supervisor-workspace__canvas-heading">
                      <strong>{t('supervisor.graph3d.all')}</strong>
                      <div className="supervisor-workspace__canvas-tools">
                        {selection && <button type="button" className="link-button" onClick={() => { setSelection(undefined); setSource(undefined) }}>
                          {t('supervisor.showAll')}</button>}
                        <InlineHelp icon="info" label={t('supervisor.graph3d.legendTitle')}>
                          <strong>{t('supervisor.graph3d.legendTitle')}</strong>
                          <ul className="supervisor-workspace__legend" aria-label={t('supervisor.legendLabel')}>
                            <li><i className="supervisor-workspace__legend-event" aria-hidden="true" />{t('supervisor.events')}</li>
                            <li><i className="supervisor-workspace__legend-entity" aria-hidden="true" />{t('supervisor.entities')}</li>
                            <li><i className="supervisor-workspace__legend-link" aria-hidden="true" />{t('supervisor.eventImpact')}</li>
                            <li><i className="supervisor-workspace__legend-relation" aria-hidden="true" />{t('supervisor.relations')}</li>
                          </ul>
                          <p>{t('supervisor.canvasNote')}</p>
                          <p>{t('supervisor.canvasCaption')}</p>
                        </InlineHelp>
                      </div>
                      {graphTools}
                    </div>}
                    {graphMode === 'spiral' ? (
                      <SpiralBoundary fallback={(retry) => <><div className="supervisor-workspace__canvas-heading">{graphTools}</div><div className="supervisor-workspace__inline-error" role="alert">
                        <strong>{t('supervisor.graph3d.failed')}</strong>
                        <button type="button" className="secondary-button" onClick={retry}>{t('supervisor.graph3d.retry')}</button>
                      </div></>}>
                      <Suspense fallback={<><div className="supervisor-workspace__canvas-heading">{graphTools}</div><p className="supervisor-workspace__muted" role="status">{t('supervisor.loading')}</p></>}>
                        <StoryGraph3D stories={storyState.view.stories} events={graph.events} projectNames={projectNames} attention={graph.attention ?? noAttention} timeRange={latest?.timeRange}
                          toolbar={graphTools}
                          selectedEventId={selection?.kind === 'event' ? selection.id : undefined}
                          onSelectEvent={(id) => { if (layout.eventMap.has(id)) select({ kind: 'event', id }) }}
                          onSelectStory={(id) => select({ kind: 'story', id })}
                          experiences={storyState.view.experiences}
                          selectedExperienceId={selection?.kind === 'experience' ? selection.id : undefined}
                          onSelectExperience={(id) => select({ kind: 'experience', id })} />
                      </Suspense>
                      </SpiralBoundary>
                    ) : <>
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
                      <p id={`${graphId}-caption`} className="sr-only">{t('supervisor.canvasCaption')}</p>
                      {/* Reading aids float on the canvas so the graph keeps the whole column. */}
                      <span className="supervisor-workspace__map-hint" aria-hidden="true">
                        {t('supervisor.visibleCounts', { events: layout.visibleEvents.length, entities: layout.visibleEntities.length })}
                      </span>
                    </figure>
                    {stageEvent && (
                      <div className="supervisor-workspace__playback">
                        <label htmlFor={`${graphId}-stage`}>
                          {t('supervisor.playback')}
                        </label>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={t('supervisor.previousStage')}
                          title={t('supervisor.previousStage')}
                          disabled={stage <= 0}
                          onClick={() => selectStage(stage - 1)}
                        >
                          <ChevronLeft size={16} aria-hidden="true" />
                        </button>
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
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={t('supervisor.nextStage')}
                          title={t('supervisor.nextStage')}
                          disabled={stage >= layout.events.length - 1}
                          onClick={() => selectStage(stage + 1)}
                        >
                          <ChevronRight size={16} aria-hidden="true" />
                        </button>
                        <output htmlFor={`${graphId}-stage`}>
                          {stage + 1} / {layout.events.length} · {date(stageEvent.occurred_at)}
                        </output>
                        <button
                          type="button"
                          className="link-button"
                          title={stageEvent.title}
                          onClick={() => selectStage(stage)}
                        >
                          {stageEvent.title}
                        </button>
                      </div>
                    )}
                    </>}
                  </section>
                  <aside
                    ref={detailRef}
                    tabIndex={-1}
                    id={`${graphId}-detail`}
                    className="supervisor-workspace__detail"
                    aria-label={t('supervisor.inspector')}
                    onKeyDown={(event) => { if (event.key === 'Escape' && detailOpen) { event.stopPropagation(); setDetailOpen(false); detailToggleRef.current?.focus() } }}
                  >
                    <button type="button" className="icon-button supervisor-workspace__detail-toggle" aria-label={t('supervisor.closeDetails')}
                      onClick={() => { setDetailOpen(false); detailToggleRef.current?.focus() }}><X size={16} aria-hidden="true" /></button>
                    <h2>{t('supervisor.inspector')}</h2>
                    {selection?.kind === 'experience' ? (
                      selectedExperience ? <>
                        {storyState.error && <p role="alert">{storyState.error}</p>}
                        <SupervisionExperienceDetail key={selectedExperience.id} experience={selectedExperience} experiences={storyState.view.experiences}
                          pending={storyState.pending} canUndo={storyState.view.canUndo} date={date} onAct={storyState.act}
                          onSelectEvent={(id) => { if (layout.eventMap.has(id)) select({ kind: 'event', id }) }} />
                      </> : <p>{t('supervisor.stories.missing')}</p>
                    ) : selection?.kind === 'story' ? (
                      selectedStory ? <>
                        {storyState.error && <p role="alert">{storyState.error}</p>}
                        <SupervisionStoryDetail key={selectedStory.id} story={selectedStory} stories={storyState.view.stories}
                          pending={storyState.pending} canUndo={storyState.view.canUndo} date={date} onAct={storyState.act}
                          onSelectEvent={(id) => { if (layout.eventMap.has(id)) select({ kind: 'event', id }) }} />
                      </> : <p>{t('supervisor.stories.missing')}</p>
                    ) : selection ? (
                      <>
                        <div className="supervisor-workspace__detail-kicker">
                          {selectedEvent
                            ? t('supervisor.events')
                            : selectedEntity
                              ? t('supervisor.entities')
                              : t('supervisor.relations')}
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
                        {selectedEvent && storyState.available && <SupervisionEventStory eventId={selectedEvent.id}
                          projectId={selectedEvent.project_id ?? null} stories={storyState.view.stories}
                          pending={storyState.pending} onAct={storyState.act} />}
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
                          {source.conversationId && onOpenConversation && (
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={() => onOpenConversation(source.conversationId!)}
                            >
                              {t('supervisor.openConversation')}
                            </button>
                          )}
                          <pre>{source.content}</pre>
                          {source.conversationId && resultId && onOpenConversation && <SupervisionDiscussion
                            key={`${resultId}:${source.id}:${source.conversationId}`}
                            resultId={resultId}
                            sourceId={source.id}
                            conversationId={source.conversationId}
                            title={source.title}
                            onOpenConversation={onOpenConversation}
                          />}
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
