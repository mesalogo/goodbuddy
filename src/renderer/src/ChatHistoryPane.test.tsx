import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatHistoryPane, type ChatScrollSnapshot } from './ChatHistoryPane'
import type { Message } from './ChatTimeline'
import type { Conversation } from './chat-conversation'
import { clearRowHeightCache, maxRenderedMessageCount } from './chat-message-window'

vi.mock('./MarkdownRenderer', () => ({
  MarkdownRenderer: ({ children }: { children: string }) => <span>{children}</span>
}))

// --- A tiny fake layout: jsdom has none. ------------------------------------
// The scroll container is 400 px tall at viewport top 0. Children of the
// message list stack vertically: rows take their height from `rowHeights`
// (default 100), spacers their inline height, the "load earlier" button 30.
const viewport = 400
let rowHeights = new Map<string, number>()
let layoutEnabled = true

function chatOf(element: Element): HTMLElement | null {
  return element.closest<HTMLElement>('.chat')
}

function childHeight(child: HTMLElement): number {
  if (child.classList.contains('message-window-row')) {
    return rowHeights.get(child.dataset.messageId ?? '') ?? 100
  }
  if (child.classList.contains('message-window-spacer')) {
    return Number.parseFloat(child.style.height) || 0
  }
  if (child.classList.contains('load-earlier-messages')) return 30
  return 0
}

function contentHeight(chat: HTMLElement): number {
  const list = chat.querySelector<HTMLElement>('.message-list')
  return list ? [...list.children].reduce((sum, child) => sum + childHeight(child as HTMLElement), 0) : 0
}

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect
}

function fakeRect(this: HTMLElement): DOMRect {
  if (!layoutEnabled) return rect(0, 0)
  if (this.classList.contains('chat')) return rect(0, viewport)
  const chat = chatOf(this)
  const list = chat?.querySelector<HTMLElement>('.message-list')
  if (!chat || !list) return rect(0, 0)
  const item = this.parentElement === list ? this : this.closest<HTMLElement>('.message-window-row')
  if (!item || item.parentElement !== list) return rect(0, 0)
  let offset = 0
  for (const child of list.children) {
    if (child === item) break
    offset += childHeight(child as HTMLElement)
  }
  return rect(offset - chat.scrollTop, childHeight(item))
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  readonly observed = new Set<Element>()
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }
  observe(element: Element): void { this.observed.add(element) }
  unobserve(element: Element): void { this.observed.delete(element) }
  disconnect(): void { this.observed.clear() }
  /** Delivers entries for the observed elements matching `filter`. */
  fire(filter: (element: Element) => boolean = () => true): void {
    const entries = [...this.observed].filter(filter).map((target) => ({ target }) as ResizeObserverEntry)
    this.callback(entries, this as unknown as ResizeObserver)
  }
}

function latestObserver(): FakeResizeObserver {
  const observer = FakeResizeObserver.instances.at(-1)
  if (!observer) throw new Error('Missing ResizeObserver')
  return observer
}

function installScrollContainer(chat: HTMLElement): void {
  let scrollTop = 0
  const max = (): number => Math.max(0, contentHeight(chat) - viewport)
  Object.defineProperties(chat, {
    clientHeight: { configurable: true, get: () => viewport },
    scrollHeight: { configurable: true, get: () => contentHeight(chat) },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = Math.min(Math.max(0, value), max()) }
    }
  })
  chat.scrollTo = vi.fn((options?: ScrollToOptions | number) => {
    if (typeof options === 'object' && options.top !== undefined) chat.scrollTop = options.top
  }) as typeof chat.scrollTo
}

// Rows are measured, then the pane re-lays out with the real heights.
function measure(): void {
  act(() => latestObserver().fire())
}

function makeMessages(count: number, prefix = 'm'): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
    createdAt: 1_775_000_000_000 + index,
    state: 'complete'
  }))
}

function conversationOf(messages: Message[], id = 'conversation-1'): Conversation {
  return { id, title: 'Long', updatedAt: 1, messages } as unknown as Conversation
}

type PaneProps = ComponentProps<typeof ChatHistoryPane>

function baseProps(messages: Message[], overrides: Partial<PaneProps> = {}): PaneProps {
  return {
    active: true,
    artifactById: new Map(),
    conversation: conversationOf(messages),
    conversationHtmlRenderingEnabled: false,
    locale: 'zh-CN',
    onCopyMessage: vi.fn(async () => true),
    onDownloadImage: vi.fn(),
    onEditImage: vi.fn(),
    onOpenCitationContext: vi.fn(async () => undefined),
    onOpenCitationSource: vi.fn(async () => undefined),
    onOpenImage: vi.fn(),
    onOpenImageModelSettings: vi.fn(),
    onReselectImageSources: vi.fn(),
    onRespondApproval: vi.fn(async () => undefined),
    onRespondQuestion: vi.fn(async () => undefined),
    onRetry: vi.fn(),
    onScrollSnapshotChange: vi.fn(),
    onSetInput: vi.fn(),
    onVisibleMessageCountChange: vi.fn(),
    quickActions: [],
    visibleMessageCount: messages.length,
    ...overrides
  }
}

function setup(messages: Message[], overrides: Partial<PaneProps> = {}) {
  // The scroll container exists only after the first render, so install the
  // fake geometry right after mounting and lay out once more.
  const props = baseProps(messages, overrides)
  const view = render(<ChatHistoryPane {...props} />)
  const chat = view.container.querySelector<HTMLElement>('.chat')!
  installScrollContainer(chat)
  return { ...view, chat, props }
}

function frame(): Promise<void> {
  return act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
}

function renderedIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('.message-window-row')].map((row) => row.dataset.messageId ?? '')
}

function rowTop(container: HTMLElement, id: string): number {
  return container.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!.getBoundingClientRect().top
}

beforeEach(() => {
  rowHeights = new Map()
  layoutEnabled = true
  clearRowHeightCache()
  FakeResizeObserver.instances = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(fakeRect)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ChatHistoryPane windowing', () => {
  it('keeps the DOM bounded for a 2,000-message conversation at any scroll position', () => {
    const messages = makeMessages(2_000)
    const { container, chat } = setup(messages)
    measure()
    const atBottom = container.querySelectorAll('.message').length
    expect(atBottom).toBeGreaterThan(0)
    expect(atBottom).toBeLessThanOrEqual(maxRenderedMessageCount)
    expect(renderedIds(container).at(-1)).toBe('m1999')
    // The spacer stands in for the rest, so the full history is scrollable.
    expect(chat.scrollHeight).toBeGreaterThanOrEqual(2_000 * 100)

    for (const scrollTop of [100_000, 0, 150_000]) {
      act(() => {
        chat.scrollTop = scrollTop
        fireEvent.scroll(chat)
      })
      measure()
      const count = container.querySelectorAll('.message').length
      expect(count).toBeLessThanOrEqual(maxRenderedMessageCount + 1)
      const visible = renderedIds(container).filter((id) => {
        const top = rowTop(container, id)
        return top < viewport && top + 100 > 0
      })
      expect(visible.length).toBeGreaterThan(0)
    }
    expect(renderedIds(container)).toContain('m1500')
  })

  it('does not observe or measure rows while the pane is hidden', () => {
    const messages = makeMessages(200)
    const props = baseProps(messages, { active: false })
    const { container } = render(<ChatHistoryPane {...props} />)
    expect(FakeResizeObserver.instances).toHaveLength(0)
    expect(container.querySelectorAll('.message').length).toBeLessThanOrEqual(maxRenderedMessageCount)
  })

  it('follows a growing streaming reply once per frame while pinned', async () => {
    const messages = makeMessages(300)
    const { chat, container, rerender, props } = setup(messages)
    measure()
    await frame()
    act(() => { chat.scrollTop = chat.scrollHeight; fireEvent.scroll(chat) })
    const scrollTo = vi.mocked(chat.scrollTo)
    scrollTo.mockClear()
    let streaming = [...messages, { id: 'reply', role: 'assistant', content: 'a', createdAt: 2, state: 'streaming' } as Message]
    for (const chunk of [' b', ' c', ' d']) {
      const last = streaming.at(-1)!
      streaming = [...streaming.slice(0, -1), { ...last, content: last.content + chunk }]
      rowHeights.set('reply', (rowHeights.get('reply') ?? 100) + 120)
      rerender(<ChatHistoryPane {...props} conversation={conversationOf(streaming)} visibleMessageCount={streaming.length} />)
    }
    await frame()
    expect(scrollTo.mock.calls.length).toBeLessThanOrEqual(2)
    expect(scrollTo).toHaveBeenLastCalledWith({ top: chat.scrollHeight, behavior: 'auto' })
    expect(chat.scrollTop + viewport).toBe(chat.scrollHeight)
    expect(renderedIds(container).at(-1)).toBe('reply')

    // The last row keeps growing (layout settles): still pinned.
    rowHeights.set('reply', 900)
    act(() => latestObserver().fire((element) => (element as HTMLElement).dataset?.messageId === 'reply'))
    expect(chat.scrollTop + viewport).toBe(chat.scrollHeight)
  })

  it('keeps the reader in place while rows above change height or mount', () => {
    const messages = makeMessages(2_000)
    const { chat, container } = setup(messages)
    measure()
    act(() => { chat.scrollTop = 120_050; fireEvent.scroll(chat) })
    measure()
    const anchorId = renderedIds(container).find((id) => rowTop(container, id) + 100 > 0)!
    const before = rowTop(container, anchorId)

    // A row above the anchor (rendered overscan) grows, e.g. an image loads.
    const above = renderedIds(container)[0]!
    expect(above).not.toBe(anchorId)
    rowHeights.set(above, 400)
    act(() => latestObserver().fire((element) => (element as HTMLElement).dataset?.messageId === above))
    expect(rowTop(container, anchorId)).toBe(before)

    // Scrolling up mounts new rows above with measured heights that differ
    // from the estimate; what the reader sees does not jump.
    for (let index = 0; index < 2_000; index += 1) {
      if (index % 3 === 0) rowHeights.set(`m${index}`, 250)
    }
    act(() => { chat.scrollTop -= 3_000; fireEvent.scroll(chat) })
    const anchorAfterScroll = renderedIds(container).find((id) => rowTop(container, id) + (rowHeights.get(id) ?? 100) > 0)!
    const topAfterScroll = rowTop(container, anchorAfterScroll)
    measure()
    expect(rowTop(container, anchorAfterScroll)).toBe(topAfterScroll)
  })

  it('keeps the reader in place when earlier messages are revealed', () => {
    const messages = makeMessages(161)
    const onVisibleMessageCountChange = vi.fn()
    const { chat, container, rerender, props } = setup(messages, { visibleMessageCount: 80, onVisibleMessageCountChange })
    measure()
    act(() => { chat.scrollTop = 5_000; fireEvent.scroll(chat) })
    measure()
    const anchorId = renderedIds(container).find((id) => rowTop(container, id) + 100 > 0)!
    const before = rowTop(container, anchorId)
    fireEvent.click(container.querySelector('.load-earlier-messages')!)
    expect(onVisibleMessageCountChange).toHaveBeenCalledWith('conversation-1', 160)
    rerender(<ChatHistoryPane {...props} visibleMessageCount={160} />)
    measure()
    expect(rowTop(container, anchorId)).toBe(before)
    expect(container.querySelector('.load-earlier-messages')).toHaveTextContent('1')

    fireEvent.click(container.querySelector('.load-earlier-messages')!)
    rerender(<ChatHistoryPane {...props} visibleMessageCount={240} />)
    expect(container.querySelector('.load-earlier-messages')).toBeNull()
    // Focus moves to the first message, which is mounted for that.
    expect(container.querySelector('[data-message-id="m0"] article')).toHaveFocus()
    expect(container.querySelectorAll('.message').length).toBeLessThanOrEqual(maxRenderedMessageCount + 1)
  })

  it('renders an off-screen note target on demand, then scrolls to it', async () => {
    const messages = makeMessages(2_000)
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    const { container, rerender, props } = setup(messages, { visibleMessageCount: 80 })
    measure()
    expect(renderedIds(container)).not.toContain('m42')
    rerender(
      <ChatHistoryPane
        {...props}
        noteMessageNavigation={{ conversationId: 'conversation-1', messageId: 'm42', requestId: 1 }}
      />
    )
    expect(renderedIds(container)).toContain('m42')
    await frame()
    const target = container.querySelector<HTMLElement>('[data-message-id="m42"] article')!
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(target)
    expect(target).toHaveFocus()
    expect(container.querySelectorAll('.message').length).toBeLessThanOrEqual(maxRenderedMessageCount + 1)
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  })

  it('restores the reader position across hide/show and from a saved snapshot', () => {
    const messages = makeMessages(2_000)
    const onScrollSnapshotChange = vi.fn()
    const { chat, container, rerender, props, unmount } = setup(messages, { onScrollSnapshotChange })
    measure()
    act(() => { chat.scrollTop = 80_000; fireEvent.scroll(chat) })
    measure()
    act(() => { chat.scrollTop += 10; fireEvent.scroll(chat) })
    const scrollTop = chat.scrollTop
    const anchorId = renderedIds(container).find((id) => rowTop(container, id) + 100 > 0)!
    const anchorTop = rowTop(container, anchorId)

    rerender(<ChatHistoryPane {...props} active={false} />)
    // Browsers may drop scrollTop of a hidden pane.
    layoutEnabled = false
    chat.scrollTop = 0
    layoutEnabled = true
    rerender(<ChatHistoryPane {...props} active />)
    expect(chat.scrollTop).toBe(scrollTop)
    expect(rowTop(container, anchorId)).toBe(anchorTop)

    unmount()
    const snapshot = onScrollSnapshotChange.mock.calls.at(-1)?.[1] as ChatScrollSnapshot
    expect(snapshot).toMatchObject({ pinnedToBottom: false, scrollTop, anchorMessageId: anchorId })

    // A remounted pane (keep-alive eviction) restores from the snapshot.
    const remounted = render(<ChatHistoryPane {...baseProps(messages, { scrollSnapshot: snapshot })} />)
    expect(renderedIds(remounted.container)).toContain(anchorId)
    expect(remounted.container.querySelectorAll('.message').length).toBeLessThanOrEqual(maxRenderedMessageCount)
  })

  it('returns to the bottom when the user sends a message', async () => {
    const messages = makeMessages(500)
    const { chat, container, rerender, props } = setup(messages)
    measure()
    act(() => { chat.scrollTop = 1_000; fireEvent.scroll(chat) })
    measure()
    expect(container.querySelector('.chat-scroll-to-bottom')).not.toBeNull()
    const next = [...messages, { id: 'sent', role: 'user', content: 'new', createdAt: 3, state: 'complete' } as Message]
    rerender(<ChatHistoryPane {...props} conversation={conversationOf(next)} visibleMessageCount={next.length} />)
    await frame()
    expect(renderedIds(container).at(-1)).toBe('sent')
    expect(chat.scrollTop + viewport).toBe(chat.scrollHeight)
  })

  it('keeps messageIndex-based props for windowed rows', () => {
    const messages = makeMessages(300)
    messages[299] = { ...messages[299]!, state: 'error', content: 'failed' }
    messages[298] = { ...messages[298]!, role: 'user', content: 'prompt' }
    const { container } = setup(messages)
    measure()
    expect(container.querySelector('[data-message-id="m299"]')).toHaveAttribute('data-message-index', '299')
    expect(container.querySelector('[data-message-id="m299"]')?.textContent).toContain('重新编辑')
  })
})
