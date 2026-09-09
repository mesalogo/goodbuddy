import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

afterEach(cleanup)

const firstBrowserTabId =
  '00000000-0000-4000-8000-000000000401' as BrowserTabId
const secondBrowserTabId =
  '00000000-0000-4000-8000-000000000402' as BrowserTabId
const browserApi = {
  createTab: vi.fn<(request: BrowserCreateTabRequest) => Promise<BrowserTabSummary>>(),
  closeTab: vi.fn(async () => undefined),
  setViewport: vi.fn<
    (request: BrowserSetViewportRequest) => Promise<void>
  >(async () => undefined)
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
  browserStates,
  onBackBrowser,
  onNavigateBrowser,
  onReloadBrowser,
  onStopLoadingBrowser
}: {
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
  browserStates?: Readonly<Record<string, Readonly<Record<string, BrowserLiveState>>>>
  onBackBrowser?: (conversationId: string, tabId: BrowserTabId) => Promise<void>
  onNavigateBrowser?: (conversationId: string, tabId: BrowserTabId, url: string) => Promise<void>
  onReloadBrowser?: (conversationId: string, tabId: BrowserTabId) => Promise<void>
  onStopLoadingBrowser?: (conversationId: string, tabId: BrowserTabId) => Promise<void>
} = {}): React.JSX.Element {
  return (
    <div>
      <main className="workspace" />
      <RightAssistantSidebar
        approvals={approvals}
        activeConversationId={activeConversationId}
        artifacts={artifacts}
        browserStates={browserStates}
        schedules={[]}
        tasks={tasks}
        conversationTitles={new Map()}
        currentProject={activeProject ?? undefined}
        projectNames={new Map()}
        onCreateCustomTask={vi.fn()}
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
        onRespondApproval={vi.fn()}
        onRunSchedule={vi.fn(async () => undefined)}
        onSetScheduleEnabled={vi.fn(async () => undefined)}
        onStopLoadingBrowser={onStopLoadingBrowser}
        onOpenTask={vi.fn()}
        onTabChange={vi.fn()}
        open
        restoreFocusRef={restoreFocusRef}
        tab={tab}
        workspaceProjectId={workspaceProjectId}
      />
    </div>
  )
}

function renderSidebar(options: Parameters<typeof sidebarElement>[0] = {}): HTMLElement {
  render(sidebarElement(options))
  return screen.getByRole('complementary', {
    name: '助手工作栏'
  })
}

describe('RightAssistantSidebar resizing', () => {
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

  it('keeps the product Task index in the task center', () => {
    renderSidebar({ tab: 'tasks' })

    expect(screen.getByText('等待审批')).toBeInTheDocument()
    const taskIndexHeading = screen.getByRole('heading', {
      name: '任务索引'
    })
    const newTaskButton = screen.getByRole('button', {
      name: '新建任务'
    })
    expect(taskIndexHeading.parentElement).toContainElement(
      newTaskButton
    )
    expect(
      screen.getByRole('group', { name: '筛选任务' })
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('定时任务标题')).not.toBeInTheDocument()
    expect(screen.queryByText('最近任务')).not.toBeInTheDocument()
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
    fireEvent.click(
      within(screen.getByRole('group', { name: '任务范围' })).getByRole(
        'button',
        { name: '全局' }
      )
    )
    expect(screen.getByText('全局审批')).toBeInTheDocument()
    expect(screen.queryByText('当前项目审批')).not.toBeInTheDocument()
    expect(screen.getByLabelText('等待审批: 1')).toBeInTheDocument()
  })

  it('scopes tasks to the current project, global tasks, or all projects and persists the choice', () => {
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

    fireEvent.click(
      within(screen.getByRole('group', { name: '任务范围' })).getByRole(
        'button',
        { name: '全局' }
      )
    )
    expect(screen.getByText('全局任务')).toBeInTheDocument()
    expect(screen.queryByText('当前项目任务')).not.toBeInTheDocument()

    fireEvent.click(
      within(screen.getByRole('group', { name: '任务范围' })).getByRole(
        'button',
        { name: '所有项目' }
      )
    )
    expect(screen.getByText('当前项目任务')).toBeInTheDocument()
    expect(screen.getByText('全局任务')).toBeInTheDocument()
    expect(screen.getByText('其他项目任务')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('goodbuddy.workbar-layout.v1')!))
      .toEqual(expect.objectContaining({ taskScope: 'all-projects' }))
  })

  it('shows a clear current-project empty state when no project is active', () => {
    renderSidebar({ activeProject: null })

    expect(
      screen.getByText(
        '没有活动项目。请选择其他任务范围或先打开一个项目。'
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
    expect(screen.getByRole('tab', { name: '浏览器 · conversation-b' })).toHaveAttribute('aria-selected', 'true')
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
      screen.getByRole('button', { name: /关闭浏览器 · conversation-a · 2/u })
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
    expect(screen.queryByRole('tab', { name: /· 2$/u })).not.toBeInTheDocument()
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
        screen.getByRole('tab', { name: `浏览器 · ${conversationId}` })
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
        screen.getByRole('tab', { name: `浏览器 · ${conversationId}` })
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
        screen.getByRole('tab', { name: `浏览器 · ${conversationId}` })
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
  })
})
