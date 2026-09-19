import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { mountCanvasNote } from './magic-canvas/canvas-note.mjs'
import { toCoreContent, type MagicNoteCanvasContent } from './magic-canvas/model'

// Serialize temporary renderers so a long record list never mounts many Fabric editors.
let renders = Promise.resolve()
const images = new WeakMap<MagicNoteCanvasContent, string>()

export function MagicCanvasThumbnail({ content }: { content: MagicNoteCanvasContent }): React.JSX.Element {
  const { t } = useTranslation('magicNotes')
  const host = useRef<HTMLSpanElement>(null)
  const [result, setResult] = useState<{ content: MagicNoteCanvasContent; url?: string; failed?: boolean }>()
  useEffect(() => {
    const abort = new AbortController()
    const render = (): void => {
      renders = renders.then(async () => {
        if (abort.signal.aborted) return
        const cached = images.get(content)
        if (cached) { setResult({ content, url: cached }); return }
        const surface = document.createElement('div')
        surface.className = 'magic-note-thumbnail-renderer'
        surface.setAttribute('aria-hidden', 'true')
        surface.inert = true
        document.body.append(surface)
        let controller: ReturnType<typeof mountCanvasNote> | undefined
        let destruction: Promise<void> | undefined
        const destroy = (): Promise<void> => destruction ??= controller?.destroy() ?? Promise.resolve()
        const cancel = (): void => { void destroy().catch(() => {}) }
        try {
          controller = mountCanvasNote(surface, toCoreContent(content), {
            disabled: true, signal: abort.signal,
            async readPdf({ assetId }) {
              const asset = content.assets.find((item) => item.id === assetId)
              if (!asset) throw new Error('Missing PDF asset')
              const binary = atob(asset.dataUrl.slice(asset.dataUrl.indexOf(',') + 1))
              return Uint8Array.from(binary, (character) => character.charCodeAt(0))
            }
          })
          abort.signal.addEventListener('abort', cancel, { once: true })
          const [image] = await controller.capturePages({ firstPageOnly: true, thumbnailWidth: 240 })
          if (image && !abort.signal.aborted) {
            images.set(content, image.dataUrl)
            setResult({ content, url: image.dataUrl })
          }
        } catch {
          if (!abort.signal.aborted) setResult({ content, failed: true })
        } finally {
          abort.signal.removeEventListener('abort', cancel)
          try { await destroy() }
          finally { surface.remove() }
        }
      }).catch(() => {})
    }
    const observer = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { observer?.disconnect(); render() }
    }) : undefined
    if (observer && host.current) observer.observe(host.current)
    else render()
    return () => { observer?.disconnect(); abort.abort() }
  }, [content])
  const current = result?.content === content ? result : undefined
  return <span ref={host} className="magic-note-record__image">
    {current?.url ? <img src={current.url} alt={t('records.firstPage')} /> : <span>{t(current?.failed ? 'records.previewFailed' : 'status.loading')}</span>}
  </span>
}
