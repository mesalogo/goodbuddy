import { describe, expect, it } from 'vitest'
import type { ResolvedRuntimeSettings } from '../runtime-settings-store'
import { createAgentRuntime } from './create-runtime'

function settings(
  overrides: Partial<ResolvedRuntimeSettings> = {}
): ResolvedRuntimeSettings {
  return {
    provider: 'model',
    modelBaseUrl: 'http://127.0.0.1:11434/v1',
    modelName: 'qwen3',
    modelProtocol: 'openai-chat-completions',
    modelAuthentication: 'none',
    opencodeBaseUrl: '',
    opencodeEmbedded: false,
    opencodeBinaryPath: '',
    opencodeConfigPath: '',
    continueBinaryPath: '',
    continueConfigPath: '',
    continueMode: 'chat',
    runtimeSandboxMode: 'off',
    knowledgeEmbeddingEnabled: false,
    knowledgeEmbeddingBaseUrl: 'http://127.0.0.1:11434',
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
      detail: expect.stringContaining('OpenAI Chat Completions')
    })
    await runtime.dispose()
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
            apiKey: 'secret'
          }
        })
      )
    ).toThrow('Continue 不支持图像生成模型连接')
  })
})
