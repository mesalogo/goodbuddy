import DOMPurify from 'dompurify'
import { Code2, FileCode2, Maximize2, X } from 'lucide-react'
import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { activateModalFocus, trapTabFocus } from './dialog-focus'

const forbiddenTags = [
  'base',
  'embed',
  'form',
  'iframe',
  'link',
  'meta',
  'object',
  'script'
]

const forbiddenAttributes = [
  'action',
  'formaction',
  'ping',
  'srcset'
]

const staticPreviewPolicy = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  'font-src data:',
  "form-action 'none'",
  "frame-src 'none'",
  'img-src data:',
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'"
].join('; ')

const safeInlineImagePattern =
  /^data:image\/(?:gif|jpeg|png|webp);base64,[a-z0-9+/=\s]+$/iu

function createStaticHtmlDocument(source: string): string {
  const sanitized = DOMPurify.sanitize(source, {
    ALLOW_UNKNOWN_PROTOCOLS: false,
    FORBID_ATTR: forbiddenAttributes,
    FORBID_TAGS: forbiddenTags,
    WHOLE_DOCUMENT: true
  })
  const documentNode = new DOMParser().parseFromString(
    sanitized,
    'text/html'
  )

  for (const element of documentNode.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on')) {
        element.removeAttribute(attribute.name)
        continue
      }
      if (name === 'href' || name === 'xlink:href') {
        if (!attribute.value.trim().startsWith('#')) {
          element.removeAttribute(attribute.name)
        }
        continue
      }
      if (name === 'src' || name === 'poster') {
        if (
          element.localName !== 'img' ||
          !safeInlineImagePattern.test(attribute.value.trim())
        ) {
          element.removeAttribute(attribute.name)
        }
      }
    }
  }

  const policy = documentNode.createElement('meta')
  policy.httpEquiv = 'Content-Security-Policy'
  policy.content = staticPreviewPolicy
  documentNode.head.prepend(policy)

  const viewport = documentNode.createElement('meta')
  viewport.name = 'viewport'
  viewport.content = 'width=device-width, initial-scale=1'
  documentNode.head.append(viewport)

  return `<!doctype html>\n${documentNode.documentElement.outerHTML}`
}

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

  useEffect(
    () => activateModalFocus(() => closeRef.current),
    []
  )

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
            onClose()
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
          referrerPolicy="no-referrer"
          sandbox=""
          srcDoc={documentSource}
          title={t('markdown.htmlViewerFrame')}
        />
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
    () => createStaticHtmlDocument(source),
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
        sandbox=""
        srcDoc={documentSource}
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
