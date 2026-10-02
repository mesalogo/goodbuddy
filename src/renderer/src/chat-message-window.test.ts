import { describe, expect, it } from 'vitest'
import {
  MessageRowHeights,
  buildSegments,
  estimatedMessageRowHeight,
  maxRenderedMessageCount,
  rangeAround,
  rangeCovers,
  rowAtOffset,
  rowAtViewportTop,
  rowHeightsFor,
  tailRange
} from './chat-message-window'

const ids = Array.from({ length: 2_000 }, (_, index) => ({ id: `m${index}` }))

describe('MessageRowHeights', () => {
  it('estimates unmeasured rows from first measurements only', () => {
    const heights = new MessageRowHeights()
    expect(heights.size('m0')).toBe(estimatedMessageRowHeight)
    expect(heights.set('m0', 100)).toBe('new')
    expect(heights.set('m1', 300)).toBe('new')
    expect(heights.estimate()).toBe(200)
    // A streaming row growing does not move the estimate (and the spacers).
    expect(heights.set('m1', 900)).toBe('changed')
    expect(heights.estimate()).toBe(200)
    expect(heights.set('m1', 900.2)).toBeUndefined()
    expect(heights.sum(ids, 0, 4)).toBe(100 + 900 + 200 + 200)
  })

  it('tracks the viewport with a fallback', () => {
    const heights = new MessageRowHeights()
    expect(heights.viewport).toBeGreaterThan(0)
    expect(heights.setViewport(600)).toBe(true)
    expect(heights.setViewport(600.4)).toBe(false)
    expect(heights.viewport).toBe(600)
  })

  it('keeps heights per conversation across lookups', () => {
    const first = rowHeightsFor('window-test-conversation')
    first.set('x', 42)
    expect(rowHeightsFor('window-test-conversation').size('x')).toBe(42)
  })
})

describe('window ranges', () => {
  const sizeAt = (): number => 100

  it('fills the viewport plus overscan from the bottom', () => {
    expect(tailRange({ sizeAt, windowStart: 0, count: 2_000, viewportHeight: 600, overscan: 400 }))
      .toEqual({ start: 1_990, end: 2_000 })
    expect(tailRange({ sizeAt, windowStart: 1_995, count: 2_000, viewportHeight: 600, overscan: 400 }))
      .toEqual({ start: 1_995, end: 2_000 })
  })

  it('bounds the range for tiny rows', () => {
    const range = tailRange({ sizeAt: () => 1, windowStart: 0, count: 2_000, viewportHeight: 600, overscan: 400 })
    expect(range.end - range.start).toBe(maxRenderedMessageCount)
  })

  it('covers the viewport around an anchor row', () => {
    const range = rangeAround({
      sizeAt, windowStart: 0, count: 2_000, viewportHeight: 600, overscan: 300,
      anchorIndex: 1_000, anchorOffset: -40
    })
    expect(range.start).toBeLessThanOrEqual(997)
    expect(range.end).toBeGreaterThanOrEqual(1_009)
    expect(range.end - range.start).toBeLessThanOrEqual(maxRenderedMessageCount)
    expect(rangeCovers({ start: 0, end: 2_000 }, range)).toBe(true)
    expect(rangeCovers({ start: 999, end: 2_000 }, range)).toBe(false)
  })

  it('finds the row at an offset', () => {
    expect(rowAtOffset(sizeAt, 10, 2_000, 250)).toEqual({ index: 12, top: 200 })
    expect(rowAtOffset(sizeAt, 10, 20, 99_999)).toEqual({ index: 19, top: 900 })
  })

  it('finds the row at the viewport top from a known row position', () => {
    // Anchor row 50 sits 250 px below the viewport top: rows 48..49 lie above it.
    expect(rowAtViewportTop(sizeAt, 0, 2_000, 50, 250)).toEqual({ index: 47, top: -50 })
    // Anchor scrolled 1,030 px above the viewport top.
    expect(rowAtViewportTop(sizeAt, 0, 2_000, 50, -1_030)).toEqual({ index: 60, top: -30 })
    // Clamped to the loaded window.
    expect(rowAtViewportTop(sizeAt, 40, 2_000, 50, 5_000)).toEqual({ index: 40, top: 4_000 })
    expect(rowAtViewportTop(sizeAt, 0, 55, 50, -99_999)).toEqual({ index: 54, top: -99_999 + 400 })
  })
})

describe('buildSegments', () => {
  it('replaces unrendered rows with sized spacers', () => {
    const heights = new MessageRowHeights()
    heights.set('m5', 50)
    const segments = buildSegments(heights, ids.slice(0, 10), 2, 10, [4, 5, 8])
    expect(segments).toEqual([
      { kind: 'spacer', key: 'top', height: 2 * 50, top: true, start: 2 },
      { kind: 'row', index: 4 },
      { kind: 'row', index: 5 },
      { kind: 'spacer', key: 'gap:m6', height: 2 * 50, top: false, start: 6 },
      { kind: 'row', index: 8 },
      { kind: 'spacer', key: 'bottom', height: 50, top: false, start: 9 }
    ])
  })
})
