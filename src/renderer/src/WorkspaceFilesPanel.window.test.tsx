import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { changeUiLocale } from './i18n'
import { installFakeListLayout, type FakeListLayout } from './list-window-test-layout'
import { defaultMaxRenderedRows } from './use-list-window'
import { flattenFileTree, WorkspaceFilesPanel } from './WorkspaceFilesPanel'
import type { WorkspaceDirectoryListing } from '../../shared/assistant-contracts'

// 4 directories x 500 files (the per-directory listing cap) = 2,004 rows when all are expanded.
const directories = ['a', 'b', 'c', 'd']
const filesPer = 500
const fileName = (directory: string, index: number): string => `${directory}-${String(index).padStart(3, '0')}.txt`
const listing = (path: string): WorkspaceDirectoryListing => ({
  path, truncated: false,
  entries: path
    ? Array.from({ length: filesPer }, (_, index) => ({ name: fileName(path, index), path: `${path}/${fileName(path, index)}`, type: 'file' as const }))
    : directories.map((name) => ({ name, path: name, type: 'directory' as const }))
})

const rowHeight = 32
let layout: FakeListLayout
// The docked files view is the tree's scroller (see workspace-files-layout.electron.test.ts).
const body = (): HTMLElement => document.querySelector<HTMLElement>('.workspace-files__files-view')!
const tree = (): HTMLElement => document.querySelector<HTMLElement>('.workspace-files__tree')!
const rows = (): string[] => [...tree().querySelectorAll<HTMLElement>('.workspace-files__row')].map((row) => row.textContent ?? '')
const fileRow = (directory: string, index: number): HTMLElement | null =>
  tree().querySelector<HTMLElement>(`.workspace-files__row[title="${directory}/${fileName(directory, index)}"]`)

beforeEach(() => {
  vi.stubGlobal('goodbuddy', { workspace: { manage: vi.fn(async () => ({ kind: 'branches', current: 'main', branches: [] })) } })
  layout = installFakeListLayout({
    isContainer: (element) => element.classList.contains('workspace-files__files-view'),
    rowAttribute: 'data-workspace-file-row',
    rowHeight: () => rowHeight
  })
})

afterEach(async () => {
  cleanup()
  layout.restore()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await changeUiLocale('zh-CN')
})

async function setup(onOpenFile = vi.fn()) {
  const onListDirectory = vi.fn(async (path: string) => listing(path))
  const props = { projectId: 'project', changedFiles: [], onListDirectory, onLoadDiff: vi.fn(), onOpenFile }
  const view = render(<div className="assistant-sidebar__body"><section><WorkspaceFilesPanel {...props} /></section></div>)
  // Bottom-up: expanding a directory pushes the later ones out of the window.
  for (const directory of [...directories].reverse()) {
    fireEvent.click(await screen.findByRole('button', { name: directory }))
    await screen.findByText(fileName(directory, 0))
    layout.measure()
  }
  return { ...view, onListDirectory, props }
}

describe('WorkspaceFilesPanel tree windowing', () => {
  it('flattens expanded directories in display order with their status rows', () => {
    const listings = { '': listing(''), a: { ...listing('a'), truncated: true } }
    const flat = flattenFileTree(listings[''].entries, listings, new Set(['a', 'b']), new Set(['b']), { c: 'boom' })
    expect(flat.slice(0, 2).map((row) => row.key)).toEqual(['entry:a', 'entry:a/a-000.txt'])
    expect(flat[1]!.depth).toBe(1)
    expect(flat.slice(filesPer + 1, filesPer + 4).map((row) => row.key)).toEqual(['truncated:a', 'entry:b', 'loading:b'])
    // Errors show only for expanded directories, as before.
    expect(flat.some((row) => row.key === 'error:c')).toBe(false)
    expect(flat).toHaveLength(1 + filesPer + 1 + 1 + 1 + 2)
  })

  it('keeps the DOM bounded for 2,004 expanded rows and follows the files view scroll', async () => {
    await setup()
    const mounted = rows()
    expect(mounted.length).toBeGreaterThan(0)
    expect(mounted.length).toBeLessThanOrEqual(defaultMaxRenderedRows)
    expect(tree().getBoundingClientRect().height).toBe((directories.length * (filesPer + 1)) * rowHeight)
    // Row 1,002 is c/c-000 (a, 500 files, b, 500 files, c).
    layout.scroll(body(), 1_003 * rowHeight)
    expect(fileRow('c', 1)).toBeInTheDocument()
    expect(fileRow('a', 0)).toBeNull()
    expect(rows().length).toBeLessThanOrEqual(defaultMaxRenderedRows)
    // Indentation still shows the nesting.
    expect(fileRow('c', 1)!.parentElement!.style.marginLeft).toContain('1 *')
  }, 20_000)

  it('keeps the selected file and the open menu mounted, and scrolls back to the selection', async () => {
    const onOpenFile = vi.fn()
    await setup(onOpenFile)
    layout.scroll(body(), 1_600 * rowHeight)
    const target = fileRow('d', 97)!
    fireEvent.click(target)
    expect(onOpenFile).toHaveBeenCalledWith('d/d-097.txt')
    expect(target).toHaveAttribute('aria-current', 'true')
    layout.scroll(body(), 0)
    expect(fileRow('a', 0)).toBeInTheDocument()
    expect(fileRow('d', 97)).toBe(target)
    const offset = target.getBoundingClientRect().top + body().scrollTop
    expect(offset).toBe((3 * (filesPer + 1) + 1 + 97) * rowHeight)
    layout.scroll(body(), offset)
    expect(target.getBoundingClientRect().top).toBe(0)

    layout.scroll(body(), 0)
    fireEvent.click(screen.getByRole('button', { name: 'a-002.txt 的更多操作' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    layout.scroll(body(), 1_000 * rowHeight)
    expect(fileRow('a', 2)).toBeInTheDocument()
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'a-002.txt 的更多操作' })).toHaveFocus())
  }, 20_000)

  it('collapses and expands directories in the windowed tree', async () => {
    await setup()
    fireEvent.click(screen.getByRole('button', { name: 'a' }))
    expect(screen.getByRole('button', { name: 'a' })).toHaveAttribute('aria-expanded', 'false')
    layout.measure()
    expect(fileRow('a', 0)).toBeNull()
    expect(fileRow('b', 0)).toBeInTheDocument()
    expect(tree().getBoundingClientRect().height).toBe((directories.length * (filesPer + 1) - filesPer) * rowHeight)
    fireEvent.click(screen.getByRole('button', { name: 'a' }))
    await screen.findByText(fileName('a', 0))
    await act(async () => { await Promise.resolve() })
    expect(fileRow('a', 0)).toBeInTheDocument()
  }, 20_000)
})

