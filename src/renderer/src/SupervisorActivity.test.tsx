import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render as renderComponent, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SupervisionActivity as Activity } from '../../shared/supervision-contracts'
import { SupervisorActivity } from './SupervisorActivity'
import { SupervisionBatchDetails } from './SupervisionBatchDetails'
import { changeUiLocale, i18nResources } from './i18n'

const row: Activity = {
  id: 'run', kind: 'heartbeat', trigger: 'scheduled', status: 'running', scope: { kind: 'global' },
  startedAt: '2026-09-23T10:00:00Z', completedAt: null, timeRange: null, error: null,
  summary: 'Saved heartbeat', resultId: null, heartbeatStatus: 'completed', supervisionStatus: 'running'
}
const render = (ui: React.ReactNode) => {
  if (window.goodbuddy?.supervision) window.goodbuddy.supervision.execution ??= vi.fn().mockResolvedValue({ active: false })
  return renderComponent(ui)
}
afterEach(async () => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); await changeUiLocale('zh-CN') })

it.each(['zh-CN', 'en-US'] as const)('shows deletion omissions alongside surviving coverage in %s', async locale => {
  await changeUiLocale(locale)
  vi.stubGlobal('goodbuddy', { supervision: { activity: vi.fn().mockResolvedValue([{
    ...row, status: 'no_change', supervisionStatus: 'no_change', reviewProgress: {
      runId: 'saved-run', batches: 0, characters: 0, sources: 0, remainingSources: 0, omittedSources: 3, complete: true
    }
  }]) } })
  render(<SupervisorActivity active projects={[]} onOpenResult={vi.fn()} />)
  const notices = await screen.findAllByText(i18nResources[locale].heartbeat.activity.omittedSources.replace('{{count}}', '3'))
  expect(notices[0]).toBeVisible()
  expect(notices).toHaveLength(2)
  expect(screen.queryByRole('button', { name: i18nResources[locale].heartbeat.reviewSettings.resume })).not.toBeInTheDocument()
})

it.each(['zh-CN', 'en-US'] as const)('retains operational failure details and recovery in %s', async locale => {
  await changeUiLocale(locale)
  const copy = i18nResources[locale].heartbeat
  vi.stubGlobal('goodbuddy', { supervision: { activity: vi.fn().mockResolvedValue([{
    ...row, status: 'failed', supervisionStatus: 'failed', error: 'Provider HTTP 429: Retry-After 30s',
    reviewProgress: { runId: 'saved-run', batches: 1, characters: 1000, sources: 2, remainingSources: 1, complete: false }
  }]), resume: vi.fn() } })
  render(<SupervisorActivity active projects={[]} onOpenResult={vi.fn()} />)
  expect(await screen.findByText(copy.reviewSettings.runError)).toBeVisible()
  const details = screen.getByText('Provider HTTP 429: Retry-After 30s')
  expect(details).not.toBeVisible()
  fireEvent.click(screen.getByText(copy.reviewSettings.diagnostics))
  expect(details.closest('details')).toHaveAttribute('open')
  expect(details).toHaveStyle({ userSelect: 'text' })
  expect(screen.getByText(copy.activity.status.failed)).toBeVisible()
  expect(screen.queryByText(copy.activity.description)).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: copy.reviewSettings.resume })).toBeEnabled()
})

it('shows durable progress, pauses and continues the same run, and expands retained facts', async () => {
  const progress = { runId: 'saved-run', batches: 1, characters: 1000, sources: 2, remainingSources: 1, complete: false }
  const activity = vi.fn().mockResolvedValue([{ ...row, reviewProgress: progress }])
  const pause = vi.fn(async () => { activity.mockResolvedValue([{ ...row, status: 'paused', supervisionStatus: 'paused', reviewProgress: progress }]) })
  const resume = vi.fn(async () => undefined)
  const batches = vi.fn().mockResolvedValue([{ id: 'leaf', projectId: 'project', conversationId: 'conversation',
    evidence: [{ id: 'source', sourceId: 'conversation', title: 'Message', content: 'Retained quotation', locator: { messageId: 'message-id', start: 0, end: 18, revision: 'revision' } }],
    output: { summary: 'Leaf navigation', changeDigest: '', openItems: [], entities: [], relations: [], entityChanges: [],
      events: [{ title: 'Decision', description: 'Retained fact', sourceReferenceIds: ['source'] }] } }])
  vi.stubGlobal('goodbuddy', { supervision: { activity, pause, resume, batches } })
  render(<SupervisorActivity active projects={[]} onOpenResult={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: '暂停回顾' }))
  fireEvent.click(await screen.findByRole('button', { name: '继续已保存回顾' }))
  expect(pause).toHaveBeenCalledWith({ runId: 'saved-run' })
  await waitFor(() => expect(resume).toHaveBeenCalledWith({ runId: 'saved-run' }))
  await waitFor(() => expect(activity).toHaveBeenCalledTimes(3))
  fireEvent.click(await screen.findByRole('button', { name: '已保留事实与来源' }))
  expect(await screen.findByText('Retained fact')).toBeInTheDocument()
  expect(batches).toHaveBeenCalledWith({ runId: 'saved-run', offset: 0, limit: 10 })
  expect(screen.getAllByText(/message-id \[0, 18\)/).length).toBeGreaterThan(0)
})

it('allows cancelling a resumed review before the resume request settles', async () => {
  vi.useFakeTimers()
  const progress = { runId: 'saved-run', phase: 'extracting', batches: 1, characters: 1000, sources: 2, remainingSources: 1, complete: false }
  const activity = vi.fn().mockResolvedValue([{ ...row, status: 'paused', supervisionStatus: 'paused', reviewProgress: progress }])
  const execution = vi.fn().mockResolvedValue({ active: false })
  let finishResume!: () => void, finishCancel!: () => void
  const resume = vi.fn(() => {
    activity.mockResolvedValue([{ ...row, reviewProgress: progress }])
    execution.mockResolvedValue({ active: true, runId: progress.runId })
    return new Promise<void>(resolve => { finishResume = resolve })
  })
  const cancel = vi.fn(() => {
    activity.mockResolvedValue([{ ...row, status: 'cancelled', supervisionStatus: 'cancelled', reviewProgress: progress }])
    execution.mockResolvedValue({ active: true, runId: progress.runId, stopping: 'cancelled' })
    return new Promise<void>(resolve => { finishCancel = resolve })
  })
  vi.stubGlobal('goodbuddy', { supervision: { activity, execution, resume, cancel } })
  render(<SupervisorActivity active projects={[]} onOpenResult={vi.fn()} />)
  await act(() => vi.advanceTimersByTimeAsync(0))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '继续已保存回顾' })))
  await act(() => vi.advanceTimersByTimeAsync(10000))
  expect(resume).toHaveBeenCalledExactlyOnceWith({ runId: progress.runId })
  expect(screen.getByRole('button', { name: '暂停回顾' })).toBeEnabled()
  expect(screen.getByRole('button', { name: '取消回顾' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '取消回顾' }))
  expect(cancel).toHaveBeenCalledExactlyOnceWith({ runId: progress.runId })
  await act(async () => finishResume())
  expect(screen.getByRole('status')).toHaveTextContent('正在取消回顾')
  expect(screen.getByRole('button', { name: '取消回顾' })).toBeDisabled()
  execution.mockResolvedValue({ active: false })
  await act(async () => finishCancel())
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '继续已保存回顾' })).not.toBeInTheDocument()
})

it('shows a failed suggestion step as an updated review and retries only suggestions', async () => {
  const activity = vi.fn().mockResolvedValue([{ ...row, status: 'completed', supervisionStatus: 'completed', resultId: 'r1',
    suggestionStatus: 'failed', suggestionError: 'Phrase failed', suggestionCount: 0, completedAt: '2026-09-23T10:00:01Z' }])
  const retrySuggestions = vi.fn().mockResolvedValue(2)
  vi.stubGlobal('goodbuddy', { supervision: { activity, execution: vi.fn().mockResolvedValue({ active: false }), retrySuggestions } })
  render(<SupervisorActivity active projects={[]} onOpenResult={vi.fn()} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('回顾已更新，建议生成失败。')
  expect(screen.getByRole('button', { name: '查看回顾' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '重新生成建议' }))
  await waitFor(() => expect(retrySuggestions).toHaveBeenCalledWith({ heartbeatRunId: row.id }))
})

it('shows no-change execution without a new result action', async () => {
  vi.stubGlobal('goodbuddy', { supervision: { activity: vi.fn().mockResolvedValue([{
    ...row, status: 'no_change', heartbeatStatus: 'no_change', supervisionStatus: 'no_change',
    summary: null, completedAt: '2026-09-23T10:00:01Z'
  }]) } })
  render(<SupervisorActivity active projects={[]} onOpenResult={vi.fn()} />)
  expect(await screen.findByText('无变化（未调用模型）')).toBeVisible()
  // The heartbeat has no report stage of its own; only the review stage is shown.
  expect(screen.queryByText(/心跳报告/)).not.toBeInTheDocument()
  expect(screen.getByText('监督回顾: 无变化（未调用模型）')).toBeVisible()
  expect(screen.queryByRole('button', { name: '查看回顾' })).not.toBeInTheDocument()
})

it('cancels the automatic review ID and keeps cancelling visible until execution cleanup finishes', async () => {
  vi.useFakeTimers()
  const progress = { runId: 'review-id', phase: 'extracting', batches: 1, characters: 1000, sources: 2, remainingSources: 1, complete: false }
  const activity = vi.fn().mockResolvedValue([{ ...row, reviewProgress: progress }])
  const execution = vi.fn().mockResolvedValue({ active: true, runId: progress.runId })
  let finish!: () => void
  const cancel = vi.fn(() => {
    activity.mockResolvedValue([{ ...row, status: 'cancelled', supervisionStatus: 'cancelled', error: 'Cancelled', reviewProgress: progress }])
    execution.mockResolvedValue({ active: true, runId: progress.runId, stopping: 'cancelled' })
    return new Promise<void>(resolve => { finish = resolve })
  })
  const pause = vi.fn()
  vi.stubGlobal('goodbuddy', { supervision: { activity, execution, cancel, pause } })
  const { container } = render(<SupervisorActivity active projects={[]} onOpenResult={vi.fn()} onPlanChange={vi.fn()} />)
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(screen.getByLabelText('监督计划')).toBeEnabled()
  expect(screen.queryByText('监督计划')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '暂停回顾' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '取消回顾' }))
  expect(cancel).toHaveBeenCalledExactlyOnceWith({ runId: 'review-id' })
  expect(screen.getByRole('status')).toHaveTextContent('正在取消回顾')
  expect(screen.getByRole('button', { name: '暂停回顾' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '取消回顾' })).toBeDisabled()
  await act(() => vi.advanceTimersByTimeAsync(2000))
  expect(screen.getByRole('status')).toHaveTextContent('正在取消回顾')
  expect(container.querySelector('[data-phase="extracting"]')).toHaveAttribute('data-state', 'cancelling')
  expect(screen.queryByText('已取消')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '继续已保存回顾' })).not.toBeInTheDocument()
  execution.mockResolvedValue({ active: false })
  await act(async () => finish())
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.getAllByText('已取消')).toHaveLength(2)
  expect(screen.queryByRole('button', { name: /取消回顾|暂停回顾|继续已保存回顾/ })).not.toBeInTheDocument()
  expect(screen.queryByText('本次运行失败，请查看错误详情后继续。已保存的批次仍保留。')).not.toBeInTheDocument()
  expect(pause).not.toHaveBeenCalled()
})

it('rediscovers cancellation cleanup on mount and blocks resuming another saved run', async () => {
  vi.useFakeTimers()
  const progress = { runId: 'review-id', batches: 1, characters: 1000, sources: 2, remainingSources: 1, complete: false }
  const activity = vi.fn().mockResolvedValue([
    { ...row, status: 'cancelled', supervisionStatus: 'cancelled', reviewProgress: progress },
    { ...row, id: 'paused', status: 'paused', supervisionStatus: 'paused', reviewProgress: { ...progress, runId: 'paused-review' } }
  ])
  const execution = vi.fn().mockResolvedValue({ active: true, runId: progress.runId, stopping: 'cancelled' })
  const resume = vi.fn()
  vi.stubGlobal('goodbuddy', { supervision: { activity, execution, resume } })
  render(<SupervisorActivity active projects={[]} onOpenResult={vi.fn()} />)
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(screen.getByRole('status')).toHaveTextContent('正在取消回顾')
  expect(screen.getByRole('button', { name: '继续已保存回顾' })).toBeDisabled()
  execution.mockResolvedValue({ active: false })
  await act(() => vi.advanceTimersByTimeAsync(2000))
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '继续已保存回顾' })).toBeEnabled()
  execution.mockResolvedValue({ active: true, runId: 'new-automatic' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '继续已保存回顾' })))
  expect(resume).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toHaveTextContent('新回顾正在整理')
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
  expect(screen.queryByText(/心跳报告/)).not.toBeInTheDocument()
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
  expect(screen.getByText(/全局 · 用户触发/)).toBeVisible()
})

it.each(['summarizing', 'saving', undefined] as const)('renders saved phase %s without mistaking zero remaining for publication', async phase => {
  const resume = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('goodbuddy', { supervision: { activity: vi.fn().mockResolvedValue([{
    ...row, status: 'failed', supervisionStatus: 'failed', error: 'Missing arrays\n'.repeat(100),
    reviewProgress: { runId: 'saved-run', phase, navigationNodes: 1, batches: 6, characters: 4515, sources: 32, remainingSources: 0, complete: false,
      settings: { pageSize: 50, batchCharacters: 8000, batchMessages: 20, executionSeconds: 300, timeoutSeconds: 240, concurrency: 1 } }
  }]), resume } })
  const { container } = render(<SupervisorActivity active projects={[]} onOpenResult={vi.fn()} />)
  expect(await screen.findByText('已保存 6 批 · 剩余 0 个来源')).toBeVisible()
  const detailedProgress = screen.getByText('已保存 6 批 · 已读 4515 个字符 · 剩余 0 个来源')
  expect(detailedProgress).not.toBeVisible()
  expect(container.querySelector('[data-phase="saving"]')).toHaveAttribute('data-state', phase === 'saving' ? 'failed' : phase ? 'pending' : 'unknown')
  expect(container.querySelector('[data-phase="summarizing"]')).toHaveAttribute('data-state', phase === 'saving' ? 'completed' : phase ? 'failed' : 'unknown')
  expect(container.querySelector('.supervisor-activity__diagnostics')).not.toHaveAttribute('open')
  expect(container.querySelector('.supervisor-activity__advanced')).not.toHaveAttribute('open')
  expect(screen.getByText('本次回顾的已保存配置')).not.toBeVisible()
  fireEvent.click(container.querySelector('.supervisor-activity__advanced > summary')!)
  expect(detailedProgress).toBeVisible()
  expect(screen.getByText('本次回顾的已保存配置')).toBeVisible()
  const action = screen.getByRole('button', { name: phase === 'summarizing' ? '继续合并摘要' : phase === 'saving' ? '重试发布' : '继续已保存回顾' })
  expect(action.compareDocumentPosition(container.querySelector('.supervisor-activity__diagnostics')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  fireEvent.click(action)
  await waitFor(() => expect(resume).toHaveBeenCalledWith({ runId: 'saved-run' }))
})

it('pages the saved project/conversation hierarchy on demand', async () => {
  const batch = (index: number) => ({ id: `batch-${index}`, projectId: `project-${index < 5 ? 1 : 2}`, conversationId: `conversation-${index < 5 ? 1 : 2}`,
    evidence: [{ id: `source-${index}`, sourceType: 'conversation', title: `Conversation ${index < 5 ? 1 : 2}`, content: 'Source text', sourceId: 'conversation' }],
    output: { summary: `Saved batch ${index}`, changeDigest: '', openItems: [], events: [], entities: [], entityChanges: [], relations: [] } })
  const batches = vi.fn().mockResolvedValueOnce(Array.from({ length: 10 }, (_, index) => batch(index))).mockResolvedValueOnce([batch(10)])
  vi.stubGlobal('goodbuddy', { supervision: { activity: vi.fn().mockResolvedValue([{ ...row,
    reviewProgress: { runId: 'saved-run', batches: 11, characters: 4515, sources: 32, remainingSources: 0, complete: false, phase: 'summarizing' }
  }]), batches } })
  render(<SupervisorActivity active projects={[]} onOpenResult={vi.fn()} />)
  const toggle = await screen.findByRole('button', { name: '已保留事实与来源' })
  expect(batches).not.toHaveBeenCalled()
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await screen.findByText(/Conversation 1/, { selector: 'summary' })
  expect(screen.getByText('Saved batch 0', { exact: false, selector: '.supervisor-activity__batch-label' })).not.toBeVisible()
  fireEvent.click(screen.getByText(/Conversation 1/, { selector: 'summary' }))
  expect(screen.getByText('Saved batch 0', { exact: false, selector: '.supervisor-activity__batch-label' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  await waitFor(() => expect(batches).toHaveBeenLastCalledWith({ runId: 'saved-run', offset: 10, limit: 10 }))
  await screen.findByText(/Saved batch 10/, { selector: '.supervisor-activity__batch-label' })
  expect(screen.queryByText(/Saved batch 0/, { selector: '.supervisor-activity__batch-label' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
})

it('retains hierarchy expansion on saved-batch refresh and retries a failed page without mislabelling old rows', async () => {
  const batch = { id: 'batch', projectId: 'project', conversationId: 'conversation', evidence: [],
    output: { summary: 'Saved summary', changeDigest: '', openItems: [], events: [], entities: [], entityChanges: [], relations: [] } }
  const rows = Array.from({ length: 10 }, (_, index) => ({ ...batch, id: `batch-${index}` }))
  const batches = vi.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([...rows])
    .mockRejectedValueOnce(new Error('Page read failed')).mockResolvedValueOnce([{ ...batch, id: 'last', output: { ...batch.output, summary: 'Last batch' } }])
  vi.stubGlobal('goodbuddy', { supervision: { batches } })
  const view = render(<SupervisionBatchDetails runId="run" revision={10} />)
  const conversation = await screen.findByText(/conversation/, { selector: 'summary' })
  fireEvent.click(conversation)
  view.rerender(<SupervisionBatchDetails runId="run" revision={11} />)
  await waitFor(() => expect(batches).toHaveBeenCalledTimes(2))
  expect(conversation.closest('details')).toHaveAttribute('open')
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  await screen.findByText('Error: Page read failed')
  expect(screen.queryByText(/Saved summary/, { selector: '.supervisor-activity__batch-label' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await screen.findByText(/Last batch/, { selector: '.supervisor-activity__batch-label' })
  expect(batches).toHaveBeenLastCalledWith({ runId: 'run', offset: 10, limit: 10 })
})

it.each(['collecting', 'extracting', 'summarizing', 'saving'] as const)('shows running %s as active with later stages pending', async phase => {
  vi.stubGlobal('goodbuddy', { supervision: { activity: vi.fn().mockResolvedValue([{ ...row,
    reviewProgress: { runId: 'run', phase, batches: 6, characters: 4515, sources: 32, remainingSources: 0, complete: false, inFlight: 1 }
  }]) } })
  const { container } = render(<SupervisorActivity active projects={[]} onOpenResult={vi.fn()} />)
  await screen.findByRole('button', { name: '暂停回顾' })
  expect(container.querySelector(`[data-phase="${phase}"]`)).toHaveAttribute('data-state', 'running')
  expect(container.querySelector(`[data-phase="${phase}"]`)).toHaveAttribute('aria-current', 'step')
  expect(container.querySelector('[data-phase="saving"]')).toHaveAttribute('data-state', phase === 'saving' ? 'running' : 'pending')
})

it('resets pagination on a plan change and ignores the previous page response', async () => {
  vi.useFakeTimers()
  let resolve!: (value: Activity[]) => void
  const activity = vi.fn().mockResolvedValueOnce(Array.from({ length: 50 }, (_, index) => ({ ...row, id: String(index) })))
    .mockImplementationOnce(() => new Promise<Activity[]>(done => { resolve = done }))
    .mockResolvedValue([])
  vi.stubGlobal('goodbuddy', { supervision: { activity } })
  const props = { active: true, projects: [], onOpenResult: vi.fn() }
  const view = render(<SupervisorActivity {...props} configId="first-plan" />)
  await act(() => vi.advanceTimersByTimeAsync(0))
  fireEvent.click(screen.getByRole('button', { name: '更早记录' }))
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(activity).toHaveBeenLastCalledWith({ limit: 50, offset: 50, configId: 'first-plan' })
  view.rerender(<SupervisorActivity {...props} configId="second-plan" />)
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(activity).toHaveBeenLastCalledWith({ limit: 50, offset: 0, configId: 'second-plan' })
  await act(async () => resolve([{ ...row, summary: 'Wrong plan result' }]))
  expect(screen.queryByText('Wrong plan result')).not.toBeInTheDocument()
  expect(screen.getByText('此计划暂无执行记录')).toBeVisible()
})
