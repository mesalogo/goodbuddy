import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RightAssistantSidebar,
  type AssistantSidebarTab,
  type SidebarArtifact
} from './RightAssistantSidebar'

afterEach(cleanup)

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1400
  })
})

function renderSidebar({
  tab = 'context',
  artifacts = [],
  onLoadArtifact = vi.fn(async () => undefined),
  restoreFocusRef
}: {
  tab?: AssistantSidebarTab
  artifacts?: SidebarArtifact[]
  onLoadArtifact?: (artifactId: string) => Promise<void>
  restoreFocusRef?: { current: HTMLElement | null }
} = {}): HTMLElement {
  render(
    <div>
      <main className="workspace" />
      <RightAssistantSidebar
        approvals={[]}
        artifacts={artifacts}
        attachments={[]}
        enabledLibraries={[]}
        memories={[]}
        schedules={[]}
        tasks={[]}
        conversationTitles={new Map()}
        projectNames={new Map()}
        onCreateCustomTask={vi.fn()}
        onImportArtifacts={vi.fn(async () => undefined)}
        onListWorkspaceDirectory={vi.fn(async (path: string) => ({
          path,
          entries: [],
          truncated: false
        }))}
        onLoadArtifact={onLoadArtifact}
        onLoadWorkspaceFile={vi.fn()}
        onOpenWorkspaceEntry={vi.fn(async () => undefined)}
        onInteractBrowser={vi.fn(async () => undefined)}
        onRefreshChanges={vi.fn(async () => undefined)}
        onRemoveAttachment={vi.fn()}
        onRemoveSchedule={vi.fn(async () => undefined)}
        onRespondApproval={vi.fn()}
        onRunSchedule={vi.fn(async () => undefined)}
        onSetScheduleEnabled={vi.fn(async () => undefined)}
        onOpenTask={vi.fn()}
        onStopBrowser={vi.fn(async () => undefined)}
        onTabChange={vi.fn()}
        open
        restoreFocusRef={restoreFocusRef}
        tab={tab}
      />
    </div>
  )

  return screen.getByRole('complementary', {
    name: '助手工作栏'
  })
}

describe('RightAssistantSidebar resizing', () => {
  it('resizes with pointer capture and preserves equal pane minima', () => {
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
    ).toBe('1100px')
    expect(separator).toHaveAttribute('aria-valuemin', '300')
    expect(separator).toHaveAttribute('aria-valuemax', '1100')

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
    ).toBe('300px')

    fireEvent.keyDown(separator, { key: 'End' })
    expect(
      sidebar.style.getPropertyValue('--assistant-sidebar-width')
    ).toBe('1100px')
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

  it('keeps the equal minimum dock resizable in a narrow window', () => {
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
    ).toBe('300px')
    expect(sidebar).not.toHaveAttribute('aria-modal')
    expect(separator).toHaveAttribute('tabindex', '0')
    expect(separator).toHaveAttribute('aria-valuemin', '300')
    expect(separator).toHaveAttribute('aria-valuemax', '380')

    fireEvent.keyDown(separator, { key: 'End' })
    expect(
      sidebar.style.getPropertyValue('--assistant-sidebar-width')
    ).toBe('380px')
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
        expect(separator).toHaveAttribute('aria-valuemax', '600')
      )

      fireEvent.keyDown(separator, { key: 'End' })
      expect(
        sidebar.style.getPropertyValue('--assistant-sidebar-width')
      ).toBe('600px')
    } finally {
      getBoundingClientRect.mockRestore()
    }
  })

  it('exposes the task center and four reusable work surfaces', () => {
    renderSidebar()

    expect(
      screen.getAllByRole('tab').map((tab) => tab.textContent)
    ).toEqual(['任务中心', '上下文', '工作区', '浏览器', '成果'])
    expect(
      screen.queryByRole('tab', { name: '预览' })
    ).not.toBeInTheDocument()
  })

  it('keeps the docked sidebar non-modal', () => {
    const sidebar = renderSidebar()

    expect(sidebar).not.toHaveAttribute('aria-modal')
    expect(sidebar).toHaveAttribute('role', 'complementary')
  })

  it('keeps the product Task index in the task center', () => {
    renderSidebar({ tab: 'tasks' })

    expect(screen.getByText('等待审批')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '任务索引' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '新建定制任务' })
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('定时任务标题')).not.toBeInTheDocument()
    expect(screen.queryByText('最近任务')).not.toBeInTheDocument()
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
})
