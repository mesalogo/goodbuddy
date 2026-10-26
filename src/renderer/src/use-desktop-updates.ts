import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { createDesktopUpdateStore } from './desktop-update-store'
import { connectDesktopUpdates } from './desktop-update-sync'

export function useDesktopUpdates() {
  const store = useMemo(() => createDesktopUpdateStore(), [])
  const bridge = window.goodbuddy.desktopUpdates
  useEffect(() => bridge ? connectDesktopUpdates(store, bridge) : undefined, [bridge, store])
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const actions = useMemo(() => ({
    download: (fileName: string) => { void bridge?.download({ fileName }).catch(store.fail) },
    cancel: () => { void bridge?.cancel().catch(store.fail) },
    open: async () => { await bridge?.openPackage().catch(store.fail) },
    restart: async () => { await bridge?.restart?.().catch(store.fail) },
    clearCache: async () => {
      if (!bridge?.clearCache) return false
      try { await bridge.clearCache(); return true } catch (error) { store.fail(error); return false }
    }
  }), [bridge, store])
  return { ...state, actions, supported: Boolean(bridge) }
}
