import Quill from 'quill'
import { createRoot } from 'react-dom/client'
import { mountCanvasNote } from '../../src/renderer/src/magic-canvas/canvas-note.mjs'
import { MagicCanvasThumbnail } from '../../src/renderer/src/MagicCanvasThumbnail'
import { fromCoreContent } from '../../src/renderer/src/magic-canvas/model'
import '../../src/renderer/src/i18n'
import 'quill/dist/quill.snow.css'
import '../../src/renderer/src/styles.css'
import '../../src/renderer/src/magic-canvas.css'

async function canvasRegression() {
  const errors: string[] = []
  const host = document.createElement('div')
  host.className = 'magic-canvas-editor'
  document.body.append(host)
  let editor = mountCanvasNote(host, { version: 2, pages: [{
    id: 'first', width: 794, height: 1123,
    background: { type: 'template', template: 'blank' },
    objects: [{ type: 'Path', canvasKind: 'pen', path: [['M', 20, 20], ['L', 150, 80]],
      stroke: '#ff0000', strokeWidth: 4, fill: null }]
  }], flow: { version: 1, ops: [{ insert: 'Flow line\n'.repeat(50) }] } }, { onError: (error) => errors.push(error) })
  const initial = await editor.flush()
  const ink = async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const canvas = host.querySelector<HTMLCanvasElement>('.lower-canvas')!
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    let count = 0
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) count++
    return count
  }
  const visibleInkBefore = await ink()
  host.querySelector<HTMLButtonElement>('[data-tool="flow-text"]')!.click()
  host.querySelector<HTMLButtonElement>('.canvas-note-next-page')!.click()
  await editor.flush()
  const beforeShrink = host.querySelector('.canvas-note-page-counter')!.textContent
  const quill = Quill.find(host.querySelector('.canvas-flow-quill')!) as Quill
  quill.setText('Short flow\n', 'user')
  const saved = JSON.parse(JSON.stringify(await editor.flush()))
  const afterShrink = host.querySelector('.canvas-note-page-counter')!.textContent
  const visibleInkAfter = await ink()
  const flowTransform = host.querySelector<HTMLElement>('.canvas-flow-surface')!.style.transform
  await editor.destroy()
  editor = mountCanvasNote(host, saved, { onError: (error) => errors.push(error) })
  const reopened = await editor.flush()
  const reopenedInk = await ink()
  const styles = (surface: Element) => {
    const style = getComputedStyle(surface)
    return { fontSize: style.fontSize, lineHeight: style.lineHeight, columnFill: style.columnFill, padding: style.padding }
  }
  const editorStyles = styles(host.querySelector('.canvas-flow-surface')!)
  const [expectedThumbnail] = await editor.capturePages({ firstPageOnly: true, thumbnailWidth: 240 })
  await editor.destroy()
  const thumbnailHost = document.createElement('div')
  document.body.append(thumbnailHost)
  let thumbnailStyles: ReturnType<typeof styles> | undefined
  const observer = new MutationObserver(() => {
    const surface = document.querySelector('.magic-note-thumbnail-renderer .canvas-flow-surface')
    if (surface) thumbnailStyles = styles(surface)
  })
  observer.observe(document.body, { childList: true, subtree: true })
  const root = createRoot(thumbnailHost)
  root.render(<MagicCanvasThumbnail content={fromCoreContent(saved, [])} />)
  for (let i = 0; i < 400 && !thumbnailHost.querySelector('img'); i++) await new Promise(resolve => setTimeout(resolve, 25))
  const thumbnailMatchesEditor = thumbnailHost.querySelector('img')?.src === expectedThumbnail.dataUrl
  root.unmount()
  observer.disconnect()
  thumbnailHost.remove()
  host.remove()
  return { errors, initialPages: initial.pages.length, initialObjects: initial.pages[0].objects,
    beforeShrink, afterShrink, savedPages: saved.pages.length, savedObjects: saved.pages[0].objects,
    reopenedObjects: reopened.pages[0].objects, visibleInkBefore, visibleInkAfter, reopenedInk, flowTransform,
    editorStyles, thumbnailStyles, thumbnailMatchesEditor }
}

Object.assign(window, { canvasRegression })
