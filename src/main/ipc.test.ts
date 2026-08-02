import { afterEach, describe, expect, it, vi } from 'vitest'
import { ipcChannels } from '../shared/ipc-channels'
import { registerIpcHandlers } from './ipc'

type InvokeHandler = (event: unknown, input?: unknown) => unknown

const electronMocks = vi.hoisted(() => {
  const handlers = new Map<string, InvokeHandler>()
  return {
    handlers,
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    })
  }
})

vi.mock('electron', () => ({
  app: {
    getName: vi.fn(() => 'GoodBuddy'),
    getVersion: vi.fn(() => '0.1.0')
  },
  BrowserWindow: class {},
  dialog: {},
  ipcMain: {
    handle: electronMocks.handle,
    removeHandler: electronMocks.removeHandler
  },
  Notification: class {
    static isSupported(): boolean {
      return false
    }
  }
}))

vi.mock('./assistant/heartbeat-service', () => ({
  HeartbeatService: class {
    async processDue(): Promise<void> {}
  }
}))

describe('registerIpcHandlers token usage', () => {
  afterEach(() => {
    electronMocks.handlers.clear()
    vi.clearAllMocks()
  })

  it('returns the database token summary to a trusted renderer', async () => {
    const summary = {
      totals: {
        callCount: 2,
        input: 120,
        output: 30,
        cacheRead: 10,
        cacheWrite: 5,
        totalTokens: 165
      },
      records: []
    }
    const assistantDatabase = {
      claimDueSchedules: vi.fn(() => []),
      getTokenUsageSummary: vi.fn(() => summary)
    }
    const webContents = {
      mainFrame: {
        url: 'file:///goodbuddy/index.html'
      },
      getURL: vi.fn(() => 'file:///goodbuddy/index.html')
    }
    const window = {
      webContents,
      isDestroyed: vi.fn(() => false)
    }
    const dispose = registerIpcHandlers(
      window as never,
      { capability: 'text' } as never,
      'CommandOrControl+Shift+Space',
      {} as never,
      {} as never,
      { clear: vi.fn() } as never,
      {} as never,
      assistantDatabase as never,
      { clear: vi.fn() } as never,
      {} as never,
      vi.fn(async () => {})
    )

    const handler = electronMocks.handlers.get(
      ipcChannels.tokenUsageSummary
    )
    expect(handler).toBeDefined()
    expect(
      handler?.({
        sender: webContents,
        senderFrame: webContents.mainFrame
      })
    ).toBe(summary)
    expect(assistantDatabase.getTokenUsageSummary).toHaveBeenCalledOnce()

    await dispose()
  })
})

describe('registerIpcHandlers agent terminal state', () => {
  afterEach(() => {
    electronMocks.handlers.clear()
    vi.clearAllMocks()
  })

  function createHarness(runtime: Record<string, unknown>) {
    const assistantDatabase = {
      claimDueSchedules: vi.fn(() => []),
      createTask: vi.fn(),
      appendTaskEvent: vi.fn(),
      updateTaskStatus: vi.fn(),
      createTextArtifact: vi.fn(),
      upsertModelUsageCall: vi.fn()
    }
    const webContents = {
      mainFrame: { url: 'file:///goodbuddy/index.html' },
      getURL: vi.fn(() => 'file:///goodbuddy/index.html'),
      send: vi.fn()
    }
    const window = {
      webContents,
      isDestroyed: vi.fn(() => false),
      isFocused: vi.fn(() => true)
    }
    const contextManager = {
      enrichRequest: vi.fn((request) => request),
      clear: vi.fn()
    }
    const approvalBroker = {
      request: vi.fn(),
      respond: vi.fn(),
      clear: vi.fn()
    }
    const dispose = registerIpcHandlers(
      window as never,
      runtime as never,
      'CommandOrControl+Shift+Space',
      { getResolvedSettings: vi.fn() } as never,
      {} as never,
      contextManager as never,
      {} as never,
      assistantDatabase as never,
      approvalBroker as never,
      {} as never,
      vi.fn(async () => {})
    )
    return {
      assistantDatabase,
      dispose,
      handler: electronMocks.handlers.get(ipcChannels.agentRun),
      webContents
    }
  }

  const trustedEvent = (webContents: {
    mainFrame: { url: string }
  }) => ({
    sender: webContents,
    senderFrame: webContents.mainFrame
  })

  it('marks a request failed when a tool fails before runtime done', async () => {
    const runtime = {
      capability: 'chat',
      requiresToolApproval: false,
      supportsToolExecution: true,
      getStatus: vi.fn(),
      dispose: vi.fn(),
      async *run(request: { requestId: string }) {
        yield {
          requestId: request.requestId,
          type: 'tool',
          callId: 'call-1',
          name: 'write',
          state: 'failed',
          summary: 'OpenCode 工具：write'
        }
        yield { requestId: request.requestId, type: 'done' }
      }
    }
    const harness = createHarness(runtime)
    const requestId = '3f496642-f47d-4e0a-8944-a32c77b0d6ef'

    harness.handler?.(trustedEvent(harness.webContents), {
      requestId,
      conversationId: 'conversation-1',
      prompt: 'write a file',
      workMode: 'execute'
    })

    await vi.waitFor(() =>
      expect(harness.assistantDatabase.updateTaskStatus).toHaveBeenCalledWith(
        requestId,
        'failed',
        'write 工具执行失败'
      )
    )
    expect(
      harness.assistantDatabase.updateTaskStatus
    ).not.toHaveBeenCalledWith(requestId, 'completed')
    expect(harness.webContents.send).toHaveBeenCalledWith(
      ipcChannels.agentEvent,
      expect.objectContaining({
        requestId,
        type: 'error',
        status: 'failed'
      })
    )
    await harness.dispose()
  })

  it('rejects Execute before creating a task on an unsupported runtime', async () => {
    const runtime = {
      capability: 'chat',
      requiresToolApproval: false,
      supportsToolExecution: false,
      getStatus: vi.fn(),
      dispose: vi.fn(),
      run: vi.fn()
    }
    const harness = createHarness(runtime)

    expect(() =>
      harness.handler?.(trustedEvent(harness.webContents), {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'write a file',
        workMode: 'execute'
      })
    ).toThrow('当前 Runtime 不支持工具执行')
    expect(harness.assistantDatabase.createTask).not.toHaveBeenCalled()
    await harness.dispose()
  })

  it('redacts runtime errors before persistence and renderer delivery', async () => {
    const runtime = {
      capability: 'chat',
      requiresToolApproval: false,
      supportsToolExecution: false,
      getStatus: vi.fn(),
      dispose: vi.fn(),
      async *run() {
        yield* []
        throw new Error(
          'gateway failed Authorization: Bearer secret-token'
        )
      }
    }
    const harness = createHarness(runtime)
    const requestId = '3f496642-f47d-4e0a-8944-a32c77b0d6ef'

    harness.handler?.(trustedEvent(harness.webContents), {
      requestId,
      conversationId: 'conversation-1',
      prompt: 'ask',
      workMode: 'ask'
    })

    await vi.waitFor(() =>
      expect(harness.assistantDatabase.updateTaskStatus).toHaveBeenCalledWith(
        requestId,
        'failed',
        'gateway failed Authorization: [REDACTED]'
      )
    )
    expect(harness.webContents.send).toHaveBeenCalledWith(
      ipcChannels.agentEvent,
      expect.objectContaining({
        message: 'gateway failed Authorization: [REDACTED]'
      })
    )
    await harness.dispose()
  })
})
