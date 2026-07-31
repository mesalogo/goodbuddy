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
