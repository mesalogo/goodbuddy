import { Activity, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  MAX_ACTIVITY_RECORDS,
  type ActivityRecord
} from './activity-store'

type ActivityFilter = 'all' | 'active' | 'failed'

export type ActivityPanelProps = {
  records: readonly ActivityRecord[]
  onClear: () => void
  onOpenConversation: (conversationId: string) => void
}

const statusLabels: Record<ActivityRecord['status'], string> = {
  pending: '等待中',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  denied: '已拒绝'
}

const kindLabels: Record<ActivityRecord['kind'], string> = {
  request: '任务',
  tool: '工具',
  approval: '审批',
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

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})

function isActive(record: ActivityRecord): boolean {
  return record.status === 'pending' || record.status === 'running'
}

function isFailed(record: ActivityRecord): boolean {
  return record.status === 'failed' || record.status === 'denied'
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
    return '当前没有失败或被拒绝的活动。'
  }
  return '尚无活动记录。任务请求、工具调用和审批决定会显示在这里。'
}

export function ActivityPanel({
  records,
  onClear,
  onOpenConversation
}: ActivityPanelProps): React.JSX.Element {
  const [filter, setFilter] = useState<ActivityFilter>('all')

  const visibleRecords = useMemo(
    () => records.slice(0, MAX_ACTIVITY_RECORDS),
    [records]
  )
  const filteredRecords = useMemo(
    () => visibleRecords.filter((record) => matchesFilter(record, filter)),
    [filter, visibleRecords]
  )
  const activeCount = visibleRecords.filter(isActive).length
  const failedCount = visibleRecords.filter(isFailed).length

  return (
    <section
      aria-labelledby="activity-panel-title"
      className="activity-panel"
    >
      <header className="activity-panel__header">
        <div>
          <p className="eyebrow">ACTIVITY AUDIT</p>
          <h2 id="activity-panel-title">
            <Activity aria-hidden="true" size={20} />
            活动中心
          </h2>
        </div>
        <button
          className="secondary-button activity-panel__clear"
          disabled={visibleRecords.length === 0}
          onClick={onClear}
          type="button"
        >
          <Trash2 aria-hidden="true" size={15} />
          清空记录
        </button>
      </header>

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

      <div
        aria-label="筛选活动"
        className="activity-panel__filters"
        role="group"
      >
        {filters.map((item) => (
          <button
            aria-pressed={filter === item.value}
            className={
              filter === item.value
                ? 'activity-filter activity-filter--active'
                : 'activity-filter'
            }
            key={item.value}
            onClick={() => setFilter(item.value)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>

      {filteredRecords.length === 0 ? (
        <div className="activity-panel__empty">
          <Activity aria-hidden="true" size={24} />
          <p>{emptyMessage(filter)}</p>
        </div>
      ) : (
        <ol className="activity-list">
          {filteredRecords.map((record, index) => {
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
                        className={`activity-item__status activity-item__status--${record.status}`}
                      >
                        {statusLabels[record.status]}
                      </span>
                    </div>
                    <time dateTime={time.machineReadable}>
                      {time.display}
                    </time>
                  </header>
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
      )}
    </section>
  )
}
