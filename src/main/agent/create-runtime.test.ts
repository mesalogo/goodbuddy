import { describe, expect, it, vi } from 'vitest'
import type { ResolvedRuntimeSettings } from '../runtime-settings-store'
import type { BrowserToolService } from '../browser/browser-model-tools'
import { createAgentRuntime } from './create-runtime'
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
  return {
    provider: 'model',
    modelBaseUrl: 'http://127.0.0.1:11434/v1',
    modelName: 'qwen3',
    modelProtocol: 'openai-chat-completions',
    modelAuthentication: 'none',
    imageGenerationQuality: 'auto',
    opencodeBaseUrl: '',
    opencodeEmbedded: false,
    opencodeBinaryPath: '',
    opencodeConfigPath: '',
    continueBinaryPath: '',
    continueConfigPath: '',
    continueMode: 'chat',
    runtimeSandboxMode: 'off',
    subagentSmartRoutingEnabled: false,
    knowledgeEmbeddingEnabled: false,
    knowledgeEmbeddingBaseUrl:
      'http://127.0.0.1:11434/v1/embeddings',
    knowledgeEmbeddingModel: 'nomic-embed-text',
    workspacePath: process.cwd(),
    toolApproval: 'always',
    ...overrides
  }
}

describe('createAgentRuntime model compatibility', () => {
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

  it('keeps OpenCode independent profiles Anthropic API-key only', () => {
    expect(() =>
      createAgentRuntime(
        process.cwd(),
        settings({
          provider: 'opencode',
          opencodeModelProfile: {
            id: '00000000-0000-4000-8000-000000000031',
            name: 'OpenAI profile',
            baseUrl: 'https://api.example/v1',
            modelName: 'model',
            protocol: 'openai-chat-completions',
            authentication: 'api-key',
            imageGenerationQuality: 'auto',
            apiKey: 'secret'
          }
        })
      )
    ).toThrow('OpenCode 独立模型连接仅支持')
  })

  it('marks direct image runtimes and rejects them for Continue', async () => {
    const imageSettings = settings({
      modelBaseUrl: 'https://bigtoken.ai/v1',
      modelName: 'gpt-image-2',
      modelProtocol: 'openai-images-generations',
      modelAuthentication: 'api-key',
      imageGenerationQuality: 'high',
      apiKey: 'secret'
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
          provider: 'continue',
          continueModelProfile: {
            id: '00000000-0000-4000-8000-000000000033',
            name: 'Responses profile',
            baseUrl: 'https://api.openai.com/v1',
            modelName: 'gpt-5',
            protocol: 'openai-responses',
            authentication: 'api-key',
            imageGenerationQuality: 'auto',
            apiKey: 'secret'
          }
        })
      )
    ).toThrow('Continue 独立模型连接仅支持')
  })
})
