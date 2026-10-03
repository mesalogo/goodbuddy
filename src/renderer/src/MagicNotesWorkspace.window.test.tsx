import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from './i18n'
import type { DesktopApi } from '../../shared/contracts'
import type { MagicNoteDetail, MagicNoteSummary } from '../../shared/magic-notes-contracts'
import { installFakeListLayout, type FakeListLayout } from './list-window-test-layout'
import { MagicNotesWorkspace } from './MagicNotesWorkspace'
import { defaultMaxRenderedRows } from './use-list-window'

vi.mock('./MagicNoteEditor', () => ({ MagicNoteEditor: () => <div data-testid="magic-note-editor" /> }))
vi.mock('./MagicCanvasThumbnail', () => ({ MagicCanvasThumbnail: () => null }))
vi.mock('./MagicNoteContent', () => ({ MagicNoteContent: () => <div /> }))
vi.mock('./MagicCanvasEditor', async () => {
  const model = await import('./magic-canvas/model')
  return { ...model, MagicCanvasEditor: () => null }
})

const count = 2_000
const rowHeight = 120
const idOf = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
const titleOf = (index: number): string => `Note ${String(index).padStart(4, '0')}`
const notes: MagicNoteSummary[] = Array.from({ length: count }, (_, index) => ({
  id: idOf(index), title: titleOf(index), preview: `preview ${index}`, entryCount: 1, pinned: false, tags: [],
  revision: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z'
}))
const detailOf = (id: string): MagicNoteDetail => ({ ...notes.find((note) => note.id === id)!, entries: [] })

let layout: FakeListLayout
const grid = (): HTMLElement => document.querySelector<HTMLElement>('.magic-notes-card-grid')!
const cards = (): string[] => [...grid().querySelectorAll<HTMLElement>('.magic-note-list-item')].map((card) => card.id.replace('magic-note-select-', ''))
const card = (index: number): HTMLElement | null => document.getElementById(`magic-note-select-${idOf(index)}`)

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
  localStorage.clear()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  layout = installFakeListLayout({
    isContainer: (element) => element.classList.contains('magic-notes-card-grid'),
    rowAttribute: 'data-magic-note-window-row',
    rowHeight: () => rowHeight
  })
  Object.defineProperty(window, 'goodbuddy', { configurable: true, value: {
    magicNotes: {
      list: vi.fn(async () => ({ notes, tags: [] })),
      listTodos: vi.fn(async () => ({ todos: [] })),
      get: vi.fn(async (id: string) => detailOf(id)),
      onChanged: () => vi.fn(),
      onAnalysisEvent: () => vi.fn()
    },
    updates: { getSettings: vi.fn(async () => undefined) },
    settings: { getRuntime: vi.fn() }
  } as unknown as DesktopApi })
})

afterEach(() => {
  cleanup()
  layout.restore()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
})

async function setup(): Promise<void> {
  render(<MagicNotesWorkspace onNotify={vi.fn()} />)
  await screen.findByText(titleOf(0))
  layout.measure()
}

describe('MagicNotesWorkspace note list windowing', () => {
  it('keeps the DOM bounded for 2,000 notes with list semantics and the full scroll height', async () => {
    await setup()
    expect(grid()).toHaveClass('magic-notes-card-grid--windowed')
    expect(grid()).toHaveAttribute('role', 'list')
    expect(cards().length).toBeGreaterThan(0)
    expect(cards().length).toBeLessThanOrEqual(30)
    expect(cards()[0]).toBe(idOf(0))
    expect(layout.contentHeight(grid())).toBe(count * rowHeight)
    const first = card(0)!.closest('.magic-note-row')!
    expect(first).toHaveAttribute('role', 'listitem')
    expect(first).toHaveAttribute('aria-posinset', '1')
    expect(first).toHaveAttribute('aria-setsize', String(count))
  })

  it('mounts the notes at the scroll position', async () => {
    await setup()
    layout.scroll(grid(), 1_500 * rowHeight)
    expect(cards().length).toBeLessThanOrEqual(defaultMaxRenderedRows)
    expect(card(1_500)).toBeInTheDocument()
    expect(card(1_500)!.getBoundingClientRect().top).toBe(0)
    expect(card(1_500)!.closest('.magic-note-row')).toHaveAttribute('aria-posinset', '1501')
    expect(card(0)).toBeNull()
  })

  it('keeps the selected and menu-open notes mounted at their real position and returns focus to the selected card', async () => {
    await setup()
    layout.scroll(grid(), 1_500 * rowHeight)
    fireEvent.click(card(1_500)!)
    await screen.findByDisplayValue(titleOf(1_500))
    layout.measure()
    // The split list beside the open note: the selected card stays mounted.
    layout.scroll(grid(), 0)
    expect(card(0)).toBeInTheDocument()
    expect(card(1_500)).toHaveAttribute('aria-current', 'true')
    const order = cards().map((id) => Number(id.slice(-12)))
    expect(order).toEqual([...order].sort((left, right) => left - right))
    // It sits where it belongs, so scrolling it into view lands on it.
    const offset = card(1_500)!.getBoundingClientRect().top + grid().scrollTop
    expect(offset).toBe(1_500 * rowHeight)
    layout.scroll(grid(), offset)
    expect(card(1_500)!.getBoundingClientRect().top).toBe(0)
    expect(card(1_501)).toBeInTheDocument()

    layout.scroll(grid(), 0)
    fireEvent.click(screen.getByRole('button', { name: `更多笔记操作 ${titleOf(3)}` }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    layout.scroll(grid(), 900 * rowHeight)
    expect(card(3)).toBeInTheDocument()
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    fireEvent.click(screen.getByRole('button', { name: '返回总览' }))
    await waitFor(() => expect(card(1_500)).toHaveFocus())
  })

  it('re-windows the search results at the clamped scroll position, as the browser leaves it', async () => {
    await setup()
    layout.scroll(grid(), 1_000 * rowHeight)
    fireEvent.change(screen.getByPlaceholderText(/搜索/), { target: { value: 'Note 19' } })
    await act(async () => { await Promise.resolve() })
    layout.measure()
    // 100 matches (Note 1900-1999) stay windowed; the list does not jump to
    // the top (it never did), so the end of the shorter result is in view.
    const shown = cards().map((id) => Number(id.slice(-12)))
    expect(shown.every((index) => index >= 1_900)).toBe(true)
    expect(card(1_999)).toBeInTheDocument()
    expect(card(1_999)!.closest('.magic-note-row')).toHaveAttribute('aria-setsize', '100')
    expect(card(1_999)!.closest('.magic-note-row')).toHaveAttribute('aria-posinset', '100')
    layout.scroll(grid(), 0)
    expect(cards()[0]).toBe(idOf(1_900))
  })
})
