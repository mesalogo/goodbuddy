import { useLayoutEffect, type RefObject } from 'react'

/**
 * Sets `--fill-height` on the element: the visible height of its scroll container from the element's
 * top down, minus `bottomGap`, never below `minimum`. Lets a panel fill the window with a steady bottom
 * margin while its columns scroll inside, instead of growing the page with their content.
 * Measured with the container scrolled to the top, so scrolling does not change the value.
 */
export function useFillHeight(ref: RefObject<HTMLElement | null>, enabled: boolean, bottomGap = 24, minimum = 420): void {
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || !enabled) return
    let container: HTMLElement | null = element.parentElement
    while (container && !/(auto|scroll)/.test(getComputedStyle(container).overflowY)) container = container.parentElement
    const scroller = container ?? document.documentElement
    const measure = () => {
      const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      const padding = parseFloat(getComputedStyle(scroller).paddingBottom) || 0
      // The layout's own border sits outside the row; subtract it so the outer box ends exactly at the gap.
      const style = getComputedStyle(element)
      const borders = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0)
      const height = Math.max(minimum, Math.floor(scroller.clientHeight - top - Math.max(bottomGap, padding) - borders))
      element.style.setProperty('--fill-height', `${height}px`)
    }
    measure()
    // Content above the element (notices, toolbars, headers) moves its top. Elements that appear or disappear
    // there do not resize anything we observe, so layout changes are re-measured once per frame instead.
    let frame: number | undefined
    const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; measure() }) }
    const observer = new ResizeObserver(schedule)
    observer.observe(scroller)
    const observeSiblings = () => {
      // Parents are not observed, since the element's own height changes theirs.
      for (let node: HTMLElement | null = element; node && node !== scroller; node = node.parentElement) {
        for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) observer.observe(sibling)
      }
    }
    observeSiblings()
    const mutations = new MutationObserver(() => { observeSiblings(); schedule() })
    mutations.observe(scroller, { childList: true, subtree: true })
    window.addEventListener('resize', schedule)
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      observer.disconnect(); mutations.disconnect(); window.removeEventListener('resize', schedule); element.style.removeProperty('--fill-height')
    }
  }, [ref, enabled, bottomGap, minimum])
}
