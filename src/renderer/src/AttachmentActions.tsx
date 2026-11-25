import { useContext, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Ellipsis } from 'lucide-react'
import type { ContextAttachment } from '../../shared/contracts'
import { AnchoredMenu } from './AnchoredMenu'
import { DocumentConversationContext } from './DocumentConversationContext'
import { officeStore } from './office-store'
import { isOfficeFile } from '../../shared/office-contracts'

export function AttachmentStatus({ attachment }: { attachment: ContextAttachment }): React.JSX.Element {
  const { t } = useTranslation('settings')
  return <>
    {attachment.completeness && <small>{t(`documentParsing.attachmentStatus.${attachment.completeness}`)}</small>}
    {attachment.sendMode && <small>{attachment.sendMode === 'text' ? t('documentParsing.attachmentStatus.textMode') : t('documentParsing.attachmentStatus.imageMode')}</small>}
  </>
}

export function AttachmentActions({ attachment, conversationId, onBusyChange, readOnly = false }: {
  attachment: ContextAttachment; conversationId?: string; onBusyChange?: (busy: boolean) => void; readOnly?: boolean
}): React.JSX.Element {
  const target = useContext(DocumentConversationContext)
  const { t } = useTranslation('settings')
  const [menu, setMenu] = useState(false)
  const [operation, setOperation] = useState('')
  const [error, setError] = useState('')
  const [provider, setProvider] = useState('')
  const anchor = useRef<HTMLButtonElement>(null)
  const id = useId()
  if (!attachment.resourceId) return <></>
  const run = (action: (operationId: string) => Promise<unknown>): void => {
    const operationId = crypto.randomUUID()
    setMenu(false); setError(''); setOperation(operationId); onBusyChange?.(true)
    void action(operationId).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t('documentParsing.attachmentActions.actionFailed')))
      .finally(() => { setOperation(''); onBusyChange?.(false) })
  }
  const more = t('documentParsing.attachmentActions.more')
  return <>
    <button type="button" className="icon-button attachment-action" title={more} data-tooltip={more} ref={anchor} aria-haspopup="menu" aria-expanded={menu} aria-controls={menu ? id : undefined}
      aria-label={t('documentParsing.attachmentActions.moreNamed', { name: attachment.name })} disabled={Boolean(operation)} onClick={() => {
        if (!menu && !readOnly) {
          setProvider(t('documentParsing.attachmentActions.readingSource'))
          void window.goodbuddy.documentParsing!.getSnapshot().then((snapshot) => setProvider(snapshot.settings.ocrProvider === 'paddleocr-vl' ? t('documentParsing.attachmentActions.sourceHttp') : t('documentParsing.attachmentActions.sourceLocal')), () => setProvider(t('documentParsing.attachmentActions.sourceReadFailed')))
        }
        setMenu((value) => !value)
      }}><Ellipsis size={16} aria-hidden="true" /></button>
    {menu && <AnchoredMenu anchorRef={anchor} id={id} label={t('documentParsing.attachmentActions.menuLabel', { name: attachment.name })} onClose={() => setMenu(false)}>
      {!readOnly && <small>{provider}</small>}
      <button type="button" role="menuitem" onClick={() => run(() => window.goodbuddy.context.openOriginal(attachment.resourceId!))}>{t('documentParsing.attachmentActions.openOriginal', { name: attachment.originalName ?? attachment.name })}</button>
      {isOfficeFile(attachment.originalName ?? attachment.name) && <button type="button" role="menuitem" onClick={() => {
        setMenu(false); officeStore.requestOpen({ kind: 'attachment', resourceId: attachment.resourceId! }, attachment.originalName ?? attachment.name)
      }}>{t('documentParsing.attachmentActions.editInDocumentTab')}</button>}
      {!readOnly && conversationId && <button type="button" role="menuitem" onClick={() => run((operationId) => window.goodbuddy.context.reparseDraft(conversationId, attachment.id, operationId))}>
        {t(attachment.sendMode ? 'documentParsing.attachmentActions.extractText' : 'documentParsing.attachmentActions.reparse', { name: attachment.originalName ?? attachment.name })}
      </button>}
      {!readOnly && conversationId && attachment.sendMode === 'text' && <button type="button" role="menuitem" onClick={() => run(() => window.goodbuddy.context.sendOriginal(conversationId, attachment.id))}>{t('documentParsing.attachmentActions.sendOriginal', { name: attachment.originalName ?? '' })}</button>}
      {!readOnly && !conversationId && target?.activeId && <button type="button" role="menuitem" onClick={() => run(async (operationId) => {
        await window.goodbuddy.context.copyToDraft(target.activeId!, attachment.resourceId!, operationId)
        target.notify(t('documentParsing.attachmentActions.copiedToDraft'))
      })}>{t(attachment.sendMode ? 'documentParsing.attachmentActions.copyAndExtract' : 'documentParsing.attachmentActions.copyAndReparse', { name: attachment.originalName ?? attachment.name })}</button>}
      {!readOnly && <button type="button" role="menuitem" onClick={() => { setMenu(false); void window.goodbuddy.localInference.openSettings('document-parsing') }}>{t('documentParsing.attachmentActions.openSettings')}</button>}
    </AnchoredMenu>}
    {operation && <span role="status">{t('documentParsing.attachmentActions.processing')}<button type="button" className="secondary-button" onClick={() => void window.goodbuddy.context.cancelParsing(operation)}>{t('documentParsing.attachmentActions.cancelParsing')}</button></span>}
    {error && <span role="alert">{error}</span>}
  </>
}
