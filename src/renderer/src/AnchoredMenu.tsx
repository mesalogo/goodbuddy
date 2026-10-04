import { useEffect, useEffectEvent, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { FloatingPortal } from './FloatingPortal'
import './anchored-menu.css'

export function AnchoredMenu({ anchorRef, id, label, width: preferredWidth = 280, role = 'menu', className = '', onClose, children }: {
  anchorRef: RefObject<HTMLButtonElement | null>
  id: string
  label: string
  width?: number | 'anchor'
  role?: 'menu' | 'group'
  className?: string
  onClose: () => void
  children: ReactNode
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const dismiss = useEffectEvent(onClose)
  const position = useEffectEvent(() => {
    const menu = menuRef.current
    const anchor = anchorRef.current
    if (!menu || !anchor) return
    const viewport = window.visualViewport
    const left = viewport?.offsetLeft ?? 0
    const top = viewport?.offsetTop ?? 0
    const width = viewport?.width ?? window.innerWidth
    const height = viewport?.height ?? window.innerHeight
    const rect = anchor.getBoundingClientRect()
    const menuWidth = Math.max(0, Math.min(preferredWidth === 'anchor' ? rect.width : preferredWidth, width - 32))
    menu.style.width = `${menuWidth}px`
    const above = Math.max(0, Math.min(height - 32, rect.top - top - 24))
    const below = Math.max(0, Math.min(height - 32, top + height - rect.bottom - 24))
    const openBelow = menu.scrollHeight > above && below > above
    const availableHeight = openBelow ? below : above
    menu.style.maxHeight = `${role === 'group' ? Math.min(availableHeight, 400, height / 2) : availableHeight}px`
    menu.style.left = `${Math.max(left + 16, Math.min(rect.left, left + width - menuWidth - 16))}px`
    menu.style.top = `${Math.max(top + 16, openBelow ? rect.bottom + 8 : Math.min(rect.top - 8, top + height - 16) - menu.getBoundingClientRect().height)}px`
  })
  useLayoutEffect(() => { position() })
  useEffect(() => {
    const menu = menuRef.current!
    const anchor = anchorRef.current
    const focusFirst = (): void => {
      if (document.activeElement === document.body || document.activeElement === menu) {
        (menu.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not(:disabled), [role="menuitem"][aria-current="true"]:not(:disabled)')
          ?? menu.querySelector<HTMLElement>(':is([role="menuitem"], [role="menuitemradio"]):not(:disabled)') ?? menu).focus()
      }
    }
    menu.focus()
    focusFirst()
    const outside = (event: Event): void => {
      if (!menu.contains(event.target as Node) && !anchor?.contains(event.target as Node)) dismiss()
    }
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        flushSync(() => dismiss())
        anchor?.focus()
        return
      }
      if (!menu.contains(event.target as Node)) return
      if (event.key === 'Tab') {
        flushSync(() => dismiss())
        anchor?.focus()
        return
      }
      if (role !== 'menu' || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const items = Array.from(menu.querySelectorAll<HTMLElement>(':is([role="menuitem"], [role="menuitemradio"]):not(:disabled)'))
      const index = items.indexOf(document.activeElement as HTMLElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next]?.focus()
    }
    const reposition = (): void => { position(); focusFirst() }
    const observer = new ResizeObserver(reposition)
    observer.observe(menu)
    if (anchor) observer.observe(anchor)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('keydown', keydown, true)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    window.visualViewport?.addEventListener('resize', reposition)
    window.visualViewport?.addEventListener('scroll', reposition)
    return () => {
      observer.disconnect()
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('keydown', keydown, true)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
      window.visualViewport?.removeEventListener('resize', reposition)
      window.visualViewport?.removeEventListener('scroll', reposition)
      if (document.activeElement === document.body || menu.contains(document.activeElement)) anchor?.focus()
    }
  }, [anchorRef, role])
  return <FloatingPortal anchorRef={anchorRef}><div ref={menuRef} id={id} role={role} aria-label={label}
    tabIndex={-1} className={`anchored-menu ${className}`}>{children}</div></FloatingPortal>
}
