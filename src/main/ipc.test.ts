import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ipcChannels } from '../shared/ipc-channels'
import type { BrowserLiveState } from '../shared/contracts'
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

const channelMocks = vi.hoisted(() => ({
  executor: undefined as
    | ((
        message: {
          channel: string
          eventId: string
          senderId: string
          conversationId: string
          conversationType: 'direct' | 'group'
          text: string
          mentioned: boolean
          workMode: 'ask' | 'plan'
        },
        signal: AbortSignal
      ) => Promise<{
        status: string
        output?: string
        error?: string
      }>)
    | undefined,
  stop: vi.fn(async () => undefined)
}))

describe('registerIpcHandlers computer capabilities', () => {
  afterEach(() => {
    electronMocks.handlers.clear()
    vi.clearAllMocks()
    channelMocks.stop.mockResolvedValue(undefined)
  })

  it('validates computer capability requests and restricts them to the trusted renderer', async () => {
    const webContents = {
      mainFrame: { url: 'file:///goodbuddy/index.html' },
      getURL: vi.fn(() => 'file:///goodbuddy/index.html'),
      send: vi.fn()
    }
    const window = {
      webContents,
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      on: vi.fn(),
      removeListener: vi.fn()
    }
    const snapshot = {
      skills: [],
      mcpServers: [],
      computerCapabilities: [],
      browserProfiles: { profiles: [], defaultProfileId: null }
    }
    const capabilityService = {
      setComputerCapabilityEnabled: vi.fn(async () => snapshot),
      createBrowserProfile: vi.fn(async () => snapshot),
      diagnoseComputerCapability: vi.fn(async () => ({
        capabilityId: 'host-browser-control',
        status: 'disabled',
        checkedAt: '2026-08-05T00:00:00.000Z',
        checks: []
      }))
    }
    const onRuntimeSettingsChanged = vi.fn(async () => {})
    const releaseConversation = vi.fn(async () => {})
    let browserStateListener:
      | ((state: BrowserLiveState) => void)
      | undefined
    const dispose = registerIpcHandlers(
      window as never,
      { capability: 'text' } as never,
      'CommandOrControl+Shift+Space',
      {} as never,
      capabilityService as never,
      { clear: vi.fn() } as never,
      {} as never,
      { claimDueSchedules: vi.fn(() => []) } as never,
      { clear: vi.fn() } as never,
      {} as never,
      onRuntimeSettingsChanged,
      undefined,
      {
        releaseConversation,
        onState: (listener) => {
          browserStateListener = listener
          return vi.fn()
        }
      }
    )
    const event = {
      sender: webContents,
      senderFrame: webContents.mainFrame
    }

    await expect(
      electronMocks.handlers.get(
        ipcChannels.capabilitiesToggleComputer
      )?.(event, {
        capabilityId: 'host-browser-control',
        enabled: true
      })
    ).resolves.toEqual(snapshot)
    expect(
      capabilityService.setComputerCapabilityEnabled
    ).toHaveBeenCalledWith('host-browser-control', true)
    expect(onRuntimeSettingsChanged).toHaveBeenCalledOnce()

    browserStateListener?.({
      conversationId: 'browser-conversation',
      status: 'ready',
      updatedAt: 1
    })
    expect(webContents.send).toHaveBeenCalledWith(
      ipcChannels.browserState,
      expect.objectContaining({
        conversationId: 'browser-conversation',
        status: 'ready'
      })
    )
    await expect(
      electronMocks.handlers.get(ipcChannels.browserStop)?.(event, {
        conversationId: 'browser-conversation'
      })
    ).resolves.toBeUndefined()
    expect(releaseConversation).toHaveBeenCalledWith(
      'browser-conversation'
    )

    expect(() =>
      electronMocks.handlers.get(
        ipcChannels.capabilitiesCreateBrowserProfile
      )?.(event, {
        name: '工作配置',
        executable: 'C:\\unsafe.exe'
      })
    ).toThrow()
    expect(capabilityService.createBrowserProfile).not.toHaveBeenCalled()

    expect(() =>
      electronMocks.handlers.get(
        ipcChannels.capabilitiesDiagnoseComputer
      )?.(
        {
          sender: {},
          senderFrame: webContents.mainFrame
        },
        'host-browser-control'
      )
    ).toThrow('拒绝来自未知窗口的 IPC 请求')
    await dispose()
  })
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

vi.mock('./channels/channel-env', () => ({
  isReadOnlyChannelMessage: (message: { workMode: string }) =>
    message.workMode === 'ask' || message.workMode === 'plan',
  startEnvironmentChannels: vi.fn(
    (options: { executor: typeof channelMocks.executor }) => {
      channelMocks.executor = options.executor
      return [
        {
          start: vi.fn(async () => undefined),
          stop: channelMocks.stop
        }
      ]
    }
  )
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

  function createHarness(
    runtime: Record<string, unknown>,
    onBeforeClearLocalData?: () => Promise<void>,
    toolApproval: 'always' | 'policy' = 'always',
    subagentService?: Record<string, unknown>,
    smartRoutingEnabled = false
  ) {
    const assistantDatabase = {
      claimDueSchedules: vi.fn(() => []),
      createTask: vi.fn(),
      appendTaskEvent: vi.fn(),
      updateTaskStatus: vi.fn(),
      createTextArtifact: vi.fn(),
      upsertModelUsageCall: vi.fn(),
      clearAssistantData: vi.fn(),
      listExperts: vi.fn<() => Array<Record<string, unknown>>>(() => []),
      getExpert: vi.fn()
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
          toolApproval,
          subagentSmartRoutingEnabled: smartRoutingEnabled
        }))
      } as never,
      {} as never,
      contextManager as never,
      {} as never,
      assistantDatabase as never,
      approvalBroker as never,
      {} as never,
      vi.fn(async () => {}),
      onBeforeClearLocalData,
      undefined,
      subagentService as never
    )
    return {
      approvalBroker,
      assistantDatabase,
      contextManager,
      dispose,
      clearHandler: electronMocks.handlers.get(
        ipcChannels.appClearLocalData
      ),
      handler: electronMocks.handlers.get(ipcChannels.agentRun),
      cancelHandler: electronMocks.handlers.get(ipcChannels.agentCancel),
      webContents
    }
  }

  const trustedEvent = (webContents: {
    mainFrame: { url: string }
  }) => ({
    sender: webContents,
    senderFrame: webContents.mainFrame
  })

  it('aborts active work and clears browser sessions before assistant data', async () => {
    const lifecycle: string[] = []
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const runtime = {
      capability: 'chat',
      requiresToolApproval: false,
      supportsToolExecution: true,
      getStatus: vi.fn(),
      dispose: vi.fn(),
      async *run(
        _request: unknown,
        signal: AbortSignal
      ): AsyncGenerator<never, void, void> {
        markStarted()
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              lifecycle.push('aborted')
              reject(signal.reason)
            },
            { once: true }
          )
        })
        yield undefined as never
      }
    }
    const harness = createHarness(runtime, async () => {
      lifecycle.push('browser-cleared')
    })
    vi.mocked(
      harness.assistantDatabase.clearAssistantData
    ).mockImplementation(() => {
      lifecycle.push('assistant-cleared')
    })
    harness.handler?.(trustedEvent(harness.webContents), {
      requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
      conversationId: 'conversation-clear',
      prompt: 'keep running',
      workMode: 'execute'
    })
    await started

    await harness.clearHandler?.(trustedEvent(harness.webContents))

    expect(lifecycle).toEqual([
      'aborted',
      'browser-cleared',
      'assistant-cleared'
    ])
    await harness.dispose()
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
          summary: 'OpenCode 工具：write',
          error: 'write path denied'
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
        'write 工具执行失败：write path denied'
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
        status: 'failed',
        message: 'write 工具执行失败：write path denied'
      })
    )
    await harness.dispose()
  })

  it('allows a completed request after a recoverable tool failure', async () => {
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
          callId: 'call-recoverable',
          name: '浏览器输入',
          state: 'recoverable',
          summary: '直连模型工具需要刷新后重试：浏览器输入'
        }
        yield { requestId: request.requestId, type: 'done' }
      }
    }
    const harness = createHarness(runtime)
    const requestId = '3f496642-f47d-4e0a-8944-a32c77b0d6ef'

    harness.handler?.(trustedEvent(harness.webContents), {
      requestId,
      conversationId: 'conversation-1',
      prompt: 'retry browser input',
      workMode: 'execute'
    })

    await vi.waitFor(() =>
      expect(harness.assistantDatabase.updateTaskStatus).toHaveBeenCalledWith(
        requestId,
        'completed'
      )
    )
    expect(
      harness.assistantDatabase.updateTaskStatus
    ).not.toHaveBeenCalledWith(
      requestId,
      'failed',
      expect.any(String)
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

  it.each(['model', 'opencode'] as const)(
    'normalizes legacy interactive Plan requests to Ask for %s',
    async (runtimeId) => {
      let receivedRequest:
        | { requestId: string; prompt: string; workMode?: string }
        | undefined
      const runtime = {
        runtimeId,
        capability: 'chat',
        requiresToolApproval: false,
        supportsToolExecution: true,
        getStatus: vi.fn(),
        dispose: vi.fn(),
        async *run(request: {
          requestId: string
          prompt: string
          workMode?: string
        }) {
          receivedRequest = request
          yield { requestId: request.requestId, type: 'done' }
        }
      }
      const harness = createHarness(runtime)
      const requestId = '3f496642-f47d-4e0a-8944-a32c77b0d6ef'

      harness.handler?.(trustedEvent(harness.webContents), {
        requestId,
        conversationId: 'conversation-1',
        prompt: 'draft a plan',
        workMode: 'plan'
      })

      await vi.waitFor(() =>
        expect(
          harness.assistantDatabase.updateTaskStatus
        ).toHaveBeenCalledWith(requestId, 'completed')
      )
      expect(receivedRequest?.workMode).toBe('ask')
      expect(receivedRequest?.prompt).toContain('Work mode: Ask.')
      expect(receivedRequest?.prompt).not.toContain('Work mode: Plan.')
      expect(
        harness.assistantDatabase.createTask
      ).toHaveBeenCalledWith(
        expect.objectContaining({ id: requestId, workMode: 'ask' })
      )
      await harness.dispose()
    }
  )

  it('routes eligible Ask requests through the persisted smart expert service and publishes child events', async () => {
    const runtime = {
      capability: 'chat',
      requiresToolApproval: false,
      supportsToolExecution: true,
      getStatus: vi.fn(),
      dispose: vi.fn(),
      run: vi.fn()
    }
    const childTaskId = '00000000-0000-4000-8000-000000000099'
    const expert = {
      id: '00000000-0000-4000-8000-000000000001',
      name: '研究专家',
      description: '',
      systemInstructions: 'Analyze evidence.',
      routingKeywords: ['资料分析'],
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
    const subagentService = {
      run: vi.fn(async (input: {
        parentRequest: { requestId: string }
        onEvent: (event: Record<string, unknown>) => void
      }) => {
        for (const state of ['queued', 'running', 'completed']) {
          input.onEvent({
            requestId: input.parentRequest.requestId,
            type: 'subagent',
            childTaskId,
            expertId: expert.id,
            expertName: expert.name,
            routingMode: 'smart',
            state
          })
        }
        return { childTaskId, output: '专家结果' }
      }),
      cancelAll: vi.fn(),
      dispose: vi.fn(async () => undefined)
    }
    const harness = createHarness(
      runtime,
      undefined,
      'always',
      subagentService,
      true
    )
    vi.mocked(harness.assistantDatabase.listExperts).mockReturnValue([
      expert
    ])
    const requestId = '3f496642-f47d-4e0a-8944-a32c77b0d6ef'

    harness.handler?.(trustedEvent(harness.webContents), {
      requestId,
      conversationId: 'conversation-smart',
      prompt: '请做资料分析',
      workMode: 'ask',
      smartRouting: true
    })

    await vi.waitFor(() =>
      expect(harness.assistantDatabase.updateTaskStatus).toHaveBeenCalledWith(
        requestId,
        'completed'
      )
    )
    expect(runtime.run).not.toHaveBeenCalled()
    expect(subagentService.run).toHaveBeenCalledWith(
      expect.objectContaining({ expert, routingMode: 'smart' })
    )
    expect(harness.assistantDatabase.appendTaskEvent).toHaveBeenCalledWith(
      requestId,
      'subagent',
      expect.objectContaining({ childTaskId, state: 'queued' })
    )
    expect(harness.webContents.send).toHaveBeenCalledWith(
      ipcChannels.agentEvent,
      expect.objectContaining({ type: 'subagent', state: 'completed' })
    )
    await harness.dispose()
  })

  it.each([
    { workMode: 'ask' as const, persisted: false },
    { workMode: 'execute' as const, persisted: true }
  ])(
    'falls back to the ordinary runtime for ineligible smart routing %#',
    async ({ workMode, persisted }) => {
      const runtime = {
        capability: 'chat',
        requiresToolApproval: false,
        supportsToolExecution: true,
        getStatus: vi.fn(),
        dispose: vi.fn(),
        async *run(request: { requestId: string }) {
          yield { requestId: request.requestId, type: 'done' }
        }
      }
      const run = vi.spyOn(runtime, 'run')
      const subagentService = {
        run: vi.fn(),
        cancelAll: vi.fn(),
        dispose: vi.fn(async () => undefined)
      }
      const harness = createHarness(
        runtime,
        undefined,
        'always',
        subagentService,
        persisted
      )
      vi.mocked(harness.assistantDatabase.listExperts).mockReturnValue([
        {
          id: '00000000-0000-4000-8000-000000000001',
          name: '研究专家',
          description: '',
          systemInstructions: 'Analyze.',
          routingKeywords: ['资料分析'],
          enabled: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ])
      const requestId = '3f496642-f47d-4e0a-8944-a32c77b0d6ef'
      harness.handler?.(trustedEvent(harness.webContents), {
        requestId,
        conversationId: 'conversation-fallback',
        prompt: '请做资料分析',
        workMode,
        smartRouting: true
      })
      await vi.waitFor(() =>
        expect(harness.assistantDatabase.updateTaskStatus).toHaveBeenCalledWith(
          requestId,
          'completed'
        )
      )
      expect(run).toHaveBeenCalledOnce()
      expect(subagentService.run).not.toHaveBeenCalled()
      await harness.dispose()
    }
  )

  it('does not fall back to the ordinary runtime after smart subagent cancellation', async () => {
    const runtime = {
      capability: 'chat',
      requiresToolApproval: false,
      supportsToolExecution: true,
      getStatus: vi.fn(),
      dispose: vi.fn(),
      run: vi.fn()
    }
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const subagentService = {
      run: vi.fn((input: { signal: AbortSignal }) => {
        markStarted()
        return new Promise((_resolve, reject) => {
          input.signal.addEventListener(
            'abort',
            () => reject(input.signal.reason),
            { once: true }
          )
        })
      }),
      cancelAll: vi.fn(),
      dispose: vi.fn(async () => undefined)
    }
    const harness = createHarness(
      runtime,
      undefined,
      'always',
      subagentService,
      true
    )
    vi.mocked(harness.assistantDatabase.listExperts).mockReturnValue([
      {
        id: '00000000-0000-4000-8000-000000000001',
        name: '研究专家',
        description: '',
        systemInstructions: 'Analyze.',
        routingKeywords: ['资料分析'],
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ])
    const requestId = '3f496642-f47d-4e0a-8944-a32c77b0d6ef'
    harness.handler?.(trustedEvent(harness.webContents), {
      requestId,
      conversationId: 'conversation-cancel-smart',
      prompt: '请做资料分析',
      workMode: 'ask',
      smartRouting: true
    })
    await started
    harness.cancelHandler?.(trustedEvent(harness.webContents), requestId)

    await vi.waitFor(() =>
      expect(harness.assistantDatabase.updateTaskStatus).toHaveBeenCalledWith(
        requestId,
        'cancelled',
        '请求已取消'
      )
    )
    expect(runtime.run).not.toHaveBeenCalled()
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

  it('bridges channel requests to read-only delegation tasks without approval', async () => {
    let received:
      | {
          request: {
            requestId: string
            conversationId: string
            prompt: string
            workMode: string
          }
          authorize?: (request: {
            scopeKey: string
            title: string
            description: string
          }) => Promise<string>
        }
      | undefined
    const runtime = {
      capability: 'chat',
      async *run(
        request: {
          requestId: string
          conversationId: string
          prompt: string
          workMode: string
        },
        _signal: AbortSignal,
        authorize?: (request: {
          scopeKey: string
          title: string
          description: string
        }) => Promise<string>
      ) {
        received = { request, authorize }
        yield {
          requestId: request.requestId,
          type: 'text',
          delta: '只读结果'
        }
        yield { requestId: request.requestId, type: 'done' }
      }
    }
    const harness = createHarness(runtime)
    const executor = channelMocks.executor
    if (!executor) {
      throw new Error('Expected channel executor')
    }

    await expect(
      executor(
        {
          channel: 'wecom',
          eventId: 'event-1',
          senderId: 'user-1',
          conversationId: 'conversation-1',
          conversationType: 'direct',
          text: '请制定只读计划',
          mentioned: false,
          workMode: 'plan'
        },
        new AbortController().signal
      )
    ).resolves.toEqual({
      status: 'completed',
      output: '只读结果'
    })
    expect(received?.request).toMatchObject({
      workMode: 'plan',
      prompt: expect.stringContaining('请制定只读计划')
    })
    await expect(
      received?.authorize?.({
        scopeKey: 'model:builtin:workspace_read_text',
        title: '读取文件',
        description: '不应申请批准'
      })
    ).resolves.toBe('deny')
    expect(harness.approvalBroker.request).not.toHaveBeenCalled()
    expect(harness.assistantDatabase.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '企业微信远程请求',
        instructions: '请制定只读计划',
        workMode: 'plan',
        origin: 'delegation'
      })
    )
    await harness.dispose()
  })

  it('stops channels before clearing other IPC resources', async () => {
    const order: string[] = []
    channelMocks.stop.mockImplementationOnce(async () => {
      order.push('channel-stop')
    })
    const harness = createHarness({
      capability: 'chat',
      run: vi.fn()
    })
    harness.contextManager.clear.mockImplementation(() => {
      order.push('context-clear')
    })

    await harness.dispose()

    expect(order).toEqual(['channel-stop', 'context-clear'])
  })

  it('authorizes direct-model Execute tools without approval events or broker prompts', async () => {
    let receivedAuthorize:
      | ((
          request: {
            scopeKey: string
            title: string
            description: string
          }
        ) => Promise<string>)
      | undefined
    let decision: string | undefined
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
        decision = await authorize?.({
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
    expect(decision).toBe('once')
    expect(harness.approvalBroker.request).not.toHaveBeenCalled()
    expect(
      harness.assistantDatabase.updateTaskStatus
    ).not.toHaveBeenCalledWith(requestId, 'waiting_approval')
    expect(harness.webContents.send).not.toHaveBeenCalledWith(
      ipcChannels.agentEvent,
      expect.objectContaining({ type: 'approval' })
    )
    await harness.dispose()
  })

  it('denies direct-model Execute tools when the deny-all policy is selected', async () => {
    let decision: string | undefined
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
        authorize: (
          request: {
            scopeKey: string
            title: string
            description: string
          }
        ) => Promise<string>
      ) {
        decision = await authorize({
          scopeKey: 'model:builtin:workspace_read_text',
          title: '允许读取工作区文本？',
          description: '读取 README.md'
        })
        yield { requestId: request.requestId, type: 'done' }
      }
    }
    const harness = createHarness(runtime, undefined, 'policy')
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
    expect(decision).toBe('deny')
    expect(harness.approvalBroker.request).not.toHaveBeenCalled()
    expect(harness.webContents.send).not.toHaveBeenCalledWith(
      ipcChannels.agentEvent,
      expect.objectContaining({ type: 'approval' })
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
