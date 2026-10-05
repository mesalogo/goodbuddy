import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Message } from './ChatTimeline'

type Expansion = { open: boolean; automaticOpen: boolean }
type Override = Expansion & { messageId: string; scopeId?: string; id: string }
const ExpansionContext = createContext<{
  states: Map<string, Override>; path: string; messageId?: string; scopeId?: string
} | undefined>(undefined)

/** Only called for saved overrides, after message updates, never on scroll. */
function currentDefault(message: Message, entry: Override): boolean | undefined {
  const child = entry.scopeId ? message.subagents?.find(item => `subagent:${item.childTaskId}` === entry.scopeId) : undefined
  if (entry.scopeId && !child) return undefined
  const blocks = child ? child.progress : message.blocks
  const automaticOpen = !child && message.state === 'streaming'
  if (entry.id === 'subagent') return child ? false : undefined
  if (entry.id === 'citations') return message.sourceReferences?.length ? false : undefined
  if (entry.id === 'reasoning') return !blocks?.length && message.reasoning ? automaticOpen : undefined
  if (entry.id.startsWith('reasoning:')) {
    return blocks?.some(block => block.type === 'reasoning' && `reasoning:${block.id}` === entry.id) ? automaticOpen : undefined
  }
  const input = entry.id.startsWith('tool-input:')
  const toolId = entry.id.slice(input ? 'tool-input:'.length : 'tool:'.length)
  const matches = (tool: NonNullable<Message['tools']>[number]) =>
    (tool.callId ?? tool.name) === toolId && (!input || Boolean(tool.input))
  const exists = blocks?.length ? blocks.some(block => block.type === 'tool' && matches(block.tool))
    : !child && message.tools?.some(matches)
  return exists ? false : undefined
}

/** Owned by the history pane, not by rows that scrolling can unmount. */
export function MessageExpansionProvider({ children, messages, messageIndexes }: {
  children: ReactNode; messages: readonly Message[]; messageIndexes: ReadonlyMap<string, number>
}) {
  const [value] = useState(() => ({ states: new Map<string, Override>(), path: '' }))
  useEffect(() => {
    for (const [key, entry] of value.states) {
      const index = messageIndexes.get(entry.messageId)
      const message = index === undefined ? undefined : messages[index]
      if (!message || currentDefault(message, entry) !== entry.automaticOpen) value.states.delete(key)
    }
  }, [messages, messageIndexes, value])
  return <ExpansionContext value={value}>{children}</ExpansionContext>
}

export function MessageExpansionScope({ id, children }: { id: string; children: ReactNode }) {
  const parent = useContext(ExpansionContext)
  const value = useMemo(() => parent && ({ states: parent.states, path: `${parent.path}/${JSON.stringify(id)}`,
    messageId: parent.messageId ?? id, scopeId: parent.messageId ? id : undefined }), [parent, id])
  return <ExpansionContext value={value}>{children}</ExpansionContext>
}

export function useMessageExpansion(id: string, automaticOpen = false): [boolean, (open: boolean) => void] {
  const context = useContext(ExpansionContext)
  const key = `${context?.path}/${JSON.stringify(id)}`
  const [state, setState] = useState(() => {
    const saved = context?.states.get(key)
    return saved?.automaticOpen === automaticOpen ? saved : { open: automaticOpen, automaticOpen }
  })
  // Reasoning still opens while streaming and closes on completion, including
  // when that transition happened while its row was outside the window.
  if (state.automaticOpen !== automaticOpen) setState({ open: automaticOpen, automaticOpen })
  return [state.open, open => {
    const next = { open, automaticOpen }
    if (open === automaticOpen) context?.states.delete(key)
    else if (context?.messageId) context.states.set(key, { ...next, messageId: context.messageId, scopeId: context.scopeId, id })
    setState(next)
  }]
}
