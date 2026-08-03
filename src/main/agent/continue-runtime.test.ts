import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeEvent } from './runtime'
import { ContinueHostRunError } from './continue-host-adapter'

const mocks = vi.hoisted(() => ({
  detectRuntimeBinary: vi.fn(),
  runHost: vi.fn(),
  disposeHost: vi.fn(),
  prepareHost: vi.fn()
}))

vi.mock('./runtime-discovery', () => ({
  detectRuntimeBinary: mocks.detectRuntimeBinary
}))

import { ContinueAgentRuntime } from './continue-runtime'

function createRuntime(): ContinueAgentRuntime {
  return new ContinueAgentRuntime({
    binaryPath: '',
    configPath: 'C:\\safe config\\continue.yaml',
    defaultWorkspace: process.cwd(),
    hostCacheRoot: 'C:\\safe\\continue-host',
    createHostAdapter: () => ({
      getPreparedHost: mocks.prepareHost,
      run: mocks.runHost,
      dispose: mocks.disposeHost
    })
  })
}

async function collectEvents(
  runtime: ContinueAgentRuntime,
  workMode?: 'ask' | 'plan' | 'execute'
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
      expect.any(Function)
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

  it('adds assigned Skill instructions to the Continue prompt', async () => {
    const runtime = new ContinueAgentRuntime({
      binaryPath: '',
      configPath: 'C:\\safe config\\continue.yaml',
      defaultWorkspace: process.cwd(),
      hostCacheRoot: 'C:\\safe\\continue-host',
      skillInstructions: '# 周报助手',
      createHostAdapter: () => ({
        getPreparedHost: mocks.prepareHost,
        run: mocks.runHost,
        dispose: mocks.disposeHost
      })
    })

    await collectEvents(runtime)

    const prompt = String(mocks.runHost.mock.calls[0]?.[0])
    expect(prompt).toContain('SYSTEM CAPABILITY INSTRUCTIONS')
    expect(prompt).toContain('# 周报助手')
    expect(prompt).toContain('test')
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
        { callId: 'call-1', name: 'Bash', state: 'completed' },
        { callId: 'call-2', name: 'Write', state: 'completed' }
      ]
    })

    const events = await collectEvents(createRuntime(), 'execute')

    expect(events.filter((event) => event.type === 'tool')).toEqual([
      expect.objectContaining({
        type: 'tool',
        name: 'Bash',
        state: 'completed',
        summary: 'Continue 工具：Bash'
      }),
      expect.objectContaining({
        type: 'tool',
        name: 'Write',
        state: 'completed',
        summary: 'Continue 工具：Write'
      })
    ])
  })

  it('emits terminal tool audits before a failed Continue run', async () => {
    mocks.runHost.mockRejectedValue(
      new ContinueHostRunError('Continue failed', {
        cause: new Error('failed'),
        tools: [
          {
            callId: 'call-1',
            name: 'Bash',
            state: 'failed'
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
        state: 'failed'
      }
    })
    await expect(stream.next()).rejects.toThrow('Continue failed')
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
