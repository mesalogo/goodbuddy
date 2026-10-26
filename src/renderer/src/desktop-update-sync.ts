import type { DesktopUpdateBridge } from '../../shared/desktop-update-contracts'
import type { DesktopUpdateStore } from './desktop-update-store'

export function connectDesktopUpdates(store: DesktopUpdateStore, bridge: DesktopUpdateBridge): () => void {
  let active = true
  const unsubscribe = bridge.onChanged(snapshot => { if (active) store.receive(snapshot) })
  void bridge.getSnapshot().then(
    snapshot => { if (active) store.receive(snapshot) },
    error => { if (active) store.fail(error) }
  )
  return () => { active = false; unsubscribe() }
}
