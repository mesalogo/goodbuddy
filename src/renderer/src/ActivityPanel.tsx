import { Activity, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
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

const statusLabels: Record<ActivityRecord['status'], string> = {
  pending: '等待中',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  denied: '已拒绝',
  cancelled: '已取消',
  interrupted: '已中断'
}

const kindLabels: Record<ActivityRecord['kind'], string> = {
  request: '任务',
  tool: '工具',
  approval: '审批',
  subagent: '子专家',
  result: '结果'
}

const filters: ReadonlyArray<{
  value: ActivityFilter
  label: string
}> = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '进行中' },
  { value: 'failed', label: '失败' }
]

const tokenGroups: ReadonlyArray<{
  value: TokenUsageGroup
  label: string
  columnLabel: string
}> = [
  { value: 'project', label: '按项目', columnLabel: '项目' },
  {
    value: 'conversation',
    label: '按会话',
    columnLabel: '会话'
  },
  { value: 'model', label: '按模型', columnLabel: '模型' }
]

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})

const tokenCountFormatter = new Intl.NumberFormat('zh-CN')

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

function formatTime(createdAt: number): {
  display: string
  machineReadable?: string
} {
  if (!Number.isFinite(createdAt) || createdAt < 0) {
    return { display: '时间未知' }
  }

  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) {
    return { display: '时间未知' }
  }

  return {
    display: dateTimeFormatter.format(date),
    machineReadable: date.toISOString()
  }
}

function emptyMessage(filter: ActivityFilter): string {
  if (filter === 'active') {
    return '当前没有等待中或正在运行的活动。'
  }
  if (filter === 'failed') {
    return '当前没有失败、取消或中断的活动。'
  }
  return '任务请求、子专家、工具调用和审批决定会显示在这里。'
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
  scope: ActivityRecord['scope']
): WorkspaceScope {
  if (scope.kind === 'project') {
    return { kind: 'project', projectName: scope.projectName }
  }
  if (scope.kind === 'global') {
    return { kind: 'global' }
  }
  return {
    kind: 'unavailable',
    explanation: '创建此活动记录时未能确定其归属范围。'
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
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [tokenGroup, setTokenGroup] =
    useState<TokenUsageGroup>('project')
  const [confirmingClear, setConfirmingClear] = useState(false)

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
    '项目'

  return (
    <section
      aria-labelledby="activity-panel-title"
      className="activity-panel"
    >
      <PageHeader
        actions={
          <DestructiveConfirmActions
            confirmAriaLabel={`确认清空 ${visibleRecords.length} 条活动记录`}
            confirmLabel={`清空 ${visibleRecords.length} 条记录`}
            confirming={confirmingClear}
            disabled={!confirmingClear && visibleRecords.length === 0}
            icon={<Trash2 aria-hidden="true" size={15} />}
            message={`永久清空 ${visibleRecords.length} 条活动记录？此操作不可撤销。`}
            onCancel={() => setConfirmingClear(false)}
            onConfirm={() => {
              onClear()
              setConfirmingClear(false)
            }}
            onRequestConfirm={() => setConfirmingClear(true)}
            triggerLabel="清空记录"
          />
        }
        description="查看全部项目中的任务请求、子专家、工具调用、审批结果和 Token 用量。"
        eyebrow="ACTIVITY AUDIT"
        headingId="activity-panel-title"
        icon={<Activity size={20} />}
        scope={{ kind: 'all-projects' }}
        title="任务与活动"
      />

      <section
        aria-labelledby="token-usage-title"
        className="token-usage"
      >
        <header className="token-usage__header">
          <h3 id="token-usage-title">Token 用量</h3>
          <SegmentedControl
            ariaLabel="Token 用量分组"
            onChange={setTokenGroup}
            options={tokenGroups}
            value={tokenGroup}
          />
        </header>

        <dl aria-label="Token 用量统计" className="token-usage__stats">
          <div>
            <dt>输入</dt>
            <dd>{tokenCountFormatter.format(tokenTotals.inputTokens)}</dd>
          </div>
          <div>
            <dt>输出</dt>
            <dd>{tokenCountFormatter.format(tokenTotals.outputTokens)}</dd>
          </div>
          <div>
            <dt>缓存写入</dt>
            <dd>
              {tokenCountFormatter.format(tokenTotals.cacheWriteTokens)}
            </dd>
          </div>
          <div>
            <dt>缓存读取</dt>
            <dd>
              {tokenCountFormatter.format(tokenTotals.cacheReadTokens)}
            </dd>
          </div>
          <div>
            <dt>总计</dt>
            <dd>{tokenCountFormatter.format(tokenTotals.totalTokens)}</dd>
          </div>
        </dl>

        <div className="token-usage__table-scroll">
          <table aria-label={`Token 用量${tokenGroupLabel}明细`}>
            <thead>
              <tr>
                <th scope="col">{tokenGroupLabel}</th>
                <th scope="col">输入</th>
                <th scope="col">输出</th>
                <th scope="col">缓存写入</th>
                <th scope="col">缓存读取</th>
                <th scope="col">总计</th>
              </tr>
            </thead>
            <tbody>
              {tokenRows.length === 0 ? (
                <tr>
                  <td className="token-usage__empty" colSpan={6}>
                    暂无 Token 用量
                  </td>
                </tr>
              ) : (
                tokenRows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row">
                      <span>{row.label}</span>
                      {row.detail && <small>{row.detail}</small>}
                    </th>
                    <td>
                      {tokenCountFormatter.format(row.inputTokens)}
                    </td>
                    <td>
                      {tokenCountFormatter.format(row.outputTokens)}
                    </td>
                    <td>
                      {tokenCountFormatter.format(row.cacheWriteTokens)}
                    </td>
                    <td>
                      {tokenCountFormatter.format(row.cacheReadTokens)}
                    </td>
                    <td>
                      {tokenCountFormatter.format(row.totalTokens)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <dl aria-label="活动统计" className="activity-panel__stats">
        <div>
          <dt>全部</dt>
          <dd>{visibleRecords.length}</dd>
        </div>
        <div>
          <dt>进行中</dt>
          <dd>{activeCount}</dd>
        </div>
        <div>
          <dt>失败</dt>
          <dd>{failedCount}</dd>
        </div>
      </dl>

      <div className="activity-panel__filters">
        <SegmentedControl
          ariaLabel="筛选活动"
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
                清除筛选
              </button>
            )
          }
          description={emptyMessage(filter)}
          icon={<Activity size={24} />}
          level="section"
          title={filter === 'all' ? '尚无活动记录' : '没有匹配的活动'}
        />
      ) : (
        <div className="activity-groups">
          {activityGroups.map((group) => {
            const groupTime = formatTime(group.latestAt)
            return (
              <details
                className="activity-group"
                key={group.conversationId}
              >
                <summary>
                  <span>
                    <strong>对话：{group.title}</strong>
                    <small>{group.records.length} 条活动</small>
                    <ScopeBadge
                      scope={activityWorkspaceScope(group.scope)}
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
                    const time = formatTime(record.createdAt)
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
                            scope={activityWorkspaceScope(record.scope)}
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
                            打开所属对话
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
