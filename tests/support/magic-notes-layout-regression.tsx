import { createRoot } from 'react-dom/client'
import { MagicNotesWorkspace } from '../../src/renderer/src/MagicNotesWorkspace'
import type { DesktopApi } from '../../src/shared/contracts'
import i18n from '../../src/renderer/src/i18n'
import '../../src/renderer/src/styles.css'
import '../../src/renderer/src/magic-canvas.css'

await i18n.changeLanguage('en-US')
const note = {
  id: 'layout-note', title: 'Layout note', preview: 'Record preview', entryCount: 1,
  pinned: false, tags: ['Work', 'Release planning', 'Q4', 'Long tag name here'], revision: 1, createdAt: '2026-09-19T00:00:00Z', updatedAt: '2026-09-19T00:00:00Z',
  entries: [{ id: 'layout-entry', noteId: 'layout-note', revision: 1,
    createdAt: '2026-09-19T00:00:00Z', updatedAt: '2026-09-19T00:00:00Z',
    content: { version: 1, ops: [{ insert: 'Record preview\n'.repeat(60) }] }, plainText: 'Record preview', comments: [] }]
}
const notes = [note, ...Array.from({ length: 24 }, (_, index) => ({
  ...note, id: `other-note-${index}`, title: `Other note ${index}`, tags: index % 3 === 0 ? ['Work'] : [],
  entries: note.entries.map(entry => ({ ...entry, id: `other-entry-${index}`, noteId: `other-note-${index}` }))
}))]
const tags = [
  { id: 'tag-work', name: 'Work', noteCount: 9 },
  { id: 'tag-release', name: 'Release planning', noteCount: 1 },
  { id: 'tag-q4', name: 'Q4', noteCount: 1 },
  { id: 'tag-long', name: 'Long tag name here', noteCount: 1 }
]
window.goodbuddy = {
  magicNotes: {
    list: async () => ({ notes, tags }), get: async (id: string) => notes.find(note => note.id === id), listTodos: async () => ({ todos: [{
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
