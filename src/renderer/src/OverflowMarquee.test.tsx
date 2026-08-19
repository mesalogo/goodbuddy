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
