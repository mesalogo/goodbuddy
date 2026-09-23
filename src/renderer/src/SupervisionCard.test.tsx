import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SupervisionCard } from './RightAssistantSidebar'
import i18n from './i18n'

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.goodbuddy = {} as never })
const result = (id: string) => ({ id, storyLineId: id, sourceId: `source-${id}`, summary: `${id} recap`, scope: { kind: 'global' }, timeRange: { from: '2026-09-01T00:00:00Z', to: '2026-09-22T00:00:00Z' } })

it('keeps unknown target IDs out of visible copy and disables actions without a target', async () => {
  window.goodbuddy = { supervision: { overview: async () => [] } } as never
  const view = render(<SupervisionCard target={{ type: 'conversation', conversationId: 'raw-uuid' }} onTogglePinned={vi.fn()} />)
  expect(screen.getByText('会话：未命名会话')).toHaveAttribute('title', 'raw-uuid')
  expect(screen.queryByText(/raw-uuid/)).not.toBeInTheDocument()
  await act(async () => {})
  view.rerender(<SupervisionCard onTogglePinned={vi.fn()} />)
  expect(screen.getByRole('button', { name: '固定监督目标' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '刷新监督回顾' })).toBeDisabled()
})

it('graph navigation exposes only the matched result through a native bilingual button', async () => {
  const open = vi.fn()
  const overview = vi.fn().mockResolvedValueOnce([result('pinned')]).mockResolvedValueOnce([])
  window.goodbuddy = { supervision: { overview } } as never
  const view = render(<SupervisionCard target={{ type: 'conversation', conversationId: 'pinned' }} activeConversationId="other" onOpenSupervisionGraph={open} />)
  const button = await screen.findByRole('button', { name: '在图谱中查看' })
  expect(button.tagName).toBe('BUTTON')
  expect(button).toHaveAttribute('type', 'button')
  button.focus()
  expect(button).toHaveFocus()
  fireEvent.click(button)
  expect(open).toHaveBeenCalledWith('pinned')
  try {
    await act(async () => { await i18n.changeLanguage('en-US') })
    expect(screen.getByRole('button', { name: 'View in graph' })).toBeInTheDocument()
  } finally {
    await act(async () => { await i18n.changeLanguage('zh-CN') })
  }
  view.rerender(<SupervisionCard target={{ type: 'task', taskId: 'missing' }} onOpenSupervisionGraph={open} />)
  await waitFor(() => expect(overview).toHaveBeenCalledTimes(2))
  expect(screen.queryByRole('button', { name: '在图谱中查看' })).not.toBeInTheDocument()
})

it('supervision ignores old target responses and never falls back to a global result', async () => {
  let resolveA!: (value: unknown) => void
  const overview = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve })).mockResolvedValueOnce([result('B')]).mockResolvedValueOnce([])
  window.goodbuddy = { supervision: { overview } } as never
  const view = render(<SupervisionCard target={{ type: 'conversation', conversationId: 'A' }} />)
  view.rerender(<SupervisionCard target={{ type: 'conversation', conversationId: 'B' }} />)
  expect(await screen.findByText('B recap')).toBeInTheDocument()
  await act(async () => resolveA([result('A')]))
  expect(screen.queryByText('A recap')).not.toBeInTheDocument()
  view.rerender(<SupervisionCard target={{ type: 'task', taskId: 'task-C' }} />)
  await waitFor(() => expect(overview).toHaveBeenLastCalledWith({ target: { type: 'task', taskId: 'task-C' } }))
  expect(screen.queryByText('B recap')).not.toBeInTheDocument()
  expect(screen.getByText('暂无监督回顾')).toBeInTheDocument()
})

it('supervision previews and sends to the explicit conversation and discards stale previews', async () => {
  const send = vi.fn(async () => undefined)
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  let resolvePreview!: (value: unknown) => void
  const continueContext = vi.fn().mockResolvedValueOnce({ prompt: 'Actual prompt' }).mockImplementationOnce(() => new Promise((resolve) => { resolvePreview = resolve }))
  window.goodbuddy = { supervision: { overview: async () => [result('A')], sourceContext: async () => ({ id: 'source-A', title: 'Source', content: 'Content' }), continueContext } } as never
  const view = render(<SupervisionCard target={{ type: 'conversation', conversationId: 'fixed-A' }} activeConversationId="fixed-A" conversationTitle="Pinned A" onContinueSupervision={send} />)
  fireEvent.click(await screen.findByRole('button', { name: '查看来源' }))
  await screen.findByText('Content')
  fireEvent.click(screen.getByRole('button', { name: '继续讨论' }))
  await waitFor(() => expect(send).toHaveBeenCalledWith('Actual prompt', 'fixed-A'))
  expect(confirm.mock.calls[0]![0]).toContain('Pinned A')
  expect(confirm.mock.calls[0]![0]).toContain('fixed-A')
  fireEvent.click(screen.getByRole('button', { name: '继续讨论' }))
  await waitFor(() => expect(continueContext).toHaveBeenCalledTimes(2))
  view.rerender(<SupervisionCard target={{ type: 'conversation', conversationId: 'B' }} activeConversationId="B" onContinueSupervision={send} />)
  await act(async () => resolvePreview({ prompt: 'Stale prompt' }))
  expect(send).toHaveBeenCalledTimes(1)
  expect(confirm).toHaveBeenCalledTimes(1)
})
