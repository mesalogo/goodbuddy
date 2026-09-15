import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageCapabilityNotice } from './ImageCapabilityNotice'
import type { AgentRuntimeStatus } from '../../shared/contracts'

afterEach(cleanup)
const runtime: AgentRuntimeStatus = { id: 'model', label: 'Chat', available: true, capability: 'chat', supportsToolExecution: false, detail: 'Ready' }

describe('conversation image capability guidance', () => {
  it('explains the existing direct image workflow and links to configuration without selecting a model', () => {
    const onOpenModelSettings = vi.fn()
    const view = render(<ImageCapabilityNotice runtime={runtime} workMode="ask" hasCallableImageModels={false} onOpenModelSettings={onOpenModelSettings} />)
    expect(screen.getByRole('status')).toHaveTextContent('当前聊天模型无法自动调用图片工具，可使用已有直连图片工作流。')
    expect(screen.getByRole('status')).toHaveTextContent('在 Runtime 选择器中选择图片模型')
    fireEvent.click(screen.getByRole('button', { name: '前往图片模型设置' }))
    expect(onOpenModelSettings).toHaveBeenCalledOnce()
    view.rerender(<ImageCapabilityNotice runtime={{ ...runtime, supportsToolExecution: true }} workMode="ask" hasCallableImageModels onOpenModelSettings={onOpenModelSettings} />)
    expect(screen.getByRole('status')).toHaveTextContent('生成或编辑图片需要 Execute 模式')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it.each([
    undefined,
    { ...runtime, available: false },
    { ...runtime, capability: 'image-generation' as const },
    { ...runtime, supportsToolExecution: true },
  ])('does not claim missing tool capability for loading, unavailable, image, or tool-capable runtimes: %j', current => {
    const { container } = render(<ImageCapabilityNotice runtime={current} workMode="execute" hasCallableImageModels onOpenModelSettings={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})
