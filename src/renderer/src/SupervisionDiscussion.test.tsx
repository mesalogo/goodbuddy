import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SupervisionDiscussion } from './SupervisionDiscussion'

afterEach(cleanup)

it('sends the visible reference message once without a hidden attachment', async () => {
  const prompt = '请基于以下监督回顾继续讨论。\n\n事件：核对验收\n\n来源：会议记录\n  保留原文缩进'
  const send = vi.fn().mockResolvedValue(undefined)
  const open = vi.fn()
  window.goodbuddy = { supervision: { continueContext: async () => ({ prompt }), continue: send } } as never
  render(<SupervisionDiscussion resultId="result" sourceId="source" conversationId="original" title="Original" onOpenConversation={open} />)
  fireEvent.click(screen.getByRole('button', { name: '继续讨论' }))
  expect(await screen.findByRole('textbox', { name: '发送内容' })).toHaveValue(prompt)
  expect(send).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(open).toHaveBeenCalledWith('original'))
  expect(send).toHaveBeenCalledExactlyOnceWith({ conversationId: 'original', prompt })
})

it('previews the full editable message and preserves it on failure without reattaching deleted context', async () => {
  const continueContext = vi.fn().mockResolvedValue({ prompt: 'Related evidence only' })
  const send = vi.fn().mockRejectedValueOnce(new Error('Send failed')).mockResolvedValue(undefined)
  const onOpenConversation = vi.fn()
  window.goodbuddy = { supervision: { continueContext, continue: send } } as never
  render(<SupervisionDiscussion resultId="result" sourceId="source" conversationId="original" title="Original conversation" onOpenConversation={onOpenConversation} />)
  fireEvent.click(screen.getByRole('button', { name: '继续讨论' }))
  const question = await screen.findByRole('textbox', { name: '发送内容' })
  expect(question).toHaveValue('Related evidence only')
  expect(continueContext).toHaveBeenCalledWith({ resultId: 'result', sourceId: 'source' })
  expect(send).not.toHaveBeenCalled()
  expect(screen.getByText('发送到会话：Original conversation')).toBeVisible()
  fireEvent.change(question, { target: { value: 'What changed?' } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Send failed')
  expect(question).toHaveValue('What changed?')
  expect(onOpenConversation).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(onOpenConversation).toHaveBeenCalledWith('original'))
  expect(send).toHaveBeenNthCalledWith(1, { conversationId: 'original', prompt: 'What changed?' })
  expect(send).toHaveBeenLastCalledWith({ conversationId: 'original', prompt: 'What changed?' })
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
})

it('cancels a preview without sending or navigating', async () => {
  const send = vi.fn()
  const open = vi.fn()
  window.goodbuddy = { supervision: { continueContext: async () => ({ prompt: 'Evidence' }), continue: send } } as never
  render(<SupervisionDiscussion resultId="result" sourceId="source" conversationId="original" title="Original" onOpenConversation={open} />)
  fireEvent.click(screen.getByRole('button', { name: '继续讨论' }))
  fireEvent.click(await screen.findByRole('button', { name: '取消' }))
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(send).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
})
