import { describe, expect, it } from 'vitest'
import {
  agentRequestSchema,
  browserCloseTabRequestSchema,
  browserCreateTabRequestSchema,
  browserLiveStateSchema,
  browserNavigateRequestSchema,
  browserSetViewportRequestSchema,
  browserStopLoadingRequestSchema,
  builtinEmbeddingConnectionId,
  clipboardTextSchema,
  conversationQueueUserInputSchema,
  legacyEmbeddingConnectionId,
  runtimeSettingsInputSchema
} from './contracts'
import { projectCreateSchema, scheduleCreateSchema } from './assistant-contracts'
import { channelInboundTextSchema } from './channel-contracts'
import { runtimeNativeToolSchema } from './runtime-customization-contracts'
import { webSearchCapabilitySchema } from './capability-contracts'

describe('clipboard text contract', () => {
  it('accepts text and rejects non-text input', () => {
    expect(clipboardTextSchema.parse('Markdown response')).toBe(
      'Markdown response'
    )
    expect(clipboardTextSchema.parse('')).toBe('')
    expect(clipboardTextSchema.safeParse({ text: 'no' }).success).toBe(
      false
    )
  })
})

describe('browser control contracts', () => {
  const tabId = '4d7886c3-4c9c-4e84-bf65-1a4a841f5296'
  const workbarInstanceId = '0387bd61-3a12-40ce-98d7-ef5d14cc8251'
  const leaseToken = '7d201980-0ad4-4670-81d4-dc2bf79f03b2'

  it('requires authoritative toolbar metadata and accepts committed URLs up to 8192 characters', () => {
    const base = {
      conversationId: 'conversation',
      tabId,
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

  it('carries workbar ownership without the obsolete frame payload', () => {
    const state = {
      conversationId: 'conversation',
      tabId,
      workbarInstanceId,
      status: 'creating',
      sessionActive: false,
      isLoading: true,
      canGoBack: false,
      updatedAt: 1
    }
    expect(browserLiveStateSchema.parse(state)).toEqual(state)
    expect(browserLiveStateSchema.safeParse({
      ...state, workbarInstanceId: 'not-a-uuid'
    }).success).toBe(false)
    expect(browserLiveStateSchema.safeParse({
      ...state, frameDataUrl: 'data:image/jpeg;base64,obsolete'
    }).success).toBe(false)
  })

  it('keeps browser navigation and stop-loading requests narrow', () => {
    expect(
      browserNavigateRequestSchema.parse({
        conversationId: 'conversation',
        tabId,
        url: 'https://example.com/'
      })
    ).toEqual({
      conversationId: 'conversation',
      tabId,
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

  it('uses opaque tab IDs and validates complete viewport ownership leases', () => {
    expect(
      browserCreateTabRequestSchema.parse({
        conversationId: 'conversation',
        workbarInstanceId
      })
    ).toEqual({ conversationId: 'conversation', workbarInstanceId })
    expect(
      browserCloseTabRequestSchema.safeParse({
        conversationId: 'conversation',
        tabId
      }).success
    ).toBe(true)
    expect(
      browserCloseTabRequestSchema.safeParse({
        conversationId: 'conversation',
        tabId: 'predictable-tab-name'
      }).success
    ).toBe(false)
    expect(
      browserSetViewportRequestSchema.safeParse({
        conversationId: 'conversation',
        tabId,
        leaseToken,
        bounds: { x: 1, y: 2, width: 300, height: 400 }
      }).success
    ).toBe(true)
    expect(
      browserSetViewportRequestSchema.safeParse({ tabId, leaseToken }).success
    ).toBe(false)
    expect(
      browserLiveStateSchema.safeParse({
        conversationId: 'conversation',
        status: 'ready',
        sessionActive: true,
        isLoading: false,
        canGoBack: false,
        updatedAt: 1
      }).success
    ).toBe(false)
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
}

describe('unified execution contracts', () => {
  it('accepts mode-free requests without adding a default mode', () => {
    const request = { requestId: crypto.randomUUID(), conversationId: 'conversation', prompt: 'hello' }
    expect(agentRequestSchema.parse(request)).not.toHaveProperty('workMode')
    expect(conversationQueueUserInputSchema.parse({ conversationId: 'conversation', prompt: 'hello' })).not.toHaveProperty('workMode')
    expect(projectCreateSchema.parse({ name: 'Project', description: '', rootPath: '/workspace' })).not.toHaveProperty('defaultWorkMode')
    expect(scheduleCreateSchema.parse({ title: 'Task', prompt: 'hello', recurrence: 'once', nextRunAt: '2030-01-01T00:00:00Z' })).not.toHaveProperty('workMode')
    expect(channelInboundTextSchema.parse({ channel: 'wecom', eventId: 'event', senderId: 'sender',
      conversationId: 'conversation', conversationType: 'direct', text: 'hello' })).not.toHaveProperty('workMode')
    expect(() => agentRequestSchema.parse({ ...request, workMode: undefined })).toThrow()
  })

  it('describes registered tools without mode availability fields', () => {
    const native = { id: 'read', name: 'Read', description: 'Reads files', kind: 'read', source: 'runtime' }
    expect(runtimeNativeToolSchema.parse(native)).toEqual(native)
    expect(() => runtimeNativeToolSchema.parse({ ...native, ask: undefined, execute: undefined })).toThrow()
    const web = { provider: 'exa', enabled: true, tools: ['web_search', 'web_fetch'] }
    expect(webSearchCapabilitySchema.parse(web)).toEqual(web)
    expect(() => webSearchCapabilitySchema.parse({ ...web, availableIn: undefined })).toThrow()
  })

  it('accepts settings without a tool policy and rejects the removed setting', () => {
    expect(runtimeSettingsInputSchema.parse(baseInput)).not.toHaveProperty('toolApproval')
    expect(() => runtimeSettingsInputSchema.parse({ ...baseInput, toolApproval: undefined })).toThrow()
  })
})

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
