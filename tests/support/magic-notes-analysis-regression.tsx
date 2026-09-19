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

async function notesAnalysisRegression() {
  await i18n.changeLanguage('en-US')
  const api = window.goodbuddy.magicNotes
  const initialSettings = await window.goodbuddy.updates.getSettings()
  if (initialSettings.magicNoteCanvasPageCount !== 1) throw new Error('Expected default page count 1')
  const inputMode = (await window.goodbuddy.settings.getRuntime()).supportsImageInput ? 'canvas-images' : 'text-fallback'
  const note = await api.create({ title: 'IPC canvas analysis' })
  const content: MagicNoteCanvasContent = { version: 2, kind: 'paged-canvas', assets: [],
    pages: [1, 2, 3].map(index => ({ id: `page-${index}`, width: 794, height: 1123, background: { type: 'template', template: 'blank' }, objects: [] })),
    flow: { version: 1, ops: [{ insert: 'Review task' }, { insert: '\n', attributes: { list: 'unchecked' } },
      { insert: { canvasPageBreak: 'page-2' } }, { insert: 'Included second\n' },
      { insert: { canvasPageBreak: 'page-3' } }, { insert: 'Excluded third\n' }] } }
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
  const button = (label: string, parent: ParentNode = host) => [...parent.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)!
  const click = async (label: string, parent: ParentNode = host) => {
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
  const editor = () => host.querySelector<HTMLElement>('.magic-note-entry__editor')!
  await wait(() => editor()?.querySelector<HTMLButtonElement>('[data-tool="flow-text"]')?.disabled === false)
  editor().querySelector<HTMLButtonElement>('[data-tool="flow-text"]')!.click()
  await wait(() => editor().querySelector('.canvas-flow-quill'))
  const quill = Quill.find(editor().querySelector('.canvas-flow-quill')!) as Quill
  quill.insertText(0, 'Updated ', 'user')
  await click('Save changes')
  await wait(async () => (await entry()).revision >= manualRevision + 2)
  const editedRevision = (await entry()).revision
  await click('Cancel')
  await wait(() => host.querySelector('.magic-note-composer'))
  await click('Canvas', host.querySelector('.magic-note-composer')!)
  const composer = () => host.querySelector<HTMLElement>('.magic-note-composer')!
  await wait(() => composer().querySelector<HTMLButtonElement>('[data-tool="flow-text"]')?.disabled === false)
  composer().querySelector<HTMLButtonElement>('[data-tool="flow-text"]')!.click()
  await wait(() => composer().querySelector('.canvas-flow-quill'))
  ;(Quill.find(composer().querySelector('.canvas-flow-quill')!) as Quill).setContents(content.flow!.ops, 'user')
  await click('Analyze canvas draft', composer())
  await wait(() => button('Analyze canvas draft', composer())?.disabled === false)
  await click('Save entry', composer())
  await wait(async () => (await api.get(note.id)).entries.some(item => item.id !== entryId && item.comments[0]?.inputMode === inputMode))
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
  await wait(() => composer().querySelector<HTMLButtonElement>('[data-tool="flow-text"]')?.disabled === false)
  composer().querySelector<HTMLButtonElement>('[data-tool="flow-text"]')!.click()
  const autoFlow = Quill.find(composer().querySelector('.canvas-flow-quill')!) as Quill
  autoFlow.setText('Automatic start\n' + 'Flow line\n'.repeat(180) + 'Automatic excluded tail\n', 'user')
  await click('Analyze canvas draft', composer())
  await wait(() => button('Analyze canvas draft', composer())?.disabled === false)
  const result = { errors, manualRevision, editedRevision, createdAnalyzed: true, todoAnalyzed: todo.comments[0]?.inputMode }
  root.unmount()
  host.remove()
  return result
}

Object.assign(window, { notesAnalysisRegression })
