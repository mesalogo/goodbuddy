import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../i18n'
import { defaultKnowledgeOntologySettings } from '../../../shared/knowledge-ontology'
import { installFakeListLayout, type FakeListLayout } from '../list-window-test-layout'
import { defaultMaxRenderedRows } from '../use-list-window'
import { DocumentsView } from './DocumentsView'
import type { KnowledgeDocumentItem, KnowledgeLibrary } from './types'

vi.mock('../DocumentResultPreview', () => ({
  DocumentResultPreview: ({ resultId }: { resultId: string }) => <div>Preview {resultId}</div>
}))

const count = 2_000
const rowHeight = 60
const library: KnowledgeLibrary = {
  id: 'library-1', name: 'Docs', description: '', storageMode: 'managed', graphEnabled: false,
  graphStrategy: 'hybrid', sourceCount: 0, documentCount: count, indexedDocumentCount: count,
  ontologySettings: defaultKnowledgeOntologySettings, updatedAt: '2026-07-30T08:00:00.000Z'
}
const nameOf = (index: number): string => `doc-${String(index).padStart(4, '0')}.md`
const documents: KnowledgeDocumentItem[] = Array.from({ length: count }, (_, index) => ({
  id: `d${index}`, libraryId: library.id, name: nameOf(index), status: 'ready', indexProgress: 100,
  chunkCount: 1, size: 10, resultId: `result-${index}`
}))

let layout: FakeListLayout
let animationFrames: FrameRequestCallback[] = []
const page = (): HTMLElement => document.querySelector<HTMLElement>('.workspace-panel-scroll')!
const table = (): HTMLElement => screen.getByRole('table', { hidden: true })
const renderedNames = (): string[] =>
  [...table().querySelectorAll('tbody tr strong')].map((cell) => cell.textContent ?? '')
const row = (index: number): HTMLElement | null =>
  table().querySelector<HTMLElement>(`tr[data-knowledge-document-row="document:d${index}"]`)
const flushFrames = (): void => act(() => {
  const frames = animationFrames
  animationFrames = []
  for (const frame of frames) frame(0)
})

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
  animationFrames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => animationFrames.push(callback))
  layout = installFakeListLayout({
    isContainer: (element) => element.classList.contains('workspace-panel-scroll'),
    rowAttribute: 'data-knowledge-document-row',
    rowHeight: () => rowHeight
  })
})

afterEach(() => {
  cleanup()
  layout.restore()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function setup(): void {
  render(
    <div className="workspace-panel-scroll">
      <DocumentsView
        documents={documents} library={library} sources={[]} tasks={[]}
        onImportDirectory={vi.fn()} onImportFiles={vi.fn()} onImportUrl={vi.fn()}
        onOpenDocumentSource={vi.fn()} onPauseSource={vi.fn()} onRemoveSource={vi.fn()}
        onRebuildDocument={vi.fn()} onRetrySource={vi.fn()} onSyncSource={vi.fn()}
        onManageChunks={vi.fn()} onViewTasks={vi.fn()}
      />
    </div>
  )
  layout.measure()
}

describe('DocumentsView windowing', () => {
  it('keeps the table bounded for 2,000 documents with row indexes for assistive technology', () => {
    setup()
    const names = renderedNames()
    expect(names.length).toBeGreaterThan(0)
    expect(names.length).toBeLessThanOrEqual(30)
    expect(names[0]).toBe(nameOf(0))
    expect(table()).toHaveAttribute('aria-rowcount', String(count + 1))
    expect(row(0)).toHaveAttribute('aria-rowindex', '2')
    // Spacers keep the page as tall as the full table.
    const body = table().querySelector('tbody')!
    expect(body.getBoundingClientRect().height).toBe(count * rowHeight)
  })

  it('follows the page scroll, which belongs to an ancestor of the table', () => {
    setup()
    layout.scroll(page(), 1_200 * rowHeight)
    expect(renderedNames().length).toBeLessThanOrEqual(defaultMaxRenderedRows)
    expect(row(1_200)).toBeInTheDocument()
    expect(row(1_200)!.getBoundingClientRect().top).toBe(0)
    expect(row(1_200)).toHaveAttribute('aria-rowindex', '1202')
    expect(row(0)).toBeNull()
  })

  it('returns focus and scroll to the previewed row after the page left it', async () => {
    setup()
    layout.scroll(page(), 1_200 * rowHeight)
    const trigger = within(row(1_200)!).getByRole('button', { name: '查看解析结果' })
    trigger.focus()
    fireEvent.click(trigger)
    flushFrames()
    expect(screen.getByText('Preview result-1200')).toBeInTheDocument()
    expect(page().scrollTop).toBe(0)
    layout.measure()
    // The hidden list keeps its window; the previewed row stays mounted.
    expect(row(1_200)).toBe(trigger.closest('tr'))
    fireEvent.click(screen.getByRole('button', { name: '返回文档列表' }))
    flushFrames()
    // Browsers report the restored scrollTop with a scroll event.
    act(() => { page().dispatchEvent(new Event('scroll')) })
    layout.measure()
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(page().scrollTop).toBe(1_200 * rowHeight)
    expect(row(1_200)!.getBoundingClientRect().top).toBe(0)
    expect(row(1_201)).toBeInTheDocument()
  })

  it('renders every row without spacers for small libraries and searches', () => {
    setup()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'doc-000' } })
    layout.measure()
    // doc-0000 .. doc-0009: below the threshold.
    expect(renderedNames()).toHaveLength(10)
    expect(table().querySelector('.knowledge-documents__spacer')).toBeNull()
    expect(table()).not.toHaveAttribute('aria-rowcount')
  })
})
