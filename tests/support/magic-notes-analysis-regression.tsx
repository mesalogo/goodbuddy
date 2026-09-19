import Quill from 'quill'
import { createRoot } from 'react-dom/client'
import { MagicNotesWorkspace } from '../../src/renderer/src/MagicNotesWorkspace'
import type { MagicNoteCanvasContent } from '../../src/shared/magic-notes-contracts'
import i18n from '../../src/renderer/src/i18n'
import '../../src/renderer/src/styles.css'
import '../../src/renderer/src/magic-canvas.css'

async function notesAnalysisRegression() {
  await i18n.changeLanguage('en-US')
  const api = window.goodbuddy.magicNotes
  const note = await api.create({ title: 'IPC canvas analysis' })
  const content: MagicNoteCanvasContent = { version: 2, kind: 'paged-canvas', assets: [],
    pages: [{ id: 'page-1', width: 794, height: 1123, background: { type: 'template', template: 'blank' }, objects: [] }],
    flow: { version: 1, ops: [{ insert: 'Review task' }, { insert: '\n', attributes: { list: 'unchecked' } }] } }
  const seeded = await api.createEntry({ noteId: note.id, content })
  const entryId = seeded.createdEntryId
  const host = document.createElement('div')
  document.body.append(host)
  const errors: string[] = []
  const root = createRoot(host)
  root.render(<MagicNotesWorkspace onNotify={notification => { if (notification.tone === 'error') errors.push(notification.message) }} />)
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
  await wait(() => host.querySelector('[id^="magic-note-select-"]'))
  host.querySelector<HTMLButtonElement>('[id^="magic-note-select-"]')!.click()
  await click('Analyze with AI')
  await wait(async () => (await entry()).comments[0]?.inputMode === 'canvas-images')
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
  ;(Quill.find(composer().querySelector('.canvas-flow-quill')!) as Quill).setText('Created canvas\n', 'user')
  await click('Save entry', composer())
  await wait(async () => (await api.get(note.id)).entries.some(item => item.id !== entryId && item.comments[0]?.inputMode === 'canvas-images'))
  await click('Back to overview')
  await click('Switch to to-dos')
  await wait(() => host.querySelector<HTMLButtonElement>('.magic-todo-list-item__content'))
  host.querySelector<HTMLButtonElement>('.magic-todo-list-item__content')!.click()
  await click('Analyze with AI')
  await wait(async () => (await api.listTodos()).todos[0]?.comments[0]?.inputMode === 'canvas-images')
  const todo = (await api.listTodos()).todos[0]!
  const result = { errors, manualRevision, editedRevision, createdAnalyzed: true, todoAnalyzed: todo.comments[0]?.inputMode }
  root.unmount()
  host.remove()
  return result
}

Object.assign(window, { notesAnalysisRegression })
