import {
  cleanup,
  fireEvent,
  render,
  screen
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  KnowledgeEmbeddingIndexSnapshot
} from '../../shared/embedding-contracts'
import { KnowledgeEmbeddingIndexSection } from './KnowledgeEmbeddingIndexSection'

const snapshot: KnowledgeEmbeddingIndexSnapshot = {
  knowledgeBaseId: '11111111-1111-4111-8111-111111111111',
  enabled: true,
  configuration: {
    provider: 'openai-compatible',
    model: 'qwen3-embedding:latest',
    endpoint: 'http://127.0.0.1:11434/v1/embeddings',
    credentialConfigured: false
  },
  coverage: {
    total: 12,
    indexed: 8,
    missing: 3,
    error: 1
  },
  indexStatus: { job: null }
}

afterEach(cleanup)

describe('KnowledgeEmbeddingIndexSection', () => {
  it('shows current-library coverage and starts a scoped rebuild', () => {
    const onRebuild = vi.fn()
    render(
      <KnowledgeEmbeddingIndexSection
        onRebuild={onRebuild}
        snapshot={snapshot}
      />
    )

    expect(
      screen.getByRole('heading', { name: '向量索引' })
    ).toBeInTheDocument()
    expect(screen.getByText('qwen3-embedding:latest')).toBeInTheDocument()
    expect(screen.getByText('8')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: '重建向量索引' })
    )
    expect(onRebuild).toHaveBeenCalledOnce()
  })

  it('routes active job details to the task center without duplicating progress', () => {
    const onViewTasks = vi.fn()
    render(
      <KnowledgeEmbeddingIndexSection
        onRebuild={vi.fn()}
        onViewTasks={onViewTasks}
        snapshot={{
          ...snapshot,
          indexStatus: {
            job: {
              id: '22222222-2222-4222-8222-222222222222',
              status: 'running',
              provider: 'openai-compatible',
              model: 'qwen3-embedding:latest',
              progress: { completed: 2, total: 12, percent: 100 / 6 },
              createdAt: 1,
              startedAt: 2
            }
          }
        }}
      />
    )

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.queryByText('已完成 2 / 12 篇文档')).not
      .toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '重建向量索引' })
    ).toBeDisabled()

    fireEvent.click(
      screen.getByRole('button', {
        name: '任务中心查看详情'
      })
    )
    expect(onViewTasks).toHaveBeenCalledOnce()
  })

  it('directs users to model connections when embeddings are disabled', () => {
    render(
      <KnowledgeEmbeddingIndexSection
        onRebuild={vi.fn()}
        snapshot={{
          knowledgeBaseId: snapshot.knowledgeBaseId,
          enabled: false,
          coverage: { total: 12, indexed: 0, missing: 12, error: 0 },
          indexStatus: { job: null }
        }}
      />
    )

    expect(screen.getByText('向量模型未启用')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '重建向量索引' })
    ).toBeDisabled()
  })
})
