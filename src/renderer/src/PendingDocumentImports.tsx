import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from './i18n'
import type { ContextAttachment } from '../../shared/contracts'

export function PendingDocumentImports({ conversationId, refreshing, onBusyChange }: {
  conversationId: string; refreshing: boolean; onBusyChange: (busy: boolean) => void
}): React.JSX.Element | null {
  const { t } = useTranslation('settings')
  const [items, setItems] = useState<ContextAttachment[]>([])
  const [revision, setRevision] = useState(0)
  const [operation, setOperation] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void window.goodbuddy.context.pendingParsing(conversationId).then((value) => { if (active) setItems(value) },
      (reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : i18n.t('settings:documentParsing.pendingImports.loadFailed')) })
    return () => { active = false }
  }, [conversationId, refreshing, revision])
  if (!items.length && !error) return null
  return <div className="settings-warning" aria-label={t('documentParsing.pendingImports.regionLabel')}>
    {items.map((item) => <div key={item.id}>
      <strong>{item.name} · {item.parsingState === 'interrupted' ? t('documentParsing.pendingImports.interrupted') : t('documentParsing.pendingImports.failed')}</strong>
      <p>{item.parsingError ?? t('documentParsing.pendingImports.retryHint')}</p>
      <button type="button" className="secondary-button" disabled={Boolean(operation)} onClick={() => {
        const id = crypto.randomUUID()
        setOperation(id); setError(''); onBusyChange(true)
        void window.goodbuddy.context.retryParsing(conversationId, item.id, id).then(() => setRevision((value) => value + 1))
          .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t('documentParsing.pendingImports.retryFailed')))
          .finally(() => { setOperation(''); onBusyChange(false) })
      }}>{t('documentParsing.pendingImports.retry')}</button>
      <button type="button" className="secondary-button" disabled={Boolean(operation)} onClick={() => {
        void window.goodbuddy.context.dismissParsing(conversationId, item.id).then(() => setRevision((value) => value + 1))
          .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t('documentParsing.pendingImports.dismissFailed')))
      }}>{t('documentParsing.pendingImports.dismiss')}</button>
    </div>)}
    {operation && <button type="button" className="secondary-button" onClick={() => void window.goodbuddy.context.cancelParsing(operation)}>{t('documentParsing.pendingImports.cancelParsing')}</button>}
    {error && <p role="alert">{error}</p>}
  </div>
}
