import DOMPurify from 'dompurify'
import {
  Code2,
  Maximize2,
  RotateCcw,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { Mermaid, MermaidConfig } from 'mermaid'
import { activateModalFocus, trapTabFocus } from './dialog-focus'
import { useDocumentTheme } from './use-document-theme'
import './markdown-mermaid.css'

const MAX_MERMAID_TEXT_SIZE = 20_000
const MAX_MERMAID_EDGES = 300
const MAX_MERMAID_DIMENSION = 4_096
const MIN_VIEWER_ZOOM = 0.5
const MAX_VIEWER_ZOOM = 3
const VIEWER_ZOOM_STEP = 0.25
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const unsafeCssPattern =
  /(?:@import|\bexpression\s*\(|(?:https?|ftp|file|data|javascript|vbscript):|\/\/|-moz-binding|\bbehavior\s*:)/iu
const cssUrlPattern = /url\s*\(\s*(['"]?)(.*?)\1\s*\)/giu

const forbiddenTags = [
  'a',
  'animate',
  'animatemotion',
  'animatetransform',
  'discard',
  'foreignobject',
  'iframe',
  'image',
  'mpath',
  'set',
  'script'
]
const forbiddenAttributes = ['href', 'xlink:href']
const sharedSanitizerConfig = {
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  FORBID_ATTR: forbiddenAttributes,
  FORBID_TAGS: forbiddenTags
} as const
const secureConfigKeys = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'suppressErrorRendering',
  'maxEdges',
  'htmlLabels',
  'dompurifyConfig',
  'theme',
  'themeCSS',
  'themeVariables',
  'fontFamily',
  'altFontFamily',
  'flowchart'
]

let mermaidModulePromise: Promise<Mermaid> | undefined
let mermaidRenderQueue = Promise.resolve()
let mermaidDiagramSequence = 0

type MermaidRenderState =
  | {
      source: string
      status: 'ready'
      svg: string
      theme: 'light' | 'dark'
    }
  | {
      source: string
      status: 'error'
      theme: 'light' | 'dark'
    }

function loadMermaid(): Promise<Mermaid> {
  mermaidModulePromise ??= import('mermaid').then(
    (module) => module.default
  )
  return mermaidModulePromise
}

function containsUnsafeCss(value: string): boolean {
  const normalizedValue = value
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(
      /\\([0-9a-f]{1,6}\s?|.)/giu,
      (_match, escaped: string) => {
        const hex = escaped.trim()
        return /^[0-9a-f]{1,6}$/iu.test(hex)
          ? String.fromCodePoint(Number.parseInt(hex, 16))
          : escaped
      }
    )
  if (unsafeCssPattern.test(normalizedValue)) {
    return true
  }
  cssUrlPattern.lastIndex = 0
  for (
    let match = cssUrlPattern.exec(normalizedValue);
    match;
    match = cssUrlPattern.exec(normalizedValue)
  ) {
    if (!match[2]?.trim().startsWith('#')) {
      return true
    }
  }
  return false
}

function sanitizeMermaidSvg(svg: string): string {
  const sanitized = DOMPurify.sanitize(svg, {
    ...sharedSanitizerConfig,
    USE_PROFILES: {
      svg: true,
      svgFilters: true
    }
  })
  const documentNode = new DOMParser().parseFromString(
    sanitized,
    'image/svg+xml'
  )
  const root = documentNode.documentElement
  if (
    root.localName !== 'svg' ||
    root.namespaceURI !== SVG_NAMESPACE ||
    documentNode.querySelector('parsererror')
  ) {
    throw new Error('Mermaid returned invalid SVG')
  }

  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (
      element.localName === 'style' &&
      containsUnsafeCss(element.textContent ?? '')
    ) {
      element.remove()
      continue
    }
    for (const attribute of [...element.attributes]) {
      const attributeName = attribute.name.toLowerCase()
      if (
        attributeName.startsWith('on') ||
        forbiddenAttributes.includes(attributeName) ||
        containsUnsafeCss(attribute.value)
      ) {
        element.removeAttribute(attribute.name)
      }
    }
  }

  const viewBox = root
    .getAttribute('viewBox')
    ?.trim()
    .split(/[\s,]+/u)
    .map(Number)
  if (
    viewBox?.length === 4 &&
    viewBox.every(Number.isFinite) &&
    viewBox[2]! > 0 &&
    viewBox[3]! > 0
  ) {
    const scale = Math.min(
      1,
      MAX_MERMAID_DIMENSION / viewBox[2]!,
      MAX_MERMAID_DIMENSION / viewBox[3]!
    )
    root.setAttribute('width', String(Math.ceil(viewBox[2]! * scale)))
    root.setAttribute('height', String(Math.ceil(viewBox[3]! * scale)))
    root.style.removeProperty('max-width')
  }

  return new XMLSerializer().serializeToString(root)
}

function mermaidConfig(darkTheme: boolean): MermaidConfig {
  return {
    darkMode: darkTheme,
    deterministicIds: true,
    dompurifyConfig: sharedSanitizerConfig,
    fontFamily:
      '"Inter Variable", "Noto Sans SC Variable", "Segoe UI Variable", sans-serif',
    htmlLabels: false,
    logLevel: 'fatal',
    maxEdges: MAX_MERMAID_EDGES,
    maxTextSize: MAX_MERMAID_TEXT_SIZE,
    secure: secureConfigKeys,
    securityLevel: 'strict',
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: darkTheme ? 'dark' : 'default'
  }
}

function renderMermaid(
  source: string,
  id: string,
  darkTheme: boolean,
  shouldRender: () => boolean
): Promise<string> {
  if (source.length > MAX_MERMAID_TEXT_SIZE) {
    return Promise.reject(new Error('Mermaid source is too large'))
  }

  const render = mermaidRenderQueue.then(async () => {
    if (!shouldRender()) {
      throw new Error('Mermaid render was superseded')
    }
    const mermaid = await loadMermaid()
    if (!shouldRender()) {
      throw new Error('Mermaid render was superseded')
    }
    mermaid.initialize(mermaidConfig(darkTheme))
    const result = await mermaid.render(id, source)
    return sanitizeMermaidSvg(result.svg)
  })
  mermaidRenderQueue = render.then(
    () => undefined,
    () => undefined
  )
  return render
}

type MermaidDiagramProps = {
  source: string
}

type MermaidViewerProps = {
  onClose: () => void
  svg: string
}

function clampViewerZoom(zoom: number): number {
  return Math.min(MAX_VIEWER_ZOOM, Math.max(MIN_VIEWER_ZOOM, zoom))
}

function MermaidViewer({
  onClose,
  svg
}: MermaidViewerProps): React.JSX.Element {
  const { i18n, t } = useTranslation('app')
  const titleId = useId()
  const hintId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    scrollLeft: number
    scrollTop: number
  } | undefined>(undefined)
  const [dragging, setDragging] = useState(false)
  const [zoom, setZoom] = useState(1)
  const pendingWheelZoomRef = useRef(0)
  const zoomFrameRef = useRef<number | undefined>(undefined)
  const percentFormatter = useMemo(
    () =>
      new Intl.NumberFormat(i18n.resolvedLanguage, {
        maximumFractionDigits: 0,
        style: 'percent'
      }),
    [i18n.resolvedLanguage]
  )

  useEffect(() => {
    const deactivateModalFocus = activateModalFocus(
      () => closeRef.current
    )
    return () => {
      if (zoomFrameRef.current !== undefined) {
        cancelAnimationFrame(zoomFrameRef.current)
      }
      deactivateModalFocus()
    }
  }, [])

  const adjustZoom = (delta: number): void => {
    setZoom((current) => clampViewerZoom(current + delta))
  }

  const queueWheelZoom = (delta: number): void => {
    pendingWheelZoomRef.current += delta
    if (zoomFrameRef.current !== undefined) {
      return
    }
    zoomFrameRef.current = requestAnimationFrame(() => {
      const pendingZoom = pendingWheelZoomRef.current
      pendingWheelZoomRef.current = 0
      zoomFrameRef.current = undefined
      adjustZoom(pendingZoom)
    })
  }

  const finishDragging = (
    event: React.PointerEvent<HTMLDivElement>
  ): void => {
    if (dragRef.current?.pointerId !== event.pointerId) {
      return
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    dragRef.current = undefined
    setDragging(false)
  }

  return createPortal(
    <div
      className="mermaid-viewer-backdrop"
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
        className="mermaid-viewer"
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
        <header className="mermaid-viewer__header">
          <div>
            <strong id={titleId}>{t('markdown.mermaidViewerTitle')}</strong>
            <small id={hintId}>
              {t('markdown.mermaidViewerHint')}
            </small>
          </div>
          <div className="mermaid-viewer__controls">
            <button
              aria-label={t('markdown.mermaidZoomOut')}
              className="icon-button"
              disabled={zoom <= MIN_VIEWER_ZOOM}
              onClick={() => adjustZoom(-VIEWER_ZOOM_STEP)}
              title={t('markdown.mermaidZoomOut')}
              type="button"
            >
              <ZoomOut aria-hidden="true" size={17} />
            </button>
            <output
              aria-label={t('markdown.mermaidZoomLevel')}
              className="mermaid-viewer__zoom"
            >
              {percentFormatter.format(zoom)}
            </output>
            <button
              aria-label={t('markdown.mermaidZoomIn')}
              className="icon-button"
              disabled={zoom >= MAX_VIEWER_ZOOM}
              onClick={() => adjustZoom(VIEWER_ZOOM_STEP)}
              title={t('markdown.mermaidZoomIn')}
              type="button"
            >
              <ZoomIn aria-hidden="true" size={17} />
            </button>
            <button
              aria-label={t('markdown.mermaidResetZoom')}
              className="icon-button"
              disabled={zoom === 1}
              onClick={() => setZoom(1)}
              title={t('markdown.mermaidResetZoom')}
              type="button"
            >
              <RotateCcw aria-hidden="true" size={16} />
            </button>
            <button
              aria-label={t('markdown.mermaidCloseViewer')}
              className="icon-button"
              onClick={onClose}
              ref={closeRef}
              title={t('markdown.mermaidCloseViewer')}
              type="button"
            >
              <X aria-hidden="true" size={18} />
            </button>
          </div>
        </header>
        <div
          aria-label={t('markdown.mermaidViewerCanvas')}
          className={`mermaid-viewer__canvas${
            dragging ? ' mermaid-viewer__canvas--dragging' : ''
          }`}
          onPointerCancel={finishDragging}
          onPointerDown={(event) => {
            if (event.button !== 0) {
              return
            }
            event.preventDefault()
            dragRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              scrollLeft: event.currentTarget.scrollLeft,
              scrollTop: event.currentTarget.scrollTop
            }
            event.currentTarget.setPointerCapture(event.pointerId)
            setDragging(true)
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current
            if (drag?.pointerId !== event.pointerId) {
              return
            }
            event.preventDefault()
            event.currentTarget.scrollLeft =
              drag.scrollLeft - (event.clientX - drag.startX)
            event.currentTarget.scrollTop =
              drag.scrollTop - (event.clientY - drag.startY)
          }}
          onPointerUp={finishDragging}
          onWheel={(event) => {
            if (event.deltaY === 0) {
              return
            }
            event.preventDefault()
            queueWheelZoom(
              event.deltaY < 0
                ? VIEWER_ZOOM_STEP
                : -VIEWER_ZOOM_STEP
            )
          }}
          role="region"
          tabIndex={0}
        >
          <div
            className="mermaid-viewer__diagram"
            dangerouslySetInnerHTML={{ __html: svg }}
            style={{ zoom }}
          />
        </div>
      </section>
    </div>,
    document.body
  )
}

export function MermaidDiagram({
  source
}: MermaidDiagramProps): React.JSX.Element {
  const { t } = useTranslation('app')
  const idRef = useRef(
    `goodbuddy-mermaid-${++mermaidDiagramSequence}`
  )
  const renderRevisionRef = useRef(0)
  const sourceId = useId()
  const documentTheme = useDocumentTheme()
  const [renderState, setRenderState] =
    useState<MermaidRenderState>()
  const [visibleSource, setVisibleSource] = useState<string>()
  const [viewerSource, setViewerSource] = useState<string>()
  const sourceVisible = visibleSource === source
  const viewerOpen = viewerSource === source

  useEffect(() => {
    let active = true
    const renderRevision = renderRevisionRef.current++
    const timeout = window.setTimeout(() => {
      void renderMermaid(
        source.trim(),
        `${idRef.current}-${renderRevision}`,
        documentTheme === 'dark',
        () => active
      ).then(
        (svg) => {
          if (active) {
            setRenderState({
              source,
              status: 'ready',
              svg,
              theme: documentTheme
            })
          }
        },
        () => {
          if (active) {
            setRenderState({
              source,
              status: 'error',
              theme: documentTheme
            })
          }
        }
      )
    }, 120)

    return () => {
      active = false
      window.clearTimeout(timeout)
    }
  }, [documentTheme, source])

  const currentRenderState =
    renderState?.source === source &&
    renderState.theme === documentTheme
      ? renderState
      : undefined
  const retainedSvg =
    renderState?.status === 'ready' &&
    renderState.source === source
      ? renderState.svg
      : undefined
  const svg =
    currentRenderState?.status === 'ready'
      ? currentRenderState.svg
      : retainedSvg

  if (currentRenderState?.status === 'error') {
    return (
      <figure className="mermaid-diagram mermaid-diagram--error">
        <figcaption role="alert">
          {t('markdown.mermaidError')}
        </figcaption>
        <pre>
          <code className="language-mermaid">{source}</code>
        </pre>
      </figure>
    )
  }

  return (
    <figure
      aria-busy={!currentRenderState}
      className="mermaid-diagram"
    >
      {svg ? (
        <>
          <div
            aria-label={t('markdown.mermaidActions')}
            className="mermaid-diagram__actions"
            role="group"
          >
            <button
              aria-controls={sourceId}
              aria-expanded={sourceVisible}
              aria-label={t(
                sourceVisible
                  ? 'markdown.mermaidHideSource'
                  : 'markdown.mermaidViewSource'
              )}
              className={`icon-button${
                sourceVisible ? ' icon-button--active' : ''
              }`}
              onClick={() =>
                setVisibleSource(sourceVisible ? undefined : source)
              }
              title={t(
                sourceVisible
                  ? 'markdown.mermaidHideSource'
                  : 'markdown.mermaidViewSource'
              )}
              type="button"
            >
              <Code2 aria-hidden="true" size={17} />
            </button>
            <button
              aria-label={t('markdown.mermaidOpenViewer')}
              className="icon-button"
              onClick={() => setViewerSource(source)}
              title={t('markdown.mermaidOpenViewer')}
              type="button"
            >
              <Maximize2 aria-hidden="true" size={17} />
            </button>
          </div>
          {!viewerOpen && (
            <div
              aria-label={t('markdown.mermaidDiagram')}
              className="mermaid-diagram__viewport"
              dangerouslySetInnerHTML={{ __html: svg }}
              role="region"
              tabIndex={0}
            />
          )}
          {sourceVisible && (
            <pre className="mermaid-diagram__source" id={sourceId}>
              <code className="language-mermaid">{source}</code>
            </pre>
          )}
          {viewerOpen && (
            <MermaidViewer
              onClose={() => setViewerSource(undefined)}
              svg={svg}
            />
          )}
        </>
      ) : (
        <figcaption className="mermaid-diagram__loading" role="status">
          {t('markdown.mermaidLoading')}
        </figcaption>
      )}
    </figure>
  )
}
