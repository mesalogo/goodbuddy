/**
 * Windowing model for the chat message timeline (PERF-14).
 *
 * The timeline only mounts the rows near the viewport. Rows above and below
 * the rendered range are replaced by spacers whose heights come from measured
 * row heights, or from the mean measured height for rows never rendered yet.
 * The pane keeps the reader's place by anchoring a visible row (see
 * ChatHistoryPane), so estimate errors never move what the reader sees.
 */

export type MessageWindowRange = { start: number; end: number };

/** Used for rows that were never measured while nothing has been measured. */
export const estimatedMessageRowHeight = 160;
/** Upper bound for mounted rows from the range (extras such as the focused row come on top). */
export const maxRenderedMessageCount = 60;
/** Viewport height assumed before the scroll container has been measured. */
export const fallbackViewportHeight = 800;

export function overscanFor(viewportHeight: number): number {
  return Math.max(320, Math.round(viewportHeight * 0.75));
}

export class MessageRowHeights {
  private readonly sizes = new Map<string, number>();
  private estimateValue = estimatedMessageRowHeight;
  private viewportValue = 0;

  /** Last measured viewport height, or the fallback before any measurement. */
  get viewport(): number {
    return this.viewportValue > 0 ? this.viewportValue : fallbackViewportHeight;
  }

  /** Records the viewport height; returns whether it changed noticeably. */
  setViewport(height: number): boolean {
    if (height <= 0 || Math.abs(height - this.viewportValue) < 1) return false;
    this.viewportValue = height;
    return true;
  }

  get measuredCount(): number {
    return this.sizes.size;
  }

  /**
   * Height assumed for rows never measured: the mean of the heights recorded
   * when rows were first measured. Re-measuring a row (a streaming reply
   * growing) does not move it, so spacers only change when new rows are seen.
   */
  estimate(): number {
    return this.estimateValue;
  }

  size(id: string): number {
    return this.sizes.get(id) ?? this.estimateValue;
  }

  has(id: string): boolean {
    return this.sizes.has(id);
  }

  /**
   * Records a measured height. Returns 'new' for a row measured for the first
   * time, 'changed' for a re-measured row, undefined when nothing changed.
   */
  set(id: string, height: number): 'new' | 'changed' | undefined {
    const previous = this.sizes.get(id);
    if (previous !== undefined) {
      if (Math.abs(previous - height) < 0.5) return undefined;
      this.sizes.set(id, height);
      return 'changed';
    }
    const count = this.sizes.size;
    this.estimateValue =
      count === 0 ? height : (this.estimateValue * count + height) / (count + 1);
    this.sizes.set(id, height);
    return 'new';
  }

  /** Total height of rows [from, to). */
  sum(ids: readonly { id: string }[], from: number, to: number): number {
    const estimate = this.estimateValue;
    let total = 0;
    for (let index = from; index < to; index += 1) {
      const id = ids[index]?.id;
      total += (id === undefined ? undefined : this.sizes.get(id)) ?? estimate;
    }
    return total;
  }
}

type WindowInput = {
  /** Height of row `index`. */
  sizeAt: (index: number) => number;
  /** First loaded row. */
  windowStart: number;
  /** Number of rows (exclusive end of the loaded window). */
  count: number;
  viewportHeight: number;
  overscan: number;
  maxCount?: number;
};

/** Rows that fill the viewport from the bottom of the loaded window. */
export function tailRange({
  sizeAt,
  windowStart,
  count,
  viewportHeight,
  overscan,
  maxCount = maxRenderedMessageCount,
}: WindowInput): MessageWindowRange {
  let start = count;
  let covered = 0;
  while (start > windowStart && covered < viewportHeight + overscan) {
    start -= 1;
    covered += sizeAt(start);
  }
  return { start: Math.max(start, count - maxCount, windowStart), end: count };
}

/**
 * Rows that cover the viewport around an anchor row whose top is
 * `anchorOffset` pixels below the viewport top (negative when it starts above).
 */
export function rangeAround({
  sizeAt,
  windowStart,
  count,
  viewportHeight,
  overscan,
  anchorIndex,
  anchorOffset,
  maxCount = maxRenderedMessageCount,
}: WindowInput & { anchorIndex: number; anchorOffset: number }): MessageWindowRange {
  const anchor = Math.min(Math.max(anchorIndex, windowStart), Math.max(windowStart, count - 1));
  let start = anchor;
  let top = anchorOffset;
  while (start > windowStart && top > -overscan) {
    start -= 1;
    top -= sizeAt(start);
  }
  let end = anchor;
  let bottom = anchorOffset;
  while (end < count && (end === anchor || bottom < viewportHeight + overscan)) {
    bottom += sizeAt(end);
    end += 1;
  }
  while (end - start > maxCount) {
    if (anchor - start > end - anchor - 1) start += 1;
    else if (end > anchor + 1) end -= 1;
    else break;
  }
  return { start, end };
}

/** Row at content offset `y` from the top of the loaded window. */
export function rowAtOffset(
  sizeAt: (index: number) => number,
  windowStart: number,
  count: number,
  y: number,
): { index: number; top: number } {
  let top = 0;
  for (let index = windowStart; index < count; index += 1) {
    const size = sizeAt(index);
    if (top + size > y || index === count - 1) return { index, top };
    top += size;
  }
  return { index: windowStart, top: 0 };
}

/**
 * Row at the viewport top, found by walking from a known row whose top is
 * `anchorTop` pixels below the viewport top (negative when above). Returns
 * that row and its top relative to the viewport top (<= 0 unless the window
 * starts below the viewport top). Lets the scroll handler locate the viewport
 * from cached heights instead of reading layout.
 */
export function rowAtViewportTop(
  sizeAt: (index: number) => number,
  windowStart: number,
  count: number,
  anchorIndex: number,
  anchorTop: number,
): { index: number; top: number } {
  if (count <= windowStart) return { index: windowStart, top: anchorTop };
  let index = Math.min(Math.max(anchorIndex, windowStart), count - 1);
  let top = anchorTop;
  while (top > 0 && index > windowStart) {
    index -= 1;
    top -= sizeAt(index);
  }
  while (index < count - 1 && top + sizeAt(index) <= 0) {
    top += sizeAt(index);
    index += 1;
  }
  return { index, top };
}

export function rangeCovers(
  outer: MessageWindowRange,
  inner: MessageWindowRange,
): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}

export type MessageWindowSegment =
  | { kind: 'spacer'; key: string; height: number; top: boolean; start: number }
  | { kind: 'row'; index: number };

/**
 * Row heights per conversation, kept across pane remounts (keep-alive
 * eviction) so a reopened conversation lays out with real heights. Bounded LRU.
 */
const rowHeightCache = new Map<string, MessageRowHeights>();
const rowHeightCacheLimit = 24;

export function rowHeightsFor(conversationId: string): MessageRowHeights {
  let heights = rowHeightCache.get(conversationId);
  if (heights) {
    rowHeightCache.delete(conversationId);
  } else {
    heights = new MessageRowHeights();
  }
  rowHeightCache.set(conversationId, heights);
  while (rowHeightCache.size > rowHeightCacheLimit) {
    const oldest = rowHeightCache.keys().next().value;
    if (oldest === undefined) break;
    rowHeightCache.delete(oldest);
  }
  return heights;
}

export function clearRowHeightCache(): void {
  rowHeightCache.clear();
}

/**
 * Lays out the loaded window [windowStart, count) as rendered rows and
 * spacers. `rendered` must be sorted and unique.
 */
export function buildSegments(
  heights: MessageRowHeights,
  ids: readonly { id: string }[],
  windowStart: number,
  count: number,
  rendered: readonly number[],
): MessageWindowSegment[] {
  // The top spacer is always present (possibly 0 px) so the element keeps
  // its identity while the window moves.
  const segments: MessageWindowSegment[] = [
    { kind: 'spacer', key: 'top', height: 0, top: true, start: windowStart },
  ];
  let previous = windowStart;
  for (const index of rendered) {
    if (index < previous || index >= count) continue;
    if (index > previous) {
      const height = heights.sum(ids, previous, index);
      if (previous === windowStart) {
        segments[0] = { kind: 'spacer', key: 'top', height, top: true, start: windowStart };
      } else {
        segments.push({
          kind: 'spacer',
          key: `gap:${ids[previous]?.id ?? previous}`,
          height,
          top: false,
          start: previous,
        });
      }
    }
    segments.push({ kind: 'row', index });
    previous = index + 1;
  }
  if (previous < count) {
    segments.push({
      kind: 'spacer',
      key: 'bottom',
      height: heights.sum(ids, previous, count),
      top: false,
      start: previous,
    });
  }
  return segments;
}
