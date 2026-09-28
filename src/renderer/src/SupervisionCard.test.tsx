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

it('shows actual context in the editable message and sends exactly that message only on Send', async () => {
  const send = vi.fn(async () => undefined)
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  const sourceContext = vi.fn()
  const continueContext = vi.fn().mockResolvedValue({ prompt: 'Actual prompt\n  Exact context' })
  window.goodbuddy = { supervision: { overview: async () => [result('A')], sourceContext, continueContext } } as never
  render(<SupervisionCard target={{ type: 'conversation', conversationId: 'fixed-A' }} activeConversationId="fixed-A" conversationTitle="Pinned A" onContinueSupervision={send} />)
  fireEvent.click(await screen.findByRole('button', { name: '继续讨论' }))
  const question = await screen.findByRole('textbox', { name: '发送内容' })
  expect(continueContext).toHaveBeenCalledWith({ sourceId: 'source-A', resultId: 'A' })
  expect(sourceContext).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
  expect(screen.getByText('发送到会话：Pinned A')).toHaveAttribute('title', 'fixed-A')
  expect(question).toHaveValue('Actual prompt\n  Exact context')
  expect(screen.queryByText('发送时会附带相关回顾与来源。')).not.toBeInTheDocument()
  const edited = 'Actual prompt\n  Edited context\n\nWhat next?\nKeep this detail.  '
  fireEvent.change(question, { target: { value: edited } })
  expect(send).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
  expect(send).toHaveBeenCalledExactlyOnceWith(edited, 'fixed-A')
  expect(confirm).not.toHaveBeenCalled()
})

it('preserves the question on send failure, blocks duplicate requests and supports retry and cancel', async () => {
  let rejectSend!: (error: Error) => void
  const send = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { rejectSend = reject })).mockResolvedValue(undefined)
  let resolveContext!: (value: unknown) => void
  const continueContext = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveContext = resolve })).mockResolvedValue({ prompt: 'Context' })
  window.goodbuddy = { supervision: { overview: async () => [result('A')], continueContext } } as never
  render(<SupervisionCard target={{ type: 'conversation', conversationId: 'A' }} activeConversationId="A" onContinueSupervision={send} />)
  const start = await screen.findByRole('button', { name: '继续讨论' })
  fireEvent.click(start)
  fireEvent.click(start)
  expect(start).toBeDisabled()
  expect(continueContext).toHaveBeenCalledTimes(1)
  await act(async () => resolveContext({ prompt: 'Context' }))
  const question = screen.getByRole('textbox', { name: '发送内容' })
  fireEvent.change(question, { target: { value: '  ' } })
  expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
  fireEvent.change(question, { target: { value: 'My question' } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  fireEvent.click(screen.getByRole('button', { name: '正在发送...' }))
  expect(send).toHaveBeenCalledTimes(1)
  expect(question).toBeDisabled()
  expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
  await act(async () => rejectSend(new Error('Send failed')))
  expect(screen.getByRole('status')).toHaveTextContent('Send failed')
  expect(question).toHaveValue('My question')
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
  expect(send).toHaveBeenNthCalledWith(2, 'My question', 'A')
  fireEvent.click(start)
  await screen.findByRole('textbox')
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(send).toHaveBeenCalledTimes(2)
})

it('discards pending context when the target changes and clears previews on refresh', async () => {
  const send = vi.fn()
  let resolvePreview!: (value: unknown) => void
  const continueContext = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolvePreview = resolve })).mockResolvedValue({ prompt: 'Fresh context' })
  const overview = vi.fn().mockResolvedValueOnce([result('A')]).mockResolvedValueOnce([result('B')]).mockResolvedValueOnce([result('C')])
  window.goodbuddy = { supervision: { overview, sourceContext: async () => ({ title: 'Source', content: 'Content' }), continueContext } } as never
  const view = render(<SupervisionCard target={{ type: 'conversation', conversationId: 'A' }} activeConversationId="A" onContinueSupervision={send} />)
  fireEvent.click(await screen.findByRole('button', { name: '继续讨论' }))
  view.rerender(<SupervisionCard target={{ type: 'conversation', conversationId: 'B' }} activeConversationId="B" onContinueSupervision={send} />)
  await screen.findByText('B recap')
  await act(async () => resolvePreview({ prompt: 'Stale prompt' }))
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '查看来源' }))
  await screen.findByText('Content')
  fireEvent.click(screen.getByRole('button', { name: '继续讨论' }))
  await screen.findByRole('textbox')
  fireEvent.click(screen.getByRole('button', { name: '刷新监督回顾' }))
  await screen.findByText('C recap')
  expect(screen.queryByText('Content')).not.toBeInTheDocument()
  expect(screen.queryByText('Fresh context')).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(send).not.toHaveBeenCalled()
})

it('allows retry after context loading fails without sending', async () => {
  const send = vi.fn()
  const continueContext = vi.fn().mockRejectedValueOnce(new Error('Context failed')).mockResolvedValue({ prompt: 'Context' })
  window.goodbuddy = { supervision: { overview: async () => [result('A')], continueContext } } as never
  render(<SupervisionCard target={{ type: 'conversation', conversationId: 'A' }} activeConversationId="A" onContinueSupervision={send} />)
  fireEvent.click(await screen.findByRole('button', { name: '继续讨论' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Context failed'))
  fireEvent.click(screen.getByRole('button', { name: '继续讨论' }))
  await screen.findByRole('textbox')
  expect(send).not.toHaveBeenCalled()
})
