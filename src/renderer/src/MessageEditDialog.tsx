import { Paperclip, X } from 'lucide-react'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { activateModalFocus, trapTabFocus } from './dialog-focus'
import type { MessageEditStore } from './message-edit-store'
import { maximumAttachmentsPerMessage } from '../../shared/attachment-limits'
import { useWorkspaceUnsavedChanges } from './workspace-unsaved-changes'

export function MessageEditDialog({ store, unavailable }: { store: MessageEditStore; unavailable?: string }): React.JSX.Element | null {
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const { t } = useTranslation('app')
  const input = useRef<HTMLTextAreaElement>(null)
  const dialog = useRef<HTMLElement>(null)
  const open = Boolean(state)
  useWorkspaceUnsavedChanges(open)
  useEffect(() => open ? activateModalFocus(() => input.current) : undefined, [open])
  if (!state) return null
  const busy = state.submitting || state.addingFiles
  return createPortal(<div className="custom-task-dialog" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); if (!busy) void store.cancel() }
    if (event.key === 'Tab' && dialog.current) trapTabFocus(event, dialog.current)
  }}>
    <section ref={dialog} className="custom-task-dialog__surface" role="dialog" aria-modal="true" aria-labelledby="message-edit-title" aria-describedby="message-edit-hint">
      <header className="custom-task-dialog__header"><h2 id="message-edit-title">{t('messageEdit.title')}</h2><button type="button" className="icon-button" disabled={busy} aria-label={t('messageEdit.cancel')} onClick={() => void store.cancel()}><X size={18} /></button></header>
      <div className="custom-task-dialog__content">
        <p id="message-edit-hint">{t('messageEdit.hint')}</p>
        <label className="field"><span>{t('messageEdit.content')}</span><textarea ref={input} value={state.content} rows={8} disabled={state.submitting} maxLength={100_000} onChange={event => store.setContent(event.target.value)} onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); if (!unavailable) void store.submit() }
        }} /></label>
        <div className="message-attachments">{state.attachments.map(attachment => <div className="message-attachment" key={attachment.id}><span>{attachment.name}</span><button type="button" className="icon-button" disabled={busy} aria-label={t('messageEdit.removeAttachment', { name: attachment.name })} onClick={() => store.removeAttachment(attachment.id)}><X size={16} /></button></div>)}</div>
        <button type="button" className="secondary-button" disabled={busy || state.attachments.length >= maximumAttachmentsPerMessage} onClick={() => void store.addFiles()}><Paperclip size={16} />{t(state.addingFiles ? 'messageEdit.adding' : 'messageEdit.addAttachment')}</button>
        {unavailable && <p role="status">{unavailable}</p>}
        {state.error && <p role="alert">{state.error}</p>}
        {state.branch && state.error && <p>{t('messageEdit.branchSaved')}</p>}
      </div>
      <footer className="custom-task-dialog__actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => void store.cancel()}>{t('messageEdit.cancel')}</button><button type="button" className="primary-button" disabled={busy || Boolean(unavailable) || !state.content.trim()} onClick={() => void store.submit()}>{t(state.submitting ? 'messageEdit.submitting' : 'messageEdit.submit')}</button></footer>
    </section>
  </div>, document.body)
}
