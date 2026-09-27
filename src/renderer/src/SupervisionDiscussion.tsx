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
  const [context, setContext] = useState<string>()
  const [question, setQuestion] = useState('')
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
        if (!context || !question.trim()) return
        await window.goodbuddy.supervision.continue({ conversationId, prompt: `${context}\n\n${question}` })
        if (!mounted.current) return
        setContext(undefined)
        setQuestion('')
        onOpenConversation(conversationId)
      } else {
        const preview = await window.goodbuddy.supervision.continueContext({ resultId, sourceId })
        if (!mounted.current) return
        if (typeof preview.prompt !== 'string' || !preview.prompt.trim()) throw new Error(t('supervisor.discussion.empty'))
        setContext(preview.prompt)
        setQuestion(t('supervisor.discussion.defaultQuestion'))
      }
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : t('common.operationFailed'))
    } finally {
      busy.current = false
      if (mounted.current) setPending(false)
    }
  }
  return <div className="supervisor-discussion">
    {context === undefined ? <button className="primary-button" disabled={pending} onClick={() => void perform(false)}>{t('supervisor.discussion.start')}</button> : <>
      <p>{t('supervisor.discussion.target', { title })}</p>
      <label className="field"><span>{t('supervisor.discussion.question')}</span><textarea rows={3} value={question} disabled={pending} onChange={event => setQuestion(event.target.value)} /></label>
      <p>{t('supervisor.discussion.contextHint')}</p>
      <div className="supervisor-workspace__actions">
        <button className="secondary-button" disabled={pending} onClick={() => { setContext(undefined); setQuestion(''); setError('') }}>{t('supervisor.cancel')}</button>
        <button className="primary-button" disabled={pending || !question.trim()} onClick={() => void perform(true)}>{t('supervisor.discussion.send')}</button>
      </div>
    </>}
    {pending && <p role="status">{t('supervisor.discussion.loading')}</p>}
    {error && <p role="alert">{error}</p>}
  </div>
}
