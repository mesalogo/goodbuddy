import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationInputQueue } from './ConversationInputQueue'

afterEach(cleanup)

describe('ConversationInputQueue', () => {
  const items = [
    {
      id: '00000000-0000-4000-8000-000000000901',
      conversationId: '00000000-0000-4000-8000-000000000900',
      source: 'schedule' as const,
      label: '每日汇总',
      createdAt: '2026-08-20T09:00:00.000Z'
    },
    {
      id: '00000000-0000-4000-8000-000000000902',
      conversationId: '00000000-0000-4000-8000-000000000900',
      source: 'user' as const,
      label: '再补充一段说明',
      createdAt: '2026-08-20T09:01:00.000Z'
    }
  ]

  it('shows both queue sources and exposes interrupt and remove actions', async () => {
    const onInterruptAndRun = vi.fn(async () => undefined)
    const onRemove = vi.fn(async () => undefined)
    const { container } = render(
      <ConversationInputQueue
        items={items}
        onError={vi.fn()}
        onInterruptAndRun={onInterruptAndRun}
        onRemove={onRemove}
        running
      />
    )

    const queue = screen.getByRole('region', {
      name: '对话待发送队列'
    })
    expect(queue).toBeInTheDocument()
    expect(queue.querySelector('header')).not.toBeInTheDocument()
    expect(
      within(queue).getAllByRole('listitem')
    ).toHaveLength(2)
    expect(screen.queryByText('待发送（2）')).not.toBeInTheDocument()
    expect(
      screen.queryByText('当前回复结束后按顺序执行')
    ).not.toBeInTheDocument()
    expect(screen.getByText('每日汇总')).toBeInTheDocument()
    expect(screen.getByText('再补充一段说明')).toBeInTheDocument()
    expect(screen.queryByText('定时任务')).not.toBeInTheDocument()
    expect(screen.queryByText('消息')).not.toBeInTheDocument()
    expect(
      container.querySelector('.lucide-clock-fading')
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', {
        name: '中断当前回复并优先执行“每日汇总”'
      })
    )
    await waitFor(() =>
      expect(onInterruptAndRun).toHaveBeenCalledWith(items[0]!.id)
    )

    fireEvent.click(
      screen.getByRole('button', {
        name: '从待发送队列删除“再补充一段说明”'
      })
    )
    await waitFor(() =>
      expect(onRemove).toHaveBeenCalledWith(items[1]!.id)
    )
  })

  it('uses run-now wording while idle and reports action errors', async () => {
    const onError = vi.fn()
    render(
      <ConversationInputQueue
        items={[items[0]!]}
        onError={onError}
        onInterruptAndRun={vi.fn(async () => {
          throw new Error('队列项已变化')
        })}
        onRemove={vi.fn(async () => undefined)}
        running={false}
      />
    )

    const action = screen.getByRole('button', {
      name: '立即运行“每日汇总”'
    })
    expect(action).toHaveTextContent('立即运行')
    fireEvent.click(action)
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith('队列项已变化')
    )
  })
})
