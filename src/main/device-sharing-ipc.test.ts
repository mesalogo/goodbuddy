import { expect, it, vi } from 'vitest'
import { registerDeviceSharingIpc } from './device-sharing-ipc'
import { ipcChannels } from '../shared/ipc-channels'
const handlers = vi.hoisted(() => new Map<string, (event: unknown, input?: unknown) => unknown>())
vi.mock('electron', () => ({ ipcMain: {
  handle: (channel: string, handler: (event: unknown, input?: unknown) => unknown) => handlers.set(channel, handler),
  removeHandler: (channel: string) => handlers.delete(channel)
} }))
it('checks the trusted main frame on every explicit method and validates mutation input', () => {
  const webContents = { mainFrame: { url: 'file:///app.html' }, getURL: () => 'file:///app.html' }
  const service = { getSettings: vi.fn(), saveSettings: vi.fn(), registerDevice: vi.fn(), getCatalog: vi.fn(), publish: vi.fn(), revoke: vi.fn(), getModelConfigs: vi.fn(), importModelConfig: vi.fn(), disposePersonaRequests: vi.fn() }
  const dispose = registerDeviceSharingIpc({ webContents } as never, service as never)
  const event = { sender: webContents, senderFrame: webContents.mainFrame }
  expect(handlers.size).toBe(13)
  for (const handler of handlers.values()) {
    expect(() => handler({ sender: {}, senderFrame: webContents.mainFrame })).toThrow('IPC')
    expect(() => handler({ sender: webContents, senderFrame: { url: 'file:///app.html' } })).toThrow('IPC')
  }
  expect(() => handlers.get(ipcChannels.sharingSettingsSave)!(event, { deviceId: 'forged', name: 'x', serverUrl: 'http://localhost' })).toThrow()
  expect(() => handlers.get(ipcChannels.sharingPublish)!(event, { name: 'x' })).toThrow()
  expect(() => handlers.get(ipcChannels.sharingRevoke)!(event, '')).toThrow()
  expect(() => handlers.get(ipcChannels.sharingModelImport)!(event, { id: 'forged' })).toThrow()
  expect(() => handlers.get(ipcChannels.sharingPersonaSave)!(event, { ownerId: 'forged' })).toThrow()
  expect(() => handlers.get(ipcChannels.sharingPersonaChat)!(event, { message: 'Hello' })).toThrow()
  handlers.get(ipcChannels.sharingRegister)!(event)
  expect(service.registerDevice).toHaveBeenCalledOnce()
  expect(service.registerDevice).toHaveBeenCalledWith({ mode: 'anonymous' })
  expect(() => handlers.get(ipcChannels.sharingRegister)!(event, { mode: 'account', username: 'member', password: '' })).toThrow()
  handlers.get(ipcChannels.sharingRegister)!(event, { mode: 'account', username: 'member', password: 'test-password' })
  expect(service.registerDevice).toHaveBeenLastCalledWith({ mode: 'account', username: 'member', password: 'test-password' })
  dispose(); expect(handlers.size).toBe(0)
})
