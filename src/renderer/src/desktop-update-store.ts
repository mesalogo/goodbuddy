import type { DesktopUpdateSnapshot } from '../../shared/desktop-update-contracts'

export function createDesktopUpdateStore() {
  let state: { snapshot?: DesktopUpdateSnapshot; error?: string } = {}
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of listeners) listener() }
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    receive: (snapshot: DesktopUpdateSnapshot) => {
      if (state.snapshot && snapshot.revision <= state.snapshot.revision) return
      state = { snapshot }
      notify()
    },
    fail: (reason: unknown) => {
      state = { ...state, error: reason instanceof Error ? reason.message : String(reason) }
      notify()
    }
  }
}

export type DesktopUpdateStore = ReturnType<typeof createDesktopUpdateStore>
