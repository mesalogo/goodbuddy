import React, { useSyncExternalStore } from 'react'
import '../src/renderer/src/i18n'
import { createRoot } from 'react-dom/client'
import type { BrowserLiveState, BrowserTabId } from '../src/shared/contracts'
import { NativeBrowserViewport } from '../src/renderer/src/NativeBrowserViewport'

let current: BrowserLiveState | undefined
const listeners = new Set<() => void>()
window.goodbuddy.browser.onState((state) => { current = state; for (const listener of listeners) listener() })
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => listeners.delete(listener) }
function Fixture(): React.JSX.Element {
  const state = useSyncExternalStore(subscribe, () => current)
  const tabId = new URL(location.href).searchParams.get('tab') as BrowserTabId
  return <section role="tabpanel" hidden={false}><header>Browser</header><NativeBrowserViewport browserState={state} conversationId="browser-ui-e2e" tabId={tabId} visible /></section>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
