import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SupervisionActivity as Activity } from '../../shared/supervision-contracts'
import { SupervisorActivity } from './SupervisorActivity'
import './i18n'

const row: Activity = {
  id: 'run', kind: 'heartbeat', trigger: 'scheduled', status: 'running', scope: { kind: 'global' },
  startedAt: '2026-09-23T10:00:00Z', completedAt: null, timeRange: null, error: null,
  summary: 'Saved heartbeat', resultId: null, heartbeatStatus: 'completed', supervisionStatus: 'running'
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('shows no-change execution without a new result action', async () => {
  vi.stubGlobal('goodbuddy', { supervision: { activity: vi.fn().mockResolvedValue([{
    ...row, status: 'no_change', heartbeatStatus: 'no_change', supervisionStatus: 'no_change',
    summary: null, completedAt: '2026-09-23T10:00:01Z'
  }]) } })
  render(<SupervisorActivity active projects={[]} onOpenResult={vi.fn()} />)
  expect(await screen.findByText('无变化（未调用模型）')).toBeVisible()
  expect(screen.getByText('心跳报告: 无变化（未调用模型）')).toBeVisible()
  expect(screen.queryByRole('button', { name: '查看回顾' })).not.toBeInTheDocument()
})

it('polls sequentially only while active and ignores late responses after leaving', async () => {
  vi.useFakeTimers()
  let resolve!: (value: Activity[]) => void
  const activity = vi.fn().mockResolvedValueOnce([row]).mockImplementationOnce(() => new Promise<Activity[]>((done) => { resolve = done })).mockResolvedValue([])
  vi.stubGlobal('goodbuddy', { supervision: { activity } })
  const props = { active: true, projects: [], onOpenResult: vi.fn() }
  const view = render(<SupervisorActivity {...props} />)
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(screen.getByText('运行中')).toBeVisible()
  expect(screen.getByText('心跳报告: 已完成')).toBeVisible()
  await act(() => vi.advanceTimersByTimeAsync(2000))
  expect(screen.getByRole('button', { name: '刷新' })).toBeDisabled()
  await act(() => vi.advanceTimersByTimeAsync(20000))
  expect(activity).toHaveBeenCalledTimes(2)
  view.rerender(<SupervisorActivity {...props} active={false} />)
  await act(async () => resolve([{ ...row, status: 'failed', error: 'Late error' }]))
  expect(screen.queryByText('Late error')).not.toBeInTheDocument()
  await act(() => vi.advanceTimersByTimeAsync(20000))
  expect(activity).toHaveBeenCalledTimes(2)
  view.rerender(<SupervisorActivity {...props} />)
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(activity).toHaveBeenCalledTimes(3)
  expect(screen.getByText('暂无活动记录')).toBeVisible()
  view.unmount()
  await act(() => vi.advanceTimersByTimeAsync(20000))
  expect(activity).toHaveBeenCalledTimes(3)
})

it('does not query while inactive and exposes recoverable read errors without triggering execution', async () => {
  vi.useFakeTimers()
  const activity = vi.fn().mockRejectedValueOnce(new Error('Read failed')).mockResolvedValue([])
  const run = vi.fn()
  vi.stubGlobal('goodbuddy', { supervision: { activity, run } })
  const props = { projects: [], onOpenResult: vi.fn() }
  const view = render(<SupervisorActivity {...props} active={false} />)
  await act(() => vi.advanceTimersByTimeAsync(20000))
  expect(activity).not.toHaveBeenCalled()
  view.rerender(<SupervisorActivity {...props} active />)
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(screen.getByRole('alert')).toHaveTextContent('Read failed')
  await act(() => vi.advanceTimersByTimeAsync(20000))
  expect(activity).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(screen.getByText('暂无活动记录')).toBeVisible()
  expect(run).not.toHaveBeenCalled()
})

it('shows actual status, scope and result destinations without unsupported cancellation', async () => {
  const activity = vi.fn().mockResolvedValue([{ ...row, kind: 'supervision', trigger: 'manual', status: 'completed', supervisionStatus: 'completed', heartbeatStatus: null, resultId: 'old-result', completedAt: '2026-09-23T10:01:00Z' }])
  vi.stubGlobal('goodbuddy', { supervision: { activity } })
  const open = vi.fn()
  render(<SupervisorActivity active projects={[]} onOpenResult={open} />)
  fireEvent.click(await screen.findByRole('button', { name: '查看回顾' }))
  expect(open).toHaveBeenLastCalledWith('old-result', 'overview')
  fireEvent.click(screen.getByRole('button', { name: '在图谱中查看' }))
  expect(open).toHaveBeenLastCalledWith('old-result', 'graph')
  expect(screen.queryByRole('button', { name: /取消/ })).not.toBeInTheDocument()
  expect(screen.getByText('用户触发')).toBeVisible()
})
