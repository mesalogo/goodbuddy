import {
  cleanup,
  fireEvent,
  render,
  screen,
  within
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TokenUsageSummary } from '../../shared/assistant-contracts'
import { ActivityPanel } from './ActivityPanel'
import {
  MAX_ACTIVITY_RECORDS,
  type ActivityRecord
} from './activity-store'
import i18n from './i18n'

function makeRecord(
  index: number,
  status: ActivityRecord['status'] = 'completed'
): ActivityRecord {
  return {
    id: `activity-${index}`,
    conversationId: `conversation-${index}`,
    requestId: `request-${index}`,
    scope: { kind: 'global' },
    kind: 'tool',
    title: `活动 ${index}`,
    detail: `详情 ${index}`,
    status,
    createdAt: Date.UTC(2026, 0, 1, 12, 0, index)
  }
}

function makeTokenUsage(): TokenUsageSummary {
  return {
    totals: {
      callCount: 2,
      input: 125,
      output: 25,
      cacheRead: 40,
      cacheWrite: 10,
      totalTokens: 200
    },
    records: [
      {
        requestId: 'request-1',
        projectId: 'project-1',
        projectName: '项目甲',
        conversationId: 'conversation-1',
        conversationTitle: '会话甲',
        runtime: 'model',
        provider: 'openai',
        model: 'gpt-5',
        callCount: 1,
        input: 100,
        output: 20,
        cacheRead: 40,
        cacheWrite: 10,
        totalTokens: 170
      },
      {
        requestId: 'request-2',
        conversationId: '',
        runtime: 'model',
        provider: '',
        model: '',
        callCount: 1,
        input: 25,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 30
      }
    ]
  }
}

describe('ActivityPanel', () => {
  afterEach(async () => {
    cleanup()
    await i18n.changeLanguage('zh-CN')
  })

  it('renders localized tabs and keeps usage separate from activity', async () => {
    await i18n.changeLanguage('en-US')
    const record = makeRecord(1, 'running')
    render(
      <ActivityPanel
        onClear={vi.fn()}
        onOpenConversation={vi.fn()}
        records={[record]}
        tokenUsage={makeTokenUsage()}
      />
    )

    const englishDate = new Intl.DateTimeFormat('en-US', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(new Date(record.createdAt))
    expect(screen.getAllByText(englishDate).length).toBeGreaterThan(0)
    expect(
      screen.getByRole('heading', { level: 1, name: 'Run history' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('tab', { name: 'Tasks and conversations' })
    ).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(record.title)).toBeInTheDocument()
    expect(screen.queryByText('Token usage')).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('tab', { name: 'Usage analytics' })
    )
    expect(screen.getByText('Token usage')).toBeInTheDocument()
    expect(screen.queryByText(record.title)).not.toBeInTheDocument()
  })

  it('organizes records by project, conversation, and detail', () => {
    const request: ActivityRecord = {
      ...makeRecord(1, 'running'),
      kind: 'request',
      title: '分析登录问题',
      scope: {
        kind: 'project',
        projectId: 'project-1',
        projectName: '项目甲'
      }
    }
    const tool: ActivityRecord = {
      ...makeRecord(2),
      conversationId: request.conversationId,
      requestId: request.requestId,
      title: '搜索 IPC 代码',
      scope: request.scope
    }
    const { container } = render(
      <ActivityPanel
        onClear={vi.fn()}
        onOpenConversation={vi.fn()}
        records={[request, tool, makeRecord(3)]}
        tokenUsage={makeTokenUsage()}
      />
    )

    expect(container.querySelectorAll('.activity-project')).toHaveLength(2)
    expect(screen.getByText('项目：项目甲')).toBeInTheDocument()
    expect(
      screen.getByText('1 个任务或会话 · 2 条活动')
    ).toBeInTheDocument()

    const projectConversation = screen
      .getByText('对话：分析登录问题')
      .closest('details')
    expect(projectConversation).not.toBeNull()
    expect(projectConversation).not.toHaveAttribute('open')
    fireEvent.click(screen.getByText('对话：分析登录问题'))
    expect(projectConversation).toHaveAttribute('open')
    expect(
      projectConversation?.querySelectorAll('article')
    ).toHaveLength(2)
  })

  it('filters active and exceptional activity and opens its conversation', () => {
    const onOpenConversation = vi.fn()
    render(
      <ActivityPanel
        onClear={vi.fn()}
        onOpenConversation={onOpenConversation}
        records={[
          makeRecord(1, 'running'),
          makeRecord(2, 'failed'),
          makeRecord(3, 'denied'),
          makeRecord(4)
        ]}
        tokenUsage={makeTokenUsage()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '进行中' }))
    expect(screen.getByText('对话：活动 1')).toBeInTheDocument()
    expect(screen.queryByText('活动 2')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '异常' }))
    expect(screen.getByText('对话：活动 2')).toBeInTheDocument()
    expect(screen.getByText('对话：活动 3')).toBeInTheDocument()
    expect(screen.queryByText('活动 1')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('对话：活动 2'))
    fireEvent.click(
      screen.getAllByRole('button', { name: '打开所属对话' })[0]!
    )
    expect(onOpenConversation).toHaveBeenCalledWith('conversation-2')
  })

  it('clears activity and explains the real empty state', () => {
    const onClear = vi.fn()
    const { rerender } = render(
      <ActivityPanel
        onClear={onClear}
        onOpenConversation={vi.fn()}
        records={[makeRecord(1)]}
        tokenUsage={makeTokenUsage()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '清空记录' }))
    expect(onClear).not.toHaveBeenCalled()
    expect(
      screen.getByText('永久清空 1 条活动记录？此操作不可撤销。')
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: '确认清空 1 条活动记录' })
    )
    expect(onClear).toHaveBeenCalledOnce()

    rerender(
      <ActivityPanel
        onClear={onClear}
        onOpenConversation={vi.fn()}
        records={[]}
        tokenUsage={makeTokenUsage()}
      />
    )
    expect(
      screen.getByText(
        '任务请求、子专家、工具调用和审批决定会显示在这里。'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '清空记录' })
    ).toBeDisabled()
  })

  it('clears a filter that has no matching activity', () => {
    render(
      <ActivityPanel
        onClear={vi.fn()}
        onOpenConversation={vi.fn()}
        records={[makeRecord(1)]}
        tokenUsage={makeTokenUsage()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '进行中' }))
    expect(screen.getByText('没有匹配的活动')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))

    expect(
      screen.getByRole('button', { name: '全部' })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('对话：活动 1')).toBeInTheDocument()
  })

  it('labels Subagent activity as child expert work', () => {
    render(
      <ActivityPanel
        onClear={vi.fn()}
        onOpenConversation={vi.fn()}
        records={[
          {
            ...makeRecord(1),
            kind: 'subagent',
            title: '研究专家',
            detail: '智能路由 · 分析证据',
            status: 'running'
          }
        ]}
        tokenUsage={makeTokenUsage()}
      />
    )

    expect(screen.getByText('子专家')).toBeInTheDocument()
    const item = screen.getByText('研究专家').closest('article')
    expect(item).not.toBeNull()
    if (!item) {
      return
    }
    expect(
      within(item).getByText('智能路由 · 分析证据')
    ).toBeInTheDocument()
    expect(within(item).getByText('进行中')).toBeInTheDocument()
  })

  it('shows immutable project and unavailable scope snapshots', () => {
    const projectRecord: ActivityRecord = {
      ...makeRecord(1),
      scope: {
        kind: 'project',
        projectId: 'project-1',
        projectName: '项目甲'
      }
    }
    const unavailableRecord: ActivityRecord = {
      ...makeRecord(2),
      scope: { kind: 'unavailable' }
    }
    render(
      <ActivityPanel
        onClear={vi.fn()}
        onOpenConversation={vi.fn()}
        records={[projectRecord, unavailableRecord]}
        tokenUsage={makeTokenUsage()}
      />
    )

    expect(screen.getByText('项目：项目甲')).toBeInTheDocument()
    expect(screen.getByText('范围不可用')).toBeInTheDocument()
  })

  it('uses shared page tabs and explicit global scope', () => {
    render(
      <ActivityPanel
        onClear={vi.fn()}
        onOpenConversation={vi.fn()}
        records={[]}
        tokenUsage={makeTokenUsage()}
      />
    )

    expect(
      screen.getByRole('heading', { level: 1, name: '运行记录' })
    ).toBeInTheDocument()
    expect(screen.getByText('全部项目')).toHaveClass('scope-badge')
    expect(screen.getByLabelText('运行记录视图')).toHaveClass(
      'page-tabs'
    )
    expect(
      screen.getByRole('tabpanel', { name: '任务与会话' })
    ).toBeInTheDocument()
    expect(screen.getByLabelText('筛选活动')).toHaveClass(
      'segmented-control'
    )
    expect(
      screen.queryByLabelText('Token 用量分组')
    ).not.toBeInTheDocument()
  })

  it('renders shared-time project and conversation activity tracks', () => {
    const first: ActivityRecord = {
      ...makeRecord(1, 'running'),
      kind: 'request',
      title: '分析登录问题',
      scope: {
        kind: 'project',
        projectId: 'project-1',
        projectName: '项目甲'
      }
    }
    const second: ActivityRecord = {
      ...makeRecord(2, 'failed'),
      conversationId: first.conversationId,
      requestId: first.requestId,
      scope: first.scope
    }
    const third: ActivityRecord = {
      ...makeRecord(3),
      conversationId: 'conversation-parallel',
      requestId: 'request-parallel',
      kind: 'subagent',
      title: '研究专家',
      scope: first.scope
    }
    const fourth: ActivityRecord = {
      ...makeRecord(4),
      conversationId: first.conversationId,
      requestId: first.requestId,
      kind: 'result',
      title: '任务执行完成',
      scope: first.scope
    }
    render(
      <ActivityPanel
        onClear={vi.fn()}
        onOpenConversation={vi.fn()}
        records={[first, second, third, fourth]}
        tokenUsage={makeTokenUsage()}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '活动时间线' }))
    const timeline = screen.getByLabelText(
      '按项目和会话分组的并行活动轨道'
    )
    expect(timeline).toHaveClass('activity-tracks')
    expect(
      timeline.querySelectorAll('.activity-track')
    ).toHaveLength(2)
    expect(
      timeline.querySelectorAll('.activity-track__node')
    ).toHaveLength(4)
    expect(within(timeline).getByText('分析登录问题')).toBeInTheDocument()
    expect(
      within(timeline).getAllByText('研究专家').length
    ).toBeGreaterThan(0)
    expect(within(timeline).getAllByText('用户').length).toBeGreaterThan(0)
    expect(
      within(timeline).getAllByText('GoodBuddy').length
    ).toBeGreaterThan(0)
    expect(
      within(
        screen.getByRole('button', { name: /用户，任务/u })
      ).getByText('U')
    ).toBeInTheDocument()
    expect(
      within(
        screen.getByRole('button', { name: /活动 2，工具/u })
      ).getByText('T')
    ).toBeInTheDocument()
    expect(
      within(
        screen.getByRole('button', { name: /研究专家，子专家/u })
      ).getByText('S')
    ).toBeInTheDocument()
    expect(
      within(
        screen.getByRole('button', { name: /GoodBuddy，结果/u })
      ).getByText('G')
    ).toBeInTheDocument()
    expect(within(timeline).getByText('项目：项目甲')).toBeInTheDocument()
    expect(
      within(timeline).getByText(
        '所有轨道共享同一执行顺序，节点按发生时间依次展开，点击节点查看身份和活动详情。'
      )
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', {
        name: /工具，失败，活动 2/u
      })
    )
    const detail = screen.getByLabelText('选中的活动节点详情')
    expect(within(detail).getByText('活动 2')).toBeInTheDocument()
    expect(
      within(detail).getByText('对话：分析登录问题')
    ).toBeInTheDocument()
    expect(within(detail).getByText('项目：项目甲')).toBeInTheDocument()
  })

  it('never renders more than 500 records', () => {
    const records = Array.from(
      { length: MAX_ACTIVITY_RECORDS + 1 },
      (_, index) => makeRecord(index)
    )
    render(
      <ActivityPanel
        onClear={vi.fn()}
        onOpenConversation={vi.fn()}
        records={records}
        tokenUsage={makeTokenUsage()}
      />
    )

    expect(screen.getByText('活动 499')).toBeInTheDocument()
    expect(screen.queryByText('活动 500')).not.toBeInTheDocument()
  })

  it('shows totals without double-counting cache tokens', () => {
    render(
      <ActivityPanel
        onClear={vi.fn()}
        onOpenConversation={vi.fn()}
        records={[]}
        tokenUsage={makeTokenUsage()}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: '用量统计' }))

    const stats = screen.getByLabelText('Token 用量统计')
    expect(within(stats).getByText('150')).toBeInTheDocument()

    const projectRow = screen.getByRole('row', {
      name: '项目甲gpt-5 · openai 100 20 10 40 120'
    })
    expect(projectRow).toBeInTheDocument()
    expect(
      within(projectRow).queryByText('170')
    ).not.toBeInTheDocument()
  })

  it('groups token usage by project, conversation, and model', () => {
    render(
      <ActivityPanel
        onClear={vi.fn()}
        onOpenConversation={vi.fn()}
        records={[]}
        tokenUsage={makeTokenUsage()}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: '用量统计' }))

    expect(screen.getByText('项目甲')).toBeInTheDocument()
    expect(screen.getByText('未归属项目')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '按会话' }))
    expect(screen.getByText('会话甲')).toBeInTheDocument()
    expect(screen.getByText('已删除会话')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '按模型' }))
    expect(screen.getByText('gpt-5')).toBeInTheDocument()
    expect(screen.getByText('未知模型')).toBeInTheDocument()
  })
})
