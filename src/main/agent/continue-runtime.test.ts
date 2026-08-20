import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeEvent } from './runtime'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ContinueHostRunError,
  type ContinueHostAdapterOptions
} from './continue-host-adapter'
import type { KnowledgeMcpGateway } from './knowledge-mcp-gateway'

const mocks = vi.hoisted(() => ({
  detectRuntimeBinary: vi.fn(),
  runHost: vi.fn(),
  respondHostQuestion: vi.fn(),
  disposeHost: vi.fn(),
  prepareHost: vi.fn()
}))

vi.mock('./runtime-discovery', () => ({
  detectRuntimeBinary: mocks.detectRuntimeBinary
}))

import {
  buildContinuePrompt,
  ContinueAgentRuntime
} from './continue-runtime'

function createRuntime(): ContinueAgentRuntime {
  return new ContinueAgentRuntime({
    binaryPath: '',
    configPath: 'C:\\safe config\\continue.yaml',
    defaultWorkspace: process.cwd(),
    hostCacheRoot: 'C:\\safe\\continue-host',
    createHostAdapter: () => ({
      getPreparedHost: mocks.prepareHost,
      run: mocks.runHost,
      respondToQuestion: mocks.respondHostQuestion,
      dispose: mocks.disposeHost
    })
  })
}

async function collectEvents(
  runtime: ContinueAgentRuntime,
  workMode?: 'ask' | 'execute'
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = []
  for await (const event of runtime.run(
    {
      requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
      conversationId: 'conversation-1',
      prompt: 'test',
      workMode
    },
    new AbortController().signal
  )) {
    events.push(event)
  }
  return events
}

describe('ContinueAgentRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.detectRuntimeBinary.mockResolvedValue({
      available: true,
      path: 'C:\\canonical\\cn.cmd',
      version: '1.5.47',
      detail: 'Continue CLI 1.5.47 已就绪'
    })
    mocks.prepareHost.mockResolvedValue({
      entryPath: 'C:\\safe\\continue-host\\dist\\cn.js',
      version: '1.5.47'
    })
    mocks.runHost.mockResolvedValue({
      text: 'Continue response'
    })
    mocks.respondHostQuestion.mockResolvedValue(undefined)
    mocks.disposeHost.mockResolvedValue(undefined)
  })

  it('does not launch the CLI for an already-cancelled request', async () => {
    const runtime = createRuntime()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    const stream = runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'test',
        workMode: 'execute'
      },
      controller.signal
    )

    await expect(stream.next()).rejects.toThrow('cancelled')
    expect(mocks.detectRuntimeBinary).not.toHaveBeenCalled()
    expect(mocks.runHost).not.toHaveBeenCalled()
  })

  it('awaits host process cleanup during Runtime disposal', async () => {
    let releaseDispose!: () => void
    mocks.disposeHost.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseDispose = resolve
        })
    )
    const runtime = createRuntime()
    await collectEvents(runtime)
    let disposed = false

    const disposal = runtime.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)

    releaseDispose()
    await disposal
    expect(disposed).toBe(true)
  })

  it('uses the resolved binary through the Continue host adapter', async () => {
    const runtime = createRuntime()

    const events = await collectEvents(runtime)

    expect(mocks.detectRuntimeBinary).toHaveBeenCalledWith({
      binaryPath: '',
      bundledPath: undefined,
      bundledValidation: 'canonical-file',
      binaryNames: ['cn'],
      label: 'Continue CLI'
    })
    expect(mocks.runHost).toHaveBeenCalledWith(
      'test',
      expect.any(AbortSignal),
      expect.any(Function),
      expect.objectContaining({
        onEvent: expect.any(Function)
      })
    )
    expect(events).toContainEqual({
      requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
      type: 'text',
      delta: 'Continue response'
    })
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'model-usage' })
    )
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('does not advertise host-inaccessible Skills or statically undiscoverable Tools', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'goodbuddy-continue-native-snapshot-')
    )
    const workspace = join(root, 'workspace')
    const skillDirectory = join(
      workspace,
      '.continue',
      'skills',
      'native-skill'
    )
    const configPath = join(root, 'continue.json')
    try {
      await mkdir(skillDirectory, { recursive: true })
      await writeFile(
        join(skillDirectory, 'SKILL.md'),
        [
          '---',
          'name: Native Skill',
          'description: Not reachable by the isolated Continue host',
          '---'
        ].join('\n'),
        'utf8'
      )
      await writeFile(configPath, '{}', 'utf8')
      const runtime = new ContinueAgentRuntime({
        binaryPath: '',
        configPath,
        defaultWorkspace: workspace,
        hostCacheRoot: join(root, 'host-cache')
      })

      await expect(runtime.getNativeSnapshot()).resolves.toMatchObject({
        provider: 'continue',
        available: true,
        inventoryStatus: 'available',
        skills: [],
        tools: [],
        toolsSupported: false
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('forwards images to the Continue host when configuration allows them', async () => {
    const runtime = createRuntime()
    for await (const _event of runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'describe',
        images: [
          {
            name: 'screenshot.png',
            mediaType: 'image/png',
            data: 'aW1hZ2U='
          }
        ]
      },
      new AbortController().signal
    )) {
      void _event
    }

    expect(mocks.runHost).toHaveBeenCalledWith(
      'describe',
      expect.any(AbortSignal),
      expect.any(Function),
      expect.objectContaining({
        images: [
          {
            name: 'screenshot.png',
            mediaType: 'image/png',
            data: 'aW1hZ2U='
          }
        ]
      })
    )
  })

  it('rejects images when the explicit model connection disables image input', async () => {
    const runtime = new ContinueAgentRuntime({
      binaryPath: '',
      configPath: '',
      defaultWorkspace: process.cwd(),
      hostCacheRoot: 'C:\\safe\\continue-host',
      modelProfile: {
        id: '00000000-0000-4000-8000-000000000001',
        name: '文本模型',
        baseUrl: 'https://model.example',
        modelName: 'text-model',
        protocol: 'anthropic-messages',
        authentication: 'none',
        supportsImageInput: false
      },
      createHostAdapter: () => ({
        getPreparedHost: mocks.prepareHost,
        run: mocks.runHost,
        dispose: mocks.disposeHost
      })
    })
    const stream = runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'describe',
        images: [
          {
            name: 'screenshot.png',
            mediaType: 'image/png',
            data: 'aW1hZ2U='
          }
        ]
      },
      new AbortController().signal
    )

    await expect(stream.next()).rejects.toThrow(
      '当前模型连接未启用图像输入'
    )
    expect(mocks.detectRuntimeBinary).not.toHaveBeenCalled()
  })

  it('emits one request-scoped host usage event at the end', async () => {
    mocks.runHost.mockResolvedValue({
      text: 'Continue response',
      usage: {
        provider: 'openai',
        model: 'qwen3',
        inputTokens: 31,
        outputTokens: 9,
        cacheReadTokens: 13,
        cacheWriteTokens: 4
      }
    })

    const events = await collectEvents(createRuntime(), 'execute')

    expect(events.filter((event) => event.type === 'model-usage')).toEqual([
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        type: 'model-usage',
        callId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        runtime: 'continue',
        provider: 'openai',
        model: 'qwen3',
        inputTokens: 31,
        outputTokens: 9,
        cacheReadTokens: 13,
        cacheWriteTokens: 4
      }
    ])
    expect(events.at(-2)).toMatchObject({ type: 'model-usage' })
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('does not require whole-run approval', () => {
    const runtime = createRuntime()
    expect(runtime.requiresToolApproval).toBe(false)
  })

  it('passes scoped MCP configuration for Ask and denies every other Ask tool', async () => {
    const runtime = new ContinueAgentRuntime({
      binaryPath: '',
      configPath: 'C:\\safe config\\continue.yaml',
      defaultWorkspace: process.cwd(),
      hostCacheRoot: 'C:\\safe\\continue-host',
      knowledgeGateway: {
        getEndpoint: () => 'http://127.0.0.1:4567/mcp'
      } as unknown as KnowledgeMcpGateway,
      createHostAdapter: () => ({
        getPreparedHost: mocks.prepareHost,
        run: mocks.runHost,
        dispose: mocks.disposeHost
      })
    })
    for await (const _event of runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'search',
        workMode: 'ask',
        knowledgeCapabilityToken: 'main-only-token'
      },
      new AbortController().signal
    )) {
      void _event
    }

    expect(mocks.runHost).toHaveBeenCalledWith(
      'search',
      expect.any(AbortSignal),
      expect.any(Function),
      {
        workMode: 'ask',
        knowledgeCapability: {
          endpoint: 'http://127.0.0.1:4567/mcp',
          token: 'main-only-token'
        },
        onEvent: expect.any(Function)
      }
    )
    const authorize = mocks.runHost.mock.calls[0]?.[2]
    await expect(
      authorize?.({ toolName: 'knowledge_list' })
    ).resolves.toBe('once')
    await expect(
      authorize?.({ toolName: 'knowledge_search' })
    ).resolves.toBe('once')
    await expect(
      authorize?.({ toolName: 'note_search' })
    ).resolves.toBe('once')
    await expect(
      authorize?.({ toolName: 'note_list' })
    ).resolves.toBe('once')
    await expect(
      authorize?.({ toolName: 'note_get' })
    ).resolves.toBe('once')
    await expect(authorize?.({ toolName: 'Bash' })).resolves.toBe('deny')
  })

  it('shares assigned custom MCP with Continue Agent only in Execute through a scoped loopback token', async () => {
    const gateway = {
      getEndpoint: vi.fn(() => 'http://127.0.0.1:4567/mcp'),
      grantCustomMcp: vi.fn(() => 'custom-capability'),
      prepareCustomMcpTools: vi.fn(async () => [
        {
          name: 'mcp_12345678_abcdef01_private_tool',
          inputSchema: { type: 'object' }
        }
      ]),
      revoke: vi.fn()
    } as unknown as KnowledgeMcpGateway
    const runtime = new ContinueAgentRuntime({
      binaryPath: '',
      configPath: 'C:\\safe config\\continue.yaml',
      defaultWorkspace: process.cwd(),
      hostCacheRoot: 'C:\\safe\\continue-host',
      knowledgeGateway: gateway,
      mcpServers: [
        {
          id: '00000000-0000-4000-8000-000000000094',
          name: 'Private MCP',
          description: '',
          enabled: true,
          allowDynamicTools: false,
          assignments: ['continue'],
          secretConfigured: true,
          secret: 'must-stay-in-main',
          transport: 'http',
          url: 'https://private.example/mcp'
        }
      ],
      createHostAdapter: () => ({
        getPreparedHost: mocks.prepareHost,
        run: mocks.runHost,
        dispose: mocks.disposeHost
      })
    })

    await collectEvents(runtime, 'execute')

    expect(gateway.grantCustomMcp).toHaveBeenCalledWith(
      '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
      expect.any(Array),
      expect.any(AbortSignal)
    )
    expect(mocks.runHost).toHaveBeenCalledWith(
      'test',
      expect.any(AbortSignal),
      expect.any(Function),
      {
        workMode: 'execute',
        customMcpCapability: {
          endpoint: 'http://127.0.0.1:4567/mcp',
          token: 'custom-capability'
        },
        onEvent: expect.any(Function)
      }
    )
    expect(JSON.stringify(mocks.runHost.mock.calls)).not.toContain(
      'must-stay-in-main'
    )
    expect(JSON.stringify(mocks.runHost.mock.calls)).not.toContain(
      'private.example'
    )
    expect(gateway.revoke).toHaveBeenCalledWith('custom-capability')

    vi.clearAllMocks()
    mocks.detectRuntimeBinary.mockResolvedValue({
      available: true,
      path: 'C:\\canonical\\cn.cmd',
      version: '1.5.47',
      detail: 'Continue CLI 1.5.47 已就绪'
    })
    mocks.runHost.mockResolvedValue({ text: 'Continue response' })
    await collectEvents(runtime, 'ask')
    expect(gateway.grantCustomMcp).not.toHaveBeenCalled()
  })

  it('adds assigned Skill instructions to the Continue prompt', async () => {
    let hostOptions: ContinueHostAdapterOptions | undefined
    const runtime = new ContinueAgentRuntime({
      binaryPath: '',
      configPath: 'C:\\safe config\\continue.yaml',
      defaultWorkspace: process.cwd(),
      hostCacheRoot: 'C:\\safe\\continue-host',
      skillInstructions: '# 周报助手',
      skillPackages: [
        {
          id: 'weekly-report',
          directory: 'C:\\safe\\skills\\weekly-report'
        }
      ],
      createHostAdapter: (options) => {
        hostOptions = options
        return {
          getPreparedHost: mocks.prepareHost,
          run: mocks.runHost,
          dispose: mocks.disposeHost
        }
      }
    })

    await collectEvents(runtime)

    const prompt = String(mocks.runHost.mock.calls[0]?.[0])
    expect(prompt).toContain('SYSTEM CAPABILITY INSTRUCTIONS')
    expect(prompt).toContain('# 周报助手')
    expect(prompt).toContain('test')
    expect(hostOptions?.skillPackages).toEqual([
      {
        id: 'weekly-report',
        directory: 'C:\\safe\\skills\\weekly-report'
      }
    ])
  })

  it('keeps a full bundled Skill payload on every platform', async () => {
    const runtime = new ContinueAgentRuntime({
      binaryPath: '',
      configPath: 'C:\\safe config\\continue.yaml',
      defaultWorkspace: process.cwd(),
      hostCacheRoot: 'C:\\safe\\continue-host',
      skillInstructions: `# Skills\n${'技'.repeat(30_000)}`.slice(0, 30_000),
      createHostAdapter: () => ({
        getPreparedHost: mocks.prepareHost,
        run: mocks.runHost,
        dispose: mocks.disposeHost
      })
    })

    await collectEvents(runtime)

    const prompt = String(mocks.runHost.mock.calls[0]?.[0])
    expect(prompt).toContain('SYSTEM CAPABILITY INSTRUCTIONS')
    expect(prompt.length).toBeGreaterThan(24_000)
  })

  it('reports oversized Skill payloads instead of dropping them silently', async () => {
    const runtime = new ContinueAgentRuntime({
      binaryPath: '',
      configPath: 'C:\\safe config\\continue.yaml',
      defaultWorkspace: process.cwd(),
      hostCacheRoot: 'C:\\safe\\continue-host',
      skillInstructions: '巨'.repeat(130_000),
      createHostAdapter: () => ({
        getPreparedHost: mocks.prepareHost,
        run: mocks.runHost,
        dispose: mocks.disposeHost
      })
    })

    await expect(collectEvents(runtime)).rejects.toThrow('超过 Continue')
    expect(mocks.runHost).not.toHaveBeenCalled()
  })

  it('blocks anonymous platform fallback without an explicit model configuration', async () => {
    const runtime = new ContinueAgentRuntime({
      binaryPath: '',
      configPath: '',
      defaultWorkspace: process.cwd(),
      hostCacheRoot: 'C:\\safe\\continue-host',
      createHostAdapter: () => ({
        getPreparedHost: mocks.prepareHost,
        run: mocks.runHost,
        dispose: mocks.disposeHost
      })
    })

    await expect(runtime.getStatus()).resolves.toMatchObject({
      available: false,
      detail: expect.stringContaining('尚未配置模型连接')
    })
    const stream = runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'test',
        workMode: 'execute'
      },
      new AbortController().signal
    )
    await expect(stream.next()).rejects.toThrow('尚未配置模型连接')
    expect(mocks.detectRuntimeBinary).not.toHaveBeenCalled()
    expect(mocks.prepareHost).not.toHaveBeenCalled()
    expect(mocks.runHost).not.toHaveBeenCalled()
  })

  it('places the current request before untrusted conversation history', async () => {
    const runtime = createRuntime()
    for await (const _event of runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'current request',
        history: [
          { role: 'user', content: 'previous request' },
          { role: 'assistant', content: 'previous response' }
        ]
      },
      new AbortController().signal
    )) {
      expect(_event).toBeDefined()
    }

    const prompt = String(mocks.runHost.mock.calls[0]?.[0])
    expect(prompt.indexOf('current request')).toBeLessThan(
      prompt.indexOf('previous response')
    )
    expect(prompt).toContain('Answer the CURRENT USER REQUEST now.')
    expect(prompt).not.toContain('\n')
  })

  it('ignores the synthetic greeting when there is no prior user turn', async () => {
    const runtime = createRuntime()
    for await (const event of runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'current request',
        history: [{ role: 'assistant', content: 'synthetic greeting' }]
      },
      new AbortController().signal
    )) {
      expect(event).toBeDefined()
    }

    expect(mocks.runHost.mock.calls[0]?.[0]).toBe('current request')
  })

  it('uses a verified persisted summary and retains recent history', async () => {
    const history = [
      { role: 'user' as const, content: 'old secret turn' },
      { role: 'assistant' as const, content: 'old answer' },
      { role: 'user' as const, content: 'recent question' },
      { role: 'assistant' as const, content: 'recent answer' }
    ]
    const runtime = createRuntime()
    for await (const _event of runtime.run(
      {
        requestId: randomUUID(),
        conversationId: 'summary-conversation',
        prompt: 'continue',
        history,
        contextCompressionState: {
          coveredHistoryDigest: createHash('sha256')
            .update(JSON.stringify(history.slice(0, 2)))
            .digest('hex'),
          coveredMessageCount: 2,
          summary: 'trusted persisted facts'
        }
      },
      new AbortController().signal
    )) {
      void _event
    }

    const prompt = String(mocks.runHost.mock.calls[0]?.[0])
    expect(prompt).toContain('UNTRUSTED CONVERSATION SUMMARY')
    expect(prompt).toContain('trusted persisted facts')
    expect(prompt).toContain('recent question')
    expect(prompt).not.toContain('old secret turn')
  })

  it('keeps a persisted summary when its covered prefix rolls out of the bounded history window', () => {
    const history = Array.from({ length: 500 }, (_, index) => ({
      role:
        index % 2 === 0
          ? ('user' as const)
          : ('assistant' as const),
      content: `recent message ${index}`
    }))
    const prompt = buildContinuePrompt({
      requestId: randomUUID(),
      conversationId: 'evicted-summary-conversation',
      prompt: 'continue',
      history,
      historyMessageIds: history.map(() => randomUUID()),
      contextCompressionState: {
        coveredHistoryDigest: createHash('sha256')
          .update(
            JSON.stringify([
              { role: 'user', content: 'evicted question' },
              { role: 'assistant', content: 'evicted answer' }
            ])
          )
          .digest('hex'),
        coveredMessageCount: 2,
        coveredFromMessageId: randomUUID(),
        coveredThroughMessageId: randomUUID(),
        summary: 'persisted evicted facts'
      }
    })

    expect(prompt).toContain('persisted evicted facts')
    expect(prompt).toContain('recent message 499')
    expect(prompt).not.toContain('evicted question')
  })

  it('keeps a persisted summary when filtered messages shorten the bounded history window', () => {
    const history = Array.from({ length: 499 }, (_, index) => ({
      role:
        index % 2 === 0
          ? ('user' as const)
          : ('assistant' as const),
      content: `filtered recent message ${index}`
    }))
    const prompt = buildContinuePrompt({
      requestId: randomUUID(),
      conversationId: 'filtered-evicted-summary-conversation',
      prompt: 'continue',
      history,
      historyMessageIds: history.map(() => randomUUID()),
      contextCompressionState: {
        coveredHistoryDigest: createHash('sha256')
          .update(
            JSON.stringify([
              { role: 'user', content: 'evicted question' },
              { role: 'assistant', content: 'evicted answer' }
            ])
          )
          .digest('hex'),
        coveredMessageCount: 2,
        coveredFromMessageId: randomUUID(),
        coveredThroughMessageId: randomUUID(),
        summary: 'persisted facts after filtering'
      }
    })

    expect(prompt).toContain('persisted facts after filtering')
    expect(prompt).toContain('filtered recent message 498')
    expect(prompt).not.toContain('evicted question')
  })

  it('keeps a persisted summary when only its covered start rolls out of the history window', () => {
    const coveredThroughMessageId = randomUUID()
    const history = [
      {
        role: 'assistant' as const,
        content: 'covered answer still at window start'
      },
      ...Array.from({ length: 499 }, (_, index) => ({
        role:
          index % 2 === 0
            ? ('user' as const)
            : ('assistant' as const),
        content: `later message ${index}`
      }))
    ]
    const prompt = buildContinuePrompt({
      requestId: randomUUID(),
      conversationId: 'partially-evicted-summary-conversation',
      prompt: 'continue',
      history,
      historyMessageIds: [
        coveredThroughMessageId,
        ...history.slice(1).map(() => randomUUID())
      ],
      contextCompressionState: {
        coveredHistoryDigest: createHash('sha256')
          .update(
            JSON.stringify([
              { role: 'user', content: 'evicted covered question' },
              history[0]
            ])
          )
          .digest('hex'),
        coveredMessageCount: 2,
        coveredFromMessageId: randomUUID(),
        coveredThroughMessageId,
        summary: 'persisted partially evicted facts'
      }
    })

    expect(prompt).toContain('persisted partially evicted facts')
    expect(prompt).toContain('later message 498')
    expect(prompt).not.toContain('covered answer still at window start')
  })

  it('rejects a persisted summary that contradicts the current bounded history window', () => {
    const coveredThroughMessageId = randomUUID()
    const history = Array.from({ length: 500 }, (_, index) => ({
      role:
        index % 2 === 0
          ? ('user' as const)
          : ('assistant' as const),
      content: `conflicting message ${index}`
    }))
    const historyMessageIds = history.map(() => randomUUID())
    historyMessageIds[10] = coveredThroughMessageId
    const prompt = buildContinuePrompt({
      requestId: randomUUID(),
      conversationId: 'conflicting-summary-conversation',
      prompt: 'continue',
      history,
      historyMessageIds,
      contextCompressionState: {
        coveredHistoryDigest: '0'.repeat(64),
        coveredMessageCount: 2,
        coveredFromMessageId: randomUUID(),
        coveredThroughMessageId,
        summary: 'contradictory summary must not appear'
      }
    })

    expect(prompt).toContain('conflicting message 499')
    expect(prompt).not.toContain('contradictory summary must not appear')
  })

  it('falls back to bounded raw history when a persisted summary is stale', async () => {
    const runtime = createRuntime()
    for await (const _event of runtime.run(
      {
        requestId: randomUUID(),
        conversationId: 'stale-summary-conversation',
        prompt: 'continue',
        history: [
          { role: 'user', content: 'raw old question' },
          { role: 'assistant', content: 'raw old answer' }
        ],
        contextCompressionState: {
          coveredHistoryDigest: '0'.repeat(64),
          coveredMessageCount: 2,
          summary: 'stale summary must not appear'
        }
      },
      new AbortController().signal
    )) {
      void _event
    }

    const prompt = String(mocks.runHost.mock.calls[0]?.[0])
    expect(prompt).toContain('raw old question')
    expect(prompt).not.toContain('stale summary must not appear')
  })

  it('selects a Continue preset and rejects stale preset IDs', async () => {
    const preset = {
      id: randomUUID(),
      name: 'Review',
      rules: [
        {
          id: randomUUID(),
          name: 'Be concise',
          content: 'Use concise answers.',
          enabled: true
        }
      ],
      prompts: []
    }
    const runtime = new ContinueAgentRuntime({
      binaryPath: '',
      configPath: 'C:\\safe config\\continue.yaml',
      defaultWorkspace: process.cwd(),
      hostCacheRoot: 'C:\\safe\\continue-host',
      customization: {
        defaultPresetId: preset.id,
        presets: [preset]
      },
      createHostAdapter: () => ({
        getPreparedHost: mocks.prepareHost,
        run: mocks.runHost,
        dispose: mocks.disposeHost
      })
    })

    await collectEvents(runtime)
    expect(mocks.runHost.mock.calls[0]?.[3]).toMatchObject({
      preset
    })

    const staleRuntime = new ContinueAgentRuntime({
      binaryPath: '',
      configPath: 'C:\\safe config\\continue.yaml',
      defaultWorkspace: process.cwd(),
      hostCacheRoot: 'C:\\safe\\continue-host',
      customization: {
        defaultPresetId: randomUUID(),
        presets: []
      },
      createHostAdapter: () => ({
        getPreparedHost: mocks.prepareHost,
        run: mocks.runHost,
        dispose: mocks.disposeHost
      })
    })
    const stream = staleRuntime.run(
      {
        requestId: randomUUID(),
        conversationId: 'stale-preset',
        prompt: 'test'
      },
      new AbortController().signal
    )
    await expect(stream.next()).rejects.toThrow('预设已失效或不存在')
  })

  it('reuses discovery for availability and reports safe diagnostics', async () => {
    mocks.detectRuntimeBinary.mockResolvedValue({
      available: false,
      detail: '未自动检测到 Continue CLI，请配置绝对二进制路径'
    })
    const runtime = createRuntime()

    await expect(runtime.getStatus()).resolves.toEqual({
      id: 'continue',
      label: 'Continue CLI',
      available: false,
      supportsToolExecution: true,
      detail: '未自动检测到 Continue CLI，请配置绝对二进制路径'
    })
    const stream = runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'test'
      },
      new AbortController().signal
    )
    await expect(stream.next()).rejects.toThrow(
      '未自动检测到 Continue CLI'
    )
    expect(mocks.detectRuntimeBinary).toHaveBeenCalledOnce()
    expect(mocks.runHost).not.toHaveBeenCalled()
  })

  it('auto-allows host tool requests without using GoodBuddy approval', async () => {
    const runtime = createRuntime()
    const stream = runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'test',
        workMode: 'execute'
      },
      new AbortController().signal
    )
    for await (const event of stream) {
      expect(event).toBeDefined()
    }

    const hostAuthorize = mocks.runHost.mock.calls[0]?.[2] as
      | (() => Promise<string>)
      | undefined
    await expect(hostAuthorize?.()).resolves.toBe('once')
  })

  it('keeps non-interactive Ask runs read-only', async () => {
    const modes: Array<'chat' | 'agent' | undefined> = []
    const runtime = new ContinueAgentRuntime({
      binaryPath: '',
      configPath: 'C:\\safe config\\continue.yaml',
      defaultWorkspace: process.cwd(),
      hostCacheRoot: 'C:\\safe\\continue-host',
      createHostAdapter: (options) => {
        modes.push(options.mode)
        return {
          getPreparedHost: mocks.prepareHost,
          run: mocks.runHost,
          dispose: mocks.disposeHost
        }
      }
    })

    await collectEvents(runtime, 'ask')
    await collectEvents(runtime, 'execute')

    expect(modes).toEqual(['chat', 'agent'])
    const askAuthorize = mocks.runHost.mock.calls[0]?.[2] as
      | (() => Promise<string>)
      | undefined
    const executeAuthorize = mocks.runHost.mock.calls[1]?.[2] as
      | (() => Promise<string>)
      | undefined
    await expect(askAuthorize?.()).resolves.toBe('deny')
    await expect(executeAuthorize?.()).resolves.toBe('once')
  })

  it('emits completed audit events for Continue tools', async () => {
    mocks.runHost.mockResolvedValue({
      text: 'Continue response',
      tools: [
        {
          callId: 'call-1',
          name: 'Bash',
          state: 'completed',
          input: '{"command":"npm test"}',
          output: 'Tests passed'
        },
        { callId: 'call-2', name: 'Write', state: 'completed' }
      ]
    })

    const events = await collectEvents(createRuntime(), 'execute')

    expect(events.filter((event) => event.type === 'tool')).toEqual([
      expect.objectContaining({
        type: 'tool',
        name: 'Bash',
        state: 'completed',
        summary: 'Continue 工具：Bash',
        input: '{"command":"npm test"}',
        output: 'Tests passed'
      }),
      expect.objectContaining({
        type: 'tool',
        name: 'Write',
        state: 'completed',
        summary: 'Continue 工具：Write'
      })
    ])
  })

  it('forwards streamed text and tool events in host order', async () => {
    mocks.runHost.mockImplementation(
      async (
        _prompt,
        _signal,
        _authorize,
        options
      ) => {
        await options?.onEvent?.({
          type: 'text',
          delta: '先分析'
        })
        await options?.onEvent?.({
          type: 'tool',
          tool: {
            callId: 'call-1',
            name: 'Read',
            state: 'running'
          }
        })
        await options?.onEvent?.({
          type: 'tool',
          tool: {
            callId: 'call-1',
            name: 'Read',
            state: 'completed'
          }
        })
        await options?.onEvent?.({
          type: 'text',
          delta: '再回答'
        })
        return {
          text: '再回答',
          streamedText: true,
          tools: [
            {
              callId: 'call-1',
              name: 'Read',
              state: 'completed'
            }
          ]
        }
      }
    )

    const events = await collectEvents(createRuntime(), 'execute')

    expect(
      events.filter(
        (event) => event.type === 'text' || event.type === 'tool'
      )
    ).toEqual([
      expect.objectContaining({ type: 'text', delta: '先分析' }),
      expect.objectContaining({
        type: 'tool',
        callId: 'call-1',
        state: 'running'
      }),
      expect.objectContaining({
        type: 'tool',
        callId: 'call-1',
        state: 'completed'
      }),
      expect.objectContaining({ type: 'text', delta: '再回答' })
    ])
  })

  it('routes structured question answers and cleans completed mappings', async () => {
    let finishQuestion: (() => void) | undefined
    const answered = new Promise<void>((resolve) => {
      finishQuestion = resolve
    })
    mocks.respondHostQuestion.mockImplementation(async () => {
      finishQuestion?.()
    })
    mocks.runHost.mockImplementation(
      async (_prompt, _signal, _authorize, options) => {
        await options?.onEvent?.({
          type: 'question',
          questionId: 'quiz-123',
          questions: [
            {
              header: 'Continue',
              question: 'Choose a plan',
              options: [
                { label: 'Safe', description: '' }
              ],
              multiple: false,
              custom: true
            }
          ]
        })
        await answered
        return { text: 'Plan selected' }
      }
    )
    const runtime = createRuntime()
    const stream = runtime.run(
      {
        requestId: randomUUID(),
        conversationId: 'question-conversation',
        prompt: 'plan'
      },
      new AbortController().signal
    )

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'status' }
    })
    await expect(stream.next()).resolves.toMatchObject({
      value: {
        type: 'question',
        questionId: 'quiz-123',
        questions: [
          expect.objectContaining({ question: 'Choose a plan' })
        ]
      }
    })
    await runtime.respondToQuestion('quiz-123', [['Safe']])
    const remaining: RuntimeEvent[] = []
    for await (const event of stream) {
      remaining.push(event)
    }

    expect(mocks.respondHostQuestion).toHaveBeenCalledWith(
      'quiz-123',
      [['Safe']]
    )
    expect(remaining).toContainEqual(
      expect.objectContaining({
        type: 'text',
        delta: 'Plan selected'
      })
    )
    await expect(
      runtime.respondToQuestion('quiz-123', [['Safe']])
    ).rejects.toThrow('已失效或不存在')
  })

  it('fails instead of silently dropping an overflowing stream queue', async () => {
    mocks.runHost.mockImplementation(
      async (
        _prompt,
        _signal,
        _authorize,
        options
      ) => {
        for (let index = 0; index < 1_001; index += 1) {
          options?.onEvent?.({
            type: 'text',
            delta: String(index)
          })
        }
        return { text: 'done', streamedText: true }
      }
    )
    const stream = createRuntime().run(
      {
        requestId: randomUUID(),
        conversationId: 'overflow-conversation',
        prompt: 'test'
      },
      new AbortController().signal
    )

    await expect(async () => {
      for await (const _event of stream) {
        void _event
      }
    }).rejects.toThrow('流式事件积压超过安全限制')
  })

  it('aborts the host run when stream consumption ends early', async () => {
    let resolveHost: (() => void) | undefined
    const hostFinished = new Promise<void>((resolve) => {
      resolveHost = resolve
    })
    let hostSignal: AbortSignal | undefined
    mocks.runHost.mockImplementation(
      async (
        _prompt,
        signal,
        _authorize,
        options
      ) => {
        hostSignal = signal
        await options?.onEvent?.({
          type: 'text',
          delta: 'partial'
        })
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              resolve()
              resolveHost?.()
            },
            { once: true }
          )
        })
        throw signal.reason
      }
    )
    const stream = createRuntime().run(
      {
        requestId: randomUUID(),
        conversationId: 'early-close-conversation',
        prompt: 'test'
      },
      new AbortController().signal
    )

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'status' }
    })
    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'text', delta: 'partial' }
    })
    await stream.return()
    await hostFinished
    expect(hostSignal?.aborted).toBe(true)
  })

  it('emits terminal tool audits before a failed Continue run', async () => {
    mocks.runHost.mockRejectedValue(
      new ContinueHostRunError('Continue failed', {
        cause: new Error('failed'),
        tools: [
          {
            callId: 'call-1',
            name: 'Bash',
            state: 'failed',
            error: 'PowerShell parser failed'
          }
        ]
      })
    )
    const stream = createRuntime().run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'test',
        workMode: 'execute'
      },
      new AbortController().signal
    )

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'status' }
    })
    await expect(stream.next()).resolves.toMatchObject({
      value: {
        type: 'tool',
        callId: 'call-1',
        state: 'failed',
        error: 'PowerShell parser failed'
      }
    })
    await expect(stream.next()).rejects.toThrow('Continue failed')
  })

  it('keeps a completed Continue response when an earlier tool attempt failed', async () => {
    mocks.runHost.mockResolvedValue({
      text: 'Continue response',
      tools: [
        {
          callId: 'call-1',
          name: 'Bash',
          state: 'failed',
          error: 'PowerShell EmptyPipeElement'
        }
      ]
    })
    const stream = createRuntime().run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'test',
        workMode: 'execute'
      },
      new AbortController().signal
    )

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'status' }
    })
    const events: RuntimeEvent[] = []
    for await (const event of stream) {
      events.push(event)
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool',
        callId: 'call-1',
        state: 'recoverable',
        error: 'PowerShell EmptyPipeElement'
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'text',
        delta: 'Continue response'
      })
    )
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('fails a run that returns a nonterminal tool state', async () => {
    mocks.runHost.mockResolvedValue({
      text: 'Continue response',
      tools: [
        {
          callId: 'call-1',
          name: 'Bash',
          state: 'running'
        }
      ]
    })
    const stream = createRuntime().run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'test',
        workMode: 'execute'
      },
      new AbortController().signal
    )

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'status' }
    })
    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'tool', state: 'failed' }
    })
    await expect(stream.next()).rejects.toThrow('工具未完成')
  })
})
