import { describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '../shared/contracts'
import { ipcChannels } from '../shared/ipc-channels'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { on: vi.fn(), removeListener: vi.fn() },
  webUtils: {}
}))
vi.mock('electron', () => electron)

describe('Magic Notes preload events', () => {
  it('forwards change notifications without exposing the Electron event and removes the same listener', async () => {
    await import('./index')
    const api = electron.contextBridge.exposeInMainWorld.mock.calls[0]![1] as DesktopApi
    const listener = vi.fn()
    const unsubscribe = api.magicNotes.onChanged(listener)
    const [channel, handler] = electron.ipcRenderer.on.mock.calls[0]!
    expect(channel).toBe(ipcChannels.magicNotesChanged)
    handler({ sender: 'must stay in preload' })
    expect(listener).toHaveBeenCalledExactlyOnceWith()
    unsubscribe()
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledExactlyOnceWith(channel, handler)
  })
})
