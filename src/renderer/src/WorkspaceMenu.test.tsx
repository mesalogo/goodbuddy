import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Profiler } from 'react'
import type { AssistantProject } from '../../shared/assistant-contracts'
import type { Conversation } from './chat-conversation'
import type { ConversationActivity } from './conversation-activity'
import { createConversationStores } from './conversation-store'
import { ProjectSwitcher } from './ProjectSwitcher'
import i18n from './i18n'

const local: AssistantProject = {
  id: 'local', name: 'Local workspace', description: '', rootPath: 'C:/workspace',
  executionSpace: { kind: 'local', rootPath: 'C:/workspace' }, defaultWorkMode: 'ask',
  kind: 'user', status: 'active', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z'
}
const other = { ...local, id: 'other', name: 'Other workspace', rootPath: 'C:/other' }
const conversation = (id: string, projectId = local.id, updatedAt = 1): Conversation => ({ id, projectId, title: id, updatedAt, messages: [] })

function setup({ projects = [local, other], conversations = [conversation('Local chat'), conversation('Other chat', other.id)],
  activities = [] as ConversationActivity[], remoteProjectsEnabled = false } = {}) {
  const store = createConversationStores(conversations, { flushIntervalMs: 250 }).conversations
  const actions = { onArchive: vi.fn(), onCreate: vi.fn(), onDelete: vi.fn(), onRemoteCommitted: vi.fn(),
    onSelect: vi.fn(), onSelectRoot: vi.fn(), onUpdate: vi.fn(), onOpenConversation: vi.fn(), onNewConversation: vi.fn() }
  const props = { ...actions, projects, conversationStore: store, activeProjectId: local.id, activities, remoteProjectsEnabled }
  const renders = vi.fn()
  const view = render(<Profiler id="workspace" onRender={renders}><ProjectSwitcher {...props} /></Profiler>)
  return { ...view, actions, store, props, renders }
}

afterEach(async () => { cleanup(); vi.restoreAllMocks(); await i18n.changeLanguage('zh-CN') })

describe('production workspace menu', () => {
  it('opens with all projects and clears the previous preview when reopened', async () => {
    await i18n.changeLanguage('en-US')
    const { actions } = setup()
    const trigger = screen.getByRole('button', { name: 'Current project' })
    fireEvent.click(trigger)
    const assertAllProjects = (): void => {
      const region = screen.getByRole('region', { name: 'All projects' })
      expect(within(region).getByRole('button', { name: /^Local chat/ })).toBeVisible()
      expect(within(region).getByRole('button', { name: /^Other chat/ })).toBeVisible()
      expect(document.querySelector('[data-preview="true"]')).toBeNull()
    }
    assertAllProjects()
    fireEvent.pointerOver(screen.getByRole('menuitemradio', { name: /Other workspace/ }), { pointerType: 'mouse' })
    expect(screen.getByRole('region', { name: other.name })).toBeVisible()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    fireEvent.click(trigger)
    assertAllProjects()
    expect(actions.onSelect).not.toHaveBeenCalled()
  })

  it('puts All Projects first in a fixed tab row and filters categories only when activated', async () => {
    await i18n.changeLanguage('en-US')
    const remote: AssistantProject = { ...other, id: 'remote', name: 'Remote workspace', rootPath: '/srv/workspace',
      executionSpace: { kind: 'ssh', hostId: 'host', remoteRootPath: '/srv/workspace' } }
    const channel: AssistantProject = { ...other, id: 'channel', name: 'Team channel', kind: 'channel', channel: 'wecom' }
    const { actions } = setup({ projects: [local, remote, channel], remoteProjectsEnabled: true,
      conversations: [conversation('Local chat'), conversation('Remote chat', remote.id)] })
    fireEvent.click(screen.getByRole('button', { name: 'Current project' }))
    const tabs = screen.getByRole('tablist', { name: 'Project categories' })
    expect(within(tabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['All projects', 'Local', 'Remote', 'Channels'])
    const list = screen.getByRole('menu', { name: 'Current project' })
    expect(list).not.toContainElement(tabs)
    expect(Array.from(list.querySelectorAll('.workspace-menu__project-category'), (heading) => heading.textContent))
      .toEqual(['Local', 'Remote', 'Channels'])
    const all = within(tabs).getByRole('tab', { name: 'All projects' })
    fireEvent.click(all)
    expect(screen.getByRole('region', { name: 'All projects' })).toHaveClass('workspace-menu__activity')
    expect(within(list).getAllByRole('menuitemradio')).toHaveLength(3)
    fireEvent.pointerOver(within(tabs).getByRole('tab', { name: 'Channels' }), { pointerType: 'mouse' })
    expect(all).toHaveAttribute('aria-selected', 'true')
    expect(within(list).getAllByRole('menuitemradio')).toHaveLength(3)

    for (const [label, project] of [['Local', local], ['Remote', remote], ['Channels', channel]] as const) {
      const tab = within(tabs).getByRole('tab', { name: label })
      fireEvent.click(tab)
      expect(tab).toHaveAttribute('aria-selected', 'true')
      const panel = screen.getByRole('tabpanel', { name: label })
      expect(tab).toHaveAttribute('aria-controls', panel.id)
      expect(panel).toContainElement(list)
      expect(within(list).getAllByRole('menuitemradio')).toHaveLength(1)
      expect(within(list).getByRole('menuitemradio', { name: new RegExp(project.name) })).toBeVisible()
    }
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'workspace' } })
    expect(within(list).getAllByRole('menuitemradio')).toHaveLength(2)
    expect(within(list).getByRole('menuitemradio', { name: /Local workspace/ })).toBeVisible()
    const remoteRow = within(list).getByRole('menuitemradio', { name: /Remote workspace/ })
    fireEvent.pointerOver(remoteRow, { pointerType: 'mouse' })
    const preview = screen.getByRole('region', { name: remote.name })
    expect(within(preview).getByRole('button', { name: 'Remote chat' })).toBeVisible()
    expect(within(preview).queryByText(remote.name)).not.toBeInTheDocument()
    expect(within(tabs).getByRole('tab', { name: 'Channels' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    expect(within(list).getAllByRole('menuitemradio')).toHaveLength(1)
    expect(within(list).getByRole('menuitemradio', { name: /Team channel/ })).toBeVisible()
    fireEvent.pointerOver(all, { pointerType: 'mouse' })
    expect(screen.getByRole('region', { name: remote.name })).toBeVisible()
    fireEvent.click(all)
    expect(within(list).getAllByRole('menuitemradio')).toHaveLength(3)
    expect(within(screen.getByRole('region', { name: 'All projects' })).getByText(remote.name)).toBeVisible()
    expect(actions.onSelect).not.toHaveBeenCalled()
    expect(actions.onOpenConversation).not.toHaveBeenCalled()
    expect(actions.onNewConversation).not.toHaveBeenCalled()
  })

  it('keeps shared tab keyboard selection and omits Remote when it is disabled', async () => {
    await i18n.changeLanguage('en-US')
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Current project' }))
    const tabs = screen.getByRole('tablist', { name: 'Project categories' })
    expect(within(tabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['All projects', 'Local', 'Channels'])
    const all = within(tabs).getByRole('tab', { name: 'All projects' })
    expect(all).toHaveFocus()
    fireEvent.keyDown(all, { key: 'ArrowRight' })
    const localTab = within(tabs).getByRole('tab', { name: 'Local' })
    expect(localTab).toHaveFocus()
    expect(localTab).toHaveAttribute('aria-selected', 'true')
    expect(all).toHaveAttribute('tabindex', '-1')
    fireEvent.keyDown(localTab, { key: 'End' })
    expect(within(tabs).getByRole('tab', { name: 'Channels' })).toHaveFocus()
    expect(screen.getByRole('tabpanel', { name: 'Channels' })).not.toContainElement(screen.queryByRole('menuitemradio'))
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(all).toHaveFocus()
    expect(screen.getByRole('region', { name: 'All projects' })).toBeVisible()
  })

  it('previews without navigation or IPC, keeps current separate, and manages settings independently', async () => {
    await i18n.changeLanguage('en-US')
    const get = vi.fn()
    const listSummaries = vi.fn()
    const original = window.goodbuddy
    Object.defineProperty(window, 'goodbuddy', { configurable: true, value: { conversations: { get, listSummaries } } })
    try {
      const { actions } = setup()
      const trigger = screen.getByRole('button', { name: 'Current project' })
      fireEvent.click(trigger)
      const current = screen.getByRole('menuitemradio', { name: /Local workspace/ })
      const target = screen.getByRole('menuitemradio', { name: /Other workspace/ })
      fireEvent.pointerOver(target, { pointerType: 'mouse' })
      const list = screen.getByRole('list', { name: 'Conversations' })
      expect(within(list).getByRole('button', { name: 'Other chat' })).toBeVisible()
      expect(within(list).queryByText('Other workspace')).not.toBeInTheDocument()
      const scopedPane = screen.getByRole('region', { name: 'Other workspace' })
      expect(scopedPane).toHaveClass('workspace-menu__activity')
      expect(within(scopedPane).queryByText('Other workspace')).not.toBeInTheDocument()
      expect(current).toHaveAttribute('aria-checked', 'true')
      expect(target).toHaveAttribute('aria-checked', 'false')
      expect(actions.onSelect).not.toHaveBeenCalled()
      expect(actions.onOpenConversation).not.toHaveBeenCalled()
      expect(get).not.toHaveBeenCalled()
      expect(listSummaries).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('menuitem', { name: 'Manage project Other workspace' }))
      expect(screen.getByRole('dialog', { name: 'Project settings' })).toBeVisible()
      expect(actions.onSelect).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Close project settings' }))
      expect(trigger).toHaveFocus()
      fireEvent.click(trigger)
      fireEvent.click(screen.getByRole('menuitemradio', { name: /Other workspace/ }))
      expect(actions.onSelect).toHaveBeenCalledExactlyOnceWith(other.id)
      expect(screen.queryByRole('dialog', { name: 'Projects and activity' })).not.toBeInTheDocument()
    } finally {
      Object.defineProperty(window, 'goodbuddy', { configurable: true, value: original })
    }
  })

  it('opens all-project activity from the unified button', async () => {
    await i18n.changeLanguage('en-US')
    const conversations = Array.from({ length: 12 }, (_, i) => conversation(`Finished ${i}`, local.id, 100 - i))
    const activities: ConversationActivity[] = conversations.map((row) => ({ conversationId: row.id, projectId: local.id,
      projectName: local.name, title: row.title, status: 'completed' }))
    activities.push({ conversationId: 'Running', projectId: other.id, projectName: other.name, title: 'Running chat', status: 'running' })
    const { actions, rerender, props } = setup({ conversations, activities })
    const trigger = screen.getByRole('button', { name: 'Current project' })
    expect(screen.getAllByRole('button')).toEqual([trigger])
    expect(trigger).toHaveAccessibleDescription('1 running 12 completed')
    fireEvent.click(within(trigger).getByText('12 completed'))
    const menu = screen.getByRole('dialog', { name: 'Projects and activity' })
    expect(trigger).toHaveAttribute('aria-controls', menu.id)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('region', { name: 'All projects' })).toBeVisible()
    const all = screen.getByRole('tab', { name: 'All projects' })
    expect(all).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('tab')[0]).toBe(all)
    const list = screen.getByRole('list', { name: 'Conversations' })
    expect(within(list).getByText('Running chat')).toBeVisible()
    expect(within(list).getAllByRole('button')).toHaveLength(11)
    expect(within(list).getAllByText(local.name)).toHaveLength(10)
    fireEvent.click(within(screen.getByRole('group', { name: 'Filter conversation status' })).getByRole('button', { name: 'Completed' }))
    expect(within(list).getAllByRole('button')).toHaveLength(12)
    fireEvent.click(within(list).getByRole('button', { name: /Finished 0/ }))
    expect(actions.onOpenConversation).toHaveBeenCalledExactlyOnceWith('Finished 0')
    rerender(<ProjectSwitcher {...props} activities={activities.filter((row) => row.conversationId !== 'Finished 0')} />)
    fireEvent.click(screen.getByRole('button', { name: 'Current project' }))
    expect(within(screen.getByRole('list', { name: 'Conversations' })).getByRole('button', { name: /^Finished 0 / })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'All projects' })).toBeVisible()
  })

  it('searches across categories, creates in preview scope, and explains channel restrictions', async () => {
    await i18n.changeLanguage('en-US')
    const channel: AssistantProject = { ...other, id: 'channel', name: 'Team channel', kind: 'channel', channel: 'wecom' }
    const { actions } = setup({ projects: [local, other, channel] })
    fireEvent.click(screen.getByRole('button', { name: 'Current project' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Local' }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'team' } })
    expect(screen.queryByRole('menuitemradio', { name: /Local workspace/ })).not.toBeInTheDocument()
    const channelRow = screen.getByRole('menuitemradio', { name: /Team channel/ })
    fireEvent.pointerOver(channelRow, { pointerType: 'mouse' })
    expect(screen.getByRole('button', { name: 'New conversation' })).toBeDisabled()
    expect(screen.getByText(/automatically/i, { selector: '.workspace-menu__channel-note' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'C:/other' } })
    fireEvent.pointerOver(screen.getByRole('menuitemradio', { name: /Other workspace/ }), { pointerType: 'mouse' })
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }))
    expect(actions.onNewConversation).toHaveBeenCalledExactlyOnceWith(other.id)
  })

  it('windows large project lists while keyboard End reaches the last row and Escape restores focus', async () => {
    await i18n.changeLanguage('en-US')
    setup({ projects: [local, ...Array.from({ length: 400 }, (_, i) => ({ ...other, id: `p${i}`, name: `Project ${i}` }))] })
    const trigger = screen.getByRole('button', { name: 'Current project' })
    fireEvent.click(trigger)
    expect(screen.getAllByRole('menuitemradio').length).toBeLessThan(120)
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Current project' }), { key: 'End' })
    expect(screen.getByRole('menuitemradio', { name: /Project 399/ })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('does not rerender the menu for message content deltas with unchanged summaries', async () => {
    await i18n.changeLanguage('en-US')
    const initial = { ...conversation('Streaming chat'), messages: [{ id: 'm', role: 'assistant' as const, content: 'first', createdAt: 1, state: 'streaming' as const }] }
    const { store, renders } = setup({ conversations: [initial] })
    act(() => store.rememberOpened(initial.id))
    fireEvent.click(screen.getByRole('button', { name: 'Current project' }))
    const activityTimes = store.getActivityTimes()
    renders.mockClear()
    act(() => store.set((rows) => rows.map((row) => ({ ...row, updatedAt: Date.now(), messages: [{ ...initial.messages[0]!, content: 'streaming text' }] }))))
    expect(renders).not.toHaveBeenCalled()
    expect(store.getActivityTimes()).toBe(activityTimes)
  })

  it('records activity transitions while closed and promotes task-only completions when opened', async () => {
    await i18n.changeLanguage('en-US')
    const conversations = Array.from({ length: 12 }, (_, i) => conversation(`Recent ${i}`, local.id, 1000 - i))
    const activity: ConversationActivity = { conversationId: 'task-only', projectId: local.id,
      projectName: local.name, title: 'Older background task', status: 'running' }
    const { rerender, props, store } = setup({ conversations, activities: [activity] })
    rerender(<ProjectSwitcher {...props} activities={[{ ...activity, status: 'completed' }]} />)
    expect(store.getActivityTimes().get(activity.conversationId)).toBeGreaterThan(1000)
    fireEvent.click(screen.getByRole('button', { name: 'Current project' }))
    const rows = within(screen.getByRole('list', { name: 'Conversations' })).getAllByRole('button')
    expect(rows).toHaveLength(10)
    expect(rows[0]).toHaveTextContent(activity.title)
  })

  it('keeps a long completed list bounded and lets the keyboard open its last exact ID', async () => {
    await i18n.changeLanguage('en-US')
    const conversations = Array.from({ length: 300 }, (_, i) => conversation(`Result ${i}`, local.id, 1000 - i))
    const activities: ConversationActivity[] = conversations.map((row) => ({ conversationId: row.id, projectId: local.id,
      projectName: local.name, title: row.title, status: 'completed' }))
    const { actions } = setup({ conversations, activities })
    fireEvent.click(screen.getByRole('button', { name: 'Current project' }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Filter conversation status' })).getByRole('button', { name: 'Completed' }))
    const list = screen.getByRole('list', { name: 'Conversations' })
    expect(within(list).getAllByRole('button').length).toBeLessThan(120)
    fireEvent.keyDown(list, { key: 'End' })
    const last = within(list).getByRole('button', { name: 'Result 299 Completed' })
    expect(last).toHaveFocus()
    expect(last.closest('[role="listitem"]')).toHaveAttribute('aria-setsize', '300')
    fireEvent.click(last)
    expect(actions.onOpenConversation).toHaveBeenCalledExactlyOnceWith('Result 299')
  })
})
