import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectActivity, ProjectActivityCounts } from './ProjectActivity'
import type { ConversationActivity } from './conversation-activity'
import { isBrowserViewportOccluded } from './browser-viewport-occlusion'
import { workspace } from './i18n/locales/en-US/workspace'
import type { AssistantProject } from '../../shared/assistant-contracts'

const i18n = createInstance()
void i18n.init({ lng: 'en', initImmediate: false, resources: { en: { workspace } } })

const activities: ConversationActivity[] = [
  { conversationId: 'running', projectId: 'local', projectName: 'Local', title: 'Build', status: 'running' },
  { conversationId: 'remote-run', projectId: 'remote', projectName: 'Remote', title: 'Deploy', status: 'running' },
  { conversationId: 'question', projectId: 'remote', projectName: 'Remote', title: 'Choose target', status: 'question' },
  { conversationId: 'approval', projectId: 'remote', projectName: 'Remote', title: 'Approve command', status: 'approval' },
  { conversationId: 'unloaded', projectName: 'No project', title: 'Background task', status: 'attention' }
]

function view(rows = activities, onOpenConversation = vi.fn(), projects?: AssistantProject[], visible = true): React.JSX.Element {
  return <I18nextProvider i18n={i18n}>
    <div className="app-shell">
      <button type="button">Destination</button>
      <ProjectActivity activities={rows} onOpenConversation={onOpenConversation} projects={projects} visible={visible} />
    </div>
  </I18nextProvider>
}

function open(): HTMLButtonElement {
  const trigger = screen.getByRole<HTMLButtonElement>('button', { name: /All project activity/ })
  fireEvent.click(trigger)
  return trigger
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ProjectActivity', () => {
  it('keeps an idle summary and an accessible empty menu while hiding zero counts', () => {
    render(view([]))
    const trigger = open()
    expect(trigger).toHaveTextContent('No activity')
    expect(screen.getByRole('menu')).toHaveTextContent('No running conversations')
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(trigger).toHaveFocus()
    const { container } = render(<I18nextProvider i18n={i18n}><ProjectActivityCounts attention={0} running={0} /></I18nextProvider>)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows authoritative counts, stable projects and attention-first conversations', () => {
    render(view())
    expect(open()).toHaveAccessibleName('All project activity: 3 need attention, 2 running')
    const menu = screen.getByRole('menu', { name: 'All project activity' })
    expect(within(menu).getAllByRole('menuitem').map((row) => row.textContent)).toEqual([
      'Local  1 running', 'Remote 2 need attention 1 running', 'No project 1 need attention '
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: /Remote/ }))
    expect(within(screen.getByRole('menu', { name: 'Remote' })).getAllByRole('menuitem').map((row) => row.textContent))
      .toEqual(['Choose target Waiting for your answer', 'Approve command Waiting for approval', 'Deploy Running'])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.querySelector<HTMLElement>('.app-shell')?.inert).not.toBe(true)
  })

  it('uses project metadata order and keeps SSH hosts grouped regardless of activity priority', () => {
    const projects = [
      { id: 'remote', name: 'Remote', kind: 'user', executionSpace: { kind: 'ssh', hostId: 'host-a' } },
      { id: 'channel', name: 'Channel', kind: 'channel', executionSpace: { kind: 'local' } },
      { id: 'local', name: 'Local', kind: 'user', executionSpace: { kind: 'local' } },
      { id: 'other-host', name: 'Other host', kind: 'user', executionSpace: { kind: 'ssh', hostId: 'host-b' } },
      { id: 'same-host', name: 'Same host', kind: 'user', executionSpace: { kind: 'ssh', hostId: 'host-a' } }
    ] as AssistantProject[]
    render(view([...activities, ...projects.slice(1).filter((p) => p.id !== 'local').map((p) => ({
      conversationId: p.id, projectId: p.id, projectName: p.name, title: p.id, status: 'running' as const
    }))], vi.fn(), projects))
    open()
    expect(screen.getAllByRole('menuitem').map((row) => row.querySelector('.project-activity__identity > span')?.textContent))
      .toEqual(['Local', 'Remote', 'Same host', 'Other host', 'Channel', 'No project'])
  })

  it('navigates arrows, Home/End, Enter and two-stage Escape before the sidebar listener', () => {
    render(view())
    const sidebarEscape = vi.fn()
    document.addEventListener('keydown', sidebarEscape)
    const trigger = open()
    const local = screen.getByRole('menuitem', { name: /Local/ })
    const remote = screen.getByRole('menuitem', { name: /Remote/ })
    expect(local).toHaveFocus()
    fireEvent.keyDown(local, { key: 'ArrowDown' })
    expect(remote).toHaveFocus()
    fireEvent.keyDown(remote, { key: 'ArrowRight' })
    const first = screen.getByRole('menuitem', { name: 'Choose target Waiting for your answer' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'End' })
    expect(screen.getByRole('menuitem', { name: 'Deploy Running' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(screen.getByRole('menuitem', { name: 'Approve command Waiting for approval' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(first).toHaveFocus()
    sidebarEscape.mockClear()
    fireEvent.keyDown(first, { key: 'Escape' })
    expect(remote).toHaveFocus()
    expect(screen.queryByRole('menu', { name: 'Remote' })).not.toBeInTheDocument()
    fireEvent.keyDown(remote, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(sidebarEscape).not.toHaveBeenCalled()
    document.removeEventListener('keydown', sidebarEscape)
  })

  it('navigates the exact unloaded conversation after closing without stealing destination focus', () => {
    const onOpen = vi.fn(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      screen.getByRole('button', { name: 'Destination' }).focus()
    })
    render(view(activities, onOpen))
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: /No project/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Background task Needs attention' }))
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('unloaded')
    expect(screen.getByRole('button', { name: 'Destination' })).toHaveFocus()
  })

  it('keeps the submenu open across the adjoining pointer boundary', () => {
    render(view())
    open()
    const remote = screen.getByRole('menuitem', { name: /Remote/ })
    // jsdom does not provide PointerEvent's pointerType.
    const event = new MouseEvent('pointerover', { bubbles: true })
    Object.defineProperty(event, 'pointerType', { value: 'mouse' })
    fireEvent(remote, event)
    const menu = screen.getByRole('menu', { name: 'Remote' })
    fireEvent.pointerLeave(remote)
    fireEvent.pointerEnter(menu)
    expect(menu).toBeInTheDocument()
    expect(remote).toHaveAttribute('aria-expanded', 'true')
  })

  it('dismisses on outside pointer, focus, Tab and toggle with focus restoration', () => {
    render(view())
    const trigger = open()
    fireEvent.pointerDown(document.body)
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    open()
    act(() => screen.getByRole('button', { name: 'Destination' }).focus())
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Destination' })).toHaveFocus()
    open()
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    open()
    fireEvent.click(trigger)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('preserves live focus and recovers when the selected project drains', () => {
    const { rerender } = render(view())
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: /Remote/ }))
    const row = screen.getByRole('menuitem', { name: 'Choose target Waiting for your answer' })
    rerender(view(activities.filter((activity) => activity.status !== 'running')))
    expect(row).toHaveFocus()
    rerender(view(activities.filter((activity) => activity.projectId === 'local')))
    expect(screen.getByRole('menuitem', { name: /Local/ })).toHaveFocus()
    rerender(view([]))
    expect(screen.getByRole('menu')).toHaveTextContent('No running conversations')
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    rerender(view())
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes when the sidebar is hidden', () => {
    const { rerender } = render(view())
    open()
    rerender(view(activities, vi.fn(), undefined, false))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('positions beside the anchor, falls left and drills down in a narrow viewport', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(900)
    render(view())
    const trigger = screen.getByRole('button', { name: /All project activity/ })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(600, 100, 200, 32))
    open()
    const menu = screen.getByRole('menu', { name: 'All project activity' })
    fireEvent.click(screen.getByRole('menuitem', { name: /Remote/ }))
    expect(menu).toHaveAttribute('data-left', 'true')
    expect(menu.style.left).toBe('336px')
    expect(menu.style.top).toBe('136px')
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(400)
    fireEvent(window, new Event('resize'))
    expect(menu).toHaveAttribute('data-compact', 'true')
    expect(menu.style.width).toBe('264px')
    fireEvent.click(screen.getByRole('button', { name: 'Back to projects' }))
    expect(screen.getByRole('menuitem', { name: /Remote/ })).toHaveFocus()
    expect(menu).toHaveAttribute('data-submenu', 'false')
  })

  it('uses shared native-browser occlusion only where menus intersect the viewport', () => {
    render(view())
    open()
    const menu = screen.getByRole('menu')
    vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 10, 264, 200))
    const host = screen.getByRole('button', { name: 'Destination' })
    expect(isBrowserViewportOccluded(host, new DOMRect(200, 10, 500, 500))).toBe(true)
    expect(isBrowserViewportOccluded(host, new DOMRect(400, 10, 500, 500))).toBe(false)
  })
})
