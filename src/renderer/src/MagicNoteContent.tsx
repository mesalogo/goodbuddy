import { useEffect, useRef } from 'react'
import Quill from 'quill'
import type { MagicNoteRichContent } from '../../shared/magic-notes-contracts'

export function MagicNoteContent({
  content
}: {
  content: MagicNoteRichContent
}): React.JSX.Element {
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
      aria-label="笔记记录内容"
      className="magic-note-content"
    />
  )
}
