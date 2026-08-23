import { Activity, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AssistantProject,
  TokenUsageSummary
} from '../../shared/assistant-contracts'
import { isUntouchedBuiltInDefaultProject } from '../../shared/assistant-contracts'
import {
  MAX_ACTIVITY_RECORDS,
  type ActivityRecord
} from './activity-store'
import {
  getTokenUsageTotals,
  groupTokenUsage,
  type TokenUsageGroup
} from './token-usage'
import {
  DestructiveConfirmActions,
  EmptyState,
  PageHeader,
  PageTabs,
  ScopeBadge,
  SegmentedControl,
  type WorkspaceScope
} from './WorkspacePrimitives'
import { getProjectDisplayText } from './project-display'

type ActivityFilter = 'all' | 'active' | 'failed'
type ActivityView = 'tasks' | 'timeline' | 'usage'
type ActivityActorKind =
  | 'user'
  | 'assistant'
  | 'subagent'
  | 'tool'
  | 'approval'

export type ActivityPanelProps = {
  projects?: readonly AssistantProject[]
  records: readonly ActivityRecord[]
  tokenUsage: TokenUsageSummary
  onClear: () => void
  onOpenConversation: (conversationId: string) => void
}

type ConversationActivityGroup = {
  conversationId: string
  title: string
  records: ActivityRecord[]
  latestAt: number
  status: ActivityRecord['status']
}

type ProjectActivityGroup = {
  key: string
  scope: ActivityRecord['scope']
  conversations: ConversationActivityGroup[]
  activityCount: number
}

function isActive(record: ActivityRecord): boolean {
  return record.status === 'pending' || record.status === 'running'
}

function isFailed(record: ActivityRecord): boolean {
  return (
    record.status === 'failed' ||
    record.status === 'denied' ||
    record.status === 'cancelled' ||
    record.status === 'interrupted'
  )
}

function matchesFilter(
  record: ActivityRecord,
  filter: ActivityFilter
): boolean {
  if (filter === 'active') {
    return isActive(record)
  }
  if (filter === 'failed') {
    return isFailed(record)
  }
  return true
}

function formatTime(
  createdAt: number,
  formatter: Intl.DateTimeFormat,
  unknownTime: string
): {
  display: string
  machineReadable?: string
} {
  if (!Number.isFinite(createdAt) || createdAt < 0) {
    return { display: unknownTime }
  }

  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) {
    return { display: unknownTime }
  }

  return {
    display: formatter.format(date),
    machineReadable: date.toISOString()
  }
}

function activityWorkspaceScope(
  scope: ActivityRecord['scope'],
  unavailableExplanation: string
): WorkspaceScope {
  if (scope.kind === 'project') {
    return { kind: 'project', projectName: scope.projectName }
  }
  if (scope.kind === 'global') {
    return { kind: 'global' }
  }
  return {
    kind: 'unavailable',
    explanation: unavailableExplanation
  }
}

function activityScopeKey(scope: ActivityRecord['scope']): string {
  if (scope.kind === 'project') {
    return `project:${scope.projectId}`
  }
  return scope.kind
}

function conversationStatus(
  records: readonly ActivityRecord[]
): ActivityRecord['status'] {
  const latestRecord = (
    candidates: readonly ActivityRecord[]
  ): ActivityRecord | undefined =>
    candidates.reduce<ActivityRecord | undefined>(
      (latest, record) =>
        !latest || record.createdAt > latest.createdAt ? record : latest,
      undefined
    )
  const latestRequest = latestRecord(
    records.filter((record) => record.kind === 'request')
  )
  if (latestRequest) {
    const latestResult = latestRecord(
      records.filter(
        (record) =>
          record.kind === 'result' &&
          record.requestId === latestRequest.requestId
      )
    )
    return latestResult?.status ?? latestRequest.status
  }

  return (
    latestRecord(records.filter((record) => record.kind === 'result'))
      ?.status ??
    latestRecord(records)?.status ??
    'completed'
  )
}

function getConversationTitles(
  records: readonly ActivityRecord[]
): Map<string, string> {
  const conversationTitles = new Map<string, string>()
  for (const record of records) {
    if (
      record.kind === 'request' &&
      !conversationTitles.has(record.conversationId)
    ) {
      conversationTitles.set(record.conversationId, record.title)
    }
  }
  return conversationTitles
}

function groupActivityRecordsByProject(
  records: readonly ActivityRecord[],
  allRecords: readonly ActivityRecord[]
): ProjectActivityGroup[] {
  const conversationTitles = getConversationTitles(allRecords)
  const allConversationRecords = new Map<string, ActivityRecord[]>()
  for (const record of allRecords) {
    const conversationRecords =
      allConversationRecords.get(record.conversationId) ?? []
    conversationRecords.push(record)
    allConversationRecords.set(record.conversationId, conversationRecords)
  }
  const projectGroups = new Map<
    string,
    {
      scope: ActivityRecord['scope']
      conversations: Map<string, ActivityRecord[]>
    }
  >()

  for (const record of records) {
    const projectKey = activityScopeKey(record.scope)
    const projectGroup = projectGroups.get(projectKey) ?? {
      scope: record.scope,
      conversations: new Map<string, ActivityRecord[]>()
    }
    const conversationRecords =
      projectGroup.conversations.get(record.conversationId) ?? []
    conversationRecords.push(record)
    projectGroup.conversations.set(
      record.conversationId,
      conversationRecords
    )
    projectGroups.set(projectKey, projectGroup)
  }

  return [...projectGroups.entries()].map(([key, projectGroup]) => {
    const conversations = [...projectGroup.conversations.entries()].map(
      ([conversationId, items]) => ({
        conversationId,
        title:
          conversationTitles.get(conversationId) ?? items[0]!.title,
        records: items,
        latestAt: Math.max(...items.map((record) => record.createdAt)),
        status: conversationStatus(
          allConversationRecords.get(conversationId) ?? items
        )
      })
    )
    return {
      key,
      scope: projectGroup.scope,
      conversations,
      activityCount: conversations.reduce(
        (count, conversation) => count + conversation.records.length,
        0
      )
    }
  })
}

export function ActivityPanel({
  projects = [],
  records,
  tokenUsage,
  onClear,
  onOpenConversation
}: ActivityPanelProps): React.JSX.Element {
  const { t, i18n } = useTranslation('activity')
  const { t: tWorkspace } = useTranslation('workspace')
  const [activeView, setActiveView] =
    useState<ActivityView>('tasks')
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [tokenGroup, setTokenGroup] =
    useState<TokenUsageGroup>('project')
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [selectedTimelineRecordId, setSelectedTimelineRecordId] =
    useState<string>()
  const dateTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.resolvedLanguage || 'zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }),
    [i18n.resolvedLanguage]
  )
  const tokenCountFormatter = useMemo(
    () => new Intl.NumberFormat(i18n.resolvedLanguage || 'zh-CN'),
    [i18n.resolvedLanguage]
  )
  const tokenPercentFormatter = useMemo(
    () =>
      new Intl.NumberFormat(i18n.resolvedLanguage || 'zh-CN', {
        style: 'percent',
        maximumFractionDigits: 1
      }),
    [i18n.resolvedLanguage]
  )
  const formatCacheHitRate = (value: number | undefined): string =>
    value === undefined ? '—' : tokenPercentFormatter.format(value)
  const formatCount = (value: number): string =>
    tokenCountFormatter.format(value)
  const statusLabels: Record<ActivityRecord['status'], string> = {
    pending: t('statuses.pending'),
    running: t('statuses.running'),
    completed: t('statuses.completed'),
    failed: t('statuses.failed'),
    denied: t('statuses.denied'),
    cancelled: t('statuses.cancelled'),
    interrupted: t('statuses.interrupted')
  }
  const kindLabels: Record<ActivityRecord['kind'], string> = {
    request: t('kinds.request'),
    tool: t('kinds.tool'),
    approval: t('kinds.approval'),
    subagent: t('kinds.subagent'),
    result: t('kinds.result')
  }
  const views: ReadonlyArray<{
    id: ActivityView
    label: string
  }> = [
    { id: 'tasks', label: t('tabs.tasks') },
    { id: 'timeline', label: t('tabs.timeline') },
    { id: 'usage', label: t('tabs.usage') }
  ]
  const tokenGroups: ReadonlyArray<{
    value: TokenUsageGroup
    label: string
    columnLabel: string
  }> = [
    {
      value: 'project',
      label: t('tokenUsage.groups.project'),
      columnLabel: t('tokenUsage.columns.project')
    },
    {
      value: 'conversation',
      label: t('tokenUsage.groups.conversation'),
      columnLabel: t('tokenUsage.columns.conversation')
    },
    {
      value: 'model',
      label: t('tokenUsage.groups.model'),
      columnLabel: t('tokenUsage.columns.model')
    }
  ]

  const projectDisplayNames = useMemo(
    () =>
      new Map(
        projects.flatMap((project) => {
          const displayName = getProjectDisplayText(
            project,
            tWorkspace
          ).name
          return isUntouchedBuiltInDefaultProject(project) &&
            displayName !== project.name
            ? [[project.id, displayName] as const]
            : []
        })
      ),
    [projects, tWorkspace]
  )
  const displayRecords = useMemo(
    () =>
      records.map((record) => {
        if (record.scope.kind !== 'project') {
          return record
        }
        const projectName = projectDisplayNames.get(
          record.scope.projectId
        )
        return projectName
          ? {
              ...record,
              scope: {
                ...record.scope,
                projectName
              }
            }
          : record
      }),
    [projectDisplayNames, records]
  )
  const displayTokenUsage = useMemo(
    () => ({
      ...tokenUsage,
      records: tokenUsage.records.map((record) => {
        const projectName = record.projectId
          ? projectDisplayNames.get(record.projectId)
          : undefined
        return projectName ? { ...record, projectName } : record
      })
    }),
    [projectDisplayNames, tokenUsage]
  )
  const visibleRecords = useMemo(
    () => displayRecords.slice(0, MAX_ACTIVITY_RECORDS),
    [displayRecords]
  )
  const filteredRecords = useMemo(
    () => visibleRecords.filter((record) => matchesFilter(record, filter)),
    [filter, visibleRecords]
  )
  const projectGroups = useMemo(
    () => groupActivityRecordsByProject(filteredRecords, displayRecords),
    [displayRecords, filteredRecords]
  )
  const timelineBounds = useMemo(() => {
    const timestamps = filteredRecords.map((record) => record.createdAt)
    return {
      start: Math.min(...timestamps),
      end: Math.max(...timestamps)
    }
  }, [filteredRecords])
  const timelineNodePositions = useMemo(() => {
    const chronologicalRecords = [...filteredRecords].sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    )
    return new Map(
      chronologicalRecords.map((record, index) => [
        record.id,
        chronologicalRecords.length === 1
          ? 50
          : 5 + (index / (chronologicalRecords.length - 1)) * 90
      ])
    )
  }, [filteredRecords])
  const selectedTimelineRecord = filteredRecords.find(
    (record) => record.id === selectedTimelineRecordId
  )
  const conversationTitles = useMemo(
    () => getConversationTitles(displayRecords),
    [displayRecords]
  )
  const activeCount = visibleRecords.filter(isActive).length
  const failedCount = visibleRecords.filter(isFailed).length
  const filters: ReadonlyArray<{
    value: ActivityFilter
    label: string
  }> = [
    {
      value: 'all',
      label: t('filters.all', {
        count: visibleRecords.length,
        formattedCount: formatCount(visibleRecords.length)
      })
    },
    {
      value: 'active',
      label: t('filters.active', {
        count: activeCount,
        formattedCount: formatCount(activeCount)
      })
    },
    {
      value: 'failed',
      label: t('filters.failed', {
        count: failedCount,
        formattedCount: formatCount(failedCount)
      })
    }
  ]
  const tokenTotals = useMemo(
    () => getTokenUsageTotals(tokenUsage),
    [tokenUsage]
  )
  const tokenRows = useMemo(
    () => groupTokenUsage(displayTokenUsage, tokenGroup),
    [displayTokenUsage, tokenGroup]
  )
  const tokenGroupLabel =
    tokenGroups.find((item) => item.value === tokenGroup)?.columnLabel ??
    t('tokenUsage.columns.project')
  const emptyDescription =
    filter === 'active'
      ? t('empty.active')
      : filter === 'failed'
        ? t('empty.failed')
        : t('empty.all')
  const timelineStart = formatTime(
    timelineBounds.start,
    dateTimeFormatter,
    t('records.unknownTime')
  )
  const timelineEnd = formatTime(
    timelineBounds.end,
    dateTimeFormatter,
    t('records.unknownTime')
  )
  const getActivityActor = (
    record: ActivityRecord
  ): {
    kind: ActivityActorKind
    name: string
    abbreviation: string
  } => {
    if (record.kind === 'request') {
      return {
        kind: 'user',
        name: t('timeline.actors.user'),
        abbreviation: t('timeline.nodes.user')
      }
    }
    if (record.kind === 'result') {
      return {
        kind: 'assistant',
        name: t('timeline.actors.assistant'),
        abbreviation: t('timeline.nodes.assistant')
      }
    }
    if (record.kind === 'subagent') {
      return {
        kind: 'subagent',
        name: record.title,
        abbreviation: t('timeline.nodes.subagent')
      }
    }
    if (record.kind === 'tool') {
      return {
        kind: 'tool',
        name: record.title,
        abbreviation: t('timeline.nodes.tool')
      }
    }
    return {
      kind: 'approval',
      name: t('timeline.actors.approval'),
      abbreviation: t('timeline.nodes.approval')
    }
  }
  const timelineLegend: ReadonlyArray<{
    kind: ActivityActorKind
    label: string
  }> = [
    { kind: 'user', label: t('timeline.actors.user') },
    { kind: 'assistant', label: t('timeline.actors.assistant') },
    { kind: 'subagent', label: t('timeline.actors.subagent') },
    { kind: 'tool', label: t('timeline.actors.tool') },
    { kind: 'approval', label: t('timeline.actors.approval') }
  ]
  const localizeTokenRow = (
    row: (typeof tokenRows)[number]
  ): { label: string; detail?: string } => {
    const modelLabel =
      row.model || t('tokenUsage.fallbacks.unknownModel')
    const runtimeLabel =
      row.runtime === 'model'
        ? t('tokenUsage.runtimes.model')
        : row.runtime === 'opencode'
          ? t('tokenUsage.runtimes.opencode')
          : row.runtime === 'continue'
            ? t('tokenUsage.runtimes.continue')
            : row.runtime === 'deepseek-harness'
              ? t('tokenUsage.runtimes.deepseekHarness')
              : row.runtime || t('tokenUsage.fallbacks.unknownRuntime')
    const label =
      tokenGroup === 'project' &&
      row.key.startsWith('project:unassigned:')
        ? t('tokenUsage.fallbacks.unassignedProject')
        : tokenGroup === 'conversation' &&
            row.key.startsWith('conversation:deleted:')
          ? t('tokenUsage.fallbacks.deletedConversation')
          : tokenGroup === 'model'
            ? `${runtimeLabel} · ${modelLabel}`
            : row.label
    const detail =
      tokenGroup === 'model'
        ? undefined
        : `${runtimeLabel} · ${modelLabel}`
    return { label, detail }
  }
  const renderRecordCard = (
    record: ActivityRecord,
    showContext: boolean
  ): React.JSX.Element => {
    const time = formatTime(
      record.createdAt,
      dateTimeFormatter,
      t('records.unknownTime')
    )
    const conversationTitle =
      conversationTitles.get(record.conversationId) ?? record.title
    return (
      <article
        className={`activity-item activity-item--${record.status}`}
      >
        <header className="activity-item__header">
          <div className="activity-item__labels">
            <span className="activity-item__kind">
              {kindLabels[record.kind]}
            </span>
            <span
              className={`status-badge activity-item__status activity-item__status--${record.status}`}
            >
              {statusLabels[record.status]}
            </span>
          </div>
          <time dateTime={time.machineReadable}>{time.display}</time>
        </header>
        <h3>{record.title}</h3>
        {record.detail.length > 0 && <p>{record.detail}</p>}
        {showContext && (
          <div className="activity-item__context">
            <span>
              {t('records.conversation', {
                title: conversationTitle
              })}
            </span>
            <ScopeBadge
              scope={activityWorkspaceScope(
                record.scope,
                t('records.unavailableScope')
              )}
            />
          </div>
        )}
        <button
          className="activity-item__conversation"
          onClick={() => onOpenConversation(record.conversationId)}
          type="button"
        >
          {t('records.openConversation')}
        </button>
      </article>
    )
  }
  const recordToolbar = (
    <div className="activity-panel__toolbar">
      <SegmentedControl
        ariaLabel={t('filters.ariaLabel')}
        onChange={setFilter}
        options={filters}
        value={filter}
      />
      <DestructiveConfirmActions
        confirmAriaLabel={t('clear.confirmAriaLabel', {
          count: visibleRecords.length,
          formattedCount: formatCount(visibleRecords.length)
        })}
        confirmLabel={t('clear.confirmLabel', {
          count: visibleRecords.length,
          formattedCount: formatCount(visibleRecords.length)
        })}
        confirming={confirmingClear}
        disabled={!confirmingClear && visibleRecords.length === 0}
        icon={<Trash2 aria-hidden="true" size={15} />}
        message={t('clear.message', {
          count: visibleRecords.length,
          formattedCount: formatCount(visibleRecords.length)
        })}
        onCancel={() => setConfirmingClear(false)}
        onConfirm={() => {
          onClear()
          setConfirmingClear(false)
        }}
        onRequestConfirm={() => setConfirmingClear(true)}
        triggerLabel={t('clear.triggerLabel')}
      />
    </div>
  )
  const emptyState = (
    <EmptyState
      action={
        filter === 'all' ? undefined : (
          <button
            className="secondary-button"
            onClick={() => setFilter('all')}
            type="button"
          >
            {t('filters.clear')}
          </button>
        )
      }
      description={emptyDescription}
      icon={<Activity size={24} />}
      level="section"
      title={
        filter === 'all'
          ? t('empty.noRecordsTitle')
          : t('empty.noMatchesTitle')
      }
    />
  )

  return (
    <section
      aria-labelledby="activity-panel-title"
      className="activity-panel"
    >
      <PageHeader
        headingId="activity-panel-title"
        icon={<Activity size={20} />}
        scope={{ kind: 'all-projects' }}
        title={t('header.title')}
      />

      <PageTabs
        ariaLabel={t('tabs.ariaLabel')}
        idPrefix="activity-view"
        onChange={(view) => {
          setActiveView(view)
          setConfirmingClear(false)
        }}
        tabs={views}
        value={activeView}
      />

      {activeView === 'tasks' && (
        <div
          aria-labelledby="activity-view-tab-tasks"
          className="activity-panel__tab-panel"
          id="activity-view-panel-tasks"
          role="tabpanel"
          tabIndex={0}
        >
          {recordToolbar}
          {filteredRecords.length === 0 ? (
            emptyState
          ) : (
            <div className="activity-projects">
              {projectGroups.map((project) => (
                <section
                  className="activity-project"
                  key={project.key}
                >
                  <header className="activity-project__header">
                    <ScopeBadge
                      scope={activityWorkspaceScope(
                        project.scope,
                        t('records.unavailableScope')
                      )}
                    />
                    <span>
                      {t('records.projectSummary', {
                        conversationCount: formatCount(
                          project.conversations.length
                        ),
                        activityCount: formatCount(
                          project.activityCount
                        )
                      })}
                    </span>
                  </header>
                  <div className="activity-conversations">
                    {project.conversations.map((conversation) => {
                      const groupTime = formatTime(
                        conversation.latestAt,
                        dateTimeFormatter,
                        t('records.unknownTime')
                      )
                      return (
                        <details
                          className="activity-group"
                          key={conversation.conversationId}
                        >
                          <summary>
                            <span>
                              <strong>
                                {t('records.conversation', {
                                  title: conversation.title
                                })}
                              </strong>
                              <small>
                                {t('records.activityCount', {
                                  count: conversation.records.length,
                                  formattedCount: formatCount(
                                    conversation.records.length
                                  )
                                })}
                              </small>
                            </span>
                            <span
                              className={`status-badge activity-item__status activity-item__status--${conversation.status}`}
                            >
                              {statusLabels[conversation.status]}
                            </span>
                            <time dateTime={groupTime.machineReadable}>
                              {groupTime.display}
                            </time>
                          </summary>
                          <ol className="activity-list">
                            {conversation.records.map((record, index) => (
                              <li
                                className={`activity-list__item activity-item--${record.status}`}
                                key={`${record.id}-${index}`}
                              >
                                {renderRecordCard(record, false)}
                              </li>
                            ))}
                          </ol>
                        </details>
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      )}

      {activeView === 'timeline' && (
        <div
          aria-labelledby="activity-view-tab-timeline"
          className="activity-panel__tab-panel"
          id="activity-view-panel-timeline"
          role="tabpanel"
          tabIndex={0}
        >
          {recordToolbar}
          {filteredRecords.length === 0 ? (
            emptyState
          ) : (
            <div
              aria-label={t('timeline.ariaLabel')}
              className="activity-tracks"
            >
              <ul
                aria-label={t('timeline.legendAriaLabel')}
                className="activity-tracks__legend"
              >
                {timelineLegend.map((item) => (
                  <li key={item.kind}>
                    <span
                      aria-hidden="true"
                      className={`activity-tracks__legend-swatch activity-tracks__legend-swatch--${item.kind}`}
                    />
                    {item.label}
                  </li>
                ))}
              </ul>
              <div className="activity-tracks__scroll">
                <div
                  className="activity-tracks__canvas"
                  style={{
                    minWidth: `${Math.max(
                      760,
                      filteredRecords.length * 64 + 210
                    )}px`
                  }}
                >
                  <div
                    aria-hidden="true"
                    className="activity-tracks__axis"
                  >
                    <strong>{t('timeline.lanes')}</strong>
                    <span>{timelineStart.display}</span>
                    <span>{timelineEnd.display}</span>
                  </div>
                  {projectGroups.map((project) => (
                    <section
                      className="activity-tracks__project"
                      key={project.key}
                    >
                      <header>
                        <ScopeBadge
                          scope={activityWorkspaceScope(
                            project.scope,
                            t('records.unavailableScope')
                          )}
                        />
                        <span>
                          {t('records.projectSummary', {
                            conversationCount: formatCount(
                              project.conversations.length
                            ),
                            activityCount: formatCount(
                              project.activityCount
                            )
                          })}
                        </span>
                      </header>
                      {project.conversations.map((conversation) => (
                        <div
                          aria-label={t('timeline.laneAriaLabel', {
                            title: conversation.title
                          })}
                          className="activity-track"
                          key={conversation.conversationId}
                          role="group"
                        >
                          <div className="activity-track__label">
                            <strong title={conversation.title}>
                              {conversation.title}
                            </strong>
                            <span>
                              <span
                                className={`status-badge activity-item__status activity-item__status--${conversation.status}`}
                              >
                                {statusLabels[conversation.status]}
                              </span>
                              {t('records.activityCount', {
                                count: conversation.records.length,
                                formattedCount: formatCount(
                                  conversation.records.length
                                )
                              })}
                            </span>
                          </div>
                          <div className="activity-track__rail">
                            {conversation.records.map((record, index) => {
                              const nodeTime = formatTime(
                                record.createdAt,
                                dateTimeFormatter,
                                t('records.unknownTime')
                              )
                              const selected =
                                selectedTimelineRecord?.id === record.id
                              const actor = getActivityActor(record)
                              return (
                                <button
                                  aria-label={t(
                                    'timeline.nodeAriaLabel',
                                    {
                                      kind: kindLabels[record.kind],
                                      actor: actor.name,
                                      status:
                                        statusLabels[record.status],
                                      title: record.title,
                                      time: nodeTime.display
                                    }
                                  )}
                                  aria-pressed={selected}
                                  className={`activity-track__node activity-track__node--actor-${actor.kind} activity-track__node--${record.status}`}
                                  key={`${record.id}-${index}`}
                                  onClick={() =>
                                    setSelectedTimelineRecordId(
                                      selected ? undefined : record.id
                                    )
                                  }
                                  style={{
                                    left: `${
                                      timelineNodePositions.get(
                                        record.id
                                      ) ?? 50
                                    }%`
                                  }}
                                  title={`${actor.name} · ${kindLabels[record.kind]} · ${record.title} · ${nodeTime.display}`}
                                  type="button"
                                >
                                  <span>{actor.abbreviation}</span>
                                  <small>{actor.name}</small>
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      ))}
                    </section>
                  ))}
                </div>
              </div>
              {selectedTimelineRecord && (
                <aside
                  aria-label={t('timeline.detailAriaLabel')}
                  className="activity-tracks__detail"
                >
                  <button
                    className="secondary-button"
                    onClick={() =>
                      setSelectedTimelineRecordId(undefined)
                    }
                    type="button"
                  >
                    {t('timeline.closeDetail')}
                  </button>
                  {renderRecordCard(selectedTimelineRecord, true)}
                </aside>
              )}
            </div>
          )}
        </div>
      )}

      {activeView === 'usage' && (
        <div
          aria-labelledby="activity-view-tab-usage"
          className="activity-panel__tab-panel"
          id="activity-view-panel-usage"
          role="tabpanel"
          tabIndex={0}
        >
          <section
            aria-labelledby="token-usage-title"
            className="token-usage"
          >
            <header className="token-usage__header">
              <h2 id="token-usage-title">{t('tokenUsage.title')}</h2>
              <SegmentedControl
                ariaLabel={t('tokenUsage.groupAriaLabel')}
                onChange={setTokenGroup}
                options={tokenGroups}
                value={tokenGroup}
              />
            </header>

            <dl
              aria-label={t('tokenUsage.statsAriaLabel')}
              className="token-usage__stats"
            >
              <div>
                <dt>{t('tokenUsage.columns.input')}</dt>
                <dd>
                  {tokenCountFormatter.format(tokenTotals.inputTokens)}
                </dd>
              </div>
              <div>
                <dt>{t('tokenUsage.columns.output')}</dt>
                <dd>
                  {tokenCountFormatter.format(tokenTotals.outputTokens)}
                </dd>
              </div>
              <div>
                <dt>{t('tokenUsage.columns.cacheWrite')}</dt>
                <dd>
                  {tokenCountFormatter.format(
                    tokenTotals.cacheWriteTokens
                  )}
                </dd>
              </div>
              <div>
                <dt>{t('tokenUsage.columns.cacheRead')}</dt>
                <dd>
                  {tokenCountFormatter.format(
                    tokenTotals.cacheReadTokens
                  )}
                </dd>
              </div>
              <div>
                <dt>{t('tokenUsage.columns.cacheHitRate')}</dt>
                <dd>
                  {formatCacheHitRate(tokenTotals.cacheHitRate)}
                </dd>
              </div>
              <div>
                <dt>{t('tokenUsage.columns.total')}</dt>
                <dd>
                  {tokenCountFormatter.format(tokenTotals.totalTokens)}
                </dd>
              </div>
            </dl>

            <div className="token-usage__table-scroll">
              <table
                aria-label={t('tokenUsage.detailAriaLabel', {
                  group: tokenGroupLabel
                })}
              >
                <thead>
                  <tr>
                    <th scope="col">{tokenGroupLabel}</th>
                    <th scope="col">{t('tokenUsage.columns.input')}</th>
                    <th scope="col">{t('tokenUsage.columns.output')}</th>
                    <th scope="col">
                      {t('tokenUsage.columns.cacheWrite')}
                    </th>
                    <th scope="col">
                      {t('tokenUsage.columns.cacheRead')}
                    </th>
                    <th scope="col">
                      {t('tokenUsage.columns.cacheHitRate')}
                    </th>
                    <th scope="col">
                      {t('tokenUsage.columns.total')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tokenRows.length === 0 ? (
                    <tr>
                      <td className="token-usage__empty" colSpan={7}>
                        {t('tokenUsage.empty')}
                      </td>
                    </tr>
                  ) : (
                    tokenRows.map((row) => {
                      const localizedRow = localizeTokenRow(row)
                      return (
                        <tr key={row.key}>
                          <th scope="row">
                            <span>{localizedRow.label}</span>
                            {localizedRow.detail && (
                              <small>{localizedRow.detail}</small>
                            )}
                          </th>
                          <td>
                            {tokenCountFormatter.format(
                              row.inputTokens
                            )}
                          </td>
                          <td>
                            {tokenCountFormatter.format(
                              row.outputTokens
                            )}
                          </td>
                          <td>
                            {tokenCountFormatter.format(
                              row.cacheWriteTokens
                            )}
                          </td>
                          <td>
                            {tokenCountFormatter.format(
                              row.cacheReadTokens
                            )}
                          </td>
                          <td>
                            {formatCacheHitRate(row.cacheHitRate)}
                          </td>
                          <td>
                            {tokenCountFormatter.format(
                              row.totalTokens
                            )}
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </section>
  )
}
