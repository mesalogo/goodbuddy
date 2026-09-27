import type { KnowledgeSource, KnowledgeStorageMode } from './types'
import { useTranslation } from 'react-i18next'
import { useState, useRef, useId, useEffect } from 'react'
import { activateModalFocus, trapTabFocus } from '../dialog-focus'
import { toErrorMessage } from './helpers'
import { createPortal } from 'react-dom'
import { AlertCircle, Trash2 } from 'lucide-react'

export function RemoveSourceDialog({
  onCancel,
  onConfirm,
  source,
  storageMode
}: {
  onCancel: () => void
  onConfirm: () => void | Promise<void>
  source: KnowledgeSource
  storageMode: KnowledgeStorageMode
}): React.JSX.Element {
  const { t } = useTranslation('knowledge')
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string>()
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(
    () => activateModalFocus(() => cancelRef.current),
    []
  )

  const remove = async (): Promise<void> => {
    setRemoving(true)
    setError(undefined)
    try {
      await onConfirm()
      onCancel()
    } catch (reason) {
      setError(toErrorMessage(reason, t))
    } finally {
      setRemoving(false)
    }
  }

  return createPortal(
    <div
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      aria-modal="true"
      className="knowledge-confirm-dialog-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !removing) {
          event.preventDefault()
          onCancel()
          return
        }
        trapTabFocus(event, dialogRef.current)
      }}
      ref={dialogRef}
      role="alertdialog"
    >
      <section className="knowledge-confirm-dialog">
        <AlertCircle aria-hidden="true" size={26} />
        <h2 id={titleId}>
          {t('documents.removeSource.title', { name: source.name })}
        </h2>
        <p id={descriptionId}>
          {t(
            storageMode === 'managed'
              ? 'documents.removeSource.managedDescription'
              : 'documents.removeSource.referenceDescription',
            { count: source.documentCount }
          )}
        </p>
        {error && (
          <p className="knowledge-inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="knowledge-confirm-dialog__actions">
          <button
            className="secondary-button"
            disabled={removing}
            onClick={onCancel}
            ref={cancelRef}
            type="button"
          >
            {t('actions.cancel')}
          </button>
          <button
            className="danger-button"
            disabled={removing}
            onClick={() => void remove()}
            type="button"
          >
            <Trash2 aria-hidden="true" size={15} />
            {removing
              ? t('documents.removeSource.removing')
              : t('documents.removeSource.action')}
          </button>
        </div>
      </section>
    </div>,
    document.body
  )
}
