import { describe, expect, it, vi } from 'vitest'
import { createDesktopUpdateStore } from './desktop-update-store'
import { connectDesktopUpdates } from './desktop-update-sync'
import type { DesktopUpdateBridge, DesktopUpdateSnapshot } from '../../shared/desktop-update-contracts'

describe('desktop update synchronization', () => {
  it('does not let a late snapshot replace newer progress and detaches on unmount', async () => {
    const store = createDesktopUpdateStore()
    let received!: (state: DesktopUpdateSnapshot) => void
    let resolve!: (state: DesktopUpdateSnapshot) => void
    const unsubscribe = vi.fn()
    const bridge: DesktopUpdateBridge = {
      getSnapshot: () => new Promise(done => { resolve = done }),
      onChanged: listener => { received = listener; return unsubscribe },
      download: vi.fn(), cancel: vi.fn(), openPackage: vi.fn()
    }
    const stop = connectDesktopUpdates(store, bridge)
    received({ revision: 2, status: 'downloading', transferred: 100 })
    resolve({ revision: 1, status: 'available', transferred: 0 })
    await Promise.resolve()
    expect(store.getState().snapshot?.transferred).toBe(100)
    stop()
    received({ revision: 3, status: 'ready', transferred: 200 })
    expect(store.getState().snapshot?.revision).toBe(2)
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
