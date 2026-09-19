import { useEffect, useRef } from 'react'
import Quill from 'quill'
import { useTranslation } from 'react-i18next'
import type { MagicNoteContent as NoteContent, MagicNoteRichContent } from '../../shared/magic-notes-contracts'
import { MagicCanvasContent, type MagicCanvasContentHandle } from './MagicCanvasContent'
import './magic-note-embeds'

export function MagicNoteContent({
  content, onError, canvasRef
}: {
  content: NoteContent
  onError?: (message: string) => void
  canvasRef?: React.Ref<MagicCanvasContentHandle>
}): React.JSX.Element {
  return content.version === 2
    ? <MagicCanvasContent ref={canvasRef} content={content} onError={onError} />
    : <RichNoteContent content={content} />
}

function RichNoteContent({
  content
}: {
  content: MagicNoteRichContent
}): React.JSX.Element {
  const { t } = useTranslation('magicNotes')
  const containerRef = useRef<HTMLDivElement>(null)
  const quillRef = useRef<Quill | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const quill = new Quill(container, {
      readOnly: true,
      theme: 'snow',
      modules: { toolbar: false }
    })
    quill.disable()
    quillRef.current = quill
    return () => {
      quillRef.current = null
      container.replaceChildren()
    }
  }, [])

  useEffect(() => {
    quillRef.current?.setContents(content.ops, 'silent')
  }, [content])

  return (
    <div
      ref={containerRef}
      aria-label={t('editor.contentLabel')}
      className="magic-note-content"
    />
  )
}
