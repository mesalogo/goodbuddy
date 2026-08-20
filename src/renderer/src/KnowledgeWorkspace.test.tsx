import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  KnowledgeGraphChartLoader,
  KnowledgeWorkspace,
  type KnowledgeWorkspaceProps
} from './KnowledgeWorkspace'
import i18n from './i18n'
import {
  defaultKnowledgeOntologySettings
} from '../../shared/knowledge-ontology'

const knowledgeWorkspaceSource = readFileSync(
  join(
    process.cwd(),
    'src',
    'renderer',
    'src',
    'KnowledgeWorkspace.tsx'
  ),
  'utf8'
)

const g6Mock = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown) => void>()
  const graph = {
    destroy: vi.fn(),
    draw: vi.fn(async () => undefined),
    fitView: vi.fn(async () => undefined),
    getElementPosition: vi.fn(() => [240, 320]),
    getZoom: vi.fn(() => 1),
    off: vi.fn((eventName: string) => handlers.delete(eventName)),
    on: vi.fn((eventName: string, handler: (event: unknown) => void) => {
      handlers.set(eventName, handler)
    }),
    render: vi.fn(async () => undefined),
    resize: vi.fn(),
    setData: vi.fn(),
    setEdge: vi.fn(),
    setElementState: vi.fn(async () => undefined),
    setLayout: vi.fn(),
    setNode: vi.fn(),
    setOptions: vi.fn(),
    zoomTo: vi.fn(async () => undefined)
  }
  return {
    graph,
    handlers,
    Graph: vi.fn(function () {
      return graph
    })
  }
})

vi.mock('@antv/g6', () => ({
  Graph: g6Mock.Graph,
  GraphEvent: {
    AFTER_TRANSFORM: 'aftertransform'
  },
  NodeEvent: {
    CLICK: 'node:click',
    DRAG_END: 'node:dragend'
  }
}))

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
  ontologySettings: defaultKnowledgeOntologySettings,
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
    onReextractGraph: vi.fn(),
    onImportFiles: vi.fn(),
    onImportDirectory: vi.fn(),
    onImportUrl: vi.fn(),
    onSyncSource: vi.fn(),
    onPauseSource: vi.fn(),
    onRetrySource: vi.fn(),
    onRemoveSource: vi.fn(),
    onRetrieve: vi.fn(async () => ({
      query: 'test',
      durationMs: 0,
      settings: {
        version: 1 as const,
        topK: 6,
        minimumVectorSimilarity: 0,
        ftsWeight: 1,
        vectorWeight: 1,
        graphWeight: 0.8,
        candidateMultiplier: 4,
        contextMaxCharacters: 16_000,
        adjacentChunkCount: 0,
        localRerankEnabled: false,
        rerankMode: 'none' as const
      },
      diagnostics: {
        requestedChannels: [],
        usedChannels: [],
        degradedChannels: [],
        candidateCounts: {},
        channelDurationMs: {},
        vectorScannedCount: 0,
        filteredByThresholdCount: 0,
        filteredByBudgetCount: 0,
        rerank: {
          requested: 'none' as const,
          used: 'none' as const,
          status: 'skipped' as const,
          candidateCount: 0,
          durationMs: 0
        }
      },
      results: [],
      context: {
        characterCount: 0,
        truncated: false,
        groups: []
      }
    })),
    onUpdateKnowledgeSettings: vi.fn(),
    onListChunks: vi.fn(async () => ({
      items: [],
      page: 1,
      pageSize: 50,
      totalItems: 0
    })),
    onUpdateChunk: vi.fn(),
    onDeleteChunk: vi.fn(),
    onRebuildDocument: vi.fn(),
    onRebuildLibrary: vi.fn(),
    onCancelRebuild: vi.fn(),
    onGetEmbeddingIndex: vi.fn(async () => ({
      knowledgeBaseId: library.id,
      enabled: true,
      configuration: {
        provider: 'openai-compatible',
        model: 'nomic-embed-text',
        endpoint: 'http://127.0.0.1:11434/v1/embeddings',
        credentialConfigured: false
      },
      coverage: { total: 1, indexed: 1, missing: 0, error: 0 },
      indexStatus: { job: null }
    })),
    onRebuildEmbeddingIndex: vi.fn(async () => ({
      knowledgeBaseId: library.id,
      enabled: true,
      configuration: {
        provider: 'openai-compatible',
        model: 'nomic-embed-text',
        endpoint: 'http://127.0.0.1:11434/v1/embeddings',
        credentialConfigured: false
      },
      coverage: { total: 1, indexed: 1, missing: 0, error: 0 },
      indexStatus: { job: null }
    })),
    onCancelTask: vi.fn(),
    onRetryTask: vi.fn(),
    onOpenReferenceSource: vi.fn(),
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
    g6Mock.handlers.clear()
    g6Mock.graph.getZoom.mockReturnValue(1)
    g6Mock.graph.getElementPosition.mockReturnValue([240, 320])
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
    expect(
      screen.getByRole('switch', { name: /启用知识图谱/u })
    ).not.toBeChecked()
    expect(
      screen.queryByLabelText('图谱生成策略')
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '创建知识库' }))

    await waitFor(() =>
      expect(onCreateLibrary).toHaveBeenCalledWith({
        name: '客户研究',
        description: '访谈与反馈',
        storageMode: 'reference',
        graphEnabled: false,
        graphStrategy: 'rules'
      })
    )
  })

  it('renders English interface copy without translating knowledge content', async () => {
    await i18n.changeLanguage('en-US')
    render(<KnowledgeWorkspace {...createProps()} />)

    expect(
      screen.getByRole('heading', { name: 'Knowledge Base' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('tab', { name: 'Documents and sources' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '产品知识' })
    ).toBeInTheDocument()
    expect(screen.getByText('架构说明.md')).toBeInTheDocument()
    expect(screen.getByText('Local file · 架构说明.md')).toBeInTheDocument()
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

  it('opens the retrieval workbench and runs an isolated test query', async () => {
    const props = createProps()
    const onRetrieve = vi.fn(props.onRetrieve)
    render(
      <KnowledgeWorkspace
        {...props}
        onRetrieve={onRetrieve}
      />
    )

    fireEvent.click(
      screen.getByRole('button', { name: '检索测试' })
    )
    const dialog = screen.getByRole('dialog', { name: '检索测试' })
    fireEvent.change(within(dialog).getByLabelText('检索问题'), {
      target: { value: '如何配置离线部署？' }
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: '测试检索' })
    )

    await waitFor(() =>
      expect(onRetrieve).toHaveBeenCalledWith(
        'library-1',
        '如何配置离线部署？',
        expect.objectContaining({ topK: 6 })
      )
    )
  })

  it('opens document chunk management from a ready document row', async () => {
    const onListChunks = vi.fn(async () => ({
      items: [],
      page: 1,
      pageSize: 50,
      totalItems: 0
    }))
    render(
      <KnowledgeWorkspace
        {...createProps({ onListChunks })}
      />
    )
    fireEvent.click(
      screen.getByRole('button', { name: '文档分块' })
    )
    expect(
      screen.getByRole('dialog', { name: '文档分块' })
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(onListChunks).toHaveBeenCalledWith({
        libraryId: 'library-1',
        documentId: 'document-1',
        page: 1,
        pageSize: 50,
        search: undefined
      })
    )
  })

  it('ignores stale chunk responses after opening another document', async () => {
    let resolveFirst:
      | ((value: Awaited<
          ReturnType<KnowledgeWorkspaceProps['onListChunks']>
        >) => void)
      | undefined
    const secondDocument = {
      ...createProps().documents[0]!,
      id: 'document-2',
      name: '第二份文档.md'
    }
    const onListChunks = vi.fn(
      (input: Parameters<KnowledgeWorkspaceProps['onListChunks']>[0]) => {
        if (input.documentId === 'document-1') {
          return new Promise<
            Awaited<ReturnType<KnowledgeWorkspaceProps['onListChunks']>>
          >((resolve) => {
            resolveFirst = resolve
          })
        }
        return Promise.resolve({
          items: [
            {
              id: 'second-chunk',
              ordinal: 0,
              content: '第二份文档内容',
              characterCount: 7,
              enabled: true,
              role: 'standalone' as const,
              manuallyEdited: false
            }
          ],
          page: 1,
          pageSize: 50,
          totalItems: 1
        })
      }
    )
    render(
      <KnowledgeWorkspace
        {...createProps({
          documents: [createProps().documents[0]!, secondDocument],
          onListChunks
        })}
      />
    )

    const chunkButtons = screen.getAllByRole('button', { name: '文档分块' })
    fireEvent.click(chunkButtons[0]!)
    fireEvent.click(screen.getByRole('button', { name: '关闭文档分块' }))
    fireEvent.click(chunkButtons[1]!)
    expect(await screen.findByText('第二份文档内容')).toBeInTheDocument()

    await act(async () => {
      resolveFirst?.({
        items: [
          {
            id: 'stale-chunk',
            ordinal: 0,
            content: '过期文档内容',
            characterCount: 6,
            enabled: true,
            role: 'standalone',
            manuallyEdited: false
          }
        ],
        page: 1,
        pageSize: 50,
        totalItems: 1
      })
    })
    expect(screen.queryByText('过期文档内容')).not.toBeInTheDocument()
    expect(screen.getByText('第二份文档内容')).toBeInTheDocument()
  })

  it('switches to the graph and opens entity details', async () => {
    render(<KnowledgeWorkspace {...createProps()} />)

    fireEvent.click(screen.getByRole('tab', { name: '知识图谱' }))
    expect(
      await screen.findByLabelText('实体关系图')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('tab', { name: /拓扑/u })
    ).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('图谱拓扑')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('选择图谱实体'), {
      target: { value: 'entity-1' }
    })
    expect(
      screen.getByRole('tab', { name: '详情' })
    ).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('实体详情')).toBeInTheDocument()
    expect(screen.getByText('跨平台 AI 桌面助手')).toBeInTheDocument()
    expect(screen.getByText('架构说明.md')).toBeInTheDocument()
  })

  it('uses controlled localized ontology types and endpoint constraints', async () => {
    const onCreateEntity = vi.fn()
    const onCreateRelation = vi.fn()
    const ontologySettings = {
      version: 1 as const,
      entityTypes: [
        {
          id: 'CONCEPT',
          name: { zh: '概念', en: 'Concept' },
          aliases: ['概念', '产品', '技术']
        },
        {
          id: 'PERSON',
          name: { zh: '人物', en: 'Person' },
          aliases: ['人物']
        }
      ],
      relationTypes: [
        {
          id: 'RELATED_TO',
          name: { zh: '相关', en: 'Related to' },
          aliases: ['相关'],
          sourceTypes: ['CONCEPT'],
          targetTypes: ['CONCEPT']
        },
        {
          id: 'KNOWS',
          name: { zh: '认识', en: 'Knows' },
          aliases: ['认识'],
          sourceTypes: ['PERSON'],
          targetTypes: ['PERSON']
        }
      ]
    }
    render(
      <KnowledgeWorkspace
        {...createProps({
          libraries: [{ ...library, ontologySettings }],
          onCreateEntity,
          onCreateRelation
        })}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '知识图谱' }))
    fireEvent.click(screen.getByRole('button', { name: '新增实体' }))
    const entityForm = screen.getByRole('form', { name: '新增实体' })
    expect(within(entityForm).getByLabelText('类型').tagName).toBe('SELECT')
    expect(
      within(entityForm).getByRole('option', { name: '概念 (CONCEPT)' })
    ).toBeInTheDocument()

    fireEvent.change(within(entityForm).getByLabelText('名称'), {
      target: { value: '新概念' }
    })
    fireEvent.click(within(entityForm).getByRole('button', {
      name: '新增实体'
    }))
    await waitFor(() =>
      expect(onCreateEntity).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'CONCEPT' })
      )
    )

    fireEvent.change(screen.getByLabelText('选择图谱实体'), {
      target: { value: 'entity-1' }
    })
    fireEvent.click(screen.getByRole('button', { name: '新增' }))
    const relationForm = screen.getByRole('form', { name: '新增关系' })
    expect(
      within(relationForm).getByRole('option', {
        name: '相关 (RELATED_TO)'
      })
    ).toBeInTheDocument()
    expect(
      within(relationForm).queryByRole('option', { name: '认识 (KNOWS)' })
    ).not.toBeInTheDocument()
  })

  it('uses capability-aware tabs and keeps index controls separate', async () => {
    const onUpdateLibrary = vi.fn()
    const onRebuildEmbeddingIndex = vi.fn(async () => ({
      knowledgeBaseId: library.id,
      enabled: true,
      configuration: {
        provider: 'openai-compatible',
        model: 'nomic-embed-text',
        credentialConfigured: false
      },
      coverage: { total: 1, indexed: 1, missing: 0, error: 0 },
      indexStatus: { job: null }
    }))
    render(
      <KnowledgeWorkspace
        {...createProps({
          onRebuildEmbeddingIndex,
          onUpdateLibrary
        })}
      />
    )

    const tabs = screen.getByRole('tablist', { name: '知识库视图' })
    expect(within(tabs).getAllByRole('tab').map((item) => item.textContent))
      .toEqual(['文档与来源', '知识图谱', '任务中心', '索引与检索'])
    expect(
      screen.queryByRole('switch', { name: '知识图谱' })
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '索引与检索' }))
    expect(
      await screen.findByRole('heading', { name: '向量索引' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: '本体定义' })
    ).not.toBeInTheDocument()
    expect(screen.queryByLabelText('知识图谱抽取策略'))
      .not.toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: '重建向量索引' })
    )
    expect(onRebuildEmbeddingIndex).toHaveBeenCalledWith(library.id)
    fireEvent.click(screen.getByRole('switch', { name: /启用知识图谱/u }))
    expect(onUpdateLibrary).toHaveBeenCalledWith('library-1', {
      graphEnabled: false
    })
  })

  it('hides graph navigation and graph-only controls until enabled', () => {
    const disabledLibrary = {
      ...library,
      graphEnabled: false
    }
    render(
      <KnowledgeWorkspace
        {...createProps({ libraries: [disabledLibrary] })}
      />
    )

    const tabs = screen.getByRole('tablist', { name: '知识库视图' })
    expect(within(tabs).getAllByRole('tab').map((item) => item.textContent))
      .toEqual(['文档与来源', '任务中心', '索引与检索'])
    expect(screen.queryByText('本次导入的图谱抽取策略'))
      .not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '索引与检索' }))
    expect(screen.getByRole('switch', { name: /启用知识图谱/u }))
      .not.toBeChecked()
    expect(screen.queryByLabelText('知识图谱抽取策略'))
      .not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '本体定义' }))
      .not.toBeInTheDocument()
  })

  it('moves graph configuration into the enabled graph workspace', () => {
    render(<KnowledgeWorkspace {...createProps()} />)

    fireEvent.click(screen.getByRole('tab', { name: '知识图谱' }))
    const graphTabs = screen.getByRole('tablist', {
      name: '知识图谱工作区'
    })
    expect(within(graphTabs).getAllByRole('tab').map((item) => item.textContent))
      .toEqual(['图谱探索', '图谱设置'])
    fireEvent.click(within(graphTabs).getByRole('tab', { name: '图谱设置' }))

    expect(screen.getByLabelText('知识图谱抽取策略')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '本体定义' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: '向量索引' })
    ).not.toBeInTheDocument()
  })

  it('ignores stale vector status after switching libraries', async () => {
    let resolveFirst:
      | ((value: Awaited<
          ReturnType<KnowledgeWorkspaceProps['onGetEmbeddingIndex']>
        >) => void)
      | undefined
    const secondLibrary = {
      ...library,
      id: 'library-2',
      name: '客户知识'
    }
    const onGetEmbeddingIndex = vi.fn((libraryId: string) => {
      if (libraryId === library.id) {
        return new Promise<
          Awaited<
            ReturnType<KnowledgeWorkspaceProps['onGetEmbeddingIndex']>
          >
        >((resolve) => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve({
        knowledgeBaseId: secondLibrary.id,
        enabled: true,
        configuration: {
          provider: 'openai-compatible',
          model: 'second-model',
          credentialConfigured: false
        },
        coverage: { total: 2, indexed: 2, missing: 0, error: 0 },
        indexStatus: { job: null }
      })
    })
    const props = createProps({
      libraries: [library, secondLibrary],
      onGetEmbeddingIndex
    })
    const { rerender } = render(<KnowledgeWorkspace {...props} />)

    fireEvent.click(screen.getByRole('tab', { name: '索引与检索' }))
    rerender(
      <KnowledgeWorkspace
        {...props}
        selectedLibraryId={secondLibrary.id}
      />
    )
    expect(await screen.findByText('second-model')).toBeInTheDocument()

    await act(async () => {
      resolveFirst?.({
        knowledgeBaseId: library.id,
        enabled: true,
        configuration: {
          provider: 'openai-compatible',
          model: 'stale-first-model',
          credentialConfigured: false
        },
        coverage: { total: 1, indexed: 1, missing: 0, error: 0 },
        indexStatus: { job: null }
      })
    })
    expect(screen.queryByText('stale-first-model')).not.toBeInTheDocument()
    expect(screen.getByText('second-model')).toBeInTheDocument()
  })

  it('saves parent-child chunking settings without rebuilding implicitly', async () => {
    const onUpdateKnowledgeSettings = vi.fn()
    const onRebuildLibrary = vi.fn()
    render(
      <KnowledgeWorkspace
        {...createProps({
          onRebuildLibrary,
          onUpdateKnowledgeSettings
        })}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '索引与检索' }))
    fireEvent.change(screen.getByLabelText('分块方式'), {
      target: { value: 'parent-child' }
    })
    fireEvent.click(
      screen.getByRole('button', { name: '保存分块设置' })
    )

    await waitFor(() =>
      expect(onUpdateKnowledgeSettings).toHaveBeenCalledWith(
        'library-1',
        {
          chunking: expect.objectContaining({
            mode: 'parent-child',
            parentCharacters: 4_800,
            childCharacters: 900
          })
        }
      )
    )
    expect(onRebuildLibrary).not.toHaveBeenCalled()
  })

  it('saves library ontology definitions without rebuilding implicitly', async () => {
    const onUpdateKnowledgeSettings = vi.fn()
    const onRebuildLibrary = vi.fn()
    render(
      <KnowledgeWorkspace
        {...createProps({
          onRebuildLibrary,
          onUpdateKnowledgeSettings
        })}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '知识图谱' }))
    fireEvent.click(
      screen.getByRole('tab', { name: '图谱设置' })
    )
    const ontologySection = screen
      .getByRole('heading', { name: '本体定义' })
      .closest('section')!
    const chineseNameInputs = within(ontologySection).getAllByLabelText(
      '中文名称'
    )
    fireEvent.change(chineseNameInputs[0]!, {
      target: { value: '人员' }
    })
    fireEvent.click(
      within(ontologySection).getByRole('button', {
        name: '保存本体定义'
      })
    )

    await waitFor(() =>
      expect(onUpdateKnowledgeSettings).toHaveBeenCalledWith(
        'library-1',
        {
          ontology: expect.objectContaining({
            entityTypes: expect.arrayContaining([
              expect.objectContaining({
                id: 'PERSON',
                name: expect.objectContaining({ zh: '人员' })
              })
            ])
          })
        }
      )
    )
    expect(onRebuildLibrary).not.toHaveBeenCalled()
  })

  it('shows parsing, embedding, and graph progress in the task center', () => {
    render(
      <KnowledgeWorkspace
        {...createProps({
          tasks: [
            {
              id: 'task-1',
              libraryId: 'library-1',
              documentId: 'document-1',
              documentName: '架构说明.md',
              scope: 'document',
              kind: 'graph',
              stage: 'graph',
              status: 'running',
              progress: 40,
              message: '正在重新抽取知识图谱',
              attempt: 1,
              canCancel: true,
              canRetry: false,
              createdAt: '2026-08-10T08:00:00.000Z',
              startedAt: '2026-08-10T08:00:01.000Z',
              updatedAt: '2026-08-10T08:00:02.000Z'
            }
          ]
        })}
      />
    )

    fireEvent.click(
      screen.getByRole('tab', { name: /^任务中心/u })
    )
    expect(screen.getByText('图谱抽取')).toBeInTheDocument()
    expect(screen.getByText('正在重新抽取知识图谱')).toBeInTheDocument()
    expect(
      screen.getByRole('progressbar', {
        name: '架构说明.md 图谱抽取进度'
      })
    ).toHaveValue(40)
  })

  it('filters tasks and discloses parent stages with errors and actions', () => {
    const onCancelTask = vi.fn()
    const onRetryTask = vi.fn()
    render(
      <KnowledgeWorkspace
        {...createProps({
          onCancelTask,
          onRetryTask,
          tasks: [
            {
              id: 'parent-task',
              libraryId: 'library-1',
              documentName: '整库重建',
              scope: 'library',
              kind: 'library-rebuild',
              stage: 'indexing',
              status: 'running',
              progress: 50,
              completedItems: 1,
              totalItems: 2,
              attempt: 1,
              canCancel: true,
              canRetry: false,
              createdAt: '2026-08-10T08:00:00.000Z',
              startedAt: '2026-08-10T08:00:01.000Z',
              updatedAt: '2026-08-10T08:00:02.000Z'
            },
            {
              id: 'child-task',
              parentTaskId: 'parent-task',
              libraryId: 'library-1',
              documentId: 'document-1',
              documentName: '架构说明.md',
              scope: 'document',
              kind: 'embedding',
              stage: 'embedding',
              status: 'failed',
              progress: 30,
              error: {
                message: '向量服务不可用',
                remedy: '检查向量模型连接后重试'
              },
              attempt: 1,
              canCancel: false,
              canRetry: true,
              createdAt: '2026-08-10T08:00:01.000Z',
              completedAt: '2026-08-10T08:00:03.000Z',
              updatedAt: '2026-08-10T08:00:03.000Z'
            },
            {
              id: 'history-task',
              libraryId: 'library-1',
              documentName: '旧文档.md',
              scope: 'document',
              kind: 'document-process',
              stage: 'finalizing',
              status: 'cancelled',
              progress: 70,
              attempt: 1,
              canCancel: false,
              canRetry: false,
              createdAt: '2026-08-09T08:00:00.000Z',
              completedAt: '2026-08-09T08:00:03.000Z',
              updatedAt: '2026-08-09T08:00:03.000Z'
            }
          ]
        })}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '任务中心' }))
    const disclosure = screen.getByRole('button', {
      name: '展开 整库重建 的阶段任务'
    })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('向量服务不可用')).not.toBeInTheDocument()
    fireEvent.click(disclosure)
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('生成向量')).toBeInTheDocument()
    expect(screen.getByText('向量服务不可用')).toBeInTheDocument()
    expect(screen.getByText('检查向量模型连接后重试')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '取消任务' }))
    expect(onCancelTask).toHaveBeenCalledWith('parent-task')
    fireEvent.click(screen.getByRole('button', { name: '重试任务' }))
    expect(onRetryTask).toHaveBeenCalledWith('child-task')

    fireEvent.click(screen.getByRole('button', { name: '失败' }))
    expect(screen.getByText('整库重建')).toBeInTheDocument()
    expect(screen.queryByText('旧文档.md')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '历史' }))
    expect(screen.getByText('旧文档.md')).toBeInTheDocument()
    expect(screen.getByText('已取消')).toBeInTheDocument()
    expect(screen.queryByText('整库重建')).not.toBeInTheDocument()
  })

  it('keeps task context and disables repeated actions while cancellation is pending', async () => {
    let resolveCancel: (() => void) | undefined
    const onCancelTask = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCancel = resolve
        })
    )
    render(
      <KnowledgeWorkspace
        {...createProps({
          onCancelTask,
          tasks: [
            {
              id: 'pending-parent',
              libraryId: 'library-1',
              sourceId: 'source-1',
              documentName: '来源同步',
              scope: 'source',
              kind: 'source-sync',
              stage: 'syncing',
              status: 'running',
              progress: 45,
              attempt: 1,
              canCancel: true,
              canRetry: false,
              createdAt: '2026-08-10T08:00:00.000Z',
              startedAt: '2026-08-10T08:00:01.000Z',
              updatedAt: '2026-08-10T08:00:02.000Z'
            },
            {
              id: 'pending-child',
              parentTaskId: 'pending-parent',
              libraryId: 'library-1',
              sourceId: 'source-1',
              documentName: '架构说明.md',
              scope: 'document',
              kind: 'parsing',
              stage: 'parsing',
              status: 'running',
              progress: 20,
              attempt: 1,
              canCancel: false,
              canRetry: false,
              createdAt: '2026-08-10T08:00:01.000Z',
              startedAt: '2026-08-10T08:00:01.000Z',
              updatedAt: '2026-08-10T08:00:02.000Z'
            }
          ]
        })}
      />
    )

    fireEvent.click(
      screen.getAllByRole('button', { name: '查看任务' })[0]!
    )
    fireEvent.click(screen.getByRole('button', { name: '进行中' }))
    const disclosure = screen.getByRole('button', {
      name: '收起 来源同步 的阶段任务'
    })
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    expect(
      screen.getByText('正在显示当前来源或文档的相关任务')
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '取消任务' }))
    expect(onCancelTask).toHaveBeenCalledOnce()
    const pendingButton = screen.getByRole('button', {
      name: '正在取消…'
    })
    expect(pendingButton).toBeDisabled()
    fireEvent.click(pendingButton)
    expect(onCancelTask).toHaveBeenCalledOnce()
    expect(
      screen.getByRole('button', { name: '进行中' })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')

    await act(async () => {
      resolveCancel?.()
    })
    expect(
      screen.getByRole('button', { name: '取消任务' })
    ).toBeEnabled()
  })

  it('shows a recoverable local alert when retrying a task fails', async () => {
    const onRetryTask = vi.fn(async () => {
      throw new Error('服务暂时不可用')
    })
    render(
      <KnowledgeWorkspace
        {...createProps({
          onRetryTask,
          tasks: [
            {
              id: 'retry-task',
              libraryId: 'library-1',
              documentName: '失败文档.md',
              scope: 'document',
              kind: 'document-process',
              stage: 'indexing',
              status: 'failed',
              progress: 55,
              error: {
                message: '索引未完成',
                remedy: '可以重试任务'
              },
              attempt: 1,
              canCancel: false,
              canRetry: true,
              createdAt: '2026-08-10T08:00:00.000Z',
              completedAt: '2026-08-10T08:00:02.000Z',
              updatedAt: '2026-08-10T08:00:02.000Z'
            }
          ]
        })}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '任务中心' }))
    fireEvent.click(screen.getByRole('button', { name: '失败' }))
    const progress = screen.getByRole('progressbar', {
      name: '失败文档.md 文档处理进度'
    })
    expect(progress.closest('[aria-live]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重试任务' }))

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('重试任务失败')).toBeInTheDocument()
    expect(within(alert).getByText('服务暂时不可用')).toBeInTheDocument()
    expect(
      within(alert).getByText(
        '任务和筛选已保留，请检查问题后再次操作。'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '失败' })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('失败文档.md')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试任务' })).toBeEnabled()
  })

  it('keeps legacy orphan tasks as top-level task center entries', () => {
    render(
      <KnowledgeWorkspace
        {...createProps({
          tasks: [
            {
              id: 'orphan-task',
              parentTaskId: 'missing-parent',
              libraryId: 'library-1',
              documentName: '旧版导入任务',
              scope: 'document',
              kind: 'parsing',
              stage: 'parsing',
              status: 'interrupted',
              progress: 20,
              attempt: 1,
              canCancel: false,
              canRetry: true,
              createdAt: '2026-08-08T08:00:00.000Z',
              completedAt: '2026-08-08T08:00:03.000Z',
              updatedAt: '2026-08-08T08:00:03.000Z'
            }
          ]
        })}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '任务中心' }))
    expect(screen.getByText('旧版导入任务')).toBeInTheDocument()
    expect(screen.getByText('文档解析')).toBeInTheDocument()
    expect(screen.getByText('已中断')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /展开旧版导入任务/u })
    ).not.toBeInTheDocument()
  })

  it('deduplicates document progress and merges processing status', () => {
    render(
      <KnowledgeWorkspace
        {...createProps({
          sources: [
            {
              ...createProps().sources[0]!,
              status: 'syncing',
              progress: 35
            }
          ],
          documents: [
            {
              ...createProps().documents[0]!,
              status: 'indexing',
              indexProgress: 60
            }
          ],
          tasks: [
            {
              id: 'document-task',
              libraryId: 'library-1',
              sourceId: 'source-1',
              documentId: 'document-1',
              documentName: '架构说明.md',
              scope: 'document',
              kind: 'document-process',
              stage: 'embedding',
              status: 'running',
              progress: 60,
              attempt: 1,
              canCancel: true,
              canRetry: false,
              createdAt: '2026-08-10T08:00:00.000Z',
              startedAt: '2026-08-10T08:00:01.000Z',
              updatedAt: '2026-08-10T08:00:02.000Z'
            }
          ]
        })}
      />
    )

    expect(
      screen.getByRole('columnheader', { name: '处理状态' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('columnheader', { name: '索引进度' })
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.getByText('同步中 · 35%')).toBeInTheDocument()
    expect(screen.getByText('生成向量 · 60%')).toBeInTheDocument()
    fireEvent.click(
      screen.getAllByRole('button', { name: '查看任务' })[0]!
    )
    expect(
      screen.getByRole('tab', { name: '任务中心' })
    ).toHaveAttribute('aria-selected', 'true')
    expect(
      screen.getByText('正在显示当前来源或文档的相关任务')
    ).toBeInTheDocument()
  })

  it('edits library metadata from the detail header', async () => {
    const onUpdateLibrary = vi.fn()
    render(<KnowledgeWorkspace {...createProps({ onUpdateLibrary })} />)

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('名称'), {
      target: { value: '研发知识' }
    })
    fireEvent.change(screen.getByLabelText('描述'), {
      target: { value: '研发资料与设计说明' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))

    await waitFor(() =>
      expect(onUpdateLibrary).toHaveBeenCalledWith('library-1', {
        name: '研发知识',
        description: '研发资料与设计说明'
      })
    )
  })

  it('reextracts the graph from the graph tab', async () => {
    const onReextractGraph = vi.fn()
    render(<KnowledgeWorkspace {...createProps({ onReextractGraph })} />)

    fireEvent.click(screen.getByRole('tab', { name: '知识图谱' }))
    fireEvent.click(screen.getByRole('button', { name: '重新抽取' }))

    await waitFor(() =>
      expect(onReextractGraph).toHaveBeenCalledWith('library-1')
    )
  })

  it('renders and filters graph nodes with their relationships', async () => {
    render(<KnowledgeWorkspace {...createProps()} />)

    fireEvent.click(screen.getByRole('tab', { name: '知识图谱' }))
    await waitFor(() =>
      expect(g6Mock.graph.setOptions).toHaveBeenCalled()
    )
    expect(
      screen.getByRole('option', { name: 'GoodBuddy · 概念 (CONCEPT)' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('option', { name: 'Electron · 概念 (CONCEPT)' })
    ).toBeInTheDocument()
    expect(screen.getByText('可见关系')).toBeInTheDocument()
    expect(screen.getByText('使用 (USES)')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('搜索图谱实体'), {
      target: { value: 'Electron' }
    })
    expect(
      screen.queryByRole('option', { name: 'GoodBuddy · 概念 (CONCEPT)' })
    ).not.toBeInTheDocument()
    expect(screen.queryByText('使用 (USES)')).not.toBeInTheDocument()
    expect(g6Mock.graph.setOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          nodes: [
            expect.objectContaining({
              id: 'entity-2'
            })
          ],
          edges: []
        }
      })
    )

    fireEvent.change(screen.getByLabelText('搜索图谱实体'), {
      target: { value: '' }
    })
    fireEvent.change(screen.getByLabelText('筛选实体类型'), {
      target: { value: 'CONCEPT' }
    })
    expect(
      screen.getByRole('option', { name: 'GoodBuddy · 概念 (CONCEPT)' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('option', { name: 'Electron · 概念 (CONCEPT)' })
    ).toBeInTheDocument()
  })

  it('provides responsive workspace and graph layout hooks', () => {
    render(<KnowledgeWorkspace {...createProps()} />)

    const workspace = screen.getByLabelText('知识工作区')
    expect(workspace).toHaveClass('knowledge-workspace')
    expect(workspace).not.toHaveAttribute('style')
    expect(workspace.querySelector('aside')).toHaveClass(
      'knowledge-workspace__sidebar'
    )
    expect(workspace.querySelector('aside')).not.toHaveAttribute('style')
    const detailRegion = within(workspace).getByRole('region', {
      name: '知识库详情'
    })
    expect(detailRegion).toHaveClass('knowledge-workspace__main')
    expect(detailRegion).not.toHaveAttribute('style')
    expect(screen.getByText('全局')).toHaveClass('scope-badge')
    const mobileBack = screen.getByRole('button', {
      name: '返回知识库列表'
    })
    expect(mobileBack).toHaveClass('knowledge-workspace__mobile-back')
    fireEvent.click(mobileBack)
    expect(workspace).toHaveClass('knowledge-workspace--mobile-list')
    const selectedLibraryButton = screen.getByRole('button', {
      name: /^产品知识 1 个文档/u
    })
    expect(selectedLibraryButton).toHaveClass(
      'knowledge-workspace__library-button--selected'
    )
    expect(selectedLibraryButton).not.toHaveAttribute('style')
    fireEvent.click(selectedLibraryButton)
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
    const syncSource = screen.getByRole('button', {
      name: '同步 产品手册'
    })
    const removeSource = screen.getByRole('button', {
      name: '移除来源 产品手册'
    })
    expect(syncSource.parentElement).toBe(removeSource.parentElement)
    expect(syncSource.parentElement).toHaveClass(
      'knowledge-source-row__actions'
    )
    expect(removeSource).not.toHaveStyle({ padding: '8px' })

    fireEvent.click(screen.getByRole('tab', { name: '知识图谱' }))
    fireEvent.change(screen.getByLabelText('选择图谱实体'), {
      target: { value: 'entity-1' }
    })
    expect(screen.getByLabelText('知识图谱画布').parentElement).toHaveClass(
      'knowledge-graph'
    )
    expect(screen.getByLabelText('知识图谱画布').parentElement)
      .not.toHaveClass('knowledge-graph--with-details')
    expect(screen.getByLabelText('实体详情')).toHaveClass(
      'knowledge-graph__detail'
    )
  })

  it('keeps Knowledge workspace presentation in semantic classes', () => {
    expect(knowledgeWorkspaceSource).not.toMatch(/\bstyle\s*=/u)
  })

  it('manages the G6 graph, zoom, selection, movement, and cleanup', async () => {
    const onMoveNode = vi.fn()
    const { rerender, unmount } = render(
      <KnowledgeWorkspace {...createProps({ onMoveNode })} />
    )

    fireEvent.click(screen.getByRole('tab', { name: '知识图谱' }))
    const graph = await screen.findByLabelText('实体关系图')
    expect(graph).toHaveClass('knowledge-graph__chart')
    expect(g6Mock.Graph).toHaveBeenCalledWith(
      expect.objectContaining({
        container: graph,
        zoomRange: [0.5, 2]
      })
    )
    expect(g6Mock.graph.setOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: 'entity-1',
              data: expect.objectContaining({
                entityType: '产品',
                label: 'GoodBuddy'
              })
            })
          ]),
          edges: [
            expect.objectContaining({
              id: 'relation-1',
              data: expect.objectContaining({
                label: '使用'
              })
            })
          ]
        },
        layout: expect.objectContaining({
          animate: false,
          centerStrength: 0.8,
          linkDistance: 64,
          nodeStrength: -70,
          preventOverlap: true,
          radialRadius: 0,
          radialStrength: 0.04,
          type: 'd3-force'
        }),
        behaviors: expect.arrayContaining([
          'drag-canvas',
          'zoom-canvas',
          expect.objectContaining({
            type: 'drag-element-force',
            fixed: true
          }),
          expect.objectContaining({ type: 'auto-adapt-label' })
        ])
      })
    )
    const graphOptions = g6Mock.graph.setOptions.mock.lastCall?.[0]
    expect(graphOptions?.behaviors).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'hover-activate' })
      ])
    )
    expect(graphOptions?.node.state).not.toHaveProperty('inactive')
    expect(graphOptions?.edge.state).not.toHaveProperty('inactive')
    await waitFor(() => expect(g6Mock.graph.render).toHaveBeenCalledTimes(1))
    expect(g6Mock.graph.setElementState).toHaveBeenCalledWith(
      {
        'entity-1': [],
        'entity-2': []
      },
      false
    )
    expect(g6Mock.graph.fitView).toHaveBeenCalledWith(
      {
        when: 'always',
        direction: 'both'
      },
      false
    )
    const stableRenderCallCount = g6Mock.graph.render.mock.calls.length
    rerender(<KnowledgeWorkspace {...createProps({ onMoveNode })} />)
    expect(g6Mock.graph.render).toHaveBeenCalledTimes(stableRenderCallCount)
    const movedGraphNodes = createProps().graphNodes.map((node) =>
      node.id === 'entity-1' ? { ...node, x: 240, y: 320 } : node
    )
    rerender(
      <KnowledgeWorkspace
        {...createProps({ graphNodes: movedGraphNodes, onMoveNode })}
      />
    )
    expect(g6Mock.graph.render).toHaveBeenCalledTimes(stableRenderCallCount)

    fireEvent.click(screen.getByRole('button', { name: '放大图谱' }))
    expect(screen.getByText('115%')).toBeInTheDocument()
    expect(g6Mock.graph.zoomTo).toHaveBeenLastCalledWith(1.15, false)

    const fitViewCallCount = g6Mock.graph.fitView.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: '显示全部' }))
    await waitFor(() =>
      expect(g6Mock.graph.fitView).toHaveBeenCalledTimes(
        fitViewCallCount + 1
      )
    )

    act(() => {
      g6Mock.handlers.get('node:click')?.({
        target: { id: 'entity-1' },
        targetType: 'node'
      })
    })
    expect(screen.getByLabelText('实体详情')).toBeInTheDocument()
    await waitFor(() =>
      expect(g6Mock.graph.setElementState).toHaveBeenCalledWith(
        expect.objectContaining({
          'entity-1': ['selected'],
          'entity-2': []
        }),
        false
      )
    )
    expect(onMoveNode).not.toHaveBeenCalled()

    act(() => {
      g6Mock.handlers.get('node:dragend')?.({
        target: { id: 'entity-1' },
        targetType: 'node'
      })
    })
    expect(onMoveNode).toHaveBeenCalledWith('entity-1', {
      x: 240,
      y: 320
    })

    fireEvent.click(
      screen.getByRole('button', { name: 'Electron' })
    )
    expect(
      screen.getByRole('heading', { name: 'Electron' })
    ).toBeInTheDocument()

    unmount()
    expect(g6Mock.graph.off).toHaveBeenCalledWith(
      'node:click',
      expect.any(Function)
    )
    expect(g6Mock.graph.off).toHaveBeenCalledWith(
      'node:dragend',
      expect.any(Function)
    )
    expect(g6Mock.graph.off).toHaveBeenCalledWith(
      'aftertransform',
      expect.any(Function)
    )
    expect(g6Mock.graph.destroy).toHaveBeenCalled()
  })

  it('preserves the G6 instance and refreshes theme colors', async () => {
    render(<KnowledgeWorkspace {...createProps()} />)
    fireEvent.click(screen.getByRole('tab', { name: '知识图谱' }))
    await screen.findByLabelText('实体关系图')

    g6Mock.graph.getZoom.mockReturnValueOnce(1.3)
    act(() => {
      g6Mock.handlers.get('aftertransform')?.({})
    })

    await waitFor(() =>
      expect(screen.getByText('130%')).toBeInTheDocument()
    )
    const renderCalls = g6Mock.graph.render.mock.calls.length
    fireEvent.change(screen.getByLabelText('搜索图谱实体'), {
      target: { value: 'Electron' }
    })
    await waitFor(() =>
      expect(g6Mock.graph.render.mock.calls.length).toBeGreaterThan(
        renderCalls
      )
    )
    expect(g6Mock.Graph).toHaveBeenCalledTimes(1)

    const themeRenderCalls = g6Mock.graph.render.mock.calls.length
    act(() => {
      document.documentElement.dataset.theme = 'dark'
    })
    await waitFor(() =>
      expect(g6Mock.graph.render.mock.calls.length).toBeGreaterThan(
        themeRenderCalls
      )
    )
    delete document.documentElement.dataset.theme
  })

  it('sizes dense nodes by degree and labels key entities', async () => {
    const graphNodes = Array.from({ length: 30 }, (_, index) => ({
      id: `entity-${index}`,
      label: `实体 ${index}`,
      type: '概念',
      x: index * 10,
      y: index * 5
    }))
    render(
      <KnowledgeWorkspace
        {...createProps({
          graphNodes,
          graphRelations: [
            {
              id: 'relation-dense-1',
              sourceId: 'entity-0',
              targetId: 'entity-1',
              type: '关联'
            },
            {
              id: 'relation-dense-2',
              sourceId: 'entity-0',
              targetId: 'entity-2',
              type: '关联'
            }
          ]
        })}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: '知识图谱' }))
    await screen.findByLabelText('实体关系图')

    expect(g6Mock.graph.setOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: 'entity-0',
              data: expect.objectContaining({
                degree: 2,
                size: 32
              }),
              style: expect.objectContaining({
                x: 0,
                y: 0
              })
            }),
            expect.objectContaining({
              id: 'entity-29',
              data: expect.objectContaining({
                degree: 0,
                size: 16
              })
            })
          ])
        }),
        layout: expect.objectContaining({
          animate: false,
          linkDistance: 44,
          nodeSpacing: 10,
          nodeStrength: -45,
          preventOverlap: true,
          radialRadius: 0,
          radialStrength: 0.055,
          type: 'd3-force'
        }),
        behaviors: expect.arrayContaining([
          expect.objectContaining({
            sortNode: { type: 'degree' },
            type: 'auto-adapt-label'
          })
        ])
      })
    )
  })

  it('shows a graph-local loading state and retries a failed chart chunk', async () => {
    let attempts = 0
    const loadModule = vi.fn(async () => {
      attempts += 1
      if (attempts <= 2) {
        throw new Error('chunk unavailable')
      }
      return {
        KnowledgeGraphChart: () => (
          <div aria-label="已加载的图谱测试组件" />
        )
      } as unknown as typeof import('./KnowledgeGraphChart')
    })
    const props = createProps()

    render(
      <KnowledgeGraphChartLoader
        fitViewRequest={0}
        loadModule={loadModule}
        nodes={props.graphNodes}
        onMoveNode={props.onMoveNode}
        onSelectNode={vi.fn()}
        onZoomChange={vi.fn()}
        relations={props.graphRelations}
        zoom={1}
      />
    )

    expect(
      screen.getByRole('status')
    ).toHaveTextContent('正在加载知识图谱…')
    expect(
      await screen.findByRole('alert')
    ).toHaveTextContent('知识图谱未能加载，请重试。')
    expect(loadModule).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    expect(
      await screen.findByLabelText('已加载的图谱测试组件')
    ).toBeInTheDocument()
    expect(loadModule).toHaveBeenCalledTimes(3)
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
      target: { value: 'DEPENDS_ON' }
    })
    fireEvent.change(screen.getByLabelText('说明'), {
      target: { value: '桌面运行基础' }
    })
    fireEvent.click(screen.getByRole('button', { name: '新增关系' }))
    await waitFor(() =>
      expect(onCreateRelation).toHaveBeenCalledWith({
        sourceId: 'entity-1',
        targetId: 'entity-2',
        type: 'DEPENDS_ON',
        description: '桌面运行基础'
      })
    )

    fireEvent.change(screen.getByLabelText('选择合并目标'), {
      target: { value: 'entity-2' }
    })
    fireEvent.click(screen.getByRole('button', { name: '合并到目标实体' }))
    expect(
      screen.getByRole('alertdialog', {
        name: '将“GoodBuddy”合并到“Electron”？'
      })
    ).toHaveAccessibleDescription(
      '“GoodBuddy”的关系、别名和证据将并入“Electron”，随后删除源实体。此操作无法恢复。'
    )
    expect(onMergeEntities).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole('button', { name: '合并实体' })
    )
    await waitFor(() =>
      expect(onMergeEntities).toHaveBeenCalledWith(
        'entity-1',
        'entity-2'
      )
    )
    await waitFor(() =>
      expect(screen.getByLabelText('选择图谱实体')).toHaveFocus()
    )
  })

  it('confirms graph entity and relation deletion with concrete impact', async () => {
    const onDeleteEntity = vi.fn(async () => {})
    const onDeleteRelation = vi.fn(async () => {})
    render(
      <KnowledgeWorkspace
        {...createProps({ onDeleteEntity, onDeleteRelation })}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '知识图谱' }))
    fireEvent.change(screen.getByLabelText('选择图谱实体'), {
      target: { value: 'entity-1' }
    })
    fireEvent.click(
      screen.getByRole('button', { name: '删除实体 GoodBuddy' })
    )
    expect(
      screen.getByRole('alertdialog', {
        name: '删除实体“GoodBuddy”？'
      })
    ).toHaveAccessibleDescription(
      '将永久删除实体“GoodBuddy”及其 1 条关联关系；相关证据引用也会从图谱中移除，且无法恢复。'
    )
    expect(onDeleteEntity).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    fireEvent.click(
      screen.getByRole('button', { name: '删除关系 使用' })
    )
    expect(
      screen.getByRole('alertdialog', {
        name: '删除关系“使用 (USES)”？'
      })
    ).toHaveAccessibleDescription(
      '将永久删除“GoodBuddy”到“Electron”的“使用 (USES)”关系及其图谱证据引用，且无法恢复。两个实体本身会保留。'
    )
    fireEvent.click(
      screen.getByRole('button', { name: '删除关系' })
    )
    await waitFor(() =>
      expect(onDeleteRelation).toHaveBeenCalledWith('relation-1')
    )
    await waitFor(() =>
      expect(screen.getByLabelText('选择图谱实体')).toHaveFocus()
    )

    fireEvent.click(
      screen.getByRole('button', { name: '删除实体 GoodBuddy' })
    )
    fireEvent.click(
      screen.getByRole('button', { name: '删除实体' })
    )
    await waitFor(() =>
      expect(onDeleteEntity).toHaveBeenCalledWith('entity-1')
    )
    await waitFor(() =>
      expect(screen.getByLabelText('选择图谱实体')).toHaveFocus()
    )
  })

  it('keeps a failed graph confirmation open and focused', async () => {
    const onDeleteEntity = vi.fn(async () => {
      throw new Error('删除实体失败')
    })
    render(
      <KnowledgeWorkspace
        {...createProps({ onDeleteEntity })}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '知识图谱' }))
    fireEvent.change(screen.getByLabelText('选择图谱实体'), {
      target: { value: 'entity-1' }
    })
    fireEvent.click(
      screen.getByRole('button', { name: '删除实体 GoodBuddy' })
    )
    const confirm = screen.getByRole('button', {
      name: '删除实体'
    })
    confirm.focus()
    fireEvent.click(confirm)

    expect(await screen.findByText('删除实体失败')).toBeInTheDocument()
    expect(
      screen.getByRole('alertdialog', {
        name: '删除实体“GoodBuddy”？'
      })
    ).toBeInTheDocument()
    expect(confirm).toHaveFocus()
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

  it('keeps one primary creation action in the empty library state', () => {
    render(
      <KnowledgeWorkspace
        {...createProps({
          libraries: [],
          selectedLibraryId: undefined
        })}
      />
    )

    expect(screen.getByText('建立第一个知识库')).toBeInTheDocument()
    expect(
      screen.getAllByRole('button', { name: '新建知识库' })
    ).toHaveLength(1)
    expect(
      screen.queryByRole('button', { name: '创建知识库' })
    ).not.toBeInTheDocument()
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

  it('isolates and traps focus in the library edit dialog', async () => {
    render(<KnowledgeWorkspace {...createProps()} />)

    const trigger = screen.getByRole('button', { name: '编辑' })
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = screen.getByRole('dialog', {
      name: '编辑知识库'
    })
    const nameInput = screen.getByLabelText('名称')
    expect(nameInput).toHaveFocus()
    expect(
      document.querySelector<HTMLElement>(
        '.knowledge-workspace__main'
      )?.inert
    ).toBe(true)
    fireEvent.keyDown(nameInput, { key: 'Tab', shiftKey: true })
    expect(
      screen.getByRole('button', { name: '保存修改' })
    ).toHaveFocus()

    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(
      document.querySelector<HTMLElement>(
        '.knowledge-workspace__main'
      )?.inert
    ).toBe(false)
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
    expect(
      document.querySelector<HTMLElement>(
        '.knowledge-workspace__main'
      )?.inert
    ).toBe(true)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(
      document.querySelector<HTMLElement>(
        '.knowledge-workspace__main'
      )?.inert
    ).toBe(false)
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
