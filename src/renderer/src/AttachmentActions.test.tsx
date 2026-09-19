import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AttachmentActions, AttachmentStatus } from './AttachmentActions'
import { AttachmentResultButton } from './AttachmentResultButton'
import type { ContextAttachment } from '../../shared/contracts'

vi.mock('./DocumentResultPreview', () => ({ DocumentResultPreview: () => <p>Saved result</p> }))

const attachment: ContextAttachment = {
  id: 'asset-id', resourceId: 'asset-id', resultId: 'result-id',
  name: 'quarterly-report.pdf', originalName: 'quarterly-report.pdf',
  kind: 'text', size: 1024, preview: 'Report', completeness: 'complete'
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Object.defineProperty(window, 'goodbuddy', { configurable: true, value: {
    documentParsing: { getSnapshot: vi.fn(async () => ({ settings: { ocrProvider: 'paddleocr-vl' } })) },
    context: { openOriginal: vi.fn(async () => undefined) }
  } })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('keeps attachment actions icon-only and named, and restores keyboard focus after preview and menu dismissal', async () => {
  render(<>
    <AttachmentStatus attachment={attachment} />
    <div className="attachment-actions">
      <AttachmentResultButton resultId={attachment.resultId!} name={attachment.name} />
      <AttachmentActions attachment={attachment} />
    </div>
  </>)
  const preview = screen.getByRole('button', { name: `查看解析结果：${attachment.name}` })
  const more = screen.getByRole('button', { name: `更多附件操作：${attachment.name}` })
  for (const button of [preview, more]) {
    expect(button).toHaveClass('icon-button', 'attachment-action')
    expect(button.textContent).toBe('')
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(button.getAttribute('title')).toBe(button.getAttribute('data-tooltip'))
  }
  expect(screen.getByText('解析完成')).toBeVisible()
  preview.focus()
  fireEvent.click(preview)
  expect(screen.getByRole('dialog')).toHaveTextContent('Saved result')
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(preview).toHaveFocus()
  more.focus()
  fireEvent.click(more)
  expect(more).toHaveAttribute('aria-expanded', 'true')
  expect(await screen.findByText('解析来源：HTTP PaddleOCR-VL（远程服务）')).toBeVisible()
  expect(screen.getByRole('menuitem', { name: `打开原文件：${attachment.name}` })).toHaveFocus()
  fireEvent.keyDown(document.activeElement!, { key: 'End' })
  expect(screen.getByRole('menuitem', { name: '前往文档解析设置' })).toHaveFocus()
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(more).toHaveFocus()
  fireEvent.click(more)
  fireEvent.click(screen.getByRole('menuitem', { name: `打开原文件：${attachment.name}` }))
  await waitFor(() => expect(window.goodbuddy.context.openOriginal).toHaveBeenCalledWith('asset-id'))
})

it('keeps queued attachments read-only and exposes no action for legacy attachments without assets', async () => {
  const { rerender } = render(<AttachmentActions attachment={attachment} readOnly />)
  fireEvent.click(screen.getByRole('button'))
  await screen.findByText('解析来源：HTTP PaddleOCR-VL（远程服务）')
  expect(screen.getAllByRole('menuitem')).toHaveLength(2)
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  rerender(<AttachmentActions attachment={{ ...attachment, resourceId: undefined }} />)
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})
