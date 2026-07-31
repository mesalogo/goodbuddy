import {
  cleanup,
  fireEvent,
  render,
  screen
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '清空记录' }))
    expect(onClear).toHaveBeenCalledOnce()

    rerender(
      <ActivityPanel
        onClear={onClear}
        onOpenConversation={vi.fn()}
        records={[]}
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
      />
    )

    expect(screen.getByText('活动 499')).toBeInTheDocument()
    expect(screen.queryByText('活动 500')).not.toBeInTheDocument()
  })
})
