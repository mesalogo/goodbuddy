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
import type {
  AssistantHeartbeatConfig,
  AssistantHeartbeatEntry,
  AssistantHeartbeatRun,
  AssistantMemory,
  AssistantTask,
  HeartbeatCreateInput
} from '../../shared/assistant-contracts'
import { HeartbeatSettings } from './HeartbeatSettings'

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
  tasks: AssistantTask[]
  onCreate: (input: HeartbeatCreateInput) => Promise<void>
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
}

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
})

const weekdayLabels = [
  '周日',
  '周一',
  '周二',
  '周三',
  '周四',
  '周五',
  '周六'
]

const runStatusLabels: Record<AssistantHeartbeatRun['status'], string> = {
  claimed: '运行中',
  completed: '已完成',
  failed: '失败',
  skipped: '已跳过'
}

const taskStatusLabels: Record<AssistantTask['status'], string> = {
  queued: '等待中',
  running: '运行中',
  waiting_approval: '等待审批',
  paused: '待处理',
  completed: '已完成',
  failed: '失败',
  cancelled: '已忽略',
  interrupted: '已中断'
}

const memoryTypeLabels: Record<AssistantMemory['type'], string> = {
  preference: '偏好',
  fact: '事实',
  summary: '总结',
  procedure: '流程'
}

function formatDateTime(value?: string): string {
  if (!value) {
    return '暂无'
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '时间未知'
    : dateTimeFormatter.format(date)
}

function recurrenceLabel(config: AssistantHeartbeatConfig): string {
  if (config.recurrence.type === 'weekly') {
    return `${weekdayLabels[config.recurrence.weekday]} ${config.recurrence.localTime}`
  }
  return `每天 ${config.recurrence.localTime}`
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
  tasks,
  onCreate,
  onSetPaused,
  onRemove,
  onRunNow,
  onRefresh,
  onSetMemoryStatus,
  onSetTaskStatus,
  onUseFollowUpTask
}: HeartbeatCenterProps): React.JSX.Element {
  const [tab, setTab] = useState<HeartbeatCenterTab>('overview')
  const [pendingAction, setPendingAction] = useState<string>()
  const [error, setError] = useState<string>()
  const [expandedEntryId, setExpandedEntryId] = useState<string>()
  const [expandedSuggestionId, setExpandedSuggestionId] =
    useState<string>()
  const [visibleEntryCount, setVisibleEntryCount] = useState(20)
  const [visibleRunCount, setVisibleRunCount] = useState(20)

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
        reason instanceof Error ? reason.message : '智能心跳操作失败'
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
    { id: 'overview', label: '成长概览' },
    {
      id: 'suggestions',
      label: '待处理建议',
      count: attentionCount
    },
    { id: 'history', label: '心跳轨迹' },
    { id: 'plans', label: '心跳计划' }
  ]

  return (
    <section
      aria-labelledby="heartbeat-center-title"
      className="heartbeat-center"
    >
      <header className="heartbeat-center__hero">
        <div>
          <p className="eyebrow">SMART HEARTBEAT</p>
          <h2 id="heartbeat-center-title">
            <HeartPulse aria-hidden="true" size={22} />
            智能心跳
          </h2>
          <p>
            GoodBuddy 定期回顾经历、沉淀记忆、发现问题，并把每次变化转化为可处理的成长建议。
          </p>
        </div>
        <div className="heartbeat-center__hero-actions">
          <button
            aria-label="刷新智能心跳"
            className="secondary-button"
            disabled={pendingAction !== undefined}
            onClick={() => void runAction('refresh', onRefresh)}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={14} />
            刷新
          </button>
          {primaryConfig ? (
            <button
              className="primary-button"
              disabled={pendingAction !== undefined}
              onClick={() =>
                void runAction(`run:${primaryConfig.id}`, () =>
                  onRunNow(primaryConfig.id)
                )
              }
              type="button"
            >
              <Play aria-hidden="true" size={14} />
              {pendingAction === `run:${primaryConfig.id}`
                ? '心跳中…'
                : '运行一次心跳'}
            </button>
          ) : (
            <button
              className="primary-button"
              onClick={() => setTab('plans')}
              type="button"
            >
              配置智能心跳
            </button>
          )}
        </div>
      </header>

      {error && (
        <p className="heartbeat-center__error" role="alert">
          {error}
        </p>
      )}

      <nav
        aria-label="智能心跳视图"
        className="heartbeat-center__tabs"
        role="tablist"
      >
        {tabs.map((item) => (
          <button
            aria-controls={`heartbeat-panel-${item.id}`}
            aria-selected={tab === item.id}
            className={
              tab === item.id
                ? 'heartbeat-center__tab heartbeat-center__tab--active'
                : 'heartbeat-center__tab'
            }
            id={`heartbeat-tab-${item.id}`}
            key={item.id}
            onClick={() => setTab(item.id)}
            role="tab"
            type="button"
          >
            {item.label}
            {item.count ? <span>{item.count}</span> : null}
          </button>
        ))}
      </nav>

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
                <p className="eyebrow">CURRENT PULSE</p>
                <h3 id="heartbeat-status-title">当前状态</h3>
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
                  ? `${activeConfigs.length} 个计划运行中`
                  : '尚未启用'}
              </span>
            </div>
            {configs.length === 0 ? (
              <div className="heartbeat-center__empty">
                <HeartPulse aria-hidden="true" size={24} />
                <strong>尚未建立成长节奏</strong>
                <p>配置每日或每周心跳，让 GoodBuddy 持续回顾和学习。</p>
                <button
                  className="primary-button"
                  onClick={() => setTab('plans')}
                  type="button"
                >
                  创建心跳计划
                </button>
              </div>
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
                          {config.projectId ? '当前项目' : '全局'}
                        </small>
                      </div>
                    </header>
                    <dl>
                      <div>
                        <dt>下次心跳</dt>
                        <dd>{formatDateTime(config.nextRunAt)}</dd>
                      </div>
                      <div>
                        <dt>上次状态</dt>
                        <dd>
                          {config.lastStatus
                            ? runStatusLabels[config.lastStatus]
                            : '尚未运行'}
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
                        立即心跳
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
                        {config.enabled ? '暂停' : '恢复'}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <dl
            aria-label="智能心跳成长维度"
            className="heartbeat-center__metrics"
          >
            <div>
              <dt>
                <HeartPulse aria-hidden="true" size={15} />
                心跳健康
              </dt>
              <dd>{terminalRuns.length ? `${healthPercent}%` : '暂无'}</dd>
              <small>
                {completedRuns.length}/{terminalRuns.length} 次成功完成
              </small>
              <span
                aria-label={`心跳成功率 ${healthPercent}%`}
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
                记忆沉淀
              </dt>
              <dd>
                {confirmedMemories.length}/{proposedMemoryIds.size}
              </dd>
              <small>已确认记忆 / 心跳建议</small>
              <span
                aria-label={`记忆确认率 ${memoryPercent}%`}
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
                洞察发现
              </dt>
              <dd>{highlightCount}</dd>
              <small>来自 {orderedEntries.length} 份心跳报告</small>
              <span className="heartbeat-center__metric-note">
                {latestEntry
                  ? `最近一次发现 ${latestEntry.highlights.length} 条`
                  : '等待首次心跳'}
              </span>
            </div>
            <div>
              <dt>
                <ListChecks aria-hidden="true" size={15} />
                行动转化
              </dt>
              <dd>
                {completedTasks.length}/{followUpTaskIds.size}
              </dd>
              <small>已完成任务 / 心跳建议</small>
              <span
                aria-label={`建议任务完成率 ${actionPercent}%`}
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
                  <p className="eyebrow">GROWTH TREND</p>
                  <h3 id="heartbeat-trend-title">成长趋势</h3>
                </div>
              </div>
              {recentTrend.length === 0 ? (
                <p className="heartbeat-center__section-empty">
                  完成心跳后，这里会显示洞察、记忆与行动建议的变化。
                </p>
              ) : (
                <>
                  <div className="heartbeat-center__legend">
                    <span className="heartbeat-center__legend--insight">
                      洞察
                    </span>
                    <span className="heartbeat-center__legend--memory">
                      记忆
                    </span>
                    <span className="heartbeat-center__legend--task">
                      行动
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
                          aria-label={`${formatDateTime(entry.createdAt)}：${entry.highlights.length} 条洞察，${entry.proposedMemoryIds.length} 条记忆建议，${entry.followUpTaskIds.length} 个行动建议`}
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
                          <small>{total}</small>
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
                  <p className="eyebrow">LATEST REPORT</p>
                  <h3 id="latest-heartbeat-title">本次心跳</h3>
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
                      查看心跳轨迹
                      <ChevronRight aria-hidden="true" size={14} />
                    </button>
                    {attentionCount > 0 && (
                      <button
                        className="primary-button"
                        onClick={() => setTab('suggestions')}
                        type="button"
                      >
                        处理 {attentionCount} 条建议
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <p className="heartbeat-center__section-empty">
                  尚无心跳报告。运行一次心跳后，你会在这里看到本次学到了什么。
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
                <p className="eyebrow">MEMORY GROWTH</p>
                <h3 id="heartbeat-memory-title">待确认记忆</h3>
              </div>
              <span>{pendingMemories.length} 条</span>
            </div>
            {pendingMemories.length === 0 ? (
              <p className="heartbeat-center__section-empty">
                当前没有等待确认的记忆建议。
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
                        置信度 {Math.round(memory.confidence * 100)}% ·
                        重要度 {Math.round(memory.salience * 100)}%
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
                          ? '收起内容'
                          : '查看完整内容'}
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
                        确认记忆
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
                        忽略
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
                <p className="eyebrow">NEXT ACTIONS</p>
                <h3 id="heartbeat-task-title">行动建议</h3>
              </div>
              <span>{followUpTasks.length} 个</span>
            </div>
            {followUpTasks.length === 0 ? (
              <p className="heartbeat-center__section-empty">
                当前没有由智能心跳产生的行动建议。
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
                          ? '收起内容'
                          : '查看完整内容'}
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
                          带入对话处理
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
                          标记完成
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
                          忽略建议
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
                <p className="eyebrow">HEARTBEAT TIMELINE</p>
                <h3 id="heartbeat-reports-title">
                  <History aria-hidden="true" size={16} />
                  成长轨迹
                </h3>
              </div>
              <span>{orderedEntries.length} 份报告</span>
            </div>
            {orderedEntries.length === 0 ? (
              <p className="heartbeat-center__section-empty">
                完成心跳后，每次学习和变化都会沉淀在这里。
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
                            {entry.highlights.length} 条洞察 ·{' '}
                            {entry.proposedMemoryIds.length} 条记忆 ·{' '}
                            {entry.followUpTaskIds.length} 个行动
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
                          {expanded ? '收起报告' : '展开完整报告'}
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
                加载更多心跳报告
              </button>
            )}
          </section>

          <section
            aria-labelledby="heartbeat-runs-title"
            className="heartbeat-center__section"
          >
            <div className="heartbeat-center__section-heading">
              <div>
                <p className="eyebrow">RUN AUDIT</p>
                <h3 id="heartbeat-runs-title">运行记录</h3>
              </div>
              <span>{orderedRuns.length} 次</span>
            </div>
            {orderedRuns.length === 0 ? (
              <p className="heartbeat-center__section-empty">
                尚无智能心跳运行记录。
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
                        {run.trigger === 'manual' ? '手动运行' : '周期运行'} ·{' '}
                        {formatDateTime(run.scheduledFor)}
                        {run.attemptCount > 1
                          ? ` · 第 ${run.attemptCount} 次尝试`
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
                加载更多运行记录
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
          />
        </div>
      )}
    </section>
  )
}
