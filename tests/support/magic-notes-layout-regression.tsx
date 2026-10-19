import { createRoot } from 'react-dom/client'
import { MagicNotesWorkspace } from '../../src/renderer/src/MagicNotesWorkspace'
import { PageShell } from '../../src/renderer/src/WorkspacePrimitives'
import { ApplicationAvailability } from '../../src/renderer/src/ApplicationCenter'
import { KeepAliveRoute } from '../../src/renderer/src/KeepAliveRoute'
import type { DesktopApi } from '../../src/shared/contracts'
import type { MagicNoteComment } from '../../src/shared/magic-notes-contracts'
import i18n from '../../src/renderer/src/i18n'
import '../../src/renderer/src/styles.css'
import '../../src/renderer/src/magic-canvas.css'

await i18n.changeLanguage('en-US')
const note = {
  id: 'layout-note', title: 'Layout note', preview: 'Record preview', entryCount: 1,
  pinned: false, tags: ['Work', 'Release planning', 'Q4', 'Long tag name here'], revision: 1, createdAt: '2026-09-19T00:00:00Z', updatedAt: '2026-09-19T00:00:00Z',
  entries: [{ id: 'layout-entry', noteId: 'layout-note', revision: 1,
    createdAt: '2026-09-19T00:00:00Z', updatedAt: '2026-09-19T00:00:00Z',
    content: { version: 1, ops: [{ insert: 'Record preview\n'.repeat(60) }] }, plainText: 'Record preview', comments: [] as MagicNoteComment[] }]
}
const notes = [note, ...Array.from({ length: 24 }, (_, index) => ({
  ...note, id: `other-note-${index}`, title: `Other note ${index}`, tags: index % 3 === 0 ? ['Work'] : [],
  entries: note.entries.map(entry => ({ ...entry, id: `other-entry-${index}`, noteId: `other-note-${index}`,
    content: { version: 1, ops: [{ insert: 'Short record\n' }] } }))
}))]
const tags = [
  { id: 'tag-work', name: 'Work', noteCount: 9 },
  { id: 'tag-release', name: 'Release planning', noteCount: 1 },
  { id: 'tag-q4', name: 'Q4', noteCount: 1 },
  { id: 'tag-long', name: 'Long tag name here', noteCount: 1 }
]
// A long list masks the content-sized PageShell bug by forcing it to fill the window.
if (location.search) notes.splice(5)
let analysisListener: Parameters<DesktopApi['magicNotes']['onAnalysisEvent']>[0] | undefined
let streamChunk: (() => void) | undefined
window.addEventListener('layout-stream', () => streamChunk?.())
window.goodbuddy = {
  magicNotes: {
    list: async () => structuredClone({ notes, tags }), get: async (id: string) => structuredClone(notes.find(note => note.id === id)), listTodos: async () => ({ todos: [{
      id: 'layout-todo', noteId: note.id, noteTitle: note.title, entryId: 'layout-entry',
      title: 'Layout task', instructions: 'Task details', completed: false, revision: 1,
      comments: [], createdAt: note.createdAt, updatedAt: note.updatedAt
    }] }),
    analyze: (_entryId: string, options: Parameters<DesktopApi['magicNotes']['analyze']>[1]) => {
      streamChunk = () => analysisListener?.({ requestId: options!.requestId, type: 'text', delta: 'Streaming comment paragraph.\n\n'.repeat(80), direction: options!.direction, format: 'combined' })
      return new Promise(() => {})
    },
    onChanged: (listener: () => void) => {
      const update = () => {
        for (const item of notes) {
          item.revision += 1
          item.entries[0].comments = [{ id: 'layout-comment', kind: 'narrative', content: 'Growing AI comment.\n\n'.repeat(100) }]
        }
        listener()
      }
      window.addEventListener('layout-comments', update)
      return () => window.removeEventListener('layout-comments', update)
    }, onAnalysisEvent: (listener: typeof analysisListener) => { analysisListener = listener; return () => { analysisListener = undefined } }
  },
  updates: { getSettings: async () => ({ magicNoteCommentMode: 'after-save-manual', magicNoteCommentFormat: 'combined' }) }
} as unknown as DesktopApi
const host = document.createElement('div')
host.style.height = '100vh'
document.body.append(host)
createRoot(host).render(location.search ? (
  <div className="app-shell">
    <aside className="sidebar" />
    <div className="app-frame">
      <header className="topbar">GoodBuddy</header>
      <div className="app-content">
        <main className="workspace">
          <KeepAliveRoute active route="magic-notes">
            <ApplicationAvailability enabled>
              <PageShell variant="master-detail"><MagicNotesWorkspace onNotify={() => {}} /></PageShell>
            </ApplicationAvailability>
          </KeepAliveRoute>
        </main>
      </div>
    </div>
  </div>
) : <MagicNotesWorkspace onNotify={() => {}} />)
