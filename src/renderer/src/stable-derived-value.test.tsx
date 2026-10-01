import { act, render } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { sortConversationsForDisplay, type Conversation } from './chat-conversation'
import {
  sameArrayItems,
  sameMapEntries,
  useStableDerivedValue,
  useStableHandlers
} from './stable-derived-value'

describe('useStableDerivedValue', () => {
  it('keeps the previous value only while it is equal', () => {
    const seen: Map<string, string>[] = []
    let setEntries!: (entries: [string, string][]) => void
    function Probe(): null {
      const [entries, set] = useState<[string, string][]>([['a', 'A']])
      setEntries = set
      seen.push(useStableDerivedValue(new Map(entries), sameMapEntries))
      return null
    }
    render(<Probe />)
    act(() => setEntries([['a', 'A']]))
    expect(seen[1]).toBe(seen[0])
    act(() => setEntries([['a', 'B']]))
    expect(seen[2]).not.toBe(seen[1])
    expect(seen[2]!.get('a')).toBe('B')
  })

  it('compares arrays item by item', () => {
    expect(sameArrayItems([1, 2], [1, 2])).toBe(true)
    expect(sameArrayItems([1, 2], [1])).toBe(false)
    expect(sameArrayItems([{ id: 1 }], [{ id: 1 }], (a, b) => a.id === b.id)).toBe(true)
  })
})

describe('useStableHandlers', () => {
  it('keeps one identity and always calls the latest implementation', () => {
    const results: string[] = []
    let handlersSeen: { run: () => void }[] = []
    let setLabel!: (label: string) => void
    function Probe(): null {
      const [label, set] = useState('first')
      setLabel = set
      handlersSeen.push(useStableHandlers({ run: () => results.push(label) }))
      return null
    }
    render(<Probe />)
    handlersSeen[0]!.run()
    act(() => setLabel('second'))
    handlersSeen[1]!.run()
    expect(handlersSeen[1]).toBe(handlersSeen[0])
    expect(results).toEqual(['first', 'second'])
    handlersSeen = []
  })
})

describe('sortConversationsForDisplay', () => {
  const message = (id: string, createdAt: number): Conversation['messages'][number] =>
    ({ id, role: 'user', content: id, createdAt, state: 'complete' })

  it('reflects new message arrays and summaries while reusing unchanged scans', () => {
    const a: Conversation = { id: 'a', title: 'A', updatedAt: 1, messages: [message('a1', 10)] }
    const b: Conversation = { id: 'b', title: 'B', updatedAt: 1, messages: [message('b1', 20)] }
    expect(sortConversationsForDisplay([a, b]).map(({ id }) => id)).toEqual(['b', 'a'])
    const newer = { ...a, messages: [...a.messages, message('a2', 30)] }
    expect(sortConversationsForDisplay([newer, b]).map(({ id }) => id)).toEqual(['a', 'b'])
    const summarized = { ...b, messageSummary: { count: 2, latestMessageAt: 40 } } as Conversation
    expect(sortConversationsForDisplay([newer, summarized]).map(({ id }) => id)).toEqual(['b', 'a'])
    const pinned = { ...a, pinned: true }
    expect(sortConversationsForDisplay([summarized, pinned]).map(({ id }) => id)).toEqual(['a', 'b'])
    const empty: Conversation = { id: 'c', title: 'C', updatedAt: 50, messages: [] }
    expect(sortConversationsForDisplay([newer, empty]).map(({ id }) => id)).toEqual(['c', 'a'])
  })
})
