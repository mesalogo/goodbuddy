import { useLayoutEffect, useMemo, useState } from 'react'
import { defaultListWindowThreshold, useListWindow, type ListWindowOptions } from './use-list-window'

/** `gap` is the grid's column gap; windowed rows reuse it as their row spacing. */
export type GridTrackMetrics = { columns: number; gap: number }

/**
 * Resolved column count and row gap of a CSS grid; follows its width.
 * Changing `layoutKey` re-reads them (the grid's class, and so its tracks, changed).
 */
export function useGridColumns(
  gridRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  layoutKey = '',
): GridTrackMetrics {
  const [metrics, setMetrics] = useState<GridTrackMetrics>({ columns: 1, gap: 0 })
  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!enabled || !grid) return
    const update = (): void => {
      // Hidden grids report no tracks; keep the last layout until shown again.
      if (grid.closest('[hidden]')) return
      const next = readGridMetrics(grid)
      setMetrics((current) =>
        current.columns === next.columns && Math.abs(current.gap - next.gap) < 0.5 ? current : next)
    }
    update()
    if (typeof ResizeObserver !== 'function') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const observer = new ResizeObserver(update)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [enabled, gridRef, layoutKey])
  return metrics
}

export function readGridMetrics(grid: HTMLElement): GridTrackMetrics {
  const style = getComputedStyle(grid)
  // Computed `grid-template-columns` lists one resolved length per track.
  const tracks = (style.gridTemplateColumns ?? '').trim().split(/\s+/).filter((track) => /^[\d.]+px$/.test(track))
  const gap = Number.parseFloat(style.columnGap)
  return { columns: Math.max(1, tracks.length), gap: Number.isFinite(gap) ? gap : 0 }
}

export type GridWindowSegment =
  | { kind: 'spacer'; key: string; height: number }
  | { kind: 'row'; key: string; start: number; end: number }

/**
 * Windowing for a CSS grid of cards that scrolls itself: items are grouped in
 * rows of the grid's current column count and the rows are windowed. Kept
 * items (selection, open menu, focus) keep their whole row mounted.
 *
 * While windowed, each row should be a full-width subgrid item
 * (`grid-column: 1 / -1; grid-template-columns: subgrid`) and spacers full-width
 * blocks of the given height; the grid's own `row-gap` must then be 0, with
 * the returned `gap` carried inside each row as bottom padding, so the
 * measured row height includes it.
 */
export function useGridListWindow({
  itemIds,
  gridRef,
  keepIds,
  layoutKey,
  ...options
}: Omit<ListWindowOptions, 'ids' | 'scrollRef' | 'listRef' | 'keepIds' | 'layoutKey'> & {
  itemIds: readonly string[]
  gridRef: React.RefObject<HTMLElement | null>
  keepIds: readonly (string | undefined)[]
  /** Card layout (view mode); rows are re-measured when it or the column count changes. */
  layoutKey: string
}) {
  // The threshold counts items, not grid rows.
  const enabled = options.enabled && itemIds.length >= (options.threshold ?? defaultListWindowThreshold)
  const { columns, gap } = useGridColumns(gridRef, enabled, layoutKey)
  const itemKey = itemIds.join('\n')
  const rowIds = useMemo(() => {
    const items = itemKey ? itemKey.split('\n') : []
    const rows: string[] = []
    for (let index = 0; index < items.length; index += columns) rows.push(`row:${items[index]}`)
    return rows
  }, [columns, itemKey])
  const rowIndexById = useMemo(() => {
    const map = new Map<string, number>()
    itemIds.forEach((id, index) => map.set(id, Math.floor(index / columns)))
    return map
  }, [columns, itemIds])
  const keepRows = keepIds.map((id) => {
    const row = id ? rowIndexById.get(id) : undefined
    return row === undefined ? undefined : rowIds[row]
  })
  const listWindow = useListWindow({
    ...options,
    enabled,
    threshold: 1,
    ids: rowIds,
    scrollRef: gridRef,
    keepIds: keepRows,
    layoutKey: `${layoutKey}:${columns}`,
  })
  const segments: GridWindowSegment[] = listWindow.segments.map((segment) =>
    segment.kind === 'spacer'
      ? segment
      : {
          kind: 'row',
          key: rowIds[segment.index]!,
          start: segment.index * columns,
          end: Math.min(itemIds.length, (segment.index + 1) * columns),
        })
  return { ...listWindow, segments, columns, gap }
}
