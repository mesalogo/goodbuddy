import { useCallback, useLayoutEffect, useRef, useState } from 'react'

/**
 * Windowing for the sidebar conversation list (PERF-14).
 *
 * Long lists mount only the rows near the viewport; spacers stand in for the
 * rest, sized from measured row heights (or the mean measured height for rows
 * never rendered). The list is top-anchored like any normal list. Rows that
 * hold user state (focus, open menu, rename, the active conversation) stay
 * mounted at their real position even when scrolled away.
 */

/** Lists shorter than this render every row (no windowing). */
export const conversationListWindowThreshold = 60
/** Height assumed for rows before any row has been measured. */
export const estimatedConversationRowHeight = 40
/** Upper bound for rows mounted from the range (kept rows come on top). */
export const maxRenderedConversationRows = 120
const fallbackViewportHeight = 800

export function conversationListOverscan(viewportHeight: number): number {
  return Math.max(320, Math.round(viewportHeight))
}

export type ConversationListSegment =
  | { kind: 'spacer'; key: string; height: number }
  | { kind: 'row'; index: number }

class ConversationRowHeights {
  private readonly sizes = new Map<string, number>()
  private estimateValue = estimatedConversationRowHeight
  private viewportValue = 0

  get viewport(): number {
    return this.viewportValue > 0 ? this.viewportValue : fallbackViewportHeight
  }

  setViewport(height: number): boolean {
    if (height <= 0 || Math.abs(height - this.viewportValue) < 1) return false
    this.viewportValue = height
    return true
  }

  size(id: string): number {
    return this.sizes.get(id) ?? this.estimateValue
  }

  /** Records a height; returns whether layout may have changed. */
  set(id: string, height: number): boolean {
    const previous = this.sizes.get(id)
    if (previous !== undefined) {
      if (Math.abs(previous - height) < 0.5) return false
      this.sizes.set(id, height)
      return true
    }
    const count = this.sizes.size
    this.estimateValue = count === 0 ? height : (this.estimateValue * count + height) / (count + 1)
    this.sizes.set(id, height)
    return true
  }
}

type Layout = {
  /** offsets[i] is the top of row i; offsets[count] is the total height. */
  offsets: number[]
  start: number
  end: number
  viewport: number
}

/** Rows covering the viewport whose top is `scrollTop`, plus `overscan` on both sides. */
export function conversationWindowRange(
  offsets: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
  maxCount = maxRenderedConversationRows,
): { start: number; end: number } {
  const count = offsets.length - 1
  const total = offsets[count] ?? 0
  const top = Math.min(Math.max(0, scrollTop), Math.max(0, total - viewportHeight))
  let start = 0
  while (start < count && offsets[start + 1]! <= top - overscan) start += 1
  let end = start
  while (end < count && offsets[end]! < top + viewportHeight + overscan) end += 1
  if (end - start > maxCount) {
    // Keep the rows at the viewport top; trim the overscan evenly.
    let first = start
    while (first < end && offsets[first + 1]! <= top) first += 1
    start = Math.max(start, Math.min(first - Math.floor(maxCount / 4), end - maxCount))
    end = Math.min(end, start + maxCount)
  }
  return { start, end }
}

export function useConversationListWindow({
  ids,
  scope,
  scrollRef,
  keepIds,
  enabled,
}: {
  /** Row ids in display order. */
  ids: readonly string[]
  /** Changing the scope (project, search) returns the list to the top. */
  scope: string
  scrollRef: React.RefObject<HTMLElement | null>
  /** Ids that must stay mounted (active, menu open, renaming...). */
  keepIds: readonly (string | undefined)[]
  enabled: boolean
}) {
  const windowed = enabled && ids.length >= conversationListWindowThreshold
  const [heights] = useState(() => new ConversationRowHeights())
  const [measureVersion, setMeasureVersion] = useState(0)
  // scrollTop at the last re-window; the range is derived from it.
  const [anchorTop, setAnchorTop] = useState(0)
  const [focusedId, setFocusedId] = useState<string | undefined>(undefined)
  const [seenScope, setSeenScope] = useState(scope)
  if (seenScope !== scope) {
    setSeenScope(scope)
    setAnchorTop(0)
  }

  const layoutRef = useRef<Layout | undefined>(undefined)
  const rowElements = useRef(new Map<string, HTMLElement>())
  const rowRefCallbacks = useRef(new Map<string, (element: HTMLElement | null) => void>())
  const observerRef = useRef<ResizeObserver | undefined>(undefined)
  const scrollAnchorRef = useRef<{ id: string; top: number } | undefined>(undefined)
  const scopeRef = useRef(scope)

  const keep = new Set([...keepIds, focusedId].filter((id): id is string => Boolean(id)))
  // Kept rows change the mounted set (and spacers), so the layout effect reruns.
  const keepKey = [...keep].join('\n')
  let segments: ConversationListSegment[]
  let layout: Layout | undefined
  if (!windowed) {
    segments = ids.map((_, index) => ({ kind: 'row', index }))
  } else {
    const offsets = new Array<number>(ids.length + 1)
    offsets[0] = 0
    for (let index = 0; index < ids.length; index += 1) {
      offsets[index + 1] = offsets[index]! + heights.size(ids[index]!)
    }
    const viewport = heights.viewport
    const range = conversationWindowRange(offsets, anchorTop, viewport, conversationListOverscan(viewport))
    layout = { offsets, start: range.start, end: range.end, viewport }
    const rendered: number[] = []
    for (let index = range.start; index < range.end; index += 1) rendered.push(index)
    if (keep.size) {
      ids.forEach((id, index) => {
        if (keep.has(id) && (index < range.start || index >= range.end)) rendered.push(index)
      })
      rendered.sort((left, right) => left - right)
    }
    // The top spacer is always present so it keeps its identity while the window moves.
    segments = [{ kind: 'spacer', key: 'top', height: 0 }]
    let previous = 0
    for (const index of rendered) {
      if (index > previous) {
        const height = offsets[index]! - offsets[previous]!
        if (previous === 0) segments[0] = { kind: 'spacer', key: 'top', height }
        else segments.push({ kind: 'spacer', key: `gap:${ids[previous]}`, height })
      }
      segments.push({ kind: 'row', index })
      previous = index + 1
    }
    if (previous < ids.length) {
      segments.push({ kind: 'spacer', key: 'bottom', height: offsets[ids.length]! - offsets[previous]! })
    }
  }

  useLayoutEffect(() => {
    layoutRef.current = layout
  })

  /** First mounted row reaching into the viewport, relative to the viewport top. */
  const captureScrollAnchor = useCallback((): void => {
    const container = scrollRef.current
    if (!container || container.scrollTop <= 0) {
      scrollAnchorRef.current = undefined
      return
    }
    const viewportTop = container.getBoundingClientRect().top
    for (const element of container.querySelectorAll<HTMLElement>('[data-conversation-window-row]')) {
      const rect = element.getBoundingClientRect()
      if (rect.bottom > viewportTop) {
        scrollAnchorRef.current = { id: element.dataset.conversationWindowRow ?? '', top: rect.top - viewportTop }
        return
      }
    }
    scrollAnchorRef.current = undefined
  }, [scrollRef])

  // Row and viewport measurement.
  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!windowed || !container) return
    if (heights.setViewport(container.clientHeight)) setMeasureVersion((version) => version + 1)
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver((entries) => {
      let changed = false
      for (const entry of entries) {
        const target = entry.target as HTMLElement
        if (target === container) {
          if (heights.setViewport(container.clientHeight)) changed = true
          continue
        }
        const id = target.dataset?.conversationWindowRow
        if (!id) continue
        const height = target.getBoundingClientRect().height
        if (height > 0 && heights.set(id, height)) changed = true
      }
      if (changed) {
        // Spacer sizes may change with the new estimate; keep the visible row in place.
        captureScrollAnchor()
        setMeasureVersion((version) => version + 1)
      }
    })
    observer.observe(container)
    for (const element of rowElements.current.values()) observer.observe(element)
    observerRef.current = observer
    return () => {
      observer.disconnect()
      observerRef.current = undefined
    }
  }, [captureScrollAnchor, heights, scrollRef, windowed])

  // After each commit: restore the visible row's position after a re-layout,
  // return to the top on a scope change, and re-window when the scroll
  // position left the mounted rows without a scroll event (content shrank).
  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container) return
    if (scopeRef.current !== scope) {
      scopeRef.current = scope
      scrollAnchorRef.current = undefined
      // New search results or another project start at the top; short lists
      // keep the browser's own clamping, as before windowing.
      if (windowed && container.scrollTop !== 0) container.scrollTop = 0
    }
    const anchor = scrollAnchorRef.current
    scrollAnchorRef.current = undefined
    if (windowed && anchor) {
      const element = rowElements.current.get(anchor.id)
      if (element) {
        const delta = element.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.top
        if (Math.abs(delta) >= 0.5) container.scrollTop += delta
      }
    }
    const current = layoutRef.current
    if (!windowed || !current) return
    const scrollTop = container.scrollTop
    if (!coversViewport(current, scrollTop) && Math.abs(scrollTop - anchorTop) >= 1) setAnchorTop(scrollTop)
  }, [anchorTop, ids, keepKey, measureVersion, scope, scrollRef, windowed])

  const onScroll = useCallback((): void => {
    const container = scrollRef.current
    const current = layoutRef.current
    if (!container || !current) return
    if (heights.setViewport(container.clientHeight)) setMeasureVersion((version) => version + 1)
    const scrollTop = container.scrollTop
    // Hysteresis: re-window only when the viewport (plus a margin) leaves the
    // mounted rows, so a steady scroll remounts rows every screen or so.
    if (!coversViewport(current, scrollTop)) setAnchorTop(scrollTop)
  }, [heights, scrollRef])

  const rowRef = useCallback((id: string): ((element: HTMLElement | null) => void) => {
    let callback = rowRefCallbacks.current.get(id)
    if (!callback) {
      callback = (element) => {
        const previous = rowElements.current.get(id)
        if (previous && previous !== element) {
          observerRef.current?.unobserve(previous)
          rowElements.current.delete(id)
        }
        if (element && previous !== element) {
          rowElements.current.set(id, element)
          observerRef.current?.observe(element)
        }
        if (!element) rowRefCallbacks.current.delete(id)
      }
      rowRefCallbacks.current.set(id, callback)
    }
    return callback
  }, [])

  const onFocus = useCallback((event: React.FocusEvent<HTMLElement>): void => {
    const row = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-conversation-window-row]')
      : null
    setFocusedId(row?.dataset.conversationWindowRow)
  }, [])
  const onBlur = useCallback((event: React.FocusEvent<HTMLElement>): void => {
    const next = event.relatedTarget
    // Focus leaving the window (null) keeps the row; moving elsewhere releases it.
    if (next instanceof Node && !event.currentTarget.contains(next)) setFocusedId(undefined)
  }, [])

  return { windowed, segments, rowRef, onScroll, onFocus, onBlur }
}

function coversViewport(layout: Layout, scrollTop: number): boolean {
  const count = layout.offsets.length - 1
  const margin = Math.round(layout.viewport / 4)
  const renderedTop = layout.offsets[layout.start] ?? 0
  const renderedBottom = layout.offsets[layout.end] ?? 0
  const topCovered = layout.start === 0 || renderedTop <= scrollTop - margin
  const bottomCovered = layout.end >= count || renderedBottom >= scrollTop + layout.viewport + margin
  return topCovered && bottomCovered
}
