import { beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => { vi.resetModules(); localStorage.clear() })

function setup() {
  let settings = { serverUrl: 'http://10.7.0.23:8088', name: 'My desktop', deviceId: 'device-1' }
  const capabilities = vi.fn().mockResolvedValue({ enabled: true })
  const saveSettings = vi.fn(async (input: { serverUrl: string; name: string }) => (settings = { ...settings, ...input }))
  window.goodbuddy = { sharing: { getSettings: vi.fn(async () => settings), saveSettings }, office: { capabilities } } as unknown as typeof window.goodbuddy
  return { capabilities, saveSettings }
}

it('ignores a stale Office address and rereads the shared connection for each new open', async () => {
  localStorage.setItem('goodbuddy.office.serverUrl', 'http://192.168.0.23:8088')
  const { capabilities, saveSettings } = setup()
  const { shareServerConnection } = await import('./shareserver-connection-store')
  expect(await shareServerConnection.resolve()).toBe('http://10.7.0.23:8088')
  await saveSettings({ serverUrl: 'http://10.7.0.24:8088', name: 'My desktop' })
  expect(await shareServerConnection.resolve()).toBe('http://10.7.0.24:8088')
  expect(capabilities.mock.calls).toEqual([[{ serverUrl: 'http://10.7.0.23:8088' }], [{ serverUrl: 'http://10.7.0.24:8088' }]])
})

it('saves the shared connection, preserving the device name and never writing an Office override', async () => {
  const { saveSettings } = setup()
  const { shareServerConnection } = await import('./shareserver-connection-store')
  expect(await shareServerConnection.connect('http://10.7.0.24:8088/')).toBe(true)
  expect(saveSettings).toHaveBeenCalledWith({ serverUrl: 'http://10.7.0.24:8088', name: 'My desktop' })
  expect(await shareServerConnection.resolve()).toBe('http://10.7.0.24:8088')
  expect(localStorage.getItem('goodbuddy.office.serverUrl')).toBeNull()
})

it('does not change the registered connection when capability checking fails', async () => {
  const { capabilities, saveSettings } = setup()
  capabilities.mockRejectedValue(new Error('HTTP 503'))
  const { shareServerConnection } = await import('./shareserver-connection-store')
  expect(await shareServerConnection.connect('http://10.7.0.24:8088')).toBe(false)
  expect(saveSettings).not.toHaveBeenCalled()
  expect(shareServerConnection.getState().error).toContain('503')
})

it('keeps a server-advertised Web entry separate from the saved device connection', async () => {
  const { capabilities } = setup()
  capabilities.mockResolvedValue({ webUrl: 'http://10.7.0.23:18088' })
  const { shareServerConnection } = await import('./shareserver-connection-store')
  expect(await shareServerConnection.resolve()).toBe('http://10.7.0.23:18088')
  expect(shareServerConnection.getState().serverUrl).toBe('http://10.7.0.23:8088')
})
