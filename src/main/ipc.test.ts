import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

describe('registerIpcHandlers window controls', () => {
  afterEach(() => {
    electronMocks.handlers.clear()
    vi.clearAllMocks()
  })

  it('restricts custom chrome controls to the trusted main window', async () => {
    let maximized = false
    const listeners = new Map<string, () => void>()
    const webContents = {
      mainFrame: { url: 'file:///goodbuddy/index.html' },
      getURL: vi.fn(() => 'file:///goodbuddy/index.html'),
      send: vi.fn()
    }
    const window = {
      webContents,
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => maximized),
      minimize: vi.fn(),
      maximize: vi.fn(() => {
        maximized = true
      }),
      unmaximize: vi.fn(() => {
        maximized = false
      }),
      close: vi.fn(),
      on: vi.fn((name: string, listener: () => void) => {
        listeners.set(name, listener)
      }),
      removeListener: vi.fn()
    }
    const dispose = registerIpcHandlers(
      window as never,
      { capability: 'text' } as never,
      'CommandOrControl+Shift+Space',
      {} as never,
      {} as never,
      { clear: vi.fn() } as never,
      {} as never,
      { claimDueSchedules: vi.fn(() => []) } as never,
      { clear: vi.fn() } as never,
      {} as never,
      vi.fn(async () => {})
    )
    const event = {
      sender: webContents,
      senderFrame: webContents.mainFrame
    }

    electronMocks.handlers.get(ipcChannels.windowMinimize)?.(event)
    electronMocks.handlers.get(
      ipcChannels.windowToggleMaximize
    )?.(event)
    listeners.get('maximize')?.()
    electronMocks.handlers.get(ipcChannels.windowClose)?.(event)

    expect(window.minimize).toHaveBeenCalledOnce()
    expect(window.maximize).toHaveBeenCalledOnce()
    expect(webContents.send).toHaveBeenCalledWith(
      ipcChannels.windowMaximizedChanged,
      true
    )
    expect(window.close).toHaveBeenCalledOnce()
    expect(() =>
      electronMocks.handlers
        .get(ipcChannels.windowIsMaximized)
        ?.({
          sender: {},
          senderFrame: webContents.mainFrame
        })
    ).toThrow('拒绝来自未知窗口的 IPC 请求')

    await dispose()
    expect(window.removeListener).toHaveBeenCalledWith(
      'maximize',
      listeners.get('maximize')
    )
  })
})

describe('registerIpcHandlers workspace files', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    electronMocks.handlers.clear()
    vi.clearAllMocks()
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true })
      )
    )
  })

  it('resolves the project root and validates file requests', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'goodbuddy-ipc-files-'))
    temporaryDirectories.push(rootPath)
    await writeFile(join(rootPath, 'README.md'), '# GoodBuddy\n')
    const projectId = '00000000-0000-4000-8000-000000000101'
    const assistantDatabase = {
      claimDueSchedules: vi.fn(() => []),
      getProject: vi.fn(() => ({ id: projectId, rootPath }))
    }
    const webContents = {
      mainFrame: { url: 'file:///goodbuddy/index.html' },
      getURL: vi.fn(() => 'file:///goodbuddy/index.html')
    }
    const window = {
      webContents,
      isDestroyed: vi.fn(() => false),
      on: vi.fn(),
      removeListener: vi.fn()
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
    const event = {
      sender: webContents,
      senderFrame: webContents.mainFrame
    }

    const list = await electronMocks.handlers.get(
      ipcChannels.workspaceDirectoryList
    )?.(event, { projectId, path: '' })
    const preview = await electronMocks.handlers.get(
      ipcChannels.workspaceFileRead
    )?.(event, { projectId, path: 'README.md' })

    expect(list).toMatchObject({
      entries: [
        { name: 'README.md', path: 'README.md', type: 'file' }
      ]
    })
    expect(preview).toMatchObject({
      path: 'README.md',
      content: '# GoodBuddy\n',
      mimeType: 'text/markdown'
    })
    await expect(
      electronMocks.handlers.get(ipcChannels.workspaceFileRead)?.(event, {
        projectId,
        path: '../outside.txt'
      })
    ).rejects.toThrow('路径必须是工作区内的相对路径')
    expect(assistantDatabase.getProject).toHaveBeenCalledWith(projectId)

    await dispose()
  })
})

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
      isDestroyed: vi.fn(() => false),
      on: vi.fn(),
      removeListener: vi.fn()
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
      isFocused: vi.fn(() => true),
      on: vi.fn(),
      removeListener: vi.fn()
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
      {
        getResolvedSettings: vi.fn(async () => ({
          toolApproval: 'always'
        }))
      } as never,
      {} as never,
      contextManager as never,
      {} as never,
      assistantDatabase as never,
      approvalBroker as never,
      {} as never,
      vi.fn(async () => {})
    )
    return {
      approvalBroker,
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

  it.each(['opencode', 'continue'] as const)(
    'normalizes interactive %s requests to Execute without GoodBuddy approval',
    async (runtimeId) => {
      let received:
        | {
            request: { workMode?: string }
            authorize: unknown
          }
        | undefined
      const runtime = {
        runtimeId,
        capability: 'chat',
        requiresToolApproval: false,
        supportsToolExecution: true,
        getStatus: vi.fn(),
        dispose: vi.fn(),
        async *run(
          request: { requestId: string; workMode?: string },
          _signal: AbortSignal,
          authorize: unknown
        ) {
          received = { request, authorize }
          yield { requestId: request.requestId, type: 'done' }
        }
      }
      const harness = createHarness(runtime)
      const requestId = '3f496642-f47d-4e0a-8944-a32c77b0d6ef'

      harness.handler?.(trustedEvent(harness.webContents), {
        requestId,
        conversationId: 'conversation-1',
        prompt: 'run the task',
        workMode: 'ask'
      })

      await vi.waitFor(() =>
        expect(
          harness.assistantDatabase.updateTaskStatus
        ).toHaveBeenCalledWith(requestId, 'completed')
      )
      expect(received?.request.workMode).toBe('execute')
      expect(received?.authorize).toBeUndefined()
      expect(harness.approvalBroker.request).not.toHaveBeenCalled()
      expect(
        harness.assistantDatabase.createTask
      ).toHaveBeenCalledWith(
        expect.objectContaining({ id: requestId, workMode: 'execute' })
      )
      await harness.dispose()
    }
  )

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

  it('routes direct-model tool calls through the GoodBuddy approval broker', async () => {
    let receivedAuthorize:
      | ((
          request: {
            scopeKey: string
            title: string
            description: string
          }
        ) => Promise<string>)
      | undefined
    const runtime = {
      runtimeId: 'model',
      capability: 'chat',
      requiresToolApproval: false,
      supportsToolExecution: true,
      getStatus: vi.fn(),
      dispose: vi.fn(),
      async *run(
        request: { requestId: string },
        _signal: AbortSignal,
        authorize: typeof receivedAuthorize
      ) {
        receivedAuthorize = authorize
        await authorize?.({
          scopeKey: 'model:builtin:workspace_read_text',
          title: '允许读取工作区文本？',
          description: '读取 README.md'
        })
        yield {
          requestId: request.requestId,
          type: 'tool',
          callId: 'call-1',
          name: '读取工作区文本',
          state: 'completed',
          summary: '直连模型工具已完成'
        }
        yield { requestId: request.requestId, type: 'done' }
      }
    }
    const harness = createHarness(runtime)
    harness.approvalBroker.request.mockResolvedValue('once')
    const requestId = '3f496642-f47d-4e0a-8944-a32c77b0d6ef'

    harness.handler?.(trustedEvent(harness.webContents), {
      requestId,
      conversationId: 'conversation-1',
      prompt: '读取文件',
      workMode: 'execute'
    })

    await vi.waitFor(() =>
      expect(
        harness.assistantDatabase.updateTaskStatus
      ).toHaveBeenCalledWith(requestId, 'completed')
    )
    expect(receivedAuthorize).toEqual(expect.any(Function))
    expect(harness.approvalBroker.request).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId,
        conversationId: 'conversation-1',
        scopeKey: 'model:builtin:workspace_read_text'
      }),
      expect.any(AbortSignal),
      expect.any(Function)
    )
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
