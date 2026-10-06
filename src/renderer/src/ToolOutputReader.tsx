import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ToolOutputReference } from '../../shared/assistant-contracts'
import type { ConversationOutputPage } from '../../shared/conversation-output'

export function ToolOutputReader({ conversationId, reference, index, onCopy }: {
  conversationId: string
  reference: ToolOutputReference
  index: number
  onCopy: (content: string, kind?: 'tool') => Promise<boolean>
}): React.JSX.Element {
  const { t } = useTranslation('app')
  const [page, setPage] = useState<ConversationOutputPage>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [])
  const load = async (cursor: number): Promise<void> => {
    const current = ++generation.current
    setBusy(true)
    setError('')
    try {
      const next = await window.goodbuddy.context.readOutput({ conversationId, handle: reference.handle, cursor })
      if (current === generation.current) setPage(next)
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : t('chat.tools.readOutputFailed'))
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }
  const label = t('chat.tools.fullOutput', { index })
  return <section className="tool-detail" aria-label={label}>
    <header className="tool-detail__toolbar">
      <button type="button" disabled={busy} onClick={() => { void load(0) }}>{label}</button>
      {page && <>
        <span>{page.cursor}-{page.nextCursor} / {page.totalBytes}</span>
        <button type="button" disabled={busy || page.eof} onClick={() => { void load(page.nextCursor) }}>{t('chat.tools.nextOutputPage')}</button>
        <button type="button" onClick={() => { void onCopy(page.content, 'tool') }}>{t('chat.tools.copyOutputPage')}</button>
      </>}
    </header>
    {busy && <span role="status">{t('chat.tools.loadingOutput')}</span>}
    {error && <p role="alert">{error}</p>}
    {page && <pre tabIndex={0} aria-label={label}>{page.content}</pre>}
  </section>
}
