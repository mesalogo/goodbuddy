import { describe, expect, it, vi } from 'vitest'
import type { ChannelRuntimeStatusChange, ChannelSettingsSnapshot } from '../../shared/channel-settings-contracts'
import type { DesktopApi } from '../../shared/contracts'
import { createChannelStatusStore } from './channel-status-store'

const credential = {
  enabled: true,
  secretConfigured: true,
  source: 'encrypted' as const,
  readOnly: false,
  allowedSenderIds: [],
  allowGroupMessages: false as const,
  status: { state: 'starting' as const }
}
const snapshot: ChannelSettingsSnapshot = {
  weixin: { enabled: false, bindingConfigured: false, source: 'none', status: { state: 'disabled' } },
  wecom: { ...credential, botId: 'test-bot' },
  dingtalk: { ...credential, clientId: 'test-client' },
  telegram: credential
}

describe('channel status store', () => {
  it('keeps pushed status over a late snapshot, preserves other channel references, and deduplicates events', () => {
    const store = createChannelStatusStore()
    let receive!: (change: ChannelRuntimeStatusChange) => void
    const unsubscribe = vi.fn()
    const api = { onStatusChanged: vi.fn((listener: typeof receive) => { receive = listener; return unsubscribe }) } as unknown as DesktopApi['channels']
    const disconnect = store.connect(api)
    receive({ channel: 'telegram', status: { state: 'running' } })
    store.seed(snapshot)
    expect(store.getState().telegram).toEqual({ state: 'running' })
    expect(store.getState().wecom).toEqual({ state: 'starting' })
    const wecom = store.getState().wecom
    const listener = vi.fn()
    const removeListener = store.subscribe(listener)
    receive({ channel: 'telegram', status: { state: 'running' } })
    expect(listener).not.toHaveBeenCalled()
    receive({ channel: 'telegram', status: { state: 'error', lastError: 'Network unavailable' } })
    expect(listener).toHaveBeenCalledOnce()
    expect(store.getState().wecom).toBe(wecom)
    receive({ channel: 'telegram', status: { state: 'running' } })
    expect(store.getState().telegram).toEqual({ state: 'running' })
    removeListener()
    disconnect()
    expect(unsubscribe).toHaveBeenCalledOnce()
    receive({ channel: 'telegram', status: { state: 'error', lastError: 'Late callback' } })
    expect(store.getState().telegram).toEqual({ state: 'running' })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('uses updated snapshot baselines when the API has no status subscription', () => {
    const store = createChannelStatusStore()
    const disconnect = store.connect({} as DesktopApi['channels'])
    store.seed(snapshot)
    expect(store.getState().telegram).toEqual({ state: 'starting' })
    store.seed({ ...snapshot, telegram: { ...credential, status: { state: 'disabled' } } })
    expect(store.getState().telegram).toEqual({ state: 'disabled' })
    expect(() => disconnect()).not.toThrow()
  })
})
