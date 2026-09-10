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
  onClose,
  onTerminalTarget = vi.fn((): WorkbarTargetRef => ({
    type: 'local'
  }))
}: {
  initialInstances?: readonly WorkbarTabInstance[]
  onCreate?: (request: WorkbarInstanceCreateRequest) => void
  onClose?: (instance: WorkbarTabInstance) => boolean | void | Promise<boolean | void>
  onTerminalTarget?: () =>
    | WorkbarTargetRef
    | Promise<WorkbarTargetRef>
}): ReactNode {
  const [instances, setInstances] = useState(initialInstances)
  const [activeId, setActiveId] = useState(
    initialInstances[0]?.id ?? null
  )

  return (
    <>
      <output data-testid="active-workbar-instance">
        {activeId ?? 'none'}
      </output>
      <WorkbarShell
        activeInstanceId={activeId}
        instances={instances}
        onActiveInstanceChange={setActiveId}
        onCloseInstance={async (instance) => {
          const accepted = await onClose?.(instance)
          if (accepted === false) return false
          setInstances((current) =>
            current.filter((candidate) => candidate.id !== instance.id)
          )
          return true
        }}
        onCreateInstance={onCreate}
        onResolveTerminalTarget={onTerminalTarget}
        renderPanel={(instance) => <p>{instance.title}内容</p>}
      />
    </>
  )
}

describe('WorkbarShell', () => {
  it('keeps tabs and their controls rounded', () => {
    expect(stylesheet).toMatch(
      /\.workbar-shell__tab-item\s*\{[^}]*border-radius:\s*var\(--radius-control\) var\(--radius-control\) 0 0;/u
    )
    expect(stylesheet).toMatch(
      /\.workbar-shell__tab-close,\s*\n\.workbar-shell__add\s*\{[^}]*border-radius:\s*var\(--radius-control\);/u
    )
  })

  it('keeps the close control background transparent when a tab reveals it', () => {
    expect(stylesheet).toMatch(
      /\.workbar-shell__tab-close\s*\{[^}]*background:\s*transparent;/u
    )
  })

  it('provides fixed defaults plus a browser tab and keeps add outside the tablist', () => {
    render(<ControlledShell />)

    const tablist = screen.getByRole('tablist', {
      name: '已打开的工作栏应用'
    })
    expect(within(tablist).getAllByRole('tab')).toHaveLength(4)
    expect(within(tablist).getAllByRole('tab').map((tab) => tab.textContent))
      .toEqual(DEFAULT_WORKBAR_INSTANCES.map((instance) => instance.title))
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

  it('pins tasks and workspace in supplied layouts and navigates in displayed order', () => {
    const [tasks, workspace, browser, results] = DEFAULT_WORKBAR_INSTANCES
    render(
      <ControlledShell
        initialInstances={[terminalOne, workspace!, results!, tasks!, browser!]}
      />
    )

    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(
      [tasks!, workspace!, terminalOne, results!, browser!].map((instance) => instance.title)
    )
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(tabs[2]!, { key: 'Home' })
    expect(tabs[0]).toHaveFocus()
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' })
    expect(tabs[1]).toHaveFocus()
    fireEvent.keyDown(tabs[1]!, { key: 'ArrowRight' })
    expect(tabs[2]).toHaveFocus()
  })

  it('does not expose close controls for fixed tabs', () => {
    render(<ControlledShell />)

    expect(
      screen.queryByRole('button', { name: '关闭任务中心' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '关闭工作区' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '关闭浏览器' })
    ).toBeInTheDocument()
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

  it('allows another browser instance to be requested', () => {
    const onCreate = vi.fn()
    render(<ControlledShell onCreate={onCreate} />)

    fireEvent.click(
      screen.getByRole('button', { name: '打开工作栏应用' })
    )
    fireEvent.click(
      screen.getByText('浏览器', { selector: 'strong' }).closest('button')!
    )

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'browser' })
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

  it('closes an active closable tab, activates its neighbor, and restores focus', async () => {
    render(
      <ControlledShell
        initialInstances={[...DEFAULT_WORKBAR_INSTANCES, terminalOne]}
      />
    )
    const browser = screen.getByRole('tab', { name: '浏览器' })
    fireEvent.click(browser)
    fireEvent.click(
      screen.getByRole('button', { name: '关闭浏览器' })
    )

    const results = screen.getByRole('tab', { name: '成果' })
    await waitFor(() => expect(results).toHaveFocus())
    expect(results).toHaveAttribute('aria-selected', 'true')
    expect(
      screen.queryByRole('tab', { name: '浏览器' })
    ).not.toBeInTheDocument()
  })

  it('keeps the current active tab focused when a background tab closes', async () => {
    render(<ControlledShell />)
    const tasks = screen.getByRole('tab', { name: '任务中心' })
    fireEvent.click(
      screen.getByRole('button', { name: '关闭浏览器' })
    )

    await waitFor(() => expect(tasks).toHaveFocus())
    expect(tasks).toHaveAttribute('aria-selected', 'true')
  })

  it('retains an instance when its close operation rejects', async () => {
    const onClose = vi.fn(async () => {
      throw new Error('Close denied')
    })
    render(
      <ControlledShell
        initialInstances={[terminalOne]}
        onClose={onClose}
      />
    )

    fireEvent.click(
      screen.getByRole('button', { name: `关闭${terminalOne.title}` })
    )

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(screen.getByRole('tab', { name: terminalOne.title }))
      .toBeInTheDocument()
  })

  it('shows the empty state while preserving the add command after the last close', async () => {
    render(
      <ControlledShell initialInstances={[terminalOne]} />
    )
    fireEvent.click(
      screen.getByRole('button', { name: `关闭${terminalOne.title}` })
    )

    const addButton = screen.getByRole('button', {
      name: '打开工作栏应用'
    })
    await waitFor(() => expect(addButton).toHaveFocus())
    expect(
      screen.getByText('还没有打开的工作栏应用')
    ).toBeInTheDocument()
    expect(screen.getByTestId('active-workbar-instance')).toHaveTextContent(
      'none'
    )
    expect(addButton).toBeVisible()
  })
})
