import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageOperationStatus } from './ImageOperationStatus'
import type { ImageOperation } from '../../shared/image-generation-contracts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('image operation controls', () => {
  it('offers explicit failed-edit recovery without changing regeneration inputs', async () => {
    const regenerate = vi.fn(async () => undefined)
    Object.defineProperty(window, 'goodbuddy', { configurable: true, value: { conversations: { imageOperations: { regenerate } } } })
    const operation: ImageOperation = {
      id: crypto.randomUUID(), conversationId: crypto.randomUUID(), messageId: crypto.randomUUID(),
      requestId: crypto.randomUUID(), callId: 'edit-call', modelProfileId: crypto.randomUUID(), modelName: 'original-model',
      input: { intent: 'edit', prompt: 'Change the background', sourceArtifactIds: [crypto.randomUUID()] },
      state: 'failed', error: 'Source unavailable', artifactIds: [], createdAt: 1, updatedAt: 1
    }
    const onOpenImageModelSettings = vi.fn()
    const onReselectImageSources = vi.fn()
    const view = render(<ImageOperationStatus operation={operation} onOpenImageModelSettings={onOpenImageModelSettings} onReselectImageSources={onReselectImageSources} />)
    fireEvent.click(screen.getByRole('button', { name: '重新选择模型' }))
    fireEvent.click(screen.getByRole('button', { name: '重新选择素材' }))
    expect(onOpenImageModelSettings).toHaveBeenCalledOnce()
    expect(onReselectImageSources).toHaveBeenCalledExactlyOnceWith(operation)
    expect(regenerate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '重新生成' }))
    await waitFor(() => expect(regenerate).toHaveBeenCalledExactlyOnceWith({ conversationId: operation.conversationId, operationId: operation.id }))
    view.rerender(<ImageOperationStatus operation={{ ...operation, state: 'running' }} onOpenImageModelSettings={onOpenImageModelSettings} onReselectImageSources={onReselectImageSources} />)
    expect(screen.queryByRole('button', { name: '重新选择模型' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新选择素材' })).not.toBeInTheDocument()
    view.rerender(<ImageOperationStatus operation={{ ...operation, input: { ...operation.input, intent: 'create', sourceArtifactIds: [] } }} onOpenImageModelSettings={onOpenImageModelSettings} onReselectImageSources={onReselectImageSources} />)
    expect(screen.getByRole('button', { name: '重新选择模型' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新选择素材' })).not.toBeInTheDocument()
  })

  it('cancels independently and offers an explicit new request with local error recovery', async () => {
    const cancel = vi.fn(async () => undefined)
    const regenerate = vi.fn(async () => { throw new Error('Selected image model is unavailable') })
    Object.defineProperty(window, 'goodbuddy', { configurable: true, value: { conversations: { imageOperations: { cancel, regenerate } } } })
    const operation: ImageOperation = { id: crypto.randomUUID(), conversationId: crypto.randomUUID(), messageId: crypto.randomUUID(),
      requestId: crypto.randomUUID(), callId: 'image-call', modelProfileId: crypto.randomUUID(), modelName: 'image-model',
      input: { intent: 'create', prompt: 'Blue circle', sourceArtifactIds: [] }, state: 'running', artifactIds: [], createdAt: 1, updatedAt: 1 }
    const view = render(<ImageOperationStatus operation={operation} />)
    fireEvent.click(screen.getByRole('button', { name: '取消生成' }))
    await waitFor(() => expect(cancel).toHaveBeenCalledExactlyOnceWith({ conversationId: operation.conversationId, operationId: operation.id }))
    view.rerender(<ImageOperationStatus operation={{ ...operation, state: 'unconfirmed' }} />)
    expect(screen.getByText('将发起新的模型请求。')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: '重新生成' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Selected image model is unavailable')
    expect(screen.getByText('Blue circle')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新生成' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '重新生成' })).toHaveAccessibleDescription('Selected image model is unavailable')
    expect(regenerate).toHaveBeenCalledOnce()
  })

  it('distinguishes pending cancellation, stopped waiting, and a saved late result', () => {
    const operation: ImageOperation = {
      id: crypto.randomUUID(), conversationId: crypto.randomUUID(), messageId: crypto.randomUUID(),
      requestId: crypto.randomUUID(), callId: 'image-call', modelProfileId: crypto.randomUUID(), modelName: 'image-model',
      input: { intent: 'create', prompt: 'Blue circle', sourceArtifactIds: [] },
      state: 'cancelling', cancellationRequested: true, artifactIds: [], createdAt: 1, updatedAt: 1
    }
    const view = render(<ImageOperationStatus operation={operation} />)
    expect(screen.getByText('已请求取消。提供商可能继续生成并计费。')).toBeVisible()
    expect(screen.queryByText(/已停止等待/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消生成' })).toBeDisabled()
    view.rerender(<ImageOperationStatus operation={{ ...operation, state: 'stopped' }} />)
    expect(screen.getByText('已停止等待。提供商可能继续生成并计费，晚到的结果会保存在这里。')).toBeVisible()
    view.rerender(<ImageOperationStatus operation={{ ...operation, state: 'completed', artifactIds: [crypto.randomUUID()] }} />)
    expect(screen.getByText('取消未生效，已生成并保存图片。')).toBeVisible()
    expect(screen.queryByText(/已停止等待/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新生成' })).toBeEnabled()
  })
})
