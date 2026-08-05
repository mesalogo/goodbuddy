import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RightAssistantSidebar } from './RightAssistantSidebar'

afterEach(cleanup)

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1400
  })
})

function renderSidebar(): HTMLElement {
  render(
    <RightAssistantSidebar
      activities={[]}
      approvals={[]}
      artifacts={[]}
      attachments={[]}
      enabledLibraries={[]}
      heartbeatEntries={[]}
      heartbeats={[]}
      memories={[]}
      onClose={vi.fn()}
      onCreateHeartbeat={vi.fn(async () => undefined)}
      onCreateMemory={vi.fn(async () => undefined)}
      onCreateSchedule={vi.fn(async () => undefined)}
      onImportArtifacts={vi.fn(async () => undefined)}
      onListWorkspaceDirectory={vi.fn(async (path: string) => ({
        path,
        entries: [],
        truncated: false
      }))}
      onLoadArtifact={vi.fn(async () => undefined)}
      onLoadWorkspaceFile={vi.fn()}
      onOpenConversation={vi.fn()}
      onOpenHeartbeat={vi.fn()}
      onRefreshChanges={vi.fn(async () => undefined)}
      onRemoveAttachment={vi.fn()}
      onRemoveHeartbeat={vi.fn(async () => undefined)}
      onRemoveMemory={vi.fn(async () => undefined)}
      onRemoveSchedule={vi.fn(async () => undefined)}
      onRespondApproval={vi.fn()}
      onRunHeartbeat={vi.fn(async () => undefined)}
      onRunSchedule={vi.fn(async () => undefined)}
      onSetHeartbeatPaused={vi.fn(async () => undefined)}
      onSetMemoryStatus={vi.fn(async () => undefined)}
      onStopBrowser={vi.fn(async () => undefined)}
      onTabChange={vi.fn()}
      open
      schedules={[]}
      tab="context"
      tasks={[]}
    />
  )

  return screen.getByRole('complementary', {
    name: '助手工作栏'
  })
}

describe('RightAssistantSidebar resizing', () => {
  it('resizes with pointer capture and clamps the resulting width', () => {
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
      clientX: 600,
      pointerId: 7
    })

    expect(setPointerCapture).toHaveBeenCalledWith(7)
    expect(sidebar).toHaveClass('assistant-sidebar--resizing')
    expect(
      sidebar.style.getPropertyValue('--assistant-sidebar-width')
    ).toBe('640px')

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
    ).toBe('366px')
    expect(separator).toHaveAttribute('aria-valuenow', '366')

    fireEvent.keyDown(separator, { key: 'Home' })
    expect(
      sidebar.style.getPropertyValue('--assistant-sidebar-width')
    ).toBe('300px')

    fireEvent.keyDown(separator, { key: 'End' })
    expect(
      sidebar.style.getPropertyValue('--assistant-sidebar-width')
    ).toBe('640px')
  })

  it('remains resizable when the sidebar overlays a medium window', () => {
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
})
