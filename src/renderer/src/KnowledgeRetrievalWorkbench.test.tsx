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
  KnowledgeRetrievalWorkbench,
  type KnowledgeRetrievalWorkbenchProps,
  type KnowledgeRetrievalWorkbenchResponse,
  type KnowledgeRetrievalWorkbenchSettings
} from './KnowledgeRetrievalWorkbench'
import { changeUiLocale } from './i18n'

const settings: KnowledgeRetrievalWorkbenchSettings = {
  topK: 6,
  minimumVectorSimilarity: 0,
  ftsWeight: 1,
  vectorWeight: 1,
  graphWeight: 0.8,
  candidateMultiplier: 4,
  contextMaxCharacters: 16_000,
  adjacentChunkCount: 1,
  localRerankEnabled: false,
  rerankMode: 'none'
}

const response: KnowledgeRetrievalWorkbenchResponse = {
  diagnostics: {
    durationMs: 43,
    requestedChannels: ['fts', 'cjk', 'vector', 'graph'],
    usedChannels: ['fts', 'cjk'],
    degradedChannels: [
      {
        channel: 'vector',
        reason: '查询向量服务不可用'
      }
    ],
    candidateCounts: { fts: 4, cjk: 7, vector: 0, graph: 0 },
    channelDurationsMs: { fts: 8, cjk: 12, vector: 20, graph: 3 },
    vectorScannedCount: 10_240
  },
  context: {
    characterCount: 312,
    budget: 16_000,
    truncated: false
  },
  results: [
    {
      chunkId: 'chunk-1',
      documentId: 'document-1',
      rank: 1,
      documentName: '离线部署.md',
      sourceName: '产品文档',
      locator: '第 3 节',
      snippet: '离线环境可以导入已经校验的模型 ZIP。',
      fusedScore: 0.0328,
      relevance: 0.91,
      channels: ['fts', 'cjk'],
      channelDetails: {
        fts: { rank: 1, score: 0.84 },
        cjk: { rank: 2, score: 0.71 }
      },
      rankBeforeRerank: 2,
      contextText: '离线环境可以导入已经校验的模型 ZIP，并在本机运行。',
      contextCharacterCount: 312,
      contextTruncated: false,
      diagnostics: ['标题短语命中']
    }
  ]
}

function createProps(
  overrides: Partial<KnowledgeRetrievalWorkbenchProps> = {}
): KnowledgeRetrievalWorkbenchProps {
  return {
    libraryName: '产品知识',
    settings,
    onTest: vi.fn(),
    onViewContext: vi.fn(),
    onOpenSource: vi.fn(),
    onSaveDefaults: vi.fn(),
    onClose: vi.fn(),
    ...overrides
  }
}

afterEach(async () => {
  cleanup()
  await changeUiLocale('zh-CN')
})

describe('KnowledgeRetrievalWorkbench', () => {
  it('provides dialog semantics, focuses the persistent query, and returns focus on close', async () => {
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(false)
      return (
        <>
          <div className="app-shell">
            <button onClick={() => setOpen(true)} type="button">
              打开检索测试
            </button>
          </div>
          {open && (
            <KnowledgeRetrievalWorkbench
              {...createProps({ onClose: () => setOpen(false) })}
            />
          )}
        </>
      )
    }

    render(<Harness />)
    const trigger = screen.getByRole('button', { name: '打开检索测试' })
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = screen.getByRole('dialog', { name: '检索测试' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByLabelText('检索问题')).toHaveFocus()
    expect(
      document.querySelector<HTMLElement>('.app-shell')?.inert
    ).toBe(true)

    fireEvent.change(screen.getByLabelText('检索问题'), {
      target: { value: '这段查询会被保留' }
    })
    expect(screen.getByLabelText('检索问题')).toHaveValue(
      '这段查询会被保留'
    )

    fireEvent.keyDown(dialog, { key: 'Escape' })

    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(trigger).toHaveFocus()
    expect(
      document.querySelector<HTMLElement>('.app-shell')?.inert
    ).toBe(false)
  })

  it('validates the query and settings before invoking retrieval', () => {
    const onTest = vi.fn()
    render(
      <KnowledgeRetrievalWorkbench
        {...createProps({
          onTest,
          settings: {
            ...settings,
            topK: 0,
            ftsWeight: 0,
            vectorWeight: 0,
            graphWeight: 0
          }
        })}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '测试检索' }))

    expect(screen.getByText('请输入测试问题。')).toBeInTheDocument()
    expect(
      screen.getByText('Top K 必须是 1 至 20 的整数。')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('alert')
    ).toHaveTextContent('至少一个当前可用的检索通道权重必须大于 0。')
    expect(onTest).not.toHaveBeenCalled()
  })

  it('requires available channel shares to total one hundred percent', () => {
    const onTest = vi.fn()
    render(
      <KnowledgeRetrievalWorkbench
        {...createProps({
          initialQuery: '检查占比',
          onTest
        })}
      />
    )

    fireEvent.change(screen.getByLabelText(/^全文占比/), {
      target: { value: '40' }
    })
    fireEvent.click(screen.getByRole('button', { name: '测试检索' }))

    expect(screen.getByRole('alert')).toHaveTextContent(
      '当前可用检索通道的融合占比合计必须为 100%。'
    )
    expect(onTest).not.toHaveBeenCalled()
  })

  it('presents legacy negative thresholds as zero', () => {
    const onTest = vi.fn()
    render(
      <KnowledgeRetrievalWorkbench
        {...createProps({
          initialQuery: '兼容旧阈值',
          onTest,
          settings: {
            ...settings,
            minimumVectorSimilarity: -1
          }
        })}
      />
    )

    expect(screen.getByLabelText(/^最低向量相似度/)).toHaveValue(0)
    fireEvent.click(screen.getByRole('button', { name: '测试检索' }))
    expect(onTest).toHaveBeenCalledWith({
      query: '兼容旧阈值',
      settings: {
        ...settings,
        minimumVectorSimilarity: 0
      }
    })
  })

  it('submits temporary settings and exposes result actions and diagnostics', () => {
    const onTest = vi.fn()
    const onSaveDefaults = vi.fn()
    const onViewContext = vi.fn()
    const onOpenSource = vi.fn()
    render(
      <KnowledgeRetrievalWorkbench
        {...createProps({
          initialQuery: '如何离线部署？',
          onOpenSource,
          onSaveDefaults,
          onTest,
          onViewContext,
          response,
          status: 'success'
        })}
      />
    )

    expect(screen.getByText('最多 24 个融合候选')).toBeInTheDocument()
    const recallMultiplier = screen.getByLabelText(/^召回倍数/)
    fireEvent.change(recallMultiplier, { target: { value: '5' } })
    expect(screen.getByText('最多 30 个融合候选')).toBeInTheDocument()
    expect(screen.getByLabelText(/^全文占比/)).toHaveValue(35.7)
    expect(screen.getByLabelText(/^向量占比/)).toHaveValue(35.7)
    expect(screen.getByLabelText(/^图谱占比/)).toHaveValue(28.6)
    fireEvent.change(screen.getByLabelText(/^最低向量相似度/), {
      target: { value: '25' }
    })
    fireEvent.change(screen.getByLabelText(/^全文占比/), {
      target: { value: '50' }
    })
    fireEvent.change(screen.getByLabelText(/^向量占比/), {
      target: { value: '30' }
    })
    fireEvent.change(screen.getByLabelText(/^图谱占比/), {
      target: { value: '20' }
    })
    const topK = screen.getByLabelText(/^最终结果数/)
    fireEvent.change(topK, { target: { value: '8' } })
    expect(screen.getByText('最多 40 个融合候选')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '本地规则' }))
    expect(screen.getByText('重排最多 40 个候选')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '测试检索' }))

    expect(onTest).toHaveBeenCalledWith({
      query: '如何离线部署？',
      settings: {
        ...settings,
        topK: 8,
        candidateMultiplier: 5,
        minimumVectorSimilarity: 0.25,
        ftsWeight: 1,
        vectorWeight: 0.6,
        graphWeight: 0.4,
        localRerankEnabled: true,
        rerankMode: 'local'
      }
    })

    fireEvent.click(screen.getByRole('button', { name: '保存为默认值' }))
    expect(onSaveDefaults).toHaveBeenCalledWith({
      ...settings,
      topK: 8,
      candidateMultiplier: 5,
      minimumVectorSimilarity: 0.25,
      ftsWeight: 1,
      vectorWeight: 0.6,
      graphWeight: 0.4,
      localRerankEnabled: true,
      rerankMode: 'local'
    })

    expect(screen.getByText('本次检索已降级')).toBeInTheDocument()
    expect(screen.getByText('已扫描向量')).toBeInTheDocument()
    expect(screen.getByText('91%')).toBeInTheDocument()
    expect(
      screen.getByRole('article', {
        name: '第 1 条结果，离线部署.md'
      })
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '查看分块' }))
    fireEvent.click(screen.getByRole('button', { name: '打开来源' }))
    expect(onViewContext).toHaveBeenCalledWith(response.results[0])
    expect(onOpenSource).toHaveBeenCalledWith(response.results[0])
  })

  it('distinguishes running, error, and zero-result states', () => {
    const { rerender } = render(
      <KnowledgeRetrievalWorkbench
        {...createProps({
          initialQuery: '没有答案的问题',
          status: 'running'
        })}
      />
    )

    expect(screen.getByRole('status')).toHaveTextContent(
      '正在检索当前知识库'
    )
    expect(screen.getByRole('button', { name: '正在检索…' })).toBeDisabled()

    rerender(
      <KnowledgeRetrievalWorkbench
        {...createProps({
          error: '索引校验失败',
          initialQuery: '没有答案的问题',
          status: 'error'
        })}
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent('索引校验失败')

    rerender(
      <KnowledgeRetrievalWorkbench
        {...createProps({
          initialQuery: '没有答案的问题',
          response: {
            ...response,
            results: [],
            zeroReason: 'filtered'
          },
          status: 'success'
        })}
      />
    )
    expect(screen.getByText('结果已被阈值过滤')).toBeInTheDocument()
    expect(screen.getByLabelText('检索问题')).toHaveValue('没有答案的问题')
  })
})
