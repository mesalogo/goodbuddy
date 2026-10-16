import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultWecomToolSettings, type WecomApi, type WecomSnapshot } from '../../shared/wecom-contracts'
import { WecomToolSettings } from './WecomToolSettings'
import { WecomWorkbarPanel } from './WecomWorkbarPanel'
import i18n from './i18n'

let revision = 0
function snapshot(overrides: Partial<WecomSnapshot> = {}): WecomSnapshot {
  revision += 1
  return {
    revision,
    platformSupported: true,
    cli: { state: 'ready', version: '1.3.4' },
    authorization: { state: 'unauthorized' },
    qr: { state: 'idle' },
    settings: defaultWecomToolSettings(),
    ...overrides
  }
}

function installApi(initial: WecomSnapshot, overrides: Partial<WecomApi> = {}) {
  let listener: ((next: WecomSnapshot) => void) | undefined
  const api = {
    getSnapshot: vi.fn(async () => initial),
    updateSettings: vi.fn(async () => initial),
    startQrAuthorization: vi.fn(async () => ({ ...initial, qr: { state: 'starting' as const } })),
    cancelQrAuthorization: vi.fn(async () => initial),
    authorizeManually: vi.fn(async () => initial),
    authorizeWithChannelBot: vi.fn(async () => initial),
    disconnect: vi.fn(async () => initial),
    searchDocuments: vi.fn(async () => []),
    onChanged: vi.fn((next: (snapshot: WecomSnapshot) => void) => { listener = next; return () => { listener = undefined } }),
    ...overrides
  } satisfies WecomApi
  Object.defineProperty(window, 'goodbuddy', { configurable: true, value: { wecom: api } })
  return { api, push: (next: WecomSnapshot) => act(() => listener?.(next)) }
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('zh-CN')
})

describe('WecomToolSettings', () => {
  it('offers scanning, the channel bot, and manual credentials before authorization', async () => {
    const { api, push } = installApi(snapshot())
    render(<WecomToolSettings channelBotConfigured />)
    fireEvent.click(await screen.findByRole('button', { name: '扫码授权' }))
    expect(api.startQrAuthorization).toHaveBeenCalledOnce()
    push(snapshot({ qr: { state: 'waiting', url: 'https://work.weixin.qq.com/ai/qc/gen?scode=x', expiresAt: new Date(Date.now() + 300_000).toISOString() } }))
    expect(await screen.findByText('请用企业微信扫描二维码，并在手机上确认创建机器人。')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '取消扫码' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '取消扫码' }))
    expect(api.cancelQrAuthorization).toHaveBeenCalledOnce()
    push(snapshot())
    await waitFor(() => expect(screen.getByRole('button', { name: '使用消息通道的机器人' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '使用消息通道的机器人' }))
    expect(api.authorizeWithChannelBot).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.getByRole('button', { name: '填写 Bot ID 和 Secret' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '填写 Bot ID 和 Secret' }))
    fireEvent.change(screen.getByLabelText('Bot ID'), { target: { value: 'bot-1' } })
    fireEvent.change(screen.getByLabelText('Secret'), { target: { value: 'secret-1' } })
    fireEvent.click(screen.getByRole('button', { name: '验证并保存' }))
    await waitFor(() => expect(api.authorizeManually).toHaveBeenCalledWith({ botId: 'bot-1', secret: 'secret-1' }))
  })

  it('shows CLI errors and keeps the manual form open after rejected credentials', async () => {
    installApi(snapshot(), { authorizeManually: vi.fn(async () => { throw new Error('invalid bot_id or secret') }) })
    render(<WecomToolSettings channelBotConfigured={false} />)
    expect(screen.queryByRole('button', { name: '使用消息通道的机器人' })).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: '填写 Bot ID 和 Secret' }))
    fireEvent.change(screen.getByLabelText('Bot ID'), { target: { value: 'bot' } })
    fireEvent.change(screen.getByLabelText('Secret'), { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: '验证并保存' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid bot_id or secret')
    expect(screen.getByLabelText('Secret')).toHaveValue('bad')
  })

  it('edits the enable switch, categories, and message-session permission once authorized', async () => {
    const authorized = snapshot({ authorization: { state: 'authorized', botId: 'bot-9' } })
    const { api } = installApi(authorized)
    render(<WecomToolSettings channelBotConfigured={false} />)
    expect(await screen.findByText(/机器人 bot-9/u)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /邮件/u })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /待办/u })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /待办/u })).toBeDisabled()
    fireEvent.click(screen.getByRole('switch', { name: '在对话中提供企业微信工具' }))
    expect(api.updateSettings).toHaveBeenLastCalledWith({ enabled: true })
    await waitFor(() => expect(screen.getByRole('button', { name: '断开并删除本机凭据' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '断开并删除本机凭据' }))
    await waitFor(() => expect(api.disconnect).toHaveBeenCalledOnce())
  })

  it('reports an unsupported platform', async () => {
    installApi(snapshot({ platformSupported: false }))
    render(<WecomToolSettings channelBotConfigured={false} />)
    expect(await screen.findByText('当前安装包没有内置企业微信 CLI（不支持此操作系统或处理器架构）。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '扫码授权' })).toBeDisabled()
  })
})

describe('WecomWorkbarPanel', () => {
  it('asks for setup until tools are enabled and authorized', async () => {
    installApi(snapshot())
    const onOpenSettings = vi.fn()
    render(<WecomWorkbarPanel onOpenSettings={onOpenSettings} />)
    expect(await screen.findByText('企业微信工具尚未授权或已关闭。')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: '打开应用设置' })[1]!)
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('searches documents and inserts a reference into the conversation', async () => {
    const ready = snapshot({ authorization: { state: 'authorized' }, settings: { ...defaultWecomToolSettings(), enabled: true } })
    const { api } = installApi(ready, {
      searchDocuments: vi.fn(async () => [
        { id: 'd1', name: '周报汇总', type: 'smartsheet', url: 'https://doc.weixin.qq.com/smartsheet/1', modifiedAt: '2026-10-10 09:00:00' }
      ])
    })
    const onUse = vi.fn()
    render(<WecomWorkbarPanel onUseInConversation={onUse} />)
    fireEvent.change(await screen.findByRole('searchbox', { name: '搜索企业微信文档' }), { target: { value: '周报' } })
    fireEvent.submit(screen.getByRole('search'))
    expect(await screen.findByText('周报汇总')).toBeInTheDocument()
    expect(api.searchDocuments).toHaveBeenCalledWith({ query: '周报' })
    expect(screen.getByText(/智能表格 · 2026-10-10/u)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '打开原文' })).toHaveAttribute('href', 'https://doc.weixin.qq.com/smartsheet/1')
    fireEvent.click(screen.getByRole('button', { name: '用于当前对话' }))
    expect(onUse).toHaveBeenCalledWith('请参考企业微信文档「周报汇总」（https://doc.weixin.qq.com/smartsheet/1）')
  })
})
