import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  KnowledgeWorkspace,
  type KnowledgeWorkspaceProps
} from './KnowledgeWorkspace'

const library: KnowledgeWorkspaceProps['libraries'][number] = {
  id: 'library-1',
  name: '产品知识',
  description: '产品设计与研发资料',
  storageMode: 'managed',
  graphEnabled: true,
  graphStrategy: 'hybrid',
  sourceCount: 1,
  documentCount: 1,
  indexedDocumentCount: 1,
  updatedAt: '2026-07-30T08:00:00.000Z'
}

function createProps(
  overrides: Partial<KnowledgeWorkspaceProps> = {}
): KnowledgeWorkspaceProps {
  return {
    libraries: [library],
    selectedLibraryId: library.id,
    sources: [
      {
        id: 'source-1',
        libraryId: library.id,
        name: '产品手册',
        kind: 'directory',
        location: 'D:\\Private\\产品手册',
        status: 'ready',
        documentCount: 1,
        lastSyncedAt: '2026-07-30T08:00:00.000Z'
      }
    ],
    documents: [
      {
        id: 'document-1',
        libraryId: library.id,
        sourceId: 'source-1',
        name: '架构说明.md',
        path: 'D:\\Private\\架构说明.md',
        status: 'ready',
        indexProgress: 100,
        chunkCount: 12,
        size: 2048
      }
    ],
    graphNodes: [
      {
        id: 'entity-1',
        label: 'GoodBuddy',
        type: '产品',
        description: '跨平台 AI 桌面助手',
        aliases: ['好伙伴'],
        x: 180,
        y: 180,
        evidenceIds: ['evidence-1']
      },
      {
        id: 'entity-2',
        label: 'Electron',
        type: '技术',
        x: 480,
        y: 240
      }
    ],
    graphRelations: [
      {
        id: 'relation-1',
        sourceId: 'entity-1',
        targetId: 'entity-2',
        type: '使用'
      }
    ],
    evidence: [
      {
        id: 'evidence-1',
        documentId: 'document-1',
        documentName: '架构说明.md',
        excerpt: 'GoodBuddy 使用 Electron 构建。',
        location: '第 2 段'
      }
    ],
    onSelectLibrary: vi.fn(),
    onCreateLibrary: vi.fn(),
    onDeleteLibrary: vi.fn(),
    onUpdateLibrary: vi.fn(),
    onImportFiles: vi.fn(),
    onImportDirectory: vi.fn(),
    onImportUrl: vi.fn(),
    onSyncSource: vi.fn(),
    onPauseSource: vi.fn(),
    onRetrySource: vi.fn(),
    onRemoveSource: vi.fn(),
    onMoveNode: vi.fn(),
    onCreateEntity: vi.fn(),
    onUpdateEntity: vi.fn(),
    onDeleteEntity: vi.fn(),
    onMergeEntities: vi.fn(),
    onCreateRelation: vi.fn(),
    onUpdateRelation: vi.fn(),
    onDeleteRelation: vi.fn(),
    ...overrides
  }
}

describe('KnowledgeWorkspace', () => {
  afterEach(() => {
    cleanup()
  })

  it('creates a configured knowledge library', async () => {
    const onCreateLibrary = vi.fn()
    render(
      <KnowledgeWorkspace
        {...createProps({ onCreateLibrary })}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '新建知识库' }))
    fireEvent.change(screen.getByLabelText('名称'), {
      target: { value: '客户研究' }
    })
    fireEvent.change(screen.getByLabelText('描述'), {
      target: { value: '访谈与反馈' }
    })
    fireEvent.click(screen.getByLabelText(/引用原文件/))
    fireEvent.change(screen.getByLabelText('图谱生成策略'), {
      target: { value: 'rules' }
    })
    fireEvent.click(screen.getByRole('button', { name: '创建知识库' }))

    await waitFor(() =>
      expect(onCreateLibrary).toHaveBeenCalledWith({
        name: '客户研究',
        description: '访谈与反馈',
        storageMode: 'reference',
        graphEnabled: true,
        graphStrategy: 'rules'
      })
    )
  })

  it('imports an HTTP URL into the selected library', async () => {
    const onImportUrl = vi.fn()
    render(
      <KnowledgeWorkspace {...createProps({ onImportUrl })} />
    )

    fireEvent.click(screen.getByRole('button', { name: '导入 URL' }))
    fireEvent.change(screen.getByLabelText('URL 地址'), {
      target: { value: 'https://example.com/guide' }
    })
    fireEvent.click(screen.getByRole('button', { name: '导入' }))

    await waitFor(() =>
      expect(onImportUrl).toHaveBeenCalledWith(
        'library-1',
        'https://example.com/guide',
        undefined
      )
    )
  })

  it('switches to the graph and opens entity details', () => {
    render(<KnowledgeWorkspace {...createProps()} />)

    fireEvent.click(screen.getByRole('tab', { name: '知识图谱' }))
    expect(screen.getByLabelText('实体关系图')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '实体 GoodBuddy' }))
    expect(screen.getByLabelText('实体详情')).toBeInTheDocument()
    expect(screen.getByText('跨平台 AI 桌面助手')).toBeInTheDocument()
    expect(screen.getByText('架构说明.md')).toBeInTheDocument()
  })

  it('renders and filters graph nodes with their relationships', () => {
    render(<KnowledgeWorkspace {...createProps()} />)

    fireEvent.click(screen.getByRole('tab', { name: '知识图谱' }))
    expect(
      screen.getByRole('button', { name: '实体 GoodBuddy' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '实体 Electron' })
    ).toBeInTheDocument()
    expect(screen.getByText('使用')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('搜索图谱实体'), {
      target: { value: 'Electron' }
    })
    expect(
      screen.queryByRole('button', { name: '实体 GoodBuddy' })
    ).not.toBeInTheDocument()
    expect(screen.queryByText('使用')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('搜索图谱实体'), {
      target: { value: '' }
    })
    fireEvent.change(screen.getByLabelText('筛选实体类型'), {
      target: { value: '产品' }
    })
    expect(
      screen.getByRole('button', { name: '实体 GoodBuddy' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '实体 Electron' })
    ).not.toBeInTheDocument()
  })

  it('provides responsive workspace and graph layout hooks', () => {
    render(<KnowledgeWorkspace {...createProps()} />)

    const workspace = screen.getByLabelText('知识工作区')
    expect(workspace).toHaveClass('knowledge-workspace')
    expect(workspace).toHaveStyle({
      background: 'var(--surface-canvas)'
    })
    expect(workspace.querySelector('aside')).toHaveClass(
      'knowledge-workspace__sidebar'
    )
    expect(workspace.querySelector('main')).toHaveClass(
      'knowledge-workspace__main'
    )
    expect(workspace.querySelector('main')).toHaveStyle({
      background: 'var(--surface-raised)'
    })
    expect(screen.getByText('全局')).toHaveClass('scope-badge')
    expect(screen.getByRole('tablist', { name: '知识库视图' })).toHaveClass(
      'page-tabs'
    )
    expect(screen.getByLabelText('搜索文档').closest('label')).toHaveClass(
      'knowledge-documents__search'
    )
    expect(screen.getByText('本地文件 · 架构说明.md')).toBeInTheDocument()
    expect(screen.queryByText('D:\\Private\\架构说明.md')).not
      .toBeInTheDocument()
    expect(screen.queryByTitle('D:\\Private\\架构说明.md')).not
      .toBeInTheDocument()
    expect(screen.queryByTitle('D:\\Private\\产品手册')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '知识图谱' }))
    fireEvent.click(screen.getByRole('button', { name: '实体 GoodBuddy' }))
    expect(screen.getByLabelText('知识图谱画布').parentElement).toHaveClass(
      'knowledge-graph--with-details'
    )
    expect(screen.getByLabelText('实体详情')).toHaveClass(
      'knowledge-graph__detail'
    )
  })

  it('supports graph zoom, keyboard selection, and related-node navigation', () => {
    render(<KnowledgeWorkspace {...createProps()} />)

    fireEvent.click(screen.getByRole('tab', { name: '知识图谱' }))
    const graph = screen.getByLabelText('实体关系图')
    expect(graph).toHaveAttribute('viewBox', '0 0 900 560')

    fireEvent.click(screen.getByRole('button', { name: '放大图谱' }))
    expect(screen.getByText('115%')).toBeInTheDocument()
    expect(graph.getAttribute('viewBox')).not.toBe('0 0 900 560')

    fireEvent.keyDown(
      screen.getByRole('button', { name: '实体 GoodBuddy' }),
      { key: 'Enter' }
    )
    expect(screen.getByLabelText('实体详情')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看 Electron' }))
    expect(
      screen.getByRole('heading', { name: 'Electron' })
    ).toBeInTheDocument()
  })

  it('creates relationships, merges entities, and opens graph evidence', async () => {
    const onCreateRelation = vi.fn()
    const onMergeEntities = vi.fn()
    const onOpenEvidence = vi.fn()
    render(
      <KnowledgeWorkspace
        {...createProps({
          onCreateRelation,
          onMergeEntities,
          onOpenEvidence
        })}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '知识图谱' }))
    fireEvent.click(screen.getByRole('button', { name: '实体 GoodBuddy' }))
    fireEvent.click(
      screen.getByRole('button', { name: /架构说明\.md/u })
    )
    expect(onOpenEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'evidence-1' })
    )

    fireEvent.click(screen.getByRole('button', { name: '新增' }))
    fireEvent.change(screen.getByLabelText('关系类型'), {
      target: { value: '依赖' }
    })
    fireEvent.change(screen.getByLabelText('说明'), {
      target: { value: '桌面运行基础' }
    })
    fireEvent.click(screen.getByRole('button', { name: '新增关系' }))
    await waitFor(() =>
      expect(onCreateRelation).toHaveBeenCalledWith({
        sourceId: 'entity-1',
        targetId: 'entity-2',
        type: '依赖',
        description: '桌面运行基础'
      })
    )

    fireEvent.change(screen.getByLabelText('选择合并目标'), {
      target: { value: 'entity-2' }
    })
    fireEvent.click(screen.getByRole('button', { name: '合并到目标实体' }))
    expect(onMergeEntities).toHaveBeenCalledWith('entity-1', 'entity-2')
  })

  it('renders an explicit empty graph state', () => {
    render(
      <KnowledgeWorkspace
        {...createProps({ graphNodes: [], graphRelations: [] })}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '知识图谱' }))
    expect(
      screen.getByText('当前知识库尚未生成实体关系。')
    ).toBeInTheDocument()
  })

  it('keeps loading distinct from the first-library empty state', () => {
    render(
      <KnowledgeWorkspace
        {...createProps({
          libraries: [],
          loading: true,
          selectedLibraryId: undefined
        })}
      />
    )

    expect(screen.getByText('正在加载知识库')).toBeInTheDocument()
    expect(
      screen.queryByText('建立第一个知识库')
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '新建知识库' })
    ).toBeDisabled()
  })

  it('confirms that deleting a managed library removes managed copies', async () => {
    const onDeleteLibrary = vi.fn()
    render(
      <KnowledgeWorkspace
        {...createProps({ onDeleteLibrary })}
      />
    )

    fireEvent.click(
      screen.getByRole('button', { name: '删除知识库 产品知识' })
    )
    expect(
      screen.getByText(
        '此知识库使用托管存储。删除后，应用保存的托管副本、索引和图谱都会被永久删除。'
      )
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))

    await waitFor(() =>
      expect(onDeleteLibrary).toHaveBeenCalledWith('library-1')
    )
  })

  it('explains that reference library deletion preserves original files', () => {
    render(
      <KnowledgeWorkspace
        {...createProps({
          libraries: [
            {
              ...library,
              storageMode: 'reference'
            }
          ]
        })}
      />
    )

    fireEvent.click(
      screen.getByRole('button', { name: '删除知识库 产品知识' })
    )
    expect(
      screen.getByText(
        '此知识库引用原文件。删除后只会移除索引和图谱，不会删除磁盘上的原文件。'
      )
    ).toBeInTheDocument()
  })
})
