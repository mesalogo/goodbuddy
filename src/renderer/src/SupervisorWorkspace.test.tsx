import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { SupervisorWorkspace } from './SupervisorWorkspace'

const result = { id: 'result-1', storyLineId: 'story', sourceId: null, summary: 'Recap', changeDigest: '', createdAt: '2026-09-22T00:00:00.000Z', scope: { kind: 'global' }, timeRange: { from: '2026-09-20T00:00:00.000Z', to: '2026-09-22T00:00:00.000Z' }, openItems: [] }

describe('SupervisorWorkspace', () => {
  it('keeps dated historical content and exact graph selection when configuring and running a new review', async () => {
    const old = { ...result, id: 'old', summary: 'Earlier conclusion.\n\nImportant final conclusion.', changeDigest: 'Confirmed change', openItems: ['Pending decision'], createdAt: '2026-08-22T00:00:00.000Z' }
    let finish!: () => void
    const run = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const graph = vi.fn(async () => ({ storyLine: null, events: [], entities: [], relations: [], sources: [], eventEntities: [], eventSources: [] }))
    window.goodbuddy = { supervision: { overview: async () => [result, old], graph, run } } as never
    const onTabChange = vi.fn()
    const onOpenActivity = vi.fn()
    const project = { id: 'project', name: 'New project', description: '', status: 'active', kind: 'user', rootPath: 'C:\\project', executionSpace: { kind: 'local', rootPath: 'C:\\project' }, defaultWorkMode: 'ask', createdAt: result.createdAt, updatedAt: result.createdAt } as const
    render(<SupervisorWorkspace projects={[project]} onTabChange={onTabChange} onOpenActivity={onOpenActivity} />)
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
    fireEvent.click(screen.getByRole('button', { name: '回顾当前进展' }))
    expect(recap.textContent).toBe(frozenText)
    expect(screen.getByText('Important final conclusion.')).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('新回顾正在整理')
    expect(screen.getByRole('button', { name: '回顾整理中…' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '活动记录' }))
    expect(onOpenActivity).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: 'projects', projectIds: [project.id] } }))
    await act(async () => finish())
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
    expect(await screen.findByRole('alert')).toHaveTextContent('Missing requested result')
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
  afterEach(() => { cleanup(); window.goodbuddy = {} as never })
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
    fireEvent.click(screen.getByRole('button', { name: '回顾当前进展' }))
    await waitFor(() => expect(window.goodbuddy.supervision.run).toHaveBeenCalledOnce())
    expect(window.goodbuddy.supervision.run).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'manual', scope: { kind: 'global' } }))
  })

  it('keeps review failures retryable even with a selected graph event', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('Review provider unavailable')).mockResolvedValueOnce(undefined)
    window.goodbuddy = { supervision: {
      overview: async () => [],
      graph: async () => ({ storyLine: null, events: [{ id: 'event', title: 'Decision', description: '', occurred_at: '2026-09-21T00:00:00.000Z' }], entities: [], relations: [], sources: [], eventEntities: [], eventSources: [] }),
      run
    } } as never
    render(<SupervisorWorkspace />)
    await screen.findByText('还没有成功回顾')
    fireEvent.click(screen.getByRole('button', { name: '回顾当前进展' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Review provider unavailable')
    fireEvent.click(screen.getByRole('button', { name: '重试回顾' }))
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
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
    expect(within(canvas).getByRole('list', { name: '图谱图例' })).toBeInTheDocument()
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
    fireEvent.click(within(list).getByRole('button', { name: '实体 10' }))
    expect(within(graph).getByRole('button', { name: '实体 10' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(graph).getByRole('button', { name: '事件 20' })).toHaveClass('is-selected')
    expect(graph.querySelector('[data-event-entity="event-20:entity-10"]')).toHaveClass('is-selected')
  })
})
