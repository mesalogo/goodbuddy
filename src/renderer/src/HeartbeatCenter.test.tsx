import '@testing-library/jest-dom/vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AssistantHeartbeatConfig,
  AssistantHeartbeatEntry,
  AssistantHeartbeatRun,
  AssistantMemory,
  AssistantTask
} from '../../shared/assistant-contracts'
import { HeartbeatCenter, type HeartbeatCenterProps } from './HeartbeatCenter'
import i18n from './i18n'

const config: AssistantHeartbeatConfig = {
  id: 'heartbeat-1',
  projectId: 'project-1',
  name: '智能成长回顾',
  timezone: 'Asia/Shanghai',
  recurrence: {
    type: 'daily',
    localTime: '09:00'
  },
  enabled: true,
  lookbackHours: 48,
  retentionDays: 90,
  nextRunAt: '2026-08-02T01:00:00.000Z',
  lastRunAt: '2026-08-01T01:00:00.000Z',
  lastStatus: 'completed',
  createdAt: '2026-07-31T01:00:00.000Z',
  updatedAt: '2026-08-01T01:00:00.000Z'
}

const runs: AssistantHeartbeatRun[] = [
  {
    id: 'run-completed',
    configId: config.id,
    trigger: 'scheduled',
    scheduledFor: '2026-08-01T01:00:00.000Z',
    status: 'completed',
    attemptCount: 1,
    completedAt: '2026-08-01T01:00:30.000Z',
    entryId: 'entry-1',
    createdAt: '2026-08-01T01:00:00.000Z',
    updatedAt: '2026-08-01T01:00:30.000Z'
  },
  {
    id: 'run-failed',
    configId: config.id,
    trigger: 'manual',
    scheduledFor: '2026-07-31T01:00:00.000Z',
    status: 'failed',
    attemptCount: 2,
    error: '模型暂时不可用',
    createdAt: '2026-07-31T01:00:00.000Z',
    updatedAt: '2026-07-31T01:01:00.000Z'
  }
]

const entry: AssistantHeartbeatEntry = {
  id: 'entry-1',
  configId: config.id,
  runId: 'run-completed',
  scheduledFor: '2026-08-01T01:00:00.000Z',
  summary: '本次心跳发现用户偏好简洁回复，并建议整理交付计划。',
  highlights: ['回复偏好已经稳定', '项目存在一个待整理的交付计划'],
  proposedMemoryIds: ['memory-1'],
  followUpTaskIds: ['task-1'],
  createdAt: '2026-08-01T01:00:30.000Z'
}

const memory: AssistantMemory = {
  id: 'memory-1',
  scope: 'global',
  type: 'preference',
  content: '用户偏好简洁且可执行的中文回复。',
  confidence: 0.92,
  salience: 0.88,
  status: 'proposed',
  createdAt: '2026-08-01T01:00:30.000Z',
  updatedAt: '2026-08-01T01:00:30.000Z'
}

const task: AssistantTask = {
  id: 'task-1',
  title: '整理交付计划',
  instructions: '梳理当前任务并形成明确的交付步骤。',
  origin: 'assistant',
  status: 'paused',
  createdAt: '2026-08-01T01:00:30.000Z'
}

function createProps(
  overrides: Partial<HeartbeatCenterProps> = {}
): HeartbeatCenterProps {
  return {
    configs: [config],
    runs,
    entries: [entry],
    memories: [memory],
    tasks: [task],
    currentProjectName: '默认项目',
    onCreate: vi.fn(async () => {}),
    onSetPaused: vi.fn(async () => {}),
    onRemove: vi.fn(async () => {}),
    onRunNow: vi.fn(async () => {}),
    onRefresh: vi.fn(async () => {}),
    onRetryLoad: vi.fn(async () => {}),
    onSetMemoryStatus: vi.fn(async () => {}),
    onSetTaskStatus: vi.fn(async () => {}),
    onUseFollowUpTask: vi.fn(),
    ...overrides
  }
}

describe('HeartbeatCenter', () => {
  afterEach(async () => {
    cleanup()
    await i18n.changeLanguage('zh-CN')
  })

  it('renders English interface copy while preserving heartbeat content', async () => {
    await i18n.changeLanguage('en-US')
    render(<HeartbeatCenter {...createProps()} />)

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Smart Heartbeat'
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Run heartbeat now' })
    ).toBeInTheDocument()
    expect(screen.getByText(entry.summary)).toBeInTheDocument()
    const englishDate = new Intl.DateTimeFormat('en-US', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(config.nextRunAt))
    expect(screen.getAllByText(englishDate).length).toBeGreaterThan(0)

    fireEvent.click(
      screen.getByRole('tab', { name: /Pending suggestions/ })
    )
    expect(screen.getByText(task.title)).toBeInTheDocument()
    expect(screen.getByText(task.instructions)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Handle in conversation/ })
    ).toBeInTheDocument()
  })

  it('shows heartbeat health, growth dimensions, and the latest report', () => {
    render(<HeartbeatCenter {...createProps()} />)

    expect(
      screen.getByRole('heading', { level: 1, name: '智能心跳' })
    ).toBeInTheDocument()
    expect(screen.getByText('项目：默认项目 + 全局')).toHaveClass(
      'scope-badge'
    )
    expect(screen.getByText(/每天 09:00 · 默认项目/u)).toBeInTheDocument()
    expect(screen.getByText('1 个计划运行中')).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument()
    expect(
      screen.getByText('本次心跳发现用户偏好简洁回复，并建议整理交付计划。')
    ).toBeInTheDocument()

    const dimensions = screen.getByLabelText('智能心跳成长维度')
    expect(
      within(dimensions).getByText('记忆沉淀')
    ).toBeInTheDocument()
    expect(
      within(dimensions).getByText('行动转化')
    ).toBeInTheDocument()
    expect(within(dimensions).getByText('2')).toBeInTheDocument()
  })

  it('turns heartbeat findings into explicit user actions', async () => {
    const onSetMemoryStatus = vi.fn(async () => {})
    const onSetTaskStatus = vi.fn(async () => {})
    const onUseFollowUpTask = vi.fn()
    render(
      <HeartbeatCenter
        {...createProps({
          onSetMemoryStatus,
          onSetTaskStatus,
          onUseFollowUpTask
        })}
      />
    )

    fireEvent.click(
      screen.getByRole('tab', { name: /待处理建议/ })
    )
    expect(screen.getByText(memory.content)).toBeInTheDocument()
    expect(screen.getByText(task.title)).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: '确认记忆' })
    )
    await waitFor(() =>
      expect(onSetMemoryStatus).toHaveBeenCalledWith(
        memory.id,
        'confirmed'
      )
    )

    fireEvent.click(
      screen.getByRole('button', { name: /带入对话处理/ })
    )
    expect(onUseFollowUpTask).toHaveBeenCalledWith(task)

    fireEvent.click(
      screen.getByRole('button', { name: '标记完成' })
    )
    await waitFor(() =>
      expect(onSetTaskStatus).toHaveBeenCalledWith(
        task.id,
        'completed'
      )
    )
  })

  it('runs, refreshes, and exposes auditable heartbeat history', async () => {
    const onRunNow = vi.fn(async () => {})
    const onRefresh = vi.fn(async () => {})
    render(
      <HeartbeatCenter
        {...createProps({ onRefresh, onRunNow })}
      />
    )

    fireEvent.click(
      screen.getByRole('button', { name: '运行一次心跳' })
    )
    await waitFor(() =>
      expect(onRunNow).toHaveBeenCalledWith(config.id)
    )

    fireEvent.click(
      screen.getByRole('button', { name: '刷新智能心跳' })
    )
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce())

    fireEvent.click(screen.getByRole('tab', { name: '心跳轨迹' }))
    expect(screen.getByText('模型暂时不可用')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: '展开完整报告' })
    )
    expect(screen.getByText(entry.highlights[0]!)).toBeInTheDocument()
  })

  it('explains the irreversible impact before deleting a plan', () => {
    render(<HeartbeatCenter {...createProps()} />)

    fireEvent.click(screen.getByRole('tab', { name: '心跳计划' }))
    fireEvent.click(
      screen.getByRole('button', {
        name: `删除 ${config.name}`
      })
    )

    const confirmation = screen.getByRole('alertdialog', {
      name: `确认删除 ${config.name}`
    })
    expect(confirmation).toHaveTextContent(
      '将永久删除此计划、运行历史和关联结果，且无法恢复。'
    )
  })

  it('guides first-time users to create a heartbeat plan', () => {
    render(
      <HeartbeatCenter
        {...createProps({
          configs: [],
          runs: [],
          entries: [],
          memories: [],
          tasks: []
        })}
      />
    )

    fireEvent.click(
      screen.getByRole('button', { name: '配置智能心跳' })
    )
    expect(
      screen.getByRole('tab', { name: '心跳计划' })
    ).toHaveAttribute('aria-selected', 'true')
    expect(
      screen.getByRole('button', { name: '启用智能心跳' })
    ).toBeInTheDocument()
  })

  it('keeps loading and load failure distinct from first-time empty state', () => {
    const emptyProps = {
      configs: [],
      runs: [],
      entries: [],
      memories: [],
      tasks: []
    }
    const { rerender } = render(
      <HeartbeatCenter
        {...createProps({
          ...emptyProps,
          loading: true
        })}
      />
    )

    expect(screen.getByText('正在加载智能心跳')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '配置智能心跳' })
    ).not.toBeInTheDocument()

    rerender(
      <HeartbeatCenter
        {...createProps({
          ...emptyProps,
          loadError: '数据库暂时不可用'
        })}
      />
    )
    expect(screen.getByText('智能心跳加载失败')).toBeInTheDocument()
    expect(screen.getByText('数据库暂时不可用')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '配置智能心跳' })
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('keeps existing heartbeat data visible when refresh fails', () => {
    render(
      <HeartbeatCenter
        {...createProps({ loadError: '刷新连接失败' })}
      />
    )

    expect(screen.getByText('智能心跳刷新失败')).toBeInTheDocument()
    expect(screen.getByText(config.name)).toBeInTheDocument()
    expect(
      screen.getByText(entry.summary)
    ).toBeInTheDocument()
  })
})
