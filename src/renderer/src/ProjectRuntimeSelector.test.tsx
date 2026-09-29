import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultRuntimeSettings, type RuntimeSettings } from '../../shared/contracts'
import { ProjectRuntimeSelector } from './ProjectRuntimeSelector'
import i18n from './i18n'

afterEach(cleanup)
beforeEach(async () => { await i18n.changeLanguage('zh-CN') })

const firstId = '00000000-0000-4000-8000-000000000011'
const secondId = '00000000-0000-4000-8000-000000000012'
const settings = {
  ...defaultRuntimeSettings,
  provider: 'opencode',
  defaultModelProfileId: firstId,
  opencodeModelSource: { kind: 'profile', profileId: firstId },
  continueModelSource: { kind: 'platform' },
  modelProfiles: [
    { id: firstId, name: 'Model A', modelName: 'model-a', baseUrl: 'https://example.com/v1',
      protocol: 'openai-chat-completions', authentication: 'api-key', apiKeyConfigured: true },
    { id: secondId, name: 'Model B', modelName: 'model-b', baseUrl: 'https://example.com/v1',
      protocol: 'anthropic-messages', authentication: 'none' }
  ]
} as RuntimeSettings

describe('ProjectRuntimeSelector', () => {
  it('shows a concrete execution mode and follows that Runtime’s default model', () => {
    render(<ProjectRuntimeSelector label="Runtime" onChange={vi.fn()} runtimeSettings={settings}
      selection={{ provider: 'opencode' }} />)
    const provider = screen.getByLabelText('执行方式') as HTMLSelectElement
    expect(provider).toHaveValue('opencode')
    // No "follow global" execution mode: projects own it.
    expect(Array.from(provider.options).map((option) => option.value))
      .toEqual(['model', 'opencode', 'continue', 'deepseek-harness'])
    expect(screen.getByLabelText('模型')).toHaveValue('')
    expect(screen.getByRole('option', { name: '跟随 OpenCode 默认（Model A）' })).toBeInTheDocument()
    expect(screen.getByText('模型来自全局设置')).toBeInTheDocument()
  })

  it('switches mode and model and returns the model to the Runtime default', () => {
    const onChange = vi.fn()
    const view = render(<ProjectRuntimeSelector label="Runtime" onChange={onChange}
      runtimeSettings={settings} selection={{ provider: 'opencode' }} />)
    fireEvent.change(screen.getByLabelText('执行方式'), { target: { value: 'continue' } })
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'continue' })
    view.rerender(<ProjectRuntimeSelector label="Runtime" onChange={onChange}
      runtimeSettings={settings} selection={{ provider: 'continue' }} />)
    expect(screen.getByRole('option', { name: '跟随 Continue 默认（自有配置）' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: secondId } })
    expect(onChange).toHaveBeenLastCalledWith({
      provider: 'continue', model: { kind: 'profile', profileId: secondId }
    })
    view.rerender(<ProjectRuntimeSelector label="Runtime" onChange={onChange} runtimeSettings={settings}
      selection={{ provider: 'continue', model: { kind: 'profile', profileId: secondId } }} />)
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'continue' })
  })

  it('explains and offers to clear a deleted model', () => {
    const onChange = vi.fn()
    render(<ProjectRuntimeSelector label="Runtime" onChange={onChange} runtimeSettings={settings}
      selection={{ provider: 'opencode', model: { kind: 'profile', profileId: '00000000-0000-4000-8000-000000000099' } }} />)
    expect(screen.getByText('所选模型连接已删除，已回退到 Model A')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '改为跟随默认模型' }))
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'opencode' })
  })

  it('limits remote projects to OpenCode and Continue without own configuration', () => {
    render(<ProjectRuntimeSelector label="Runtime" onChange={vi.fn()} remote runtimeSettings={settings} />)
    const providers = Array.from((screen.getByLabelText('执行方式') as HTMLSelectElement).options)
      .map((option) => option.value)
    expect(providers).toEqual(['opencode', 'continue'])
    expect(screen.queryByRole('option', { name: /自有配置/u })).not.toBeInTheDocument()
  })
})
