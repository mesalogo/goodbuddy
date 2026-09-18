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
  const focusable = Array.from(
    container.querySelectorAll<HTMLElement>(focusableSelector)
  ).filter((element) => !element.closest('[hidden], [inert], [aria-hidden="true"]'))
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
  initialFocus: () => HTMLElement | null,
  fallbackFocus?: () => HTMLElement | null
): () => void {
  const restoreFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  const focusTarget = initialFocus()
  const modalRoot = focusTarget?.closest<HTMLElement>('[aria-modal="true"]')
  const isolatedElements: Array<{
    element: HTMLElement
    wasInert: boolean
  }> = []
  const isolate = (element: HTMLElement): void => {
    if (isolatedElements.some((entry) => entry.element === element)) {
      return
    }
    isolatedElements.push({
      element,
      wasInert: element.inert ?? false
    })
    element.inert = true
  }
  if (modalRoot) {
    const appShell = document.querySelector<HTMLElement>('.app-shell')
    if (appShell && !appShell.contains(modalRoot)) {
      isolate(appShell)
    }
    let activeBranch: HTMLElement = modalRoot
    while (activeBranch.parentElement) {
      for (const sibling of activeBranch.parentElement.children) {
        if (sibling !== activeBranch && sibling instanceof HTMLElement) {
          isolate(sibling)
        }
      }
      activeBranch = activeBranch.parentElement
      if (activeBranch === document.body) {
        break
      }
    }
  } else {
    const appShell = document.querySelector<HTMLElement>('.app-shell')
    if (appShell) {
      isolate(appShell)
    }
  }
  focusTarget?.focus()
  return () => {
    for (const { element, wasInert } of isolatedElements) {
      element.inert = wasInert
    }
    const canRestore = restoreFocus?.isConnected &&
      restoreFocus !== document.body &&
      !restoreFocus.closest('[hidden], [inert], [aria-hidden="true"], :disabled')
    const target = canRestore ? restoreFocus : fallbackFocus?.()
    target?.focus()
  }
}
