import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SupervisionDiscussion } from './SupervisionDiscussion'

afterEach(cleanup)

it('previews before sending and preserves the question on failure', async () => {
  const continueContext = vi.fn().mockResolvedValue({ prompt: 'Related evidence only' })
  const send = vi.fn().mockRejectedValueOnce(new Error('Send failed')).mockResolvedValue(undefined)
  const onOpenConversation = vi.fn()
  window.goodbuddy = { supervision: { continueContext, continue: send } } as never
  render(<SupervisionDiscussion resultId="result" sourceId="source" conversationId="original" title="Original conversation" onOpenConversation={onOpenConversation} />)
  fireEvent.click(screen.getByRole('button', { name: '继续讨论' }))
  const question = await screen.findByRole('textbox', { name: '继续讨论的问题' })
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
  expect(send).toHaveBeenLastCalledWith({ conversationId: 'original', prompt: 'Related evidence only\n\nWhat changed?' })
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
