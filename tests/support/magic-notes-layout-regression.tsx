import { createRoot } from 'react-dom/client'
import { MagicNotesWorkspace } from '../../src/renderer/src/MagicNotesWorkspace'
import type { DesktopApi } from '../../src/shared/contracts'
import i18n from '../../src/renderer/src/i18n'
import '../../src/renderer/src/styles.css'
import '../../src/renderer/src/magic-canvas.css'

await i18n.changeLanguage('en-US')
const note = {
  id: 'layout-note', title: 'Layout note', preview: 'Record preview', entryCount: 1,
  pinned: false, revision: 1, createdAt: '2026-09-19T00:00:00Z', updatedAt: '2026-09-19T00:00:00Z',
  entries: [{ id: 'layout-entry', noteId: 'layout-note', revision: 1,
    createdAt: '2026-09-19T00:00:00Z', updatedAt: '2026-09-19T00:00:00Z',
    content: { version: 1, ops: [{ insert: 'Record preview\n' }] }, plainText: 'Record preview', comments: [] }]
}
window.goodbuddy = {
  magicNotes: {
    list: async () => ({ notes: [note] }), get: async () => note, listTodos: async () => ({ todos: [{
      id: 'layout-todo', noteId: note.id, noteTitle: note.title, entryId: 'layout-entry',
      title: 'Layout task', instructions: 'Task details', completed: false, revision: 1,
      comments: [], createdAt: note.createdAt, updatedAt: note.updatedAt
    }] }),
    onChanged: () => () => {}, onAnalysisEvent: () => () => {}
  },
  updates: { getSettings: async () => ({ magicNoteCommentMode: 'after-save-manual', magicNoteCommentFormat: 'combined' }) }
} as unknown as DesktopApi
const host = document.createElement('div')
host.style.height = '100vh'
document.body.append(host)
createRoot(host).render(<MagicNotesWorkspace onNotify={() => {}} />)
