import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MagicNoteSource as Source } from '../../shared/magic-notes-contracts'

export type OpenMagicNoteSource = (source: Source, messageId?: string) => Promise<'opened' | 'missing'>

export function MagicNoteSource({ source, onOpen }: { source: Source; onOpen?: OpenMagicNoteSource }): React.JSX.Element {
  const { t, i18n } = useTranslation('magicNotes')
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const open = async (messageId?: string): Promise<void> => {
    if (!onOpen || busy) return
    setBusy(true)
    setError('')
    try { setMissing(await onOpen(source, messageId) === 'missing') }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('errors.operationFailed')) }
    finally { setBusy(false) }
  }
  return <aside className="magic-note-source" aria-label={t('capture.source')}>
    <span>{t('capture.source')}: {source.conversationTitle}</span>
    <span>{source.projectName && `${source.projectName} · `}<time dateTime={source.capturedAt}>{new Date(source.capturedAt).toLocaleString(i18n.language)}</time></span>
    {onOpen && <div className="magic-note-panel__actions">
      <button className="secondary-button" type="button" disabled={missing || busy} onClick={() => void open()}>{t(missing ? 'capture.missingConversation' : 'capture.openSource')}</button>
      {source.kind === 'message' && <button className="secondary-button" type="button" disabled={missing || busy} onClick={() => void open(source.messageIds[0])}>{t('capture.openMessage')}</button>}
    </div>}
    {error && <p role="alert">{error} <button className="secondary-button" type="button" onClick={() => void open(source.kind === 'message' ? source.messageIds[0] : undefined)}>{t('actions.retry')}</button></p>}
  </aside>
}
