import { useRef } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { installFakeListLayout } from './list-window-test-layout'
import { useListWindow } from './use-list-window'

const ids = Array.from({ length: 600 }, (_, index) => `row-${index}`)
function List() {
  const ref = useRef<HTMLDivElement>(null)
  const list = useListWindow({ ids, scope: 'test', scrollRef: ref, enabled: true, keepIds: ['row-599'], estimatedRowHeight: 44 })
  return <div ref={ref} data-scroll-list onScroll={list.onScroll} onFocus={list.onFocus} onBlur={list.onBlur}>
    {list.segments.map(segment => segment.kind === 'spacer'
      ? <div key={segment.key} data-list-window-spacer style={{ height: segment.height }} />
      : <div key={ids[segment.index]} data-list-window-row={ids[segment.index]} ref={list.rowRef(ids[segment.index]!)}><button>{ids[segment.index]}</button></div>)}
  </div>
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('keeps visibly focused rows in view when rewindowing replaces measured DOM with estimated spacers', () => {
  const layout = installFakeListLayout({ isContainer: element => element.hasAttribute('data-scroll-list'),
    rowAttribute: 'data-list-window-row', rowHeight: () => 38, viewport: 528 })
  try {
    const view = render(<List />)
    const panel = view.container.querySelector<HTMLElement>('[data-scroll-list]')!
    const row = panel.querySelector<HTMLElement>('[data-list-window-row="row-599"]')!
    const button = row.querySelector('button')!
    act(() => { button.focus(); panel.scrollTop = panel.scrollHeight; fireEvent.scroll(panel) })
    expect(button).toHaveFocus()
    expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(528)
    layout.measure()
    expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(528)
    // Explicit scrolling away keeps focus mounted, but must not pull the viewport back.
    layout.scroll(panel, 0)
    expect(button).toHaveFocus()
    expect(panel.scrollTop).toBe(0)
    expect(row.getBoundingClientRect().top).toBeGreaterThan(528)
  } finally { layout.restore() }
})
