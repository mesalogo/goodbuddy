import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  useState,
  type ReactNode
} from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  WorkbarTabInstance,
  WorkbarTargetRef
} from '../../shared/workbar-contracts'
import {
  DEFAULT_WORKBAR_INSTANCES,
  WorkbarShell,
  type WorkbarInstanceCreateRequest
} from './WorkbarShell'

afterEach(cleanup)

const terminalOne: WorkbarTabInstance = {
  id: '20000000-0000-4000-8000-000000000001',
  appId: 'terminal',
  title: '终端 · 本机 1',
  targetRef: { type: 'local' }
}
const stylesheet = readFileSync(
  join(process.cwd(), 'src', 'renderer', 'src', 'styles.css'),
  'utf8'
)

function ControlledShell({
  initialInstances = DEFAULT_WORKBAR_INSTANCES,
  onCreate = vi.fn(),
  onTerminalTarget = vi.fn((): WorkbarTargetRef => ({
    type: 'local'
  }))
}: {
  initialInstances?: readonly WorkbarTabInstance[]
  onCreate?: (request: WorkbarInstanceCreateRequest) => void
  onTerminalTarget?: () =>
    | WorkbarTargetRef
    | Promise<WorkbarTargetRef>
}): ReactNode {
  const [instances, setInstances] = useState(initialInstances)
  const [activeId, setActiveId] = useState(
    initialInstances[0]?.id ?? null
  )

  return (
    <WorkbarShell
      activeInstanceId={activeId}
      instances={instances}
      onActiveInstanceChange={setActiveId}
      onCloseInstance={(instance) =>
        setInstances((current) =>
          current.filter((candidate) => candidate.id !== instance.id)
        )
      }
      onCreateInstance={onCreate}
      onResolveTerminalTarget={onTerminalTarget}
      renderPanel={(instance) => <p>{instance.title}内容</p>}
    />
  )
}

describe('WorkbarShell', () => {
  it('keeps tabs and their controls square', () => {
    expect(stylesheet).toMatch(
      /\.workbar-shell__tab-item\s*\{[^}]*border-radius:\s*0;/u
    )
    expect(stylesheet).toMatch(
      /\.workbar-shell__tab-close,\s*\n\.workbar-shell__add\s*\{[^}]*border-radius:\s*0;/u
    )
  })

  it('provides four default single-instance tabs and keeps add outside the tablist', () => {
    render(<ControlledShell />)

    const tablist = screen.getByRole('tablist', {
      name: '已打开的工作栏应用'
    })
    expect(within(tablist).getAllByRole('tab')).toHaveLength(4)
    expect(
      within(tablist).queryByRole('button', {
        name: '打开工作栏应用'
      })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '打开工作栏应用' })
    ).toBeVisible()
    expect(tablist.parentElement).toHaveClass(
      'workbar-shell__tab-scroll'
    )
    expect(
      screen.getByRole('tab', { name: '任务中心' }).parentElement
    ).toHaveClass('workbar-shell__tab-item--active')
    expect(
      screen.getByRole('tab', { name: '工作区' }).parentElement
    ).not.toHaveClass('workbar-shell__tab-item--active')
  })

  it('opens the catalog, focuses its first choice, and restores add-button focus on Escape', async () => {
    render(<ControlledShell />)
    const addButton = screen.getByRole('button', {
      name: '打开工作栏应用'
    })

    fireEvent.click(addButton)
    const firstChoice = screen
      .getByText('任务中心', { selector: 'strong' })
      .closest('button')!
    await waitFor(() => expect(firstChoice).toHaveFocus())
    expect(
      screen.getByRole('heading', { name: '新建工作栏应用' })
    ).toBeInTheDocument()

    fireEvent.keyDown(firstChoice, { key: 'Escape' })
    await waitFor(() => expect(addButton).toHaveFocus())
    expect(
      screen.queryByRole('heading', { name: '新建工作栏应用' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('tab', { name: '任务中心' })
    ).toHaveAttribute('aria-selected', 'true')
  })

  it('focuses an existing single instance instead of requesting a duplicate', async () => {
    const onCreate = vi.fn()
    render(<ControlledShell onCreate={onCreate} />)

    fireEvent.click(
      screen.getByRole('button', { name: '打开工作栏应用' })
    )
    fireEvent.click(
      screen
        .getByText('工作区', { selector: 'strong' })
        .closest('button')!
    )

    const workspaceTab = screen.getByRole('tab', {
      name: '工作区'
    })
    await waitFor(() => expect(workspaceTab).toHaveFocus())
    expect(workspaceTab).toHaveAttribute('aria-selected', 'true')
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('resolves the current terminal target for every multiple-instance creation', async () => {
    const onCreate = vi.fn()
    const onTerminalTarget = vi.fn((): WorkbarTargetRef => ({
      type: 'local'
    }))
    render(
      <ControlledShell
        initialInstances={[...DEFAULT_WORKBAR_INSTANCES, terminalOne]}
        onCreate={onCreate}
        onTerminalTarget={onTerminalTarget}
      />
    )

    for (let count = 1; count <= 2; count += 1) {
      fireEvent.click(
        screen.getByRole('button', {
          name: '打开工作栏应用'
        })
      )
      fireEvent.click(
        screen.getByRole('button', { name: /^终端/u })
      )
      await waitFor(() =>
        expect(onCreate).toHaveBeenCalledTimes(count)
      )
    }

    expect(onTerminalTarget).toHaveBeenCalledTimes(2)
    expect(onCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        appId: 'terminal',
        targetRef: { type: 'local' }
      })
    )
  })

  it('supports roving Arrow, Home, and End navigation', () => {
    render(<ControlledShell />)
    const tasks = screen.getByRole('tab', { name: '任务中心' })

    tasks.focus()
    fireEvent.keyDown(tasks, { key: 'ArrowRight' })
    const workspace = screen.getByRole('tab', { name: '工作区' })
    expect(workspace).toHaveFocus()
    expect(workspace).toHaveAttribute('tabindex', '0')

    fireEvent.keyDown(workspace, { key: 'End' })
    const results = screen.getByRole('tab', { name: '成果' })
    expect(results).toHaveFocus()

    fireEvent.keyDown(results, { key: 'Home' })
    expect(tasks).toHaveFocus()
  })

  it('closes the active tab, activates its right neighbor, and restores focus', async () => {
    render(<ControlledShell />)
    const workspace = screen.getByRole('tab', { name: '工作区' })
    fireEvent.click(workspace)
    fireEvent.click(
      screen.getByRole('button', { name: '关闭工作区' })
    )

    const browser = screen.getByRole('tab', { name: '浏览器' })
    await waitFor(() => expect(browser).toHaveFocus())
    expect(browser).toHaveAttribute('aria-selected', 'true')
    expect(
      screen.queryByRole('tab', { name: '工作区' })
    ).not.toBeInTheDocument()
  })

  it('keeps the current active tab focused when a background tab closes', async () => {
    render(<ControlledShell />)
    const tasks = screen.getByRole('tab', { name: '任务中心' })
    fireEvent.click(
      screen.getByRole('button', { name: '关闭成果' })
    )

    await waitFor(() => expect(tasks).toHaveFocus())
    expect(tasks).toHaveAttribute('aria-selected', 'true')
  })

  it('shows the empty state while preserving the add command after the last close', async () => {
    render(
      <ControlledShell initialInstances={[DEFAULT_WORKBAR_INSTANCES[0]!]} />
    )
    fireEvent.click(
      screen.getByRole('button', { name: '关闭任务中心' })
    )

    const addButton = screen.getByRole('button', {
      name: '打开工作栏应用'
    })
    await waitFor(() => expect(addButton).toHaveFocus())
    expect(
      screen.getByText('还没有打开的工作栏应用')
    ).toBeInTheDocument()
    expect(addButton).toBeVisible()
  })
})
