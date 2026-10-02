import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { sortConversationsForDisplay, type Conversation } from './chat-conversation'

export function useConversationListOrder(
  conversations: readonly Conversation[],
  scope: string,
  menuOpen: boolean,
) {
  const listRef = useRef<HTMLDivElement>(null)
  const mouseWithin = useRef(false)
  const scrollIdleAt = useRef(0)
  const [order, setOrder] = useState(() => ({
    scope,
    ids: sortConversationsForDisplay(conversations).map(item => item.id),
    pins: new Map(conversations.map(item => [item.id, Boolean(item.pinned)])),
  }))
  const byId = useMemo(() => new Map(conversations.map(item => [item.id, item])), [conversations])
  const reconciled = useMemo(() => {
    const changed = new Set(conversations.filter(item =>
      !order.pins.has(item.id) || order.pins.get(item.id) !== Boolean(item.pinned),
    ).map(item => item.id))
    const scopeChanged = order.scope !== scope
    if (!scopeChanged && !changed.size && order.ids.length === byId.size) return order

    const sorted = sortConversationsForDisplay(conversations).map(item => item.id)
    const ids = scopeChanged ? sorted : order.ids.filter(id => byId.has(id) && !changed.has(id))
    if (!scopeChanged) {
      const ranks = new Map(sorted.map((id, index) => [id, index]))
      // Insert only new or repinned rows; leave unrelated pending moves for a tick.
      for (const id of sorted) {
        if (!changed.has(id)) continue
        const index = ids.findIndex(existing => ranks.get(existing)! > ranks.get(id)!)
        ids.splice(index < 0 ? ids.length : index, 0, id)
      }
    }
    return { scope, ids, pins: new Map(conversations.map(item => [item.id, Boolean(item.pinned)])) }
  }, [byId, conversations, order, scope])
  if (reconciled !== order) setOrder(reconciled)

  const reorder = useEffectEvent(() => {
    if (menuOpen || mouseWithin.current || Date.now() < scrollIdleAt.current ||
      listRef.current?.contains(document.activeElement)) return
    const ids = sortConversationsForDisplay(conversations).map(item => item.id)
    setOrder(current => ids.every((id, index) => current.ids[index] === id) && ids.length === current.ids.length
      ? current : { ...current, ids })
  })
  useEffect(() => {
    const timer = window.setInterval(() => reorder(), 5000)
    return () => window.clearInterval(timer)
  }, [])

  const orderedConversations = useMemo(() => reconciled.ids.map(id => byId.get(id)!), [byId, reconciled])
  return {
    conversations: orderedConversations,
    listProps: {
      ref: listRef,
      onMouseEnter: () => { mouseWithin.current = true },
      onMouseLeave: () => { mouseWithin.current = false },
      onScroll: () => { scrollIdleAt.current = Date.now() + 200 },
    },
  }
}
