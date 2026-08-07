import type { ResolvedRuntimeSettings } from '../runtime-settings-store'
import { describe, expect, it } from 'vitest'
import {
  applyRuntimeSelection,
  getConfiguredRuntimeTarget
} from './runtime-selection'

const defaultProfileId = '00000000-0000-4000-8000-000000000001'
const secondProfileId = '00000000-0000-4000-8000-000000000002'
const responsesProfileId = '00000000-0000-4000-8000-000000000003'
const imageProfileId = '00000000-0000-4000-8000-000000000004'

function settings(
  overrides: Partial<ResolvedRuntimeSettings> = {}
): ResolvedRuntimeSettings {
  return {
    provider: 'auto',
    modelBaseUrl: 'https://default.example/v1',
    modelName: 'default-model',
    modelProtocol: 'anthropic-messages',
    modelAuthentication: 'api-key',
    imageGenerationQuality: 'auto',
    apiKey: 'default-key',
    modelProfiles: [
      {
        id: defaultProfileId,
        name: '默认模型',
        baseUrl: 'https://default.example/v1',
        modelName: 'default-model',
        protocol: 'anthropic-messages',
        authentication: 'api-key',
        imageGenerationQuality: 'auto',
        apiKey: 'default-key'
      },
      {
        id: secondProfileId,
        name: '第二模型',
        baseUrl: 'https://second.example/v1',
        modelName: 'second-model',
        protocol: 'openai-chat-completions',
        authentication: 'none',
        imageGenerationQuality: 'auto'
      },
      {
        id: responsesProfileId,
        name: 'Responses 模型',
        baseUrl: 'https://responses.example/v1',
        modelName: 'responses-model',
        protocol: 'openai-responses',
        authentication: 'api-key',
        imageGenerationQuality: 'auto',
        apiKey: 'responses-key'
      },
      {
        id: imageProfileId,
        name: '图像模型',
        baseUrl: 'https://images.example/v1',
        modelName: 'image-model',
        protocol: 'openai-images-generations',
        authentication: 'api-key',
        imageGenerationQuality: 'auto',
        apiKey: 'image-key'
      }
    ],
    defaultModelProfileId: defaultProfileId,
    opencodeBaseUrl: '',
    opencodeEmbedded: true,
    opencodeBinaryPath: '',
    opencodeConfigPath: '',
    continueBinaryPath: '',
    continueConfigPath: '',
    continueMode: 'chat',
    runtimeSandboxMode: 'auto',
    subagentSmartRoutingEnabled: false,
    knowledgeEmbeddingEnabled: false,
    knowledgeEmbeddingBaseUrl:
      'http://127.0.0.1:11434/v1/embeddings',
    knowledgeEmbeddingModel: 'embedding',
    workspacePath: process.cwd(),
    toolApproval: 'always',
    ...overrides
  }
}

describe('runtime selection', () => {
  it('selects an independent direct model profile without changing defaults', () => {
    const original = settings()
    const selected = applyRuntimeSelection(original, {
      provider: 'model',
      profileId: secondProfileId
    })

    expect(selected.target).toBe('model')
    expect(selected.settings).toMatchObject({
      provider: 'model',
      modelBaseUrl: 'https://second.example/v1',
      modelName: 'second-model',
      modelProtocol: 'openai-chat-completions',
      modelAuthentication: 'none',
      defaultModelProfileId: secondProfileId
    })
    expect(original.defaultModelProfileId).toBe(defaultProfileId)
  })

  it.each([
    ['opencode', defaultProfileId],
    ['opencode', secondProfileId],
    ['opencode', responsesProfileId],
    ['continue', defaultProfileId],
    ['continue', secondProfileId],
    ['continue', responsesProfileId]
  ] as const)(
    'selects %s with text profile %s',
    (provider, profileId) => {
      const selected = applyRuntimeSelection(settings(), {
        provider,
        profileId
      })
      expect(
        provider === 'opencode'
          ? selected.settings.opencodeModelProfile?.id
          : selected.settings.continueModelProfile?.id
      ).toBe(profileId)
    }
  )

  it('rejects deleted or incompatible profile selections', () => {
    expect(() =>
      applyRuntimeSelection(settings(), {
        provider: 'model',
        profileId: '00000000-0000-4000-8000-000000000099'
      })
    ).toThrow('不存在')
    expect(() =>
      applyRuntimeSelection(settings(), {
        provider: 'opencode',
        profileId: imageProfileId
      })
    ).toThrow('不支持图像生成协议')
    expect(() =>
      applyRuntimeSelection(
        settings({ opencodeBaseUrl: 'http://127.0.0.1:4096' }),
        {
          provider: 'opencode',
          profileId: defaultProfileId
        }
      )
    ).toThrow('自动启动')
  })

  it('routes legacy automatic settings through local OpenCode when the Server is blank', () => {
    expect(getConfiguredRuntimeTarget(settings())).toBe('opencode')
    expect(
      getConfiguredRuntimeTarget(
        settings({ opencodeEmbedded: false })
      )
    ).toBe('opencode')
    expect(
      applyRuntimeSelection(settings(), { provider: 'auto' }).settings
    ).toEqual(settings())
  })
})
