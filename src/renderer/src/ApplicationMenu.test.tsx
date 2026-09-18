import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { applicationSettingsSchema, defaultLocalToolEnvironmentSettings, type ApplicationSettings } from '../../shared/application-settings-contracts'
import { ApplicationMenu } from './ApplicationMenu'
import { isBrowserViewportOccluded } from './browser-viewport-occlusion'

const settings = applicationSettingsSchema.parse({
  checkUpdatesOnStartup: false, updateSource: 'github', modelDownloadSource: 'modelscope',
  localToolEnvironment: defaultLocalToolEnvironmentSettings,
  conversationHtmlRenderingEnabled: true, remoteProjectsEnabled: false,
})
function Harness({ value = settings, pending = false, error, onOpen = vi.fn(), onManage = vi.fn(), onRetry = vi.fn() }: {
  value?: ApplicationSettings | null; pending?: boolean; error?: string
  onOpen?: (id: string) => void; onManage?: () => void; onRetry?: () => void
}): React.JSX.Element {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return <><button ref={anchorRef} onClick={() => setOpen(!open)}>Launcher</button><button>Outside</button>
    {open && <ApplicationMenu anchorRef={anchorRef} settings={value ?? undefined} pending={pending} error={error}
      onClose={() => setOpen(false)} onOpen={onOpen} onManage={onManage} onRetry={onRetry} />}</>
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('filters the shared order by enablement only, including reordered always-shown apps', () => {
  const value = { ...settings, magicNotesEnabled: true, localInferenceEnabled: true,
    applicationNavigation: { order: ['local-inference', 'heartbeat', 'magic-notes', 'knowledge'] as ApplicationSettings['applicationNavigation']['order'],
      pinned: { 'magic-notes': false, 'local-inference': false } } }
  const onOpen = vi.fn()
  const { rerender } = render(<Harness value={value} onOpen={onOpen} />)
  fireEvent.click(screen.getByText('Launcher'))
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['本机推理监控', '智能心跳', '魔法笔记', '知识库', '管理应用'])
  rerender(<Harness value={{ ...value, magicNotesEnabled: false }} onOpen={onOpen} />)
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['本机推理监控', '智能心跳', '知识库', '管理应用'])
  fireEvent.click(screen.getByRole('menuitem', { name: '本机推理监控' }))
  expect(onOpen).toHaveBeenCalledWith('local-inference')
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})

it('shows loading and actionable errors without treating unknown settings as disabled', () => {
  const onRetry = vi.fn()
  const { rerender } = render(<Harness value={null} pending onRetry={onRetry} />)
  fireEvent.click(screen.getByText('Launcher'))
  expect(screen.getByRole('status')).toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: '知识库' })).toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: '智能心跳' })).toBeInTheDocument()
  rerender(<Harness value={null} error="Cannot read settings" onRetry={onRetry} />)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('Cannot read settings')
  fireEvent.click(screen.getByRole('menuitem', { name: '重新读取' }))
  expect(onRetry).toHaveBeenCalledOnce()
})

it('supports arrow, Home, End, Escape, outside focus and pointer dismissal and management focus handoff', () => {
  const onManage = vi.fn()
  render(<Harness onManage={onManage} />)
  const trigger = screen.getByText('Launcher')
  fireEvent.click(trigger)
  const items = screen.getAllByRole('menuitem')
  expect(items[0]).toHaveFocus()
  fireEvent.keyDown(document.activeElement!, { key: 'End' })
  expect(items.at(-1)).toHaveFocus()
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  expect(items[0]).toHaveFocus()
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
  expect(items.at(-1)).toHaveFocus()
  fireEvent.keyDown(document.activeElement!, { key: 'Home' })
  expect(items[0]).toHaveFocus()
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(trigger).toHaveFocus()
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  fireEvent.click(trigger)
  act(() => screen.getByText('Outside').focus())
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(screen.getByText('Outside')).toHaveFocus()
  fireEvent.click(trigger)
  fireEvent.pointerDown(screen.getByText('Outside'))
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('menuitem', { name: '管理应用' }))
  expect(onManage).toHaveBeenCalledOnce()
  expect(trigger).toHaveFocus()
})

it('anchors upward, clamps to a narrow viewport, repositions on resize and uses shared native viewport occlusion', () => {
  vi.stubGlobal('innerWidth', 320)
  vi.stubGlobal('innerHeight', 400)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.getAttribute('role') === 'menu' ? new DOMRect(24, 92, 280, 200) : new DOMRect(270, 300, 34, 34)
  })
  render(<Harness />)
  fireEvent.click(screen.getByText('Launcher'))
  const menu = screen.getByRole('menu')
  expect(menu).toHaveStyle({ left: '24px', top: '92px', width: '280px', maxHeight: '276px' })
  const host = screen.getByText('Outside')
  expect(isBrowserViewportOccluded(host, new DOMRect(200, 100, 100, 100))).toBe(true)
  expect(isBrowserViewportOccluded(host, new DOMRect(400, 100, 100, 100))).toBe(false)
  vi.stubGlobal('innerWidth', 240)
  vi.stubGlobal('innerHeight', 220)
  fireEvent(window, new Event('resize'))
  expect(menu).toHaveStyle({ left: '16px', top: '16px', width: '208px', maxHeight: '188px' })
  fireEvent.keyDown(menu, { key: 'Tab' })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(isBrowserViewportOccluded(host, new DOMRect(200, 100, 100, 100))).toBe(false)
})
