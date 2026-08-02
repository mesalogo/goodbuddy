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

function makeRecord(
  index: number,
  status: ActivityRecord['status'] = 'completed'
): ActivityRecord {
  return {
    id: `activity-${index}`,
    conversationId: `conversation-${index}`,
    requestId: `request-${index}`,
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
  afterEach(() => {
    cleanup()
  })

  it('filters active and unsuccessful activity and opens its conversation', () => {
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
    expect(screen.getByText('活动 1')).toBeInTheDocument()
    expect(screen.queryByText('活动 2')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '失败' }))
    expect(screen.getByText('活动 2')).toBeInTheDocument()
    expect(screen.getByText('活动 3')).toBeInTheDocument()
    expect(screen.queryByText('活动 1')).not.toBeInTheDocument()

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
        '尚无活动记录。任务请求、工具调用和审批决定会显示在这里。'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '清空记录' })
    ).toBeDisabled()
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

    const stats = screen.getByLabelText('Token 用量统计')
    expect(
      within(stats).getByText('150')
    ).toBeInTheDocument()

    const projectRow = screen.getByRole('row', {
      name: '项目甲gpt-5 · openai 100 20 10 40 120'
    })
    expect(projectRow).toBeInTheDocument()
    expect(
      within(projectRow).queryByText('170')
    ).not.toBeInTheDocument()
  })

  it('groups token usage and displays fallback labels', () => {
    render(
      <ActivityPanel
        onClear={vi.fn()}
        onOpenConversation={vi.fn()}
        records={[]}
        tokenUsage={makeTokenUsage()}
      />
    )

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
