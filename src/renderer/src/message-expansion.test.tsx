import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message } from './ChatTimeline'
import { MessageExpansionProvider, MessageExpansionScope, useMessageExpansion } from './message-expansion'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function Disclosure({ id, automaticOpen = false }: { id: string; automaticOpen?: boolean }) {
  const [open, setOpen] = useMessageExpansion(id, automaticOpen)
  return <button aria-label={id} aria-pressed={open} onClick={() => setOpen(!open)} />
}

function captureMaps() {
  const maps = new Set<Map<unknown, unknown>>()
  const original = Map.prototype.set
  vi.spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<unknown, unknown>, key, value) {
    if (value && typeof value.open === 'boolean' && typeof value.automaticOpen === 'boolean') maps.add(this)
    return original.call(this, key, value)
  })
  return () => [...maps].reduce((total, map) => total + map.size, 0)
}

describe('message expansion retention', () => {
  it('keeps streaming defaults sparse and releases an unmounted manual collapse on completion', async () => {
    const entries = captureMaps()
    const message: Message = { id: 'm', content: '', reasoning: 'Reason', state: 'streaming', role: 'assistant', createdAt: 1 }
    const window = (current: Message, visible: boolean) => <MessageExpansionProvider messages={[current]} messageIndexes={new Map([['m', 0]])}>
      {visible && <MessageExpansionScope id="m"><Disclosure id="reasoning" automaticOpen={current.state === 'streaming'} /></MessageExpansionScope>}
    </MessageExpansionProvider>
    const view = render(window(message, true))
    expect(entries()).toBe(0)
    expect(view.getByRole('button')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(view.getByRole('button'))
    expect(entries()).toBe(1)
    view.rerender(window(message, false))
    view.rerender(window(message, true))
    expect(view.getByRole('button')).toHaveAttribute('aria-pressed', 'false')
    view.rerender(window(message, false))
    const completed = { ...message, state: 'complete' as const }
    await act(async () => view.rerender(window(completed, false)))
    expect(entries()).toBe(0)
    view.rerender(window(completed, true))
    expect(view.getByRole('button')).toHaveAttribute('aria-pressed', 'false')
  })

  it('removes obsolete child and block identities without treating row eviction as deletion', async () => {
    const entries = captureMaps()
    const message: Message = { id: 'm', content: '', state: 'complete', role: 'assistant', createdAt: 1,
      blocks: [{ id: 'reason', type: 'reasoning', content: 'Reason' }],
      subagents: [{ childTaskId: 'child', expertId: 'expert', expertName: 'Expert', routingMode: 'native', state: 'completed' }] }
    const window = (current: Message, visible: boolean) => <MessageExpansionProvider messages={[current]} messageIndexes={new Map([['m', 0]])}>
      {visible && <MessageExpansionScope id="m"><Disclosure id="reasoning:reason" />
        <MessageExpansionScope id="subagent:child"><Disclosure id="subagent" /></MessageExpansionScope>
      </MessageExpansionScope>}
    </MessageExpansionProvider>
    const view = render(window(message, true))
    fireEvent.click(view.getByRole('button', { name: 'reasoning:reason' }))
    fireEvent.click(view.getByRole('button', { name: 'subagent' }))
    view.rerender(window(message, false))
    expect(entries()).toBe(2)
    await act(async () => view.rerender(window({ ...message, blocks: [], subagents: [] }, false)))
    expect(entries()).toBe(0)
  })

  it('visits 10,000 untouched rows without retaining defaults, including absent citations', () => {
    const entries = captureMaps()
    const messages: Message[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: `m${index}`, content: 'Plain message', role: 'assistant', state: 'complete', createdAt: index,
    }))
    const messageIndexes = new Map(messages.map((message, index) => [message.id, index]))
    const window = (start: number) => <MessageExpansionProvider messages={messages} messageIndexes={messageIndexes}>
      {messages.slice(start, start + 80).map(message => <MessageExpansionScope key={message.id} id={message.id}>
        <Disclosure id="citations" />
      </MessageExpansionScope>)}
    </MessageExpansionProvider>
    const view = render(window(0))
    for (let start = 80; start < messages.length; start += 80) view.rerender(window(start))
    expect(view.container.querySelectorAll('button').length).toBeLessThanOrEqual(80)
    expect(entries()).toBe(0)
  })

  it('retains only overrides across eviction and cleans removed messages and disclosures', async () => {
    const entries = captureMaps()
    const messages: Message[] = [{ id: 'm', content: '', role: 'assistant', state: 'complete', createdAt: 1,
      reasoning: 'Reason', tools: [{ callId: 'read', name: 'read', summary: '', state: 'completed', input: 'input' }] }]
    const window = (items: Message[], visible: boolean) => <MessageExpansionProvider messages={items}
      messageIndexes={new Map(items.map((message, index) => [message.id, index]))}>
      {visible && <MessageExpansionScope id="m"><Disclosure id="reasoning" /><Disclosure id="tool:read" /><Disclosure id="tool-input:read" /></MessageExpansionScope>}
    </MessageExpansionProvider>
    const view = render(window(messages, true))
    fireEvent.click(view.getByRole('button', { name: 'reasoning' }))
    fireEvent.click(view.getByRole('button', { name: 'tool:read' }))
    fireEvent.click(view.getByRole('button', { name: 'tool-input:read' }))
    expect(entries()).toBe(3)
    view.rerender(window(messages, false))
    expect(entries()).toBe(3)
    view.rerender(window(messages, true))
    expect(view.getByRole('button', { name: 'reasoning' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(view.getByRole('button', { name: 'reasoning' }))
    expect(entries()).toBe(2)
    view.rerender(window(messages, false))
    await act(async () => view.rerender(window([{ ...messages[0]!, tools: undefined }], false)))
    expect(entries()).toBe(0)
    view.rerender(window(messages, true))
    fireEvent.click(view.getByRole('button', { name: 'reasoning' }))
    expect(entries()).toBe(1)
    await act(async () => view.rerender(window([], false)))
    expect(entries()).toBe(0)
  })
})
