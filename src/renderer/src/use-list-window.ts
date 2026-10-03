import { useCallback, useLayoutEffect, useRef, useState } from 'react'

/**
 * Windowing for long renderer lists (PERF-14, P5).
 *
 * Long lists mount only the rows near the viewport; spacers stand in for the
 * rest, sized from measured row heights (or the mean measured height for rows
 * never rendered). The list is top-anchored like any normal list. Rows that
 * hold user state (focus, open menu, rename, the selection) stay mounted at
 * their real position even when scrolled away, so DOM and Tab order follow
 * the list and `scrollIntoView` on such a row lands where it belongs.
 *
 * The scrolling element is either the list itself (`scrollRef` only) or an
 * ancestor (`listRef` plus `scrollParent`), in which case the list may sit
 * anywhere inside it, below other content. Without any scroll parent the
 * window follows the document viewport.
 */

/** Lists shorter than this render every row (no windowing). */
export const defaultListWindowThreshold = 60
/** Height assumed for rows before any row has been measured. */
export const defaultEstimatedRowHeight = 40
/** Upper bound for rows mounted from the range (kept rows come on top). */
export const defaultMaxRenderedRows = 120
/** Row attribute carrying the row id; spacers carry `data-list-window-spacer`. */
export const defaultListWindowRowAttribute = 'data-list-window-row'
const fallbackViewportHeight = 800

export function listWindowOverscan(viewportHeight: number): number {
  return Math.max(320, Math.round(viewportHeight))
}

export type ListWindowSegment =
  | { kind: 'spacer'; key: string; height: number }
  | { kind: 'row'; index: number }

class RowHeights {
  private readonly sizes = new Map<string, number>()
  private estimateValue: number
  private viewportValue = 0

  constructor(estimate: number) {
    this.estimateValue = estimate
  }

  /** Forgets every measurement (the row layout changed, e.g. a new column count). */
  reset(estimate: number): void {
    this.sizes.clear()
    this.estimateValue = estimate
  }

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
export function listWindowRange(
  offsets: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
  maxCount = defaultMaxRenderedRows,
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

export type ListWindowOptions = {
  /** Row ids in display order. */
  ids: readonly string[]
  /** Changing the scope (project, search, folder) re-windows from the top. */
  scope: string
  /** The list element when it scrolls itself. */
  scrollRef?: React.RefObject<HTMLElement | null>
  /** The element containing the rows when an ancestor scrolls. */
  listRef?: React.RefObject<HTMLElement | null>
  /** Finds the scrolling ancestor of `listRef`; null follows the document viewport. */
  scrollParent?: (list: HTMLElement) => HTMLElement | null
  /** Ids that must stay mounted (selected, menu open, renaming...). */
  keepIds: readonly (string | undefined)[]
  enabled: boolean
  rowAttribute?: string
  threshold?: number
  estimatedRowHeight?: number
  maxRenderedRows?: number
  /** Scroll back to the top on a scope change (sidebar search results). */
  resetScrollOnScopeChange?: boolean
  /** Changing it drops measured heights (rows were re-laid out). */
  layoutKey?: string
  /**
   * False while the list is hidden (`hidden`, a collapsed view): its geometry
   * is meaningless then. Turning it back on re-windows at the current position.
   */
  active?: boolean
}

type Geometry = {
  list: HTMLElement
  /** Scrolling element; undefined follows the document viewport. */
  container: HTMLElement | undefined
}

export function useListWindow({
  ids,
  scope,
  scrollRef,
  listRef,
  scrollParent,
  keepIds,
  enabled,
  rowAttribute = defaultListWindowRowAttribute,
  threshold = defaultListWindowThreshold,
  estimatedRowHeight = defaultEstimatedRowHeight,
  maxRenderedRows = defaultMaxRenderedRows,
  resetScrollOnScopeChange = false,
  active = true,
  layoutKey = '',
}: ListWindowOptions) {
  const windowed = enabled && ids.length >= threshold
  const [heights] = useState(() => new RowHeights(estimatedRowHeight))
  const [measureVersion, setMeasureVersion] = useState(0)
  const [seenLayoutKey, setSeenLayoutKey] = useState(layoutKey)
  if (seenLayoutKey !== layoutKey) {
    setSeenLayoutKey(layoutKey)
    heights.reset(estimatedRowHeight)
  }
  // List-relative scroll position at the last re-window; the range is derived from it.
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
  const scrollParentRef = useRef(scrollParent)
  useLayoutEffect(() => {
    scrollParentRef.current = scrollParent
  })

  const keep = new Set([...keepIds, focusedId].filter((id): id is string => Boolean(id)))
  // Kept rows change the mounted set (and spacers), so the layout effect reruns.
  const keepKey = [...keep].join('\n')
  let segments: ListWindowSegment[]
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
    const range = listWindowRange(offsets, anchorTop, viewport, listWindowOverscan(viewport), maxRenderedRows)
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

  const geometry = useCallback((): Geometry | undefined => {
    const list = listRef?.current ?? scrollRef?.current
    if (!list) return undefined
    const container = scrollRef?.current ?? scrollParentRef.current?.(list) ?? undefined
    return { list, container }
  }, [listRef, scrollRef])

  const rowSelector = `[${rowAttribute}]`

  /** Viewport top in client coordinates. */
  const viewportTop = (container: HTMLElement | undefined): number =>
    container ? container.getBoundingClientRect().top : 0

  /** Scroll position relative to the list top, and the viewport height. */
  const position = useCallback(({ list, container }: Geometry): { top: number; viewport: number } => {
    if (container === list) return { top: list.scrollTop, viewport: list.clientHeight }
    const top = viewportTop(container) - list.getBoundingClientRect().top
    return { top, viewport: container ? container.clientHeight : window.innerHeight }
  }, [])

  /** First mounted row reaching into the viewport, relative to the viewport top. */
  const captureScrollAnchor = useCallback((): void => {
    const current = geometry()
    if (!current || position(current).top <= 0) {
      scrollAnchorRef.current = undefined
      return
    }
    const top = viewportTop(current.container)
    for (const element of current.list.querySelectorAll<HTMLElement>(rowSelector)) {
      const rect = element.getBoundingClientRect()
      if (rect.bottom > top) {
        scrollAnchorRef.current = { id: element.getAttribute(rowAttribute) ?? '', top: rect.top - top }
        return
      }
    }
    scrollAnchorRef.current = undefined
  }, [geometry, position, rowAttribute, rowSelector])

  const activeRef = useRef(active)
  useLayoutEffect(() => {
    activeRef.current = active
  })

  /** Re-windows when the viewport (plus a margin) left the mounted rows. */
  const follow = useCallback((): void => {
    const current = geometry()
    const layoutNow = layoutRef.current
    if (!current || !layoutNow || !activeRef.current || isHidden(current.list)) return
    const { top, viewport } = position(current)
    if (heights.setViewport(viewport)) setMeasureVersion((version) => version + 1)
    // Hysteresis: re-window only when the viewport (plus a margin) leaves the
    // mounted rows, so a steady scroll remounts rows every screen or so.
    if (!coversViewport(layoutNow, top)) setAnchorTop(top)
  }, [geometry, heights, position])

  // Row and viewport measurement.
  useLayoutEffect(() => {
    const current = geometry()
    if (!windowed || !current) return
    const { container, list } = current
    const onWindowResize = (): void => follow()
    if (!container) window.addEventListener('resize', onWindowResize)
    if (typeof ResizeObserver !== 'function') {
      return () => window.removeEventListener('resize', onWindowResize)
    }
    // The observer reports every observed element once on `observe`, which
    // delivers the first viewport height without a synchronous re-render here.
    const observer = new ResizeObserver((entries) => {
      let changed = false
      for (const entry of entries) {
        const target = entry.target as HTMLElement
        if (target === (container ?? list)) {
          if (heights.setViewport(container ? container.clientHeight : window.innerHeight)) changed = true
          if (target !== list) continue
        }
        const id = target.getAttribute?.(rowAttribute)
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
    observer.observe(container ?? list)
    for (const element of rowElements.current.values()) observer.observe(element)
    observerRef.current = observer
    return () => {
      window.removeEventListener('resize', onWindowResize)
      observer.disconnect()
      observerRef.current = undefined
    }
  }, [captureScrollAnchor, follow, geometry, heights, rowAttribute, windowed])

  // An ancestor (or the document) scrolls: listen to it here.
  useLayoutEffect(() => {
    const current = geometry()
    if (!windowed || !current || current.container === current.list) return
    const target: HTMLElement | Window = current.container ?? window
    const onScroll = (): void => follow()
    target.addEventListener('scroll', onScroll, { passive: true })
    return () => target.removeEventListener('scroll', onScroll)
  }, [follow, geometry, windowed])

  // After each commit: restore the visible row's position after a re-layout,
  // return to the top on a scope change, and re-window when the scroll
  // position left the mounted rows without a scroll event (content shrank).
  useLayoutEffect(() => {
    const current = geometry()
    if (!current) return
    const { container } = current
    if (scopeRef.current !== scope) {
      scopeRef.current = scope
      scrollAnchorRef.current = undefined
      // New search results start at the top; short lists keep the browser's
      // own clamping, as before windowing.
      if (resetScrollOnScopeChange && windowed && container && container.scrollTop !== 0) container.scrollTop = 0
    }
    const anchor = scrollAnchorRef.current
    scrollAnchorRef.current = undefined
    if (windowed && anchor) {
      const element = rowElements.current.get(anchor.id)
      if (element) {
        const delta = element.getBoundingClientRect().top - viewportTop(container) - anchor.top
        if (Math.abs(delta) >= 0.5) {
          if (container) container.scrollTop += delta
          else window.scrollBy(0, delta)
        }
      }
    }
    const layoutNow = layoutRef.current
    if (!windowed || !layoutNow || !active || isHidden(current.list)) return
    const { top } = position(current)
    if (!coversViewport(layoutNow, top) && Math.abs(top - anchorTop) >= 1) setAnchorTop(top)
  }, [active, anchorTop, geometry, ids, keepKey, measureVersion, position, resetScrollOnScopeChange, scope, windowed])

  /** For lists that scroll themselves: wire to the list's onScroll. */
  const onScroll = useCallback((): void => follow(), [follow])

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

  // The row that last held focus inside the list; a portaled menu opened from
  // it (React focus events bubble through portals) keeps that row mounted.
  const lastFocusedRef = useRef<string | undefined>(undefined)
  const onFocus = useCallback((event: React.FocusEvent<HTMLElement>): void => {
    const target = event.target
    if (target instanceof Node && !event.currentTarget.contains(target)) {
      // Focus inside a portal rendered by a row: keep its row.
      setFocusedId(lastFocusedRef.current)
      return
    }
    const row = target instanceof Element ? target.closest<HTMLElement>(rowSelector) : null
    const id = row?.getAttribute(rowAttribute) ?? undefined
    lastFocusedRef.current = id
    setFocusedId(id)
  }, [rowAttribute, rowSelector])
  const onBlur = useCallback((event: React.FocusEvent<HTMLElement>): void => {
    const next = event.relatedTarget
    // Focus leaving the window (null) keeps the row; moving elsewhere releases
    // it (a portal of this list gets it back from its own focus event).
    if (next instanceof Node && !event.currentTarget.contains(next)) setFocusedId(undefined)
  }, [])

  return { windowed, segments, rowRef, onScroll, onFocus, onBlur }
}

/** A list inside a `hidden` subtree has no geometry; leave its window alone. */
function isHidden(list: HTMLElement): boolean {
  return list.closest('[hidden]') !== null
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
