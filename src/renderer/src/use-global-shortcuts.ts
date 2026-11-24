import { useEffect, useLayoutEffect, useRef } from 'react'
import { formatShortcutForDisplay } from '../../shared/shortcut'

type GlobalShortcutActions = {
  platform: string
  newConversation: () => void
  openConversationSearch: () => void
  toggleSidebar: () => void
  openSettings: () => void
  // In the workbench layout the conversation column exists only on the chat page.
  conversationColumnAvailable: boolean
}

const isEditing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement)

// Ctrl/Cmd+N keeps working anywhere, as before. The other shortcuts yield to
// text fields and to an active input method, so typing never moves focus or
// changes the layout. The labels are for the tooltips of the controls the
// shortcuts trigger.
export function useGlobalShortcuts(actions: GlobalShortcutActions): {
  searchLabel: string
  sidebarLabel: string
  settingsLabel: string
} {
  const latest = useRef(actions)
  useLayoutEffect(() => {
    latest.current = actions
  })
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((!event.ctrlKey && !event.metaKey) || event.altKey) return
      const current = latest.current
      const key = event.key.toLocaleLowerCase()
      if (!event.shiftKey && key === 'n') {
        event.preventDefault()
        current.newConversation()
        return
      }
      if (event.isComposing || event.shiftKey || isEditing(event.target)) return
      if (key === 'k') {
        if (!current.conversationColumnAvailable) return
        event.preventDefault()
        current.openConversationSearch()
      } else if (key === 'b') {
        if (!current.conversationColumnAvailable) return
        event.preventDefault()
        current.toggleSidebar()
      } else if (key === ',') {
        event.preventDefault()
        current.openSettings()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
  return {
    searchLabel: formatShortcutForDisplay('CommandOrControl+K', actions.platform),
    sidebarLabel: formatShortcutForDisplay('CommandOrControl+B', actions.platform),
    settingsLabel: formatShortcutForDisplay('CommandOrControl+,', actions.platform),
  }
}
