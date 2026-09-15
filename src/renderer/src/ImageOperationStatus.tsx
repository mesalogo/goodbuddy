import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ImageOperation } from '../../shared/image-generation-contracts'
import { displayErrorMessage } from './error-message'

export function ImageOperationStatus({ operation, onOpenImageModelSettings, onReselectImageSources }: {
  operation: ImageOperation
  onOpenImageModelSettings?: () => void
  onReselectImageSources?: (operation: ImageOperation) => void
}): React.JSX.Element {
  const { t } = useTranslation('app')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const active = ['running', 'saving', 'cancelling'].includes(operation.state)
  const needsRecovery = !active && (operation.state === 'failed' || Boolean(error))
  const act = async (): Promise<void> => {
    setPending(true)
    setError(undefined)
    try {
      const api = window.goodbuddy.conversations.imageOperations
      await api[active ? 'cancel' : 'regenerate']({ conversationId: operation.conversationId, operationId: operation.id })
    } catch (reason) {
      setError(displayErrorMessage(reason, t('chat.images.states.failed')))
    } finally {
      setPending(false)
    }
  }
  return <section className="message-retrieval-status" aria-label={t('chat.images.operation')}>
    <div>
      <strong role="status">{t(`chat.images.states.${operation.state}`)} · {operation.modelProfileName ?? operation.modelName}</strong>
      {operation.cancellationRequested && <p>{t(
        operation.state === 'completed'
          ? 'chat.images.cancelTooLateNotice'
          : active ? 'chat.images.cancellingNotice' : 'chat.images.cancelNotice'
      )}</p>}
      {operation.state === 'unconfirmed' && <p>{t('chat.images.unconfirmedNotice')}</p>}
      {operation.error && <p>{operation.error}</p>}
      <details><summary>{t('chat.images.details')}</summary><div>{operation.input.prompt}</div>
        <small>{operation.modelName} · {operation.input.quality ?? 'auto'}</small>
        {operation.input.sourceArtifactIds.length > 0 && <div>{t('chat.images.sources', { count: operation.input.sourceArtifactIds.length })}</div>}
      </details>
      <div className="message-image-actions">
        <button type="button" aria-describedby={error ? `image-operation-error-${operation.id}` : undefined} disabled={pending || operation.state === 'cancelling'} onClick={() => void act()}>
          {t(active ? 'chat.images.cancel' : 'chat.images.regenerate')}
        </button>
        {!active && <small>{t('chat.images.regenerateNotice')}</small>}
        {needsRecovery && onOpenImageModelSettings && (
          <button type="button" disabled={pending} onClick={onOpenImageModelSettings}>
            {t('chat.images.reselectModel')}
          </button>
        )}
        {needsRecovery && operation.input.intent === 'edit' && onReselectImageSources && (
          <button type="button" disabled={pending} onClick={() => onReselectImageSources(operation)}>
            {t('chat.images.reselectSources')}
          </button>
        )}
      </div>
      {needsRecovery && <small>{t('chat.images.recoveryNotice')}</small>}
      {error && <p id={`image-operation-error-${operation.id}`} role="alert">{error}</p>}
    </div>
  </section>
}
