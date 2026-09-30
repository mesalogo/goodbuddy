import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { QueuedAttachmentsDialog } from './QueuedAttachmentsDialog'
import { DocumentConversationContext } from './DocumentConversationContext'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it.each([true, false])('previews queued images without parsing (full image available: %s)', async (fullImage) => {
  const thumbnailUrl = 'data:image/png;base64,thumbnail'
  const contentUrl = fullImage ? 'data:image/png;base64,full' : undefined
  const openImage = vi.fn()
  const getSnapshot = vi.fn()
  const reparseDraft = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('goodbuddy', {
    conversationQueue: { getAttachments: vi.fn().mockResolvedValue([
      { id: 'image', resourceId: 'image', name: 'screenshot.png', kind: 'image', sendMode: 'image', thumbnailUrl, contentUrl }
    ]) },
    documentParsing: { getSnapshot }, context: { reparseDraft }
  })
  render(<DocumentConversationContext.Provider value={{ openImage, create: vi.fn(), navigate: vi.fn(), notify: vi.fn() }}>
    <QueuedAttachmentsDialog itemId="queued" onClose={vi.fn()} />
  </DocumentConversationContext.Provider>)
  expect(await screen.findByRole('img', { name: 'screenshot.png' })).toHaveAttribute('src', thumbnailUrl)
  const trigger = screen.getByRole('button', { name: '查看图片 screenshot.png' })
  fireEvent.click(trigger)
  expect(openImage).toHaveBeenCalledWith(contentUrl ?? thumbnailUrl, 'screenshot.png', trigger)
  fireEvent.click(screen.getByRole('button', { name: '更多附件操作：screenshot.png' }))
  expect(screen.getAllByRole('menuitem')).toHaveLength(1)
  expect(screen.getByRole('menuitem')).toHaveTextContent('打开原文件')
  expect(screen.queryByRole('button', { name: /查看解析结果/ })).not.toBeInTheDocument()
  expect(getSnapshot).not.toHaveBeenCalled()
  expect(reparseDraft).not.toHaveBeenCalled()
})

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
