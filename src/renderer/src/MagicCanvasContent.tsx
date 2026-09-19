import { forwardRef, useState, useRef, useImperativeHandle } from 'react'
import { useTranslation } from 'react-i18next'
import { MagicCanvasEditor, type MagicCanvasEditorHandle, type MagicNoteCanvasContent } from './MagicCanvasEditor'
import './magic-canvas.css'

export type MagicCanvasContentProps = {
  content: MagicNoteCanvasContent
  onError?: (message: string) => void
  onEdit?: () => void
}

export type MagicCanvasContentHandle = Pick<MagicCanvasEditorHandle, 'capturePages'>

export const MagicCanvasContent = forwardRef<MagicCanvasContentHandle, MagicCanvasContentProps>(function MagicCanvasContent({ content, onError, onEdit }, ref) {
  const { t } = useTranslation('magicNotes')
  const editorRef = useRef<MagicCanvasEditorHandle>(null)
  useImperativeHandle(ref, () => ({ async capturePages() {
    if (!editorRef.current) throw new Error(t('canvas.notReady'))
    return editorRef.current.capturePages()
  } }), [t])
  const [snapshot, setSnapshot] = useState({ content, revision: 0 })
  if (snapshot.content !== content) setSnapshot({ content, revision: snapshot.revision + 1 })
  return <div className="magic-canvas-content">
    {onEdit && <button type="button" className="magic-canvas-open" onClick={onEdit}>{t('canvas.edit')}</button>}
    <MagicCanvasEditor ref={editorRef} key={snapshot.revision} initialContent={content} disabled onChange={() => {}} onError={onError ?? (() => {})} />
  </div>
})
