import type { ResolvedRuntimeSettings } from '../runtime-settings-store'
import { describe, expect, it } from 'vitest'
import {
  applyRuntimeSelection,
  getConfiguredRuntimeTarget,
  resolveConfiguredAgentRuntimeSelection
} from './runtime-selection'

const defaultProfileId = '00000000-0000-4000-8000-000000000001'
const secondProfileId = '00000000-0000-4000-8000-000000000002'
const responsesProfileId = '00000000-0000-4000-8000-000000000003'
const imageProfileId = '00000000-0000-4000-8000-000000000004'
const harnessProfileId = '00000000-0000-4000-8000-000000000005'

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
        supportsImageInput: true,
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
      },
      {
        id: harnessProfileId,
        name: 'OpenAI-compatible gateway',
        baseUrl: 'https://gateway.example/openai/v1',
        modelName: 'qwen-plus',
        protocol: 'openai-chat-completions',
        authentication: 'api-key',
        imageGenerationQuality: 'auto',
        apiKey: 'deepseek-key'
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
    knowledgeRerankEnabled: false,
    knowledgeRerankEndpoint: 'https://api.cohere.com/v1/rerank',
    knowledgeRerankModel: 'rerank-v3.5',
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
      supportsImageInput: true,
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

  it('selects DeepSeek Harness with a compatible gateway profile', () => {
    const selected = applyRuntimeSelection(settings(), {
      provider: 'deepseek-harness',
      profileId: harnessProfileId
    })
    expect(selected.target).toBe('deepseek-harness')
    expect(selected.settings).toMatchObject({
      provider: 'deepseek-harness',
      deepseekHarnessModelProfile: { id: harnessProfileId }
    })
    expect(() =>
      applyRuntimeSelection(settings(), {
        provider: 'deepseek-harness',
        profileId: secondProfileId
      })
    ).toThrow('API Key')
  })

  it('keeps the controlled platform Harness profile when selected without a profile ID', () => {
    const base = settings()
    const platformProfile = {
      ...base.modelProfiles[4]!,
      id: 'goodbuddy-platform-harness',
      name: '管理员预置模型',
      modelName: 'qwen-plus'
    }
    const selected = applyRuntimeSelection(
      settings({ deepseekHarnessModelProfile: platformProfile }),
      { provider: 'deepseek-harness' }
    )

    expect(selected.settings).toMatchObject({
      provider: 'deepseek-harness',
      deepseekHarnessModelProfile: {
        id: 'goodbuddy-platform-harness',
        modelName: 'qwen-plus'
      }
    })
  })

  it('resolves Agent Runtime backends from the global Runtime configuration', () => {
    const base = settings()
    const configured = settings({
      opencodeModelProfile: base.modelProfiles[1],
      continueModelProfile: base.modelProfiles[2],
      deepseekHarnessModelProfile: base.modelProfiles[4]
    })

    expect(
      resolveConfiguredAgentRuntimeSelection(configured, {
        provider: 'deepseek-harness'
      })
    ).toEqual({
      provider: 'deepseek-harness',
      profileId: harnessProfileId
    })
    expect(
      resolveConfiguredAgentRuntimeSelection(configured, {
        provider: 'opencode',
        profileId: defaultProfileId
      })
    ).toEqual({
      provider: 'opencode',
      profileId: secondProfileId
    })
    expect(
      resolveConfiguredAgentRuntimeSelection(configured, {
        provider: 'continue'
      })
    ).toEqual({
      provider: 'continue',
      profileId: responsesProfileId
    })
    expect(
      resolveConfiguredAgentRuntimeSelection(configured, {
        provider: 'model',
        profileId: defaultProfileId
      })
    ).toEqual({
      provider: 'model',
      profileId: defaultProfileId
    })
  })

  it('keeps the controlled platform Harness source profile-free across configured selection repair', () => {
    const base = settings()
    const configured = settings({
      deepseekHarnessModelProfile: {
        ...base.modelProfiles[4]!,
        id: 'goodbuddy-platform-harness',
        name: '管理员预置模型'
      }
    })

    expect(
      resolveConfiguredAgentRuntimeSelection(configured, {
        provider: 'deepseek-harness'
      })
    ).toEqual({ provider: 'deepseek-harness' })
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
