import {
  cleanup,
  fireEvent,
  render,
  screen
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  EmbeddingConfigurationSummary,
  EmbeddingIndexStatus
} from '../../shared/embedding-contracts'
import { EmbeddingSettingsSection } from './EmbeddingSettingsSection'
import { changeUiLocale } from './i18n'

const configuration: EmbeddingConfigurationSummary = {
  provider: 'openai-compatible',
  model: 'text-embedding-3-small',
  endpoint: 'https://vectors.example/v1/embeddings',
  credentialConfigured: true
}

const idleIndex: EmbeddingIndexStatus = {
  job: null
}

afterEach(() => {
  cleanup()
})

describe('EmbeddingSettingsSection', () => {
  it('renders embedding settings in English without translating model data', async () => {
    await changeUiLocale('en-US')
    render(
      <EmbeddingSettingsSection
        configuration={configuration}
        indexStatus={idleIndex}
        onRebuild={vi.fn()}
        onTest={vi.fn()}
      />
    )

    expect(
      screen.getByRole('heading', {
        name: 'Embeddings and knowledge retrieval'
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Current embedding model' })
    ).toBeInTheDocument()
    expect(screen.getByText('text-embedding-3-small')).toBeInTheDocument()
    expect(screen.getByText('Provider: openai-compatible'))
      .toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Test embedding model' })
    ).toBeInTheDocument()
    expect(screen.getByText('No rebuild history yet')).toBeInTheDocument()
  })

  it('uses supplied callbacks without depending on a preload API', () => {
    const onTest = vi.fn()
    const onRebuild = vi.fn()
    render(
      <EmbeddingSettingsSection
        configuration={configuration}
        indexStatus={idleIndex}
        onRebuild={onRebuild}
        onTest={onTest}
      />
    )

    expect(
      screen.getByRole('heading', { name: '向量与知识检索' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '当前向量模型' })
    ).toBeInTheDocument()
    expect(screen.getByText('text-embedding-3-small')).toBeInTheDocument()
    expect(screen.getByText('已配置凭据')).toBeInTheDocument()
    expect(screen.getByText('还没有重建记录')).toBeInTheDocument()
    expect(
      screen.getByText(
        '点击“重建向量索引”，为知识文档生成可用于检索的向量。'
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/快照/)).not.toBeInTheDocument()
    expect(screen.queryByText(/当前检索索引/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '测试向量模型' }))
    fireEvent.click(screen.getByRole('button', { name: '重建向量索引' }))
    expect(onTest).toHaveBeenCalledOnce()
    expect(onRebuild).toHaveBeenCalledOnce()
  })

  it('shows dimensions and latency from a real diagnostic result', () => {
    render(
      <EmbeddingSettingsSection
        configuration={configuration}
        diagnostic={{
          status: 'available',
          provider: 'openai-compatible',
          model: 'text-embedding-3-small',
          checkedAt: 1_700_000_000_000,
          latencyMs: 126,
          dimensions: 1_536
        }}
        indexStatus={idleIndex}
        onRebuild={vi.fn()}
        onTest={vi.fn()}
      />
    )

    expect(screen.getByText('测试成功')).toBeInTheDocument()
    expect(
      screen.getByText('服务返回 1536 维向量，耗时 126 毫秒。')
    ).toBeInTheDocument()
  })

  it('renders a safe actionable diagnostic error', () => {
    render(
      <EmbeddingSettingsSection
        configuration={configuration}
        diagnostic={{
          status: 'unavailable',
          provider: 'openai-compatible',
          model: 'missing-model',
          checkedAt: 1,
          latencyMs: 25,
          error: {
            code: 'model_not_found',
            message: '未找到指定的向量模型。',
            retryable: false,
            remedy: '请确认模型名称正确。'
          }
        }}
        indexStatus={idleIndex}
        onRebuild={vi.fn()}
        onTest={vi.fn()}
      />
    )

    expect(screen.getByRole('alert')).toHaveTextContent(
      '未找到指定的向量模型。'
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      '处理建议：请确认模型名称正确。'
    )
  })

  it('shows document progress and atomic availability while rebuilding', () => {
    const onCancel = vi.fn()
    render(
      <EmbeddingSettingsSection
        configuration={configuration}
        indexStatus={{
          job: {
            id: 'job-new',
            status: 'running',
            provider: 'openai-compatible',
            model: 'embed-v2',
            progress: {
              completed: 10,
              total: 40,
              percent: 25
            },
            createdAt: 1_700_000_000_100,
            startedAt: 1_700_000_000_200
          }
        }}
        onCancel={onCancel}
        onRebuild={vi.fn()}
        onTest={vi.fn()}
      />
    )

    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '25')
    expect(screen.getByText('已完成 10 / 40 篇文档')).toBeInTheDocument()
    expect(
      screen.getByText(/每篇文档会一次性更新，处理完成后立即可用于检索。/)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/其余文档的原有或缺失状态不变。/)
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '重建进行中…' })
    ).toBeDisabled()

    fireEvent.click(
      screen.getByRole('button', { name: '取消向量索引重建' })
    )
    expect(onCancel).toHaveBeenCalledWith('job-new')
  })

  it('shows a failed rebuild remedy and retries from the rebuild button', () => {
    const onRebuild = vi.fn()
    render(
      <EmbeddingSettingsSection
        configuration={configuration}
        indexStatus={{
          job: {
            id: 'job-failed',
            status: 'failed',
            provider: 'provider',
            model: 'model',
            progress: { completed: 2, total: 4, percent: 50 },
            createdAt: 1,
            completedAt: 2,
            error: {
              code: 'rate_limited',
              message: '向量服务当前请求过多。',
              retryable: true
            }
          }
        }}
        onRebuild={onRebuild}
        onTest={vi.fn()}
      />
    )

    expect(screen.getByText('最近一次重建失败')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      '向量服务当前请求过多。'
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      '已完成 2 / 4 篇文档。发生错误的文档已标记为错误，已完成文档仍可用于检索。'
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      '请检查向量模型配置和网络连接。修复后点击“重建向量索引”重试。'
    )

    fireEvent.click(screen.getByRole('button', { name: '重建向量索引' }))
    expect(onRebuild).toHaveBeenCalledOnce()
  })

  it('reports successful and cancelled rebuilds distinctly', () => {
    const { rerender } = render(
      <EmbeddingSettingsSection
        configuration={configuration}
        indexStatus={{
          job: {
            id: 'job-completed',
            status: 'completed',
            provider: 'provider',
            model: 'model',
            progress: { completed: 4, total: 4, percent: 100 },
            createdAt: 1,
            completedAt: 2
          }
        }}
        onRebuild={vi.fn()}
        onTest={vi.fn()}
      />
    )
    expect(screen.getByText('最近一次重建成功')).toBeInTheDocument()
    expect(screen.getByText('已完成 4 / 4 篇文档', { exact: false }))
      .toBeInTheDocument()

    rerender(
      <EmbeddingSettingsSection
        configuration={configuration}
        indexStatus={{
          job: {
            id: 'job-cancelled',
            status: 'cancelled',
            provider: 'provider',
            model: 'model',
            progress: { completed: 2, total: 4, percent: 50 },
            createdAt: 1,
            completedAt: 2
          }
        }}
        onRebuild={vi.fn()}
        onTest={vi.fn()}
      />
    )
    expect(screen.getByText('最近一次重建已取消')).toBeInTheDocument()
    expect(
      screen.getByText('已完成 2 / 4 篇文档。')
    ).toBeInTheDocument()
    expect(
      screen.getByText(/已完成文档保留新向量；其余文档保留原有向量/)
    ).toBeInTheDocument()
    expect(screen.getByText(/原本没有向量的仍保持缺失。/))
      .toBeInTheDocument()
    expect(screen.queryByText(/索引未更改/)).not.toBeInTheDocument()
  })
})
