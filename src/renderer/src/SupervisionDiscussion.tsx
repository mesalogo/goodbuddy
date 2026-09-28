import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export function SupervisionDiscussion({ resultId, sourceId, conversationId, title, onOpenConversation }: {
  resultId: string
  sourceId: string
  conversationId: string
  title: string
  onOpenConversation: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('heartbeat')
  const [draft, setDraft] = useState<string>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const perform = async (send: boolean) => {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setError('')
    try {
      if (send) {
        if (!draft?.trim()) return
        await window.goodbuddy.supervision.continue({ conversationId, prompt: draft })
        if (!mounted.current) return
        setDraft(undefined)
        onOpenConversation(conversationId)
      } else {
        const preview = await window.goodbuddy.supervision.continueContext({ resultId, sourceId })
        if (!mounted.current) return
        if (typeof preview.prompt !== 'string' || !preview.prompt.trim()) throw new Error(t('supervisor.discussion.empty'))
        setDraft(preview.prompt)
      }
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : t('common.operationFailed'))
    } finally {
      busy.current = false
      if (mounted.current) setPending(false)
    }
  }
  return <div className="supervisor-discussion">
    {draft === undefined ? <button className="primary-button" disabled={pending} onClick={() => void perform(false)}>{t('supervisor.discussion.start')}</button> : <div className="supervision-discussion-editor">
      <p className="supervision-discussion-editor__target">{t('supervisor.discussion.target', { title })}</p>
      <label className="field"><span>{t('supervisor.discussion.message')}</span><textarea rows={10} value={draft} disabled={pending} onChange={event => setDraft(event.target.value)} /></label>
      <footer className="custom-task-dialog__actions">
        <button className="secondary-button" disabled={pending} onClick={() => { setDraft(undefined); setError('') }}>{t('supervisor.cancel')}</button>
        <button className="primary-button" disabled={pending || !draft.trim()} onClick={() => void perform(true)}>{t(pending ? 'supervisor.discussion.sending' : 'supervisor.discussion.send')}</button>
      </footer>
    </div>}
    {pending && <p role="status">{t('supervisor.discussion.loading')}</p>}
    {error && <p role="alert">{error}</p>}
  </div>
}
