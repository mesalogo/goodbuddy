import {
  cleanup,
  fireEvent,
  render,
  screen
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  EmbeddingConfigurationSummary
} from '../../shared/embedding-contracts'
import { EmbeddingSettingsSection } from './EmbeddingSettingsSection'
import { changeUiLocale } from './i18n'

const configuration: EmbeddingConfigurationSummary = {
  provider: 'openai-compatible',
  model: 'text-embedding-3-small',
  endpoint: 'https://vectors.example/v1/embeddings',
  credentialConfigured: true
}

afterEach(() => {
  cleanup()
})

describe('EmbeddingSettingsSection', () => {
  it('keeps model settings limited to connection details and diagnostics', () => {
    const onTest = vi.fn()
    render(
      <EmbeddingSettingsSection
        configuration={configuration}
        onTest={onTest}
      />
    )

    expect(
      screen.getByRole('heading', { name: '向量模型连接' })
    ).toBeInTheDocument()
    expect(screen.getByText('text-embedding-3-small')).toBeInTheDocument()
    expect(screen.getByText('已配置凭据')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /重建向量索引/u })
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/知识向量索引/u)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '测试向量模型' }))
    expect(onTest).toHaveBeenCalledOnce()
  })

  it('renders connection copy in English without translating model data', async () => {
    await changeUiLocale('en-US')
    render(
      <EmbeddingSettingsSection
        configuration={configuration}
        onTest={vi.fn()}
      />
    )

    expect(
      screen.getByRole('heading', {
        name: 'Embedding model connection'
      })
    ).toBeInTheDocument()
    expect(screen.getByText('text-embedding-3-small')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Test embedding model' })
    ).toBeInTheDocument()
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
})
