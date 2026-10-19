import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { changeUiLocale } from './i18n'
import {
  applicationSettingsSchema,
  defaultApplicationNavigation,
  defaultLocalToolEnvironmentSettings,
} from '../../shared/application-settings-contracts'
import {
  ApplicationAvailability,
  ApplicationCenter,
  ApplicationSettingsView,
  isApplicationEnabled,
  isApplicationOpenable,
} from './ApplicationCenter'

const settings = applicationSettingsSchema.parse({
  checkUpdatesOnStartup: false,
  updateSource: 'github',
  modelDownloadSource: 'modelscope',
  localToolEnvironment: defaultLocalToolEnvironmentSettings,
  conversationHtmlRenderingEnabled: true,
  remoteProjectsEnabled: false,
})
const props = () => ({
  settings,
  pending: false,
  onClose: vi.fn(),
  onOpen: vi.fn(),
  onUpdate: vi.fn(async () => true),
  onRetry: vi.fn(),
})
afterEach(async () => {
  cleanup()
  await changeUiLocale('zh-CN')
})

describe('Application Center', () => {
  const card = (name: string): HTMLElement => screen.getByText(name, { exact: true, selector: 'strong' }).closest('article')!

  it('shows cards in the fixed order with enable and pin switches and a settings button in the footer', () => {
    const handlers = props()
    render(<ApplicationCenter {...handlers} />)
    const work = document.querySelector<HTMLElement>('.application-center__cards')!
    expect(within(work).getAllByRole('article').map((item) => item.querySelector('strong')?.textContent))
      .toEqual(['魔法笔记', '知识库', '监督者', '主机管理', '本机推理监控', '设备共享（技术预览）'])
    expect(screen.queryByRole('button', { name: /上移|下移/u })).not.toBeInTheDocument()
    for (const item of within(work).getAllByRole('article')) expect(item).not.toHaveAttribute('draggable')
    const notes = card('魔法笔记')
    const footer = notes.querySelector('footer')!
    expect(within(footer).getByRole('switch', { name: '启用魔法笔记' })).toBeChecked()
    expect(within(footer).getByRole('switch', { name: '魔法笔记常驻左侧菜单' })).toBeChecked()
    expect(within(footer).getByRole('button', { name: '魔法笔记 应用设置' })).toBeInTheDocument()
  })

  it('switches enablement and pinning straight from the card, waiting for confirmed settings', () => {
    const handlers = props()
    const { rerender } = render(<ApplicationCenter {...handlers} settings={{ ...settings, localInferenceEnabled: false }} />)
    const inference = card('本机推理监控')
    const enable = within(inference).getByRole('switch', { name: '启用本机推理监控' })
    expect(enable).not.toBeChecked()
    expect(within(inference).getByRole('button', { name: '打开本机推理监控' })).toBeDisabled()
    fireEvent.click(enable)
    expect(handlers.onUpdate).toHaveBeenLastCalledWith({ localInferenceEnabled: true })
    expect(enable).not.toBeChecked()
    const pin = within(inference).getByRole('switch', { name: '本机推理监控常驻左侧菜单' })
    fireEvent.click(pin)
    expect(handlers.onUpdate).toHaveBeenLastCalledWith({
      applicationNavigation: { ...defaultApplicationNavigation, pinned: { ...defaultApplicationNavigation.pinned, 'local-inference': true } },
    })
    rerender(<ApplicationCenter {...handlers} pending />)
    for (const toggle of screen.getAllByRole('switch')) expect(toggle).toBeDisabled()
    rerender(<ApplicationCenter {...handlers} locked error="无法确认保存结果" />)
    expect(screen.getByRole('alert')).toHaveTextContent('无法确认保存结果')
    for (const toggle of screen.getAllByRole('switch')) expect(toggle).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
    expect(handlers.onRetry).toHaveBeenCalledOnce()
  })

  it('keeps 知识库 always enabled: only a pin switch, no enable switch or settings', () => {
    const handlers = props()
    render(<ApplicationCenter {...handlers} />)
    const knowledge = card('知识库')
    expect(within(knowledge).queryByRole('switch', { name: /^启用/u })).not.toBeInTheDocument()
    const pin = within(knowledge).getByRole('switch', { name: '知识库常驻左侧菜单' })
    expect(pin).toBeChecked()
    expect(within(knowledge).queryByRole('button', { name: /应用设置/u })).not.toBeInTheDocument()
    fireEvent.click(pin)
    expect(handlers.onUpdate).toHaveBeenLastCalledWith({
      applicationNavigation: { ...defaultApplicationNavigation, pinned: { ...defaultApplicationNavigation.pinned, knowledge: false } },
    })
    fireEvent.click(within(knowledge).getByRole('button', { name: '打开知识库' }))
    expect(handlers.onOpen).toHaveBeenCalledWith('knowledge')
  })

  it('offers device sharing a pin switch and its settings, and opens it once enabled', () => {
    const handlers = props()
    const { rerender } = render(<ApplicationCenter {...handlers} />)
    expect(isApplicationEnabled(undefined, 'device-sharing')).toBe(false)
    const sharing = card('设备共享（技术预览）')
    expect(within(sharing).getByRole('switch', { name: '设备共享（技术预览）常驻左侧菜单' })).not.toBeChecked()
    expect(within(sharing).getByRole('button', { name: '打开设备共享（技术预览）' })).toBeDisabled()
    fireEvent.click(within(sharing).getByRole('switch', { name: '启用设备共享（技术预览）' }))
    expect(handlers.onUpdate).toHaveBeenLastCalledWith({ deviceSharingEnabled: true })
    rerender(<ApplicationCenter {...handlers} settings={{ ...settings, deviceSharingEnabled: true }} />)
    fireEvent.click(within(card('设备共享（技术预览）')).getByRole('button', { name: '打开设备共享（技术预览）' }))
    expect(handlers.onOpen).toHaveBeenCalledWith('device-sharing')
    fireEvent.click(within(card('设备共享（技术预览）')).getByRole('button', { name: '设备共享（技术预览） 应用设置' }))
    expect(screen.getByRole('switch', { name: '常驻左侧菜单' })).toBeInTheDocument()
  })

  it('opens Hosts while remote capability is off and switches it through the shared remote projects setting', () => {
    const handlers = props()
    render(<ApplicationCenter {...handlers} />)
    expect(isApplicationEnabled(settings, 'remote-hosts')).toBe(false)
    expect(isApplicationOpenable(settings, 'remote-hosts')).toBe(true)
    expect(isApplicationOpenable(undefined, 'remote-hosts')).toBe(false)
    const hosts = card('主机管理')
    fireEvent.click(within(hosts).getByRole('button', { name: '打开主机管理' }))
    expect(handlers.onOpen).toHaveBeenCalledWith('remote-hosts')
    fireEvent.click(within(hosts).getByRole('switch', { name: '启用主机管理' }))
    expect(handlers.onUpdate).toHaveBeenLastCalledWith({ remoteProjectsEnabled: true })
    fireEvent.click(within(hosts).getByRole('button', { name: '主机管理 应用设置' }))
    expect(screen.getByRole('switch', { name: '启用远程能力' })).not.toBeChecked()
    expect(screen.getByText(/主机、凭据、远程项目和 Agent 离线包都会保留/u)).toBeVisible()
  })

  it.each([undefined, false])('keeps the supervisor disabled with preference %s until explicitly enabled', (heartbeatEnabled) => {
    const handlers = props()
    render(<ApplicationCenter {...handlers} settings={{ ...settings, heartbeatEnabled }} />)
    const supervisor = card('监督者')
    const open = within(supervisor).getByRole('button', { name: '打开监督者' })
    expect(open).toBeDisabled()
    fireEvent.click(open)
    expect(handlers.onOpen).not.toHaveBeenCalled()
    fireEvent.click(within(supervisor).getByRole('switch', { name: '启用监督者' }))
    expect(handlers.onUpdate).toHaveBeenLastCalledWith({ heartbeatEnabled: true })
  })

  it('searches cards, opens without pinning, and restores focus', () => {
    const handlers = props()
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const { unmount } = render(<ApplicationCenter {...handlers} settings={{
      ...settings,
      applicationNavigation: { ...defaultApplicationNavigation, pinned: { ...defaultApplicationNavigation.pinned, 'magic-notes': false } },
    }} />)
    const search = screen.getByRole('searchbox', { name: '搜索内置应用' })
    expect(search).toHaveFocus()
    fireEvent.change(search, { target: { value: '笔记' } })
    fireEvent.click(screen.getByRole('button', { name: '打开魔法笔记' }))
    expect(handlers.onOpen).toHaveBeenCalledWith('magic-notes')
    expect(handlers.onUpdate).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(handlers.onClose).toHaveBeenCalledOnce()
    unmount()
    expect(trigger).toHaveFocus()
    trigger.remove()
  })

  it.each(['zh-CN', 'en-US'] as const)('keeps disable consequences visible and pin help separate in %s', async (locale) => {
    await changeUiLocale(locale)
    const onUpdate = vi.fn(async () => true)
    const { container } = render(<ApplicationSettingsView id="magic-notes" settings={settings} pending={false} onUpdate={onUpdate} />)
    const pinLabel = locale === 'zh-CN' ? '常驻左侧菜单' : 'Pin to sidebar'
    const explanation = locale === 'zh-CN' ? '常驻只控制左侧捷径。' : 'Pinning only controls the sidebar shortcut.'
    const consequence = locale === 'zh-CN' ? /不停止已有请求或后台服务/ : /without stopping existing requests or background services/
    expect(screen.getByText(explanation)).not.toBeVisible()
    expect(screen.getByText(consequence)).toBeVisible()
    const help = screen.getByRole('button', { name: pinLabel })
    expect(container.querySelector('label .inline-help, button .inline-help, summary .inline-help')).toBeNull()
    const pin = screen.getByRole('switch', { name: pinLabel })
    expect(pin).toHaveAccessibleDescription(explanation)
    const checked = (pin as HTMLInputElement).checked
    fireEvent.click(help)
    expect(onUpdate).not.toHaveBeenCalled()
    expect((pin as HTMLInputElement).checked).toBe(checked)
    expect(screen.getByRole('tooltip')).toHaveTextContent(explanation)
    expect(screen.getByRole('tooltip')).not.toHaveTextContent(consequence)
    expect(pin).toHaveAccessibleDescription(explanation)
  })

  it('returns from compact settings through header navigation without losing the search', () => {
    render(<ApplicationCenter {...props()} />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '笔记' } })
    const body = screen.getByRole('searchbox').closest('.application-center__body')!
    body.scrollTop = 200
    fireEvent.click(screen.getByRole('button', { name: '魔法笔记 应用设置' }))
    const dialog = screen.getByRole('dialog', { name: '魔法笔记' })
    expect(dialog).toHaveClass('application-center--detail')
    // Same layout as system settings: app tabs on the left, settings on the right.
    const tabs = within(dialog).getByRole('tablist', { name: '应用' })
    expect(within(tabs).getByRole('tab', { name: '魔法笔记' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(within(tabs).getByRole('tab', { name: '监督者' }))
    expect(screen.getByRole('dialog', { name: '监督者' })).toBe(dialog)
    expect(within(dialog).getByRole('switch', { name: '启用应用' })).toBeInTheDocument()
    const back = within(dialog).getByRole('button', { name: '返回应用中心' })
    expect(back.closest('.settings-panel__header')).not.toBeNull()
    fireEvent.click(back)
    expect(screen.getByRole('searchbox')).toHaveValue('笔记')
    expect(screen.getByRole('searchbox')).toHaveFocus()
    expect(dialog).not.toHaveClass('application-center--detail')
  })

  it.each([
    { state: 'loading', settings: undefined },
    { state: 'missing preference', settings },
    { state: 'explicitly disabled', settings: { ...settings, heartbeatEnabled: false } },
  ])('hides supervisor content when settings are $state', ({ settings: current }) => {
    const enabled = isApplicationEnabled(current, 'heartbeat')
    expect(enabled).toBe(false)
    const { rerender } = render(
      <ApplicationAvailability enabled={enabled}>
        <button>Supervisor content</button>
      </ApplicationAvailability>,
    )
    expect(screen.queryByRole('button', { name: 'Supervisor content' })).not.toBeInTheDocument()
    expect(screen.getByText('Supervisor content')).not.toBeVisible()
    expect(screen.getByText('Supervisor content').closest('.application-page-content')).toHaveAttribute('inert')
    rerender(
      <ApplicationAvailability enabled={isApplicationEnabled({ ...settings, heartbeatEnabled: true }, 'heartbeat')}>
        <button>Supervisor content</button>
      </ApplicationAvailability>,
    )
    expect(screen.getByRole('button', { name: 'Supervisor content' })).toBeVisible()
  })
  it('provides a recoverable search empty state and no market or system tools', () => {
    render(<ApplicationCenter {...props()} />)
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.queryByText('安装')).not.toBeInTheDocument()
    expect(screen.queryByText('终端')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'absent' },
    })
    expect(screen.getByText('未找到相关应用')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }))
    expect(screen.getAllByRole('article')).toHaveLength(6)
  })

  it('edits all notes preferences through the shared settings form', () => {
    const onUpdate = vi.fn(async () => true)
    render(
      <ApplicationSettingsView
        id="magic-notes"
        settings={settings}
        pending={false}
        onUpdate={onUpdate}
      />,
    )
    fireEvent.click(screen.getByRole('switch', { name: '启用应用' }))
    expect(onUpdate).toHaveBeenLastCalledWith({ magicNotesEnabled: false })
    const pageCount = screen.getByRole('combobox', { name: '发送画布页数' })
    expect(pageCount).toHaveValue('1')
    expect(within(pageCount).getAllByRole('option')).toHaveLength(8)
    expect(pageCount.parentElement).toHaveClass('field')
    const help = screen.getByRole('button', { name: '发送画布页数' })
    expect(help).toHaveClass('inline-help')
    expect(help).not.toHaveAttribute('title')
    expect(help.closest('label, summary')).toBeNull()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    fireEvent.click(help)
    expect(pageCount).toHaveValue('1')
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(pageCount).toHaveAccessibleDescription(expect.stringContaining('不是笔记记录数量'))
    expect(screen.getByRole('tooltip')).toHaveAttribute('id', 'magic-note-canvas-page-count-help')
    fireEvent.change(pageCount, { target: { value: '8' } })
    expect(onUpdate).toHaveBeenLastCalledWith({ magicNoteCanvasPageCount: 8 })
    fireEvent.click(screen.getByRole('switch', { name: '显示未完成待办数量' }))
    expect(onUpdate).toHaveBeenLastCalledWith({
      magicNotesShowIncompleteTodoCount: false,
    })
    fireEvent.click(screen.getByRole('button', { name: '保存后自动' }))
    expect(onUpdate).toHaveBeenLastCalledWith({
      magicNoteCommentMode: 'after-save-auto',
    })
    fireEvent.click(screen.getByRole('button', { name: '要点' }))
    expect(onUpdate).toHaveBeenLastCalledWith({
      magicNoteCommentFormat: 'structured',
    })
  })

  it('lists platform applications with channel status, opens their project, and edits one channel', async () => {
    const snapshot = {
      telegram: { enabled: false, secretConfigured: false, source: 'none', readOnly: false, allowedSenderIds: [], allowGroupMessages: false, status: { state: 'disabled' } },
      weixin: { enabled: true, bindingConfigured: true, source: 'encrypted', status: { state: 'running' } },
      wecom: { enabled: false, botId: '', secretConfigured: false, source: 'none', readOnly: false, allowedSenderIds: [], allowGroupMessages: false, status: { state: 'disabled' } },
      dingtalk: { enabled: true, clientId: 'c', secretConfigured: true, source: 'encrypted', readOnly: false, allowedSenderIds: [], allowGroupMessages: false, status: { state: 'error', lastError: 'x' } },
      feishu: { enabled: false, appId: '', domain: 'feishu', secretConfigured: false, source: 'none', readOnly: false, allowedSenderIds: [], allowGroupMessages: false, status: { state: 'disabled' } },
    }
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        channels: {
          getSnapshot: vi.fn(async () => snapshot),
          onStatusChanged: vi.fn(() => () => undefined),
          getWeixinBinding: vi.fn(async () => ({ status: 'stopped' })),
          onWeixinBindingChanged: vi.fn(() => () => undefined),
        },
        settings: { getRuntime: vi.fn(() => new Promise(() => undefined)) },
      },
    })
    const handlers = props()
    const onOpenChannel = vi.fn()
    const channelProject = { id: 'p1', kind: 'channel', channel: 'weixin' } as never
    render(<ApplicationCenter {...handlers} platform={{ projects: [channelProject], onOpenChannel, onUpdateProject: vi.fn() }} />)
    const group = await screen.findByRole('region', { name: '平台应用' })
    const weixin = (await within(group).findByText('微信 ClawBot', { exact: true })).closest('article')!
    expect(await within(weixin).findByText(/已连接/u)).toBeInTheDocument()
    const telegram = within(group).getByText('Telegram', { exact: true }).closest('article')!
    expect(within(telegram).getByText(/未配置/u)).toBeInTheDocument()
    // Unconfigured platforms offer "连接" instead of open/settings.
    expect(within(telegram).queryByRole('button', { name: '打开Telegram' })).not.toBeInTheDocument()
    expect(within(telegram).queryByRole('switch')).not.toBeInTheDocument()
    expect(within(telegram).getByRole('button', { name: '连接 Telegram' })).toBeInTheDocument()
    const dingtalk = within(group).getByText('钉钉', { exact: true }).closest('article')!
    expect(dingtalk).toHaveTextContent('连接失败')
    expect(dingtalk.querySelector('.application-card__status')).toHaveAttribute('data-tone', 'error')
    expect(dingtalk.querySelector('.application-card__account')).toHaveTextContent('c')
    expect(within(dingtalk).getByRole('switch', { name: '启用钉钉' })).toBeChecked()
    expect(within(dingtalk).getByRole('button', { name: '钉钉 应用设置' })).toBeInTheDocument()
    expect(dingtalk).toHaveTextContent('消息 · 未设置发送者')
    expect(dingtalk).toHaveTextContent('只有消息')
    // Platforms with tools come first.
    expect(within(group).getAllByRole('article').map((row) => row.querySelector('strong')?.textContent))
      .toEqual(['飞书', '企业微信', '钉钉', '微信 ClawBot', 'Telegram'])
    expect(within(group).getByText(/每个平台连接一个账号/u)).toBeInTheDocument()
    expect(within(group).queryByRole('button', { name: /上移|下移/u })).not.toBeInTheDocument()
    fireEvent.click(within(weixin).getByRole('button', { name: '打开微信 ClawBot' }))
    expect(onOpenChannel).toHaveBeenCalledWith('weixin')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Telegram' } })
    expect(screen.queryByText('微信 ClawBot', { exact: true })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '连接 Telegram' }))
    expect(screen.getByRole('dialog', { name: 'Telegram' })).toHaveClass('application-center--detail')
    expect(await screen.findByText('正在读取消息通道设置…')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '返回应用中心' }))
    expect(screen.getByRole('searchbox')).toHaveValue('Telegram')
  })

  it('turns a platform application off from its card without touching its other settings', async () => {
    const dingtalk = { enabled: true, clientId: 'c', secretConfigured: true, source: 'encrypted', readOnly: false, allowedSenderIds: ['u1'], allowGroupMessages: true, status: { state: 'running' } }
    const off = { state: 'disabled' }
    const snapshot = {
      telegram: { enabled: false, secretConfigured: false, source: 'none', readOnly: false, allowedSenderIds: [], allowGroupMessages: false, status: off },
      weixin: { enabled: false, bindingConfigured: false, source: 'none', status: off },
      wecom: { enabled: false, botId: '', secretConfigured: false, source: 'none', readOnly: false, allowedSenderIds: [], allowGroupMessages: false, status: off },
      dingtalk,
      feishu: { enabled: false, appId: '', domain: 'feishu', secretConfigured: false, source: 'none', readOnly: false, allowedSenderIds: [], allowGroupMessages: false, status: off },
    }
    const apply = vi.fn(async () => ({ ...snapshot, dingtalk: { ...dingtalk, enabled: false, status: off } }))
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        channels: {
          getSnapshot: vi.fn(async () => snapshot), apply,
          onStatusChanged: vi.fn(() => () => undefined),
          getWeixinBinding: vi.fn(async () => ({ status: 'stopped' })),
          onWeixinBindingChanged: vi.fn(() => () => undefined),
        },
        settings: { getRuntime: vi.fn(() => new Promise(() => undefined)) },
      },
    })
    render(<ApplicationCenter {...props()} platform={{ projects: [], onOpenChannel: vi.fn(), onUpdateProject: vi.fn() }} />)
    const toggle = await screen.findByRole('switch', { name: '启用钉钉' })
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith({ dingtalk: {
      enabled: false, clientId: 'c', secret: { action: 'keep' }, allowedSenderIds: ['u1'], allowGroupMessages: true
    } }))
    await vi.waitFor(() => expect(screen.getByRole('switch', { name: '启用钉钉' })).not.toBeChecked())
  })

  it('opens directly on a requested platform application', async () => {
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        channels: {
          getSnapshot: vi.fn(() => new Promise(() => undefined)),
          onStatusChanged: vi.fn(() => () => undefined),
          getWeixinBinding: vi.fn(async () => ({ status: 'stopped' })),
          onWeixinBindingChanged: vi.fn(() => () => undefined),
        },
        settings: { getRuntime: vi.fn(() => new Promise(() => undefined)) },
      },
    })
    render(<ApplicationCenter {...props()} platform={{ projects: [], initialChannel: 'wecom', onOpenChannel: vi.fn(), onUpdateProject: vi.fn() }} />)
    expect(screen.getByRole('dialog', { name: '企业微信' })).toBeInTheDocument()
    expect(await screen.findByText('正在读取消息通道设置…')).toBeInTheDocument()
  })

  it('keeps disabled page drafts mounted without a generic settings shortcut', () => {
    const page = (enabled: boolean) => (
      <ApplicationAvailability enabled={enabled}>
        <input aria-label="draft" defaultValue="original" />
      </ApplicationAvailability>
    )
    const { rerender } = render(page(true))
    expect(screen.queryByRole('button', { name: '应用设置' })).not.toBeInTheDocument()
    const draft = screen.getByRole('textbox', { name: 'draft' })
    fireEvent.change(draft, { target: { value: 'keep this draft' } })
    rerender(page(false))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(draft).toBeInTheDocument()
    expect(screen.getByText('应用已关闭')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '应用设置' })).not.toBeInTheDocument()
    rerender(page(true))
    expect(screen.getByRole('textbox')).toHaveValue('keep this draft')
  })
})
