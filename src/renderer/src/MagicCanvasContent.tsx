import { forwardRef, useEffect, useState, useRef, useImperativeHandle } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { MagicCanvasEditor, type MagicCanvasEditorHandle, type MagicNoteCanvasContent } from './MagicCanvasEditor'
import './magic-canvas.css'

export type MagicCanvasContentProps = {
  content: MagicNoteCanvasContent
  onError?: (message: string) => void
  onEdit?: () => void
}

/** Percentages of the current page, origin at the top-left corner. */
export type MagicCanvasRegion = { x: number; y: number; width: number; height: number }

export type MagicCanvasContentHandle = Pick<MagicCanvasEditorHandle, 'capturePages' | 'activePage'> & {
  /** Overlays the visible page and resolves with the dragged region, or null when cancelled. */
  selectRegion(hint: string): Promise<MagicCanvasRegion | null>
  cancelRegion(): void
}

type Selection = { host: HTMLElement; hint: string; resolve(region: MagicCanvasRegion | null): void }

const FULL_PAGE: MagicCanvasRegion = { x: 0, y: 0, width: 100, height: 100 }
const MIN_SIZE = 0.5
const clamp = (value: number): number => Math.max(0, Math.min(100, value))

function RegionOverlay({ hint, label, onDone }: { hint: string; label: string; onDone(region: MagicCanvasRegion | null): void }): React.JSX.Element {
  const [region, setRegion] = useState<MagicCanvasRegion>()
  const drag = useRef<{ x: number; y: number; box: DOMRect } | undefined>(undefined)
  const element = useRef<HTMLDivElement>(null)
  useEffect(() => { element.current?.focus({ preventScroll: true }) }, [])
  const point = (event: React.PointerEvent, box: DOMRect) => ({
    x: clamp((event.clientX - box.left) / box.width * 100),
    y: clamp((event.clientY - box.top) / box.height * 100)
  })
  return <div ref={element} className="magic-canvas-region" tabIndex={0} role="group" aria-label={label}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDone(null); return }
      if (event.key === 'Enter') { event.preventDefault(); onDone(region ?? FULL_PAGE); return }
      const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]
      if (!step) return
      event.preventDefault()
      setRegion(current => {
        const base = current ?? FULL_PAGE
        if (event.shiftKey) {
          // Shift resizes from the bottom-right corner; the region never collapses below the minimum.
          return { ...base, width: Math.max(MIN_SIZE, Math.min(100 - base.x, base.width + step[0]!)), height: Math.max(MIN_SIZE, Math.min(100 - base.y, base.height + step[1]!)) }
        }
        return { ...base, x: Math.max(0, Math.min(100 - base.width, base.x + step[0]!)), y: Math.max(0, Math.min(100 - base.height, base.y + step[1]!)) }
      })
    }}
    onPointerDown={event => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const box = event.currentTarget.getBoundingClientRect()
      drag.current = { ...point(event, box), box }
      setRegion(undefined)
      event.currentTarget.setPointerCapture(event.pointerId)
    }}
    onPointerMove={event => {
      if (!drag.current) return
      const { x, y } = point(event, drag.current.box)
      setRegion({ x: Math.min(x, drag.current.x), y: Math.min(y, drag.current.y), width: Math.abs(x - drag.current.x), height: Math.abs(y - drag.current.y) })
    }}
    onPointerUp={event => {
      if (!drag.current) return
      const { x, y } = point(event, drag.current.box)
      const next = { x: Math.min(x, drag.current.x), y: Math.min(y, drag.current.y), width: Math.abs(x - drag.current.x), height: Math.abs(y - drag.current.y) }
      drag.current = undefined
      // A plain click is not a selection; keep the overlay open so the user can drag again.
      if (next.width >= MIN_SIZE && next.height >= MIN_SIZE) onDone(next)
      else setRegion(undefined)
    }}
    onPointerCancel={() => { drag.current = undefined }}>
    <span className="magic-canvas-region__hint">{hint}</span>
    {region && <span className="magic-canvas-region__box" style={{ left: `${region.x}%`, top: `${region.y}%`, width: `${region.width}%`, height: `${region.height}%` }} />}
  </div>
}

export const MagicCanvasContent = forwardRef<MagicCanvasContentHandle, MagicCanvasContentProps>(function MagicCanvasContent({ content, onError, onEdit }, ref) {
  const { t } = useTranslation('magicNotes')
  const editorRef = useRef<MagicCanvasEditorHandle>(null)
  const [selection, setSelection] = useState<Selection>()
  const selectionRef = useRef<Selection | undefined>(undefined)
  const finish = (region: MagicCanvasRegion | null): void => {
    const current = selectionRef.current
    selectionRef.current = undefined
    setSelection(undefined)
    current?.resolve(region)
  }
  useImperativeHandle(ref, () => ({ async capturePages(pageLimit, includeImages, pageStart) {
    if (!editorRef.current) throw new Error(t('canvas.notReady'))
    return editorRef.current.capturePages(pageLimit, includeImages, pageStart)
  }, async activePage() {
    if (!editorRef.current) throw new Error(t('canvas.notReady'))
    return editorRef.current.activePage()
  }, async selectRegion(hint) {
    if (!editorRef.current) throw new Error(t('canvas.notReady'))
    const host = await editorRef.current.pageElement()
    finish(null)
    host.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    return new Promise<MagicCanvasRegion | null>(resolve => {
      const next = { host, hint, resolve }
      selectionRef.current = next
      setSelection(next)
    })
  }, cancelRegion() { finish(null) } }), [t])
  const [snapshot, setSnapshot] = useState({ content, revision: 0 })
  if (snapshot.content !== content) setSnapshot({ content, revision: snapshot.revision + 1 })
  // Replacing the content remounts the editor and its page element, so a pending selection is stale.
  useEffect(() => () => finish(null), [snapshot.revision])
  return <div className="magic-canvas-content">
    {onEdit && <button type="button" className="magic-canvas-open" onClick={onEdit}>{t('canvas.edit')}</button>}
    <MagicCanvasEditor ref={editorRef} key={snapshot.revision} initialContent={content} disabled onChange={() => {}} onError={onError ?? (() => {})} />
    {selection && createPortal(<RegionOverlay hint={selection.hint} label={t('questions.captureRegion')} onDone={finish} />, selection.host)}
  </div>
})
