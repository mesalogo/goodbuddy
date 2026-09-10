import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultRuntimeSettings, type RuntimeSettings } from '../../shared/contracts'
import { ProjectRuntimeSelector } from './ProjectRuntimeSelector'
import i18n from './i18n'

afterEach(cleanup)

describe('ProjectRuntimeSelector saved model references', () => {
  it.each(['zh-CN', 'en-US'])('describes fixed selections accurately in %s without restoring duplicate menus', async (language) => {
    await i18n.changeLanguage(language)
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
    for (const provider of ['opencode', 'continue', 'deepseek-harness'] as const) {
      const runtime = provider === 'opencode' ? 'OpenCode'
        : provider === 'continue' ? 'Continue' : 'DeepSeek Harness'
      const props = {
        ariaLabel: 'Project Runtime', label: 'Runtime', onChange,
        runtimeSettings: settings
      }
      const view = render(<ProjectRuntimeSelector {...props} selection={{ provider, profileId }} />)
      const select = screen.getByRole('combobox')
      expect(select).toHaveValue(`${provider}:${profileId}`)
      expect(screen.getByText(language === 'zh-CN'
        ? `通过 ${runtime} 运行，固定使用 Model A。`
        : `Run through ${runtime} with the fixed model Model A.`)).toBeInTheDocument()
      expect(screen.getAllByRole('option').filter((option) =>
        (option as HTMLOptionElement).value.endsWith(`:${profileId}`))).toHaveLength(2)

      fireEvent.change(select, { target: { value: `${provider}:default` } })
      expect(onChange).toHaveBeenLastCalledWith({ provider })
      view.rerender(<ProjectRuntimeSelector {...props} selection={{ provider }} />)
      expect(select).toHaveValue(`${provider}:default`)
      expect(screen.queryByText(language === 'zh-CN'
        ? `通过 ${runtime} 运行，固定使用 Model A。`
        : `Run through ${runtime} with the fixed model Model A.`)).not.toBeInTheDocument()
      expect(screen.getAllByRole('option').filter((option) =>
        (option as HTMLOptionElement).value.endsWith(`:${profileId}`))).toHaveLength(1)
      view.unmount()
    }
  })
})
