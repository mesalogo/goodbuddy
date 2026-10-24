import { Code2, FileCode2, Maximize2, X } from 'lucide-react'
import {
  memo,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { activateModalFocus, getModalFocusableElements, trapTabFocus } from './dialog-focus'

function StaticHtmlViewer({
  documentSource,
  onClose
}: {
  documentSource: string
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation('app')
  const titleId = useId()
  const hintId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const closePreview = useEffectEvent(onClose)

  useEffect(
    () => activateModalFocus(() => closeRef.current),
    []
  )
  useEffect(() => window.goodbuddy.app.onPreviewEscape(() => {
    if (document.activeElement === frameRef.current && !dialogRef.current?.closest('[inert]')) {
      closePreview()
    }
  }), [])

  return createPortal(
    <div
      className="html-preview-viewer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <section
        aria-describedby={hintId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="html-preview-viewer"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose()
            return
          }
          if (event.key === 'Tab' && !event.shiftKey && document.activeElement === closeRef.current) {
            event.preventDefault()
            frameRef.current?.focus()
            return
          }
          trapTabFocus(event, dialogRef.current)
        }}
        ref={dialogRef}
        role="dialog"
      >
        <header className="html-preview-viewer__header">
          <div>
            <strong id={titleId}>
              {t('markdown.htmlViewerTitle')}
            </strong>
            <small id={hintId}>
              {t('markdown.htmlPreviewNotice')}
            </small>
          </div>
          <button
            aria-label={t('markdown.htmlCloseViewer')}
            className="icon-button"
            onClick={onClose}
            ref={closeRef}
            title={t('markdown.htmlCloseViewer')}
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <iframe
          ref={frameRef}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-forms"
          src={documentSource}
          tabIndex={0}
          title={t('markdown.htmlViewerFrame')}
        />
        {/* Native Tab leaving a cross-origin frame needs a focus target in this document. */}
        <span className="sr-only" tabIndex={0} data-focus-guard onFocus={() => {
          if (!dialogRef.current || !frameRef.current) return
          const targets = getModalFocusableElements(dialogRef.current)
          const next = targets[targets.indexOf(frameRef.current) + 1] ?? targets[0]
          next?.focus()
        }} />
      </section>
    </div>,
    document.body
  )
}

export const StaticHtmlPreview = memo(function StaticHtmlPreview({
  source
}: {
  source: string
}): React.JSX.Element {
  const { t } = useTranslation('app')
  const sourceId = useId()
  // Tracking the source these panels were opened for resets both when the
  // reply changes, without an effect that cascades renders.
  const [visibleSource, setVisibleSource] = useState<string>()
  const [viewerSource, setViewerSource] = useState<string>()
  const sourceVisible = visibleSource === source
  const viewerOpen = viewerSource === source
  const documentSource = useMemo(
    // A separate document avoids inheriting the application's script/network CSP.
    () => `goodbuddy-html://preview/?html=${encodeURIComponent(source)}`,
    [source]
  )

  const sourceLabel = t(
    sourceVisible
      ? 'markdown.htmlHideSource'
      : 'markdown.htmlViewSource'
  )

  return (
    <figure className="message-html-preview">
      <figcaption className="message-html-preview__header">
        <span>
          <FileCode2 aria-hidden="true" size={15} />
          <span>
            <strong>{t('markdown.htmlPreview')}</strong>
            <small>{t('markdown.htmlPreviewNotice')}</small>
          </span>
        </span>
        <div
          aria-label={t('markdown.htmlActions')}
          className="message-html-preview__actions"
          role="group"
        >
          <button
            aria-controls={sourceId}
            aria-expanded={sourceVisible}
            aria-label={sourceLabel}
            className={`icon-button${
              sourceVisible ? ' icon-button--active' : ''
            }`}
            onClick={() =>
              setVisibleSource(sourceVisible ? undefined : source)
            }
            title={sourceLabel}
            type="button"
          >
            <Code2 aria-hidden="true" size={17} />
          </button>
          <button
            aria-label={t('markdown.htmlOpenViewer')}
            className="icon-button"
            onClick={() => setViewerSource(source)}
            title={t('markdown.htmlOpenViewer')}
            type="button"
          >
            <Maximize2 aria-hidden="true" size={17} />
          </button>
        </div>
      </figcaption>
      <iframe
        loading="lazy"
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-forms"
        src={documentSource}
        title={t('markdown.htmlPreviewFrame')}
      />
      {sourceVisible && <pre id={sourceId}>{source}</pre>}
      {viewerOpen && (
        <StaticHtmlViewer
          documentSource={documentSource}
          onClose={() => setViewerSource(undefined)}
        />
      )}
    </figure>
  )
})
