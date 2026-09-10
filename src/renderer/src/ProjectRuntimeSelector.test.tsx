import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultRuntimeSettings, type RuntimeSettings } from '../../shared/contracts'
import { ProjectRuntimeSelector } from './ProjectRuntimeSelector'
import i18n from './i18n'

afterEach(cleanup)

describe('ProjectRuntimeSelector rules', () => {
  it('allows fixed Runtime models and switching back to a profile-free reference', async () => {
    await i18n.changeLanguage('zh-CN')
    const profileId = '00000000-0000-4000-8000-000000000011'
    const settings = {
      ...defaultRuntimeSettings,
      defaultModelProfileId: profileId,
      modelProfiles: [{
        id: profileId, name: 'Model A', modelName: 'model-a',
        baseUrl: 'https://example.com/v1', protocol: 'openai-chat-completions',
        authentication: 'api-key', apiKeyConfigured: true
      }]
    } as RuntimeSettings
    const onChange = vi.fn()
    const props = {
      ariaLabel: 'Project Runtime', label: 'Runtime', onChange,
      runtimeSettings: settings
    }
    const view = render(<ProjectRuntimeSelector {...props} selection={{ provider: 'opencode' }} />)
    const select = screen.getByRole('combobox')
    for (const provider of ['opencode', 'continue', 'deepseek-harness'] as const) {
      expect(screen.getByRole('option', {
        name: `${provider === 'opencode' ? 'OpenCode' : provider === 'continue' ? 'Continue' : 'DeepSeek Harness'} · Model A`
      })).toHaveValue(`${provider}:${profileId}`)
      fireEvent.change(select, { target: { value: `${provider}:${profileId}` } })
      expect(onChange).toHaveBeenLastCalledWith({ provider, profileId })
    }
    view.rerender(<ProjectRuntimeSelector {...props} selection={{ provider: 'opencode', profileId }} />)
    expect(screen.getByText('通过 OpenCode 运行，固定使用 Model A。')).toBeInTheDocument()
    fireEvent.change(select, { target: { value: 'opencode:default' } })
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'opencode' })
    fireEvent.change(select, { target: { value: 'model:default' } })
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'model' })
  })
})
