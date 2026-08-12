import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import {
  KnowledgeChunkManager,
  type KnowledgeChunkManagerProps,
  type KnowledgeChunkPage
} from './KnowledgeChunkManager'
import { changeUiLocale } from './i18n'

const chunkPage: KnowledgeChunkPage = {
  page: 1,
  pageSize: 20,
  totalItems: 21,
  items: [
    {
      id: 'chunk-1',
      ordinal: 1,
      role: 'child',
      parentChunkId: 'parent-1',
      heading: '安装模型',
      locator: '第 3 节',
      characterCount: 18,
      enabled: true,
      content: '可以导入已经校验的模型 ZIP。',
      manuallyEdited: true
    },
    {
      id: 'chunk-2',
      ordinal: 2,
      role: 'standalone',
      locator: '第 4 节',
      characterCount: 12,
      enabled: false,
      content: '服务不可用时使用本地回退。',
      manuallyEdited: false
    }
  ]
}

function createProps(
  overrides: Partial<KnowledgeChunkManagerProps> = {}
): KnowledgeChunkManagerProps {
  return {
    documentId: 'document-1',
    documentName: '离线部署.md',
    page: chunkPage,
    onList: vi.fn(),
    onUpdateChunk: vi.fn(),
    onDeleteChunk: vi.fn(),
    onRebuildDocument: vi.fn(),
    onClose: vi.fn(),
    ...overrides
  }
}

afterEach(async () => {
  cleanup()
  await changeUiLocale('zh-CN')
})

describe('KnowledgeChunkManager', () => {
  it('provides dialog semantics, focuses search, traps focus, and returns focus on Escape', async () => {
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(false)
      return (
        <>
          <div className="app-shell">
            <button onClick={() => setOpen(true)} type="button">
              查看分块
            </button>
          </div>
          {open && (
            <KnowledgeChunkManager
              {...createProps({ onClose: () => setOpen(false) })}
            />
          )}
        </>
      )
    }

    render(<Harness />)
    const trigger = screen.getByRole('button', { name: '查看分块' })
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = screen.getByRole('dialog', { name: '文档分块' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByLabelText('搜索文档内分块')).toHaveFocus()
    expect(screen.getAllByRole('switch')).toHaveLength(2)
    expect(
      screen.getByText('人工修改可能被替换。')
    ).toBeInTheDocument()

    const rebuild = screen.getByRole('button', { name: '重建文档' })
    rebuild.focus()
    fireEvent.keyDown(rebuild, { key: 'Tab' })
    expect(
      screen.getByRole('button', { name: '关闭文档分块' })
    ).toHaveFocus()

    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(trigger).toHaveFocus()
  })

  it('searches and paginates with a bounded list request', () => {
    const onList = vi.fn()
    render(<KnowledgeChunkManager {...createProps({ onList })} />)

    fireEvent.change(screen.getByLabelText('搜索文档内分块'), {
      target: { value: '模型' }
    })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    expect(onList).toHaveBeenCalledWith({
      documentId: 'document-1',
      page: 1,
      pageSize: 20,
      query: '模型'
    })

    fireEvent.click(screen.getByRole('button', { name: '下一页分块' }))
    expect(onList).toHaveBeenLastCalledWith({
      documentId: 'document-1',
      page: 2,
      pageSize: 20,
      query: '模型'
    })
  })

  it('switches enablement, edits content, validates, and preserves a failed draft', () => {
    const onUpdateChunk = vi.fn()
    const { rerender } = render(
      <KnowledgeChunkManager {...createProps({ onUpdateChunk })} />
    )

    fireEvent.click(screen.getByRole('switch', { name: '启用分块 1' }))
    expect(onUpdateChunk).toHaveBeenCalledWith('chunk-1', {
      enabled: false
    })

    const editor = screen.getByLabelText(/^分块内容/)
    fireEvent.change(editor, { target: { value: '保留的人工修正文稿' } })
    fireEvent.click(screen.getByRole('button', { name: '保存分块' }))
    expect(onUpdateChunk).toHaveBeenCalledWith('chunk-1', {
      content: '保留的人工修正文稿'
    })

    rerender(
      <KnowledgeChunkManager
        {...createProps({
          error: '向量重建失败，请重试。',
          onUpdateChunk
        })}
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      '向量重建失败，请重试。'
    )
    expect(
      screen.getByRole('switch', { name: '启用分块 1' })
    ).toBeChecked()
    expect(screen.getByLabelText(/^分块内容/)).toHaveValue(
      '保留的人工修正文稿'
    )

    fireEvent.change(screen.getByLabelText(/^分块内容/), {
      target: { value: '' }
    })
    expect(screen.getByText('分块内容不能为空。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存分块' })).toBeDisabled()
  })

  it('confirms a specific deletion, restores trigger focus on cancel, and invokes rebuild', () => {
    const onDeleteChunk = vi.fn()
    const onRebuildDocument = vi.fn()
    render(
      <KnowledgeChunkManager
        {...createProps({ onDeleteChunk, onRebuildDocument })}
      />
    )

    const deleteTrigger = screen.getByRole('button', {
      name: '删除分块 1'
    })
    fireEvent.click(deleteTrigger)
    const confirmation = screen.getByRole('alertdialog', {
      name: '确认删除分块 1'
    })
    expect(confirmation).toHaveAccessibleDescription(
      '删除分块 1 会移除其全文、中文、向量和图谱证据。来源同步或重建可能重新创建此分块；原始文件不会被删除。'
    )
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(
      screen.getByRole('button', { name: '删除分块 1' })
    ).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: '删除分块 1' }))
    fireEvent.click(
      screen.getByRole('button', { name: '确认删除分块 1' })
    )
    expect(onDeleteChunk).toHaveBeenCalledWith('chunk-1')

    fireEvent.click(screen.getByRole('button', { name: '重建文档' }))
    expect(onRebuildDocument).toHaveBeenCalledWith('document-1')
  })

  it('renders loading and zero states without a selected editor', () => {
    const { rerender } = render(
      <KnowledgeChunkManager {...createProps({ loading: true })} />
    )
    expect(screen.getByRole('status')).toHaveTextContent('正在加载分块')

    rerender(
      <KnowledgeChunkManager
        {...createProps({
          page: {
            items: [],
            page: 1,
            pageSize: 20,
            totalItems: 0
          }
        })}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      '没有符合条件的分块'
    )
    expect(screen.getByText('选择一个分块')).toBeInTheDocument()
  })
})
