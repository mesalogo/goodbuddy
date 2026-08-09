import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  KnowledgeWorkspace,
  type KnowledgeWorkspaceProps
} from './KnowledgeWorkspace'

const echartsMock = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown) => void>()
  const chart = {
    convertFromPixel: vi.fn(() => [240, 320]),
    dispose: vi.fn(),
    dispatchAction: vi.fn(),
    getOption: vi.fn(() => ({
      series: [{ center: ['50%', '50%'], zoom: 1 }]
    })),
    off: vi.fn((eventName: string) => handlers.delete(eventName)),
    on: vi.fn((eventName: string, handler: (event: unknown) => void) => {
      handlers.set(eventName, handler)
    }),
    resize: vi.fn(),
    setOption: vi.fn()
  }
  return {
    chart,
    handlers,
    init: vi.fn(() => chart),
    use: vi.fn()
  }
})

vi.mock('echarts/core', () => ({
  init: echartsMock.init,
  use: echartsMock.use
}))
vi.mock('echarts/charts', () => ({ GraphChart: {} }))
vi.mock('echarts/components', () => ({ TooltipComponent: {} }))
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }))

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
    onRetryLoad: vi.fn(),
    ...overrides
  }
}

describe('KnowledgeWorkspace', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    echartsMock.handlers.clear()
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

    fireEvent.change(screen.getByLabelText('选择图谱实体'), {
      target: { value: 'entity-1' }
    })
    expect(screen.getByLabelText('实体详情')).toBeInTheDocument()
    expect(screen.getByText('跨平台 AI 桌面助手')).toBeInTheDocument()
    expect(screen.getByText('架构说明.md')).toBeInTheDocument()
  })

  it('renders and filters graph nodes with their relationships', async () => {
    render(<KnowledgeWorkspace {...createProps()} />)

    fireEvent.click(screen.getByRole('tab', { name: '知识图谱' }))
    expect(
      screen.getByRole('option', { name: 'GoodBuddy · 产品' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('option', { name: 'Electron · 技术' })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByText('可见关系 1 条'))
    expect(await screen.findByText('使用')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('搜索图谱实体'), {
      target: { value: 'Electron' }
    })
    expect(
      screen.queryByRole('option', { name: 'GoodBuddy · 产品' })
    ).not.toBeInTheDocument()
    expect(screen.queryByText('使用')).not.toBeInTheDocument()
    expect(echartsMock.chart.setOption).toHaveBeenLastCalledWith(
      expect.objectContaining({
        series: [
          expect.objectContaining({
            data: [
              expect.objectContaining({
                id: 'entity-2'
              })
            ],
            links: []
          })
        ]
      }),
      { notMerge: true }
    )

    fireEvent.change(screen.getByLabelText('搜索图谱实体'), {
      target: { value: '' }
    })
    fireEvent.change(screen.getByLabelText('筛选实体类型'), {
      target: { value: '产品' }
    })
    expect(
      screen.getByRole('option', { name: 'GoodBuddy · 产品' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('option', { name: 'Electron · 技术' })
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
    expect(workspace.querySelector('aside')).not.toHaveAttribute('style')
    const detailRegion = within(workspace).getByRole('region', {
      name: '知识库详情'
    })
    expect(detailRegion).toHaveClass('knowledge-workspace__main')
    expect(detailRegion).toHaveStyle({
      background: 'var(--surface-raised)'
    })
    expect(screen.getByText('全局')).toHaveClass('scope-badge')
    const mobileBack = screen.getByRole('button', {
      name: '返回知识库列表'
    })
    expect(mobileBack).toHaveClass('knowledge-workspace__mobile-back')
    fireEvent.click(mobileBack)
    expect(workspace).toHaveClass('knowledge-workspace--mobile-list')
    fireEvent.click(
      screen.getByRole('button', {
        name: /^产品知识 1 个文档/u
      })
    )
    expect(workspace).not.toHaveClass('knowledge-workspace--mobile-list')
    expect(screen.getByRole('tablist', { name: '知识库视图' })).toHaveClass(
      'page-tabs'
    )
    expect(screen.getByLabelText('搜索文档').closest('label')).toHaveClass(
      'knowledge-documents__search'
    )
    expect(screen.getByLabelText('搜索文档')).not.toHaveStyle({
      outline: 'none'
    })
    expect(screen.getByText('本地文件 · 架构说明.md')).toBeInTheDocument()
    expect(screen.queryByText('D:\\Private\\架构说明.md')).not
      .toBeInTheDocument()
    expect(screen.queryByTitle('D:\\Private\\架构说明.md')).not
      .toBeInTheDocument()
    expect(screen.queryByTitle('D:\\Private\\产品手册')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '知识图谱' }))
    fireEvent.change(screen.getByLabelText('选择图谱实体'), {
      target: { value: 'entity-1' }
    })
    expect(screen.getByLabelText('知识图谱画布').parentElement).toHaveClass(
      'knowledge-graph--with-details'
    )
    expect(screen.getByLabelText('实体详情')).toHaveClass(
      'knowledge-graph__detail'
    )
  })

  it('manages the graph chart, zoom, selection, movement, and cleanup', () => {
    const onMoveNode = vi.fn()
    const { unmount } = render(
      <KnowledgeWorkspace {...createProps({ onMoveNode })} />
    )

    fireEvent.click(screen.getByRole('tab', { name: '知识图谱' }))
    const graph = screen.getByLabelText('实体关系图')
    expect(graph).toHaveClass('knowledge-graph__chart')
    expect(echartsMock.init).toHaveBeenCalledWith(
      graph,
      undefined,
      { renderer: 'canvas' }
    )
    expect(echartsMock.chart.setOption).toHaveBeenLastCalledWith(
      expect.objectContaining({
        series: [
          expect.objectContaining({
            layout: 'force',
            symbol: 'circle',
            type: 'graph',
            data: expect.arrayContaining([
              expect.objectContaining({
                id: 'entity-1',
                name: 'GoodBuddy'
              })
            ]),
            links: [
              expect.objectContaining({
                id: 'relation-1',
                value: '使用'
              })
            ]
          })
        ]
      }),
      { notMerge: true }
    )

    fireEvent.click(screen.getByRole('button', { name: '放大图谱' }))
    expect(screen.getByText('115%')).toBeInTheDocument()
    expect(echartsMock.chart.setOption).toHaveBeenLastCalledWith(
      expect.objectContaining({
        series: [
          expect.objectContaining({
            zoom: 1.15
          })
        ]
      })
    )

    act(() => {
      echartsMock.handlers.get('click')?.({
        dataType: 'node',
        data: { id: 'entity-1' }
      })
    })
    expect(screen.getByLabelText('实体详情')).toBeInTheDocument()
    expect(echartsMock.chart.dispatchAction).toHaveBeenCalledWith({
      type: 'select',
      seriesIndex: 0,
      dataIndex: 0
    })
    expect(onMoveNode).not.toHaveBeenCalled()

    act(() => {
      echartsMock.chart.convertFromPixel
        .mockReturnValueOnce([100, 100])
        .mockReturnValueOnce([220, 260])
        .mockReturnValueOnce([120, 160])
      echartsMock.handlers.get('mousedown')?.({
        dataType: 'node',
        data: { id: 'entity-1' },
        event: {
          offsetX: 100,
          offsetY: 100,
          target: {
            transformCoordToGlobal: () => [220, 260]
          }
        }
      })
      echartsMock.handlers.get('mouseup')?.({
        dataType: 'node',
        data: { id: 'entity-1' },
        event: { offsetX: 120, offsetY: 160 }
      })
    })
    expect(onMoveNode).toHaveBeenCalledWith('entity-1', {
      x: 240,
      y: 320
    })

    fireEvent.click(screen.getByRole('button', { name: '查看 Electron' }))
    expect(
      screen.getByRole('heading', { name: 'Electron' })
    ).toBeInTheDocument()

    unmount()
    expect(echartsMock.chart.off).toHaveBeenCalledWith(
      'click',
      expect.any(Function)
    )
    expect(echartsMock.chart.off).toHaveBeenCalledWith(
      'mousedown',
      expect.any(Function)
    )
    expect(echartsMock.chart.off).toHaveBeenCalledWith(
      'mouseup',
      expect.any(Function)
    )
    expect(echartsMock.chart.off).toHaveBeenCalledWith(
      'graphRoam',
      expect.any(Function)
    )
    expect(echartsMock.chart.dispose).toHaveBeenCalled()
  })

  it('preserves the graph viewport and refreshes theme colors', async () => {
    render(<KnowledgeWorkspace {...createProps()} />)
    fireEvent.click(screen.getByRole('tab', { name: '知识图谱' }))

    echartsMock.chart.getOption.mockReturnValueOnce({
      series: [{ center: ['46%', '54%'], zoom: 1.3 }]
    })
    act(() => {
      echartsMock.handlers.get('graphRoam')?.({})
    })

    await waitFor(() =>
      expect(screen.getByText('130%')).toBeInTheDocument()
    )
    fireEvent.change(screen.getByLabelText('搜索图谱实体'), {
      target: { value: 'Electron' }
    })
    expect(echartsMock.chart.setOption).toHaveBeenLastCalledWith(
      expect.objectContaining({
        series: [
          expect.objectContaining({
            center: ['46%', '54%'],
            zoom: 1.3
          })
        ]
      }),
      { notMerge: true }
    )

    const optionCalls = echartsMock.chart.setOption.mock.calls.length
    act(() => {
      document.documentElement.dataset.theme = 'dark'
    })
    await waitFor(() =>
      expect(echartsMock.chart.setOption.mock.calls.length).toBeGreaterThan(
        optionCalls
      )
    )
    delete document.documentElement.dataset.theme
  })

  it('reduces labels and node size for dense graphs', () => {
    const graphNodes = Array.from({ length: 30 }, (_, index) => ({
      id: `entity-${index}`,
      label: `实体 ${index}`,
      type: '概念',
      x: index * 10,
      y: index * 5
    }))
    render(
      <KnowledgeWorkspace
        {...createProps({ graphNodes, graphRelations: [] })}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: '知识图谱' }))

    expect(echartsMock.chart.setOption).toHaveBeenLastCalledWith(
      expect.objectContaining({
        series: [
          expect.objectContaining({
            data: expect.arrayContaining([
              expect.objectContaining({
                id: 'entity-0',
                symbolSize: 24,
                label: expect.objectContaining({ show: false })
              })
            ]),
            edgeLabel: expect.objectContaining({ show: false }),
            force: expect.objectContaining({
              repulsion: 220
            })
          })
        ]
      }),
      { notMerge: true }
    )
    const option = echartsMock.chart.setOption.mock.calls.at(-1)?.[0] as {
      series?: Array<{ data?: Array<Record<string, unknown>> }>
    }
    expect(option.series?.[0]?.data?.[0]).not.toHaveProperty('x')
    expect(option.series?.[0]?.data?.[0]).not.toHaveProperty('y')
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
    fireEvent.change(screen.getByLabelText('选择图谱实体'), {
      target: { value: 'entity-1' }
    })
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

  it('shows a retryable load error instead of the first-library empty state', () => {
    const onRetryLoad = vi.fn()
    render(
      <KnowledgeWorkspace
        {...createProps({
          libraries: [],
          loadError: '数据库暂时不可用',
          onRetryLoad,
          selectedLibraryId: undefined
        })}
      />
    )

    expect(screen.getByText('知识库加载失败')).toBeInTheDocument()
    expect(screen.getByText('数据库暂时不可用')).toBeInTheDocument()
    expect(
      screen.queryByText('建立第一个知识库')
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetryLoad).toHaveBeenCalledOnce()
  })

  it('keeps existing data and selection visible when refresh fails', () => {
    render(
      <KnowledgeWorkspace
        {...createProps({ loadError: '刷新连接失败' })}
      />
    )

    expect(screen.getByText('知识库刷新失败')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: library.name }))
      .toBeInTheDocument()
    expect(screen.getByText('架构说明.md')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /^产品知识 1 个文档/u })
    ).toHaveAttribute('aria-current', 'page')
  })

  it('confirms that deleting a managed library removes managed copies', async () => {
    const onDeleteLibrary = vi.fn()
    render(
      <KnowledgeWorkspace
        {...createProps({ onDeleteLibrary })}
      />
    )

    const trigger = screen.getByRole('button', {
      name: '删除知识库 产品知识'
    })
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', {
      name: '删除知识库确认'
    })
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(trigger).toHaveFocus())
    fireEvent.click(trigger)
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
