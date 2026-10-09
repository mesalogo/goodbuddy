import { useEffect, useRef, useState } from 'react'
import { History, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AssistantHeartbeatConfig, AssistantProject } from '../../shared/assistant-contracts'
import type { SupervisionActivity } from '../../shared/supervision-contracts'
import type { SupervisionReviewExecution } from '../../shared/supervision-review-contracts'
import { EmptyState, ScopeBadge } from './WorkspacePrimitives'
import { SupervisionBatchDetails } from './SupervisionBatchDetails'
import { SupervisionReviewStages } from './SupervisionReviewStages'

export function SupervisorActivity({ active, projects, onOpenResult, configId, configs = [], onPlanChange }: {
  configId?: string
  configs?: AssistantHeartbeatConfig[]
  onPlanChange?: (id: string) => void
  active: boolean
  projects: AssistantProject[]
  onOpenResult: (resultId: string, tab: 'overview' | 'graph') => void
}) {
  const { t, i18n } = useTranslation('heartbeat')
  const [rows, setRows] = useState<SupervisionActivity[]>([])
  const [offset, setOffset] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string>()
  const [expanded, setExpanded] = useState<string>()
  const [pending, setPending] = useState<string>()
  const [execution, setExecution] = useState<SupervisionReviewExecution>({ active: false })
  const [stopping, setStopping] = useState<{ runId: string; kind: 'paused' | 'cancelled' }>()
  const actionPending = useRef(false)
  const filterRef = useRef<HTMLSelectElement>(null)
  const [appliedConfigId, setAppliedConfigId] = useState(configId)
  if (appliedConfigId !== configId) {
    setAppliedConfigId(configId)
    setOffset(0)
    setRows([])
    setLoading(true)
    setError(undefined)
    setExpanded(undefined)
  }
  const api = window.goodbuddy?.supervision
  useEffect(() => {
    if (!active) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      setReading(true)
      try {
        if (!api?.activity) throw new Error(t('supervisor.unavailable'))
        const [result, current] = await Promise.all([
          api.activity({ limit: 50, offset, ...(configId ? { configId } : {}) }),
          api.execution()
        ])
        if (disposed) return
        setRows(result)
        setExecution(current)
        setError(undefined)
        // One request at a time, only while this page is active.
        timer = setTimeout(() => void load(), current.active || result.some((row) => row.status === 'running') ? 2000 : 10000)
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : t('common.operationFailed'))
      } finally {
        if (!disposed) {
          setLoading(false)
          setReading(false)
        }
      }
    }
    timer = setTimeout(() => void load(), 0)
    return () => { disposed = true; clearTimeout(timer) }
  }, [active, api, offset, refresh, t, configId])
  const reload = (nextOffset = offset) => {
    setLoading(true)
    setError(undefined)
    setOffset(nextOffset)
    setRefresh((value) => value + 1)
  }
  const date = (value: string) => new Date(value).toLocaleString(i18n.resolvedLanguage)
  // The review stays published; only the suggestion step is repeated.
  const retrySuggestions = async (heartbeatRunId: string) => {
    if (actionPending.current) return
    actionPending.current = true
    setPending(heartbeatRunId)
    setError(undefined)
    try { await api.retrySuggestions({ heartbeatRunId }) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally {
      actionPending.current = false
      setPending(undefined)
      setRefresh(value => value + 1)
    }
  }
  // The review stays published; only story organizing is repeated.
  const retryStories = async (row: SupervisionActivity) => {
    if (actionPending.current || !row.reviewProgress) return
    actionPending.current = true
    setPending(row.id)
    setError(undefined)
    try { await api.retryStories({ runId: row.reviewProgress.runId }) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally {
      actionPending.current = false
      setPending(undefined)
      setRefresh(value => value + 1)
    }
  }
  const control = async (row: SupervisionActivity, action: 'pause' | 'cancel' | 'resume') => {
    if (actionPending.current || !row.reviewProgress) return
    const runId = row.reviewProgress.runId
    actionPending.current = true
    setPending(row.id)
    setError(undefined)
    if (action !== 'resume') setStopping({ runId, kind: action === 'cancel' ? 'cancelled' : 'paused' })
    try {
      if (action === 'resume') {
        const current = await api.execution()
        setExecution(current)
        if (current.active) {
          setError(t('supervisor.runningHint'))
          return
        }
        // Resume resolves only when execution stops; keep its pause/cancel controls available.
        void api.resume({ runId }).then(
          () => setRefresh(value => value + 1),
          reason => setError(reason instanceof Error ? reason.message : String(reason))
        )
        return
      }
      await api[action]({ runId })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      actionPending.current = false
      setPending(undefined)
      setStopping(undefined)
      setRefresh(value => value + 1)
    }
  }
  const planScope = configs.find(config => config.id === configId)?.scope
  return <section className="supervisor-activity" aria-label={t('activity.title')} aria-busy={loading}>
    <div className="supervisor-workspace__action-bar">
      <ScopeBadge scope={planScope?.kind === 'global' ? { kind: 'global' }
        : planScope?.kind === 'projects' ? { kind: 'projects', projectCount: planScope.projectIds.length }
          : { kind: 'mixed' }} />
      {onPlanChange && <label className="heartbeat-settings__field">
        <select aria-label={t('activity.planFilter')} ref={filterRef} value={configId ?? ''} onChange={(event) => onPlanChange(event.target.value)}>
          <option value="">{t('activity.allPlans')}</option>
          {configId && !configs.some(config => config.id === configId) && <option value={configId}>{t('activity.unavailablePlan')}</option>}
          {configs.map(config => <option key={config.id} value={config.id}>{config.name}</option>)}
        </select>
      </label>}
      {configId && onPlanChange && <button className="secondary-button" type="button" onClick={() => {
        onPlanChange('')
        filterRef.current?.focus()
      }}>{t('activity.clearFilter')}</button>}
      <button className="secondary-button" type="button" disabled={loading || reading || !active} onClick={() => reload()}>
        <RefreshCw size={14} aria-hidden="true" />{t('center.actions.refresh')}
      </button>
    </div>
    {error && <div role="alert" className="heartbeat-center__error"><p>{error}</p>
      <button className="secondary-button" type="button" onClick={() => reload()}>{t('center.actions.retry')}</button>
    </div>}
    {loading ? <EmptyState icon={<RefreshCw size={24} />} variant="loading" title={t('activity.loading')} description={t('activity.loadingHint')} />
      : !error && rows.length === 0 ? <EmptyState icon={<History size={24} />} title={t(configId ? 'activity.filteredEmpty' : 'activity.empty')} description={t(configId ? 'activity.filteredEmptyHint' : 'activity.emptyHint')} />
      : <ol className="supervisor-activity__list">{rows.map((row) => {
        const runId = row.reviewProgress?.runId
        const experiences = row.reviewProgress?.stories?.experiences
        const stoppingKind = runId && stopping?.runId === runId ? stopping.kind
          : runId && execution.active && execution.runId === runId ? execution.stopping : undefined
        return <li key={`${row.kind}:${row.id}`}>
        <article className="supervisor-activity__item">
          <header><strong>{t(`activity.kind.${row.kind}`)}</strong>
            <span className={`supervisor-activity__status supervisor-activity__status--${stoppingKind ? 'running' : row.status}`} role={stoppingKind ? 'status' : undefined}>{t(stoppingKind === 'cancelled' ? 'reviewSettings.cancelling' : stoppingKind === 'paused' ? 'reviewSettings.pausing' : `activity.status.${row.status}`)}</span>
            <time dateTime={row.startedAt} title={row.startedAt}>{date(row.startedAt)}</time>
          </header>
          <p className="supervisor-activity__scope">{!row.scope ? t('activity.unknownScope') : row.scope.kind === 'global' ? t('center.scope.global') : t('supervisor.projectScope', { names: row.scope.projectIds.map((id) => projects.find((project) => project.id === id)?.name ?? t('settings.scope.unavailableProject')).join(', ') })} · {t(`activity.triggers.${row.trigger}`)}</p>
          {!row.reviewProgress && <>
          <p className="supervisor-activity__stages">
            <span>{t('activity.supervisionStage')}: {row.supervisionStatus ? t(`activity.status.${row.supervisionStatus}`) : t('activity.notRecorded')}</span>
          </p>
          </>}
          {row.reviewProgress && <>
            {row.reviewProgress.restartRequired && <p>{t('reviewSettings.restartRequired')}</p>}
            <div className="supervisor-workspace__actions">
              {(row.supervisionStatus === 'running' || stoppingKind) && <>
                <button type="button" className="secondary-button" disabled={!!pending || !!stoppingKind} onClick={() => void control(row, 'pause')}>{t('reviewSettings.pause')}</button>
                <button type="button" className="danger-ghost" disabled={!!pending || !!stoppingKind} onClick={() => void control(row, 'cancel')}>{t('reviewSettings.cancel')}</button>
              </>}
              {!stoppingKind && !row.reviewProgress.complete && !row.reviewProgress.restartRequired && (row.supervisionStatus === 'paused' || row.supervisionStatus === 'failed') && <button type="button" className="secondary-button" disabled={!!pending || execution.active} onClick={() => void control(row, 'resume')}>{t(row.reviewProgress.phase === 'summarizing' ? 'activity.resumeMerge' : row.reviewProgress.phase === 'saving' ? 'activity.resumeSave' : 'reviewSettings.resume')}</button>}
              <button type="button" className="secondary-button" aria-expanded={expanded === row.id} aria-controls={`batches-${row.id}`} onClick={() => setExpanded(expanded === row.id ? undefined : row.id)}>{t('reviewSettings.facts')}</button>
            </div>
          </>}
          {row.reviewProgress && <SupervisionReviewStages row={row} stopping={stoppingKind || undefined} />}
          {row.error && row.supervisionStatus !== 'cancelled' && !stoppingKind && <div className="supervisor-activity__failure">
            <p>{t(row.status === 'paused' ? 'reviewSettings.pausedHint' : /persistedId|candidateRef|entity identity/.test(row.error)
              ? 'reviewSettings.identityError' : 'reviewSettings.runError')}</p>
            <details className="supervisor-activity__diagnostics"><summary>{t('reviewSettings.diagnostics')}</summary>
              <pre tabIndex={0} aria-label={t('reviewSettings.diagnostics')} style={{ userSelect: 'text' }}>{row.error}</pre>
            </details>
          </div>}
          {row.reviewProgress?.stories && <p className="supervisor-activity__suggestion" role={row.reviewProgress.stories.status === 'failed' ? 'alert' : undefined}>
            {row.reviewProgress.stories.status === 'failed' ? t('activity.storyFailed')
              : `${t('activity.storyStage')}: ${t(`activity.storyStates.${row.reviewProgress.stories.status}`, { assigned: row.reviewProgress.stories.assigned ?? 0 })}`}
            {row.reviewProgress.stories.status === 'failed' && typeof api?.retryStories === 'function' && <button type="button" className="secondary-button"
              disabled={!!pending || execution.active} onClick={() => void retryStories(row)}>{t('activity.retryStories')}</button>}
          </p>}
          {experiences && <p className="supervisor-activity__suggestion" role={experiences.status === 'failed' ? 'alert' : undefined}>
              {experiences.status === 'failed' ? t('activity.experienceFailed')
                : `${t('activity.experienceStage')}: ${experiences.calls ? t('activity.experienceCompleted', { created: experiences.created ?? 0, applied: experiences.applied ?? 0 }) : t('activity.experienceNone')}`}
              {experiences.status === 'failed' && typeof api?.retryStories === 'function' && <button type="button" className="secondary-button"
                disabled={!!pending || execution.active} onClick={() => void retryStories(row)}>{t('activity.retryStories')}</button>}
            </p>}
          {row.suggestionStatus && <p className="supervisor-activity__suggestion" role={row.suggestionStatus === 'failed' ? 'alert' : undefined}>
            {row.suggestionStatus === 'failed' ? t('activity.updatedSuggestionFailed')
              : `${t('activity.suggestionStage')}: ${t(`activity.suggestionStates.${row.suggestionStatus}`, { count: row.suggestionCount ?? 0 })}`}
            {row.suggestionStatus === 'failed' && typeof api?.retrySuggestions === 'function' && <button type="button" className="secondary-button" disabled={!!pending}
              onClick={() => void retrySuggestions(row.id)}>{t('activity.retrySuggestions')}</button>}
          </p>}
          {row.resultId && <div className="supervisor-workspace__actions">
            <button className="secondary-button" type="button" onClick={() => onOpenResult(row.resultId!, 'overview')}>{t('activity.openReview')}</button>
            <button className="secondary-button" type="button" onClick={() => onOpenResult(row.resultId!, 'graph')}>{t('supervisor.viewInGraph')}</button>
          </div>}
          {row.reviewProgress && expanded === row.id && <div id={`batches-${row.id}`}><SupervisionBatchDetails key={row.reviewProgress.runId} runId={row.reviewProgress.runId} projects={projects} revision={row.reviewProgress.batches} /></div>}
          <details className="supervisor-activity__advanced"><summary>{t('activity.runDetails')}</summary>
            <dl>
              <div><dt>{t('activity.started')}</dt><dd>{date(row.startedAt)}</dd></div>
              <div><dt>{t('activity.finished')}</dt><dd>{row.completedAt ? date(row.completedAt) : t('common.unavailable')}</dd></div>
              {row.timeRange && <div><dt>{t('supervisor.period')}</dt><dd>{date(row.timeRange.from)} / {date(row.timeRange.to)}</dd></div>}
            </dl>
            {row.reviewProgress && <p>{t('reviewSettings.progress', { batches: row.reviewProgress.batches, characters: row.reviewProgress.characters, remaining: row.reviewProgress.remainingSources })}</p>}
            {!!row.reviewProgress?.omittedSources && <p>{t('activity.omittedSources', { count: row.reviewProgress.omittedSources })}</p>}
            {!!row.reviewProgress?.revisedSources && <p>{t('activity.revisedSources', { count: row.reviewProgress.revisedSources })}</p>}
            {row.reviewProgress?.navigationNodes !== undefined && <p>{t('activity.navigationSaved', { count: row.reviewProgress.navigationNodes })}</p>}
            {row.summary && <p className="supervisor-activity__summary">{row.summary}</p>}
            {row.reviewProgress?.settings && <details><summary>{t('reviewSettings.configuration')}</summary>
              <p>{t('reviewSettings.configurationValues', row.reviewProgress.settings)}</p>
            </details>}
          </details>
        </article>
      </li>})}</ol>}
    <nav className="supervisor-workspace__actions" aria-label={t('activity.pagination')}>
      <button className="secondary-button" type="button" disabled={loading || reading || !active || offset === 0} onClick={() => reload(Math.max(0, offset - 50))}>{t('activity.previous')}</button>
      <span>{t('activity.page', { page: offset / 50 + 1 })}</span>
      <button className="secondary-button" type="button" disabled={loading || reading || !active || rows.length < 50 || offset >= 100000} onClick={() => reload(offset + 50)}>{t('activity.next')}</button>
    </nav>
  </section>
}
