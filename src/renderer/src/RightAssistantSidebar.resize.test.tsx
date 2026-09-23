import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalSnapshot } from '../../shared/terminal-contracts'
import { workbarLayoutPreferencesSchema } from '../../shared/workbar-contracts'
import { DEFAULT_WORKBAR_INSTANCES } from './WorkbarShell'
import i18n from './i18n'
import type {
  AssistantProject,
  AssistantTask,
  WorkspaceFilePreview
} from '../../shared/assistant-contracts'
import type {
  BrowserCreateTabRequest,
  BrowserLiveState,
  BrowserSetViewportRequest,
  BrowserTabId,
  BrowserTabSummary
} from '../../shared/contracts'
import {
  RightAssistantSidebar,
  type AssistantSidebarTab,
  type PendingSidebarApproval,
  type SidebarArtifact
} from './RightAssistantSidebar'

vi.mock('./TerminalPanel', () => ({
  TerminalPanel: ({ onSessionChange, onRename, title }: {
    onSessionChange?: (snapshot: TerminalSnapshot) => void
    onRename: (title: string) => void
    title: string
  }) => (
    <>
      <input
        aria-label="Test terminal name"
        onChange={(event) => onRename(event.target.value)}
        value={title}
      />
      <button
        onClick={() => onSessionChange?.({
          sessionId: '00000000-0000-4000-8000-000000000498',
          state: 'running'
        } as TerminalSnapshot)}
        type="button"
      >
        Start test terminal
      </button>
    </>
  )
}))

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('zh-CN')
})

const firstBrowserTabId =
  '00000000-0000-4000-8000-000000000401' as BrowserTabId
const secondBrowserTabId =
  '00000000-0000-4000-8000-000000000402' as BrowserTabId
const browserStateListeners = new Set<(state: BrowserLiveState) => void>()
const browserApi = {
  createTab: vi.fn<(request: BrowserCreateTabRequest) => Promise<BrowserTabSummary>>(),
  closeTab: vi.fn(async () => undefined),
  setViewport: vi.fn<
    (request: BrowserSetViewportRequest) => Promise<void>
  >(async () => undefined),
  onState: (listener: (state: BrowserLiveState) => void) => {
    browserStateListeners.add(listener)
    return () => { browserStateListeners.delete(listener) }
  }
}

function browserSummary(
  conversationId: string,
  tabId: BrowserTabId,
  primary: boolean
): BrowserTabSummary {
  return {
    conversationId,
    tabId,
    primary,
    status: 'ready',
    isLoading: false,
    canGoBack: false,
    createdAt: 1,
    updatedAt: 1
  }
}

beforeEach(() => {
  localStorage.clear()
  browserStateListeners.clear()
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1400
  })
  browserApi.createTab.mockReset()
  browserApi.closeTab.mockReset().mockResolvedValue(undefined)
  browserApi.setViewport.mockReset().mockResolvedValue(undefined)
  const tabsByOwner = new Map<string, BrowserTabId>()
  browserApi.createTab.mockImplementation(async ({ conversationId, workbarInstanceId }) => {
    const ownershipKey = `${conversationId}:${workbarInstanceId}`
    let tabId = tabsByOwner.get(ownershipKey)
    if (!tabId) {
      tabId = tabsByOwner.size === 0 ? firstBrowserTabId : secondBrowserTabId
      tabsByOwner.set(ownershipKey, tabId)
    }
    return browserSummary(conversationId, tabId, tabsByOwner.size === 1)
  })
  Object.defineProperty(window, 'goodbuddy', {
    configurable: true,
    value: { browser: browserApi }
  })
})

const currentProject: AssistantProject = {
  id: '00000000-0000-4000-8000-000000000301',
  name: '当前项目',
  description: '',
  rootPath: 'D:\\project',
  defaultWorkMode: 'ask',
  kind: 'user',
  executionSpace: { kind: 'local', rootPath: 'D:\\project' },
  status: 'active',
  createdAt: '2026-09-09T00:00:00.000Z',
  updatedAt: '2026-09-09T00:00:00.000Z'
}

function sidebarElement({
  open = true,
  tab = 'tasks',
  approvals = [],
  artifacts = [],
  onListWorkspaceDirectory = vi.fn(async (path: string) => ({
    path,
    entries: [],
    truncated: false
  })),
  onLoadArtifact = vi.fn(async () => undefined),
  onLoadWorkspaceFile = vi.fn(),
  tasks = [],
  activeProject = currentProject,
  workspaceProjectId,
  restoreFocusRef,
  activeConversationId,
  supervisionEnabled,
  supervisionLibraries,
  conversationStats,
  taskDurations,
  selectedTaskId,
  browserStates,
  onBackBrowser,
  onNavigateBrowser,
  onReloadBrowser,
  onStopLoadingBrowser,
  onOpenTask = vi.fn(),
  onCreateCustomTask = vi.fn(),
  onRespondApproval = vi.fn(),
  onTabChange = vi.fn()
}: {
  open?: boolean
  tab?: AssistantSidebarTab
  approvals?: PendingSidebarApproval[]
  artifacts?: SidebarArtifact[]
  onListWorkspaceDirectory?: (
    path: string
  ) => Promise<{
    path: string
    entries: {
      name: string
      path: string
      type: 'file' | 'directory'
    }[]
    truncated: boolean
  }>
  onLoadArtifact?: (artifactId: string) => Promise<void>
  onLoadWorkspaceFile?: (
    path: string,
    offsetBytes?: number
  ) => Promise<WorkspaceFilePreview>
  tasks?: AssistantTask[]
  activeProject?: AssistantProject | null
  workspaceProjectId?: string
  restoreFocusRef?: { current: HTMLElement | null }
  activeConversationId?: string
  supervisionEnabled?: boolean
  supervisionLibraries?: React.ComponentProps<typeof RightAssistantSidebar>['supervisionLibraries']
  conversationStats?: React.ComponentProps<typeof RightAssistantSidebar>['conversationStats']
  taskDurations?: React.ComponentProps<typeof RightAssistantSidebar>['taskDurations']
  selectedTaskId?: string
  browserStates?: Readonly<Record<string, Readonly<Record<string, BrowserLiveState>>>>
  onBackBrowser?: (conversationId: string, tabId: BrowserTabId) => Promise<void>
  onNavigateBrowser?: (conversationId: string, tabId: BrowserTabId, url: string) => Promise<void>
  onReloadBrowser?: (conversationId: string, tabId: BrowserTabId) => Promise<void>
  onStopLoadingBrowser?: (conversationId: string, tabId: BrowserTabId) => Promise<void>
  onOpenTask?: (task: AssistantTask) => void
  onCreateCustomTask?: () => void
  onRespondApproval?: React.ComponentProps<typeof RightAssistantSidebar>['onRespondApproval']
  onTabChange?: (tab: AssistantSidebarTab) => void
} = {}): React.JSX.Element {
  return (
    <div>
      <main className="workspace" />
      <RightAssistantSidebar
        approvals={approvals}
        activeConversationId={activeConversationId}
        supervisionEnabled={supervisionEnabled}
        supervisionLibraries={supervisionLibraries}
        conversationStats={conversationStats}
        taskDurations={taskDurations}
        selectedTaskId={selectedTaskId}
        artifacts={artifacts}
        browserStates={browserStates}
        schedules={[]}
        tasks={tasks}
        conversationTitles={new Map()}
        currentProject={activeProject ?? undefined}
        projectNames={new Map()}
        onCreateCustomTask={onCreateCustomTask}
        onBackBrowser={onBackBrowser}
        onImportArtifacts={vi.fn(async () => undefined)}
        onListWorkspaceDirectory={onListWorkspaceDirectory}
        onLoadArtifact={onLoadArtifact}
        onLoadWorkspaceFile={onLoadWorkspaceFile}
        onNavigateBrowser={onNavigateBrowser}
        onLoadWorkspaceDiff={vi.fn()}
        onOpenWorkspaceEntry={vi.fn(async () => undefined)}
        onRefreshChanges={vi.fn(async () => undefined)}
        onReloadBrowser={onReloadBrowser}
        onRemoveSchedule={vi.fn(async () => undefined)}
        onRespondApproval={onRespondApproval}
        onRunSchedule={vi.fn(async () => undefined)}
        onSetScheduleEnabled={vi.fn(async () => undefined)}
        onStopLoadingBrowser={onStopLoadingBrowser}
        onOpenTask={onOpenTask}
        onTabChange={onTabChange}
        open={open}
        restoreFocusRef={restoreFocusRef}
        tab={tab}
        workspaceProjectId={workspaceProjectId}
      />
    </div>
  )
}

function renderSidebar(options: Parameters<typeof sidebarElement>[0] = {}): HTMLElement {
  render(sidebarElement(options))
  const taskListToggle = screen.queryByRole('button', { name: /^项目任务 /u })
  if (taskListToggle) fireEvent.click(taskListToggle)
  return screen.getByRole('complementary', {
    name: '助手工作栏'
  })
}

it.each([false, undefined])('does not mount or query supervision when enabled is %s', async (supervisionEnabled) => {
  const overview = vi.fn(async () => [])
  const onCreateCustomTask = vi.fn()
  Object.assign(window.goodbuddy, { supervision: { overview } })
  const view = render(sidebarElement({ activeConversationId: 'A', supervisionEnabled, onCreateCustomTask }))
  expect(screen.queryByRole('region', { name: '监督反馈' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '固定监督目标' })).not.toBeInTheDocument()
  expect(overview).not.toHaveBeenCalled()
  expect(screen.getByRole('region', { name: '当前会话统计' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
  expect(onCreateCustomTask).toHaveBeenCalledOnce()

  view.rerender(sidebarElement({ activeConversationId: 'A', supervisionEnabled: true }))
  await waitFor(() => expect(overview).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: '固定监督目标' }))
  view.rerender(sidebarElement({ activeConversationId: 'B', supervisionEnabled }))
  expect(screen.queryByRole('region', { name: '监督反馈' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '取消固定监督目标' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '刷新监督回顾' })).not.toBeInTheDocument()
  expect(overview).toHaveBeenCalledOnce()
  expect(screen.getByRole('region', { name: '当前会话统计' })).toBeVisible()
})

it('pins the supervision target across conversation switches and restores following when unpinned', async () => {
  const overview = vi.fn(async () => [])
  Object.assign(window.goodbuddy, { supervision: { overview } })
  const view = render(sidebarElement({ activeConversationId: 'A', supervisionEnabled: true }))
  await waitFor(() => expect(overview).toHaveBeenLastCalledWith({ target: { type: 'conversation', conversationId: 'A' } }))
  fireEvent.click(screen.getByRole('button', { name: '固定监督目标' }))
  view.rerender(sidebarElement({ activeConversationId: 'B', supervisionEnabled: true }))
  expect(screen.getByRole('button', { name: '取消固定监督目标' })).toBeInTheDocument()
  expect(overview).toHaveBeenLastCalledWith({ target: { type: 'conversation', conversationId: 'A' } })
  expect(localStorage.getItem('goodbuddy.workbar-layout.v1')).toContain('"conversationId":"A"')
  fireEvent.click(screen.getByRole('button', { name: '取消固定监督目标' }))
  await waitFor(() => expect(overview).toHaveBeenLastCalledWith({ target: { type: 'conversation', conversationId: 'B' } }))
})

it.each(['cancel', 'failure'] as const)('retries supervision knowledge preview after %s and shows returned content', async (outcome) => {
  const knowledgePreview = vi.fn(async () => ({ previewId: 'preview', libraryId: 'library', operation: 'create-entity',
    entity: { label: 'Returned label', type: 'Returned type', description: 'Returned description', aliases: ['Returned alias'] },
    source: { title: 'Returned source', content: 'Returned evidence' } }))
  const knowledgeCommit = vi.fn(async () => ({}))
  if (outcome === 'failure') knowledgeCommit.mockRejectedValueOnce(new Error('Write failed'))
  Object.assign(window.goodbuddy, { supervision: {
    overview: vi.fn(async () => [{ id: 'result', storyLineId: 'story', sourceId: 'source', summary: 'Summary', scope: { kind: 'global' }, timeRange: { from: '2026-09-01T00:00:00Z', to: '2026-09-22T00:00:00Z' } }]),
    sourceContext: vi.fn(async () => ({ id: 'source', title: 'Source', content: 'Content' })), knowledgePreview, knowledgeCommit
  } })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(outcome !== 'cancel').mockReturnValue(true)
  try {
    renderSidebar({ activeConversationId: 'conversation', supervisionEnabled: true, supervisionLibraries: [{ id: 'library', name: 'Target library' } as never] })
    fireEvent.click(await screen.findByRole('button', { name: '查看来源' }))
    const button = await screen.findByRole('button', { name: '预览并写入实体' })
    fireEvent.click(button)
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    for (const text of ['Target library', 'Returned label', 'Returned type', 'Returned description', 'Returned alias', 'Returned source', 'Returned evidence']) {
      expect(confirm.mock.calls[0]![0]).toContain(text)
    }
    await waitFor(() => expect(button).toBeEnabled())
    expect(knowledgeCommit).toHaveBeenCalledTimes(outcome === 'cancel' ? 0 : 1)
    fireEvent.click(button)
    expect(await screen.findByText('知识实体已写入')).toBeInTheDocument()
    expect(knowledgePreview).toHaveBeenCalledTimes(2)
    expect(button).toBeEnabled()
  } finally { confirm.mockRestore() }
})

describe('RightAssistantSidebar tab titles', () => {
  it('updates application titles in place when the locale changes without rewriting the layout', async () => {
    renderSidebar()
    const initialTabs = screen.getAllByRole('tab')
    const savedLayout = localStorage.getItem('goodbuddy.workbar-layout.v1')
    expect(initialTabs.map((tab) => tab.textContent)).toEqual([
      '任务中心', '工作区', '浏览器 · 未绑定会话', '成果'
    ])

    await act(async () => { await i18n.changeLanguage('en-US') })
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Task center', 'Files', '浏览器 · 未绑定会话', 'Results'
    ])
    expect(screen.getAllByRole('tab')).toEqual(initialTabs)
    expect(screen.getByRole('tab', { name: 'Task center' })).toHaveAttribute('aria-selected', 'true')
    expect(localStorage.getItem('goodbuddy.workbar-layout.v1')).toBe(savedLayout)

    await act(async () => { await i18n.changeLanguage('zh-CN') })
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      '任务中心', '工作区', '浏览器 · 未绑定会话', '成果'
    ])
  })

  it('persists default terminal numbers and restores titles using the current locale', async () => {
    const view = render(sidebarElement())
    for (const number of [1, 2]) {
      fireEvent.click(screen.getByRole('button', { name: '打开工作栏应用' }))
      fireEvent.click(screen.getByText('终端', { selector: 'strong' }).closest('button')!)
      expect(await screen.findByRole('tab', { name: `终端 ${number}` })).toBeInTheDocument()
    }
    const savedLayout = workbarLayoutPreferencesSchema.parse(
      JSON.parse(localStorage.getItem('goodbuddy.workbar-layout.v1')!)
    )
    expect(savedLayout.instances.filter((instance) => instance.appId === 'terminal'))
      .toEqual([1, 2].map((number) => expect.objectContaining({
        title: `终端 ${number}`, defaultTitleNumber: number,
        targetRef: { type: 'project', projectId: currentProject.id }
      })))
    view.unmount()
    await i18n.changeLanguage('en-US')
    render(sidebarElement())
    expect(screen.getByRole('tab', { name: 'Terminal 1' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Terminal 2' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByRole('textbox', { name: 'Test terminal name' })).toHaveValue('Terminal 2')
    for (const name of ['Task center', 'Files', 'Results']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }
    await act(async () => { await i18n.changeLanguage('zh-CN') })
    expect(screen.getByRole('tab', { name: '终端 2' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: 'Test terminal name' })).toHaveValue('终端 2')
  })

  it('clears the default marker on rename and preserves a default-looking custom name across locale changes and restore', async () => {
    const view = render(sidebarElement())
    fireEvent.click(screen.getByRole('button', { name: '打开工作栏应用' }))
    fireEvent.click(screen.getByText('终端', { selector: 'strong' }).closest('button')!)
    const input = await screen.findByRole('textbox', { name: 'Test terminal name' })
    fireEvent.change(input, { target: { value: 'Terminal 99' } })
    const savedLayout = workbarLayoutPreferencesSchema.parse(
      JSON.parse(localStorage.getItem('goodbuddy.workbar-layout.v1')!)
    )
    const terminal = savedLayout.instances.find((instance) => instance.appId === 'terminal')!
    expect(terminal.title).toBe('Terminal 99')
    expect(terminal).not.toHaveProperty('defaultTitleNumber')
    await act(async () => { await i18n.changeLanguage('en-US') })
    expect(screen.getByRole('tab', { name: 'Terminal 99' })).toBeInTheDocument()
    view.unmount()
    await i18n.changeLanguage('zh-CN')
    render(sidebarElement())
    expect(screen.getByRole('tab', { name: 'Terminal 99' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByRole('textbox', { name: 'Test terminal name' })).toHaveValue('Terminal 99')
  })

  it.each(['终端 1', 'Terminal 2', '部署日志'])('preserves an unmarked legacy terminal title: %s', async (title) => {
    const terminalId = '10000000-0000-4000-8000-000000000009'
    localStorage.setItem('goodbuddy.workbar-layout.v1', JSON.stringify({
      instances: [...DEFAULT_WORKBAR_INSTANCES, {
        id: terminalId, appId: 'terminal', title, targetRef: { type: 'local' }
      }],
      activeInstanceId: terminalId, expanded: true, dock: 'right', widthRatio: 0.3
    }))
    renderSidebar()
    expect(await screen.findByRole('textbox', { name: 'Test terminal name' })).toHaveValue(title)
    await act(async () => { await i18n.changeLanguage('en-US') })
    expect(screen.getByRole('tab', { name: title })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: 'Test terminal name' })).toHaveValue(title)
    const savedLayout = workbarLayoutPreferencesSchema.parse(
      JSON.parse(localStorage.getItem('goodbuddy.workbar-layout.v1')!)
    )
    expect(savedLayout.instances.find((instance) => instance.id === terminalId))
      .toEqual({ id: terminalId, appId: 'terminal', title, targetRef: { type: 'local' } })
  })
})

describe('RightAssistantSidebar resizing', () => {
  it('updates conversation statistics without narrowing project tasks and rejects stale statistics', () => {
    const tasks: AssistantTask[] = ['a', 'b'].map((id) => ({
      id, conversationId: id, projectId: currentProject.id, title: `Project task ${id}`,
      instructions: '', origin: 'schedule', status: id === 'a' ? 'running' : 'completed',
      createdAt: '2026-09-01T00:00:00Z', startedAt: '2026-09-01T00:00:00Z',
      completedAt: id === 'b' ? '2026-09-17T00:00:00Z' : undefined
    }))
    const props = {
      tasks, selectedTaskId: 'a', activeConversationId: 'a',
      conversationStats: { conversationId: 'a', title: 'Conversation A', messageCount: 24, replyDurationMs: 3_661_000, incomplete: true },
      taskDurations: new Map([['a', { durationMs: 125_000, incomplete: true }]])
    }
    const view = render(sidebarElement(props))
    fireEvent.click(screen.getByRole('button', { name: '项目任务 2' }))
    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    const stats = within(screen.getByRole('region', { name: '当前会话统计' }))
    expect(stats.getByText('01:01:01')).toBeVisible()
    expect(stats.getByText('24')).toBeVisible()
    expect(stats.getByText('部分回复缺少计时记录，时长仅包含已知记录。')).toBeVisible()
    expect(screen.getByText('任务累计用时: 00:02:05 (部分记录)')).toBeVisible()
    expect(screen.getByText('Project task a').closest('button')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByText('Project task b').closest('article')).not.toHaveTextContent('任务累计用时')

    view.rerender(sidebarElement({ ...props, activeConversationId: 'b' }))
    expect(stats.queryByText('Conversation A')).not.toBeInTheDocument()
    expect(stats.getAllByText('暂无统计')).toHaveLength(2)
    for (const task of tasks) expect(screen.getByText(task.title)).toBeVisible()
    view.rerender(sidebarElement({ ...props, activeConversationId: 'b', conversationStats: {
      conversationId: 'b', title: 'Conversation B', messageCount: 0, replyDurationMs: 0, incomplete: false
    } }))
    expect(stats.getByText('00:00:00')).toBeVisible()
    expect(stats.getByText('0')).toBeVisible()
    expect(stats.queryByText('部分回复缺少计时记录，时长仅包含已知记录。')).not.toBeInTheDocument()
    view.rerender(sidebarElement({ ...props, activeProject: { ...currentProject, id: 'other' } }))
    for (const task of tasks) expect(screen.queryByText(task.title)).not.toBeInTheDocument()
  })

  it('shows the task status tabs when expanded and defaults to active tasks', () => {
    renderSidebar({ tasks: [{
      id: 'completed', projectId: currentProject.id, title: 'Completed task', instructions: '',
      origin: 'schedule', status: 'completed', createdAt: '2026-09-17T00:00:00Z'
    }] })
    expect(screen.queryByText('Completed task')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '筛选任务' })).not.toBeInTheDocument()
    const filters = within(screen.getByRole('group', { name: '筛选任务' }))
    expect(filters.getByRole('button', { name: '进行中' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('Completed task')).not.toBeInTheDocument()
    fireEvent.click(filters.getByRole('button', { name: '已结束' }))
    expect(screen.getByText('Completed task')).toBeVisible()
  })

  it('scrolls the focused task filter into view when keyboard navigation reaches either end', () => {
    renderSidebar()
    const filters = within(screen.getByRole('group', { name: '筛选任务' }))
    const first = filters.getByRole('button', { name: '全部' })
    const last = filters.getByRole('button', { name: '已结束' })
    const scrollFirst = vi.fn()
    const scrollLast = vi.fn()
    Object.defineProperty(first, 'scrollIntoView', { value: scrollFirst })
    Object.defineProperty(last, 'scrollIntoView', { value: scrollLast })
    act(() => first.focus())
    scrollFirst.mockClear()

    fireEvent.keyDown(first, { key: 'End' })
    expect(last).toHaveFocus()
    expect(last).toHaveAttribute('aria-pressed', 'true')
    expect(scrollLast).toHaveBeenCalledExactlyOnceWith({ block: 'nearest', inline: 'nearest' })
    expect(scrollFirst).not.toHaveBeenCalled()

    fireEvent.keyDown(last, { key: 'Home' })
    expect(first).toHaveFocus()
    expect(first).toHaveAttribute('aria-pressed', 'true')
    expect(scrollFirst).toHaveBeenCalledExactlyOnceWith({ block: 'nearest', inline: 'nearest' })
    expect(scrollLast).toHaveBeenCalledTimes(1)
  })

  it('resizes with pointer capture and preserves compact pane minima', () => {
    const sidebar = renderSidebar()
    const separator = screen.getByRole('separator', {
      name: '调整助手工作栏宽度'
    })
    const setPointerCapture = vi.fn()
    const releasePointerCapture = vi.fn()
    Object.defineProperties(separator, {
      setPointerCapture: { value: setPointerCapture },
      hasPointerCapture: { value: () => true },
      releasePointerCapture: { value: releasePointerCapture }
    })

    fireEvent.pointerDown(separator, {
      button: 0,
      clientX: 900,
      pointerId: 7
    })
    fireEvent.pointerMove(separator, {
      clientX: 100,
      pointerId: 7
    })

    expect(setPointerCapture).toHaveBeenCalledWith(7)
    expect(sidebar).toHaveClass('assistant-sidebar--resizing')
    expect(
      sidebar.style.getPropertyValue('--assistant-sidebar-width')
    ).toBe('1240px')
    expect(separator).toHaveAttribute('aria-valuemin', '160')
    expect(separator).toHaveAttribute('aria-valuemax', '1240')

    fireEvent.pointerUp(separator, { pointerId: 7 })
    expect(releasePointerCapture).toHaveBeenCalledWith(7)
    expect(sidebar).not.toHaveClass('assistant-sidebar--resizing')
  })

  it('supports arrow, Home, and End keyboard resizing', () => {
    const sidebar = renderSidebar()
    const separator = screen.getByRole('separator', {
      name: '调整助手工作栏宽度'
    })

    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(
      sidebar.style.getPropertyValue('--assistant-sidebar-width')
    ).toBe('436px')
    expect(separator).toHaveAttribute('aria-valuenow', '436')

    fireEvent.keyDown(separator, { key: 'Home' })
    expect(
      sidebar.style.getPropertyValue('--assistant-sidebar-width')
    ).toBe('160px')

    fireEvent.keyDown(separator, { key: 'End' })
    expect(
      sidebar.style.getPropertyValue('--assistant-sidebar-width')
    ).toBe('1240px')
  })

  it('remains resizable when the sidebar docks in a medium window', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1024
    })
    const sidebar = renderSidebar()
    const separator = screen.getByRole('separator', {
      name: '调整助手工作栏宽度'
    })
    Object.defineProperties(separator, {
      setPointerCapture: { value: vi.fn() },
      hasPointerCapture: { value: () => true },
      releasePointerCapture: { value: vi.fn() }
    })

    expect(separator).toHaveAttribute('tabindex', '0')
    fireEvent.pointerDown(separator, {
      button: 0,
      clientX: 674,
      pointerId: 8
    })
    fireEvent.pointerMove(separator, {
      clientX: 600,
      pointerId: 8
    })

    expect(
      sidebar.style.getPropertyValue('--assistant-sidebar-width')
    ).toBe('424px')
  })

  it('keeps the compact dock resizable in a narrow window', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 680
    })
    const sidebar = renderSidebar()
    const separator = screen.getByRole('separator', {
      name: '调整助手工作栏宽度'
    })

    expect(
      sidebar.style.getPropertyValue('--assistant-sidebar-width')
    ).toBe('204px')
    expect(sidebar).not.toHaveAttribute('aria-modal')
    expect(separator).toHaveAttribute('tabindex', '0')
    expect(separator).toHaveAttribute('aria-valuemin', '160')
    expect(separator).toHaveAttribute('aria-valuemax', '520')

    fireEvent.keyDown(separator, { key: 'End' })
    expect(
      sidebar.style.getPropertyValue('--assistant-sidebar-width')
    ).toBe('520px')
  })

  it('excludes the primary sidebar from the equal pane limits', async () => {
    const getBoundingClientRect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const [left, width] = this.classList.contains('workspace')
          ? [278, 630]
          : this.classList.contains('assistant-sidebar')
            ? [908, 270]
            : [0, 0]
        return {
          bottom: 700,
          height: 700,
          left,
          right: left + width,
          top: 0,
          width,
          x: left,
          y: 0,
          toJSON: () => ({})
        }
      })
    try {
      const sidebar = renderSidebar()
      const separator = screen.getByRole('separator', {
        name: '调整助手工作栏宽度'
      })
      await waitFor(() =>
        expect(separator).toHaveAttribute('aria-valuemax', '740')
      )

      fireEvent.keyDown(separator, { key: 'End' })
      expect(
        sidebar.style.getPropertyValue('--assistant-sidebar-width')
      ).toBe('740px')
    } finally {
      getBoundingClientRect.mockRestore()
    }
  })

  it('exposes the task center and three reusable work surfaces', () => {
    renderSidebar()

    expect(
      screen.getAllByRole('tab').map((tab) => tab.textContent)
    ).toEqual(['任务中心', '工作区', '浏览器 · 未绑定会话', '成果'])
    expect(
      screen.queryByRole('tab', { name: '预览' })
    ).not.toBeInTheDocument()
  })

  it('uses the browser panel for only the toolbar and page viewport', () => {
    const sidebar = renderSidebar({ tab: 'browser' })
    const viewport = screen.getByLabelText('浏览器页面')
    const browserPanel = viewport.parentElement

    expect(browserPanel).toHaveClass('assistant-sidebar__browser')
    expect(browserPanel?.children).toHaveLength(2)
    expect(screen.queryByText('实时浏览器')).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: '全屏显示浏览器' })
    )
    expect(sidebar).toHaveClass('assistant-sidebar--browser-fullscreen')
    expect(
      sidebar.style.getPropertyValue('--assistant-sidebar-width')
    ).toBe('420px')
    expect(
      screen.getByRole('button', { name: '退出浏览器全屏' })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen.getByRole('separator', { name: '调整助手工作栏宽度' })
    ).toHaveAttribute('aria-disabled', 'true')
    expect(
      screen.getByRole('separator', { name: '调整助手工作栏宽度' })
    ).toHaveAttribute('tabindex', '-1')

    fireEvent.click(screen.getByRole('tab', { name: '工作区' }))
    expect(sidebar).not.toHaveClass('assistant-sidebar--browser-fullscreen')
    fireEvent.click(screen.getByRole('tab', { name: /浏览器/u }))
    expect(
      screen.getByRole('button', { name: '全屏显示浏览器' })
    ).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(
      screen.getByRole('button', { name: '全屏显示浏览器' })
    )

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(sidebar).not.toHaveClass(
      'assistant-sidebar--browser-fullscreen'
    )
    expect(
      sidebar.style.getPropertyValue('--assistant-sidebar-width')
    ).toBe('420px')
  })

  it('keeps the docked sidebar non-modal', () => {
    const sidebar = renderSidebar()

    expect(sidebar).not.toHaveAttribute('aria-modal')
    expect(sidebar).toHaveAttribute('role', 'complementary')
  })

  it('collapses project tasks by default and toggles the list from its heading', () => {
    render(sidebarElement({ tab: 'tasks' }))
    const toggle = screen.getByRole('button', { name: '项目任务 0' })
    const list = document.getElementById(toggle.getAttribute('aria-controls')!)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(list).not.toBeVisible()
    expect(screen.getByRole('button', { name: '新建任务' })).toBeVisible()
    fireEvent.click(toggle)
    expect(list).toBeVisible()
    fireEvent.click(toggle)
    expect(list).not.toBeVisible()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(list).toBeVisible()
  })

  it('keeps the project inside statistics and shows running counts while collapsed or filtered', () => {
    const tasks: AssistantTask[] = ['running', 'running', 'queued', 'completed'].map((status, index) => ({
      id: `summary-${index}`, title: `Summary task ${index}`, instructions: '',
      projectId: currentProject.id, origin: 'schedule', status: status as AssistantTask['status'],
      createdAt: '2026-09-18T00:00:00Z'
    }))
    tasks.push({ ...tasks[0]!, id: 'other-project', projectId: 'other-project' })
    tasks.push({ ...tasks[0]!, id: 'child-task', parentTaskId: tasks[0]!.id })
    const view = render(sidebarElement({ tab: 'tasks', tasks }))
    const stats = screen.getByRole('region', { name: '当前会话统计' })
    expect(within(stats).getByText(`项目：${currentProject.name}`)).toBeVisible()
    expect(screen.getByRole('button', { name: '项目任务 4' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('2 运行中')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '项目任务 4' }))
    fireEvent.click(within(screen.getByRole('group', { name: '筛选任务' })).getByRole('button', { name: '已结束' }))
    expect(screen.getByText('2 运行中')).toBeVisible()
    view.rerender(sidebarElement({ tab: 'tasks', tasks: [] }))
    expect(screen.queryByText('2 运行中')).not.toBeInTheDocument()
    expect(screen.queryByText('0 运行中')).not.toBeInTheDocument()
  })

  it('keeps the product Task index in the task center', () => {
    const onCreateCustomTask = vi.fn()
    renderSidebar({ tab: 'tasks', onCreateCustomTask })

    expect(screen.queryByText('等待审批')).not.toBeInTheDocument()
    expect(screen.queryByText(i18n.t('sidebar.tasks.noApprovals', { ns: 'workspace' }))).not.toBeInTheDocument()
    const taskIndexHeading = screen.getByRole('heading', {
      name: '项目任务 0'
    })
    const newTaskButton = screen.getByRole('button', {
      name: '新建任务'
    })
    expect(taskIndexHeading.parentElement).toContainElement(
      newTaskButton
    )
    fireEvent.click(newTaskButton)
    expect(onCreateCustomTask).toHaveBeenCalledOnce()
    expect(screen.getByRole('group', { name: '筛选任务' })).toBeVisible()
    expect(screen.queryByLabelText('定时任务标题')).not.toBeInTheDocument()
    expect(screen.queryByText('最近任务')).not.toBeInTheDocument()
  })

  it('groups attention states as active while preserving task details and approvals across filters', () => {
    const statuses: AssistantTask['status'][] = [
      'idle', 'queued', 'running', 'waiting_approval', 'failed', 'interrupted',
      'paused', 'completed', 'cancelled'
    ]
    const tasks = statuses.map((status): AssistantTask => ({
      id: status,
      title: `Task ${status}`,
      instructions: status,
      projectId: currentProject.id,
      origin: 'schedule',
      status,
      error: status === 'failed' ? 'Task execution failed' : undefined,
      createdAt: '2026-09-09T00:00:00.000Z'
    }))
    const approval: PendingSidebarApproval = {
      conversationId: 'conversation-1', messageId: 'message-1',
      approvalId: 'approval-1', projectId: currentProject.id,
      title: '写入工作区', description: '更新 release.md'
    }
    const onOpenTask = vi.fn()
    const onRespondApproval = vi.fn()
    renderSidebar({
      tasks: [...tasks, { ...tasks[4]!, id: 'child', title: 'Child task', parentTaskId: 'running' }],
      approvals: [approval], onOpenTask, onRespondApproval
    })

    const filters = within(screen.getByRole('group', { name: '筛选任务' }))
    expect(filters.getAllByRole('button').map((button) => button.textContent))
      .toEqual(['全部', '进行中', '暂停', '已结束'])
    fireEvent.click(filters.getByRole('button', { name: '进行中' }))
    expect(filters.getByRole('button', { name: '进行中' })).toHaveAttribute('aria-pressed', 'true')
    for (const task of tasks.slice(0, 6)) {
      const row = screen.getByText(task.title).closest('article')!
      expect(within(row).getByText(i18n.t(`task.status.${task.status}`, { ns: 'workspace' }))).toBeVisible()
      fireEvent.click(within(row).getByRole('button'))
      expect(onOpenTask).toHaveBeenLastCalledWith(task)
    }
    expect(screen.getByText('Task execution failed')).toBeVisible()
    expect(screen.queryByText('Child task')).not.toBeInTheDocument()

    for (const [filter, visibleStatuses] of [
      ['进行中', statuses.slice(0, 6)],
      ['暂停', ['paused']],
      ['已结束', ['completed', 'cancelled']]
    ] as const) {
      fireEvent.click(filters.getByRole('button', { name: filter }))
      for (const task of tasks) {
        expect(Boolean(screen.queryByText(task.title)))
          .toBe((visibleStatuses as readonly string[]).includes(task.status))
      }
      expect(screen.getByLabelText('等待审批: 1')).toBeVisible()
      expect(screen.getByLabelText('等待审批: 写入工作区')).toBeVisible()
    }
    fireEvent.click(screen.getByRole('button', { name: '仅此次允许' }))
    expect(onRespondApproval).toHaveBeenLastCalledWith(approval, 'once')
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    expect(onRespondApproval).toHaveBeenLastCalledWith(approval, 'deny')
  })

  it('embeds matched approvals only in active task cards and preserves their actions', () => {
    const task: AssistantTask = {
      id: 'scheduled-task', conversationId: 'conversation-1', projectId: currentProject.id,
      title: 'Scheduled task', instructions: '', origin: 'schedule', status: 'paused',
      createdAt: '2026-09-16T00:00:00Z'
    }
    const approval: PendingSidebarApproval = {
      taskId: task.id, conversationId: task.conversationId!, projectId: task.projectId,
      messageId: 'message-1', approvalId: 'approval-1', title: 'Confirm write', description: 'write file'
    }
    const onRespondApproval = vi.fn()
    renderSidebar({ tasks: [task], approvals: [approval], onRespondApproval })
    const row = screen.getByText(task.title).closest('article')!
    expect(within(row).getByLabelText('等待审批: Confirm write')).toBeVisible()
    expect(screen.queryByRole('heading', { name: '等待审批' })).not.toBeInTheDocument()
    fireEvent.click(within(row).getByRole('button', { name: '仅此次允许' }))
    expect(onRespondApproval).toHaveBeenLastCalledWith(approval, 'once')
    fireEvent.click(within(row).getByRole('button', { name: '拒绝' }))
    expect(onRespondApproval).toHaveBeenLastCalledWith(approval, 'deny')
    for (const filter of ['暂停', '已结束']) {
      fireEvent.click(screen.getByRole('button', { name: filter }))
      expect(screen.queryByText(task.title)).not.toBeInTheDocument()
      expect(screen.queryByLabelText('等待审批: Confirm write')).not.toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: '等待审批' })).not.toBeInTheDocument()
      expect(screen.getByLabelText('等待审批: 1')).toBeVisible()
    }
    fireEvent.click(screen.getByRole('button', { name: '进行中' }))
    expect(screen.getByLabelText('等待审批: Confirm write')).toBeVisible()
  })

  it('keeps unmatched approvals accessible without guessing by conversation or crossing projects', () => {
    const task: AssistantTask = {
      id: 'task-1', conversationId: 'conversation-1', projectId: currentProject.id,
      title: 'Task one', instructions: '', origin: 'schedule', status: 'running',
      createdAt: '2026-09-16T00:00:00Z'
    }
    const approvals: PendingSidebarApproval[] = [
      { taskId: task.id, conversationId: task.conversationId!, projectId: task.projectId },
      { taskId: undefined, conversationId: task.conversationId!, projectId: task.projectId },
      { taskId: 'other-run', conversationId: task.conversationId!, projectId: task.projectId },
      { taskId: task.id, conversationId: 'other-conversation', projectId: task.projectId },
      { taskId: task.id, conversationId: task.conversationId!, projectId: 'other-project' },
      { taskId: 'child', conversationId: task.conversationId!, projectId: task.projectId }
    ].map((identity, index) => ({ ...identity, messageId: `message-${index}`, approvalId: `approval-${index}`, title: `Approval ${index}`, description: '' }))
    renderSidebar({ tasks: [task, { ...task, id: 'child', parentTaskId: task.id }], approvals })
    const row = screen.getByText(task.title).closest('article')!
    expect(within(row).getAllByRole('article')).toHaveLength(1)
    expect(within(row).getByText('Approval 0')).toBeVisible()
    for (const index of [1, 2, 3, 5]) {
      expect(screen.getByText(`Approval ${index}`)).toBeVisible()
      expect(within(row).queryByText(`Approval ${index}`)).not.toBeInTheDocument()
    }
    expect(screen.queryByText('Approval 4')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '所有项目' })).not.toBeInTheDocument()
    expect(screen.getAllByText('Approval 0')).toHaveLength(1)
  })

  it('labels approval counts and cards without duplicate live regions', () => {
    renderSidebar({
      approvals: [
        {
          conversationId: 'conversation-1',
          messageId: 'message-1',
          approvalId: 'approval-1',
          projectId: currentProject.id,
          title: '写入工作区',
          description: '更新 release.md',
          toolName: 'write_file'
        }
      ]
    })

    expect(
      screen.getByLabelText('等待审批: 1')
    ).not.toHaveAttribute('aria-live')
    expect(
      screen.getByLabelText('等待审批: write_file')
    ).not.toHaveAttribute('aria-live')
    expect(
      screen.queryByRole('status', { name: /等待审批/u })
    ).not.toBeInTheDocument()
  })

  it('keeps a failed workspace preview in place and retries it', async () => {
    let rejectPreview: ((reason: unknown) => void) | undefined
    const onLoadWorkspaceFile = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectPreview = reject
          })
      )
      .mockResolvedValueOnce({
        path: 'README.md',
        name: 'README.md',
        content: 'Recovered preview',
        mimeType: 'text/plain',
        size: 17,
        offsetBytes: 0,
        nextOffsetBytes: 17,
        truncated: false
      })
    renderSidebar({
      tab: 'workspace',
      workspaceProjectId: 'project-1',
      onListWorkspaceDirectory: vi.fn(async (path: string) => ({
        path,
        entries: [
          {
            name: 'README.md',
            path: 'README.md',
            type: 'file' as const
          }
        ],
        truncated: false
      })),
      onLoadWorkspaceFile
    })

    fireEvent.click(
      await screen.findByRole('button', { name: 'README.md' })
    )
    const loading = screen.getByRole('status', {
      name: '正在读取文件…'
    })
    expect(loading).toHaveAttribute('aria-live', 'polite')
    expect(loading.closest('section')).toHaveAttribute(
      'aria-busy',
      'true'
    )

    rejectPreview?.(new Error('临时网络错误'))
    const error = await screen.findByRole('alert')
    expect(error).toHaveTextContent('临时网络错误')
    expect(screen.getByText('README.md', { selector: 'strong' })).toBeVisible()
    fireEvent.click(
      within(error).getByRole('button', { name: '刷新' })
    )

    expect(await screen.findByText('Recovered preview'))
      .toBeInTheDocument()
    expect(onLoadWorkspaceFile).toHaveBeenCalledTimes(2)
    expect(onLoadWorkspaceFile).toHaveBeenNthCalledWith(
      2,
      'README.md',
      0
    )
  })

  it('returns to the expanded directory, selected file and scroll position without reloading', async () => {
    const onListWorkspaceDirectory = vi.fn(async (path: string) => ({
      path,
      entries: path === ''
        ? [{ name: 'src', path: 'src', type: 'directory' as const }]
        : [{ name: 'nested.txt', path: 'src/nested.txt', type: 'file' as const }],
      truncated: false
    }))
    renderSidebar({
      tab: 'workspace',
      workspaceProjectId: 'project-1',
      onListWorkspaceDirectory,
      onLoadWorkspaceFile: vi.fn().mockResolvedValue({
        path: 'src/nested.txt', name: 'nested.txt', content: 'Nested content',
        mimeType: 'text/plain', size: 14, offsetBytes: 0, nextOffsetBytes: 14, truncated: false
      })
    })
    fireEvent.click(await screen.findByRole('button', { name: 'src' }))
    const file = await screen.findByRole('button', { name: 'nested.txt' })
    const body = file.closest('.assistant-sidebar__body') as HTMLElement
    body.scrollTop = 240
    fireEvent.click(file)
    expect(await screen.findByText('Nested content')).toBeVisible()
    expect(file).not.toBeVisible()
    expect(body.scrollTop).toBe(0)
    body.scrollTop = 80
    fireEvent.click(screen.getByRole('button', { name: '返回工作区' }))
    expect(screen.getByRole('button', { name: 'src' })).toHaveAttribute('aria-expanded', 'true')
    expect(file).toBeVisible()
    expect(file).toHaveAttribute('aria-current', 'true')
    expect(file).toHaveFocus()
    expect(body.scrollTop).toBe(240)
    expect(onListWorkspaceDirectory).toHaveBeenCalledTimes(2)
  })

  it('scopes approvals by their owning conversation project', () => {
    renderSidebar({
      approvals: [
        {
          conversationId: 'conversation-current',
          projectId: currentProject.id,
          messageId: 'message-current',
          approvalId: 'approval-current',
          title: '当前项目审批',
          description: 'current'
        },
        {
          conversationId: 'conversation-global',
          messageId: 'message-global',
          approvalId: 'approval-global',
          title: '全局审批',
          description: 'global'
        }
      ]
    })

    expect(screen.getByText('当前项目审批')).toBeInTheDocument()
    expect(screen.queryByText('全局审批')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: '任务范围' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('等待审批: 1')).toBeInTheDocument()
  })

  it('keeps task scope fixed to the current project', () => {
    const createTask = (
      id: string,
      title: string,
      projectId?: string
    ): AssistantTask => ({
      id,
      projectId,
      title,
      instructions: title,
      origin: 'schedule',
      status: 'running',
      createdAt: '2026-09-09T00:00:00.000Z'
    })
    renderSidebar({
      tasks: [
        createTask('task-current', '当前项目任务', currentProject.id),
        createTask('task-global', '全局任务'),
        createTask(
          'task-other',
          '其他项目任务',
          '00000000-0000-4000-8000-000000000302'
        )
      ]
    })

    expect(screen.getByText('当前项目任务')).toBeInTheDocument()
    expect(screen.queryByText('全局任务')).not.toBeInTheDocument()
    expect(screen.queryByText('其他项目任务')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: '任务范围' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '全局' })).not.toBeInTheDocument()

    expect(JSON.parse(localStorage.getItem('goodbuddy.workbar-layout.v1')!))
      .toEqual(expect.objectContaining({ taskScope: 'current-project' }))
  })

  it.each(['global', 'all-projects'])('ignores the persisted %s scope and saves current project scope', (taskScope) => {
    localStorage.setItem('goodbuddy.workbar-layout.v1', JSON.stringify({
      instances: DEFAULT_WORKBAR_INSTANCES,
      activeInstanceId: DEFAULT_WORKBAR_INSTANCES[0]!.id,
      expanded: true,
      dock: 'right',
      widthRatio: 0.3,
      taskScope
    }))
    renderSidebar({ activeProject: null, tasks: [{
      id: 'legacy-unbound-task', title: '历史任务', instructions: '历史任务',
      origin: 'schedule', status: 'running', createdAt: '2026-09-09T00:00:00.000Z'
    }] })

    expect(screen.queryByRole('button', { name: '所有项目' })).not.toBeInTheDocument()
    expect(screen.queryByText('历史任务')).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('goodbuddy.workbar-layout.v1')!).taskScope)
      .toBe('current-project')
  })

  it('shows a clear current-project empty state when no project is active', () => {
    renderSidebar({ activeProject: null })

    expect(
      screen.getByText(
        '没有活动项目。请先打开一个项目以查看和创建任务。'
      )
    ).toBeInTheDocument()
    expect(screen.queryByText('等待审批')).not.toBeInTheDocument()
  })

  it('keeps preview content and reading position when refreshing fails', async () => {
    const onLoadWorkspaceFile = vi.fn().mockResolvedValueOnce({
      path: 'README.md', name: 'README.md', content: '# Original heading',
      mimeType: 'text/markdown', size: 18, offsetBytes: 0, nextOffsetBytes: 18, truncated: false
    }).mockRejectedValueOnce(new Error('Refresh unavailable'))
    renderSidebar({
      tab: 'workspace', workspaceProjectId: 'project-1', onLoadWorkspaceFile,
      onListWorkspaceDirectory: vi.fn(async (path: string) => ({
        path, entries: [{ name: 'README.md', path: 'README.md', type: 'file' as const }], truncated: false
      }))
    })
    fireEvent.click(await screen.findByRole('button', { name: 'README.md' }))
    const heading = await screen.findByRole('heading', { name: 'Original heading' })
    const body = heading.closest('.assistant-sidebar__body') as HTMLElement
    body.scrollTop = 120
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Refresh unavailable')
    expect(heading).toBeVisible()
    expect(body.scrollTop).toBe(120)
    fireEvent.click(screen.getByRole('button', { name: '源码' }))
    expect(screen.getByText('# Original heading')).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Original heading' })).not.toBeInTheDocument()
  })

  it('discards an unfinished file preview when switching projects', async () => {
    let resolveRead: (value: WorkspaceFilePreview) => void = () => undefined
    const props = {
      open: true, tab: 'workspace' as const, approvals: [], artifacts: [], schedules: [], tasks: [],
      conversationTitles: new Map(), projectNames: new Map(),
      onCreateCustomTask: vi.fn(), onImportArtifacts: vi.fn(), onLoadArtifact: vi.fn(),
      onLoadWorkspaceFile: vi.fn(() => new Promise<WorkspaceFilePreview>((resolve) => { resolveRead = resolve })),
      onLoadWorkspaceDiff: vi.fn(), onOpenWorkspaceEntry: vi.fn(),
      onRefreshChanges: vi.fn(), onRemoveSchedule: vi.fn(), onRespondApproval: vi.fn(),
      onRunSchedule: vi.fn(), onSetScheduleEnabled: vi.fn(), onOpenTask: vi.fn(), onTabChange: vi.fn(),
      onListWorkspaceDirectory: vi.fn(async (path: string) => ({
        path, entries: [{ name: 'file.txt', path: 'file.txt', type: 'file' as const }], truncated: false
      }))
    }
    const { rerender } = render(<RightAssistantSidebar {...props} workspaceProjectId="A" />)
    fireEvent.click(await screen.findByRole('button', { name: 'file.txt' }))
    expect(screen.getByRole('status', { name: '正在读取文件…' })).toBeVisible()
    rerender(<RightAssistantSidebar {...props} workspaceProjectId="B" />)
    resolveRead({ path: 'file.txt', name: 'file.txt', content: 'Stale preview', mimeType: 'text/plain', size: 13, offsetBytes: 0, nextOffsetBytes: 13, truncated: false })
    await screen.findByRole('button', { name: 'file.txt' })
    rerender(<RightAssistantSidebar {...props} workspaceProjectId="A" />)
    expect(await screen.findByRole('button', { name: 'file.txt' })).toBeVisible()
    expect(screen.queryByRole('status', { name: '正在读取文件…' })).not.toBeInTheDocument()
    expect(screen.queryByText('Stale preview')).not.toBeInTheDocument()
  })

  it('loads and appends the rest of a large workspace file', async () => {
    const onLoadWorkspaceFile = vi
      .fn()
      .mockResolvedValueOnce({
        path: 'large.txt',
        name: 'large.txt',
        content: 'first page\n',
        mimeType: 'text/plain',
        size: 30,
        offsetBytes: 0,
        nextOffsetBytes: 11,
        truncated: true
      })
      .mockResolvedValueOnce({
        path: 'large.txt',
        name: 'large.txt',
        content: 'second page',
        mimeType: 'text/plain',
        size: 30,
        offsetBytes: 11,
        nextOffsetBytes: 30,
        truncated: false
      })
    renderSidebar({
      tab: 'workspace',
      workspaceProjectId: 'project-1',
      onListWorkspaceDirectory: vi.fn(async (path: string) => ({
        path,
        entries: [
          {
            name: 'large.txt',
            path: 'large.txt',
            type: 'file' as const
          }
        ],
        truncated: false
      })),
      onLoadWorkspaceFile
    })

    fireEvent.click(
      await screen.findByRole('button', { name: 'large.txt' })
    )
    expect(await screen.findByText('first page')).toBeInTheDocument()
    expect(screen.getByText('已加载 11 / 30 字节')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '继续加载' }))

    expect(await screen.findByText(/first page\s+second page/u))
      .toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '继续加载' }))
      .not.toBeInTheDocument()
    expect(onLoadWorkspaceFile).toHaveBeenNthCalledWith(
      2,
      'large.txt',
      11
    )
  })

  it('previews a result without switching to a separate tab', () => {
    const onLoadArtifact = vi.fn(async () => undefined)
    renderSidebar({
      tab: 'results',
      artifacts: [
        {
          id: 'artifact-1',
          title: '发布说明',
          content: '# 发布说明',
          createdAt: Date.now(),
          mimeType: 'text/markdown'
        }
      ],
      onLoadArtifact
    })

    fireEvent.click(screen.getByRole('button', { name: /发布说明/u }))

    expect(onLoadArtifact).toHaveBeenCalledWith('artifact-1')
    expect(
      screen.getByRole('tab', { name: '成果' })
    ).toHaveAttribute('aria-selected', 'true')
    expect(
      screen.getByRole('button', { name: '返回成果列表' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('tab', { name: '预览' })
    ).not.toBeInTheDocument()
  })

  it('requires a committed URL to reload a fresh active browser tab, but still allows Stop', async () => {
    const conversationId = 'blank-browser'
    const state: BrowserLiveState = {
      ...browserSummary(conversationId, firstBrowserTabId, true),
      sessionActive: true
    }
    const onReloadBrowser = vi.fn(async () => undefined)
    const onStopLoadingBrowser = vi.fn(async () => undefined)
    const props = {
      tab: 'browser' as const,
      activeConversationId: conversationId,
      onReloadBrowser,
      onStopLoadingBrowser
    }
    const withState = (browserState: BrowserLiveState) => sidebarElement({
      ...props, browserStates: { [conversationId]: { [firstBrowserTabId]: browserState } }
    })
    const view = render(withState(state))
    await waitFor(() => expect(browserApi.createTab).toHaveBeenCalledOnce())
    expect(screen.getByRole('button', { name: '刷新' })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: '浏览器地址' }), {
      target: { value: 'https://draft.example/' }
    })
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(screen.getByRole('button', { name: '刷新' })).toBeDisabled()
    expect(onReloadBrowser).not.toHaveBeenCalled()

    view.rerender(withState({ ...state, status: 'loading', isLoading: true }))
    expect(screen.getByRole('button', { name: '停止加载' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '停止加载' }))
    await waitFor(() => expect(onStopLoadingBrowser).toHaveBeenCalledWith(conversationId, firstBrowserTabId))

    view.rerender(withState({ ...state, url: 'https://committed.example/' }))
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(onReloadBrowser).toHaveBeenCalledWith(conversationId, firstBrowserTabId))
  })

  it.each(['close', 'switch', 'collapse'] as const)(
    'clears a browser action error after %s without restoring it on return',
    async (transition) => {
      const props = {
        tab: 'browser' as const,
        activeConversationId: 'error-browser',
        onNavigateBrowser: vi.fn().mockRejectedValue(new Error('Navigation failed'))
      }
      const view = render(sidebarElement(props))
      await waitFor(() => expect(browserApi.createTab).toHaveBeenCalledOnce())
      fireEvent.change(screen.getByRole('textbox', { name: '浏览器地址' }), {
        target: { value: 'https://example.com/' }
      })
      fireEvent.click(screen.getByRole('button', { name: '前往' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Navigation failed')

      if (transition === 'close') {
        fireEvent.click(screen.getByRole('button', { name: '关闭浏览器 · error-browser' }))
        await waitFor(() => expect(screen.queryByRole('tab', { name: '浏览器 · error-browser' })).not.toBeInTheDocument())
        fireEvent.click(screen.getByRole('button', { name: '打开工作栏应用' }))
        fireEvent.click(screen.getByText('浏览器', { selector: 'strong' }).closest('button')!)
        await waitFor(() => expect(browserApi.createTab).toHaveBeenCalledTimes(2))
      } else if (transition === 'switch') {
        fireEvent.click(screen.getByRole('tab', { name: '工作区' }))
        expect(screen.queryByText('Navigation failed')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('tab', { name: '浏览器 · error-browser' }))
      } else {
        view.rerender(sidebarElement({ ...props, open: false }))
        view.rerender(sidebarElement(props))
      }
      expect(screen.queryByText('Navigation failed')).not.toBeInTheDocument()
    }
  )

  it.each(['close', 'switch', 'collapse'] as const)(
    'ignores a late browser action failure after %s',
    async (transition) => {
      let rejectNavigation!: (reason: Error) => void
      const props = {
        tab: 'browser' as const,
        activeConversationId: 'late-browser',
        onNavigateBrowser: vi.fn(() => new Promise<void>((_resolve, reject) => {
          rejectNavigation = reject
        }))
      }
      const view = render(sidebarElement(props))
      await waitFor(() => expect(browserApi.createTab).toHaveBeenCalledOnce())
      fireEvent.change(screen.getByRole('textbox', { name: '浏览器地址' }), {
        target: { value: 'https://example.com/' }
      })
      fireEvent.click(screen.getByRole('button', { name: '前往' }))
      await waitFor(() => expect(props.onNavigateBrowser).toHaveBeenCalledOnce())

      if (transition === 'close') {
        fireEvent.click(screen.getByRole('button', { name: '关闭浏览器 · late-browser' }))
        await waitFor(() => expect(screen.queryByRole('tab', { name: '浏览器 · late-browser' })).not.toBeInTheDocument())
      } else if (transition === 'switch') {
        fireEvent.click(screen.getByRole('tab', { name: '工作区' }))
        fireEvent.click(screen.getByRole('tab', { name: '浏览器 · late-browser' }))
      } else {
        view.rerender(sidebarElement({ ...props, open: false }))
      }
      await act(async () => rejectNavigation(new Error('Late navigation failed')))
      if (transition === 'collapse') view.rerender(sidebarElement(props))
      expect(screen.queryByText('Late navigation failed')).not.toBeInTheDocument()
    }
  )

  it('keeps browser A selected and usable after switching to B, and binds a new browser to B', async () => {
    const onNavigateBrowser = vi.fn(async () => undefined)
    const onBackBrowser = vi.fn(async () => undefined)
    const onReloadBrowser = vi.fn(async () => undefined)
    const onStopLoadingBrowser = vi.fn(async () => undefined)
    const browserStates = {
      'conversation-a': {
        [firstBrowserTabId]: {
          ...browserSummary('conversation-a', firstBrowserTabId, true),
          sessionActive: true,
          canGoBack: true,
          url: 'https://a.example/'
        }
      },
      'conversation-b': {
        [secondBrowserTabId]: {
          ...browserSummary('conversation-b', secondBrowserTabId, true),
          sessionActive: true,
          url: 'https://b.example/'
        }
      }
    }
    const props = {
      tab: 'browser' as const,
      activeConversationId: 'conversation-a',
      browserStates,
      onNavigateBrowser,
      onBackBrowser,
      onReloadBrowser,
      onStopLoadingBrowser
    }
    const view = render(sidebarElement(props))
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: '浏览器地址' })).toHaveValue('https://a.example/')
    )
    const browserA = screen.getByRole('tab', { name: '浏览器 · conversation-a' })
    const ownerA = browserApi.createTab.mock.calls[0]![0].workbarInstanceId

    view.rerender(sidebarElement({ ...props, activeConversationId: 'conversation-b' }))

    expect(browserA).toBeVisible()
    expect(browserA).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: '浏览器地址' })).toHaveValue('https://a.example/')
    expect(browserApi.createTab).toHaveBeenCalledOnce()
    fireEvent.change(screen.getByRole('textbox', { name: '浏览器地址' }), {
      target: { value: 'https://a.example/next' }
    })
    fireEvent.click(screen.getByRole('button', { name: '前往' }))
    await waitFor(() => expect(onNavigateBrowser).toHaveBeenCalledWith(
      'conversation-a', firstBrowserTabId, 'https://a.example/next'
    ))
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await waitFor(() => {
      expect(onBackBrowser).toHaveBeenCalledWith('conversation-a', firstBrowserTabId)
      expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
    })
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => {
      expect(onReloadBrowser).toHaveBeenCalledWith('conversation-a', firstBrowserTabId)
      expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
    })

    view.rerender(sidebarElement({
      ...props,
      activeConversationId: 'conversation-b',
      browserStates: {
        ...browserStates,
        'conversation-a': {
          [firstBrowserTabId]: { ...browserStates['conversation-a'][firstBrowserTabId]!, isLoading: true }
        }
      }
    }))
    fireEvent.click(screen.getByRole('button', { name: '停止加载' }))
    await waitFor(() => expect(onStopLoadingBrowser).toHaveBeenCalledWith('conversation-a', firstBrowserTabId))

    fireEvent.click(screen.getByRole('button', { name: '打开工作栏应用' }))
    fireEvent.click(screen.getByText('浏览器', { selector: 'strong' }).closest('button')!)
    await waitFor(() => expect(browserApi.createTab).toHaveBeenCalledTimes(2))
    expect(browserApi.createTab).toHaveBeenLastCalledWith({
      conversationId: 'conversation-b',
      workbarInstanceId: expect.any(String)
    })
    expect(browserApi.createTab.mock.calls[1]![0].workbarInstanceId).not.toBe(ownerA)
    expect(screen.getByRole('tab', { name: '浏览器 1 · conversation-b' })).toHaveAttribute('aria-selected', 'true')
    expect(browserA).toBeVisible()
    await waitFor(() => expect(screen.getByRole('textbox', { name: '浏览器地址' })).toHaveValue('https://b.example/'))
    fireEvent.click(screen.getByRole('button', { name: '前往' }))
    await waitFor(() => expect(onNavigateBrowser).toHaveBeenLastCalledWith(
      'conversation-b', secondBrowserTabId, 'https://b.example/'
    ))

    fireEvent.click(browserA)
    expect(browserA).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: '浏览器地址' })).toHaveValue('https://a.example/')
    expect(browserApi.createTab).toHaveBeenCalledTimes(2)
  })

  it('opens a blank browser from + without inheriting the old address or title', async () => {
    const conversationId = 'old-conversation'
    renderSidebar({
      tab: 'browser',
      activeConversationId: conversationId,
      browserStates: {
        [conversationId]: {
          [firstBrowserTabId]: {
            ...browserSummary(conversationId, firstBrowserTabId, true),
            sessionActive: true,
            url: 'https://old.example/'
          }
        }
      }
    })
    await waitFor(() => expect(screen.getByRole('textbox', { name: '浏览器地址' })).toHaveValue('https://old.example/'))
    fireEvent.click(screen.getByRole('button', { name: '打开工作栏应用' }))
    fireEvent.click(screen.getByText('浏览器', { selector: 'strong' }).closest('button')!)
    await waitFor(() => expect(browserApi.createTab).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('tab', { name: '浏览器 1 · old-conversation' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: '浏览器地址' })).toHaveValue('')
    expect(screen.getByRole('button', { name: '返回' })).toBeDisabled()
    const requests = browserApi.createTab.mock.calls.map(([request]) => request)
    expect(requests[1]?.workbarInstanceId).not.toBe(requests[0]?.workbarInstanceId)
    fireEvent.click(screen.getByRole('tab', { name: '浏览器 · old-conversation' }))
    expect(screen.getByRole('textbox', { name: '浏览器地址' })).toHaveValue('https://old.example/')

    browserApi.createTab.mockImplementation(async ({ conversationId }) =>
      browserSummary(conversationId, crypto.randomUUID() as BrowserTabId, false)
    )
    fireEvent.click(screen.getByRole('button', { name: '打开工作栏应用' }))
    fireEvent.click(screen.getByText('浏览器', { selector: 'strong' }).closest('button')!)
    await waitFor(() => expect(browserApi.createTab).toHaveBeenCalledTimes(3))
    expect(screen.getByRole('tab', { name: '浏览器 2 · old-conversation' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('button', { name: '关闭浏览器 1 · old-conversation' }))
    await waitFor(() => expect(screen.queryByRole('tab', { name: '浏览器 1 · old-conversation' })).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '打开工作栏应用' }))
    fireEvent.click(screen.getByText('浏览器', { selector: 'strong' }).closest('button')!)
    await waitFor(() => expect(browserApi.createTab).toHaveBeenCalledTimes(4))
    expect(screen.getByRole('tab', { name: '浏览器 1 · old-conversation' })).toHaveAttribute('aria-selected', 'true')
    cleanup()
    renderSidebar({ activeConversationId: conversationId })
    expect(screen.getByRole('tab', { name: '浏览器 1 · old-conversation' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: '浏览器 2 · old-conversation' })).toBeVisible()
  })

  it('keeps two browser instances independent and closes only the selected Main tab', async () => {
    const conversationId = 'conversation-a'
    const onNavigateBrowser = vi.fn(async () => undefined)
    const states: Record<string, Record<string, BrowserLiveState>> = {
      [conversationId]: {
        [firstBrowserTabId]: {
          conversationId,
          tabId: firstBrowserTabId,
          status: 'ready',
          sessionActive: true,
          isLoading: false,
          canGoBack: false,
          url: 'https://first.example/',
          updatedAt: 1
        },
        [secondBrowserTabId]: {
          conversationId,
          tabId: secondBrowserTabId,
          status: 'ready',
          sessionActive: true,
          isLoading: false,
          canGoBack: false,
          url: 'https://second.example/',
          updatedAt: 2
        }
      }
    }
    renderSidebar({
      tab: 'browser',
      activeConversationId: conversationId,
      browserStates: states,
      onNavigateBrowser
    })

    await waitFor(() => expect(browserApi.createTab).toHaveBeenCalledOnce())
    const firstAddress = screen.getByRole('textbox', {
      name: '浏览器地址'
    })
    await waitFor(() =>
      expect(firstAddress).toHaveValue('https://first.example/')
    )
    fireEvent.change(firstAddress, {
      target: { value: 'https://first.example/next' }
    })
    fireEvent.click(screen.getByRole('button', { name: '前往' }))
    await waitFor(() =>
      expect(onNavigateBrowser).toHaveBeenCalledWith(
        conversationId,
        firstBrowserTabId,
        'https://first.example/next'
      )
    )

    fireEvent.click(screen.getByRole('button', { name: '打开工作栏应用' }))
    fireEvent.click(
      screen.getByText('浏览器', { selector: 'strong' }).closest('button')!
    )
    await waitFor(() => expect(browserApi.createTab).toHaveBeenCalledTimes(2))
    const ownershipRequests = browserApi.createTab.mock.calls.map(
      ([request]) => request
    )
    expect(ownershipRequests[0]?.conversationId).toBe(conversationId)
    expect(ownershipRequests[1]?.conversationId).toBe(conversationId)
    expect(ownershipRequests[0]?.workbarInstanceId).not.toBe(
      ownershipRequests[1]?.workbarInstanceId
    )
    const secondAddress = screen.getByRole('textbox', {
      name: '浏览器地址'
    })
    await waitFor(() =>
      expect(secondAddress).toHaveValue('https://second.example/')
    )
    fireEvent.change(secondAddress, {
      target: { value: 'https://second.example/next' }
    })
    fireEvent.click(screen.getByRole('button', { name: '前往' }))
    await waitFor(() =>
      expect(onNavigateBrowser).toHaveBeenLastCalledWith(
        conversationId,
        secondBrowserTabId,
        'https://second.example/next'
      )
    )

    fireEvent.click(
      screen.getByRole('button', { name: /关闭浏览器 1 · conversation-a/u })
    )
    await waitFor(() =>
      expect(browserApi.closeTab).toHaveBeenCalledWith({
        conversationId,
        tabId: secondBrowserTabId
      })
    )
    expect(
      screen.getByRole('tab', { name: '浏览器 · conversation-a' })
    ).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '浏览器 1 · conversation-a' })).not.toBeInTheDocument()
  })

  it('selects a visible opener popup across conversation switches and removes its script-closed instance', async () => {
    const conversationId = 'popup-owner'
    const view = render(sidebarElement({ tab: 'browser', activeConversationId: conversationId }))
    await waitFor(() => expect(browserApi.createTab).toHaveBeenCalledOnce())
    const popup: BrowserLiveState = {
      ...browserSummary(conversationId, secondBrowserTabId, false),
      workbarInstanceId: secondBrowserTabId, openerTabId: firstBrowserTabId,
      sessionActive: true, url: 'https://popup.example/'
    }
    view.rerender(sidebarElement({
      tab: 'browser', activeConversationId: 'another-conversation',
      browserStates: { [conversationId]: { [secondBrowserTabId]: popup } }
    }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: '浏览器地址' })).toHaveValue('https://popup.example/'))
    expect(browserApi.createTab).toHaveBeenCalledOnce()
    const stopped: BrowserLiveState = { ...popup, status: 'stopped', sessionActive: false }
    act(() => {
      for (const listener of browserStateListeners) listener(stopped)
      view.rerender(sidebarElement({
        tab: 'browser', activeConversationId: 'another-conversation',
        browserStates: { [conversationId]: { [secondBrowserTabId]: stopped } }
      }))
    })
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem('goodbuddy.workbar-layout.v1')!)
      expect(saved.instances.some((instance: { id: string }) => instance.id === secondBrowserTabId)).toBe(false)
    })
    expect(browserApi.createTab).toHaveBeenCalledOnce()
    expect(browserApi.closeTab).not.toHaveBeenCalled()
  })

  it('restores a browser by stable ownership and releases only its viewport lease', async () => {
    const conversationId = 'conversation-restored'
    const workbarInstanceId = '10000000-0000-4000-8000-000000000003'
    localStorage.setItem(
      'goodbuddy.workbar-layout.v1',
      JSON.stringify({
        instances: [
          {
            id: '10000000-0000-4000-8000-000000000001',
            appId: 'tasks',
            title: '任务中心'
          },
          {
            id: '10000000-0000-4000-8000-000000000002',
            appId: 'workspace',
            title: '工作区'
          },
          {
            id: '10000000-0000-4000-8000-000000000003',
            appId: 'browser',
            title: '浏览器 · 已恢复',
            targetRef: { type: 'conversation', conversationId }
          }
        ],
        activeInstanceId: '10000000-0000-4000-8000-000000000001',
        expanded: true,
        dock: 'right',
        widthRatio: 0.3,
        taskScope: 'current-project'
      })
    )
    const bounds = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        bottom: 500,
        height: 400,
        left: 900,
        right: 1300,
        top: 100,
        width: 400,
        x: 900,
        y: 100,
        toJSON: () => ({})
      })
    try {
      renderSidebar({ activeConversationId: 'different-conversation' })
      expect(browserApi.createTab).not.toHaveBeenCalled()

      fireEvent.click(
        screen.getByRole('tab', { name: '浏览器 · 已恢复' })
      )
      await waitFor(() =>
        expect(browserApi.createTab).toHaveBeenCalledWith({
          conversationId,
          workbarInstanceId
        })
      )
      await waitFor(() =>
        expect(browserApi.setViewport).toHaveBeenCalledWith(
          expect.objectContaining({
            conversationId,
            tabId: firstBrowserTabId,
            bounds: expect.any(Object),
            leaseToken: expect.any(String)
          })
        )
      )
      const acquired = browserApi.setViewport.mock.calls.find(
        ([request]) => 'conversationId' in request
      )?.[0]
      if (!acquired || !('conversationId' in acquired)) {
        throw new Error('Expected an acquired viewport lease')
      }
      expect(acquired.leaseToken).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      )

      fireEvent.click(screen.getByRole('tab', { name: '工作区' }))
      await waitFor(() =>
        expect(browserApi.setViewport).toHaveBeenCalledWith({
          leaseToken: acquired.leaseToken
        })
      )
      expect(
        browserApi.setViewport.mock.calls.some(
          ([request]) =>
            Object.keys(request).length === 1 &&
            request.leaseToken !== acquired.leaseToken
        )
      ).toBe(false)

      fireEvent.click(
        screen.getByRole('tab', { name: '浏览器 · 已恢复' })
      )
      await waitFor(() => {
        const acquisitions = browserApi.setViewport.mock.calls
          .map(([request]) => request)
          .filter((request) => 'conversationId' in request)
        expect(acquisitions).toHaveLength(2)
        expect(acquisitions[1]!.leaseToken).not.toBe(
          acquisitions[0]!.leaseToken
        )
      })

      cleanup()
      renderSidebar({ activeConversationId: 'different-conversation' })
      fireEvent.click(
        screen.getByRole('tab', { name: '浏览器 · 已恢复' })
      )
      await waitFor(() => expect(browserApi.createTab).toHaveBeenCalledTimes(2))
      expect(browserApi.createTab).toHaveBeenLastCalledWith({
        conversationId,
        workbarInstanceId
      })
      await waitFor(() =>
        expect(browserApi.setViewport).toHaveBeenLastCalledWith(
          expect.objectContaining({
            conversationId,
            tabId: firstBrowserTabId
          })
        )
      )
    } finally {
      bounds.mockRestore()
    }
  })

  it('keeps a browser workbar tab when closing its Main tab fails', async () => {
    browserApi.closeTab.mockRejectedValueOnce(new Error('Close denied'))
    renderSidebar({ tab: 'browser', activeConversationId: 'conversation-a' })
    await waitFor(() => expect(browserApi.createTab).toHaveBeenCalledOnce())

    fireEvent.click(
      screen.getByRole('button', { name: /关闭浏览器 · conversation-a/u })
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('Close denied')
    expect(
      screen.getByRole('tab', { name: '浏览器 · conversation-a' })
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '关闭浏览器 · conversation-a' }))
    await waitFor(() => expect(screen.queryByRole('tab', { name: '浏览器 · conversation-a' })).not.toBeInTheDocument())
    expect(screen.queryByText('Close denied')).not.toBeInTheDocument()
  })

  it.each(['create', 'close'] as const)(
    'ignores a late browser %s failure after switching panels',
    async (operation) => {
      let rejectOperation!: (reason: Error) => void
      const pending = new Promise<never>((_resolve, reject) => {
        rejectOperation = reject
      })
      if (operation === 'create') browserApi.createTab.mockReturnValueOnce(pending)
      else browserApi.closeTab.mockReturnValueOnce(pending)
      renderSidebar({ tab: 'browser', activeConversationId: 'late-browser' })
      await waitFor(() => expect(browserApi.createTab).toHaveBeenCalledOnce())
      if (operation === 'close') {
        fireEvent.click(screen.getByRole('button', { name: '关闭浏览器 · late-browser' }))
        await waitFor(() => expect(browserApi.closeTab).toHaveBeenCalledOnce())
      }
      fireEvent.click(screen.getByRole('tab', { name: '工作区' }))
      await act(async () => rejectOperation(new Error('Late browser failure')))
      expect(screen.queryByText('Late browser failure')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('tab', { name: '浏览器 · late-browser' }))
      await waitFor(() => expect(browserApi.createTab).toHaveBeenCalledTimes(operation === 'create' ? 2 : 1))
      expect(screen.queryByText('Late browser failure')).not.toBeInTheDocument()
    }
  )

  it('rebinds a released tab before retrying navigation and can close a released instance', async () => {
    const conversationId = 'retry-browser'
    const onNavigateBrowser = vi.fn(async () => undefined)
    renderSidebar({ tab: 'browser', activeConversationId: conversationId, onNavigateBrowser })
    await waitFor(() => expect(browserApi.createTab).toHaveBeenCalledOnce())
    const owner = browserApi.createTab.mock.calls[0]![0].workbarInstanceId
    const stopped: BrowserLiveState = {
      ...browserSummary(conversationId, firstBrowserTabId, true),
      status: 'stopped',
      sessionActive: false
    }
    act(() => {
      for (const listener of browserStateListeners) listener(stopped)
    })
    browserApi.createTab.mockResolvedValueOnce(browserSummary(conversationId, secondBrowserTabId, true))
    fireEvent.change(screen.getByRole('textbox', { name: '浏览器地址' }), {
      target: { value: 'https://retry.example/' }
    })
    fireEvent.click(screen.getByRole('button', { name: '前往' }))
    await waitFor(() => expect(onNavigateBrowser).toHaveBeenCalledWith(
      conversationId, secondBrowserTabId, 'https://retry.example/'
    ))
    expect(browserApi.createTab).toHaveBeenLastCalledWith({ conversationId, workbarInstanceId: owner })
    act(() => {
      for (const listener of browserStateListeners) listener({ ...stopped, tabId: secondBrowserTabId })
    })
    fireEvent.click(screen.getByRole('button', { name: '关闭浏览器 · retry-browser' }))
    await waitFor(() => expect(screen.queryByRole('tab', { name: '浏览器 · retry-browser' })).not.toBeInTheDocument())
    expect(browserApi.closeTab).not.toHaveBeenCalled()
  })

  it('shows the request-created Main tab without creating a second blank page', async () => {
    const conversationId = 'request-browser'
    const workbarInstanceId = '00000000-0000-4000-8000-000000000499'
    const onNavigateBrowser = vi.fn(async () => undefined)
    renderSidebar({
      tab: 'browser',
      activeConversationId: conversationId,
      onNavigateBrowser,
      browserStates: {
        [conversationId]: {
          [firstBrowserTabId]: {
            ...browserSummary(conversationId, firstBrowserTabId, true),
            workbarInstanceId,
            sessionActive: true,
            url: 'https://agent.example/'
          }
        }
      }
    })
    await waitFor(() => expect(screen.getByRole('textbox', { name: '浏览器地址' })).toHaveValue('https://agent.example/'))
    expect(browserApi.createTab).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '前往' }))
    await waitFor(() => expect(onNavigateBrowser).toHaveBeenCalledWith(
      conversationId, firstBrowserTabId, 'https://agent.example/'
    ))
    expect(browserApi.createTab).not.toHaveBeenCalled()
  })

  it('retains a request page at layout capacity and binds it after a slot is closed', async () => {
    const conversationId = 'full-workbar'
    const instances = [
      ...DEFAULT_WORKBAR_INSTANCES.filter((instance) => instance.appId === 'tasks' || instance.appId === 'workspace'),
      ...Array.from({ length: 30 }, (_, index) => ({
        id: crypto.randomUUID(),
        appId: 'browser' as const,
        title: `parked-${index}`,
        targetRef: { type: 'conversation' as const, conversationId }
      }))
    ]
    localStorage.setItem('goodbuddy.workbar-layout.v1', JSON.stringify({
      instances, activeInstanceId: instances[0]!.id,
      expanded: true, dock: 'right', widthRatio: 0.3,
      taskScope: 'current-project'
    }))
    const workbarInstanceId = '00000000-0000-4000-8000-000000000497'
    renderSidebar({
      tab: 'browser', activeConversationId: conversationId,
      browserStates: {
        [conversationId]: {
          [firstBrowserTabId]: {
            ...browserSummary(conversationId, firstBrowserTabId, true),
            workbarInstanceId, sessionActive: true, url: 'https://retained.example/'
          }
        }
      }
    })
    expect(screen.getByRole('alert')).toHaveTextContent('请关闭一个可关闭页签')
    expect(screen.getAllByRole('tab')).toHaveLength(32)
    expect(browserApi.createTab).not.toHaveBeenCalled()
    expect(workbarLayoutPreferencesSchema.safeParse(
      JSON.parse(localStorage.getItem('goodbuddy.workbar-layout.v1')!)
    ).success).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '关闭parked-0' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: '浏览器地址' })).toHaveValue('https://retained.example/'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(32)
    expect(browserApi.createTab).not.toHaveBeenCalled()
    const restored = workbarLayoutPreferencesSchema.parse(
      JSON.parse(localStorage.getItem('goodbuddy.workbar-layout.v1')!)
    )
    expect(restored.instances.some((instance) => instance.id === workbarInstanceId)).toBe(true)
    expect(restored.activeInstanceId).toBe(workbarInstanceId)
  })

  it('preserves an explicit cross-conversation tab selection when the external app follows it', async () => {
    const onTabChange = vi.fn()
    const view = render(sidebarElement({
      tab: 'browser', activeConversationId: 'conversation-a', onTabChange
    }))
    await waitFor(() => expect(browserApi.createTab).toHaveBeenCalledOnce())
    view.rerender(sidebarElement({
      tab: 'browser', activeConversationId: 'conversation-b', onTabChange
    }))
    fireEvent.click(screen.getByRole('button', { name: '打开工作栏应用' }))
    fireEvent.click(screen.getByText('浏览器', { selector: 'strong' }).closest('button')!)
    await waitFor(() => expect(browserApi.createTab).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('tab', { name: '任务中心' }))
    view.rerender(sidebarElement({
      tab: 'tasks', activeConversationId: 'conversation-b', onTabChange
    }))
    const browserA = screen.getByRole('tab', { name: '浏览器 · conversation-a' })
    fireEvent.click(browserA)
    expect(onTabChange).toHaveBeenLastCalledWith('browser')
    view.rerender(sidebarElement({
      tab: 'browser', activeConversationId: 'conversation-b', onTabChange
    }))
    expect(browserA).toHaveAttribute('aria-selected', 'true')
  })

  it('releases the native browser for portalled modals until the last modal closes', async () => {
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 500, height: 400, left: 900, right: 1300, top: 100,
      width: 400, x: 900, y: 100, toJSON: () => ({})
    })
    const modal = document.createElement('section')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    const nested = modal.cloneNode() as HTMLElement
    try {
      renderSidebar({ tab: 'browser', activeConversationId: 'modal-browser' })
      await waitFor(() => expect(browserApi.setViewport).toHaveBeenLastCalledWith(
        expect.objectContaining({ conversationId: 'modal-browser', bounds: expect.any(Object) })
      ))
      const lease = browserApi.setViewport.mock.calls.at(-1)![0].leaseToken
      document.body.append(modal)
      await waitFor(() => expect(browserApi.setViewport).toHaveBeenLastCalledWith({ leaseToken: lease }))
      document.body.append(nested)
      modal.remove()
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
      expect(browserApi.setViewport).toHaveBeenLastCalledWith({ leaseToken: lease })
      nested.remove()
      await waitFor(() => expect(browserApi.setViewport).toHaveBeenLastCalledWith(
        expect.objectContaining({ conversationId: 'modal-browser', leaseToken: lease, bounds: expect.any(Object) })
      ))
      expect(browserApi.closeTab).not.toHaveBeenCalled()
      expect(browserApi.createTab).toHaveBeenCalledTimes(1)
    } finally {
      modal.remove()
      nested.remove()
      bounds.mockRestore()
    }
  })
  it.each(['menu', 'dialog', 'notification'])('hides the native view only while an overlapping %s is visible', async (kind) => {
    const popup = document.createElement('section')
    if (kind === 'notification') popup.className = 'app-notification'
    else popup.setAttribute('role', kind)
    popup.hidden = true
    let overlapping = true
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const left = this === popup && !overlapping ? 100 : 900
      return {
        bottom: 500, height: 400, left, right: left + 400, top: 100,
        width: 400, x: left, y: 100, toJSON: () => ({})
      }
    })
    try {
      document.body.append(popup)
      renderSidebar({ tab: 'browser', activeConversationId: 'popup-browser' })
      await waitFor(() => expect(browserApi.setViewport).toHaveBeenLastCalledWith(
        expect.objectContaining({ conversationId: 'popup-browser', bounds: expect.any(Object) })
      ))
      const lease = browserApi.setViewport.mock.calls.at(-1)![0].leaseToken
      popup.hidden = false
      await waitFor(() => expect(browserApi.setViewport).toHaveBeenLastCalledWith({ leaseToken: lease }))
      overlapping = false
      fireEvent(window, new Event('resize'))
      await waitFor(() => expect(browserApi.setViewport).toHaveBeenLastCalledWith(
        expect.objectContaining({ conversationId: 'popup-browser', bounds: expect.any(Object) })
      ))
      overlapping = true
      fireEvent(window, new Event('resize'))
      await waitFor(() => expect(browserApi.setViewport).toHaveBeenLastCalledWith({ leaseToken: lease }))
      popup.hidden = true
      await waitFor(() => expect(browserApi.setViewport).toHaveBeenLastCalledWith(
        expect.objectContaining({ conversationId: 'popup-browser', bounds: expect.any(Object) })
      ))
    } finally {
      popup.remove()
      bounds.mockRestore()
    }
  })
  it('does not acquire a native view behind an already open modal or restore an inactive tab', async () => {
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 500, height: 400, left: 900, right: 1300, top: 100,
      width: 400, x: 900, y: 100, toJSON: () => ({})
    })
    const modal = document.createElement('section')
    modal.setAttribute('aria-modal', 'true')
    try {
      document.body.append(modal)
      renderSidebar({ tab: 'browser', activeConversationId: 'covered-browser' })
      await waitFor(() => expect(browserApi.setViewport).toHaveBeenCalled())
      expect(browserApi.setViewport.mock.calls.every(([request]) => !('bounds' in request))).toBe(true)
      fireEvent.click(screen.getByRole('tab', { name: '工作区' }))
      modal.remove()
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
      expect(browserApi.setViewport.mock.calls.every(([request]) => !('bounds' in request))).toBe(true)
    } finally {
      modal.remove()
      bounds.mockRestore()
    }
  })
  it('releases the native browser viewport while confirming another terminal close', async () => {
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 500, height: 400, left: 900, right: 1300, top: 100,
      width: 400, x: 900, y: 100, toJSON: () => ({})
    })
    try {
      renderSidebar({ tab: 'browser', activeConversationId: 'modal-browser' })
      await waitFor(() => expect(browserApi.setViewport).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'modal-browser', bounds: expect.any(Object) })
      ))
      fireEvent.click(screen.getByRole('button', { name: '打开工作栏应用' }))
      fireEvent.click(screen.getByText('终端', { selector: 'strong' }).closest('button')!)
      fireEvent.click(await screen.findByRole('button', { name: 'Start test terminal' }))
      fireEvent.click(screen.getByRole('tab', { name: '浏览器 · modal-browser' }))
      await waitFor(() => expect(browserApi.setViewport).toHaveBeenLastCalledWith(
        expect.objectContaining({ conversationId: 'modal-browser', bounds: expect.any(Object) })
      ))
      const activeViewport = browserApi.setViewport.mock.calls.at(-1)![0]
      fireEvent.click(screen.getByRole('button', { name: '关闭终端 1' }))
      await waitFor(() => expect(browserApi.setViewport).toHaveBeenLastCalledWith({
        leaseToken: activeViewport.leaseToken
      }))
      const dialog = screen.getByRole('alertdialog')
      fireEvent.click(within(dialog).getByRole('button', { name: /取消/u }))
      await waitFor(() => expect(browserApi.setViewport).toHaveBeenLastCalledWith(
        expect.objectContaining({ conversationId: 'modal-browser', bounds: expect.any(Object) })
      ))
    } finally {
      bounds.mockRestore()
    }
  })
})
