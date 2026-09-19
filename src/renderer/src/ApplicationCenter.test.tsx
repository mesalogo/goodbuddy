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
const pinnedSettings = {
  ...settings,
  applicationNavigation: {
    ...defaultApplicationNavigation,
    pinned: { 'magic-notes': true, 'local-inference': true },
  },
}
afterEach(async () => {
  cleanup()
  await changeUiLocale('zh-CN')
})

describe('Application Center', () => {
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
    expect(body.scrollTop).toBe(0)
    const dialog = screen.getByRole('dialog', { name: '魔法笔记' })
    expect(dialog).toHaveClass('application-center--detail')
    const back = within(dialog).getByRole('button', { name: '返回应用中心' })
    expect(back.closest('.settings-panel__header')).not.toBeNull()
    fireEvent.click(back)
    expect(screen.getByRole('searchbox')).toHaveValue('笔记')
    expect(screen.getByRole('searchbox')).toHaveFocus()
    expect(dialog).not.toHaveClass('application-center--detail')
  })

  it.each([['知识库', 'knowledge'], ['智能心跳', 'heartbeat']])('keeps %s always shown with sorting but no settings or toggles', (title, id) => {
    const handlers = props()
    render(<ApplicationCenter {...handlers} />)
    const card = screen.getByText(title, { exact: true }).closest('article')!
    expect(card).toHaveAttribute('draggable', 'true')
    expect(within(card).getByText('始终显示')).toBeInTheDocument()
    expect(within(card).queryByRole('switch')).not.toBeInTheDocument()
    expect(within(card).getAllByRole('button')).toHaveLength(3)
    fireEvent.click(within(card).getByRole('button', { name: '打开' }))
    expect(handlers.onOpen).toHaveBeenCalledWith(id)
    const notes = screen.getByText('魔法笔记', { exact: true }).closest('article')!
    fireEvent.dragStart(notes)
    fireEvent.drop(card)
    expect(handlers.onUpdate).toHaveBeenCalledWith({ applicationNavigation: {
      ...defaultApplicationNavigation,
      order: id === 'knowledge'
        ? ['magic-notes', 'knowledge', 'heartbeat', 'local-inference']
        : ['knowledge', 'magic-notes', 'heartbeat', 'local-inference'],
    } })
  })
  it('searches disabled and unpinned applications, opens without pinning, and restores focus', () => {
    const handlers = props()
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const { unmount } = render(
      <ApplicationCenter
        {...handlers}
        settings={{
          ...settings,
          localInferenceEnabled: false,
          applicationNavigation: {
            ...defaultApplicationNavigation,
            pinned: {
              ...defaultApplicationNavigation.pinned,
              'magic-notes': false,
            },
          },
        }}
      />,
    )
    const search = screen.getByRole('searchbox', { name: '搜索内置应用' })
    expect(search).toHaveFocus()
    fireEvent.change(search, { target: { value: '笔记' } })
    fireEvent.click(screen.getByRole('button', { name: '打开' }))
    expect(handlers.onOpen).toHaveBeenCalledWith('magic-notes')
    expect(handlers.onUpdate).not.toHaveBeenCalled()
    fireEvent.change(search, { target: { value: '推理' } })
    expect(screen.getByText('已关闭', { exact: false })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '打开' }),
    ).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '本机推理监控 应用设置' }))
    expect(screen.getByRole('switch', { name: '启用应用' })).not.toBeChecked()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(handlers.onClose).toHaveBeenCalledOnce()
    unmount()
    expect(trigger).toHaveFocus()
    trigger.remove()
  })

  it('sorts disabled and unpinned apps and saves pin preferences without optimistic changes', () => {
    const handlers = props()
    render(<ApplicationCenter {...handlers} settings={{ ...settings, localInferenceEnabled: false }} />)
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    const inference = screen.getByText('本机推理监控', { exact: true }).closest('article')!
    expect(inference).toHaveAttribute('draggable', 'true')
    expect(within(inference).getAllByRole('button', { name: /上移|下移/ })).toHaveLength(2)
    expect(screen.getByRole('button', { name: '上移 魔法笔记' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '下移 魔法笔记' })).toBeEnabled()
    const notes = screen.getByText('魔法笔记', { exact: true }).closest('article')!
    fireEvent.dragStart(inference)
    fireEvent.drop(notes)
    fireEvent.dragStart(notes)
    fireEvent.drop(inference)
    expect(handlers.onUpdate).toHaveBeenLastCalledWith({ applicationNavigation: {
      ...defaultApplicationNavigation, order: ['knowledge', 'heartbeat', 'local-inference', 'magic-notes'],
    } })
    fireEvent.click(within(inference).getByRole('button', { name: '打开' }))
    expect(handlers.onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '本机推理监控 应用设置' }))
    expect(screen.getByRole('switch', { name: '启用应用' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: '常驻左侧菜单' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('switch', { name: '常驻左侧菜单' }))
    expect(handlers.onUpdate).toHaveBeenLastCalledWith({
      applicationNavigation: {
        ...defaultApplicationNavigation,
        pinned: { ...defaultApplicationNavigation.pinned, 'local-inference': true },
      },
    })
    expect(
      screen.getByRole('switch', { name: '常驻左侧菜单' }),
    ).not.toBeChecked()
    expect(screen.queryByRole('button', { name: /上移|下移/ })).not.toBeInTheDocument()
  })

  it('orders all app rows, disables full-order boundaries, and waits for confirmed settings', async () => {
    const handlers = props()
    const { rerender } = render(<ApplicationCenter {...handlers} settings={pinnedSettings} />)
    const displayedOrder = () => screen.getAllByRole('article').map((row) => row.querySelector('strong')?.textContent)
    expect(displayedOrder()).toEqual(['知识库', '智能心跳', '魔法笔记', '本机推理监控'])
    expect(screen.getByRole('button', { name: '上移 知识库' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '下移 本机推理监控' })).toBeDisabled()
    const moveUp = screen.getByRole('button', { name: '上移 本机推理监控' })
    expect(moveUp.closest('article')).not.toBeNull()
    expect(moveUp).toHaveAttribute('title', '上移 本机推理监控')
    fireEvent.click(moveUp)
    expect(handlers.onUpdate).toHaveBeenLastCalledWith({
      applicationNavigation: {
        ...pinnedSettings.applicationNavigation,
        order: ['knowledge', 'heartbeat', 'local-inference', 'magic-notes'],
      },
    })
    expect(screen.getByRole('button', { name: '下移 本机推理监控' })).toBeDisabled()
    expect(await screen.findByRole('status')).not.toBeEmptyDOMElement()
    expect(displayedOrder()).toEqual(['知识库', '智能心跳', '魔法笔记', '本机推理监控'])
    rerender(<ApplicationCenter {...handlers} settings={{
      ...pinnedSettings,
      applicationNavigation: { ...pinnedSettings.applicationNavigation, order: ['knowledge', 'heartbeat', 'local-inference', 'magic-notes'] },
    }} />)
    expect(displayedOrder()).toEqual(['知识库', '智能心跳', '本机推理监控', '魔法笔记'])
    expect(screen.getByRole('button', { name: '下移 魔法笔记' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '下移 本机推理监控' }))
    expect(handlers.onUpdate).toHaveBeenLastCalledWith({ applicationNavigation: pinnedSettings.applicationNavigation })
    fireEvent.click(screen.getByRole('button', { name: '本机推理监控 应用设置' }))
    expect(screen.queryByRole('button', { name: /上移|下移/ })).not.toBeInTheDocument()
  })

  it('uses the same order patch for drag and keyboard controls', () => {
    const handlers = props()
    render(<ApplicationCenter {...handlers} settings={pinnedSettings} />)
    const notes = screen
      .getByText('魔法笔记', { exact: true })
      .closest('article')!
    const inference = screen
      .getByText('本机推理监控', { exact: true })
      .closest('article')!
    fireEvent.dragStart(inference)
    fireEvent.dragOver(notes)
    fireEvent.drop(notes)
    expect(handlers.onUpdate).toHaveBeenCalledWith({
      applicationNavigation: {
        ...pinnedSettings.applicationNavigation,
        order: ['knowledge', 'heartbeat', 'local-inference', 'magic-notes'],
      },
    })
  })

  it('locks all preference controls while saving or awaiting a confirmed read', () => {
    const handlers = props()
    const { rerender } = render(<ApplicationCenter {...handlers} />)
    fireEvent.click(screen.getByRole('button', { name: '本机推理监控 应用设置' }))
    rerender(<ApplicationCenter {...handlers} pending />)
    for (const toggle of screen.getAllByRole('switch'))
      expect(toggle).toBeDisabled()
    expect(screen.queryByRole('button', { name: /上移|下移/ })).not.toBeInTheDocument()
    rerender(
      <ApplicationCenter {...handlers} locked error="无法确认保存结果" />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('无法确认保存结果')
    for (const toggle of screen.getAllByRole('switch'))
      expect(toggle).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
    expect(handlers.onRetry).toHaveBeenCalledOnce()
  })

  it.each(['pending', 'locked'] as const)('disables row sorting when %s', (state) => {
    const handlers = props()
    render(<ApplicationCenter {...handlers} settings={pinnedSettings} {...{ [state]: true }} />)
    for (const button of screen.getAllByRole('button', { name: /上移|下移/ }))
      expect(button).toBeDisabled()
    const cards = screen.getAllByRole('article')
    for (const card of cards) expect(card).toHaveAttribute('draggable', 'false')
    fireEvent.dragStart(cards[3]!)
    fireEvent.drop(cards[2]!)
    expect(handlers.onUpdate).not.toHaveBeenCalled()
  })

  it('keeps hidden entries in the full order during search while disabling drag', () => {
    const handlers = props()
    render(<ApplicationCenter {...handlers} settings={pinnedSettings} />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '推理' } })
    const card = screen.getByRole('article')
    expect(card).toHaveAttribute('draggable', 'false')
    expect(within(card).getByRole('button', { name: '下移 本机推理监控' })).toBeDisabled()
    fireEvent.click(within(card).getByRole('button', { name: '上移 本机推理监控' }))
    expect(handlers.onUpdate).toHaveBeenCalledWith({
      applicationNavigation: {
        ...pinnedSettings.applicationNavigation,
        order: ['knowledge', 'heartbeat', 'local-inference', 'magic-notes'],
      },
    })
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
    expect(screen.getAllByRole('article')).toHaveLength(4)
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
