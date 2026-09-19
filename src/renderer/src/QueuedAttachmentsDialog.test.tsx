import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { QueuedAttachmentsDialog } from './QueuedAttachmentsDialog'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('opens snapshot guidance without hiding empty state or closing the dialog on Escape', async () => {
  const onClose = vi.fn()
  vi.stubGlobal('goodbuddy', { conversationQueue: { getAttachments: vi.fn().mockResolvedValue([]) } })
  render(<QueuedAttachmentsDialog itemId="queued" onClose={onClose} />)
  expect(await screen.findByText('此输入没有附件。')).toBeVisible()
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  const help = screen.getByRole('button', { name: '入队时的附件' })
  fireEvent.click(help)
  expect(screen.getByRole('tooltip')).toHaveTextContent('这里显示入队时的内容。需要修改附件时，请先将整条输入恢复到草稿。')
  fireEvent.keyDown(help, { key: 'Escape' })
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '关闭附件预览' }))
  expect(onClose).toHaveBeenCalledOnce()
})
