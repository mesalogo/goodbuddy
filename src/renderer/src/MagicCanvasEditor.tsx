import { forwardRef, useEffect, useImperativeHandle, useRef, useLayoutEffect } from 'react'
import { mountCanvasNote, type CanvasController } from './magic-canvas/canvas-note.mjs'
import { createEmptyCanvasContent, fromCoreContent, toCoreContent, type MagicNoteCanvasContent } from './magic-canvas/model'
import { readFileAsDataUrl } from './file-data-url'
import 'quill/dist/quill.snow.css'
import './magic-canvas.css'

export { createEmptyCanvasContent, canvasHasContent } from './magic-canvas/model'
export type { MagicNoteCanvasContent } from './magic-canvas/model'

export type MagicCanvasEditorHandle = {
  flush(): Promise<MagicNoteCanvasContent>
  focus(): void
  capturePages(pageLimit?: number, includeImages?: boolean): Promise<{ pageId: string; dataUrl: string; text?: string }[]>
}

export type MagicCanvasEditorProps = {
  initialContent?: MagicNoteCanvasContent
  onChange(content: MagicNoteCanvasContent): void
  onReady?(content: MagicNoteCanvasContent): void
  onError(message: string): void
  disabled?: boolean
}

export const MagicCanvasEditor = forwardRef<MagicCanvasEditorHandle, MagicCanvasEditorProps>(function MagicCanvasEditor({ initialContent, onChange, onReady, onError, disabled = false }, ref) {
  const host = useRef<HTMLDivElement>(null)
  const controller = useRef<CanvasController | null>(null)
  const initial = useRef(initialContent)
  const disabledRef = useRef(disabled)
  const ready = useRef<Promise<void>>(Promise.resolve())
  const initialized = useRef(false)
  const saved = useRef<MagicNoteCanvasContent | null>(null)
  const serialize = useRef<((core: ReturnType<CanvasController['content']>) => MagicNoteCanvasContent) | null>(null)
  const callbacks = useRef({ onChange, onReady, onError })
  useLayoutEffect(() => { callbacks.current = { onChange, onReady, onError }; disabledRef.current = disabled }, [onChange, onReady, onError, disabled])

  useImperativeHandle(ref, () => ({
    async flush() {
      await ready.current
      if (!controller.current || !serialize.current) throw new Error('画布尚未加载')
      return serialize.current(await controller.current.flush())
    },
    focus() { controller.current?.focus() },
    async capturePages(pageLimit, includeImages) {
      if (!controller.current) throw new Error('画布尚未加载')
      return controller.current.capturePages({ pageLimit, includeImages })
    }
  }), [])

  useEffect(() => {
    if (!host.current) return
    const abort = new AbortController()
    const content = saved.current ?? initial.current ?? createEmptyCanvasContent()
    const assets = structuredClone(content.assets)
    const pdfText = content.pages.flatMap((page) => page.background.type === 'pdf' && page.background.text !== undefined
      ? [{ assetId: page.background.assetId, pageNumber: page.background.pageNumber, text: page.background.text }] : [])
    const convert = (core: ReturnType<CanvasController['content']>) => fromCoreContent(core, assets, pdfText)
    serialize.current = convert
    const pickPdf = () => new Promise<{ assetId: string; name: string } | null>((resolve, reject) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'application/pdf,.pdf'
      input.hidden = true
      host.current?.append(input)
      const finish = (result: { assetId: string; name: string } | null) => { input.remove(); resolve(result) }
      abort.signal.addEventListener('abort', () => finish(null), { once: true })
      input.addEventListener('cancel', () => finish(null), { once: true })
      input.addEventListener('change', () => {
        const file = input.files?.[0]
        if (!file) { finish(null); return }
        void (async () => {
          if (file.size > 32 * 1024 * 1024) throw new Error('PDF 文件不能超过 32 MB')
          const dataUrl = await readFileAsDataUrl(file, 'application/pdf', abort.signal)
          if (abort.signal.aborted) { finish(null); return }
          let asset = assets.find((candidate) => candidate.dataUrl === dataUrl)
          if (!asset) {
            asset = { id: crypto.randomUUID(), name: file.name, mimeType: 'application/pdf', dataUrl }
            assets.push(asset)
          }
          finish({ assetId: asset.id, name: file.name })
        })().catch((error: unknown) => { input.remove(); reject(error) })
      }, { once: true })
      input.click()
    })
    let instance: CanvasController
    try {
      instance = mountCanvasNote(host.current, toCoreContent(content), {
        disabled: true,
        signal: abort.signal,
        onChange(core) {
          if (abort.signal.aborted || !initialized.current) return
          const next = convert(core)
          saved.current = next
          callbacks.current.onChange(next)
        },
        onError: (message) => { if (!abort.signal.aborted) callbacks.current.onError(message) },
        pickPdf,
        async readPdf({ assetId }) {
          const asset = assets.find((candidate) => candidate.id === assetId)
          if (!asset) throw new Error('PDF 底版资源不可用')
          const binary = atob(asset.dataUrl.slice(asset.dataUrl.indexOf(',') + 1))
          return Uint8Array.from(binary, (character) => character.charCodeAt(0))
        },
        onPdfText(assetId, pageNumber, text) {
          const previous = pdfText.find((item) => item.assetId === assetId && item.pageNumber === pageNumber)
          if (previous) previous.text = text
          else pdfText.push({ assetId, pageNumber, text })
        },
        async savePdf(bytes, name) {
          if (abort.signal.aborted) return
          const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }))
          const link = document.createElement('a')
          link.href = url
          link.download = name
          link.click()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
        }
      })
      controller.current = instance
      ready.current = instance.flush().then((core) => {
        if (abort.signal.aborted) return
        const normalized = convert(core)
        saved.current = normalized
        callbacks.current.onReady?.(normalized)
        initialized.current = true
        instance.setDisabled(disabledRef.current)
      })
      void ready.current.catch((error: unknown) => {
        if (!abort.signal.aborted) callbacks.current.onError(error instanceof Error ? error.message : '画布加载失败')
      })
    } catch (error) {
      callbacks.current.onError(error instanceof Error ? error.message : '画布加载失败')
      return () => abort.abort()
    }
    return () => {
      abort.abort()
      initialized.current = false
      saved.current = convert(instance.content())
      controller.current = null
      void instance.destroy()
    }
  }, [])

  useEffect(() => { if (initialized.current) controller.current?.setDisabled(disabled) }, [disabled])

  return <div className="magic-canvas-editor" ref={host} aria-label="分页画布编辑器" />
})
