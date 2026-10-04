import { act, cleanup, fireEvent, render as renderComponent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { SupervisorWorkspace } from './SupervisorWorkspace'
import { changeUiLocale, i18nResources } from './i18n'

const result = { id: 'result-1', storyLineId: 'story', sourceId: null, summary: 'Recap', changeDigest: '', createdAt: '2026-09-22T00:00:00.000Z', scope: { kind: 'global' }, timeRange: { from: '2026-09-20T00:00:00.000Z', to: '2026-09-22T00:00:00.000Z' }, openItems: [] }
const render = (ui: React.ReactNode) => {
  if (window.goodbuddy?.supervision) window.goodbuddy.supervision.execution ??= vi.fn().mockResolvedValue({ active: false })
  return renderComponent(ui)
}

describe('SupervisorWorkspace', () => {
  it('keeps source lookup failures retryable through notifications', async () => {
    const onNotify = vi.fn()
    const source = vi.fn().mockRejectedValueOnce(new TypeError('terminated')).mockResolvedValueOnce({ title: 'Source', content: 'Saved source', occurredAt: result.createdAt })
    window.goodbuddy = { supervision: {
      overview: async () => [result], source,
      graph: async () => ({ storyLine: null, events: [{ id: 'event', title: 'Event', description: '', occurred_at: result.createdAt }],
        entities: [], relations: [], eventEntities: [], sources: [{ id: 'source', title: 'Source', occurred_at: result.createdAt }],
        eventSources: [{ event_id: 'event', source_id: 'source' }] })
    } } as never
    render(<SupervisorWorkspace tab="graph" onNotify={onNotify} />)
    fireEvent.click(await screen.findByRole('button', { name: /Source/ }))
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith({ tone: 'error', message: i18nResources['zh-CN'].heartbeat.supervisor.sourceLoadFailed }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Source/ }))
    expect(await screen.findByText('Saved source')).toBeVisible()
  })
  it.each(['conversation', 'knowledge'])('opens only conversation sources without replacing the saved %s snapshot', async (sourceType) => {
    const onOpenConversation = vi.fn()
    const source = vi.fn(async () => ({ sourceType, sourceId: 'original-conversation', title: 'Original source', content: 'Saved snapshot', occurredAt: result.createdAt }))
    window.goodbuddy = { supervision: {
      overview: async () => [result], source,
      graph: async () => ({ storyLine: null,
        events: [{ id: 'event', title: 'Event', description: '', occurred_at: result.createdAt }],
        entities: [], relations: [], eventEntities: [],
        sources: [{ id: 'source', title: 'Original source', occurred_at: result.createdAt }],
        eventSources: [{ event_id: 'event', source_id: 'source' }] })
    } } as never
    render(<SupervisorWorkspace tab="graph" onOpenConversation={onOpenConversation} />)
    fireEvent.click(await screen.findByRole('button', { name: /Original source/ }))
    expect(await screen.findByText('Saved snapshot')).toBeVisible()
    expect(onOpenConversation).not.toHaveBeenCalled()
    if (sourceType === 'conversation') {
      fireEvent.click(screen.getByRole('button', { name: '打开会话' }))
      expect(onOpenConversation).toHaveBeenCalledWith('original-conversation')
    } else {
      expect(screen.queryByRole('button', { name: '打开会话' })).not.toBeInTheDocument()
    }
    expect(source).toHaveBeenCalledOnce()
  })
  it('keeps dated historical content and exact graph selection when configuring and running a new review', async () => {
    const old = { ...result, id: 'old', summary: 'Earlier conclusion.\n\nImportant final conclusion.', changeDigest: 'Confirmed change', openItems: ['Pending decision'], createdAt: '2026-08-22T00:00:00.000Z' }
    let finish!: () => void
    const run = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const graph = vi.fn(async () => ({ storyLine: null, events: [], entities: [], relations: [], sources: [], eventEntities: [], eventSources: [] }))
    window.goodbuddy = { supervision: { overview: async () => [result, old], graph, run } } as never
    const onTabChange = vi.fn()
    const onNotify = vi.fn()
    const project = { id: 'project', name: 'New project', description: '', status: 'active', kind: 'user', rootPath: 'C:\\project', executionSpace: { kind: 'local', rootPath: 'C:\\project' }, createdAt: result.createdAt, updatedAt: result.createdAt } as const
    render(<SupervisorWorkspace projects={[project]} onTabChange={onTabChange} onNotify={onNotify} />)
    const history = await screen.findByLabelText('历史结果')
    await waitFor(() => expect(history).toBeEnabled())
    fireEvent.change(history, { target: { value: 'old' } })
    await waitFor(() => expect(history).toBeEnabled())
    expect(history).toHaveValue('old')
    expect(screen.queryByText('最近一次成功回顾')).not.toBeInTheDocument()
    expect(screen.getByText('Important final conclusion.')).toBeVisible()
    expect(screen.getByText('Confirmed change')).toBeVisible()
    expect(screen.getByText('Pending decision')).toBeVisible()
    const recap = screen.getByRole('article')
    const frozenText = recap.textContent
    fireEvent.change(screen.getByLabelText('时间范围'), { target: { value: '30' } })
    fireEvent.change(screen.getByLabelText('关注范围'), { target: { value: project.id } })
    expect(recap.textContent).toBe(frozenText)
    fireEvent.click(screen.getByRole('button', { name: '故事线图谱' }))
    expect(onTabChange).toHaveBeenCalledWith('graph')
    expect(graph).toHaveBeenLastCalledWith({ resultId: 'old', storyLineId: 'story' })
    fireEvent.click(screen.getByRole('button', { name: '回顾' }))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(recap.textContent).toBe(frozenText)
    expect(screen.getByText('Important final conclusion.')).toBeVisible()
    expect(onNotify).toHaveBeenLastCalledWith({ tone: 'info', message: i18nResources['zh-CN'].heartbeat.supervisor.reviewStarted, dedupeKey: 'supervisor-review' })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '回顾' })).toBeEnabled()
    expect(screen.getByLabelText('关注范围')).toBeEnabled()
    expect(screen.getByLabelText('时间范围')).toBeEnabled()
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
    expect(screen.queryByText('关注范围')).not.toBeInTheDocument()
    expect(screen.queryByText('时间范围')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '回顾' }))
    expect(onNotify).toHaveBeenLastCalledWith(expect.objectContaining({ message: i18nResources['zh-CN'].heartbeat.supervisor.reviewBusy }))
    expect(run).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: 'projects', projectIds: [project.id] } }))
    await act(async () => finish())
    expect(onNotify).toHaveBeenLastCalledWith(expect.objectContaining({ tone: 'success' }))
    expect(history).toHaveValue('old')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
  it('loads silently and checks automatic execution before starting, including stopping cleanup', async () => {
    vi.useFakeTimers()
    const execution = vi.fn().mockResolvedValue({ active: true, runId: 'automatic', stopping: 'cancelled' })
    const run = vi.fn().mockResolvedValue(undefined)
    const cancel = vi.fn()
    window.goodbuddy = { supervision: { execution, overview: async () => [], run, cancel } } as never
    const onNotify = vi.fn()
    const view = render(<SupervisorWorkspace onNotify={onNotify} />)
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(onNotify).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(cancel).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '回顾' })))
    expect(onNotify).toHaveBeenLastCalledWith(expect.objectContaining({ message: i18nResources['zh-CN'].heartbeat.reviewSettings.cancelling }))
    expect(run).not.toHaveBeenCalled()
    execution.mockResolvedValue({ active: false })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '回顾' })))
    expect(run).toHaveBeenCalledOnce()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    view.unmount()
    const calls = execution.mock.calls.length
    await act(() => vi.advanceTimersByTimeAsync(10000))
    expect(execution).toHaveBeenCalledTimes(calls)
    vi.useRealTimers()
  })

  it('turns a backend busy race into a dismissible ongoing notice', async () => {
    const run = vi.fn().mockRejectedValue(new Error('SUPERVISION_REVIEW_BUSY'))
    window.goodbuddy = { supervision: { overview: async () => [], run } } as never
    const onNotify = vi.fn()
    render(<SupervisorWorkspace onNotify={onNotify} />)
    await screen.findByText('还没有成功回顾')
    fireEvent.click(screen.getByRole('button', { name: '回顾' }))
    await waitFor(() => expect(onNotify).toHaveBeenLastCalledWith({ tone: 'info', message: i18nResources['zh-CN'].heartbeat.supervisor.reviewBusy, dedupeKey: 'supervisor-review' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '回顾' })).toBeEnabled()
  })
  it('graph navigation discards a late overview before it can request the old graph', async () => {
    let resolveOverview!: (value: unknown) => void
    const overview = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOverview = resolve })).mockResolvedValue([result])
    const graph = vi.fn(async () => ({ storyLine: null, events: [], entities: [], relations: [], sources: [], eventEntities: [], eventSources: [] }))
    window.goodbuddy = { supervision: { overview, graph } } as never
    const view = render(<SupervisorWorkspace tab="graph" graphNavigation={{ resultId: 'old' }} />)
    await waitFor(() => expect(overview).toHaveBeenCalledTimes(1))
    view.rerender(<SupervisorWorkspace tab="graph" graphNavigation={{ resultId: result.id }} />)
    await waitFor(() => expect(graph).toHaveBeenCalledTimes(1))
    await act(async () => resolveOverview([result]))
    expect(graph).toHaveBeenCalledTimes(1)
    expect(graph).toHaveBeenCalledWith({ resultId: result.id, storyLineId: result.storyLineId })
  })

  it('graph navigation discards a late source response even when the new graph shares its source ID', async () => {
    let resolveSource!: (value: unknown) => void
    const source = vi.fn(() => new Promise(resolve => { resolveSource = resolve }))
    const graph = vi.fn(async () => ({ storyLine: null, events: [{ id: 'event', title: 'Event', description: '', occurred_at: result.createdAt }], entities: [], relations: [], sources: [{ id: 'source', title: 'Source', occurred_at: result.createdAt }], eventEntities: [], eventSources: [{ event_id: 'event', source_id: 'source' }] }))
    window.goodbuddy = { supervision: { overview: async () => [result], graph, source } } as never
    const view = render(<SupervisorWorkspace tab="graph" graphNavigation={{ resultId: 'A' }} />)
    fireEvent.click(await screen.findByRole('button', { name: /Source/ }))
    view.rerender(<SupervisorWorkspace tab="graph" graphNavigation={{ resultId: 'B' }} />)
    expect(screen.queryByRole('group', { name: '故事线图谱' })).not.toBeInTheDocument()
    await waitFor(() => expect(graph).toHaveBeenCalledTimes(2))
    await act(async () => resolveSource({ title: 'Source', content: 'Stale body', occurredAt: result.createdAt }))
    expect(screen.queryByText('Stale body')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Source/ })).toBeEnabled()
  })

  it('graph navigation shares history selection and rejects late graph responses', async () => {
    const a = { ...result, id: 'A', summary: 'A recap' }
    const b = { ...result, id: 'B', summary: 'B recap' }
    const graphFor = (title: string) => ({ storyLine: null, events: [{ id: title, title, description: title, occurred_at: result.createdAt }], entities: [], relations: [], sources: [], eventEntities: [], eventSources: [] })
    let resolveA!: (value: unknown) => void
    const graph = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve })).mockResolvedValue(graphFor('B event'))
    window.goodbuddy = { supervision: { overview: async () => [b, a], graph } } as never
    const navigation = { resultId: 'A' }
    const view = render(<SupervisorWorkspace tab="graph" graphNavigation={navigation} />)
    await waitFor(() => expect(graph).toHaveBeenCalledWith({ resultId: 'A', storyLineId: 'story' }))
    const next = { resultId: 'B' }
    view.rerender(<SupervisorWorkspace tab="graph" graphNavigation={next} />)
    await screen.findByRole('group', { name: '故事线图谱' })
    await act(async () => resolveA(graphFor('Stale A')))
    expect(screen.queryByText('Stale A')).not.toBeInTheDocument()
    view.rerender(<SupervisorWorkspace graphNavigation={next} />)
    expect(screen.getByLabelText('历史结果')).toHaveValue('B')
    fireEvent.change(screen.getByLabelText('历史结果'), { target: { value: 'A' } })
    await waitFor(() => expect(graph).toHaveBeenLastCalledWith({ resultId: 'A', storyLineId: 'story' }))
    view.rerender(<SupervisorWorkspace tab="graph" graphNavigation={{ resultId: 'B' }} />)
    await waitFor(() => expect(graph).toHaveBeenLastCalledWith({ resultId: 'B', storyLineId: 'story' }))
    expect(graph).toHaveBeenCalledTimes(4)
  })

  it('graph navigation requests results outside overview and keeps missing results retryable without latest fallback', async () => {
    const graph = vi.fn().mockRejectedValue(new Error('Missing requested result'))
    window.goodbuddy = { supervision: { overview: async () => [result], graph } } as never
    render(<SupervisorWorkspace tab="graph" graphNavigation={{ resultId: 'older' }} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(i18nResources['zh-CN'].heartbeat.supervisor.loadFailed)
    expect(screen.queryByText('Missing requested result')).not.toBeInTheDocument()
    expect(graph).toHaveBeenCalledWith({ resultId: 'older', storyLineId: undefined })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(graph).toHaveBeenCalledTimes(2))
    expect(graph).toHaveBeenLastCalledWith({ resultId: 'older', storyLineId: undefined })
    expect(screen.queryByText('Recap')).not.toBeInTheDocument()
  })
  it('opens the selected result graph and ignores a late response from another project', async () => {
    const a = { ...result, id: 'A', storyLineId: 'story-A', summary: 'A recap' }
    const b = { ...result, id: 'B', storyLineId: 'story-B', summary: 'B recap' }
    const graphFor = (title: string) => ({ storyLine: null, events: [{ id: title, title, description: title, occurred_at: result.createdAt }], entities: [], relations: [], sources: [], eventEntities: [], eventSources: [] })
    let resolveA!: (value: unknown) => void
    const graph = vi.fn().mockResolvedValueOnce(graphFor('B event')).mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve })).mockResolvedValueOnce(graphFor('B selected'))
    window.goodbuddy = { supervision: { overview: async () => [b, a], graph } } as never
    const onTabChange = vi.fn()
    const view = render(<SupervisorWorkspace onTabChange={onTabChange} />)
    await screen.findByText('B recap')
    // The history select is identified by its selected result ID, not scope labels.
    const select = [...document.querySelectorAll('select')].find((element) => element.value === 'B')!
    fireEvent.change(select, { target: { value: 'A' } })
    await waitFor(() => expect(graph).toHaveBeenLastCalledWith({ resultId: 'A', storyLineId: 'story-A' }))
    fireEvent.change(select, { target: { value: 'B' } })
    await waitFor(() => expect(graph).toHaveBeenLastCalledWith({ resultId: 'B', storyLineId: 'story-B' }))
    await act(async () => resolveA(graphFor('Wrong A event')))
    fireEvent.click(screen.getByRole('button', { name: '故事线图谱' }))
    expect(onTabChange).toHaveBeenCalledWith('graph')
    view.rerender(<SupervisorWorkspace tab="graph" onTabChange={onTabChange} />)
    expect(within(await screen.findByRole('group', { name: '故事线图谱' })).getByRole('button', { name: 'B selected' })).toBeInTheDocument()
    expect(screen.queryByText('Wrong A event')).not.toBeInTheDocument()
  })
  it('uses existing theme tokens for the supervisor workspace', () => {
    const css = readFileSync('src/renderer/src/supervisor-workspace.css', 'utf8')
    const tokens = readFileSync('src/renderer/src/styles.css', 'utf8')
    for (const [, token] of css.matchAll(/var\((--[\w-]+)\)/g)) {
      expect(tokens, token).toContain(`${token}:`)
    }
  })
  afterEach(async () => { cleanup(); vi.useRealTimers(); window.goodbuddy = {} as never; await changeUiLocale('zh-CN') })
  it('shows unavailable immediately and does not call supervision APIs when the bridge is absent', () => {
    window.goodbuddy = {} as never

    render(<SupervisorWorkspace />)

    expect(screen.getByText('监督者服务暂不可用')).toBeInTheDocument()
    expect(screen.queryByText('正在读取监督回顾…')).not.toBeInTheDocument()
  })

  it('keeps loading while the available bridge is resolving', async () => {
    const overview = vi.fn(() => new Promise<unknown[]>(() => undefined))
    const graph = vi.fn(() => new Promise<Record<string, unknown>>(() => undefined))
    window.goodbuddy = { supervision: { overview, graph } } as never

    render(<SupervisorWorkspace />)

    expect(screen.getByText('正在读取监督回顾')).toBeInTheDocument()
    await waitFor(() => {
      expect(overview).toHaveBeenCalledOnce()
      expect(graph).not.toHaveBeenCalled()
    })
  })

  it('keeps the manual review entry when there are no heartbeat plans', async () => {
    window.goodbuddy = { supervision: {
      overview: vi.fn(async () => []), graph: vi.fn(async () => ({ storyLine: null, events: [], entities: [], relations: [], sources: [], eventEntities: [], eventSources: [] })),
      run: vi.fn(async () => undefined), source: vi.fn()
    } } as never
    render(<SupervisorWorkspace />)
    await waitFor(() => expect(screen.getByText('还没有成功回顾')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '回顾' }))
    await waitFor(() => expect(window.goodbuddy.supervision.run).toHaveBeenCalledOnce())
    expect(window.goodbuddy.supervision.run).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'manual', scope: { kind: 'global' } }))
    // The default review is incremental; it never asks to re-read the interval.
    expect(vi.mocked(window.goodbuddy.supervision.run).mock.calls[0]![0]).not.toHaveProperty('reanalyze')
  })

  it('reanalyzes only after an explicit confirmation from the more menu', async () => {
    const run = vi.fn(async () => undefined)
    window.goodbuddy = { supervision: {
      overview: vi.fn(async () => []), graph: vi.fn(async () => ({ storyLine: null, events: [], entities: [], relations: [], sources: [], eventEntities: [], eventSources: [] })),
      run, source: vi.fn()
    } } as never
    render(<SupervisorWorkspace />)
    await screen.findByText('还没有成功回顾')
    fireEvent.click(screen.getByRole('button', { name: '更多回顾操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '重新整理…' }))
    const dialog = screen.getByRole('alertdialog', { name: '重新整理这段时间？' })
    expect(dialog).toHaveTextContent('可能产生较多模型用量')
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(run).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '更多回顾操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '重新整理…' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '重新整理' }))
    await waitFor(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'manual', reanalyze: true })))
  })

  it('notifies review failures and allows a new review without a workspace error banner', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('Review provider unavailable')).mockResolvedValueOnce(undefined)
    window.goodbuddy = { supervision: {
      overview: async () => [],
      graph: async () => ({ storyLine: null, events: [{ id: 'event', title: 'Decision', description: '', occurred_at: '2026-09-21T00:00:00.000Z' }], entities: [], relations: [], sources: [], eventEntities: [], eventSources: [] }),
      run
    } } as never
    const onNotify = vi.fn()
    render(<SupervisorWorkspace onNotify={onNotify} />)
    await screen.findByText('还没有成功回顾')
    fireEvent.click(screen.getByRole('button', { name: '回顾' }))
    await waitFor(() => expect(onNotify).toHaveBeenLastCalledWith(expect.objectContaining({ tone: 'error', message: i18nResources['zh-CN'].heartbeat.supervisor.reviewFailed })))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '回顾' }))
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it.each(['zh-CN', 'en-US'] as const)('localizes failures after refresh and preserves request controls in %s', async locale => {
    await changeUiLocale(locale)
    const copy = i18nResources[locale].heartbeat
    let reject!: (reason: Error) => void
    const run = vi.fn(() => new Promise((_, fail) => { reject = fail }))
    const onNotify = vi.fn()
    window.goodbuddy = { supervision: { overview: async () => [], run } } as never
    render(<SupervisorWorkspace onNotify={onNotify} />)
    await screen.findByText(copy.supervisor.empty)
    fireEvent.change(screen.getByLabelText(copy.supervisor.period), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: copy.supervisor.run }))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: copy.center.actions.refresh }))
    await waitFor(() => expect(screen.getByRole('button', { name: copy.center.actions.refresh })).toBeEnabled())
    await act(async () => reject(new Error("Error invoking remote method 'supervision:run': TypeError: terminated")))
    expect(onNotify).toHaveBeenLastCalledWith({ tone: 'error', message: copy.supervisor.reviewFailed, dedupeKey: 'supervisor-review' })
    expect(screen.getByLabelText(copy.supervisor.period)).toHaveValue('30')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each(['completed', 'paused', 'cancelled', 'no_change', 'failed'] as const)('notifies %s once without an operation banner', async status => {
    const copy = i18nResources['zh-CN'].heartbeat
    const onNotify = vi.fn()
    window.goodbuddy = { supervision: { overview: async () => [], run: vi.fn().mockResolvedValue({ status }) } } as never
    render(<SupervisorWorkspace onNotify={onNotify} />)
    await screen.findByText(copy.supervisor.empty)
    fireEvent.click(screen.getByRole('button', { name: copy.supervisor.run }))
    const message = { completed: copy.supervisor.reviewCompleted, paused: copy.reviewSettings.pausedHint,
      cancelled: copy.supervisor.reviewCancelled, no_change: copy.supervisor.reviewNoChange, failed: copy.supervisor.reviewFailed }[status]
    await waitFor(() => {
      expect(onNotify).toHaveBeenCalledTimes(2)
      expect(onNotify).toHaveBeenLastCalledWith({ message, tone: status === 'completed' ? 'success' : status === 'failed' ? 'error' : 'info', dedupeKey: 'supervisor-review' })
      expect(screen.getByRole('button', { name: copy.center.actions.refresh })).toBeEnabled()
    })
    expect(document.querySelector('.supervisor-workspace__run-status')).toBeNull()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reports execution lookup failure without starting a review', async () => {
    const onNotify = vi.fn()
    const run = vi.fn()
    window.goodbuddy = { supervision: { overview: async () => [], execution: vi.fn().mockRejectedValue(new TypeError('terminated')), run } } as never
    render(<SupervisorWorkspace onNotify={onNotify} />)
    await screen.findByText('还没有成功回顾')
    expect(onNotify).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '回顾' }))
    await waitFor(() => expect(onNotify).toHaveBeenLastCalledWith(expect.objectContaining({ tone: 'error', message: i18nResources['zh-CN'].heartbeat.supervisor.reviewStartFailed })))
    expect(run).not.toHaveBeenCalled()
  })

  it.each(['preflight', 'running'] as const)('ignores late %s responses after unmount without cancelling background work', async phase => {
    let resolve!: (value: unknown) => void
    const deferred = new Promise(done => { resolve = done })
    const execution = vi.fn().mockImplementation(() => phase === 'preflight' ? deferred : Promise.resolve({ active: false }))
    const run = vi.fn(() => deferred)
    const cancel = vi.fn()
    const overview = vi.fn().mockResolvedValue([])
    const onNotify = vi.fn()
    window.goodbuddy = { supervision: { overview, execution, run, cancel } } as never
    const view = render(<SupervisorWorkspace onNotify={onNotify} />)
    await screen.findByText('还没有成功回顾')
    fireEvent.click(screen.getByRole('button', { name: '回顾' }))
    await waitFor(() => expect(phase === 'preflight' ? execution : run).toHaveBeenCalledOnce())
    view.unmount()
    onNotify.mockClear()
    await act(async () => resolve(phase === 'preflight' ? { active: false } : { status: 'completed' }))
    expect(onNotify).not.toHaveBeenCalled()
    expect(overview).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledTimes(phase === 'preflight' ? 0 : 1)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('draws only actual event to entity links and filters sources for the selected event', async () => {
    window.goodbuddy = { supervision: {
      overview: vi.fn(async () => [result]),
      graph: vi.fn(async () => ({ storyLine: { id: 'story', scope_json: '{"kind":"global"}' }, events: [{ id: 'event-1', title: '决定', description: 'd', occurred_at: '2026-09-21T00:00:00.000Z' }], entities: [{ id: 'entity-1', canonical_label: '方案', description: 'e', confirmation_state: 'automatic' }, { id: 'entity-2', canonical_label: '无关', description: 'e', confirmation_state: 'automatic' }], relations: [], sources: [{ id: 'source-1', title: '依据 1', occurred_at: '2026-09-21T00:00:00.000Z' }, { id: 'source-2', title: '依据 2', occurred_at: '2026-09-21T00:00:00.000Z' }], eventEntities: [{ event_id: 'event-1', entity_id: 'entity-1' }], eventSources: [{ event_id: 'event-1', source_id: 'source-1' }] })),
      run: vi.fn(), source: vi.fn(async () => ({ title: '依据 1', content: '正文', occurredAt: '2026-09-21T00:00:00.000Z' }))
    } } as never
    render(<SupervisorWorkspace tab="graph" />)
    const graph = await screen.findByRole('group', { name: '故事线图谱' })
    const list = screen.getByRole('complementary', { name: '图谱选择' })
    const canvas = screen.getByRole('region', { name: '故事图谱画布' })
    const inspector = screen.getByRole('complementary', { name: '详情与来源' })
    expect(Array.from(list.parentElement!.children)).toEqual([list, canvas, inspector])
    expect(within(list).getByRole('button', { name: /1\. 决定/ })).toBeInTheDocument()
    expect(within(canvas).queryByRole('heading', { name: '时间事件' })).not.toBeInTheDocument()
    expect(within(canvas).getByRole('group', { name: '故事线图谱' })).toHaveAttribute('width', '100%')
    expect(canvas.querySelector('.supervisor-workspace__timeline-ring')).toHaveAttribute('marker-end')
    // The legend is closed by default and opens on the canvas, so the graph keeps the column.
    expect(within(canvas).queryByRole('list', { name: '图谱图例' })).not.toBeInTheDocument()
    fireEvent.click(within(canvas).getByRole('button', { name: '图例' }))
    expect(within(canvas).getByRole('list', { name: '图谱图例' })).toBeInTheDocument()
    fireEvent.click(within(canvas).getByRole('button', { name: '关闭图例' }))
    expect(within(canvas).queryByRole('list', { name: '图谱图例' })).not.toBeInTheDocument()
    expect(within(canvas).getByRole('slider', { name: '事件浏览' })).toBeDisabled()
    expect(graph.querySelector('.supervisor-workspace__entity text')).toHaveTextContent('方案')
    expect(graph.querySelector('.supervisor-workspace__node text')).toHaveTextContent('决定')
    expect(document.querySelectorAll('[data-event-entity="event-1:entity-1"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-event-entity="event-1:entity-2"]')).toHaveLength(0)
    fireEvent.click(within(graph).getByRole('button', { name: '决定' }))
    const detail = screen.getByText('关联来源').parentElement
    expect(detail).toBeTruthy()
    expect(within(detail as HTMLElement).getByText(/依据 1/)).toBeInTheDocument()
    expect(within(detail as HTMLElement).queryByText(/依据 2/)).not.toBeInTheDocument()
  })

  it('lists stories by project and feature, lets users adjust them and move an event between stories', async () => {
    const story = (id: string, name: string, level: string, eventIds: string[], parentId: string | null = null) => ({
      id, projectId: level === 'cross' ? null : 'p', projectName: level === 'cross' ? null : 'goodbuddy', parentId, level, name, description: '',
      state: 'active', stateEventId: null, userEdited: false, startedAt: '2026-09-21T00:00:00.000Z', endedAt: '2026-09-21T00:00:00.000Z',
      events: eventIds.map(eventId => ({ id: eventId, title: eventId === 'event-1' ? '决定' : eventId, projectId: 'p', startedAt: '2026-09-21T00:00:00.000Z', endedAt: '2026-09-21T00:00:00.000Z', primary: level !== 'cross', userSet: false }))
    })
    const view = { stories: [story('11111111-1111-4111-8111-111111111111', '监督者', 'feature', ['event-1']),
      story('22222222-2222-4222-8222-222222222222', '回顾算法', 'thread', [], '11111111-1111-4111-8111-111111111111'),
      story('33333333-3333-4333-8333-333333333333', '笔记', 'feature', []),
      story('44444444-4444-4444-8444-444444444444', '果蝇', 'cross', ['event-1'])], experiences: [], unassigned: 2, canUndo: true }
    const stories = vi.fn(async () => view)
    const storyAction = vi.fn(async () => undefined)
    window.goodbuddy = { supervision: {
      overview: vi.fn(async () => [result]), stories, storyAction,
      graph: vi.fn(async () => ({ storyLine: { id: 'story', scope_json: '{"kind":"global"}' }, events: [{ id: 'event-1', title: '决定', description: 'd', occurred_at: '2026-09-21T00:00:00.000Z', project_id: 'p' }],
        entities: [], relations: [], sources: [], eventEntities: [], eventSources: [] }))
    } } as never
    render(<SupervisorWorkspace tab="graph" />)
    fireEvent.click(await screen.findByRole('tab', { name: '故事 4' }))
    expect(stories).toHaveBeenCalledWith({ scope: { kind: 'global' } })
    const list = screen.getByRole('complementary', { name: '图谱选择' })
    expect(within(list).getByRole('region', { name: 'goodbuddy' })).toBeInTheDocument()
    expect(within(list).getByRole('region', { name: '跨项目故事' })).toBeInTheDocument()
    expect(within(list).getByText('另有 2 个事件暂不归入任何故事。')).toBeInTheDocument()
    fireEvent.click(within(list).getByRole('button', { name: /监督者/ }))
    const inspector = screen.getByRole('complementary', { name: '详情与来源' })
    expect(within(inspector).getByRole('heading', { name: '监督者' })).toBeInTheDocument()
    fireEvent.change(within(inspector).getByRole('combobox', { name: '合并到' }), { target: { value: '33333333-3333-4333-8333-333333333333' } })
    fireEvent.click(within(inspector).getByRole('button', { name: '合并' }))
    await waitFor(() => expect(storyAction).toHaveBeenCalledWith({ action: 'merge', storyId: '11111111-1111-4111-8111-111111111111', intoId: '33333333-3333-4333-8333-333333333333' }))
    fireEvent.click(within(inspector).getByRole('button', { name: '撤销上次调整' }))
    await waitFor(() => expect(storyAction).toHaveBeenCalledWith({ action: 'undo' }))
    // Event detail: the story picker offers only the event's own project stories, not cross stories.
    fireEvent.click(within(inspector).getByRole('button', { name: /决定/ }))
    const picker = await within(inspector).findByRole('combobox', { name: '所属故事' })
    expect(within(picker).getAllByRole('option').map(option => option.textContent)).toEqual(['暂不归类', '监督者', '· 回顾算法', '笔记'])
    fireEvent.change(picker, { target: { value: '' } })
    await waitFor(() => expect(storyAction).toHaveBeenCalledWith({ action: 'move', eventId: 'event-1', storyId: null }))
  })

  it('organizes the work review by story for the selected period and opens a story in the graph', async () => {
    const story = (id: string, name: string, at: string[]) => ({
      id, projectId: 'p', projectName: 'goodbuddy', parentId: null, level: 'feature', name, description: '', state: 'active', stateEventId: null,
      userEdited: false, startedAt: at[0], endedAt: at.at(-1),
      events: at.map((value, index) => ({ id: `${id}-${index}`, title: `${name} 第 ${index + 1} 步`, projectId: 'p', startedAt: value, endedAt: value, primary: true, userSet: false }))
    })
    const view = { unassigned: 1, canUndo: false, stories: [
      story('11111111-1111-4111-8111-111111111111', '监督者', ['2026-09-10T00:00:00.000Z', '2026-09-21T00:00:00.000Z']),
      story('22222222-2222-4222-8222-222222222222', '时间螺旋', ['2026-09-21T06:00:00.000Z']),
      story('33333333-3333-4333-8333-333333333333', '笔记', ['2026-09-05T00:00:00.000Z'])
    ], experiences: [{ id: '55555555-5555-4555-8555-555555555555', statement: '先验证关键假设', conditions: '', boundaries: '', userEdited: false,
      events: [{ id: 'e', role: 'formed', note: '', title: '决定', projectId: 'p', at: '2026-09-21T00:00:00.000Z', storyId: 's', storyName: '监督者' }] }] }
    const stories = vi.fn(async () => view)
    const onTabChange = vi.fn()
    window.goodbuddy = { supervision: {
      overview: vi.fn(async () => [result]), stories, storyAction: vi.fn(),
      graph: vi.fn(async () => ({ storyLine: { id: 'story', scope_json: '{"kind":"global"}' }, events: [], entities: [], relations: [], sources: [], eventEntities: [], eventSources: [] }))
    } } as never
    render(<SupervisorWorkspace tab="overview" onTabChange={onTabChange} />)
    const digest = await screen.findByRole('article', { name: '按故事查看本次回顾' })
    await waitFor(() => expect(within(digest).getByRole('region', { name: /推进的故事/ })).toBeInTheDocument())
    expect(stories).toHaveBeenCalledWith({ scope: { kind: 'global' } })
    expect(within(within(digest).getByRole('region', { name: /推进的故事/ })).getByText('最近：监督者 第 2 步')).toBeInTheDocument()
    expect(within(within(digest).getByRole('region', { name: /新出现的故事/ })).getByText('时间螺旋')).toBeInTheDocument()
    expect(within(within(digest).getByRole('region', { name: /没有新进展/ })).getByRole('button', { name: '在图谱中查看 笔记' })).toBeInTheDocument()
    expect(within(within(digest).getByRole('region', { name: /经验/ })).getByText('先验证关键假设')).toBeInTheDocument()
    expect(within(digest).getByText('另有 1 个事件暂不归入任何故事。')).toBeInTheDocument()
    // The original summary stays as the reading entry below.
    expect(screen.getByText('Recap')).toBeInTheDocument()
    fireEvent.click(within(digest).getByRole('button', { name: '在图谱中查看 监督者' }))
    expect(onTabChange).toHaveBeenCalledWith('graph')
  })

  it('lists experiences with evidence and applications and lets users edit or delete them', async () => {
    const experience = { id: '55555555-5555-4555-8555-555555555555', statement: '先验证关键假设', conditions: '新方向', boundaries: '紧急修复', userEdited: false,
      events: [{ id: 'event-1', role: 'formed', note: '', title: '决定', projectId: 'p', at: '2026-09-21T00:00:00.000Z', storyId: 's', storyName: '监督者' },
        { id: 'event-2', role: 'applied', note: '少走弯路', title: '复用', projectId: 'p', at: '2026-09-22T00:00:00.000Z', storyId: 't', storyName: '笔记' }] }
    const storyAction = vi.fn(async () => undefined)
    window.goodbuddy = { supervision: {
      overview: vi.fn(async () => [result]), storyAction,
      stories: vi.fn(async () => ({ stories: [], experiences: [experience], unassigned: 0, canUndo: false })),
      graph: vi.fn(async () => ({ storyLine: { id: 'story', scope_json: '{"kind":"global"}' }, events: [{ id: 'event-1', title: '决定', description: 'd', occurred_at: '2026-09-21T00:00:00.000Z', project_id: 'p' }],
        entities: [], relations: [], sources: [], eventEntities: [], eventSources: [] }))
    } } as never
    render(<SupervisorWorkspace tab="graph" />)
    fireEvent.click(await screen.findByRole('tab', { name: '经验 1' }))
    const list = screen.getByRole('complementary', { name: '图谱选择' })
    fireEvent.click(within(list).getByRole('button', { name: /先验证关键假设/ }))
    const inspector = screen.getByRole('complementary', { name: '详情与来源' })
    expect(within(inspector).getByRole('heading', { name: '先验证关键假设' })).toBeInTheDocument()
    expect(within(inspector).getByText(/自动归纳/)).toBeInTheDocument()
    expect(within(inspector).getByRole('heading', { name: '形成依据（1）' })).toBeInTheDocument()
    expect(within(inspector).getByRole('button', { name: /复用.*少走弯路/ })).toBeInTheDocument()
    fireEvent.click(within(inspector).getByRole('button', { name: '编辑' }))
    fireEvent.change(within(inspector).getByRole('textbox', { name: '经验' }), { target: { value: '先验证关键假设，再扩大投入' } })
    fireEvent.click(within(inspector).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(storyAction).toHaveBeenCalledWith({ action: 'experience-edit', experienceId: experience.id, statement: '先验证关键假设，再扩大投入', conditions: '新方向', boundaries: '紧急修复' }))
    fireEvent.click(within(inspector).getByRole('button', { name: '删除经验' }))
    fireEvent.click(within(within(inspector).getByRole('alert')).getByRole('button', { name: '删除经验' }))
    await waitFor(() => expect(storyAction).toHaveBeenCalledWith({ action: 'experience-remove', experienceId: experience.id }))
    // The evidence event opens in the inspector.
    fireEvent.click(within(inspector).getByRole('button', { name: /决定/ }))
    expect(await within(inspector).findByText('d')).toBeInTheDocument()
  })

  it('steps through real events in time order and supports keyboard selection in the canvas', async () => {
    window.goodbuddy = { supervision: {
      overview: vi.fn(async () => [result]),
      graph: vi.fn(async () => ({ storyLine: null, events: [
        { id: 'later', title: 'Later event', description: 'Later detail', occurred_at: '2026-09-22T00:00:00.000Z' },
        { id: 'earlier', title: 'Earlier event', description: 'Earlier detail', occurred_at: '2026-09-21T00:00:00.000Z' }
      ], entities: [], relations: [], sources: [], eventEntities: [], eventSources: [] }))
    } } as never
    render(<SupervisorWorkspace tab="graph" />)
    const slider = await screen.findByRole('slider', { name: '事件浏览' })
    const inspector = screen.getByRole('complementary', { name: '详情与来源' })
    expect(slider).toHaveAttribute('aria-valuetext', '2. Later event')
    fireEvent.click(screen.getByRole('button', { name: '上一事件' }))
    expect(within(inspector).getByText('Earlier detail')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '上一事件' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '下一事件' }))
    expect(within(inspector).getByText('Later detail')).toBeInTheDocument()
    fireEvent.change(slider, { target: { value: '0' } })
    expect(within(inspector).getByText('Earlier detail')).toBeInTheDocument()
    const graph = screen.getByRole('group', { name: '故事线图谱' })
    fireEvent.keyDown(within(graph).getByRole('button', { name: 'Later event' }), { key: 'Enter' })
    expect(slider).toHaveValue('1')
    expect(within(inspector).getByText('Later detail')).toBeInTheDocument()
  })

  it('does not display a late source response under an unrelated selected event', async () => {
    let resolveSource!: (value: { title: string; content: string; occurredAt: string }) => void
    window.goodbuddy = { supervision: {
      overview: async () => [result],
      graph: async () => ({ storyLine: null,
        events: ['first', 'second'].map(id => ({ id, title: id, description: '', occurred_at: '2026-09-21T00:00:00.000Z' })),
        entities: [], relations: [], eventEntities: [],
        sources: [{ id: 'source', title: 'Original source', occurred_at: '2026-09-21T00:00:00.000Z' }],
        eventSources: [{ event_id: 'first', source_id: 'source' }] }),
      source: () => new Promise(resolve => { resolveSource = resolve })
    } } as never
    render(<SupervisorWorkspace tab="graph" />)
    const graph = await screen.findByRole('group', { name: '故事线图谱' })
    fireEvent.click(within(graph).getByRole('button', { name: 'first' }))
    fireEvent.click(screen.getByRole('button', { name: /Original source/ }))
    fireEvent.click(within(graph).getByRole('button', { name: 'second' }))
    resolveSource({ title: 'Original source', content: 'Only belongs to first', occurredAt: '2026-09-21T00:00:00.000Z' })
    await waitFor(() => expect(document.querySelector('.supervisor-workspace')).toHaveAttribute('aria-busy', 'false'))
    expect(screen.queryByText('Only belongs to first')).not.toBeInTheDocument()
    expect(screen.getByText('没有可用的关联来源。')).toBeInTheDocument()
  })

  it('spreads simultaneous events and keeps every record reachable across canvas batches', async () => {
    const events = Array.from({ length: 80 }, (_, index) => ({ id: `e${index}`, title: `事件 ${index}`, description: `详情 ${index}`, occurred_at: '2026-09-21T00:00:00.000Z' }))
    window.goodbuddy = { supervision: {
      overview: async () => [result], graph: async () => ({ storyLine: null, events, entities: [], relations: [], sources: [], eventEntities: [], eventSources: [] })
    } } as never
    render(<SupervisorWorkspace tab="graph" />)
    const graph = await screen.findByRole('group', { name: '故事线图谱' })
    const circles = [...graph.querySelectorAll('.supervisor-workspace__node circle')]
    expect(circles).toHaveLength(8)
    expect(new Set(circles.map(circle => `${circle.getAttribute('cx')},${circle.getAttribute('cy')}`)).size).toBe(8)
    const list = screen.getByRole('complementary', { name: '图谱选择' })
    expect(within(list).getAllByRole('button')).toHaveLength(80)
    fireEvent.click(within(list).getByRole('button', { name: /80\. 事件 79/ }))
    expect(within(graph).getByRole('button', { name: '事件 79' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(screen.getByRole('complementary', { name: '详情与来源' })).getByText('详情 79')).toBeInTheDocument()
  })

  it('brings a selected entity and its actual event into view across different batches', async () => {
    const events = Array.from({ length: 24 }, (_, index) => ({
      id: `event-${index}`, title: `事件 ${index}`, description: '', occurred_at: '2026-09-21T00:00:00.000Z'
    }))
    const entities = Array.from({ length: 12 }, (_, index) => ({
      id: `entity-${index}`, canonical_label: `实体 ${index}`, description: '', confirmation_state: 'automatic'
    }))
    window.goodbuddy = { supervision: {
      overview: async () => [result],
      graph: async () => ({ storyLine: null, events, entities, relations: [], sources: [],
        eventEntities: [{ event_id: 'event-20', entity_id: 'entity-10' }], eventSources: [] })
    } } as never
    render(<SupervisorWorkspace tab="graph" />)
    const graph = await screen.findByRole('group', { name: '故事线图谱' })
    const list = screen.getByRole('complementary', { name: '图谱选择' })
    fireEvent.click(within(list).getByRole('tab', { name: /实体/ }))
    fireEvent.click(within(list).getByRole('button', { name: '实体 10' }))
    expect(within(graph).getByRole('button', { name: '实体 10' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(graph).getByRole('button', { name: '事件 20' })).toHaveClass('is-selected')
    expect(graph.querySelector('[data-event-entity="event-20:entity-10"]')).toHaveClass('is-selected')
    fireEvent.keyDown(within(list).getByRole('tab', { name: /实体/ }), { key: 'ArrowRight' })
    expect(within(list).getByRole('tab', { name: /关系/ })).toHaveFocus()
    expect(within(list).getByRole('tabpanel')).toHaveTextContent('本次回顾暂无此类记录。')
    expect(within(graph).getByRole('button', { name: '实体 10' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(graph).getByRole('button', { name: '事件 20' }))
    expect(within(list).getByRole('tab', { name: /事件/ })).toHaveAttribute('aria-selected', 'true')
    expect(within(list).getAllByRole('button')).toHaveLength(24)
  })
})
