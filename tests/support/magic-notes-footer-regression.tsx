import { useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import type { DesktopApi } from '../../src/shared/contracts'
import type { MagicNoteSource } from '../../src/shared/magic-notes-contracts'
import { MagicNotesPanel } from '../../src/renderer/src/MagicNotesPanel'
import { useMagicNoteDraft } from '../../src/renderer/src/use-magic-note-draft'
import i18n from '../../src/renderer/src/i18n'
import '../../src/renderer/src/styles.css'

const parameters = new URLSearchParams(location.search)
await i18n.changeLanguage(parameters.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US')
document.documentElement.dataset.theme = parameters.get('theme') === 'dark' ? 'dark' : 'light'
const source: MagicNoteSource = {
  kind: parameters.get('kind') === 'conversation' ? 'conversation' : 'message',
  conversationId: 'footer-conversation', messageIds: ['footer-message'],
  capturedAt: '2026-09-26T00:00:00Z', conversationTitle: 'Footer discussion', projectName: 'Footer project'
}
document.body.dataset.scope = i18n.t(`capture.${source.kind === 'message' ? 'messageScope' : 'conversationScope'}`, { ns: 'magicNotes' })
document.body.dataset.saveCount = '0'
window.goodbuddy = {
  magicNotes: {
    search: async () => [],
    onChanged: () => () => {},
    create: async () => {
      document.body.dataset.saveCount = String(Number(document.body.dataset.saveCount) + 1)
      throw new Error('Storage unavailable. Please try again.')
    }
  }
} as unknown as DesktopApi

function Harness(): React.JSX.Element {
  const state = useMagicNoteDraft()
  const { setDraft } = state
  useLayoutEffect(() => {
    setDraft({ text: 'Captured text', initialText: 'Captured text', title: 'Footer discussion',
      initialTitle: 'Footer discussion', targetId: '', newNote: false, source })
  }, [setDraft])
  return <>
    <MagicNotesPanel state={state} active commentMode="after-save-manual" onNotify={() => {}}
      onOpenWorkspace={() => {}} onOpenSource={async () => 'opened'} onCancelCapture={() => {}} />
    {state.confirmation}
  </>
}

const host = document.createElement('div')
host.style.height = '100vh'
document.body.append(host)
createRoot(host).render(<Harness />)
