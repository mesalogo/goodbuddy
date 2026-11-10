import Quill from 'quill'
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { ApplicationSettingsView } from '../../src/renderer/src/ApplicationCenter'
import type { ApplicationSettings } from '../../src/shared/application-settings-contracts'
import { MagicNotesWorkspace } from '../../src/renderer/src/MagicNotesWorkspace'
import type { MagicNoteCanvasContent } from '../../src/shared/magic-notes-contracts'
import i18n from '../../src/renderer/src/i18n'
import '../../src/renderer/src/styles.css'
import '../../src/renderer/src/magic-canvas.css'
import { liveNotesAnalysisRegression } from './magic-notes-analysis-live-regression'

async function notesAnalysisRegression() {
  await i18n.changeLanguage('en-US')
  if (new URLSearchParams(location.search).get('live') === '1') return liveNotesAnalysisRegression()
  const api = window.goodbuddy.magicNotes
  const initialSettings = await window.goodbuddy.updates.getSettings()
  if (initialSettings.magicNoteCanvasPageCount !== 1) throw new Error('Expected default page count 1')
  const inputMode = (await window.goodbuddy.settings.getRuntime()).supportsImageInput ? 'canvas-images' : 'text-fallback'
  const note = await api.create({ title: 'IPC canvas analysis' })
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
  const content: MagicNoteCanvasContent = { version: 2, kind: 'paged-canvas', assets: [{ id: 'pixel', name: 'pixel.png', mimeType: 'image/png', dataUrl: image }],
    pages: [1, 2, 3].map(index => ({ id: `page-${index}`, width: 794, height: 1123, background: { type: 'template', template: 'blank' }, objects: [] })),
    flow: { version: 1, ops: [{ insert: 'Review task' }, { insert: '\n', attributes: { list: 'unchecked' } },
      { insert: { canvasPageBreak: 'page-2' } }, { insert: 'Included second\n' },
      { insert: { canvasPageBreak: 'page-3' } }, { insert: 'Excluded third\n' }] } }
  content.pages[0]!.objects.push({ type: 'Image', canvasKind: 'image', assetId: 'pixel', left: 20, top: 20, width: 1, height: 1 })
  const seeded = await api.createEntry({ noteId: note.id, content })
  const entryId = seeded.createdEntryId
  const host = document.createElement('div')
  document.body.append(host)
  const errors: string[] = []
  const root = createRoot(host)
  function Probe() {
    const [settings, setSettings] = useState<ApplicationSettings>(initialSettings)
    return <><ApplicationSettingsView id="magic-notes" settings={settings} pending={false} onUpdate={async updates => {
      setSettings(await window.goodbuddy.updates.updateSettings(updates)); return true
    }} /><MagicNotesWorkspace applicationSettings={settings} onNotify={notification => { if (notification.tone === 'error') errors.push(notification.message) }} /></>
  }
  root.render(<Probe />)
  const wait = async (predicate: () => unknown | Promise<unknown>) => {
    for (let i = 0; i < 400; i++) {
      if (await predicate()) return
      if (errors.length) throw new Error(errors.join('\n'))
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error(`Timed out: ${predicate}`)
  }
  const button = (label: string, parent: ParentNode = document) => [...parent.querySelectorAll<HTMLButtonElement>('button')].find(node => (node.getAttribute('aria-label') ?? node.textContent?.trim()) === label)!
  const click = async (label: string, parent: ParentNode = document) => {
    await wait(() => button(label, parent) && !button(label, parent).disabled)
    button(label, parent).click()
  }
  const entry = async () => (await api.get(note.id)).entries.find(item => item.id === entryId)!
  await wait(() => host.querySelector('select[aria-describedby="magic-note-canvas-page-count-help"]'))
  const pageSelect = host.querySelector<HTMLSelectElement>('select[aria-describedby="magic-note-canvas-page-count-help"]')!
  pageSelect.value = '2'
  pageSelect.dispatchEvent(new Event('change', { bubbles: true }))
  await wait(async () => (await window.goodbuddy.updates.getSettings()).magicNoteCanvasPageCount === 2)
  await wait(() => host.querySelector('[id^="magic-note-select-"]'))
  host.querySelector<HTMLButtonElement>('[id^="magic-note-select-"]')!.click()
  const nextPage = () => host.querySelector<HTMLButtonElement>('.magic-note-entry .canvas-note-next-page')!
  await wait(() => nextPage() && !nextPage().disabled)
  nextPage().click()
  await wait(() => nextPage() && !nextPage().disabled)
  nextPage().click()
  await wait(() => nextPage()?.disabled)
  host.querySelector<HTMLButtonElement>('.magic-note-entry .canvas-note-zoom-out')!.click()
  await click('Analyze with AI')
  await wait(async () => (await entry()).comments[0]?.inputMode === inputMode)
  const manualRevision = (await entry()).revision
  await click('Expand canvas editor')
  const editor = () => document.querySelector<HTMLElement>('.magic-note-entry__editor')!
  await wait(() => editor()?.querySelector<HTMLButtonElement>('[data-tool="flow-text"]')?.disabled === false)
  const focus = document.querySelector<HTMLElement>('.magic-note-entry-focus')!
  const box = focus.getBoundingClientRect()
  const column = document.querySelector('.magic-notes-stream-container')!.getBoundingClientRect()
  if ((['x', 'y', 'width', 'height'] as const).some(key => Math.abs(box[key] - column[key]) > 1)) throw new Error('Canvas edit must fill only the record column')
  if (focus.hasAttribute('aria-modal') || host.inert) throw new Error('Editing must leave surrounding navigation usable')
  const canvasRoot = editor().querySelector<HTMLElement>('.canvas-note-root')!
  if (getComputedStyle(canvasRoot).borderWidth !== '0px') throw new Error('Canvas editor must have no outer border')
  editor().querySelector<HTMLButtonElement>('[data-tool="flow-text"]')!.click()
  await wait(() => editor().querySelector('.canvas-flow-quill'))
  const quill = Quill.find(editor().querySelector('.canvas-flow-quill')!) as Quill
  quill.insertText(0, 'Updated ', 'user')
  await click('Save changes')
  await wait(async () => (await entry()).revision >= manualRevision + 2)
  await wait(() => !document.querySelector('.magic-note-entry-focus'))
  if (host.inert) throw new Error('Saving must release background isolation')
  const editedRevision = (await entry()).revision
  await wait(() => host.querySelector('.magic-note-composer'))
  await click('Canvas', host.querySelector('.magic-note-composer')!)
  const composer = () => host.querySelector<HTMLElement>('.magic-note-composer')!
  await wait(() => composer().querySelector<HTMLButtonElement>('[data-tool="flow-text"]')?.disabled === false)
  const canvasBox = composer().getBoundingClientRect()
  const canvasColumn = document.querySelector('.magic-notes-stream-container')!.getBoundingClientRect()
  if ((['x', 'y', 'width', 'height'] as const).some(key => Math.abs(canvasBox[key] - canvasColumn[key]) > 1)) throw new Error('New canvas must fill the record column')
  const canvasHeader = composer().querySelector('.magic-note-composer__header')!.getBoundingClientRect()
  for (const selector of ['.magic-note-composer__title', '.magic-note-entry-type', '.magic-note-canvas-actions']) {
    const box = composer().querySelector(selector)!.getBoundingClientRect()
    if (Math.abs(box.y + box.height / 2 - canvasHeader.y - canvasHeader.height / 2) > 1) throw new Error('Canvas title, type and save actions must share one row')
  }
  composer().querySelector<HTMLButtonElement>('[data-tool="flow-text"]')!.click()
  await wait(() => composer().querySelector('.canvas-flow-quill'))
  ;(Quill.find(composer().querySelector('.canvas-flow-quill')!) as Quill).setContents(content.flow!.ops, 'user')
  await click('Analyze canvas draft', composer())
  await wait(() => button('Analyze canvas draft', composer())?.disabled === false)
  await click('Save entry', composer())
  await wait(async () => (await api.get(note.id)).entries.some(item => item.id !== entryId && item.comments[0]?.inputMode === inputMode))
  await wait(() => !composer().classList.contains('magic-note-composer--active'))
  const savedCanvas = (await entry()).content
  if (savedCanvas.version !== 2 || savedCanvas.assets[0]?.dataUrl !== image) throw new Error('Reused image changed during UI save')
  await click('Back to overview')
  await click('Switch to to-dos')
  await wait(() => host.querySelector<HTMLButtonElement>('.magic-todo-list-item__content'))
  host.querySelector<HTMLButtonElement>('.magic-todo-list-item__content')!.click()
  await click('Analyze with AI')
  await wait(async () => (await api.listTodos()).todos[0]?.comments[0]?.inputMode === inputMode)
  const todo = (await api.listTodos()).todos[0]!
  // Automatic CSS-column pagination must obey the same boundary without embeds.
  await click('Switch to notes')
  await wait(() => host.querySelector('[id^="magic-note-select-"]'))
  host.querySelector<HTMLButtonElement>('[id^="magic-note-select-"]')!.click()
  await wait(() => composer())
  await click('New entry', composer())
  await wait(() => composer().querySelector<HTMLButtonElement>('[data-tool="flow-text"]')?.disabled === false)
  composer().querySelector<HTMLButtonElement>('[data-tool="flow-text"]')!.click()
  const autoFlow = Quill.find(composer().querySelector('.canvas-flow-quill')!) as Quill
  autoFlow.setText('Automatic start\n' + 'Flow line\n'.repeat(180) + 'Automatic excluded tail\n', 'user')
  await click('Analyze canvas draft', composer())
  await wait(() => button('Analyze canvas draft', composer())?.disabled === false)
  // Exercise new text creation through the same production UI/IPC with automatic analysis disabled.
  root.render(<MagicNotesWorkspace navigation={{ noteId: note.id, requestId: 1 }}
    applicationSettings={{ ...initialSettings, magicNoteCommentMode: 'after-save-manual' }}
    onNotify={notification => { if (notification.tone === 'error') errors.push(notification.message) }} />)
  await wait(() => composer()?.querySelector<HTMLElement>('.magic-note-editor__content .ql-editor')?.isContentEditable)
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  const textEditor = composer().querySelector<HTMLElement>('.magic-note-editor__content .ql-editor')!
  textEditor.focus()
  await wait(() => composer().classList.contains('magic-note-entry-focus'))
  const textBox = composer().getBoundingClientRect()
  const textColumn = document.querySelector('.magic-notes-stream-container')!.getBoundingClientRect()
  if ((['x', 'y', 'width', 'height'] as const).some(key => Math.abs(textBox[key] - textColumn[key]) > 1)) throw new Error('New text must fill the record column')
  ;(Quill.find(textEditor.parentElement!) as Quill).setText('Focused new text record\n', 'user')
  await click('Save entry', composer())
  await wait(async () => (await api.get(note.id)).entries.some(item => item.plainText.includes('Focused new text record')))
  await wait(() => !composer().classList.contains('magic-note-composer--active'))
  const result = { errors, manualRevision, editedRevision, createdAnalyzed: true, textCreated: true, todoAnalyzed: todo.comments[0]?.inputMode }
  root.unmount()
  host.remove()
  return result
}

Object.assign(window, { notesAnalysisRegression })
