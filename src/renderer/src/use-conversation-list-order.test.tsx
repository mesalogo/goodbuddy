import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from './chat-conversation'
import { useConversationListOrder } from './use-conversation-list-order'

function conversation(id: string, time: number, pinned = false): Conversation {
  return { id, title: id, updatedAt: time, pinned, messages: [], messageSummary: { count: 1, latestMessageAt: time } }
}

function List({ items, scope = 'all', menuOpen = false }: {
  items: Conversation[]; scope?: string; menuOpen?: boolean
}) {
  const { conversations, listProps } = useConversationListOrder(items, scope, menuOpen)
  return <>
    <div data-testid="list" {...listProps}>
      {conversations.map(item => <button key={item.id} data-id={item.id}>{item.title}</button>)}
    </div>
    <button>Outside</button>
  </>
}

const ids = () => Array.from(screen.getByTestId('list').querySelectorAll('button'), item => item.dataset.id)
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('useConversationListOrder', () => {
  it('keeps content live and applies the latest order on a fixed cadence despite continuous deltas', () => {
    const a = conversation('a', 20)
    const b = conversation('b', 10)
    const { rerender } = render(<List items={[b, a]} />)
    expect(ids()).toEqual(['a', 'b'])
    for (let delta = 1; delta <= 4; delta++) {
      advance(1000)
      rerender(<List items={[a, { ...b, title: `Live ${delta}`, messageSummary: { count: delta, latestMessageAt: 30 + delta } }]} />)
      expect(screen.getByText(`Live ${delta}`)).toBeTruthy()
      expect(ids()).toEqual(['a', 'b'])
    }
    advance(999)
    expect(ids()).toEqual(['a', 'b'])
    advance(1)
    expect(ids()).toEqual(['b', 'a'])
    rerender(<List items={[{ ...a, messageSummary: { count: 2, latestMessageAt: 100 } }, b]} />)
    advance(4999)
    expect(ids()).toEqual(['b', 'a'])
    advance(1)
    expect(ids()).toEqual(['a', 'b'])
  })

  it('skips hovered ticks and waits for the next tick after the mouse leaves', () => {
    const { rerender } = render(<List items={[conversation('a', 20), conversation('b', 10)]} />)
    fireEvent.mouseEnter(screen.getByTestId('list'))
    rerender(<List items={[conversation('a', 20), conversation('b', 30)]} />)
    advance(10000)
    expect(ids()).toEqual(['a', 'b'])
    fireEvent.mouseLeave(screen.getByTestId('list'))
    advance(4999)
    expect(ids()).toEqual(['a', 'b'])
    advance(1)
    expect(ids()).toEqual(['b', 'a'])
  })

  it('keeps order while focus moves between rows and resumes only after focus leaves', () => {
    const { rerender } = render(<List items={[conversation('a', 20), conversation('b', 10)]} />)
    act(() => screen.getByText('a').focus())
    rerender(<List items={[conversation('a', 20), conversation('b', 30)]} />)
    advance(5000)
    act(() => screen.getByText('b').focus())
    advance(5000)
    expect(ids()).toEqual(['a', 'b'])
    act(() => screen.getByText('Outside').focus())
    expect(ids()).toEqual(['a', 'b'])
    advance(5000)
    expect(ids()).toEqual(['b', 'a'])
  })

  it('extends scroll activity on each event and resumes on a tick after 200ms idle', () => {
    const { rerender } = render(<List items={[conversation('a', 20), conversation('b', 10)]} />)
    rerender(<List items={[conversation('a', 20), conversation('b', 30)]} />)
    advance(4750)
    fireEvent.scroll(screen.getByTestId('list'))
    advance(150)
    fireEvent.scroll(screen.getByTestId('list'))
    advance(100)
    expect(ids()).toEqual(['a', 'b'])
    advance(4999)
    expect(ids()).toEqual(['a', 'b'])
    advance(1)
    expect(ids()).toEqual(['b', 'a'])
  })

  it('reads the latest menu state without restarting the interval', () => {
    const initial = [conversation('a', 20), conversation('b', 10)]
    const updated = [conversation('a', 20), conversation('b', 30)]
    const { rerender } = render(<List items={initial} />)
    advance(4000)
    rerender(<List items={updated} menuOpen />)
    advance(1000)
    expect(ids()).toEqual(['a', 'b'])
    advance(4000)
    rerender(<List items={updated} />)
    expect(ids()).toEqual(['a', 'b'])
    advance(1000)
    expect(ids()).toEqual(['b', 'a'])
  })

  it('creates, deletes, pins and unpins immediately without flushing unrelated pending moves', () => {
    const a = conversation('a', 30)
    const b = conversation('b', 20)
    const c = conversation('c', 10)
    const { rerender } = render(<List items={[a, b, c]} menuOpen />)
    const newerB = conversation('b', 40)
    rerender(<List items={[a, newerB, c]} menuOpen />)
    const d = conversation('d', 50)
    rerender(<List items={[a, newerB, c, d]} menuOpen />)
    expect(ids()).toEqual(['d', 'a', 'b', 'c'])
    rerender(<List items={[a, newerB, c]} menuOpen />)
    expect(ids()).toEqual(['a', 'b', 'c'])
    rerender(<List items={[a, newerB, { ...c, pinned: true }]} menuOpen />)
    expect(ids()).toEqual(['c', 'a', 'b'])
    rerender(<List items={[a, newerB, c]} menuOpen />)
    expect(ids()).toEqual(['a', 'b', 'c'])
    advance(5000)
    expect(ids()).toEqual(['a', 'b', 'c'])
    rerender(<List items={[a, newerB, c]} />)
    advance(5000)
    expect(ids()).toEqual(['b', 'a', 'c'])
  })

  it('applies scope changes and asynchronous filter membership immediately while paused', () => {
    const a = conversation('a', 20)
    const b = conversation('b', 10)
    const { rerender } = render(<List items={[a, b]} menuOpen />)
    const newerB = conversation('b', 30)
    rerender(<List items={[a, newerB]} menuOpen />)
    expect(ids()).toEqual(['a', 'b'])
    rerender(<List items={[a, newerB]} scope="search" menuOpen />)
    expect(ids()).toEqual(['b', 'a'])
    rerender(<List items={[a]} scope="search" menuOpen />)
    expect(ids()).toEqual(['a'])
    rerender(<List items={[a, newerB]} scope="search" menuOpen />)
    expect(ids()).toEqual(['b', 'a'])
    rerender(<List items={[]} scope="project" menuOpen />)
    expect(ids()).toEqual([])
  })

  it('cleans up the interval on unmount and does not duplicate it in Strict Mode', () => {
    const { unmount } = render(<StrictMode><List items={[]} /></StrictMode>)
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
