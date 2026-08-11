import { Activity, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TokenUsageSummary } from '../../shared/assistant-contracts'
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
  ScopeBadge,
  SegmentedControl,
  type WorkspaceScope
} from './WorkspacePrimitives'

type ActivityFilter = 'all' | 'active' | 'failed'

export type ActivityPanelProps = {
  records: readonly ActivityRecord[]
  tokenUsage: TokenUsageSummary
  onClear: () => void
  onOpenConversation: (conversationId: string) => void
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

type ActivityGroup = {
  conversationId: string
  title: string
  records: ActivityRecord[]
  scope: ActivityRecord['scope']
  latestAt: number
  status: ActivityRecord['status']
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

function groupActivityRecords(
  records: readonly ActivityRecord[],
  allRecords: readonly ActivityRecord[]
): ActivityGroup[] {
  const conversationTitles = new Map<string, string>()
  for (const record of allRecords) {
    if (
      record.kind === 'request' &&
      !conversationTitles.has(record.conversationId)
    ) {
      conversationTitles.set(record.conversationId, record.title)
    }
  }
  const groups = new Map<string, ActivityRecord[]>()
  for (const record of records) {
    const current = groups.get(record.conversationId) ?? []
    current.push(record)
    groups.set(record.conversationId, current)
  }
  return [...groups.entries()].map(([conversationId, items]) => {
    const request = items.find((record) => record.kind === 'request')
    const activeRecord = items.find(isActive)
    const failedRecord = items.find(isFailed)
    const status = activeRecord?.status ?? failedRecord?.status ?? 'completed'
    return {
      conversationId,
      title:
        conversationTitles.get(conversationId) ??
        request?.title ??
        items[0]!.title,
      records: items,
      scope: items[0]!.scope,
      latestAt: Math.max(...items.map((record) => record.createdAt)),
      status
    }
  })
}

export function ActivityPanel({
  records,
  tokenUsage,
  onClear,
  onOpenConversation
}: ActivityPanelProps): React.JSX.Element {
  const { t, i18n } = useTranslation('activity')
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [tokenGroup, setTokenGroup] =
    useState<TokenUsageGroup>('project')
  const [confirmingClear, setConfirmingClear] = useState(false)
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
  const filters: ReadonlyArray<{
    value: ActivityFilter
    label: string
  }> = [
    { value: 'all', label: t('filters.all') },
    { value: 'active', label: t('filters.active') },
    { value: 'failed', label: t('filters.failed') }
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

  const visibleRecords = useMemo(
    () => records.slice(0, MAX_ACTIVITY_RECORDS),
    [records]
  )
  const filteredRecords = useMemo(
    () => visibleRecords.filter((record) => matchesFilter(record, filter)),
    [filter, visibleRecords]
  )
  const activityGroups = useMemo(
    () => groupActivityRecords(filteredRecords, records),
    [filteredRecords, records]
  )
  const activeCount = visibleRecords.filter(isActive).length
  const failedCount = visibleRecords.filter(isFailed).length
  const tokenTotals = useMemo(
    () => getTokenUsageTotals(tokenUsage),
    [tokenUsage]
  )
  const tokenRows = useMemo(
    () => groupTokenUsage(tokenUsage, tokenGroup),
    [tokenGroup, tokenUsage]
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
  const localizeTokenRow = (
    row: (typeof tokenRows)[number]
  ): { label: string; detail?: string } => {
    const missingModel = row.key.endsWith(':')
    const modelProvider =
      row.key.match(/model:([^:]*):$/u)?.[1] ?? ''
    const label =
      tokenGroup === 'project' &&
      row.key.startsWith('project:unassigned:')
        ? t('tokenUsage.fallbacks.unassignedProject')
        : tokenGroup === 'conversation' &&
            row.key.startsWith('conversation:deleted:')
          ? t('tokenUsage.fallbacks.deletedConversation')
          : tokenGroup === 'model' && missingModel
            ? t('tokenUsage.fallbacks.unknownModel')
            : row.label
    const detail =
      missingModel && tokenGroup !== 'model'
        ? [
            t('tokenUsage.fallbacks.unknownModel'),
            modelProvider
          ]
            .filter(Boolean)
            .join(' · ')
        : row.detail
    return { label, detail }
  }

  return (
    <section
      aria-labelledby="activity-panel-title"
      className="activity-panel"
    >
      <PageHeader
        actions={
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
        }
        description={t('header.description')}
        eyebrow={t('header.eyebrow')}
        headingId="activity-panel-title"
        icon={<Activity size={20} />}
        scope={{ kind: 'all-projects' }}
        title={t('header.title')}
      />

      <section
        aria-labelledby="token-usage-title"
        className="token-usage"
      >
        <header className="token-usage__header">
          <h3 id="token-usage-title">{t('tokenUsage.title')}</h3>
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
            <dd>{tokenCountFormatter.format(tokenTotals.inputTokens)}</dd>
          </div>
          <div>
            <dt>{t('tokenUsage.columns.output')}</dt>
            <dd>{tokenCountFormatter.format(tokenTotals.outputTokens)}</dd>
          </div>
          <div>
            <dt>{t('tokenUsage.columns.cacheWrite')}</dt>
            <dd>
              {tokenCountFormatter.format(tokenTotals.cacheWriteTokens)}
            </dd>
          </div>
          <div>
            <dt>{t('tokenUsage.columns.cacheRead')}</dt>
            <dd>
              {tokenCountFormatter.format(tokenTotals.cacheReadTokens)}
            </dd>
          </div>
          <div>
            <dt>{t('tokenUsage.columns.total')}</dt>
            <dd>{tokenCountFormatter.format(tokenTotals.totalTokens)}</dd>
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
                <th scope="col">{t('tokenUsage.columns.total')}</th>
              </tr>
            </thead>
            <tbody>
              {tokenRows.length === 0 ? (
                <tr>
                  <td className="token-usage__empty" colSpan={6}>
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
                        {tokenCountFormatter.format(row.inputTokens)}
                      </td>
                      <td>
                        {tokenCountFormatter.format(row.outputTokens)}
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
                        {tokenCountFormatter.format(row.totalTokens)}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <dl
        aria-label={t('stats.ariaLabel')}
        className="activity-panel__stats"
      >
        <div>
          <dt>{t('stats.all')}</dt>
          <dd>{formatCount(visibleRecords.length)}</dd>
        </div>
        <div>
          <dt>{t('stats.active')}</dt>
          <dd>{formatCount(activeCount)}</dd>
        </div>
        <div>
          <dt>{t('stats.failed')}</dt>
          <dd>{formatCount(failedCount)}</dd>
        </div>
      </dl>

      <div className="activity-panel__filters">
        <SegmentedControl
          ariaLabel={t('filters.ariaLabel')}
          onChange={setFilter}
          options={filters}
          value={filter}
        />
      </div>

      {filteredRecords.length === 0 ? (
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
      ) : (
        <div className="activity-groups">
          {activityGroups.map((group) => {
            const groupTime = formatTime(
              group.latestAt,
              dateTimeFormatter,
              t('records.unknownTime')
            )
            return (
              <details
                className="activity-group"
                key={group.conversationId}
              >
                <summary>
                  <span>
                    <strong>
                      {t('records.conversation', {
                        title: group.title
                      })}
                    </strong>
                    <small>
                      {t('records.activityCount', {
                        count: group.records.length,
                        formattedCount: formatCount(
                          group.records.length
                        )
                      })}
                    </small>
                    <ScopeBadge
                      scope={activityWorkspaceScope(
                        group.scope,
                        t('records.unavailableScope')
                      )}
                    />
                  </span>
                  <span
                    className={`status-badge activity-item__status activity-item__status--${group.status}`}
                  >
                    {statusLabels[group.status]}
                  </span>
                  <time dateTime={groupTime.machineReadable}>
                    {groupTime.display}
                  </time>
                </summary>
                <ol className="activity-list">
                  {group.records.map((record, index) => {
                    const time = formatTime(
                      record.createdAt,
                      dateTimeFormatter,
                      t('records.unknownTime')
                    )
                    return (
                      <li
                        className={`activity-item activity-item--${record.status}`}
                        key={`${record.id}-${index}`}
                      >
                        <article>
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
                            <time dateTime={time.machineReadable}>
                              {time.display}
                            </time>
                          </header>
                          <ScopeBadge
                            scope={activityWorkspaceScope(
                              record.scope,
                              t('records.unavailableScope')
                            )}
                          />
                          <h3>{record.title}</h3>
                          {record.detail.length > 0 && <p>{record.detail}</p>}
                          <button
                            className="activity-item__conversation"
                            onClick={() =>
                              onOpenConversation(record.conversationId)
                            }
                            type="button"
                          >
                            {t('records.openConversation')}
                          </button>
                        </article>
                      </li>
                    )
                  })}
                </ol>
              </details>
            )
          })}
        </div>
      )}
    </section>
  )
}
