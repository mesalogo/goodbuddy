import Quill from 'quill'
import { createRoot } from 'react-dom/client'
import { MagicNotesWorkspace } from '../../src/renderer/src/MagicNotesWorkspace'
import type { DesktopApi } from '../../src/shared/contracts'
import type { MagicNoteDetail } from '../../src/shared/magic-notes-contracts'
import { magicNoteAnalyzeSchema } from '../../src/shared/magic-notes-contracts'
import i18n from '../../src/renderer/src/i18n'
import 'quill/dist/quill.snow.css'
import '../../src/renderer/src/styles.css'
import '../../src/renderer/src/magic-canvas.css'

async function notesNavigationRegression() {
  await i18n.changeLanguage('en-US')
  const note: MagicNoteDetail = {
    id: '00000000-0000-4000-8000-000000000601', title: 'Navigation note', preview: '',
    entryCount: 1, pinned: false, revision: 1, createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z', entries: [{
      id: '00000000-0000-4000-8000-000000000602', noteId: '00000000-0000-4000-8000-000000000601',
      content: { version: 1, ops: [{ insert: 'Saved entry\n' }] }, plainText: 'Saved entry',
      comments: [], revision: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    }],
  }
  let finishAnalysis!: (detail: MagicNoteDetail) => void
  let requestLeave: ((leave: () => void) => void) | undefined
  let leaves = 0
  const errors: string[] = []
  window.goodbuddy = {
    magicNotes: {
      list: async () => ({ notes: [note] }), get: async () => note,
      listTodos: async () => ({ todos: [] }),
      analyze: (...[entryId, options]: Parameters<DesktopApi['magicNotes']['analyze']>) => {
        magicNoteAnalyzeSchema.parse({ entryId, ...options })
        return new Promise(resolve => { finishAnalysis = resolve })
      },
      onChanged: () => () => {}, onAnalysisEvent: () => () => {},
    },
    updates: { getSettings: async () => ({ magicNoteCommentMode: 'after-save-manual', magicNoteCommentFormat: 'combined' }) },
  } as unknown as DesktopApi
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  root.render(<MagicNotesWorkspace onBeforeLeave={requester => { requestLeave = requester }} onNotify={message => {
    if (message.tone === 'error') errors.push(message.message)
  }} />)
  const wait = async (predicate: () => unknown) => {
    for (let i = 0; i < 400; i++) {
      if (predicate()) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('Timed out waiting for notes UI')
  }
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text)!
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  await wait(() => host.querySelector('[id^="magic-note-select-"]'))
  host.querySelector<HTMLButtonElement>('[id^="magic-note-select-"]')!.click()
  await wait(() => button('Analyze with AI'))
  button('Analyze with AI').click()
  await wait(() => finishAnalysis)
  const title = host.querySelector<HTMLInputElement>('.magic-note-detail-header input')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, 'Title during AI')
  title.dispatchEvent(new Event('input', { bubbles: true }))
  await frame()
  finishAnalysis({ ...note, revision: 2 })
  await frame()
  const titlePreserved = title.value === 'Title during AI'
  requestLeave!(() => { leaves++ })
  await wait(() => host.querySelector('[role="alertdialog"]'))
  button('Continue editing').click()
  await frame()
  const continuedTitle = title.value
  // Restore the title without saving, then exercise the actual canvas flush path.
  title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await frame()
  button('Canvas').click()
  await wait(() => host.querySelector<HTMLButtonElement>('[data-tool="flow-text"]')?.disabled === false)
  host.querySelector<HTMLButtonElement>('[data-tool="flow-text"]')!.click()
  await wait(() => host.querySelector('.canvas-flow-quill'))
  await frame()
  const quill = Quill.find(host.querySelector('.canvas-flow-quill')!) as Quill
  quill.setText('Pending canvas flow\n', 'user')
  requestLeave!(() => { leaves++ })
  await wait(() => host.querySelector('[role="alertdialog"]'))
  const canvasGuarded = leaves === 0
  button('Continue editing').click()
  await frame()
  const canvasPreserved = quill.getText().includes('Pending canvas flow')
  requestLeave!(() => { leaves++ })
  await wait(() => host.querySelector('[role="alertdialog"]'))
  button('Discard and switch').click()
  await frame()
  root.unmount()
  host.remove()
  return { errors, titlePreserved, continuedTitle, canvasGuarded, canvasPreserved, leaves }
}

Object.assign(window, { notesNavigationRegression })
