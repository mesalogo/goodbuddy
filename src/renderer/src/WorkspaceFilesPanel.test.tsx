import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { changeUiLocale } from './i18n'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel'

afterEach(async () => {
  cleanup()
  await changeUiLocale('zh-CN')
})

describe('WorkspaceFilesPanel', () => {
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
    expect(screen.getAllByText('修改')).not.toHaveLength(0)
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
    expect(screen.getByText('Modified')).toBeInTheDocument()
    expect(onListDirectory).toHaveBeenCalledOnce()
  })
})
