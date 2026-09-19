import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { trapTabFocus } from './dialog-focus'
import './floating-portal.css'

// Top-layer painting does not escape modal inertness: the host must also belong
// to the active dialog. Keep the host stable so moving it preserves toast timers.
export function FloatingPortal({ children, anchorRef }: {
  children: ReactNode
  anchorRef?: RefObject<HTMLElement | null>
}): React.JSX.Element {
  const [host] = useState(() => {
    const element = document.createElement('div')
    element.className = 'floating-portal'
    element.popover = 'manual'
    return element
  })
  useLayoutEffect(() => {
    let focused: HTMLElement | null = null
    let returnFocus: HTMLElement | null = null
    const sync = (): void => {
      const modals = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"], dialog:modal'))
      const owner = anchorRef?.current?.closest<HTMLElement>('[aria-modal="true"], dialog:modal') ??
        (anchorRef ? null : modals.reverse().find(element =>
          !element.closest('[inert], [hidden], [aria-hidden="true"]') && getComputedStyle(element).display !== 'none'))
      const target = owner ?? document.body
      const active = host.contains(document.activeElement) ? document.activeElement as HTMLElement : null
      if (host.parentElement !== target) {
        target.append(host)
        host.removeAttribute('inert')
      }
      if (!host.matches(':popover-open')) host.showPopover()
      if (active) active.focus({ preventScroll: true })
      if (focused && !focused.isConnected && document.activeElement === document.body) {
        restoreFocus()
      }
    }
    const restoreFocus = (): void => {
      const modal = host.closest<HTMLElement>('[aria-modal="true"], dialog:modal')
      const target = returnFocus?.isConnected && !returnFocus.closest('[inert], [hidden], :disabled') &&
        (!modal || modal.contains(returnFocus)) ? returnFocus : modal?.querySelector<HTMLElement>('button:not(:disabled), [tabindex="0"]')
      target?.focus({ preventScroll: true })
      focused = null
    }
    const onFocus = (event: FocusEvent): void => {
      focused = event.target instanceof HTMLElement ? event.target : null
      if (event.relatedTarget instanceof HTMLElement && !host.contains(event.relatedTarget)) {
        returnFocus = event.relatedTarget
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || anchorRef) return
      const modal = host.closest<HTMLElement>('[aria-modal="true"], dialog:modal')
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        restoreFocus()
      } else {
        trapTabFocus(event, modal)
      }
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['inert', 'hidden', 'aria-hidden', 'aria-modal', 'open'] })
    host.addEventListener('focusin', onFocus)
    host.addEventListener('keydown', onKeyDown)
    return () => {
      observer.disconnect()
      host.removeEventListener('focusin', onFocus)
      host.removeEventListener('keydown', onKeyDown)
      if (host.contains(document.activeElement)) restoreFocus()
      host.remove()
    }
  }, [anchorRef, host])
  return createPortal(children, host)
}
