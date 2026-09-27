import { EventEmitter } from 'node:events'
import type { BrowserWindow, ipcMain } from 'electron'
import { expect, it, vi } from 'vitest'
import { ipcChannels } from '../shared/ipc-channels'
import { registerWindowIpcHandlers } from './window-ipc'

vi.mock('electron', () => ({ clipboard: {} }))
vi.mock('./window', () => ({ showWindow: vi.fn() }))

it('relays only direct srcdoc Escape keydowns and removes the listener on disposal', () => {
  const mainFrame = { url: 'file:///app/index.html', parent: null }
  const contents = Object.assign(new EventEmitter(), {
    mainFrame, focusedFrame: mainFrame as { url: string; parent: unknown } | null, send: vi.fn()
  })
  let destroyed = false
  const window = { get webContents() {
    if (destroyed) throw new Error('Object has been destroyed')
    return contents
  } }
  const dispose = registerWindowIpcHandlers(vi.fn() as typeof ipcMain.handle, window as unknown as BrowserWindow)
  const input = (key = 'Escape', type = 'keyDown'): void => { contents.emit('before-input-event', {}, { key, type }) }
  input()
  contents.focusedFrame = null
  input()
  contents.focusedFrame = { url: 'https://example.com', parent: mainFrame }
  input()
  contents.focusedFrame = { url: 'about:srcdoc', parent: {} }
  input()
  contents.focusedFrame = { url: 'about:srcdoc#section', parent: mainFrame }
  input('Tab')
  input('Escape', 'keyUp')
  expect(contents.send).not.toHaveBeenCalled()
  input()
  expect(contents.send).toHaveBeenCalledExactlyOnceWith(ipcChannels.windowPreviewEscape)
  destroyed = true
  dispose()
  input()
  expect(contents.send).toHaveBeenCalledTimes(1)
  expect(contents.listenerCount('before-input-event')).toBe(0)
})
