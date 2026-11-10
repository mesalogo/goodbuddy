import { mountCanvasNote } from './canvas-note.mjs'
import { toCoreContent, type MagicNoteCanvasContent } from './model'

/** Capture the committed version independently of the editor's next draft. */
export async function captureSavedPages(content: MagicNoteCanvasContent, pageLimit: number | undefined, includeImages: boolean | undefined, signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
  const surface = document.createElement('div')
  surface.className = 'magic-note-thumbnail-renderer magic-canvas-editor'
  surface.setAttribute('aria-hidden', 'true')
  surface.inert = true
  document.body.append(surface)
  let controller: ReturnType<typeof mountCanvasNote> | undefined
  const cancel = (): void => { void controller?.destroy().catch(() => {}) }
  try {
    controller = mountCanvasNote(surface, toCoreContent(content), {
      disabled: true, signal,
      async readPdf({ assetId }) {
        const asset = content.assets.find(item => item.id === assetId)
        if (!asset) throw new Error('PDF 底版资源不可用')
        return Uint8Array.from(atob(asset.dataUrl.slice(asset.dataUrl.indexOf(',') + 1)), character => character.charCodeAt(0))
      }
    })
    signal.addEventListener('abort', cancel, { once: true })
    return await controller.capturePages({ pageLimit, includeImages })
  } finally {
    signal.removeEventListener('abort', cancel)
    try { await controller?.destroy() } finally { surface.remove() }
  }
}
