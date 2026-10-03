import {
  HeartPulse,
  History,
  RefreshCw,
  XCircle
} from 'lucide-react'
import { SupervisionSuggestionsPanel } from './SupervisionSuggestionsPanel'
import { useEffect, useMemo, useRef, useState, memo } from 'react'
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
import { isAgentRuntimeModelProtocol, type RuntimeSettings } from '../../shared/contracts'
import { defaultSupervisionTimeoutSeconds, supervisionTimeoutSecondsSchema, defaultSupervisorModelConcurrency, supervisorModelConcurrencySchema, type ApplicationSettings, type ApplicationSettingsUpdate } from '../../shared/application-settings-contracts'
import { SupervisionReviewSettings, type SupervisionSettingsSection } from './SupervisionReviewSettings'
import { SupervisorWorkspace, type SupervisionGraphNavigation } from './SupervisorWorkspace'
import { SupervisorActivity } from './SupervisorActivity'
import './supervisor-workspace.css'
import { getProjectDisplayText } from './project-display'
import { useWorkspaceUnsavedChanges } from './workspace-unsaved-changes'
import {
  EmptyState,
  PageHeader,
  PageTabs,
  ScopeBadge,
  type WorkspaceScope
} from './WorkspacePrimitives'

export type HeartbeatCenterProps = {
  runtimeSettings?: RuntimeSettings
  applicationSettings?: ApplicationSettings
  applicationSettingsPending?: boolean
  applicationSettingsLocked?: boolean
  applicationSettingsError?: string
  onUpdateApplicationSettings?: (input: ApplicationSettingsUpdate) => Promise<boolean>
  onRetryApplicationSettings?: () => void
  active?: boolean
  graphNavigation?: SupervisionGraphNavigation
  onOpenConversation?: (conversationId: string) => void
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

function byNewest<T extends { createdAt: string }>(left: T, right: T): number {
  return (
    new Date(right.createdAt).getTime() -
    new Date(left.createdAt).getTime()
  )
}

function HeartbeatCenterView(props: HeartbeatCenterProps): React.JSX.Element {
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
            onOpenConversation={props.onOpenConversation}
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
          onOpenResult={(resultId, focus) => {
            setActivityNavigation({ resultId, tab: 'graph', ...(focus ? { focus } : {}) })
            setPageTab('graph')
          }}
          onOpenActivity={(id) => {
            setActivityPlanId(id)
            setPageTab('activity')
            window.requestAnimationFrame(() => centerRef.current?.querySelector<HTMLElement>('#supervisor-tab-activity')?.focus())
          }} />
        {pageTab === 'settings' && <SupervisorSettingsTabs {...props} />}
      </div>
    </section>
  )
}

type SettingsTab = 'model' | SupervisionSettingsSection

/** Supervisor settings grouped by purpose. Every section stays mounted, so switching tabs keeps unsaved drafts. */
function SupervisorSettingsTabs(props: HeartbeatCenterProps): React.JSX.Element {
  const { t } = useTranslation('heartbeat')
  const [tab, setTab] = useState<SettingsTab>('model')
  const reviewProps = { settings: props.applicationSettings,
    disabled: props.applicationSettingsPending || props.applicationSettingsLocked,
    onSave: props.onUpdateApplicationSettings }
  const tabs: { id: SettingsTab; label: string }[] = [
    { id: 'model', label: t('settingsTabs.model') },
    { id: 'review', label: t('settingsTabs.review') },
    { id: 'stories', label: t('settingsTabs.stories') },
    { id: 'suggestions', label: t('settingsTabs.suggestions') }
  ]
  return <div className="supervisor-settings">
    <PageTabs ariaLabel={t('settingsTabs.label')} idPrefix="supervisor-settings" value={tab} onChange={setTab}
      variant="segmented" tabs={tabs} />
    {tabs.map(({ id }) => <div key={id} role="tabpanel" id={`supervisor-settings-panel-${id}`}
      aria-labelledby={`supervisor-settings-tab-${id}`} hidden={tab !== id}>
      {id === 'model' ? <SupervisionModelSettings {...props} /> : <SupervisionReviewSettings section={id} {...reviewProps} />}
    </div>)}
  </div>
}

function SupervisionModelSettings(props: HeartbeatCenterProps): React.JSX.Element {
  const { t } = useTranslation('heartbeat')
  const supervisor = props.applicationSettings?.supervisorOrganizeTimeoutSeconds ?? defaultSupervisionTimeoutSeconds
  const concurrency = props.applicationSettings?.supervisorModelConcurrency ?? defaultSupervisorModelConcurrency
  const profileId = props.applicationSettings?.supervisorModelProfileId ?? ''
  const profiles = useMemo(() => props.runtimeSettings?.modelProfiles.filter(profile => isAgentRuntimeModelProtocol(profile.protocol)) ?? [], [props.runtimeSettings])
  const [model, setModel] = useState(profileId)
  const [parallel, setParallel] = useState(String(concurrency))
  const [organize, setOrganize] = useState(String(supervisor))
  const [saved, setSaved] = useState({ supervisor, concurrency, profileId })
  if (saved.supervisor !== supervisor || saved.concurrency !== concurrency || saved.profileId !== profileId) {
    setSaved({ supervisor, concurrency, profileId })
    setModel(profileId)
    setParallel(String(concurrency))
    setOrganize(String(supervisor))
  }
  useWorkspaceUnsavedChanges(organize !== String(supervisor) || parallel !== String(concurrency) || model !== profileId)
  const valid = supervisionTimeoutSecondsSchema.safeParse(Number(organize)).success &&
    supervisorModelConcurrencySchema.safeParse(Number(parallel)).success
  const disabled = props.applicationSettingsPending || props.applicationSettingsLocked || !props.applicationSettings || !props.onUpdateApplicationSettings
  return <form className="heartbeat-settings heartbeat-settings__editor" onSubmit={(event) => {
    event.preventDefault()
    if (!valid || disabled) return
    void props.onUpdateApplicationSettings?.({ supervisorOrganizeTimeoutSeconds: Number(organize), supervisorModelConcurrency: Number(parallel),
      ...(model !== profileId ? { supervisorModelProfileId: model || null } : {}) })
  }}>
    <h2>{t('timeouts.title')}</h2>
    <label className="heartbeat-settings__field">{t('timeouts.model')}
      <select value={model} aria-describedby="supervisor-model-help" disabled={disabled || !props.runtimeSettings} onChange={event => setModel(event.target.value)}>
        <option value="">{t('timeouts.followDefault')}</option>
        {model && !profiles.some(profile => profile.id === model) && <option value={model} disabled>{t('timeouts.unavailableModel')}</option>}
        {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} ({profile.modelName})</option>)}
      </select>
    </label>
    <p id="supervisor-model-help">{t('timeouts.modelHelp')}</p>
    <p>{t('timeouts.help')}</p>
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
    <button className="primary-button" type="submit" disabled={disabled || !valid || (Number(organize) === supervisor && Number(parallel) === concurrency && model === profileId)}>{t('timeouts.save')}</button>
  </form>
}
function HeartbeatSections({
  onOpenActivity,
  pageTab,
  configs,
  runs,
  entries,
  projects,
  tasks,
  onCreate,
  onUpdate,
  onSetPaused,
  onRemove,
  onRunNow,
  onRefresh,
  onUseFollowUpTask,
  onOpenConversation,
  onOpenResult,
  loading = false,
  loadError,
  onRetryLoad
}: HeartbeatCenterProps & {
  pageTab: 'overview' | 'graph' | 'plans' | 'activity' | 'settings'
  onOpenActivity: (id: string) => void
  onOpenResult: (resultId: string, focus?: SupervisionGraphNavigation['focus']) => void
}): React.JSX.Element | null {
  const { t, i18n } = useTranslation('heartbeat')
  const { t: tWorkspace } = useTranslation('workspace')
  const [pendingAction, setPendingAction] = useState<string>()
  const [error, setError] = useState<string>()
  const [expandedEntryId, setExpandedEntryId] = useState<string>()
  const [visibleEntryCount, setVisibleEntryCount] = useState(20)
  const [suggestionReload, setSuggestionReload] = useState(0)
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
  const formatCount = (value: number): string =>
    countFormatter.format(value)
  const formatDateTime = (value?: string): string => {
    if (!value) {
      return t('common.unavailable')
    }
    const date = new Date(value)
    return Number.isNaN(date.getTime())
      ? t('common.unknownTime')
      : dateTimeFormatter.format(date)
  }

  // Earlier heartbeat versions wrote their own reports. They stay readable;
  // new heartbeats only trigger the shared review and add suggestions.
  const orderedEntries = useMemo(
    () => [...entries].sort(byNewest),
    [entries]
  )
  const activeConfigs = configs.filter((config) => config.enabled)
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
                onClick={() => void runAction('refresh', async () => {
                  setSuggestionReload(value => value + 1)
                  await onRefresh()
                })}
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

        </div>
      )}

      <SupervisionSuggestionsPanel onUseFollowUpTask={onUseFollowUpTask} tasks={tasks} reloadKey={suggestionReload}
        onOpenResult={onOpenResult} onOpenConversation={onOpenConversation} />

      {orderedEntries.length > 0 && (
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


        </>
      )}
    </section>
  )
}

/** Memoized: App re-renders on chat updates; this view re-renders only when its props change. */
export const HeartbeatCenter = memo(HeartbeatCenterView)
