import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ContextAttachment } from '../../shared/contracts'
import { activateModalFocus, trapTabFocus } from './dialog-focus'
import { AttachmentResultButton } from './AttachmentResultButton'
import { AttachmentActions, AttachmentStatus } from './AttachmentActions'

export function QueuedAttachmentsDialog({ itemId, onClose }: { itemId: string; onClose: () => void }): React.JSX.Element {
  const close = useRef<HTMLButtonElement>(null)
  const [items, setItems] = useState<ContextAttachment[]>()
  const [error, setError] = useState('')
  useEffect(() => activateModalFocus(() => close.current), [])
  useEffect(() => {
    let active = true
    void window.goodbuddy.conversationQueue.getAttachments(itemId).then((value) => { if (active) setItems(value) },
      (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : '队列附件读取失败') })
    return () => { active = false }
  }, [itemId])
  return createPortal(<div className="document-parsing-diagnostic-backdrop">
    <section className="document-parsing-diagnostic" role="dialog" aria-modal="true" aria-label="入队时的附件" onKeyDown={(event) => {
      if (event.target instanceof Element && event.target.closest('[aria-modal="true"]') !== event.currentTarget) return
      trapTabFocus(event, event.currentTarget)
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    }}>
      <header><strong>入队时的附件</strong><button type="button" className="secondary-button" ref={close} onClick={onClose}>关闭附件预览</button></header>
      <p>这里显示入队时的内容。需要修改附件时，请先将整条输入恢复到草稿。</p>
      {error && <p role="alert">{error}</p>}
      {!items && !error && <p role="status">正在读取附件</p>}
      {items?.length === 0 && <p>此输入没有附件。</p>}
      <div className="document-result-panel">{items?.map((item) => <article key={item.id}>
        <h3>{item.name}</h3>
        <div className="attachment-metadata"><AttachmentStatus attachment={item} /></div>
        <div className="attachment-actions">
        {item.resultId && <AttachmentResultButton resultId={item.resultId} name={item.name} readOnly />}
        <AttachmentActions attachment={item} readOnly />
        </div>
      </article>)}</div>
    </section>
  </div>, document.body)
}
