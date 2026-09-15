import { describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '../shared/contracts'
import { ipcChannels } from '../shared/ipc-channels'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(async () => []) },
  webUtils: { getPathForFile: vi.fn(() => 'C:\\notes.txt') }
}))
vi.mock('electron', () => electron)

describe('context file preload bridge', () => {
  it('resolves native File paths and sends only paths to Main', async () => {
    await import('./index')
    const api = electron.contextBridge.exposeInMainWorld.mock.calls[0]![1] as DesktopApi
    const file = {} as File
    const path = api.context.getFilePath(file)
    expect(electron.webUtils.getPathForFile).toHaveBeenCalledExactlyOnceWith(file)
    await expect(api.context.importFiles([path])).resolves.toEqual([])
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith(
      ipcChannels.contextImportFiles, { paths: ['C:\\notes.txt'] }
    )
  })
})
