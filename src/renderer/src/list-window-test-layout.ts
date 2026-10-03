import { act } from '@testing-library/react'
import { vi } from 'vitest'

/**
 * A tiny block-flow layout for windowed-list tests (jsdom has none).
 *
 * One scroll container (matched by `isContainer`) sits at viewport top 0 and
 * is `viewport` px tall. Inside it every element stacks its children
 * vertically: rows (elements carrying `rowAttribute`) take `rowHeight(id)`,
 * spacers take their inline height (on themselves or their only cell), and
 * every other element is as tall as its children.
 */
export type FakeListLayout = {
  measure: () => void
  scroll: (container: HTMLElement, top: number) => void
  contentHeight: (container: HTMLElement) => number
  restore: () => void
}

export function installFakeListLayout({
  isContainer,
  rowAttribute,
  viewport = 400,
  rowHeight = () => 40,
}: {
  isContainer: (element: Element) => boolean
  rowAttribute: string
  viewport?: number
  rowHeight?: (id: string) => number
}): FakeListLayout {
  const scrollTops = new WeakMap<Element, number>()

  const ownHeight = (element: HTMLElement): number | undefined => {
    const id = element.getAttribute(rowAttribute)
    if (id) return rowHeight(id)
    const inline = Number.parseFloat(element.style?.height ?? '')
    if (Number.isFinite(inline)) return inline
    return undefined
  }
  const height = (element: HTMLElement): number => {
    if (element.hidden) return 0
    const own = ownHeight(element)
    if (own !== undefined) return own
    let sum = 0
    for (const child of element.children) sum += height(child as HTMLElement)
    return sum
  }
  const containerOf = (element: Element): HTMLElement | null => {
    let current: Element | null = element
    while (current && !isContainer(current)) current = current.parentElement
    return current as HTMLElement | null
  }
  const top = (element: HTMLElement, container: HTMLElement): number => {
    if (element === container) return 0
    const parent = element.parentElement!
    let offset = top(parent, container) - (parent === container ? container.scrollTop : 0)
    for (const sibling of parent.children) {
      if (sibling === element) break
      offset += height(sibling as HTMLElement)
    }
    return offset
  }
  const rect = (y: number, h: number): DOMRect =>
    ({ top: y, bottom: y + h, height: h, left: 0, right: 0, width: 0, x: 0, y, toJSON: () => ({}) }) as DOMRect

  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const container = containerOf(this)
    if (!container) return rect(0, 0)
    if (this === container) return rect(0, viewport)
    return rect(top(this, container), height(this))
  })

  const names = ['clientHeight', 'scrollHeight', 'scrollTop'] as const
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]))
  const contentHeight = (container: HTMLElement): number => {
    let sum = 0
    for (const child of container.children) sum += height(child as HTMLElement)
    return sum
  }
  Object.defineProperties(HTMLElement.prototype, {
    clientHeight: { configurable: true, get(this: HTMLElement) { return isContainer(this) ? viewport : 0 } },
    scrollHeight: { configurable: true, get(this: HTMLElement) { return isContainer(this) ? contentHeight(this) : 0 } },
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) { return scrollTops.get(this) ?? 0 },
      set(this: HTMLElement, value: number) {
        const max = isContainer(this) ? Math.max(0, contentHeight(this) - viewport) : 0
        scrollTops.set(this, Math.min(Math.max(0, value), max))
      },
    },
  })

  class FakeResizeObserver {
    static instances: FakeResizeObserver[] = []
    readonly observed = new Set<Element>()
    constructor(private readonly callback: ResizeObserverCallback) {
      FakeResizeObserver.instances.push(this)
    }
    observe(element: Element): void { this.observed.add(element) }
    unobserve(element: Element): void { this.observed.delete(element) }
    disconnect(): void { this.observed.clear() }
    fire(): void {
      const entries = [...this.observed].map((target) => ({ target }) as ResizeObserverEntry)
      if (entries.length) this.callback(entries, this as unknown as ResizeObserver)
    }
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)

  const measure = (): void => {
    act(() => {
      for (const observer of [...FakeResizeObserver.instances]) observer.fire()
    })
  }
  return {
    measure,
    contentHeight,
    scroll(container, value) {
      act(() => {
        container.scrollTop = value
        container.dispatchEvent(new Event('scroll'))
      })
      measure()
    },
    restore() {
      for (const name of names) {
        const original = originals.get(name)
        if (original) Object.defineProperty(HTMLElement.prototype, name, original)
        else Reflect.deleteProperty(HTMLElement.prototype, name)
      }
    },
  }
}
