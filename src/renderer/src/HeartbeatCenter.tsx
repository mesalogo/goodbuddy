import {
  CheckCircle2,
  ChevronRight,
  Clock3,
  HeartPulse,
  History,
  Lightbulb,
  ListChecks,
  RefreshCw,
  Sparkles,
  XCircle
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AssistantHeartbeatConfig,
  AssistantHeartbeatEntry,
  AssistantHeartbeatRun,
  AssistantMemory,
  AssistantProject,
  AssistantTask,
  HeartbeatCreateInput,
  HeartbeatUpdateInput
} from '../../shared/assistant-contracts'
import { HeartbeatSettings } from './HeartbeatSettings'
import { defaultSupervisionTimeoutSeconds, supervisionTimeoutSecondsSchema, defaultSupervisorModelConcurrency, supervisorModelConcurrencySchema, type ApplicationSettings, type ApplicationSettingsUpdate } from '../../shared/application-settings-contracts'
import { SupervisionReviewSettings } from './SupervisionReviewSettings'
import { SupervisorWorkspace, type SupervisionGraphNavigation } from './SupervisorWorkspace'
import { SupervisorActivity } from './SupervisorActivity'
import './supervisor-workspace.css'
import { getProjectDisplayText } from './project-display'
import {
  EmptyState,
  PageHeader,
  PageTabs,
  ScopeBadge,
  type WorkspaceScope
} from './WorkspacePrimitives'

export type HeartbeatCenterProps = {
  applicationSettings?: ApplicationSettings
  applicationSettingsPending?: boolean
  applicationSettingsLocked?: boolean
  applicationSettingsError?: string
  onUpdateApplicationSettings?: (input: ApplicationSettingsUpdate) => Promise<boolean>
  onRetryApplicationSettings?: () => void
  active?: boolean
  graphNavigation?: SupervisionGraphNavigation
  configs: AssistantHeartbeatConfig[]
  runs: AssistantHeartbeatRun[]
  entries: AssistantHeartbeatEntry[]
  memories: AssistantMemory[]
  projects: AssistantProject[]
  tasks: AssistantTask[]
  onCreate: (input: HeartbeatCreateInput) => Promise<void>
  onUpdate: (
    heartbeatId: string,
    input: HeartbeatUpdateInput
  ) => Promise<void>
  onSetPaused: (heartbeatId: string, paused: boolean) => Promise<void>
  onRemove: (heartbeatId: string) => Promise<void>
  onRunNow: (heartbeatId: string) => Promise<void>
  onRefresh: () => Promise<void>
  onSetMemoryStatus: (
    memoryId: string,
    status: AssistantMemory['status']
  ) => Promise<void>
  onSetTaskStatus: (
    taskId: string,
    status: 'completed' | 'cancelled'
  ) => Promise<void>
  onUseFollowUpTask: (task: AssistantTask) => void
  loading?: boolean
  loadError?: string
  onRetryLoad: () => void | Promise<void>
}

function percentage(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0
  }
  return Math.round((numerator / denominator) * 100)
}

function byNewest<T extends { createdAt: string }>(left: T, right: T): number {
  return (
    new Date(right.createdAt).getTime() -
    new Date(left.createdAt).getTime()
  )
}

export function HeartbeatCenter(props: HeartbeatCenterProps): React.JSX.Element {
  return <UnifiedSupervisorCenter {...props} />
}

function UnifiedSupervisorCenter(props: HeartbeatCenterProps): React.JSX.Element {
  const { t } = useTranslation('heartbeat')
  const centerRef = useRef<HTMLElement>(null)
  const [pageTab, setPageTab] = useState<'overview' | 'graph' | 'plans' | 'activity' | 'settings'>(props.graphNavigation ? 'graph' : 'overview')
  const [activityPlanId, setActivityPlanId] = useState('')
  const [activityNavigation, setActivityNavigation] = useState<SupervisionGraphNavigation>()
  const [appliedNavigation, setAppliedNavigation] = useState(props.graphNavigation)
  if (appliedNavigation !== props.graphNavigation) {
    setAppliedNavigation(props.graphNavigation)
    if (props.graphNavigation) {
      setActivityNavigation(undefined)
      setPageTab('graph')
    }
  }
  useEffect(() => {
    const navigation = activityNavigation ?? props.graphNavigation
    if (navigation) {
      centerRef.current?.querySelector<HTMLElement>(`#supervisor-tab-${navigation.tab ?? 'graph'}`)?.focus()
    }
  }, [props.graphNavigation, activityNavigation])
  return (
    <section ref={centerRef} className="heartbeat-center" aria-labelledby="supervisor-title">
      <PageHeader
        headingId="supervisor-title"
        title={t('center.title')}
        help={t('center.description')}
        icon={<HeartPulse size={22} />}
      />
      <PageTabs
        ariaLabel={t('supervisor.navigation')}
        idPrefix="supervisor"
        value={pageTab}
        onChange={setPageTab}
        tabs={[
          { id: 'overview', label: t('supervisor.recap') },
          { id: 'graph', label: t('supervisor.graph') },
          { id: 'plans', label: t('supervisor.automatic') },
          { id: 'activity', label: t('activity.title') },
          { id: 'settings', label: t('supervisor.settings') }
        ]}
      />
      <div
        role="tabpanel"
        className="supervisor-center__sections"
        id={`supervisor-panel-${pageTab}`}
        aria-labelledby={`supervisor-tab-${pageTab}`}
      >
        <div hidden={pageTab !== 'overview' && pageTab !== 'graph'}>
          <SupervisorWorkspace
            graphNavigation={activityNavigation ?? props.graphNavigation}
            tab={pageTab}
            onTabChange={setPageTab}
            projects={props.projects}
            onOpenActivity={() => {
              setActivityPlanId('')
              setPageTab('activity')
              window.requestAnimationFrame(() => centerRef.current?.querySelector<HTMLElement>('#supervisor-tab-activity')?.focus())
            }}
          />
        </div>
        {pageTab === 'activity' && <SupervisorActivity
          configId={activityPlanId || undefined}
          configs={props.configs}
          onPlanChange={setActivityPlanId}
          active={props.active !== false}
          projects={props.projects}
          onOpenResult={(resultId, tab) => {
            setActivityNavigation({ resultId, tab })
            setPageTab(tab)
          }}
        />}
        <HeartbeatSections {...props} pageTab={pageTab}
          onOpenActivity={(id) => {
            setActivityPlanId(id)
            setPageTab('activity')
            window.requestAnimationFrame(() => centerRef.current?.querySelector<HTMLElement>('#supervisor-tab-activity')?.focus())
          }} />
        {pageTab === 'settings' && <>
          <SupervisionModelSettings {...props} />
          <SupervisionReviewSettings settings={props.applicationSettings}
            disabled={props.applicationSettingsPending || props.applicationSettingsLocked}
            onSave={props.onUpdateApplicationSettings} />
        </>}
      </div>
    </section>
  )
}

function SupervisionModelSettings(props: HeartbeatCenterProps): React.JSX.Element {
  const { t } = useTranslation('heartbeat')
  const heartbeat = props.applicationSettings?.heartbeatReportTimeoutSeconds ?? defaultSupervisionTimeoutSeconds
  const supervisor = props.applicationSettings?.supervisorOrganizeTimeoutSeconds ?? defaultSupervisionTimeoutSeconds
  const concurrency = props.applicationSettings?.supervisorModelConcurrency ?? defaultSupervisorModelConcurrency
  const [parallel, setParallel] = useState(String(concurrency))
  const [report, setReport] = useState(String(heartbeat))
  const [organize, setOrganize] = useState(String(supervisor))
  const [saved, setSaved] = useState({ heartbeat, supervisor, concurrency })
  if (saved.heartbeat !== heartbeat || saved.supervisor !== supervisor || saved.concurrency !== concurrency) {
    setSaved({ heartbeat, supervisor, concurrency })
    setParallel(String(concurrency))
    setReport(String(heartbeat))
    setOrganize(String(supervisor))
  }
  const valid = supervisionTimeoutSecondsSchema.safeParse(Number(report)).success &&
    supervisionTimeoutSecondsSchema.safeParse(Number(organize)).success &&
    supervisorModelConcurrencySchema.safeParse(Number(parallel)).success
  const disabled = props.applicationSettingsPending || props.applicationSettingsLocked || !props.applicationSettings || !props.onUpdateApplicationSettings
  return <form className="heartbeat-settings heartbeat-settings__editor" onSubmit={(event) => {
    event.preventDefault()
    if (!valid || disabled) return
    void props.onUpdateApplicationSettings?.({ heartbeatReportTimeoutSeconds: Number(report), supervisorOrganizeTimeoutSeconds: Number(organize), supervisorModelConcurrency: Number(parallel) })
  }}>
    <h2>{t('timeouts.title')}</h2>
    <p>{t('timeouts.help')}</p>
    <label className="heartbeat-settings__field">{t('timeouts.report')}
      <input type="number" min={30} max={600} step={1} value={report} disabled={disabled}
        onChange={(event) => setReport(event.target.value)} />
    </label>
    <label className="heartbeat-settings__field">{t('timeouts.organize')}
      <input type="number" min={30} max={600} step={1} value={organize} disabled={disabled}
        onChange={(event) => setOrganize(event.target.value)} />
    </label>
    <p>{t('timeouts.transport')}</p>
    <label className="heartbeat-settings__field">{t('timeouts.concurrency')}
      <input type="number" min={1} max={4} step={1} value={parallel} disabled={disabled}
        onChange={(event) => setParallel(event.target.value)} />
    </label>
    <p>{t('timeouts.concurrencyHelp')}</p>
    {!valid && <p role="alert">{t('timeouts.invalid')}</p>}
    {props.applicationSettingsError && <div role="alert">
      <p>{props.applicationSettingsError}</p>
      <button className="secondary-button" type="button" disabled={props.applicationSettingsPending} onClick={props.onRetryApplicationSettings}>{t('center.actions.retry')}</button>
    </div>}
    <button className="primary-button" type="submit" disabled={disabled || !valid || (Number(report) === heartbeat && Number(organize) === supervisor && Number(parallel) === concurrency)}>{t('timeouts.save')}</button>
  </form>
}

function HeartbeatSections({
  onOpenActivity,
  pageTab,
  configs,
  runs,
  entries,
  memories,
  projects,
  tasks,
  onCreate,
  onUpdate,
  onSetPaused,
  onRemove,
  onRunNow,
  onRefresh,
  onSetMemoryStatus,
  onSetTaskStatus,
  onUseFollowUpTask,
  loading = false,
  loadError,
  onRetryLoad
}: HeartbeatCenterProps & {
  pageTab: 'overview' | 'graph' | 'plans' | 'activity' | 'settings'
  onOpenActivity: (id: string) => void
}): React.JSX.Element | null {
  const { t, i18n } = useTranslation('heartbeat')
  const { t: tWorkspace } = useTranslation('workspace')
  const [pendingAction, setPendingAction] = useState<string>()
  const [error, setError] = useState<string>()
  const [expandedEntryId, setExpandedEntryId] = useState<string>()
  const [expandedSuggestionId, setExpandedSuggestionId] =
    useState<string>()
  const [visibleEntryCount, setVisibleEntryCount] = useState(20)
  const [visibleRunCount, setVisibleRunCount] = useState(20)
  const dateTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.resolvedLanguage || 'zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      }),
    [i18n.resolvedLanguage]
  )
  const countFormatter = useMemo(
    () => new Intl.NumberFormat(i18n.resolvedLanguage || 'zh-CN'),
    [i18n.resolvedLanguage]
  )
  const percentFormatter = useMemo(
    () =>
      new Intl.NumberFormat(i18n.resolvedLanguage || 'zh-CN', {
        style: 'percent',
        maximumFractionDigits: 0
      }),
    [i18n.resolvedLanguage]
  )
  const formatCount = (value: number): string =>
    countFormatter.format(value)
  const formatPercent = (value: number): string =>
    percentFormatter.format(value / 100)
  const runStatusLabels: Record<
    AssistantHeartbeatRun['status'],
    string
  > = {
    claimed: t('statuses.run.claimed'),
    no_change: t('statuses.run.no_change'),
    completed: t('statuses.run.completed'),
    failed: t('statuses.run.failed'),
    skipped: t('statuses.run.skipped')
  }
  const taskStatusLabels: Record<AssistantTask['status'], string> = {
    queued: t('statuses.task.queued'),
    idle: t('statuses.task.idle'),
    running: t('statuses.task.running'),
    waiting_approval: t('statuses.task.waitingApproval'),
    paused: t('statuses.task.paused'),
    completed: t('statuses.task.completed'),
    failed: t('statuses.task.failed'),
    cancelled: t('statuses.task.cancelled'),
    interrupted: t('statuses.task.interrupted')
  }
  const memoryTypeLabels: Record<AssistantMemory['type'], string> = {
    preference: t('statuses.memory.preference'),
    fact: t('statuses.memory.fact'),
    summary: t('statuses.memory.summary'),
    procedure: t('statuses.memory.procedure')
  }
  const formatDateTime = (value?: string): string => {
    if (!value) {
      return t('common.unavailable')
    }
    const date = new Date(value)
    return Number.isNaN(date.getTime())
      ? t('common.unknownTime')
      : dateTimeFormatter.format(date)
  }

  const orderedEntries = useMemo(
    () => [...entries].sort(byNewest),
    [entries]
  )
  const orderedRuns = useMemo(() => [...runs].sort(byNewest), [runs])
  const proposedMemoryIds = useMemo(
    () =>
      new Set(
        orderedEntries.flatMap((entry) => entry.proposedMemoryIds)
      ),
    [orderedEntries]
  )
  const followUpTaskIds = useMemo(
    () =>
      new Set(orderedEntries.flatMap((entry) => entry.followUpTaskIds)),
    [orderedEntries]
  )
  const heartbeatMemories = useMemo(
    () =>
      memories.filter((memory) => proposedMemoryIds.has(memory.id)),
    [memories, proposedMemoryIds]
  )
  const pendingMemories = heartbeatMemories.filter(
    (memory) => memory.status === 'proposed'
  )
  const confirmedMemories = heartbeatMemories.filter(
    (memory) => memory.status === 'confirmed'
  )
  const followUpTasks = useMemo(
    () => tasks.filter((task) => followUpTaskIds.has(task.id)),
    [followUpTaskIds, tasks]
  )
  const completedTasks = followUpTasks.filter(
    (task) => task.status === 'completed'
  )
  const terminalRuns = orderedRuns.filter(
    (run) => run.status !== 'claimed'
  )
  const completedRuns = terminalRuns.filter(
    (run) => run.status === 'completed'
  )
  const highlightCount = orderedEntries.reduce(
    (total, entry) => total + entry.highlights.length,
    0
  )
  const activeConfigs = configs.filter((config) => config.enabled)
  const latestEntry = orderedEntries[0]
  const healthPercent = percentage(completedRuns.length, terminalRuns.length)
  const memoryPercent = percentage(
    confirmedMemories.length,
    proposedMemoryIds.size
  )
  const actionPercent = percentage(
    completedTasks.length,
    followUpTaskIds.size
  )
  const recentTrend = orderedEntries.slice(0, 7).reverse()
  const trendMaximum = Math.max(
    1,
    ...recentTrend.map(
      (entry) =>
        entry.highlights.length +
        entry.proposedMemoryIds.length +
        entry.followUpTaskIds.length
    )
  )
  const hasHeartbeatData =
    configs.length > 0 || runs.length > 0 || entries.length > 0
  const heartbeatScope = useMemo<WorkspaceScope>(() => {
    if (
      configs.length === 0 ||
      configs.every((config) => config.scope.kind === 'global')
    ) {
      return { kind: 'global' }
    }
    const includesGlobal = configs.some(
      (config) => config.scope.kind === 'global'
    )
    const projectIds = [
      ...new Set(
        configs.flatMap((config) =>
          config.scope.kind === 'projects'
            ? config.scope.projectIds
            : []
        )
      )
    ]
    if (!includesGlobal && projectIds.length === 1) {
      const project = projects.find(
        (candidate) => candidate.id === projectIds[0]
      )
      return project
        ? {
            kind: 'project',
            projectName: getProjectDisplayText(
              project,
              tWorkspace
            ).name
          }
        : {
            kind: 'unavailable',
            explanation: t('settings.scope.unavailableProject')
          }
    }
    if (!includesGlobal && projectIds.length > 1) {
      return {
        kind: 'projects',
        projectCount: projectIds.length
      }
    }
    return { kind: 'mixed' }
  }, [configs, projects, t, tWorkspace])
  const initialLoadBlocked =
    !hasHeartbeatData && (loading || loadError !== undefined)

  const runAction = async (
    actionId: string,
    action: () => Promise<void>
  ): Promise<void> => {
    if (pendingAction) {
      return
    }
    setPendingAction(actionId)
    setError(undefined)
    try {
      await action()
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t('common.operationFailed')
      )
    } finally {
      setPendingAction(undefined)
    }
  }

  if (pageTab !== 'plans') return null

  return (
    <section
      aria-label={t('center.tabs.overview')}
      className="heartbeat-center supervisor-center__sections"
    >
      <div className="heartbeat-center__section-heading">
        <ScopeBadge scope={heartbeatScope} />
        {!initialLoadBlocked && (
          <div className="supervisor-workspace__actions">
              <button
                aria-label={t('settings.refreshPlans')}
                className="secondary-button"
                disabled={loading || pendingAction !== undefined}
                onClick={() => void runAction('refresh', onRefresh)}
                type="button"
              >
                <RefreshCw aria-hidden="true" size={14} />
                {t('settings.refreshPlans')}
              </button>
          </div>
        )}
      </div>

      {error && (
        <p className="heartbeat-center__error" role="alert">
          {error}
        </p>
      )}

      {loading && !hasHeartbeatData ? (
        <EmptyState
          description={t('center.loading.description')}
          icon={<RefreshCw size={24} />}
          level="page"
          title={t('center.loading.title')}
          variant="loading"
        />
      ) : loadError && !hasHeartbeatData ? (
        <EmptyState
          action={
            <button
              className="secondary-button"
              onClick={() => void onRetryLoad()}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={14} />
              {t('center.actions.retry')}
            </button>
          }
          description={loadError}
          icon={<XCircle size={24} />}
          level="page"
          title={t('center.loading.failedTitle')}
        />
      ) : null}

      {loadError && hasHeartbeatData && (
        <div className="heartbeat-center__error" role="alert">
          <strong>{t('center.loading.refreshFailedTitle')}</strong>
          <p>{loadError}</p>
          <button
            className="secondary-button"
            onClick={() => void onRetryLoad()}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={14} />
            {t('center.actions.retry')}
          </button>
        </div>
      )}

      {!initialLoadBlocked && (
        <>
      {pageTab === 'plans' && (
        <div
          className="heartbeat-center__panel"
          id="heartbeat-panel-overview"
        >
          <section
            aria-labelledby="heartbeat-status-title"
            className="heartbeat-center__section"
          >
            <div className="heartbeat-center__section-heading">
              <div>
                <h2 id="heartbeat-status-title">
                  {t('center.currentStatus.title')}
                </h2>
              </div>
              <span
                className={
                  activeConfigs.length > 0
                    ? 'heartbeat-center__live heartbeat-center__live--active'
                    : 'heartbeat-center__live'
                }
              >
                <span aria-hidden="true" />
                {activeConfigs.length > 0
                  ? t('center.currentStatus.activePlans', {
                      count: activeConfigs.length,
                      formattedCount: formatCount(activeConfigs.length)
                    })
                  : t('center.currentStatus.disabled')}
              </span>
            </div>
            <div className="heartbeat-center__panel heartbeat-center__plans" id="heartbeat-panel-plans">
              <HeartbeatSettings
                onOpenActivity={onOpenActivity}
                heartbeats={configs}
                onCreate={onCreate}
                onRemove={onRemove}
                onRunNow={onRunNow}
                onSetPaused={onSetPaused}
                onUpdate={onUpdate}
                projects={projects}
              />
            </div>
          </section>

          <dl
            aria-label={t('center.metrics.ariaLabel')}
            className="heartbeat-center__metrics"
          >
            <div>
              <dt>
                <HeartPulse aria-hidden="true" size={15} />
                {t('center.metrics.health')}
              </dt>
              <dd>
                {terminalRuns.length
                  ? formatPercent(healthPercent)
                  : t('common.unavailable')}
              </dd>
              <small>
                {t('center.metrics.successfulRuns', {
                  completed: formatCount(completedRuns.length),
                  total: formatCount(terminalRuns.length)
                })}
              </small>
              <span
                aria-label={t('center.metrics.healthRateAriaLabel', {
                  percent: formatPercent(healthPercent)
                })}
                className="heartbeat-center__meter"
                role="progressbar"
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={healthPercent}
              >
                <span style={{ width: `${healthPercent}%` }} />
              </span>
            </div>
            <div>
              <dt>
                <Sparkles aria-hidden="true" size={15} />
                {t('center.metrics.memory')}
              </dt>
              <dd>
                {formatCount(confirmedMemories.length)}/
                {formatCount(proposedMemoryIds.size)}
              </dd>
              <small>{t('center.metrics.memoryDescription')}</small>
              <span
                aria-label={t('center.metrics.memoryRateAriaLabel', {
                  percent: formatPercent(memoryPercent)
                })}
                className="heartbeat-center__meter"
                role="progressbar"
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={memoryPercent}
              >
                <span style={{ width: `${memoryPercent}%` }} />
              </span>
            </div>
            <div>
              <dt>
                <Lightbulb aria-hidden="true" size={15} />
                {t('center.metrics.insights')}
              </dt>
              <dd>{formatCount(highlightCount)}</dd>
              <small>
                {t('center.metrics.insightReports', {
                  count: orderedEntries.length,
                  formattedCount: formatCount(orderedEntries.length)
                })}
              </small>
              <span className="heartbeat-center__metric-note">
                {latestEntry
                  ? t('center.metrics.latestInsights', {
                      count: latestEntry.highlights.length,
                      formattedCount: formatCount(
                        latestEntry.highlights.length
                      )
                    })
                  : t('center.metrics.awaitingFirstRun')}
              </span>
            </div>
            <div>
              <dt>
                <ListChecks aria-hidden="true" size={15} />
                {t('center.metrics.action')}
              </dt>
              <dd>
                {formatCount(completedTasks.length)}/
                {formatCount(followUpTaskIds.size)}
              </dd>
              <small>{t('center.metrics.actionDescription')}</small>
              <span
                aria-label={t('center.metrics.actionRateAriaLabel', {
                  percent: formatPercent(actionPercent)
                })}
                className="heartbeat-center__meter"
                role="progressbar"
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={actionPercent}
              >
                <span style={{ width: `${actionPercent}%` }} />
              </span>
            </div>
          </dl>

          <div>
            <section
              aria-labelledby="heartbeat-trend-title"
              className="heartbeat-center__section"
            >
              <div className="heartbeat-center__section-heading">
                <div>
                  <h2 id="heartbeat-trend-title">
                    {t('center.trend.title')}
                  </h2>
                </div>
              </div>
              {recentTrend.length === 0 ? (
                <p className="heartbeat-center__section-empty">
                  {t('center.trend.empty')}
                </p>
              ) : (
                <>
                  <div className="heartbeat-center__legend">
                    <span className="heartbeat-center__legend--insight">
                      {t('center.trend.insight')}
                    </span>
                    <span className="heartbeat-center__legend--memory">
                      {t('center.trend.memory')}
                    </span>
                    <span className="heartbeat-center__legend--task">
                      {t('center.trend.action')}
                    </span>
                  </div>
                  <div className="heartbeat-center__trend">
                    {recentTrend.map((entry) => {
                      const total =
                        entry.highlights.length +
                        entry.proposedMemoryIds.length +
                        entry.followUpTaskIds.length
                      return (
                        <div
                          aria-label={t('center.trend.rowAriaLabel', {
                            date: formatDateTime(entry.createdAt),
                            insights: formatCount(
                              entry.highlights.length
                            ),
                            memories: formatCount(
                              entry.proposedMemoryIds.length
                            ),
                            actions: formatCount(
                              entry.followUpTaskIds.length
                            )
                          })}
                          className="heartbeat-center__trend-row"
                          key={entry.id}
                          role="img"
                        >
                          <time dateTime={entry.createdAt}>
                            {formatDateTime(entry.createdAt)}
                          </time>
                          <span className="heartbeat-center__trend-track">
                            <span
                              className="heartbeat-center__trend-total"
                              style={{
                                width: `${Math.max(6, (total / trendMaximum) * 100)}%`
                              }}
                            >
                              <span
                                className="heartbeat-center__trend-insight"
                                style={{
                                  flex: entry.highlights.length
                                }}
                              />
                              <span
                                className="heartbeat-center__trend-memory"
                                style={{
                                  flex: entry.proposedMemoryIds.length
                                }}
                              />
                              <span
                                className="heartbeat-center__trend-task"
                                style={{
                                  flex: entry.followUpTaskIds.length
                                }}
                              />
                            </span>
                          </span>
                          <small>{formatCount(total)}</small>
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </section>

          </div>
        </div>
      )}

      {pageTab === 'plans' && (
        <div
          className="heartbeat-center__panel heartbeat-center__suggestions"
          id="heartbeat-panel-suggestions"
        >
          <section
            aria-labelledby="heartbeat-memory-title"
            className="heartbeat-center__section"
          >
            <div className="heartbeat-center__section-heading">
              <div>
                <h2 id="heartbeat-memory-title" tabIndex={-1}>
                  {t('center.suggestions.memoryTitle')}
                </h2>
              </div>
              <span>
                {t('center.suggestions.memoryCount', {
                  count: pendingMemories.length,
                  formattedCount: formatCount(pendingMemories.length)
                })}
              </span>
            </div>
            {pendingMemories.length === 0 ? (
              <p className="heartbeat-center__section-empty">
                {t('center.suggestions.memoryEmpty')}
              </p>
            ) : (
              <div className="heartbeat-center__suggestion-list">
                {pendingMemories.map((memory) => (
                  <article
                    className="heartbeat-center__suggestion"
                    key={memory.id}
                  >
                    <header>
                      <span>{memoryTypeLabels[memory.type]}</span>
                      <small>
                        {t(
                          'center.suggestions.confidenceAndSalience',
                          {
                            confidence: percentFormatter.format(
                              memory.confidence
                            ),
                            salience: percentFormatter.format(
                              memory.salience
                            )
                          }
                        )}
                      </small>
                    </header>
                    <p
                      className={
                        expandedSuggestionId === memory.id
                          ? 'heartbeat-center__suggestion-content--expanded'
                          : undefined
                      }
                    >
                      {memory.content}
                    </p>
                    {memory.content.length > 180 && (
                      <button
                        aria-expanded={
                          expandedSuggestionId === memory.id
                        }
                        className="heartbeat-center__link-button"
                        onClick={() =>
                          setExpandedSuggestionId(
                            expandedSuggestionId === memory.id
                              ? undefined
                              : memory.id
                          )
                        }
                        type="button"
                      >
                        {expandedSuggestionId === memory.id
                          ? t('center.suggestions.collapseContent')
                          : t('center.suggestions.expandContent')}
                      </button>
                    )}
                    <div>
                      <button
                        className="primary-button"
                        disabled={pendingAction !== undefined}
                        onClick={() =>
                          void runAction(
                            `memory:${memory.id}:confirmed`,
                            () =>
                              onSetMemoryStatus(memory.id, 'confirmed')
                          )
                        }
                        type="button"
                      >
                        <CheckCircle2 aria-hidden="true" size={14} />
                        {t('center.suggestions.confirmMemory')}
                      </button>
                      <button
                        className="secondary-button"
                        disabled={pendingAction !== undefined}
                        onClick={() =>
                          void runAction(
                            `memory:${memory.id}:rejected`,
                            () =>
                              onSetMemoryStatus(memory.id, 'rejected')
                          )
                        }
                        type="button"
                      >
                        <XCircle aria-hidden="true" size={14} />
                        {t('center.suggestions.ignore')}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section
            aria-labelledby="heartbeat-task-title"
            className="heartbeat-center__section"
          >
            <div className="heartbeat-center__section-heading">
              <div>
                <h2 id="heartbeat-task-title">
                  {t('center.suggestions.taskTitle')}
                </h2>
              </div>
              <span>
                {t('center.suggestions.taskCount', {
                  count: followUpTasks.length,
                  formattedCount: formatCount(followUpTasks.length)
                })}
              </span>
            </div>
            {followUpTasks.length === 0 ? (
              <p className="heartbeat-center__section-empty">
                {t('center.suggestions.taskEmpty')}
              </p>
            ) : (
              <div className="heartbeat-center__suggestion-list">
                {followUpTasks.map((task) => (
                  <article
                    className="heartbeat-center__suggestion"
                    key={task.id}
                  >
                    <header>
                      <span>{taskStatusLabels[task.status]}</span>
                      <small>{formatDateTime(task.createdAt)}</small>
                    </header>
                    <strong>{task.title}</strong>
                    <p
                      className={
                        expandedSuggestionId === task.id
                          ? 'heartbeat-center__suggestion-content--expanded'
                          : undefined
                      }
                    >
                      {task.instructions}
                    </p>
                    {task.instructions.length > 180 && (
                      <button
                        aria-expanded={
                          expandedSuggestionId === task.id
                        }
                        className="heartbeat-center__link-button"
                        onClick={() =>
                          setExpandedSuggestionId(
                            expandedSuggestionId === task.id
                              ? undefined
                              : task.id
                          )
                        }
                        type="button"
                      >
                        {expandedSuggestionId === task.id
                          ? t('center.suggestions.collapseContent')
                          : t('center.suggestions.expandContent')}
                      </button>
                    )}
                    {task.status !== 'completed' &&
                    task.status !== 'cancelled' ? (
                      <div>
                        <button
                          className="primary-button"
                          onClick={() => onUseFollowUpTask(task)}
                          type="button"
                        >
                          {t('center.suggestions.useInConversation')}
                          <ChevronRight aria-hidden="true" size={14} />
                        </button>
                        <button
                          className="secondary-button"
                          disabled={pendingAction !== undefined}
                          onClick={() =>
                            void runAction(
                              `task:${task.id}:completed`,
                              () =>
                                onSetTaskStatus(task.id, 'completed')
                            )
                          }
                          type="button"
                        >
                          <CheckCircle2 aria-hidden="true" size={14} />
                          {t('center.suggestions.markCompleted')}
                        </button>
                        <button
                          className="secondary-button"
                          disabled={pendingAction !== undefined}
                          onClick={() =>
                            void runAction(
                              `task:${task.id}:cancelled`,
                              () =>
                                onSetTaskStatus(task.id, 'cancelled')
                            )
                          }
                          type="button"
                        >
                          {t('center.suggestions.ignoreSuggestion')}
                        </button>
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {pageTab === 'plans' && (
        <div
          className="heartbeat-center__panel"
          id="heartbeat-panel-history"
        >
          <section
            aria-labelledby="heartbeat-reports-title"
            className="heartbeat-center__section"
          >
            <div className="heartbeat-center__section-heading">
              <div>
                <h2 id="heartbeat-reports-title" tabIndex={-1}>
                  <History aria-hidden="true" size={16} />
                  {t('center.history.timelineTitle')}
                </h2>
              </div>
              <span>
                {t('center.history.reportCount', {
                  count: orderedEntries.length,
                  formattedCount: formatCount(orderedEntries.length)
                })}
              </span>
            </div>
            {orderedEntries.length === 0 ? (
              <p className="heartbeat-center__section-empty">
                {t('center.history.emptyTimeline')}
              </p>
            ) : (
              <div className="heartbeat-center__timeline">
                {orderedEntries
                  .slice(0, visibleEntryCount)
                  .map((entry) => {
                    const expanded = expandedEntryId === entry.id
                    return (
                      <article key={entry.id}>
                        <span
                          aria-hidden="true"
                          className="heartbeat-center__timeline-dot"
                        />
                        <header>
                          <time dateTime={entry.createdAt}>
                            {formatDateTime(entry.createdAt)}
                          </time>
                          <small>
                            {t('center.history.reportSummary', {
                              insights: formatCount(
                                entry.highlights.length
                              ),
                              memories: formatCount(
                                entry.proposedMemoryIds.length
                              ),
                              actions: formatCount(
                                entry.followUpTaskIds.length
                              )
                            })}
                          </small>
                        </header>
                        <p
                          className={
                            expanded
                              ? 'heartbeat-center__report-summary heartbeat-center__report-summary--expanded'
                              : 'heartbeat-center__report-summary'
                          }
                        >
                          {entry.summary}
                        </p>
                        {expanded && entry.highlights.length > 0 && (
                          <ul>
                            {entry.highlights.map((highlight) => (
                              <li key={highlight}>{highlight}</li>
                            ))}
                          </ul>
                        )}
                        <button
                          aria-expanded={expanded}
                          className="heartbeat-center__link-button"
                          onClick={() =>
                            setExpandedEntryId(
                              expanded ? undefined : entry.id
                            )
                          }
                          type="button"
                        >
                          {expanded
                            ? t('center.history.collapseReport')
                            : t('center.history.expandReport')}
                        </button>
                      </article>
                    )
                  })}
              </div>
            )}
            {orderedEntries.length > visibleEntryCount && (
              <button
                className="secondary-button heartbeat-center__load-more"
                onClick={() =>
                  setVisibleEntryCount((count) => count + 20)
                }
                type="button"
              >
                {t('center.history.loadMoreReports')}
              </button>
            )}
          </section>

        </div>
      )}

      {pageTab === 'plans' && <section
            aria-labelledby="heartbeat-runs-title"
            className="heartbeat-center__section"
          >
            <div className="heartbeat-center__section-heading">
              <div>
                <h2 id="heartbeat-runs-title">
                  {t('center.history.auditTitle')}
                </h2>
              </div>
              <span>
                {t('center.history.runCount', {
                  count: orderedRuns.length,
                  formattedCount: formatCount(orderedRuns.length)
                })}
              </span>
            </div>
            {orderedRuns.length === 0 ? (
              <p className="heartbeat-center__section-empty">
                {t('center.history.emptyRuns')}
              </p>
            ) : (
              <ul className="heartbeat-center__run-list">
                {orderedRuns.slice(0, visibleRunCount).map((run) => (
                  <li
                    className={`heartbeat-center__run heartbeat-center__run--${run.status}`}
                    key={run.id}
                  >
                    {run.status === 'completed' ? (
                      <CheckCircle2 aria-hidden="true" size={16} />
                    ) : run.status === 'failed' ? (
                      <XCircle aria-hidden="true" size={16} />
                    ) : (
                      <Clock3 aria-hidden="true" size={16} />
                    )}
                    <span>
                      <strong>{runStatusLabels[run.status]}</strong>
                      <small>
                        {run.trigger === 'manual'
                          ? t('center.history.manualRun')
                          : t('center.history.scheduledRun')}{' '}
                        ·{' '}
                        {formatDateTime(run.scheduledFor)}
                        {run.attemptCount > 1
                          ? ` · ${t('center.history.attempt', {
                              count: run.attemptCount,
                              formattedCount: formatCount(
                                run.attemptCount
                              )
                            })}`
                          : ''}
                      </small>
                      {run.error && <em>{run.error}</em>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {orderedRuns.length > visibleRunCount && (
              <button
                className="secondary-button heartbeat-center__load-more"
                onClick={() =>
                  setVisibleRunCount((count) => count + 20)
                }
                type="button"
              >
                {t('center.history.loadMoreRuns')}
              </button>
            )}
          </section>}

        </>
      )}
    </section>
  )
}
