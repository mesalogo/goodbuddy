import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationTaskStrip } from './ConversationTaskStrip'

afterEach(cleanup)

describe('ConversationTaskStrip', () => {
  it('shows Task details and controls the stable schedule', async () => {
    const taskId = '00000000-0000-4000-8000-000000000811'
    const scheduleId =
      '00000000-0000-4000-8000-000000000812'
    const conversationId =
      '00000000-0000-4000-8000-000000000813'
    const onRunSchedule = vi.fn(async () => undefined)
    const onSetScheduleEnabled = vi.fn(async () => undefined)
    const onRemoveSchedule = vi.fn(async () => undefined)

    render(
      <ConversationTaskStrip
        locale="zh-CN"
        onRemoveSchedule={onRemoveSchedule}
        onRunSchedule={onRunSchedule}
        onSelectTask={vi.fn()}
        onSetScheduleEnabled={onSetScheduleEnabled}
        schedules={[
          {
            id: scheduleId,
            taskId,
            conversationId,
            title: '每日状态',
            prompt: '汇总状态',
            workMode: 'execute',
            recurrence: 'daily',
            nextRunAt: '2026-08-20T09:00:00.000Z',
            enabled: true,
            createdAt: '2026-08-19T00:00:00.000Z',
            updatedAt: '2026-08-19T00:00:00.000Z'
          }
        ]}
        selectedTaskId={taskId}
        tasks={[
          {
            id: taskId,
            conversationId,
            scheduleId,
            title: '每日状态',
            instructions: '汇总状态',
            origin: 'schedule',
            status: 'idle',
            createdAt: '2026-08-19T00:00:00.000Z'
          }
        ]}
      />
    )

    expect(screen.getByText('每日状态', { selector: 'strong' }))
      .toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '新建任务' })
    ).not.toBeInTheDocument()
    expect(screen.getByText('Execute')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '立即运行' }))
    await waitFor(() =>
      expect(onRunSchedule).toHaveBeenCalledWith(scheduleId)
    )
    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    await waitFor(() =>
      expect(onSetScheduleEnabled).toHaveBeenCalledWith(
        scheduleId,
        false
      )
    )
    fireEvent.click(
      screen.getByRole('button', { name: '删除计划' })
    )
    expect(onRemoveSchedule).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole('button', {
        name: '确认删除“每日状态”的计划'
      })
    )
    await waitFor(() =>
      expect(onRemoveSchedule).toHaveBeenCalledWith(scheduleId)
    )
  })

  it('hides the conversation task row when there are no tasks', () => {
    render(
      <ConversationTaskStrip
        locale="zh-CN"
        onRemoveSchedule={vi.fn(async () => undefined)}
        onRunSchedule={vi.fn(async () => undefined)}
        onSelectTask={vi.fn()}
        onSetScheduleEnabled={vi.fn(async () => undefined)}
        schedules={[]}
        tasks={[]}
      />
    )

    expect(
      screen.queryByRole('region', { name: '当前会话的任务' })
    ).not.toBeInTheDocument()
  })
})
