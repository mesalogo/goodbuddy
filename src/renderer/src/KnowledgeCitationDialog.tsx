import { ExternalLink, FileSearch, LoaderCircle, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { KnowledgeSearchReference } from '../../shared/contracts'
import { activateModalFocus, trapTabFocus } from './dialog-focus'

export type KnowledgeCitationContextView = {
  libraryName: string
  documentName: string
  sourceName: string
  locator?: string
  matchedContent: string
  contextContent: string
  truncated?: boolean
}

export type KnowledgeCitationDialogProps = {
  reference: KnowledgeSearchReference
  context?: KnowledgeCitationContextView
  loading?: boolean
  error?: string
  onClose: () => void
  onOpenSource: (documentId: string) => void | Promise<void>
}

export function KnowledgeCitationDialog({
  reference,
  context,
  loading = false,
  error,
  onClose,
  onOpenSource
}: KnowledgeCitationDialogProps): React.JSX.Element {
  const { t } = useTranslation('app')
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string>()

  useEffect(() => {
    return activateModalFocus(() => closeRef.current)
  }, [])

  const openSource = async (): Promise<void> => {
    setOpening(true)
    setOpenError(undefined)
    try {
      await onOpenSource(reference.documentId)
    } catch (reason) {
      setOpenError(
        reason instanceof Error
          ? reason.message
          : t('chat.citations.contextUnavailable')
      )
    } finally {
      setOpening(false)
    }
  }

  return createPortal(
    <div
      aria-labelledby="knowledge-citation-dialog-title"
      aria-modal="true"
      className="knowledge-citation-dialog"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !opening) {
          event.preventDefault()
          onClose()
          return
        }
        trapTabFocus(event, dialogRef.current)
      }}
      ref={dialogRef}
      role="dialog"
    >
      <section className="knowledge-citation-dialog__surface">
        <header className="knowledge-citation-dialog__header">
          <div>
            <span className="knowledge-citation-dialog__eyebrow">
              <FileSearch aria-hidden="true" size={14} />
              {reference.libraryName}
            </span>
            <h2 id="knowledge-citation-dialog-title">
              {t('chat.citations.contextTitle')}
            </h2>
            <p>{t('chat.citations.contextDescription')}</p>
          </div>
          <button
            aria-label={t('chat.citations.closeContext')}
            className="secondary-button"
            disabled={opening}
            onClick={onClose}
            ref={closeRef}
            type="button"
          >
            <X aria-hidden="true" size={15} />
          </button>
        </header>

        <dl className="knowledge-citation-dialog__metadata">
          <div>
            <dt>{reference.documentName}</dt>
            <dd>{context?.sourceName ?? reference.sourceName}</dd>
          </div>
          {(context?.locator ?? reference.locator) && (
            <div>
              <dt>{context?.locator ?? reference.locator}</dt>
              {reference.score !== undefined && (
                <dd>
                  {t('chat.citations.score', {
                    score: reference.score.toFixed(3)
                  })}
                </dd>
              )}
            </div>
          )}
        </dl>

        {loading ? (
          <div
            aria-live="polite"
            className="knowledge-citation-dialog__state"
            role="status"
          >
            <LoaderCircle aria-hidden="true" size={20} />
            {t('chat.citations.contextLoading')}
          </div>
        ) : error ? (
          <div
            className="knowledge-citation-dialog__state knowledge-citation-dialog__state--error"
            role="alert"
          >
            {error}
          </div>
        ) : context ? (
          <div className="knowledge-citation-dialog__content">
            <section>
              <h3>{t('chat.citations.matchedChunk')}</h3>
              <p>{context.matchedContent}</p>
            </section>
            <section>
              <h3>{t('chat.citations.surroundingContext')}</h3>
              <p>{context.contextContent}</p>
              {context.truncated && (
                <small
                  className="knowledge-citation-dialog__truncated"
                  role="note"
                >
                  {t('chat.citations.contextTruncated')}
                </small>
              )}
            </section>
          </div>
        ) : (
          <div
            className="knowledge-citation-dialog__state"
            role="alert"
          >
            {t('chat.citations.contextUnavailable')}
          </div>
        )}

        {openError && (
          <p className="knowledge-citation-dialog__open-error" role="alert">
            {openError}
          </p>
        )}
        <footer className="knowledge-citation-dialog__actions">
          <button
            className="secondary-button"
            disabled={opening}
            onClick={onClose}
            type="button"
          >
            {t('chat.citations.closeContext')}
          </button>
          <button
            className="primary-button"
            disabled={opening}
            onClick={() => void openSource()}
            type="button"
          >
            {opening ? (
              <LoaderCircle aria-hidden="true" size={15} />
            ) : (
              <ExternalLink aria-hidden="true" size={15} />
            )}
            {t('chat.citations.openSource')}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  )
}
