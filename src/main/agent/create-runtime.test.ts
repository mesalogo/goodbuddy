import { describe, expect, it, vi } from 'vitest'
import type { ResolvedRuntimeSettings } from '../runtime-settings-store'
import type { BrowserToolService } from '../browser/browser-model-tools'
import { defaultRuntimeCustomizationSettings } from '../../shared/contracts'
import {
  createAgentRuntime,
  createModelProfileRuntime
} from './create-runtime'
import { AgentRuntimeController } from './runtime-controller'

function createBrowserService(): BrowserToolService & {
  dispose: ReturnType<typeof vi.fn>
} {
  return {
    getOrigin: vi.fn(() => undefined),
    navigate: vi.fn(),
    snapshot: vi.fn(),
    click: vi.fn(),
    type: vi.fn(),
    select: vi.fn(),
    back: vi.fn(),
    screenshot: vi.fn(),
    releaseConversation: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined)
  }
}

function settings(
  overrides: Partial<ResolvedRuntimeSettings> = {}
): ResolvedRuntimeSettings {
  const defaultModelProfileId =
    '00000000-0000-4000-8000-000000000001'
  return {
    provider: 'model',
    modelBaseUrl: 'http://127.0.0.1:11434/v1',
    modelName: 'qwen3',
    modelProtocol: 'openai-chat-completions',
    modelAuthentication: 'none',
    imageGenerationQuality: 'auto',
    modelProfiles: [
      {
        id: defaultModelProfileId,
        name: '默认模型',
        baseUrl: 'http://127.0.0.1:11434/v1',
        modelName: 'qwen3',
        protocol: 'openai-chat-completions',
        authentication: 'none',
        imageGenerationQuality: 'auto'
      }
    ],
    defaultModelProfileId,
    opencodeBaseUrl: '',
    opencodeEmbedded: false,
    opencodeBinaryPath: '',
    opencodeConfigPath: '',
    continueBinaryPath: '',
    continueConfigPath: '',
    continueMode: 'chat',
    subagentSmartRoutingEnabled: false,
    knowledgeEmbeddingEnabled: false,
    knowledgeEmbeddingBaseUrl:
      'http://127.0.0.1:11434/v1/embeddings',
    knowledgeEmbeddingModel: 'nomic-embed-text',
    knowledgeRerankEnabled: false,
    knowledgeRerankEndpoint: 'https://api.cohere.com/v1/rerank',
    knowledgeRerankModel: 'rerank-v3.5',
    runtimeCustomization: defaultRuntimeCustomizationSettings,
    workspacePath: process.cwd(),
    toolApproval: 'always',
    ...overrides
  }
}

describe('createAgentRuntime model compatibility', () => {
  it('does not treat the default model profile as the platform DeepSeek source', () => {
    const defaultProfile = {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Default DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      modelName: 'deepseek-chat',
      protocol: 'openai-chat-completions' as const,
      authentication: 'api-key' as const,
      imageGenerationQuality: 'auto' as const,
      apiKey: 'default-deepseek-key'
    }

    expect(() =>
      createAgentRuntime(
        process.cwd(),
        settings({
          provider: 'deepseek-harness',
          modelBaseUrl: defaultProfile.baseUrl,
          modelName: defaultProfile.modelName,
          modelProtocol: defaultProfile.protocol,
          modelAuthentication: defaultProfile.authentication,
          apiKey: defaultProfile.apiKey,
          modelProfiles: [defaultProfile]
        }),
        { deepseekHarnessLauncher: vi.fn() }
      )
    ).toThrow(
      'DeepSeek Harness 需要使用 API Key 的安全 OpenAI 兼容 Chat Completions 模型连接'
    )
  })

  it('creates DeepSeek Harness with a compatible HTTPS gateway profile', async () => {
    const profile = {
      id: '00000000-0000-4000-8000-000000000006',
      name: 'OpenAI-compatible gateway',
      baseUrl: 'https://gateway.example/openai/v1',
      modelName: 'qwen-plus',
      protocol: 'openai-chat-completions' as const,
      authentication: 'api-key' as const,
      imageGenerationQuality: 'auto' as const,
      apiKey: 'gateway-key'
    }
    const runtime = createAgentRuntime(
      process.cwd(),
      settings({
        provider: 'deepseek-harness',
        modelProfiles: [profile],
        defaultModelProfileId: profile.id,
        deepseekHarnessModelProfile: profile
      }),
      { deepseekHarnessLauncher: vi.fn() }
    )

    expect(runtime.runtimeId).toBe('deepseek-harness')
    await runtime.dispose()
  })

  it('creates an available direct runtime for a no-auth model', async () => {
    const runtime = createAgentRuntime(process.cwd(), settings())

    await expect(runtime.getStatus()).resolves.toMatchObject({
      id: 'model',
      available: true,
      supportsToolExecution: true,
      detail: expect.stringContaining('OpenAI Chat Completions')
    })
    await runtime.dispose()
  })

  it('forwards the selected profile image capability to direct runtimes', async () => {
    const visionSettings = settings({
      supportsImageInput: true
    })
    visionSettings.modelProfiles = visionSettings.modelProfiles.map(
      (profile) => ({
        ...profile,
        supportsImageInput: true
      })
    )
    const fetcher = vi.fn(async () =>
      new Response(
        [
          `data: ${JSON.stringify({
            choices: [
              {
                delta: { content: 'OK' },
                finish_reason: 'stop'
              }
            ]
          })}`,
          '',
          'data: [DONE]',
          '',
          ''
        ].join('\n'),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        }
      )
    )
    vi.stubGlobal('fetch', fetcher)
    const runtime = createAgentRuntime(process.cwd(), visionSettings)

    try {
      const events = []
      for await (const event of runtime.run(
        {
          requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
          conversationId: 'wechat-conversation',
          prompt: '描述图片',
          images: [
            {
              name: '微信图片.png',
              mediaType: 'image/png',
              data: 'aW1hZ2U='
            }
          ]
        },
        new AbortController().signal
      )) {
        events.push(event)
      }

      expect(fetcher).toHaveBeenCalledOnce()
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'done' })
      )
    } finally {
      await runtime.dispose()
      vi.unstubAllGlobals()
    }
  })

  it('shares injected browser service without runtime-owned disposal', async () => {
    const browserService = createBrowserService()
    const first = createAgentRuntime(process.cwd(), settings(), {
      browserService
    })
    const second = createAgentRuntime(process.cwd(), settings(), {
      browserService
    })
    const controller = new AgentRuntimeController(first)

    await controller.releaseConversation('conversation-one')
    await controller.replace(second)
    await controller.releaseConversation('conversation-two')
    await controller.dispose()

    expect(browserService.releaseConversation).toHaveBeenNthCalledWith(
      1,
      'conversation-one'
    )
    expect(browserService.releaseConversation).toHaveBeenNthCalledWith(
      2,
      'conversation-two'
    )
    expect(browserService.dispose).not.toHaveBeenCalled()
  })

  it('does not expose the browser service to OpenCode runtimes', async () => {
    const browserService = createBrowserService()
    const runtime = createAgentRuntime(
      process.cwd(),
      settings({
        provider: 'opencode',
        opencodeBaseUrl: 'http://127.0.0.1:4096'
      }),
      { browserService }
    )

    await runtime.releaseConversation?.('opencode-conversation')
    await runtime.dispose()

    expect(browserService.releaseConversation).not.toHaveBeenCalled()
    expect(browserService.dispose).not.toHaveBeenCalled()
  })

  it(
    'treats a blank OpenCode Server as bundled local mode even for legacy false settings',
    async () => {
      const runtime = createAgentRuntime(
        process.cwd(),
        settings({
          provider: 'opencode',
          opencodeBaseUrl: '',
          opencodeEmbedded: false
        })
      )

      await expect(runtime.getStatus()).resolves.not.toMatchObject({
        detail: '未配置 OpenCode Server'
      })
      await runtime.dispose()
    },
    15_000
  )

  it.each([
    ['openai-chat-completions', 'none'],
    ['openai-responses', 'api-key']
  ] as const)(
    'accepts an OpenCode %s independent profile',
    async (protocol, authentication) => {
      const runtime = createAgentRuntime(
        process.cwd(),
        settings({
          provider: 'opencode',
          opencodeModelProfile: {
            id: '00000000-0000-4000-8000-000000000031',
            name: 'OpenAI profile',
            baseUrl: 'https://api.example/v1',
            modelName: 'model',
            protocol,
            authentication,
            imageGenerationQuality: 'auto',
            ...(authentication === 'api-key'
              ? { apiKey: 'secret' }
              : {})
          }
        })
      )

      expect(runtime.requiresToolApproval).toBe(false)
      await runtime.dispose()
    }
  )

  it('marks direct image runtimes and rejects them for Agent Runtimes', async () => {
    const imageSettings = settings({
      modelBaseUrl: 'https://bigtoken.ai/v1',
      modelName: 'gpt-image-2',
      modelProtocol: 'openai-images-generations',
      modelAuthentication: 'api-key',
      imageGenerationQuality: 'high',
      apiKey: 'secret',
      modelProfiles: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          name: '默认图像模型',
          baseUrl: 'https://bigtoken.ai/v1',
          modelName: 'gpt-image-2',
          protocol: 'openai-images-generations',
          authentication: 'api-key',
          imageGenerationQuality: 'high',
          apiKey: 'secret'
        }
      ]
    })
    const runtime = createAgentRuntime(process.cwd(), imageSettings)
    await expect(runtime.getStatus()).resolves.toMatchObject({
      capability: 'image-generation'
    })
    await runtime.dispose()

    expect(() =>
      createAgentRuntime(
        process.cwd(),
        settings({
          provider: 'continue',
          continueModelProfile: {
            id: '00000000-0000-4000-8000-000000000032',
            name: 'Image profile',
            baseUrl: 'https://bigtoken.ai/v1',
            modelName: 'gpt-image-2',
            protocol: 'openai-images-generations',
            authentication: 'api-key',
            imageGenerationQuality: 'high',
            apiKey: 'secret'
          }
        })
      )
    ).toThrow('Continue 独立模型连接仅支持')
    expect(() =>
      createAgentRuntime(
        process.cwd(),
        settings({
          provider: 'opencode',
          opencodeModelProfile: {
            id: '00000000-0000-4000-8000-000000000033',
            name: 'Image profile',
            baseUrl: 'https://api.openai.com/v1',
            modelName: 'gpt-image-2',
            protocol: 'openai-images-generations',
            authentication: 'api-key',
            imageGenerationQuality: 'auto',
            apiKey: 'secret'
          }
        })
      )
    ).toThrow('OpenCode 独立模型连接仅支持')
  })

  it('accepts a Continue Responses independent profile', async () => {
    const runtime = createAgentRuntime(
      process.cwd(),
      settings({
        provider: 'continue',
        continueModelProfile: {
          id: '00000000-0000-4000-8000-000000000035',
          name: 'Responses profile',
          baseUrl: 'https://api.example/v1',
          modelName: 'gpt-compatible',
          protocol: 'openai-responses',
          authentication: 'api-key',
          imageGenerationQuality: 'auto',
          apiKey: 'secret'
        }
      })
    )

    expect(runtime.requiresToolApproval).toBe(false)
    await runtime.dispose()
  })

  it('creates a testable runtime for an image model profile', async () => {
    const resolved = settings()
    const runtime = createModelProfileRuntime(
      process.cwd(),
      resolved,
      {
        id: '00000000-0000-4000-8000-000000000034',
        name: 'Image profile',
        baseUrl: 'https://bigtoken.ai/v1',
        modelName: 'gpt-image-2',
        protocol: 'openai-images-generations',
        authentication: 'api-key',
        imageGenerationQuality: 'high',
        apiKey: 'secret'
      }
    )

    await expect(runtime.getStatus()).resolves.toMatchObject({
      id: 'model',
      capability: 'image-generation',
      available: true
    })
    await runtime.dispose()
  })
})
