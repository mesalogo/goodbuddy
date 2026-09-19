import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DocumentResultPreview } from './DocumentResultPreview'
import type { DocumentResult } from '../../shared/document-result-contracts'

const result: DocumentResult = {
  id: '00000000-0000-4000-8000-000000000001', fileName: 'report.pdf', sourceFormat: '.pdf',
  content: '<div>Invoice</div><table><tr><td rowspan="2">Amount</td><td>42</td></tr></table><script>bad()</script>',
  sections: [{ locator: 'Page 1', pageNumber: 1, content: '<div>Invoice</div>\n\n<table><tr><td rowspan="2">Amount</td><td>42</td></tr></table><script>bad()</script>' }],
  images: [{ id: '00000000-0000-4000-8000-000000000002', pageNumber: 1, key: 'imgs/a.png', mimeType: 'image/png', width: 10, height: 10, size: 20 }],
  missingImages: [], warnings: [], completeness: 'complete', parsedAt: '2026-09-19T00:00:00Z', durationMs: 100,
  settings: { chatWorkflow: 'auto', knowledgeWorkflow: 'complete-index', maximumPages: 100, pageTimeoutSeconds: 60, localOcrModelId: 'pp-ocrv6-tiny' }
}
const add = vi.fn(async () => [])
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
beforeEach(() => {
  add.mockClear()
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  Object.defineProperty(window, 'goodbuddy', { configurable: true, value: {
    documentParsing: { getResult: vi.fn(async () => result), openResultOriginal: vi.fn(async () => { throw new Error('原文件不可用') }) },
    conversations: { listSummaries: vi.fn(async () => [{ id: 'conversation', title: 'Target', updatedAt: 0, messages: [] }]) },
    projects: { list: vi.fn(async () => []) }, context: { getDraft: vi.fn(async () => []), addResultImages: add, onDraftChanged: vi.fn(() => () => undefined) }
  } })
})

it('renders OCR HTML tables and text without scripts, and keeps the result when its original is missing', async () => {
  const { container } = render(<DocumentResultPreview resultId={result.id} />)
  expect(await screen.findByText('Invoice')).toBeVisible()
  expect(screen.getByRole('table')).toHaveTextContent('Amount42')
  expect(container.querySelector('td')?.getAttribute('rowspan')).toBe('2')
  expect(container.querySelector('script')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '打开原文件' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('原文件不可用')
  expect(screen.getByRole('table')).toBeVisible()
  fireEvent.click(screen.getByRole('tab', { name: '详情' }))
  expect(screen.getByText('未提供')).toBeVisible()
  expect(screen.queryByRole('button', { name: '添加所选图片' })).not.toBeInTheDocument()
})

it('starts with zero selected images and retains selections across tabs until explicit batch submission', async () => {
  render(<DocumentResultPreview resultId={result.id} allowAddImages conversationId="conversation" />)
  fireEvent.click(await screen.findByRole('tab', { name: '图片（1）' }))
  const checkbox = screen.getByRole('checkbox')
  expect(checkbox).not.toBeChecked()
  expect(screen.getByRole('button', { name: '添加所选图片' })).toBeDisabled()
  fireEvent.click(checkbox)
  fireEvent.click(screen.getByRole('tab', { name: '详情' }))
  fireEvent.click(screen.getByRole('tab', { name: '图片（1）' }))
  expect(screen.getByRole('checkbox')).toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: '添加所选图片' }))
  await waitFor(() => expect(add).toHaveBeenCalledWith('conversation', result.id, [result.images[0]!.id]))
  expect(screen.getByRole('checkbox')).not.toBeChecked()
})
