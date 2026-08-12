type TabKeyEvent = {
  key: string
  shiftKey: boolean
  preventDefault: () => void
}

const focusableSelector =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

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
    event.preventDefault()
    container.focus()
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

export function activateModalFocus(
  initialFocus: () => HTMLElement | null
): () => void {
  const restoreFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  const appShell = document.querySelector<HTMLElement>('.app-shell')
  const wasInert = appShell?.inert ?? false
  if (appShell) {
    appShell.inert = true
  }
  initialFocus()?.focus()
  return () => {
    if (appShell) {
      appShell.inert = wasInert
    }
    restoreFocus?.focus()
  }
}
