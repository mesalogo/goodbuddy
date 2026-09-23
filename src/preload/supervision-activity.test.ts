import { expect, it, vi } from 'vitest'
import type { DesktopApi } from '../shared/contracts'
import { ipcChannels } from '../shared/ipc-channels'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }, webUtils: {}
}))
vi.mock('electron', () => electron)

it('reads activity and exact review results through the explicit bridge', async () => {
  await import('./index')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls[0]![1] as DesktopApi
  const rows = [{ id: 'saved-run' }]
  electron.ipcRenderer.invoke.mockResolvedValue(rows)
  expect(await api.supervision.activity({ limit: 50, offset: 50 })).toBe(rows)
  expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(ipcChannels.supervisionActivity, { limit: 50, offset: 50 })
  await api.supervision.overview({ resultId: 'old-result' })
  expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(ipcChannels.supervisionOverview, { resultId: 'old-result' })
})
