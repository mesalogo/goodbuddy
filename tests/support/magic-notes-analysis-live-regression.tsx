import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { ApplicationSettingsView } from '../../src/renderer/src/ApplicationCenter'
import { MagicNotesWorkspace } from '../../src/renderer/src/MagicNotesWorkspace'
import type { MagicNoteCanvasContent } from '../../src/shared/magic-notes-contracts'

export async function liveNotesAnalysisRegression() {
  const api = window.goodbuddy.magicNotes
  const initialSettings = await window.goodbuddy.updates.getSettings()
  if (initialSettings.magicNoteCanvasPageCount !== 1) throw new Error('Expected default 1 page')
  const markers = ['KITE-41', 'FERN-72', 'MOON-36', 'WAVE-85', 'PINE-29', 'STAR-63', 'LIME-57', 'BIRD-94', 'WOLF-18']
  const content: MagicNoteCanvasContent = { version: 2, kind: 'paged-canvas', pages: [], assets: [] }
  for (const [index, marker] of markers.entries()) {
    const canvas = document.createElement('canvas')
    canvas.width = 700
    canvas.height = 700
    const context = canvas.getContext('2d')!
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, 700, 700)
    context.fillStyle = '#172554'
    context.font = 'bold 64px sans-serif'
    context.fillText(`PAGE ${index + 1}`, 70, 180)
    context.fillText(marker, 70, 310)
    context.font = '32px sans-serif'
    context.fillText('Visual inventory card', 70, 410)
    content.assets.push({ id: `asset-${index + 1}`, name: `card-${index + 1}.png`, mimeType: 'image/png', dataUrl: canvas.toDataURL('image/png') })
    content.pages.push({ id: `page-${index + 1}`, width: 794, height: 1123,
      background: { type: 'template', template: 'blank' },
      objects: [{ type: 'Image', canvasKind: 'image', assetId: `asset-${index + 1}`, originX: 'left', originY: 'top', left: 40, top: 40, width: 700, height: 700 }] })
  }
  const note = await api.create({ title: 'Isolated visual inventory' })
  const created = await api.createEntry({ noteId: note.id, content })
  const entry = async () => (await api.get(note.id)).entries.find(item => item.id === created.createdEntryId)!
  const host = document.createElement('div')
  document.body.append(host)
  const errors: string[] = []
  function Probe() {
    const [settings, setSettings] = useState(initialSettings)
    return <><ApplicationSettingsView id="magic-notes" settings={settings} pending={false} onUpdate={async updates => {
      setSettings(await window.goodbuddy.updates.updateSettings(updates)); return true
    }} /><MagicNotesWorkspace applicationSettings={settings} onNotify={notification => {
      if (notification.tone === 'error') errors.push(notification.message)
    }} /></>
  }
  createRoot(host).render(<Probe />)
  const wait = async (predicate: () => unknown | Promise<unknown>) => {
    for (let i = 0; i < 4000; i++) {
      if (errors.length) throw new Error(errors.join('\n'))
      if (await predicate()) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('Live UI wait timed out')
  }
  await wait(() => host.querySelector('[id^="magic-note-select-"]'))
  host.querySelector<HTMLButtonElement>('[id^="magic-note-select-"]')!.click()
  const runs = []
  const pageCounts = new URLSearchParams(location.search).get('pages') === '8' ? [8] : [1, 8]
  for (const pageCount of pageCounts) {
    if (pageCount === 8) {
      const select = host.querySelector<HTMLSelectElement>('select[aria-describedby="magic-note-canvas-page-count-help"]')!
      select.value = '8'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await wait(async () => (await window.goodbuddy.updates.getSettings()).magicNoteCanvasPageCount === 8)
    }
    const revision = (await entry()).revision
    const button = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => ['Analyze with AI', 'Analyze again'].includes(node.textContent?.trim() ?? ''))
    await wait(() => button() && !button()!.disabled)
    button()!.click()
    await wait(async () => (await entry()).revision > revision && (await entry()).comments.length)
    runs.push({ pageCount, comments: (await entry()).comments })
  }
  return { errors, markers, runs, fixturePageCount: content.pages.length }
}
