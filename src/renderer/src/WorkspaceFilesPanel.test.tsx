import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { changeUiLocale } from './i18n'
import { gitStatusLetter, WorkspaceFilesPanel } from './WorkspaceFilesPanel'

afterEach(async () => {
  cleanup()
  await changeUiLocale('zh-CN')
})

describe('WorkspaceFilesPanel', () => {
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

    expect(await screen.findByText('当前工作区')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'docs' }))
    fireEvent.click(
      await screen.findByRole('button', { name: 'guide.md' })
    )

    expect(onListDirectory).toHaveBeenCalledWith('')
    expect(onListDirectory).toHaveBeenCalledWith('docs')
    expect(onOpenFile).toHaveBeenCalledWith('docs/guide.md')
    fireEvent.click(
      screen.getByRole('button', {
        name: '使用默认应用打开文件 guide.md'
      })
    )
    expect(onOpenEntry).toHaveBeenCalledWith('docs/guide.md', 'file')
    fireEvent.click(
      screen.getByRole('button', {
        name: '在系统资源管理器中打开文件夹 docs'
      })
    )
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
      <WorkspaceFilesPanel
        onLoadDiff={vi.fn()}
        changedFiles={[{ path: 'notes.txt', status: ' M' }]}
        onListDirectory={onListDirectory}
        onOpenEntry={vi.fn(async () => undefined)}
        onOpenFile={vi.fn()}
        projectId="00000000-0000-4000-8000-000000000101"
      />
    )

    await screen.findByText('当前工作区')
    expect(onListDirectory).toHaveBeenCalledOnce()
    await changeUiLocale('en-US')

    expect(
      await screen.findByText('Current workspace')
    ).toBeInTheDocument()
    expect(screen.getByText('Uncommitted changes')).toBeInTheDocument()
    expect(screen.getByText('M')).toBeInTheDocument()
    expect(onListDirectory).toHaveBeenCalledOnce()
  })
  it('refreshes expanded directories and drops collapsed caches without remounting', async () => {
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
    render(<WorkspaceFilesPanel projectId="project" changedFiles={[{ path: 'deleted.txt', status: ' D' }]}
      onListDirectory={vi.fn(async () => ({ path: '', entries: [], truncated: false }))}
      onLoadDiff={onLoadDiff} onOpenFile={onOpenFile} />)
    fireEvent.click(screen.getByRole('button', { name: /deleted.txt/ }))
    await screen.findByText('-deleted content')
    expect(screen.getByText('-staged content')).toBeInTheDocument()
    expect(screen.getByText('差异内容已截断。')).toBeInTheDocument()
    expect(onLoadDiff).toHaveBeenCalledWith('deleted.txt')
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('reloads the selected diff on refresh and ignores an older pending response', async () => {
    let resolveOld!: (value: Awaited<ReturnType<typeof onLoadDiff>>) => void
    const value = { rootPath: '/project', available: true, files: [], status: '', patch: '+fresh', stagedPatch: '', truncated: false }
    const onLoadDiff = vi.fn<() => Promise<typeof value>>()
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
      .mockResolvedValue(value)
    const props = {
      projectId: 'project', changedFiles: [{ path: 'seed.txt', status: ' M' }],
      onListDirectory: vi.fn(async () => ({ path: '', entries: [], truncated: false })),
      onLoadDiff, onOpenFile: vi.fn()
    }
    const view = render(<WorkspaceFilesPanel {...props} refreshToken={0} />)
    await waitFor(() => expect(props.onListDirectory).toHaveBeenCalledOnce())
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
    render(<WorkspaceFilesPanel
      projectId="project"
      changedFiles={Array.from({ length: 51 }, (_, index) => ({ path: `deleted-${index}.txt`, status: ' D' }))}
      onListDirectory={vi.fn(async () => ({ path: '', entries: [], truncated: false }))}
      onLoadDiff={onLoadDiff} onOpenFile={vi.fn()}
    />)
    expect(screen.queryByRole('button', { name: /deleted-50.txt/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '加载更多变更（剩余 1 个）' }))
    fireEvent.click(screen.getByRole('button', { name: /deleted-50.txt/ }))
    await screen.findByText('-last deleted')
    expect(onLoadDiff).toHaveBeenCalledWith('deleted-50.txt')
  })
})
