import {
  CheckCircle2,
  ChevronRight,
  Clock3,
  HeartPulse,
  History,
  Lightbulb,
  ListChecks,
  Play,
  RefreshCw,
  Sparkles,
  XCircle
} from 'lucide-react'
import { useMemo, useState } from 'react'
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
import {
  EmptyState,
  PageHeader,
  PageTabs
} from './WorkspacePrimitives'

type HeartbeatCenterTab =
  | 'overview'
  | 'suggestions'
  | 'history'
  | 'plans'

export type HeartbeatCenterProps = {
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

export function HeartbeatCenter({
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
}: HeartbeatCenterProps): React.JSX.Element {
  const { t, i18n } = useTranslation('heartbeat')
  const [tab, setTab] = useState<HeartbeatCenterTab>('overview')
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
  const weekdayLabels = [
    t('center.weekdays.sunday'),
    t('center.weekdays.monday'),
    t('center.weekdays.tuesday'),
    t('center.weekdays.wednesday'),
    t('center.weekdays.thursday'),
    t('center.weekdays.friday'),
    t('center.weekdays.saturday')
  ]
  const runStatusLabels: Record<
    AssistantHeartbeatRun['status'],
    string
  > = {
    claimed: t('statuses.run.claimed'),
    completed: t('statuses.run.completed'),
    failed: t('statuses.run.failed'),
    skipped: t('statuses.run.skipped')
  }
  const taskStatusLabels: Record<AssistantTask['status'], string> = {
    queued: t('statuses.task.queued'),
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
  const recurrenceLabel = (
    config: AssistantHeartbeatConfig
  ): string =>
    config.recurrence.type === 'weekly'
      ? t('center.recurrence.weekly', {
          weekday: weekdayLabels[config.recurrence.weekday],
          time: config.recurrence.localTime
        })
      : t('center.recurrence.daily', {
          time: config.recurrence.localTime
        })
  const scopeLabel = (config: AssistantHeartbeatConfig): string => {
    if (config.scope.kind === 'global') {
      return t('center.scope.global')
    }
    const projectNames = config.scope.projectIds.map(
      (projectId) =>
        projects.find((project) => project.id === projectId)?.name ??
        t('settings.scope.unavailableProject')
    )
    return projectNames.join(t('settings.scope.nameSeparator'))
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
  const pendingTasks = followUpTasks.filter(
    (task) =>
      task.status !== 'completed' && task.status !== 'cancelled'
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
  const primaryConfig = activeConfigs[0] ?? configs[0]
  const latestEntry = orderedEntries[0]
  const attentionCount = pendingMemories.length + pendingTasks.length
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

  const tabs: ReadonlyArray<{
    id: HeartbeatCenterTab
    label: string
    count?: number
  }> = [
    { id: 'overview', label: t('center.tabs.overview') },
    {
      id: 'suggestions',
      label: t('center.tabs.suggestions'),
      count: attentionCount
    },
    { id: 'history', label: t('center.tabs.history') },
    { id: 'plans', label: t('center.tabs.plans') }
  ]

  return (
    <section
      aria-labelledby="heartbeat-center-title"
      className="heartbeat-center"
    >
      <PageHeader
        actions={
          initialLoadBlocked ? undefined : (
            <>
            <button
              aria-label={t('center.actions.refreshAriaLabel')}
              className="secondary-button"
              disabled={loading || pendingAction !== undefined}
              onClick={() => void runAction('refresh', onRefresh)}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={14} />
              {t('center.actions.refresh')}
            </button>
            {primaryConfig ? (
              <button
                className="primary-button"
                disabled={loading || pendingAction !== undefined}
                onClick={() =>
                  void runAction(`run:${primaryConfig.id}`, () =>
                    onRunNow(primaryConfig.id)
                  )
                }
                type="button"
              >
                <Play aria-hidden="true" size={14} />
                {pendingAction === `run:${primaryConfig.id}`
                  ? t('center.actions.running')
                  : t('center.actions.runOnce')}
              </button>
            ) : (
              <button
                className="primary-button"
                disabled={loading}
                onClick={() => setTab('plans')}
                type="button"
              >
                {t('center.actions.configure')}
              </button>
            )}
            </>
          )
        }
        description={t('center.description')}
        eyebrow={t('center.eyebrow')}
        headingId="heartbeat-center-title"
        icon={<HeartPulse size={22} />}
        scope={{ kind: 'global' }}
        title={t('center.title')}
      />

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
      <PageTabs
        ariaLabel={t('center.tabs.ariaLabel')}
        idPrefix="heartbeat"
        onChange={setTab}
        tabs={tabs}
        value={tab}
      />

      {tab === 'overview' && (
        <div
          aria-labelledby="heartbeat-tab-overview"
          className="heartbeat-center__panel"
          id="heartbeat-panel-overview"
          role="tabpanel"
        >
          <section
            aria-labelledby="heartbeat-status-title"
            className="heartbeat-center__section"
          >
            <div className="heartbeat-center__section-heading">
              <div>
                <p className="eyebrow">
                  {t('center.currentStatus.eyebrow')}
                </p>
                <h3 id="heartbeat-status-title">
                  {t('center.currentStatus.title')}
                </h3>
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
            {configs.length === 0 ? (
              <EmptyState
                action={
                  <button
                    className="primary-button"
                    onClick={() => setTab('plans')}
                    type="button"
                  >
                    {t('center.currentStatus.createPlan')}
                  </button>
                }
                description={t(
                  'center.currentStatus.emptyDescription'
                )}
                icon={<HeartPulse size={24} />}
                level="section"
                title={t('center.currentStatus.emptyTitle')}
              />
            ) : (
              <div className="heartbeat-center__config-grid">
                {configs.map((config) => (
                  <article
                    className="heartbeat-center__config-card"
                    key={config.id}
                  >
                    <header>
                      <span
                        className={
                          config.enabled
                            ? 'heartbeat-center__pulse-dot heartbeat-center__pulse-dot--active'
                            : 'heartbeat-center__pulse-dot'
                        }
                      />
                      <div>
                        <strong>{config.name}</strong>
                        <small>
                          {recurrenceLabel(config)} ·{' '}
                          {scopeLabel(config)}
                        </small>
                      </div>
                    </header>
                    <dl>
                      <div>
                        <dt>{t('center.config.nextHeartbeat')}</dt>
                        <dd>{formatDateTime(config.nextRunAt)}</dd>
                      </div>
                      <div>
                        <dt>{t('center.config.lastStatus')}</dt>
                        <dd>
                          {config.lastStatus
                            ? runStatusLabels[config.lastStatus]
                            : t('center.config.neverRun')}
                        </dd>
                      </div>
                    </dl>
                    <div>
                      <button
                        disabled={pendingAction !== undefined}
                        onClick={() =>
                          void runAction(`run:${config.id}`, () =>
                            onRunNow(config.id)
                          )
                        }
                        type="button"
                      >
                        {t('center.config.runNow')}
                      </button>
                      <button
                        disabled={pendingAction !== undefined}
                        onClick={() =>
                          void runAction(`pause:${config.id}`, () =>
                            onSetPaused(config.id, config.enabled)
                          )
                        }
                        type="button"
                      >
                        {config.enabled
                          ? t('center.config.pause')
                          : t('center.config.resume')}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
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

          <div className="heartbeat-center__overview-grid">
            <section
              aria-labelledby="heartbeat-trend-title"
              className="heartbeat-center__section"
            >
              <div className="heartbeat-center__section-heading">
                <div>
                  <p className="eyebrow">
                    {t('center.trend.eyebrow')}
                  </p>
                  <h3 id="heartbeat-trend-title">
                    {t('center.trend.title')}
                  </h3>
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

            <section
              aria-labelledby="latest-heartbeat-title"
              className="heartbeat-center__section"
            >
              <div className="heartbeat-center__section-heading">
                <div>
                  <p className="eyebrow">
                    {t('center.latest.eyebrow')}
                  </p>
                  <h3 id="latest-heartbeat-title">
                    {t('center.latest.title')}
                  </h3>
                </div>
                {latestEntry && (
                  <time dateTime={latestEntry.createdAt}>
                    {formatDateTime(latestEntry.createdAt)}
                  </time>
                )}
              </div>
              {latestEntry ? (
                <div className="heartbeat-center__latest">
                  <p>{latestEntry.summary}</p>
                  {latestEntry.highlights.length > 0 && (
                    <ul>
                      {latestEntry.highlights.slice(0, 3).map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  )}
                  <div>
                    <button
                      className="secondary-button"
                      onClick={() => setTab('history')}
                      type="button"
                    >
                      {t('center.latest.viewHistory')}
                      <ChevronRight aria-hidden="true" size={14} />
                    </button>
                    {attentionCount > 0 && (
                      <button
                        className="primary-button"
                        onClick={() => setTab('suggestions')}
                        type="button"
                      >
                        {t('center.latest.handleSuggestions', {
                          count: attentionCount,
                          formattedCount: formatCount(attentionCount)
                        })}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <p className="heartbeat-center__section-empty">
                  {t('center.latest.empty')}
                </p>
              )}
            </section>
          </div>
        </div>
      )}

      {tab === 'suggestions' && (
        <div
          aria-labelledby="heartbeat-tab-suggestions"
          className="heartbeat-center__panel heartbeat-center__suggestions"
          id="heartbeat-panel-suggestions"
          role="tabpanel"
        >
          <section
            aria-labelledby="heartbeat-memory-title"
            className="heartbeat-center__section"
          >
            <div className="heartbeat-center__section-heading">
              <div>
                <p className="eyebrow">
                  {t('center.suggestions.memoryEyebrow')}
                </p>
                <h3 id="heartbeat-memory-title">
                  {t('center.suggestions.memoryTitle')}
                </h3>
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
                <p className="eyebrow">
                  {t('center.suggestions.taskEyebrow')}
                </p>
                <h3 id="heartbeat-task-title">
                  {t('center.suggestions.taskTitle')}
                </h3>
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

      {tab === 'history' && (
        <div
          aria-labelledby="heartbeat-tab-history"
          className="heartbeat-center__panel heartbeat-center__history"
          id="heartbeat-panel-history"
          role="tabpanel"
        >
          <section
            aria-labelledby="heartbeat-reports-title"
            className="heartbeat-center__section"
          >
            <div className="heartbeat-center__section-heading">
              <div>
                <p className="eyebrow">
                  {t('center.history.timelineEyebrow')}
                </p>
                <h3 id="heartbeat-reports-title">
                  <History aria-hidden="true" size={16} />
                  {t('center.history.timelineTitle')}
                </h3>
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

          <section
            aria-labelledby="heartbeat-runs-title"
            className="heartbeat-center__section"
          >
            <div className="heartbeat-center__section-heading">
              <div>
                <p className="eyebrow">
                  {t('center.history.auditEyebrow')}
                </p>
                <h3 id="heartbeat-runs-title">
                  {t('center.history.auditTitle')}
                </h3>
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
          </section>
        </div>
      )}

      {tab === 'plans' && (
        <div
          aria-labelledby="heartbeat-tab-plans"
          className="heartbeat-center__panel heartbeat-center__plans"
          id="heartbeat-panel-plans"
          role="tabpanel"
        >
          <HeartbeatSettings
            heartbeats={configs}
            onCreate={onCreate}
            onRemove={onRemove}
            onRunNow={onRunNow}
            onSetPaused={onSetPaused}
            onUpdate={onUpdate}
            projects={projects}
          />
        </div>
      )}
        </>
      )}
    </section>
  )
}
