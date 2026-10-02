import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from './chat-conversation'
import { ConversationSidebar, type ConversationListRowHandlers } from './ConversationSidebar'
import { createConversationStores, type ConversationStore } from './conversation-store'
import { conversationListWindowThreshold, maxRenderedConversationRows } from './use-conversation-list-window'

// --- A tiny fake layout: jsdom has none. ------------------------------------
// The list is 400 px tall at viewport top 0. Its children stack vertically:
// rows take their height from `rowHeights` (default 40), spacers their inline
// height.
const viewport = 400
let rowHeights = new Map<string, number>()
const scrollTops = new WeakMap<Element, number>()

function childHeight(child: HTMLElement): number {
  const id = child.dataset.conversationWindowRow
  if (id) return rowHeights.get(id) ?? 40
  if (child.classList.contains('conversation-list__spacer')) return Number.parseFloat(child.style.height) || 0
  return 0
}

function contentHeight(list: HTMLElement): number {
  return [...list.children].reduce((sum, child) => sum + childHeight(child as HTMLElement), 0)
}

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect
}

function listChildOf(element: HTMLElement, list: HTMLElement): HTMLElement | null {
  let item: HTMLElement | null = element
  while (item && item.parentElement !== list) item = item.parentElement
  return item
}

function fakeRect(this: HTMLElement): DOMRect {
  if (this.classList.contains('conversation-list')) return rect(0, viewport)
  const list = this.closest<HTMLElement>('.conversation-list')
  if (!list) return rect(0, 0)
  const item = listChildOf(this, list)
  if (!item) return rect(0, 0)
  let offset = 0
  for (const child of list.children) {
    if (child === item) break
    offset += childHeight(child as HTMLElement)
  }
  return rect(offset - list.scrollTop, childHeight(item))
}

const isList = (element: Element): boolean => element.classList.contains('conversation-list')

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  readonly observed = new Set<Element>()
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }
  observe(element: Element): void { this.observed.add(element) }
  unobserve(element: Element): void { this.observed.delete(element) }
  disconnect(): void { this.observed.clear() }
  fire(): void {
    const entries = [...this.observed].map((target) => ({ target }) as ResizeObserverEntry)
    this.callback(entries, this as unknown as ResizeObserver)
  }
}

/** Delivers row measurements to the list's observer. */
function measure(): void {
  act(() => {
    for (const observer of FakeResizeObserver.instances) {
      if ([...observer.observed].some(isList)) observer.fire()
    }
  })
}

const descriptors = ['clientHeight', 'scrollHeight', 'scrollTop'] as const
const originalDescriptors = new Map<string, PropertyDescriptor | undefined>()

function installGeometry(): void {
  for (const name of descriptors) {
    originalDescriptors.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name))
  }
  Object.defineProperties(HTMLElement.prototype, {
    clientHeight: { configurable: true, get(this: HTMLElement) { return isList(this) ? viewport : 0 } },
    scrollHeight: { configurable: true, get(this: HTMLElement) { return isList(this) ? contentHeight(this) : 0 } },
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) { return scrollTops.get(this) ?? 0 },
      set(this: HTMLElement, value: number) {
        const max = isList(this) ? Math.max(0, contentHeight(this) - viewport) : 0
        scrollTops.set(this, Math.min(Math.max(0, value), max))
      },
    },
  })
}

function restoreGeometry(): void {
  for (const name of descriptors) {
    const original = originalDescriptors.get(name)
    if (original) Object.defineProperty(HTMLElement.prototype, name, original)
    else Reflect.deleteProperty(HTMLElement.prototype, name)
  }
}

// --- Fixtures ----------------------------------------------------------------

const title = (index: number): string => `Conversation ${String(index).padStart(4, '0')}`
const idOf = (index: number): string => `c${index}`

function makeConversations(count: number): Conversation[] {
  // Newest first: row i is conversation i.
  return Array.from({ length: count }, (_, index) => ({
    id: idOf(index), title: title(index), updatedAt: 1_000_000 - index, messages: [],
  }) as unknown as Conversation)
}

const handlers: ConversationListRowHandlers = {
  toggleTasks: vi.fn(), select: vi.fn(), toggleActions: vi.fn(), registerActionTrigger: vi.fn(),
  closeActions: vi.fn(), pin: vi.fn(), branch: vi.fn(), startRename: vi.fn(), copy: vi.fn(),
  exportConversation: vi.fn(), cancelDelete: vi.fn(), confirmDelete: vi.fn(), requestDelete: vi.fn(),
  saveTitle: vi.fn(), cancelRename: vi.fn(), openTask: vi.fn(), viewAllTasks: vi.fn(),
}

type SidebarProps = ComponentProps<typeof ConversationSidebar>

function props(store: ConversationStore, overrides: Partial<SidebarProps> = {}): SidebarProps {
  return {
    store,
    activeId: '',
    activeProjectId: '',
    activeProjectKind: undefined,
    searchQuery: '',
    conversationStoreReady: false,
    loadError: undefined,
    locale: 'zh-CN',
    sidebarOpen: true,
    tasksByConversation: new Map(),
    expandedTaskConversationIds: new Set(),
    activityByConversationId: new Map(),
    activeConversationIds: new Set(),
    queuedConversationIds: new Set(),
    unreadConversationIds: new Set(),
    conversationActionsId: '',
    confirmingConversationId: '',
    deletingConversationId: '',
    renamingConversationId: '',
    branchingConversationId: '',
    pinningConversationId: '',
    assistantSchedules: [],
    selectedAssistantTaskId: undefined,
    actionsRef: { current: null },
    handlers,
    actions: { newConversation: vi.fn(), clearSearch: vi.fn(), retryLoad: vi.fn(), notify: vi.fn() },
    ...overrides,
  }
}

function setup(count: number, overrides: Partial<SidebarProps> = {}) {
  const store = createConversationStores(makeConversations(count), { flushIntervalMs: 1_000 }).conversations
  const view = render(<ConversationSidebar {...props(store, overrides)} />)
  const list = view.container.querySelector<HTMLElement>('.conversation-list')!
  measure()
  const update = (next: Partial<SidebarProps>): void => {
    view.rerender(<ConversationSidebar {...props(store, { ...overrides, ...next })} />)
  }
  return { ...view, list, store, update }
}

function renderedIds(list: HTMLElement): string[] {
  return [...list.querySelectorAll<HTMLElement>('[data-conversation-window-row]')]
    .map((row) => row.dataset.conversationWindowRow ?? '')
}

function scrollList(list: HTMLElement, top: number): void {
  act(() => {
    list.scrollTop = top
    fireEvent.scroll(list)
  })
  measure()
}

/** Rows whose box intersects the viewport. */
function visibleIds(list: HTMLElement): string[] {
  return [...list.querySelectorAll<HTMLElement>('[data-conversation-window-row]')].filter((row) => {
    const box = row.getBoundingClientRect()
    return box.bottom > 0 && box.top < viewport
  }).map((row) => row.dataset.conversationWindowRow ?? '')
}

beforeEach(() => {
  rowHeights = new Map()
  FakeResizeObserver.instances = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(fakeRect)
  installGeometry()
})

afterEach(() => {
  cleanup()
  restoreGeometry()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ConversationSidebar windowing', () => {
  it('renders every row without spacers below the threshold', () => {
    const { list } = setup(conversationListWindowThreshold - 1)
    expect(renderedIds(list)).toHaveLength(conversationListWindowThreshold - 1)
    expect(list.querySelector('.conversation-list__spacer')).toBeNull()
    expect(list).not.toHaveClass('conversation-list--windowed')
  })

  it('keeps the DOM bounded for 1,000 conversations while the full list stays scrollable', () => {
    const { list } = setup(1_000)
    expect(list).toHaveClass('conversation-list--windowed')
    expect(list).toHaveAttribute('role', 'list')
    const rows = renderedIds(list)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThanOrEqual(40)
    expect(rows[0]).toBe('c0')
    expect(list.scrollHeight).toBe(1_000 * 40)
    const first = list.querySelector<HTMLElement>('[data-conversation-window-row="c0"]')!
    expect(first).toHaveAttribute('role', 'listitem')
    expect(first).toHaveAttribute('aria-posinset', '1')
    expect(first).toHaveAttribute('aria-setsize', '1000')
  })

  it('mounts the rows at the scroll position and keeps them in place', () => {
    const { list } = setup(1_000)
    for (const top of [20_000, 39_600, 8_000, 0]) {
      scrollList(list, top)
      const rows = renderedIds(list)
      expect(rows.length).toBeLessThanOrEqual(maxRenderedConversationRows)
      const firstVisible = Math.floor(list.scrollTop / 40)
      expect(visibleIds(list)).toEqual(
        Array.from({ length: Math.min(10, 1_000 - firstVisible) }, (_, offset) => idOf(firstVisible + offset)),
      )
    }
    scrollList(list, 20_000)
    expect(screen.getByText(title(500))).toBeInTheDocument()
    expect(list.querySelector('[data-conversation-window-row="c500"]')).toHaveAttribute('aria-posinset', '501')
    expect(screen.queryByText(title(0))).toBeNull()
  })

  it('measures variable row heights and keeps the visible row steady', () => {
    rowHeights = new Map(Array.from({ length: 1_000 }, (_, index) => [idOf(index), index % 3 === 0 ? 80 : 40]))
    const { list } = setup(1_000)
    scrollList(list, 12_000)
    const firstVisible = visibleIds(list)[0]!
    const before = list.querySelector<HTMLElement>(`[data-conversation-window-row="${firstVisible}"]`)!.getBoundingClientRect().top
    measure()
    const after = list.querySelector<HTMLElement>(`[data-conversation-window-row="${firstVisible}"]`)!.getBoundingClientRect().top
    expect(after).toBeCloseTo(before, 0)
  })

  it('keeps the active, menu-open, renaming and focused rows mounted when scrolled away', () => {
    const { list, update } = setup(1_000, { activeId: idOf(900) })
    expect(renderedIds(list)).toContain('c900')
    update({ conversationActionsId: idOf(3) })
    expect(screen.getByRole('menu')).toBeInTheDocument()
    scrollList(list, 20_000)
    expect(renderedIds(list)).toEqual(expect.arrayContaining(['c3', 'c900', 'c500']))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    // Kept rows sit at their real position, so DOM (and Tab) order follows the list.
    const rows = renderedIds(list).map((id) => Number(id.slice(1)))
    expect(rows).toEqual([...rows].sort((left, right) => left - right))

    update({ conversationActionsId: '', renamingConversationId: idOf(510) })
    scrollList(list, 32_000)
    expect(screen.getByLabelText(`重命名会话 ${title(510)}`)).toBeInTheDocument()
    expect(renderedIds(list)).not.toContain('c3')

    scrollList(list, 0)
    act(() => screen.getByLabelText(`更多会话操作 ${title(4)}`).focus())
    update({ renamingConversationId: '' })
    scrollList(list, 30_000)
    expect(renderedIds(list)).toContain('c4')
    expect(screen.getByLabelText(`更多会话操作 ${title(4)}`)).toHaveFocus()
    expect(renderedIds(list)).not.toContain('c510')
  })

  it('resets the window to the top when search results change', async () => {
    const { list, update } = setup(1_000)
    scrollList(list, 20_000)
    expect(renderedIds(list)).toContain('c500')
    // "conversation 07" matches Conversation 0700-0799.
    update({ searchQuery: 'conversation 07' })
    await act(async () => { await Promise.resolve() })
    measure()
    expect(list.scrollTop).toBe(0)
    const rows = renderedIds(list)
    expect(rows[0]).toBe('c700')
    expect(rows.every((id) => Number(id.slice(1)) >= 700 && Number(id.slice(1)) < 800)).toBe(true)
    expect(list.querySelector('[data-conversation-window-row="c700"]')).toHaveAttribute('aria-setsize', '100')

    scrollList(list, 2_000)
    expect(renderedIds(list)).toContain('c750')
    update({ searchQuery: 'conversation 001' })
    await act(async () => { await Promise.resolve() })
    // Ten matches: below the threshold, all rendered.
    expect(renderedIds(list)).toEqual(Array.from({ length: 10 }, (_, index) => idOf(10 + index)))
    expect(list.querySelector('.conversation-list__spacer')).toBeNull()
  })

  it('still reorders on the 5 s tick and pauses while hovered', () => {
    vi.useFakeTimers()
    const { list, store } = setup(1_000)
    const bump = (index: number, time: number): void => act(() => store.set((current) => current.map((item) =>
      item.id === idOf(index) ? { ...item, messageSummary: { count: 1, latestMessageAt: time } } : item)))
    bump(700, 2_000_000)
    expect(renderedIds(list)[0]).toBe('c0')
    fireEvent.mouseEnter(list)
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(renderedIds(list)[0]).toBe('c0')
    fireEvent.mouseLeave(list)
    act(() => { vi.advanceTimersByTime(5_000) })
    measure()
    expect(renderedIds(list).slice(0, 2)).toEqual(['c700', 'c0'])
    expect(screen.getByText(title(700)).closest('[role="listitem"]')).toHaveAttribute('aria-posinset', '1')

    // Scrolling pauses the tick for 200 ms like before windowing.
    bump(800, 3_000_000)
    act(() => { vi.advanceTimersByTime(4_900) })
    scrollList(list, 40)
    act(() => { vi.advanceTimersByTime(100) })
    expect(renderedIds(list)).not.toContain('c800')
    scrollList(list, 0)
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(renderedIds(list)[0]).toBe('c800')
  })
})
