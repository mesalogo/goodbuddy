import { CircleHelp } from 'lucide-react'
import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { FloatingPortal } from './FloatingPortal'
import './inline-help.css'

export function InlineHelp({ label, children, id }: {
  label: string
  children: ReactNode
  id?: string
}): React.JSX.Element {
  const generatedId = useId()
  const contentId = id ?? generatedId
  const anchorRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(false)
  const hovered = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const cancelClose = (): void => { clearTimeout(timer.current) }
  const close = (): void => {
    cancelClose()
    pinned.current = false
    setOpen(false)
  }
  const leave = (): void => {
    hovered.current = false
    cancelClose()
    timer.current = setTimeout(() => {
      if (!pinned.current && !hovered.current && document.activeElement !== anchorRef.current &&
        !panelRef.current?.contains(document.activeElement)) setOpen(false)
    }, 120)
  }
  const enter = (): void => {
    hovered.current = true
    cancelClose()
    setOpen(true)
  }
  const dismiss = useEffectEvent(close)
  const position = useEffectEvent(() => {
    const panel = panelRef.current
    const anchor = anchorRef.current
    if (!panel || !anchor) return
    const viewport = window.visualViewport
    const left = viewport?.offsetLeft ?? 0
    const top = viewport?.offsetTop ?? 0
    const width = viewport?.width ?? window.innerWidth
    const height = viewport?.height ?? window.innerHeight
    const rect = anchor.getBoundingClientRect()
    const panelWidth = Math.max(0, Math.min(360, width - 32))
    panel.style.width = `${panelWidth}px`
    panel.style.maxHeight = `${Math.max(0, height - 32)}px`
    const panelHeight = panel.getBoundingClientRect().height
    const below = rect.bottom + 8
    const y = below + panelHeight <= top + height - 16 ? below : rect.top - 8 - panelHeight
    panel.style.left = `${Math.max(left + 16, Math.min(rect.left, left + width - panelWidth - 16))}px`
    panel.style.top = `${Math.max(top + 16, Math.min(y, top + height - panelHeight - 16))}px`
  })
  useLayoutEffect(() => { if (open) position() })
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (!open) return
    const inside = (target: EventTarget | null): boolean => target instanceof Node &&
      !!(anchorRef.current?.contains(target) || panelRef.current?.contains(target))
    const outside = (event: Event): void => { if (!inside(event.target)) dismiss() }
    const keydown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      dismiss()
    }
    const reposition = (): void => position()
    const observer = new ResizeObserver(reposition)
    if (panelRef.current) observer.observe(panelRef.current)
    if (anchorRef.current) observer.observe(anchorRef.current)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    // Run before modal/document handlers, including when hover did not move focus.
    window.addEventListener('keydown', keydown, true)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    window.visualViewport?.addEventListener('resize', reposition)
    window.visualViewport?.addEventListener('scroll', reposition)
    return () => {
      observer.disconnect()
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      window.removeEventListener('keydown', keydown, true)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
      window.visualViewport?.removeEventListener('resize', reposition)
      window.visualViewport?.removeEventListener('scroll', reposition)
    }
  }, [open])
  return <>
    <button type="button" className="inline-help" ref={anchorRef} aria-label={label}
      aria-expanded={open} aria-controls={open ? contentId : undefined} aria-describedby={open || id ? contentId : undefined}
      onMouseEnter={enter} onMouseLeave={leave} onFocus={() => { cancelClose(); setOpen(true) }} onBlur={leave}
      onClick={event => {
        event.stopPropagation()
        if (pinned.current) close()
        else { cancelClose(); pinned.current = true; setOpen(true) }
      }}>
      <CircleHelp size={14} aria-hidden="true" />
    </button>
    {/* Referenced hidden text remains an accessible description without a second visible copy. */}
    {!open && id && <span id={contentId} hidden>{children}</span>}
    {open && <FloatingPortal anchorRef={anchorRef}>
      <div className="inline-help__content" id={contentId} role="tooltip" ref={panelRef}
        onMouseEnter={enter} onMouseLeave={leave} onFocus={cancelClose} onBlur={leave}>
        {children}
      </div>
    </FloatingPortal>}
  </>
}
