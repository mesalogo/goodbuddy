import { describe, expect, it } from 'vitest'
import type { RuntimeSettings } from '../../shared/contracts'
import { resolveRuntimeChoice } from '../../shared/runtime-selection-contracts'
import i18n from './i18n'
import { ignoredChoiceMessage, runtimeModelLabel } from './runtime-selection'

const imageId = '00000000-0000-4000-8000-000000000072'
const anthropicId = '00000000-0000-4000-8000-000000000073'
const openAiId = '00000000-0000-4000-8000-000000000074'

const settings = {
  provider: 'model',
  defaultModelProfileId: imageId,
  opencodeBaseUrl: '',
  opencodeModelSource: { kind: 'default' },
  continueModelSource: { kind: 'default' },
  deepseekHarnessModelSource: { kind: 'platform' },
  deepseekHarnessPlatformModel: { source: 'environment', name: '管理员预置模型', modelName: 'deepseek-chat' },
  modelProfiles: [
    { id: imageId, name: 'Image', modelName: 'image', protocol: 'openai-images-generations', authentication: 'none' },
    { id: anthropicId, name: 'Claude', modelName: 'claude', protocol: 'anthropic-messages', authentication: 'none' },
    {
      id: openAiId, name: 'Gateway', modelName: 'gateway', baseUrl: 'https://gateway.example/v1',
      protocol: 'openai-chat-completions', authentication: 'api-key', apiKeyConfigured: true
    }
  ]
} as unknown as RuntimeSettings

describe('renderer runtime labels', () => {
  it('resolves "follow recommended" to the first compatible connection per mode', () => {
    expect(resolveRuntimeChoice(settings, { project: { provider: 'opencode' } }).selection)
      .toEqual({ provider: 'opencode', profileId: anthropicId })
    expect(resolveRuntimeChoice(settings, { project: { provider: 'continue' } }).selection)
      .toEqual({ provider: 'continue', profileId: anthropicId })
    // An image-only global default is skipped for the direct model too.
    expect(resolveRuntimeChoice(settings).selection)
      .toEqual({ provider: 'model', profileId: anthropicId })
  })

  it('names the model DeepSeek Harness actually uses for its own configuration', async () => {
    await i18n.changeLanguage('zh-CN')
    const t = i18n.getFixedT('zh-CN', 'app')
    expect(runtimeModelLabel('deepseek-harness', { kind: 'runtime-config' }, settings, t))
      .toBe('自有配置 · deepseek-chat')
  })

  it('explains why a saved choice was not used', async () => {
    const t = i18n.getFixedT('en-US', 'app')
    const resolved = resolveRuntimeChoice(settings, {
      conversation: { model: { kind: 'profile', profileId: '00000000-0000-4000-8000-000000000099' } }
    })
    expect(ignoredChoiceMessage(resolved, settings, t))
      .toBe('The selected model connection was deleted. Using Claude instead.')
  })
})
