import { describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '../shared/contracts'
import { ipcChannels } from '../shared/ipc-channels'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  webUtils: {}
}))
vi.mock('electron', () => electron)

describe('image operation preload', () => {
  it('forwards explicit actions and delivers operation data without Electron events', async () => {
    await import('./index')
    const api = (electron.contextBridge.exposeInMainWorld.mock.calls[0]![1] as DesktopApi).conversations.imageOperations
    const target = { conversationId: 'conversation', operationId: 'operation' }
    await api.cancel(target)
    await api.regenerate(target)
    expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
      [ipcChannels.imageOperationCancel, target], [ipcChannels.imageOperationRegenerate, target]
    ])
    const listener = vi.fn()
    const unsubscribe = api.onChanged(listener)
    const [channel, handler] = electron.ipcRenderer.on.mock.calls[0]!
    const operation = { ...target, state: 'completed' }
    handler({ sender: 'private' }, operation)
    expect(listener).toHaveBeenCalledExactlyOnceWith(operation)
    unsubscribe()
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledExactlyOnceWith(channel, handler)
  })
})
