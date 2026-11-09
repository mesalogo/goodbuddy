import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChannelSettingsSnapshot } from '../../shared/channel-settings-contracts'
import type { DingTalkRegistrationBridge, DingTalkRegistrationSnapshot } from '../../shared/dingtalk-registration-contracts'
import { DingTalkAppRegistration } from './DingTalkAppRegistration'
import { createDingTalkRegistrationStore } from './dingtalk-registration-store'
import './i18n'

afterEach(cleanup)

it('shows the provider QR, cancels, and refreshes credentials once after saving', async () => {
  let push!: (next: DingTalkRegistrationSnapshot) => void
  const api: DingTalkRegistrationBridge = {
    getSnapshot: vi.fn(async () => ({ revision: 0, state: 'idle' as const })),
    start: vi.fn(async () => ({ revision: 1, state: 'waiting' as const, url: 'https://login.dingtalk.com/test', expiresAt: new Date().toISOString() })),
    cancel: vi.fn(async () => ({ revision: 2, state: 'idle' as const })),
    onChanged: vi.fn(listener => { push = listener; return vi.fn() })
  }
  Object.defineProperty(window, 'goodbuddy', { configurable: true, value: { dingtalkRegistration: api } })
  const onCreated = vi.fn()
  render(<DingTalkAppRegistration onCreated={onCreated} />)
  fireEvent.click(screen.getByRole('button', { name: '扫码创建钉钉机器人' }))
  expect(await screen.findByRole('img', { name: '钉钉机器人授权二维码' })).toHaveAttribute('src', expect.stringContaining('data:image/png'))
  expect(screen.getByRole('link')).toHaveAttribute('href', 'https://login.dingtalk.com/test')
  fireEvent.click(screen.getByRole('button', { name: '取消扫码' }))
  await waitFor(() => expect(api.cancel).toHaveBeenCalledOnce())
  const channels = { dingtalk: { clientId: 'ding-test', enabled: true, secretConfigured: true } } as ChannelSettingsSnapshot
  act(() => push({ revision: 3, state: 'completed', channels }))
  await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith(channels, 3))
  expect(screen.getByRole('status')).toHaveTextContent('staffId')
  act(() => push({ revision: 3, state: 'completed', channels }))
  expect(onCreated).toHaveBeenCalledOnce()
})

it('does not let a late initial reply overwrite a newer registration push', async () => {
  let resolve!: (value: DingTalkRegistrationSnapshot) => void
  let push!: (value: DingTalkRegistrationSnapshot) => void
  const remove = vi.fn()
  const store = createDingTalkRegistrationStore({
    getSnapshot: () => new Promise(done => { resolve = done }),
    start: vi.fn(), cancel: vi.fn(), onChanged: listener => { push = listener; return remove }
  })
  const disconnect = store.connect()
  push({ revision: 4, state: 'starting' })
  resolve({ revision: 0, state: 'idle' })
  await Promise.resolve()
  expect(store.getSnapshot()).toMatchObject({ revision: 4, state: 'starting' })
  disconnect()
  expect(remove).toHaveBeenCalledOnce()
})
