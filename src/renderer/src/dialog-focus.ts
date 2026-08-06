type TabKeyEvent = {
  key: string
  shiftKey: boolean
  preventDefault: () => void
}

const focusableSelector =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])'

export function trapTabFocus(
  event: TabKeyEvent,
  container: HTMLElement | null
): void {
  if (event.key !== 'Tab' || !container) {
    return
  }
  const focusable =
    container.querySelectorAll<HTMLElement>(focusableSelector)
  if (focusable.length === 0) {
    return
  }
  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!
  if (!container.contains(document.activeElement)) {
    event.preventDefault()
    first.focus()
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}
