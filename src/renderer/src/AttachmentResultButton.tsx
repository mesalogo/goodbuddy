import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileSearch } from 'lucide-react'
import { DocumentResultPreview } from './DocumentResultPreview'
import { activateModalFocus, trapTabFocus } from './dialog-focus'

export function AttachmentResultButton({ resultId, name, conversationId, readOnly = false }: {
  resultId: string; name: string; conversationId?: string; readOnly?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => open ? activateModalFocus(() => close.current) : undefined, [open])
  return <>
    <button type="button" className="icon-button attachment-action" title="查看解析结果" data-tooltip="查看解析结果" aria-label={`查看解析结果：${name}`} aria-haspopup="dialog" onClick={() => setOpen(true)}><FileSearch size={16} aria-hidden="true" /></button>
    {open && createPortal(<div className="document-parsing-diagnostic-backdrop">
      <section className="document-parsing-diagnostic" role="dialog" aria-modal="true" aria-label={`解析结果：${name}`}
        onKeyDown={(event) => {
          if (event.target instanceof Element && event.target.closest('[aria-modal="true"]') !== event.currentTarget) return
          trapTabFocus(event, event.currentTarget)
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false) }
        }}>
        <header><strong>{name}</strong><button type="button" className="secondary-button" ref={close} onClick={() => setOpen(false)}>关闭解析预览</button></header>
        <DocumentResultPreview resultId={resultId} allowAddImages={!readOnly} conversationId={conversationId} />
      </section>
    </div>, document.body)}
  </>
}
