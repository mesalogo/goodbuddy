import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OverflowMarquee } from './OverflowMarquee'

const stylesheet = readFileSync(
  join(process.cwd(), 'src', 'renderer', 'src', 'styles.css'),
  'utf8'
).replaceAll('\r\n', '\n')

function setMeasuredWidth(
  element: HTMLElement,
  property: 'clientWidth' | 'scrollWidth',
  value: number
): void {
  Object.defineProperty(element, property, {
    configurable: true,
    value
  })
}

describe('OverflowMarquee', () => {
  afterEach(() => cleanup())

  it('enables sliding only when the text exceeds its container', () => {
    const text = '这是一个明显超过会话列表宽度的完整会话名称'
    render(<OverflowMarquee text={text} />)

    const container = screen.getByTitle(text)
    const track = container.querySelector<HTMLElement>(
      '.overflow-marquee__track'
    )
    expect(track).not.toBeNull()
    setMeasuredWidth(container, 'clientWidth', 120)
    setMeasuredWidth(track!, 'scrollWidth', 280)

    fireEvent.mouseEnter(container)

    expect(container).toHaveAttribute('data-overflowing', 'true')
    expect(
      container.style.getPropertyValue('--overflow-marquee-distance')
    ).toBe('160px')
    expect(
      container.style.getPropertyValue('--overflow-marquee-duration')
    ).toBe('2500ms')

    setMeasuredWidth(track!, 'scrollWidth', 100)
    fireEvent.mouseEnter(container)

    expect(container).not.toHaveAttribute('data-overflowing')
    expect(
      container.style.getPropertyValue('--overflow-marquee-distance')
    ).toBe('')
  })

  it('measures from the resize observer instead of forcing layout on mount', () => {
    let callback: ResizeObserverCallback | undefined
    class FakeResizeObserver {
      constructor(next: ResizeObserverCallback) { callback = next }
      observe(): void {}
      disconnect(): void {}
    }
    const original = globalThis.ResizeObserver
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
    try {
      const text = '这是一个明显超过会话列表宽度的完整会话名称'
      let reads = 0
      const scrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => { reads += 1; return 280 } })
      try {
        render(<OverflowMarquee text={text} />)
        const container = screen.getByTitle(text)
        setMeasuredWidth(container, 'clientWidth', 120)
        expect(reads).toBe(0)
        callback?.([], {} as ResizeObserver)
        expect(reads).toBe(1)
        expect(container).toHaveAttribute('data-overflowing', 'true')
      } finally {
        if (scrollWidth) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scrollWidth)
        else Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth')
      }
    } finally {
      globalThis.ResizeObserver = original
    }
  })

  it('keeps one readable text copy while its visual track moves', () => {
    render(<OverflowMarquee text="完整会话名称" />)

    const container = screen.getByTitle('完整会话名称')
    expect(container).toHaveTextContent('完整会话名称')
    expect(
      container.querySelector('.overflow-marquee__track')
    ).toHaveTextContent('完整会话名称')
    expect(container.querySelector('.sr-only')).not.toBeInTheDocument()
  })

  it('slides on row hover and removes displacement for reduced motion', () => {
    const rowHoverIndex = stylesheet.indexOf('.conversation-row:hover')
    const hoverTransformIndex = stylesheet.indexOf(
      'calc(-1 * var(--overflow-marquee-distance))',
      rowHoverIndex
    )
    expect(rowHoverIndex).toBeGreaterThan(-1)
    expect(hoverTransformIndex).toBeGreaterThan(rowHoverIndex)

    const reducedMotionIndex = stylesheet.indexOf(
      '@media (prefers-reduced-motion: reduce)'
    )
    const reducedMotionHoverIndex = stylesheet.indexOf(
      '.conversation-row:hover',
      reducedMotionIndex
    )
    const reducedMotionResetIndex = stylesheet.indexOf(
      'transform: none;',
      reducedMotionHoverIndex
    )
    expect(reducedMotionHoverIndex).toBeGreaterThan(reducedMotionIndex)
    expect(reducedMotionResetIndex).toBeGreaterThan(
      reducedMotionHoverIndex
    )
  })
})
