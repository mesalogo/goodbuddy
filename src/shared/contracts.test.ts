import { describe, expect, it } from 'vitest'
import {
  agentRequestSchema,
  browserLiveStateSchema,
  browserNavigateRequestSchema,
  browserStopLoadingRequestSchema,
  builtinEmbeddingConnectionId,
  legacyEmbeddingConnectionId,
  runtimeSettingsInputSchema
} from './contracts'

describe('browser control contracts', () => {
  it('requires authoritative toolbar metadata and accepts committed URLs up to 8192 characters', () => {
    const base = {
      conversationId: 'conversation',
      status: 'ready' as const,
      sessionActive: true,
      isLoading: false,
      canGoBack: true,
      updatedAt: 1
    }
    expect(
      browserLiveStateSchema.safeParse({
        ...base,
        url: `https://example.com/${'a'.repeat(8_172)}`
      }).success
    ).toBe(true)
    expect(
      browserLiveStateSchema.safeParse({
        conversationId: 'conversation',
        status: 'ready',
        updatedAt: 1
      }).success
    ).toBe(false)
  })

  it('keeps browser navigation and stop-loading requests narrow', () => {
    expect(
      browserNavigateRequestSchema.parse({
        conversationId: 'conversation',
        url: 'https://example.com/'
      })
    ).toEqual({
      conversationId: 'conversation',
      url: 'https://example.com/'
    })
    expect(
      browserNavigateRequestSchema.safeParse({
        conversationId: 'conversation',
        url: 'https://example.com/',
        rawElectron: true
      }).success
    ).toBe(false)
    expect(
      browserStopLoadingRequestSchema.safeParse({
        conversationId: 'conversation'
      }).success
    ).toBe(true)
  })
})

const baseInput = {
  provider: 'model' as const,
  modelBaseUrl: 'https://bigtoken.ai',
  modelName: 'sonnet-5',
  modelProtocol: 'anthropic-messages' as const,
  modelAuthentication: 'api-key' as const,
  imageGenerationQuality: 'auto' as const,
  opencodeBaseUrl: '',
  opencodeEmbedded: true,
  opencodeBinaryPath: '',
  opencodeConfigPath: '',
  continueBinaryPath: '',
  continueConfigPath: '',
  continueMode: 'chat' as const,
  knowledgeEmbeddingEnabled: true,
  knowledgeEmbeddingBaseUrl: 'https://vectors.example/v1/embeddings',
  knowledgeEmbeddingModel: 'embed-large',
  knowledgeRerankEnabled: false,
  knowledgeRerankEndpoint: 'https://rerank.example/v1/rerank',
  knowledgeRerankModel: 'rerank-v3.5',
  workspacePath: 'workspace',
  apiKey: { action: 'keep' as const },
  deepseekHarnessModelSource: { kind: 'platform' as const },
  toolApproval: 'always' as const
}

describe('embedding connection settings input', () => {
  it('accepts additive builtin and user connection updates', () => {
    expect(
      runtimeSettingsInputSchema.safeParse({
        ...baseInput,
        embeddingConnections: [
          {
            id: builtinEmbeddingConnectionId,
            name: 'GoodBuddy 内置向量模型',
            kind: 'builtin'
          },
          {
            id: legacyEmbeddingConnectionId,
            name: '自定义向量模型',
            kind: 'openai-compatible',
            baseUrl: 'https://vectors.example/v1/embeddings',
            modelName: 'embed-large',
            authentication: 'api-key',
            apiKey: { action: 'keep' }
          }
        ],
        activeEmbeddingConnectionId: legacyEmbeddingConnectionId
      }).success
    ).toBe(true)
  })

  it('rejects missing builtin, dangling active IDs, and keys on no-auth connections', () => {
    const connection = {
      id: legacyEmbeddingConnectionId,
      name: '自定义向量模型',
      kind: 'openai-compatible' as const,
      baseUrl: 'https://vectors.example/v1/embeddings',
      modelName: 'embed-large',
      authentication: 'none' as const,
      apiKey: { action: 'replace' as const, value: 'secret' }
    }
    expect(
      runtimeSettingsInputSchema.safeParse({
        ...baseInput,
        embeddingConnections: [connection],
        activeEmbeddingConnectionId: crypto.randomUUID()
      }).success
    ).toBe(false)
  })

  it('keeps embedding configuration and vectors outside Agent Runtime requests', () => {
    const request = {
      requestId: crypto.randomUUID(),
      conversationId: 'conversation',
      prompt: 'hello',
      knowledgeLibraryIds: [],
      knowledgeRetrievalMode: 'auto' as const
    }
    expect(agentRequestSchema.safeParse(request).success).toBe(true)
    for (const forbidden of [
      { embeddingApiKey: 'secret' },
      { embeddingConfiguration: { endpoint: 'https://vectors.example' } },
      { embeddingVectors: [[0.1, 0.2]] }
    ]) {
      expect(
        agentRequestSchema.safeParse({ ...request, ...forbidden }).success
      ).toBe(false)
    }
  })
})
