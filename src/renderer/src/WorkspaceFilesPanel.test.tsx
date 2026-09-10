import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { changeUiLocale } from './i18n'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitStatusLetter, WorkspaceFilesPanel } from './WorkspaceFilesPanel'
import type { WorkspaceManagementAction, WorkspaceManagementResult } from '../../shared/workspace-management-contracts'

beforeEach(() => vi.stubGlobal('goodbuddy', { workspace: { manage: vi.fn(async () => ({ kind: 'branches', current: 'main', branches: [] })) } }))

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await changeUiLocale('zh-CN')
})

describe('WorkspaceFilesPanel', () => {
  it('groups view switching and refresh, and only shows actions for the active view', async () => {
    const onRefresh = vi.fn(async () => undefined)
    const { container } = render(<WorkspaceFilesPanel projectId="project" isRepository rootPath="D:\\workspace\\demo"
      changedFiles={[]} onRefresh={onRefresh}
      onListDirectory={vi.fn(async () => ({ path: '', entries: [], truncated: false }))}
      onLoadDiff={vi.fn()} onOpenFile={vi.fn()} />)
    const createFile = await screen.findByRole('button', { name: '新建文件' })
    const header = container.querySelector<HTMLElement>('.workspace-files__header')!
    expect(within(header).getByRole('button', { name: '文件' })).toBeInTheDocument()
    expect(within(header).getByRole('button', { name: 'Git 工作区' })).toBeInTheDocument()
    expect(within(header).getByRole('button', { name: '刷新工作区文件' })).toBeInTheDocument()
    expect(header).not.toContainElement(createFile)
    expect(screen.queryByRole('navigation', { name: '路径' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'demo' })).not.toBeInTheDocument()
    fireEvent.click(within(header).getByRole('button', { name: 'Git 工作区' }))
    expect(await screen.findByRole('button', { name: 'main' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新建文件' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新建目录' })).not.toBeInTheDocument()
    fireEvent.click(within(header).getByRole('button', { name: '刷新工作区文件' }))
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce())
    fireEvent.click(within(header).getByRole('button', { name: '文件' }))
    expect(screen.getByRole('button', { name: '新建文件' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Fetch' })).not.toBeInTheDocument()
  })

  it.each(['D:\\workspace\\demo', '/workspace/demo'])('keeps text breadcrumbs only in subdirectories of %s', async (rootPath) => {
    const onListDirectory = vi.fn(async (path: string) => ({
      path, truncated: false,
      entries: path ? [{ name: 'guide.md', path: 'docs/guide.md', type: 'file' as const }]
        : [{ name: 'docs', path: 'docs', type: 'directory' as const }]
    }))
    render(<WorkspaceFilesPanel projectId="project" isRepository rootPath={rootPath} changedFiles={[]}
      onListDirectory={onListDirectory} onLoadDiff={vi.fn()} onOpenFile={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'docs 的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '浏览此目录' }))
    await screen.findByRole('button', { name: 'guide.md' })
    const nav = screen.getByRole('navigation', { name: '路径' })
    expect(within(nav).getByRole('button', { name: 'demo' })).toHaveAttribute('title', rootPath)
    expect(within(nav).getByRole('button', { name: 'docs' })).toHaveAttribute('aria-current', 'location')
    expect(screen.getByRole('button', { name: '新建文件' })).toHaveAttribute('title', '新建文件: docs')
    fireEvent.click(screen.getByRole('button', { name: 'Git 工作区' }))
    expect(screen.queryByRole('navigation', { name: '路径' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '文件' }))
    expect(screen.getByRole('button', { name: 'docs' })).toHaveAttribute('aria-current', 'location')
    fireEvent.click(screen.getByRole('button', { name: 'demo' }))
    expect(screen.queryByRole('navigation', { name: '路径' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '刷新工作区文件' })).toHaveFocus()
    expect(screen.getByRole('button', { name: '新建文件' })).toHaveAttribute('title', '新建文件: /')
    fireEvent.click(await screen.findByRole('button', { name: 'docs 的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '浏览此目录' }))
    fireEvent.click(screen.getByRole('button', { name: '返回父目录' }))
    expect(screen.queryByRole('navigation', { name: '路径' })).not.toBeInTheDocument()
  })

  it('styles branch search as a shared field and preserves filtering, switching and creation', async () => {
    let current = 'main'
    const manage = vi.fn(async (_project: string, action: WorkspaceManagementAction): Promise<WorkspaceManagementResult> => {
      if (action.kind === 'switchBranch' || action.kind === 'createBranch') {
        current = action.branch
        return { kind: 'done' }
      }
      return { kind: 'branches', current, branches: [
        { name: 'main', remote: false },
        { name: 'origin/topic', remote: true }
      ] }
    })
    vi.stubGlobal('goodbuddy', { workspace: { manage } })
    const onRefresh = vi.fn(async () => undefined)
    render(<WorkspaceFilesPanel projectId="project" isRepository changedFiles={[]} onRefresh={onRefresh}
      onListDirectory={vi.fn(async () => ({ path: '', entries: [], truncated: false }))}
      onLoadDiff={vi.fn()} onOpenFile={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Git 工作区' }))
    const trigger = await screen.findByRole('button', { name: 'main' })
    fireEvent.click(trigger)
    const search = screen.getByRole('textbox', { name: '搜索本地或远程分支 / 新分支名称' })
    expect(search.closest('label')).toHaveClass('field')
    expect(search.previousElementSibling?.tagName).toBe('SPAN')
    expect(search).toHaveFocus()
    expect(screen.getByRole('button', { name: '创建并切换分支' })).toBeDisabled()
    fireEvent.change(search, { target: { value: 'topic' } })
    expect(screen.queryByRole('button', { name: /main\s*本地/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /origin\/topic\s*远程/ }))
    await waitFor(() => expect(manage).toHaveBeenCalledWith('project', { kind: 'switchBranch', branch: 'origin/topic', remote: true }))
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce())
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    fireEvent.click(trigger)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new-topic' } })
    fireEvent.click(screen.getByRole('button', { name: '创建并切换分支' }))
    await waitFor(() => expect(manage).toHaveBeenCalledWith('project', { kind: 'createBranch', branch: 'new-topic' }))
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2))
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(manage.mock.calls.some(([, action]) => action.kind === 'fetch')).toBe(false)
  })

  it.each([false, true])('keeps Git operations usable when a task refresh occurs during history pagination (failure: %s)', async (fail) => {
    const head = 'a'.repeat(40)
    const initial = { oid: head, subject: 'Latest commit', author: 'Author', time: '2026-09-09T10:00:00Z', refs: 'HEAD -> main' }
    let resolvePage!: (value: WorkspaceManagementResult) => void
    let rejectPage!: (reason: Error) => void
    const page = new Promise<WorkspaceManagementResult>((resolve, reject) => { resolvePage = resolve; rejectPage = reject })
    const manage = vi.fn(async (_project: string, action: WorkspaceManagementAction): Promise<WorkspaceManagementResult> => {
      if (action.kind === 'history') return action.offset
        ? page
        : { kind: 'history', head, commits: [initial], hasMore: true }
      if (action.kind === 'fetch') return { kind: 'done' }
      return { kind: 'branches', current: 'main', branches: [] }
    })
    vi.stubGlobal('goodbuddy', { workspace: { manage } })
    const props = {
      projectId: 'project', isRepository: true, changedFiles: [],
      onListDirectory: vi.fn(async () => ({ path: '', entries: [], truncated: false })),
      onLoadDiff: vi.fn(), onOpenFile: vi.fn(), onRefresh: vi.fn(async () => undefined)
    }
    const { rerender } = render(<WorkspaceFilesPanel {...props} refreshToken={0} />)
    await waitFor(() => expect(props.onListDirectory).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Git 工作区' }))
    fireEvent.click(screen.getByRole('button', { name: '提交历史' }))
    fireEvent.click(await screen.findByRole('button', { name: '加载更多提交' }))
    expect(screen.getByRole('button', { name: 'Fetch' })).toBeDisabled()
    expect(manage).toHaveBeenCalledWith('project', { kind: 'history', offset: 1, head })
    rerender(<WorkspaceFilesPanel {...props} refreshToken={1} />)
    await waitFor(() => expect(manage.mock.calls.filter(([, action]) => action.kind === 'branches')).toHaveLength(2))
    await act(async () => {
      if (fail) rejectPage(new Error('History temporarily unavailable'))
      else resolvePage({ kind: 'history', head, commits: [{ ...initial, oid: 'b'.repeat(40), subject: 'Older commit' }], hasMore: false })
    })
    if (fail) {
      expect(screen.getByRole('alert')).toHaveTextContent('History temporarily unavailable')
      expect(screen.getByRole('button', { name: '重试' })).toBeEnabled()
    } else expect(screen.getByText('Older commit')).toBeInTheDocument()
    expect(screen.getByText('Latest commit')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fetch' })).toBeEnabled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Fetch' }))
    await waitFor(() => expect(props.onRefresh).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fetch' })).toBeEnabled())
    expect(manage).toHaveBeenCalledWith('project', { kind: 'fetch' })
  })

  it.each([false, true])('refreshes the browsed directory once even when its tree entry is not expanded (expanded: %s)', async (expanded) => {
    let version = 0
    const onListDirectory = vi.fn(async (path: string) => ({
      path, truncated: false, entries: path
        ? [{ name: `file-${version}.txt`, path: `${path}/file-${version}.txt`, type: 'file' as const }]
        : [{ name: 'docs', path: 'docs', type: 'directory' as const }]
    }))
    const props = { projectId: 'project', changedFiles: [], onListDirectory, onLoadDiff: vi.fn(), onOpenFile: vi.fn() }
    const { rerender } = render(<WorkspaceFilesPanel {...props} refreshToken={version} />)
    const directory = await screen.findByRole('button', { name: 'docs' })
    if (expanded) {
      fireEvent.click(directory)
      await screen.findByRole('button', { name: 'file-0.txt' })
    } else expect(directory).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'docs 的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '浏览此目录' }))
    await screen.findByRole('button', { name: 'file-0.txt' })
    expect(screen.getByRole('button', { name: 'docs' })).toHaveAttribute('aria-current', 'location')
    const beforeRefresh = onListDirectory.mock.calls.length
    version++
    rerender(<WorkspaceFilesPanel {...props} refreshToken={version} />)
    await screen.findByRole('button', { name: 'file-1.txt' })
    expect(screen.queryByRole('button', { name: 'file-0.txt' })).not.toBeInTheDocument()
    expect(onListDirectory.mock.calls.slice(beforeRefresh)).toEqual([[''], ['docs']])
    expect(screen.getByRole('button', { name: 'docs' })).toHaveAttribute('aria-current', 'location')
  })

  it('keeps directory navigation and compact actions bounded independently', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
    expect(css.match(/\.workspace-files__actions\s*\{([^}]*)\}/)?.[1]).toContain('flex-wrap: nowrap')
    expect(css.match(/\.workspace-files__breadcrumb-parts\s*\{([^}]*)\}/)?.[1]).toContain('overflow-x: auto')
    expect(css.match(/\.workspace-files__breadcrumb-parts button\s*\{([^}]*)\}/)?.[1]).toContain('text-overflow: ellipsis')
    const menu = css.match(/\.workspace-files__menu\s*\{([^}]*)\}/)?.[1]
    expect(menu).toContain('position: fixed')
    expect(menu).toContain('max-width: calc(100vw - 16px)')
    expect(menu).toContain('max-height: calc(100vh - 16px)')
    const more = css.match(/\.workspace-files__more\s*\{([^}]*)\}/)?.[1]
    expect(more).toContain('position: absolute')
    expect(more).toContain('top: 50%')
    expect(css).toMatch(/\.workspace-files__menu button\s*\{[^}]*justify-content: flex-start/)
    expect(css.match(/^\.workspace-git__commit\s*\{([^}]*)\}/m)?.[1]).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(css).toMatch(/\.workspace-git__toolbar\s*\{[^}]*flex-wrap: wrap;[^}]*gap: var\(--space-2\)/)
    expect(css).toMatch(/\.workspace-files__view-switch\s*\{[^}]*align-self: flex-start/)
    expect(css).toMatch(/\.workspace-git__toolbar > \.segmented-control\s*\{[^}]*width: max-content;[^}]*border: 0/)
    expect(css).toMatch(/\.workspace-git__branch-trigger\s*\{[^}]*width: auto;[^}]*height: 32px;[^}]*flex: 0 1 auto;[^}]*text-align: left/)
    expect(css).toMatch(/\.workspace-files__header\s*\{[^}]*justify-content: space-between/)
    expect(css).toMatch(/\.workspace-git__branches\s*\{[^}]*width: min\(100%, 360px\);[^}]*border-radius: var\(--radius-control\)/)
    expect(css).toMatch(/\.workspace-git__branch-list\s*\{[^}]*max-height: 240px;[^}]*overflow: auto/)
    expect(css).toMatch(/\.workspace-git__create-branch\s*\{[^}]*justify-self: start/)
  })

  it.each([
    ['D:\\project', 'd:\\project\\target', 'target/notes.txt'],
    ['/project', '/project', 'notes.txt'],
    ['/', '/target', 'target/notes.txt']
  ])('moves into the native directory selection inside %s', async (rootPath, directory, destination) => {
    const selectWorkspace = vi.fn(async () => directory)
    const manage = vi.fn(async () => ({ kind: 'done' }))
    vi.stubGlobal('goodbuddy', { projects: { list: vi.fn(async () => [{ id: 'project', rootPath }]) }, settings: { selectWorkspace }, workspace: { manage } })
    render(<WorkspaceFilesPanel projectId="project" rootPath={rootPath} changedFiles={[]}
      onListDirectory={vi.fn(async () => ({ path: '', entries: [{ name: 'notes.txt', path: 'source/notes.txt', type: 'file' as const }], truncated: false }))}
      onLoadDiff={vi.fn()} onOpenFile={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'notes.txt 的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '移动' }))
    const dialog = screen.getByRole('dialog', { name: '移动' })
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '取消' })).toHaveClass('secondary-button')
    expect(within(dialog).getByRole('button', { name: '移动' })).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('button', { name: '目标目录 选择目录' }))
    await within(dialog).findByText(directory)
    expect(selectWorkspace).toHaveBeenCalledOnce()
    fireEvent.click(within(dialog).getByRole('button', { name: '移动' }))
    await waitFor(() => expect(manage).toHaveBeenCalledWith('project', { kind: 'move', path: 'source/notes.txt', destination }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('keeps native picker cancellation and outside-workspace choices from moving files', async () => {
    const selectWorkspace = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce('D:\\project-other').mockResolvedValueOnce('D:\\project\\..\\outside')
    const manage = vi.fn()
    vi.stubGlobal('goodbuddy', { projects: { list: vi.fn(async () => [{ id: 'project', rootPath: 'D:\\project' }]) }, settings: { selectWorkspace }, workspace: { manage } })
    render(<WorkspaceFilesPanel projectId="project" changedFiles={[]}
      onListDirectory={vi.fn(async () => ({ path: '', entries: [{ name: 'notes.txt', path: 'notes.txt', type: 'file' as const }], truncated: false }))}
      onLoadDiff={vi.fn()} onOpenFile={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'notes.txt 的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '移动' }))
    const choose = screen.getByRole('button', { name: '目标目录 选择目录' })
    fireEvent.click(choose)
    await waitFor(() => expect(choose).toBeEnabled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    for (let attempt = 0; attempt < 2; attempt++) {
      fireEvent.click(choose)
      expect(await screen.findByRole('alert')).toHaveTextContent('暂不支持移动到此工作区之外')
      await waitFor(() => expect(choose).toBeEnabled())
      expect(screen.getByRole('button', { name: '移动' })).toBeDisabled()
    }
    expect(manage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('browses remote move destinations on the project host and maps the selected directory', async () => {
    const browseDirectories = vi.fn(async (_host: string, path: string) => ({ path, parentPath: '/remote', entries: path === '/remote/project' ? [{ name: 'target', path: '/remote/project/target' }] : [] }))
    const cancelDirectoryBrowse = vi.fn(async () => undefined)
    const selectWorkspace = vi.fn()
    const manage = vi.fn(async () => ({ kind: 'done' }))
    vi.stubGlobal('goodbuddy', { projects: { list: vi.fn(async () => [{ id: 'project', executionSpace: { kind: 'ssh', hostId: 'host', remoteRootPath: '/remote/project' } }]) }, settings: { selectWorkspace }, sshHosts: { browseDirectories, cancelDirectoryBrowse }, workspace: { manage } })
    render(<WorkspaceFilesPanel projectId="project" changedFiles={[]}
      onListDirectory={vi.fn(async () => ({ path: '', entries: [{ name: 'notes.txt', path: 'notes.txt', type: 'file' as const }], truncated: false }))}
      onLoadDiff={vi.fn()} onOpenFile={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'notes.txt 的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '移动' }))
    fireEvent.click(screen.getByRole('button', { name: '目标目录 选择目录' }))
    fireEvent.click(await screen.findByRole('button', { name: 'target' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '选择此目录' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '选择此目录' }))
    fireEvent.click(screen.getByRole('button', { name: '移动' }))
    await waitFor(() => expect(manage).toHaveBeenCalledWith('project', { kind: 'move', path: 'notes.txt', destination: 'target/notes.txt' }))
    expect(browseDirectories.mock.calls).toEqual([['host', '/remote/project'], ['host', '/remote/project/target']])
    expect(selectWorkspace).not.toHaveBeenCalled()
  })

  it('uses shared Git controls and opens compact commit rows into file details', async () => {
    const manage = vi.fn(async (_project: string, action: { kind: string }) => action.kind === 'history'
      ? { kind: 'history', commits: [{ oid: 'a'.repeat(40), subject: 'Initial commit', author: 'Author', time: '2026-09-09T10:00:00Z', refs: 'HEAD -> main' }], hasMore: false }
      : action.kind === 'commitFiles' ? { kind: 'commitFiles', files: [{ path: 'notes.txt', status: 'A' }] }
        : { kind: 'branches', current: 'main', branches: [] })
    vi.stubGlobal('goodbuddy', { workspace: { manage } })
    render(<WorkspaceFilesPanel projectId="project" isRepository changedFiles={[]}
      onListDirectory={vi.fn(async () => ({ path: '', entries: [], truncated: false }))} onLoadDiff={vi.fn()} onOpenFile={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Git 工作区' }))
    expect(await screen.findByRole('button', { name: 'main' })).toHaveClass('model-button')
    expect(screen.getByRole('button', { name: 'Fetch' })).toHaveClass('secondary-button')
    expect(screen.getByRole('button', { name: 'Fetch' })).toHaveAttribute('title', 'Fetch')
    const toolbar = screen.getByRole('button', { name: 'main' }).closest('.workspace-git__toolbar')!
    expect(within(toolbar as HTMLElement).getByRole('button', { name: '列表' })).toHaveClass('segmented-control__option')
    const history = screen.getByRole('button', { name: '提交历史' })
    expect(history).toHaveClass('workspace-files__changed-row')
    expect(history).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(history)
    const commit = (await screen.findByText('Initial commit')).closest('button')!
    expect(commit).toHaveClass('workspace-files__changed-row', 'workspace-git__commit')
    fireEvent.click(commit)
    expect(await screen.findByRole('button', { name: /notes\.txt/ })).toHaveClass('workspace-files__changed-row')
  })

  it('cancels an in-flight remote directory browse without moving or reopening the dialog', async () => {
    let resolveBrowse!: (value: unknown) => void
    const browseDirectories = vi.fn(() => new Promise(resolve => { resolveBrowse = resolve }))
    const cancelDirectoryBrowse = vi.fn(async () => undefined)
    const manage = vi.fn()
    vi.stubGlobal('goodbuddy', { projects: { list: vi.fn(async () => [{ id: 'project', executionSpace: { kind: 'ssh', hostId: 'host', remoteRootPath: '/project' } }]) }, sshHosts: { browseDirectories, cancelDirectoryBrowse }, workspace: { manage } })
    render(<WorkspaceFilesPanel projectId="project" changedFiles={[]}
      onListDirectory={vi.fn(async () => ({ path: '', entries: [{ name: 'notes.txt', path: 'notes.txt', type: 'file' as const }], truncated: false }))}
      onLoadDiff={vi.fn()} onOpenFile={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'notes.txt 的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '移动' }))
    fireEvent.click(screen.getByRole('button', { name: '目标目录 选择目录' }))
    await waitFor(() => expect(browseDirectories).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(cancelDirectoryBrowse).toHaveBeenCalledOnce()
    await act(async () => resolveBrowse({ path: '/project', entries: [] }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(manage).not.toHaveBeenCalled()
  })

  it('portals and clamps the row menu, supports keyboard navigation and restores focus', async () => {
    const { container } = render(<WorkspaceFilesPanel projectId="project" changedFiles={[]}
      onListDirectory={vi.fn(async () => ({ path: '', entries: [{ name: 'notes.txt', path: 'notes.txt', type: 'file' as const }], truncated: false }))}
      onLoadDiff={vi.fn()} onOpenFile={vi.fn()} />)
    const trigger = await screen.findByRole('button', { name: 'notes.txt 的更多操作' })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ right: window.innerWidth + 50, bottom: window.innerHeight + 50 } as DOMRect)
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const menu = screen.getByRole('menu', { name: 'notes.txt' })
    expect(container).not.toContainElement(menu)
    expect(menu.parentElement).toBe(document.body)
    expect(parseFloat(menu.style.left)).toBeLessThanOrEqual(window.innerWidth - 8)
    expect(parseFloat(menu.style.top)).toBeLessThanOrEqual(window.innerHeight - 8)
    expect(within(menu).getByRole('menuitem', { name: '重命名' })).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'End' })
    expect(within(menu).getByRole('menuitem', { name: '删除' })).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'Home' })
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(within(menu).getByRole('menuitem', { name: '移动' })).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
  it.each([['??', 'U'], [' M', 'M'], ['A ', 'A'], [' D', 'D'], ['R ', 'R'], ['C ', 'C'], ['UU', 'U'], ['AM', 'AM'], [' T', 'T']])('maps %s to %s without calling every new file added', (status, letter) => {
    expect(gitStatusLetter(status)).toBe(letter)
  })
  it('lists the project tree, expands directories, and opens files', async () => {
    const onListDirectory = vi.fn(async (path: string) =>
      path
        ? {
            path,
            entries: [
              {
                name: 'guide.md',
                path: 'docs/guide.md',
                type: 'file' as const
              }
            ],
            truncated: false
          }
        : {
            path,
            entries: [
              {
                name: 'docs',
                path: 'docs',
                type: 'directory' as const
              },
              {
                name: 'notes.txt',
                path: 'notes.txt',
                type: 'file' as const
              }
            ],
            truncated: false
          }
    )
    const onOpenFile = vi.fn()
    const onOpenEntry = vi.fn(async () => undefined)

    render(
      <WorkspaceFilesPanel
        onLoadDiff={vi.fn()}
        changedFiles={[{ path: 'notes.txt', status: ' M' }]}
        onListDirectory={onListDirectory}
        onOpenEntry={onOpenEntry}
        onOpenFile={onOpenFile}
        projectId="00000000-0000-4000-8000-000000000101"
      />
    )

    expect(screen.queryByRole('navigation', { name: '路径' })).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'docs' }))
    fireEvent.click(
      await screen.findByRole('button', { name: 'guide.md' })
    )

    expect(onListDirectory).toHaveBeenCalledWith('')
    expect(onListDirectory).toHaveBeenCalledWith('docs')
    expect(onOpenFile).toHaveBeenCalledWith('docs/guide.md')
    fireEvent.click(screen.getByLabelText('guide.md 的更多操作'))
    fireEvent.click(within(screen.getByRole('menu', { name: 'guide.md' })).getByRole('menuitem', { name: '使用默认应用打开' }))
    expect(onOpenEntry).toHaveBeenCalledWith('docs/guide.md', 'file')
    fireEvent.click(screen.getByLabelText('docs 的更多操作'))
    fireEvent.click(within(screen.getByRole('menu', { name: 'docs' })).getByRole('menuitem', { name: '使用默认应用打开' }))
    expect(onOpenEntry).toHaveBeenCalledWith('docs', 'directory')
    expect(screen.getAllByText('M')).not.toHaveLength(0)
  })

  it('ignores stale directory results after the active project changes', async () => {
    let resolveFirst:
      | ((value: {
          path: string
          entries: []
          truncated: false
        }) => void)
      | undefined
    const onListDirectory = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValue({
        path: '',
        entries: [],
        truncated: false
      })
    const { rerender } = render(
      <WorkspaceFilesPanel
        onLoadDiff={vi.fn()}
        changedFiles={[]}
        onListDirectory={onListDirectory}
        onOpenEntry={vi.fn(async () => undefined)}
        onOpenFile={vi.fn()}
        projectId="00000000-0000-4000-8000-000000000101"
      />
    )

    await waitFor(() => expect(onListDirectory).toHaveBeenCalledOnce())
    rerender(
      <WorkspaceFilesPanel
        onLoadDiff={vi.fn()}
        changedFiles={[]}
        onListDirectory={onListDirectory}
        onOpenEntry={vi.fn(async () => undefined)}
        onOpenFile={vi.fn()}
        projectId="00000000-0000-4000-8000-000000000102"
      />
    )
    resolveFirst?.({ path: '', entries: [], truncated: false })

    await waitFor(() => expect(onListDirectory).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('工作区为空。')).toBeInTheDocument()
  })

  it('switches navigation to English without reloading the directory', async () => {
    const onListDirectory = vi.fn(async (path: string) => ({
      path,
      entries: [],
      truncated: false
    }))

    render(
      <WorkspaceFilesPanel isRepository
        onLoadDiff={vi.fn()}
        changedFiles={[{ path: 'notes.txt', status: ' M' }]}
        onListDirectory={onListDirectory}
        onOpenEntry={vi.fn(async () => undefined)}
        onOpenFile={vi.fn()}
        projectId="00000000-0000-4000-8000-000000000101"
      />
    )

    await screen.findByText('工作区为空。')
    expect(onListDirectory).toHaveBeenCalledOnce()
    await changeUiLocale('en-US')

    expect(
      await screen.findByRole('button', { name: 'Files' })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Git Workspace' }))
    expect(screen.getByText('M')).toBeInTheDocument()
    expect(onListDirectory).toHaveBeenCalledOnce()
  })
  it('refreshes expanded directories and reloads collapsed directories when reopened', async () => {
    let version = 0
    const onListDirectory = vi.fn(async (path: string) => ({
      path,
      entries: path ? [{ name: `file-${version}.txt`, path: `${path}/file-${version}.txt`, type: 'file' as const }]
        : [{ name: 'docs', path: 'docs', type: 'directory' as const }],
      truncated: false
    }))
    const props = { projectId: 'project', changedFiles: [], onListDirectory, onLoadDiff: vi.fn(), onOpenFile: vi.fn() }
    const { rerender } = render(<WorkspaceFilesPanel {...props} refreshToken={version} />)
    fireEvent.click(await screen.findByRole('button', { name: 'docs' }))
    await screen.findByText('file-0.txt')
    version += 1
    rerender(<WorkspaceFilesPanel {...props} refreshToken={version} />)
    await screen.findByText('file-1.txt')
    expect(screen.queryByText('file-0.txt')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'docs' })).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'docs' }))
    version += 1
    rerender(<WorkspaceFilesPanel {...props} refreshToken={version} />)
    await waitFor(() => expect(onListDirectory).toHaveBeenCalledTimes(5))
    fireEvent.click(screen.getByRole('button', { name: 'docs' }))
    await screen.findByText('file-2.txt')
    expect(screen.queryByRole('button', { name: /默认应用|资源管理器/ })).not.toBeInTheDocument()
  })

  it('opens a deleted file diff rather than reading the missing file', async () => {
    const onLoadDiff = vi.fn(async () => ({ rootPath: '/project', available: true, files: [], status: '', patch: '-deleted content', stagedPatch: '-staged content', truncated: true }))
    const onOpenFile = vi.fn()
    render(<WorkspaceFilesPanel isRepository projectId="project" changedFiles={[{ path: 'deleted.txt', status: ' D' }]}
      onListDirectory={vi.fn(async () => ({ path: '', entries: [], truncated: false }))}
      onLoadDiff={onLoadDiff} onOpenFile={onOpenFile} />)
    fireEvent.click(screen.getByRole('button', { name: 'Git 工作区' }))
    fireEvent.click(screen.getByRole('button', { name: /deleted.txt/ }))
    await screen.findByText('-deleted content')
    expect(screen.getByText('-staged content')).toBeInTheDocument()
    expect(screen.getByText('差异内容已截断。')).toBeInTheDocument()
    expect(onLoadDiff).toHaveBeenCalledWith('deleted.txt')
    expect(onOpenFile).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '查看当前文件' })).not.toBeInTheDocument()
  })

  it('reloads the selected diff on refresh and ignores an older pending response', async () => {
    let resolveOld!: (value: Awaited<ReturnType<typeof onLoadDiff>>) => void
    const value = { rootPath: '/project', available: true, files: [], status: '', patch: '+fresh', stagedPatch: '', truncated: false }
    const onLoadDiff = vi.fn<() => Promise<typeof value>>()
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
      .mockResolvedValue(value)
    const props = {
      isRepository: true, projectId: 'project', changedFiles: [{ path: 'seed.txt', status: ' M' }],
      onListDirectory: vi.fn(async () => ({ path: '', entries: [], truncated: false })),
      onLoadDiff, onOpenFile: vi.fn()
    }
    const view = render(<WorkspaceFilesPanel {...props} refreshToken={0} />)
    await waitFor(() => expect(props.onListDirectory).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Git 工作区' }))
    fireEvent.click(screen.getByRole('button', { name: /seed.txt/ }))
    view.rerender(<WorkspaceFilesPanel {...props} refreshToken={1} />)
    await screen.findByText('+fresh')
    await act(async () => resolveOld({ ...value, patch: '+stale' }))
    expect(screen.queryByText('+stale')).not.toBeInTheDocument()
    expect(onLoadDiff).toHaveBeenCalledTimes(2)
  })

  it('loads more changed files so deleted files after the first batch have a diff entry', async () => {
    const onLoadDiff = vi.fn(async () => ({
      rootPath: '/project', available: true, files: [], status: '',
      patch: '-last deleted', stagedPatch: '', truncated: false
    }))
    render(<WorkspaceFilesPanel isRepository
      projectId="project"
      changedFiles={Array.from({ length: 51 }, (_, index) => ({ path: `deleted-${index}.txt`, status: ' D' }))}
      onListDirectory={vi.fn(async () => ({ path: '', entries: [], truncated: false }))}
      onLoadDiff={onLoadDiff} onOpenFile={vi.fn()}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Git 工作区' }))
    expect(screen.queryByRole('button', { name: /deleted-50.txt/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '加载更多变更（剩余 1 个）' }))
    fireEvent.click(screen.getByRole('button', { name: /deleted-50.txt/ }))
    await screen.findByText('-last deleted')
    expect(onLoadDiff).toHaveBeenCalledWith('deleted-50.txt')
  })

  it('preserves mounted rows, expansion, selection, view and scroll when returning from a diff', async () => {
    const onListDirectory = vi.fn(async (path: string) => ({ path, truncated: false,
      entries: path ? [{ name: 'guide.md', path: 'docs/guide.md', type: 'file' as const }]
        : [{ name: 'docs', path: 'docs', type: 'directory' as const }] }))
    const onOpenFile = vi.fn()
    const props = { isRepository: true, projectId: 'project', changedFiles: [{ path: 'docs/guide.md', status: ' M' }], onListDirectory,
      onLoadDiff: vi.fn(async () => ({ rootPath: '/project', available: true, files: [], status: '', patch: '+updated', truncated: false })), onOpenFile }
    const { container, rerender } = render(<div className="assistant-sidebar__body"><section><WorkspaceFilesPanel {...props} /></section></div>)
    expect(screen.getByRole('button', { name: '文件' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(await screen.findByRole('button', { name: 'docs' }))
    const fileRow = (await screen.findByText('guide.md')).closest('button')!
    fireEvent.click(fileRow)
    expect(fileRow).toHaveAttribute('aria-current', 'true')
    rerender(<div className="assistant-sidebar__body"><section hidden><WorkspaceFilesPanel {...props} /></section></div>)
    // Simulate the parent hiding its existing section without unmounting the panel.
    rerender(<div className="assistant-sidebar__body"><section><WorkspaceFilesPanel {...props} /></section></div>)
    expect(screen.getByText('guide.md').closest('button')).toBe(fileRow)
    expect(fileRow).toHaveAttribute('aria-current', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Git 工作区' }))
    const changedRow = screen.getByRole('button', { name: /docs\/guide\.md/ })
    const treeRow = container.querySelector('.workspace-files__row[title="docs/guide.md"]')
    const scroller = container.firstElementChild as HTMLElement
    scroller.scrollTop = 340
    scroller.scrollLeft = 12
    fireEvent.click(changedRow)
    await screen.findByText('+updated')
    expect(treeRow).toBeInTheDocument()
    expect(changedRow).not.toBeVisible()
    expect(scroller.scrollTop).toBe(0)
    expect(screen.getByRole('button', { name: '返回未提交更改' })).toHaveFocus()
    scroller.scrollTop = 90
    fireEvent.click(screen.getByRole('button', { name: '返回未提交更改' }))
    expect(changedRow).toHaveFocus()
    expect(changedRow).toHaveAttribute('aria-current', 'true')
    expect(scroller.scrollTop).toBe(340)
    expect(scroller.scrollLeft).toBe(12)
    expect(screen.getByRole('button', { name: 'Git 工作区' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: '文件' }))
    expect(screen.getByRole('button', { name: 'docs' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('guide.md').closest('button')).toBe(treeRow)
  })

  it('retains root and expanded listings on refresh failure and retries each directory locally', async () => {
    let fail = false
    const onListDirectory = vi.fn(async (path: string) => {
      if (fail) throw new Error(`Cannot read ${path || 'root'}`)
      return { path, truncated: false, entries: path
        ? [{ name: 'guide.md', path: 'docs/guide.md', type: 'file' as const }]
        : [{ name: 'docs', path: 'docs', type: 'directory' as const }] }
    })
    const props = { projectId: 'project', changedFiles: [], onListDirectory, onLoadDiff: vi.fn(), onOpenFile: vi.fn() }
    const { rerender } = render(<WorkspaceFilesPanel {...props} refreshToken={0} />)
    fireEvent.click(await screen.findByRole('button', { name: 'docs' }))
    const row = await screen.findByRole('button', { name: 'guide.md' })
    fail = true
    rerender(<WorkspaceFilesPanel {...props} refreshToken={1} />)
    await screen.findByText('Cannot read root')
    expect(screen.getByText('Cannot read docs')).toBeInTheDocument()
    expect(row).toBeVisible()
    fail = false
    const calls = onListDirectory.mock.calls.length
    fireEvent.click(screen.getByText('Cannot read docs').querySelector('button')!)
    await waitFor(() => expect(screen.queryByText('Cannot read docs')).not.toBeInTheDocument())
    expect(onListDirectory).toHaveBeenCalledTimes(calls + 1)
    expect(onListDirectory).toHaveBeenLastCalledWith('docs')
    fireEvent.click(screen.getByText('Cannot read root').querySelector('button')!)
    await waitFor(() => expect(screen.queryByText('Cannot read root')).not.toBeInTheDocument())
    expect(onListDirectory).toHaveBeenLastCalledWith('')
  })

  it('shows Git errors and empty states only in changes view', async () => {
    const props = { projectId: 'project', changedFiles: [], onListDirectory: vi.fn(async () => ({ path: '', entries: [], truncated: false })), onLoadDiff: vi.fn(), onOpenFile: vi.fn() }
    const { rerender } = render(<WorkspaceFilesPanel {...props} gitError="Git offline" />)
    await screen.findByText('工作区为空。')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Git 工作区' })).not.toBeInTheDocument()
    rerender(<WorkspaceFilesPanel {...props} isRepository={false} />)
    expect(screen.queryByRole('button', { name: 'Git 工作区' })).not.toBeInTheDocument()
    rerender(<WorkspaceFilesPanel {...props} isRepository />)
    fireEvent.click(screen.getByRole('button', { name: 'Git 工作区' }))
    expect(screen.getByText(/没有未提交的更改/)).toBeVisible()
    rerender(<WorkspaceFilesPanel {...props} isRepository={false} gitError="Git offline" />)
    expect(screen.getByRole('button', { name: 'Git 工作区' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Git offline')
  })

  it('views the current file, refreshes a diff and copies its relative path with recoverable errors', async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error('Clipboard busy')).mockResolvedValue(undefined)
    vi.stubGlobal('goodbuddy', { ...window.goodbuddy, clipboard: { writeText } })
    const onOpenFile = vi.fn()
    const onLoadDiff = vi.fn(async () => ({ rootPath: '/project', available: true, files: [], status: '', patch: '+content', truncated: false }))
    const onListDirectory = vi.fn(async () => ({ path: '', entries: [], truncated: false }))
    render(<WorkspaceFilesPanel isRepository projectId="project" changedFiles={[{ path: 'docs/a.md', status: ' M' }]} onOpenFile={onOpenFile} onLoadDiff={onLoadDiff} onListDirectory={onListDirectory} />)
    await waitFor(() => expect(onListDirectory).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Git 工作区' }))
    fireEvent.click(screen.getByRole('button', { name: /docs\/a\.md/ }))
    await screen.findByText('+content')
    fireEvent.click(screen.getByRole('button', { name: '查看当前文件' }))
    expect(onOpenFile).toHaveBeenCalledWith('docs/a.md')
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(onLoadDiff).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: '复制相对路径' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('复制路径失败。 Clipboard busy')
    fireEvent.click(screen.getByRole('button', { name: '复制相对路径' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(writeText).toHaveBeenLastCalledWith('docs/a.md')
  })
})
