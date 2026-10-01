import { useLayoutEffect, useState } from 'react'

type AnyHandler = (...args: never[]) => unknown

/**
 * Returns an object of handlers whose identity never changes while each call
 * still runs the latest implementation (published after every commit).
 * Memoized children receiving it skip re-renders caused by new closures.
 * Calls are only valid after mount, as for any event handler.
 */
export function useStableHandlers<T extends Record<string, AnyHandler>>(
  latest: T
): T {
  const [{ slot, handlers }] = useState(() => createForwardingHandlers(latest))
  useLayoutEffect(() => {
    latestHandlers.set(slot, latest)
  })
  return handlers
}

const latestHandlers = new WeakMap<object, Record<string, AnyHandler>>()

function createForwardingHandlers<T extends Record<string, AnyHandler>>(
  initial: T
): { slot: object; handlers: T } {
  const slot = {}
  latestHandlers.set(slot, initial)
  const handlers = {} as Record<string, AnyHandler>
  for (const key of Object.keys(initial)) {
    // Looked up when a handler is invoked (an event), never during render.
    handlers[key] = (...args: never[]) => latestHandlers.get(slot)![key]!(...args)
  }
  return { slot, handlers: handlers as T }
}

/**
 * Keeps the previous derived value when a recomputation produces an equal one.
 *
 * Streaming updates replace the conversation array on every delta, so values
 * derived from it (titles, pending approvals, activity summaries) would get a
 * new identity each time and re-render memoized consumers even though nothing
 * they display changed. Returning the previous, equal value is always safe.
 */
const previousValues = new WeakMap<object, unknown>()

export function useStableDerivedValue<T>(
  next: T,
  equal: (previous: T, next: T) => boolean
): T {
  const [slot] = useState(() => ({}))
  if (previousValues.has(slot)) {
    const previous = previousValues.get(slot) as T
    if (previous === next || equal(previous, next)) {
      return previous
    }
  }
  previousValues.set(slot, next)
  return next
}

export function sameMapEntries<K, V>(
  left: ReadonlyMap<K, V>,
  right: ReadonlyMap<K, V>
): boolean {
  if (left.size !== right.size) return false
  for (const [key, value] of left) {
    if (!right.has(key) || !Object.is(right.get(key), value)) return false
  }
  return true
}

export function sameArrayItems<T>(
  left: readonly T[],
  right: readonly T[],
  sameItem: (left: T, right: T) => boolean = Object.is
): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (!sameItem(left[index]!, right[index]!)) return false
  }
  return true
}
