import { useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import i18n from './i18n'
import type { ContextAttachment } from '../../shared/contracts'
import { activateModalFocus, trapTabFocus } from './dialog-focus'
import { AttachmentResultButton } from './AttachmentResultButton'
import { AttachmentActions, AttachmentStatus } from './AttachmentActions'
import { InlineHelp } from './InlineHelp'
import { DocumentConversationContext } from './DocumentConversationContext'

export function QueuedAttachmentsDialog({ itemId, onClose }: { itemId: string; onClose: () => void }): React.JSX.Element {
  const close = useRef<HTMLButtonElement>(null)
  const conversationContext = useContext(DocumentConversationContext)
  const { t } = useTranslation('settings')
  const [items, setItems] = useState<ContextAttachment[]>()
  const [error, setError] = useState('')
  useEffect(() => activateModalFocus(() => close.current), [])
  useEffect(() => {
    let active = true
    void window.goodbuddy.conversationQueue.getAttachments(itemId).then((value) => { if (active) setItems(value) },
      (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : i18n.t('settings:documentParsing.queuedAttachments.loadFailed')) })
    return () => { active = false }
  }, [itemId])
  return createPortal(<div className="document-parsing-diagnostic-backdrop">
    <section className="document-parsing-diagnostic" role="dialog" aria-modal="true" aria-label={t('documentParsing.queuedAttachments.dialogLabel')} onKeyDown={(event) => {
      if (event.target instanceof Element && event.target.closest('[aria-modal="true"]') !== event.currentTarget) return
      trapTabFocus(event, event.currentTarget)
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    }}>
      <header><span className="inline-help-label"><strong>{t('documentParsing.queuedAttachments.dialogLabel')}</strong><InlineHelp label={t('documentParsing.queuedAttachments.dialogLabel')}>{t('documentParsing.queuedAttachments.help')}</InlineHelp></span><button type="button" className="secondary-button" ref={close} onClick={onClose}>{t('documentParsing.queuedAttachments.close')}</button></header>
      {error && <p role="alert">{error}</p>}
      {!items && !error && <p role="status">{t('documentParsing.queuedAttachments.loading')}</p>}
      {items?.length === 0 && <p>{t('documentParsing.queuedAttachments.empty')}</p>}
      <div className="document-result-panel">{items?.map((item) => <article key={item.id}>
        <h3>{item.name}</h3>
        {item.kind === 'image' && (item.thumbnailUrl || item.contentUrl) && <div className="document-result-image"><button
          type="button" className="message-image-button" aria-label={t('documentParsing.queuedAttachments.viewImage', { name: item.name })}
          onClick={(event) => conversationContext?.openImage(item.contentUrl ?? item.thumbnailUrl!, item.name, event.currentTarget)}
        ><img src={item.thumbnailUrl ?? item.contentUrl} alt={item.name} loading="lazy" /></button></div>}
        <div className="attachment-metadata"><AttachmentStatus attachment={item} /></div>
        <div className="attachment-actions">
        {item.resultId && <AttachmentResultButton resultId={item.resultId} name={item.name} readOnly />}
        <AttachmentActions attachment={item} readOnly />
        </div>
      </article>)}</div>
    </section>
  </div>, document.body)
}
