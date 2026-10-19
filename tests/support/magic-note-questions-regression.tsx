import { createRoot } from 'react-dom/client'
import { useEffect, useRef } from 'react'
import { MagicCanvasContent, type MagicCanvasContentHandle } from '../../src/renderer/src/MagicCanvasContent'
import { MagicNoteQuestions } from '../../src/renderer/src/MagicNoteQuestions'
import i18n from '../../src/renderer/src/i18n'
import '../../src/renderer/src/styles.css'
import '../../src/renderer/src/magic-notes-workspace.css'

await i18n.changeLanguage('en-US')
const note = await window.goodbuddy.magicNotes.get('00000000-0000-4000-8000-000000000601')
const entry = note.entries[0]!
function Fixture() {
  const canvas = useRef<MagicCanvasContentHandle>(null)
  useEffect(() => { Object.assign(window, { compareQuestionCaptures: async () => {
    const full = await canvas.current!.capturePages(2, true, 1)
    const [second] = await canvas.current!.capturePages(1, true, 2)
    return { image: full[1]!.dataUrl === second!.dataUrl, text: full[1]!.text === second!.text, distinct: full[0]!.dataUrl !== second!.dataUrl }
  } }) }, [])
  return <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', height: '100vh' }}>
    <main style={{ overflow: 'auto' }}>{entry.content.version === 2 && <MagicCanvasContent ref={canvas} content={entry.content} onError={error => { throw new Error(error) }} />}</main>
    <aside className="magic-notes-ai-pane"><MagicNoteQuestions note={note} selectedEntryId={entry.id} getCanvas={() => canvas.current ?? undefined}
      onError={error => { document.querySelector('#errors')!.textContent = String(error) }} /></aside>
    <output id="errors" />
  </div>
}
const host = document.createElement('div')
document.body.append(host)
createRoot(host).render(<Fixture />)
