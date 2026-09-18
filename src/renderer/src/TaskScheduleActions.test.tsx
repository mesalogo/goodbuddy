import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantSchedule } from '../../shared/assistant-contracts'
import { TaskScheduleActions } from './TaskScheduleActions'

afterEach(cleanup)

const triggeredAt = '2026-09-17T12:00:00.000Z'
const schedule: AssistantSchedule = {
  id: '00000000-0000-4000-8000-000000000801',
  taskId: '00000000-0000-4000-8000-000000000802',
  conversationId: '00000000-0000-4000-8000-000000000803',
  title: 'Immediate task', prompt: 'Run once', workMode: 'ask',
  recurrence: 'once', enabled: false,
  nextRunAt: triggeredAt, lastRunAt: triggeredAt,
  createdAt: triggeredAt, updatedAt: triggeredAt
}

describe('TaskScheduleActions', () => {
  it('offers an explicit new run, not automatic resume, for a cancelled immediate task', async () => {
    const onRunSchedule = vi.fn().mockResolvedValue(undefined)
    const onSetScheduleEnabled = vi.fn()
    render(<TaskScheduleActions schedule={schedule} taskStatus="cancelled" taskTitle={schedule.title}
      onError={vi.fn()} onRemoveSchedule={vi.fn()} onRunSchedule={onRunSchedule}
      onSetScheduleEnabled={onSetScheduleEnabled} />)
    expect(screen.queryByRole('button', { name: '恢复' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '立即运行' }))
    await waitFor(() => expect(onRunSchedule).toHaveBeenCalledExactlyOnceWith(schedule.id))
    expect(onSetScheduleEnabled).not.toHaveBeenCalled()
  })

  it('does not allow resume or another run while the immediate occurrence is queued', () => {
    render(<TaskScheduleActions schedule={schedule} taskStatus="queued" taskTitle={schedule.title}
      onError={vi.fn()} onRemoveSchedule={vi.fn()} onRunSchedule={vi.fn()}
      onSetScheduleEnabled={vi.fn()} />)
    expect(screen.queryByRole('button', { name: '恢复' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '立即运行' })).toBeDisabled()
  })

  it.each(['once', 'daily', 'weekly'] as const)('retains resume for a paused untriggered %s schedule', async (recurrence) => {
    const onSetScheduleEnabled = vi.fn().mockResolvedValue(undefined)
    render(<TaskScheduleActions schedule={{ ...schedule, recurrence, lastRunAt: undefined }}
      taskStatus="paused" taskTitle={schedule.title} onError={vi.fn()}
      onRemoveSchedule={vi.fn()} onRunSchedule={vi.fn()} onSetScheduleEnabled={onSetScheduleEnabled} />)
    fireEvent.click(screen.getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(onSetScheduleEnabled).toHaveBeenCalledExactlyOnceWith(schedule.id, true))
  })
})
