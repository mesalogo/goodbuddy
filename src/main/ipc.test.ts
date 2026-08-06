import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
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
    }),
    openPath: vi.fn(async () => ''),
    showItemInFolder: vi.fn(),
    openExternal: vi.fn(async () => undefined)
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

const runtimeFactoryMocks = vi.hoisted(() => ({
  createModelProfileRuntime: vi.fn()
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
  },
  shell: {
    openPath: electronMocks.openPath,
    showItemInFolder: electronMocks.showItemInFolder,
    openExternal: electronMocks.openExternal
  }
}))

vi.mock('./assistant/heartbeat-service', () => ({
  HeartbeatService: class {
    async processDue(): Promise<void> {}
  }
}))

vi.mock('./agent/create-runtime', () => runtimeFactoryMocks)

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

describe('registerIpcHandlers connection tests', () => {
  afterEach(() => {
    electronMocks.handlers.clear()
    vi.clearAllMocks()
  })

  it('tests a resolved model profile without invoking the selected Continue Runtime', async () => {
    const profileId = '00000000-0000-4000-8000-000000000001'
    const profile = {
      id: profileId,
      name: '默认模型',
      baseUrl: 'https://models.example',
      modelName: 'good-model',
      protocol: 'anthropic-messages',
      authentication: 'api-key',
      imageGenerationQuality: 'auto',
      apiKey: 'main-only-secret' as string | undefined
    }
    const resolvedSettings = {
      provider: 'continue',
      workspacePath: 'C:\\Workspace',
      modelProfiles: [profile],
      defaultModelProfileId: profileId
    }
    const modelRuntime = {
      testConnection: vi.fn(async () => ({
        id: 'model',
        label: 'good-model',
        available: true,
        supportsToolExecution: true,
        detail: 'Ready'
      })),
      getStatus: vi.fn(),
      dispose: vi.fn(async () => undefined)
    }
    runtimeFactoryMocks.createModelProfileRuntime.mockReturnValue(
      modelRuntime
    )
    const continueRuntime = {
      testConnection: vi.fn(async () => {
        throw new Error('Continue 配置不可用')
      }),
      getStatus: vi.fn(),
      dispose: vi.fn(async () => undefined)
    }
    const getResolvedSettings = vi.fn(async () => resolvedSettings)
    const webContents = {
      mainFrame: { url: 'file:///goodbuddy/index.html' },
      getURL: vi.fn(() => 'file:///goodbuddy/index.html'),
      send: vi.fn()
    }
    const window = {
      webContents,
      isDestroyed: vi.fn(() => false),
      on: vi.fn(),
      removeListener: vi.fn()
    }
    const contextManager = { clear: vi.fn() }
    const approvalBroker = { clear: vi.fn() }
    const dispose = registerIpcHandlers(
      window as never,
      continueRuntime as never,
      'CommandOrControl+Shift+Space',
      { getResolvedSettings } as never,
      {} as never,
      contextManager as never,
      {} as never,
      { claimDueSchedules: vi.fn(() => []) } as never,
      approvalBroker as never,
      {} as never,
      vi.fn(async () => {})
    )
    const event = {
      sender: webContents,
      senderFrame: webContents.mainFrame
    }

    await expect(
      electronMocks.handlers.get(
        ipcChannels.runtimeSettingsTestModel
      )?.(event, profileId)
    ).resolves.toMatchObject({
      id: 'model',
      label: 'good-model',
      available: true
    })
    expect(getResolvedSettings).toHaveBeenCalledOnce()
    expect(
      runtimeFactoryMocks.createModelProfileRuntime
    ).toHaveBeenCalledWith('C:\\Workspace', resolvedSettings, profile)
    expect(modelRuntime.testConnection).toHaveBeenCalledOnce()
    expect(modelRuntime.dispose).toHaveBeenCalledOnce()
    expect(continueRuntime.testConnection).not.toHaveBeenCalled()

    await expect(
      electronMocks.handlers.get(
        ipcChannels.runtimeSettingsTestModel
      )?.(event, 'not-a-profile-id')
    ).rejects.toThrow()
    expect(getResolvedSettings).toHaveBeenCalledOnce()

    getResolvedSettings.mockResolvedValueOnce({
      ...resolvedSettings,
      modelProfiles: [{ ...profile, apiKey: undefined }]
    })
    runtimeFactoryMocks.createModelProfileRuntime.mockClear()
    modelRuntime.testConnection.mockClear()
    await expect(
      electronMocks.handlers.get(
        ipcChannels.runtimeSettingsTestModel
      )?.(event, profileId)
    ).rejects.toThrow('模型连接“默认模型”未配置 API Key')
    expect(getResolvedSettings).toHaveBeenCalledTimes(2)
    expect(
      runtimeFactoryMocks.createModelProfileRuntime
    ).not.toHaveBeenCalled()
    expect(modelRuntime.testConnection).not.toHaveBeenCalled()

    const noAuthProfile = {
      ...profile,
      authentication: 'none',
      apiKey: undefined
    }
    const noAuthSettings = {
      ...resolvedSettings,
      modelProfiles: [noAuthProfile]
    }
    getResolvedSettings.mockResolvedValueOnce(noAuthSettings)
    await expect(
      electronMocks.handlers.get(
        ipcChannels.runtimeSettingsTestModel
      )?.(event, profileId)
    ).resolves.toMatchObject({ available: true })
    expect(
      runtimeFactoryMocks.createModelProfileRuntime
    ).toHaveBeenCalledWith(
      'C:\\Workspace',
      noAuthSettings,
      noAuthProfile
    )
    expect(modelRuntime.testConnection).toHaveBeenCalledOnce()

    await dispose()
  })

  it('validates and tests the selected OpenCode or Continue Runtime', async () => {
    const selectedRuntimes = {
      getRuntime: vi.fn(),
      getStatus: vi.fn(),
      testStatus: vi.fn(async () => ({
        id: 'opencode',
        label: 'OpenCode',
        available: true,
        supportsToolExecution: true,
        detail: 'Ready'
      })),
      releaseConversation: vi.fn(async () => undefined)
    }
    const fallbackRuntime = {
      testConnection: vi.fn(async () => {
        throw new Error('不应测试旧的全局 Runtime')
      }),
      getStatus: vi.fn(),
      dispose: vi.fn(async () => undefined)
    }
    const webContents = {
      mainFrame: { url: 'file:///goodbuddy/index.html' },
      getURL: vi.fn(() => 'file:///goodbuddy/index.html'),
      send: vi.fn()
    }
    const window = {
      webContents,
      isDestroyed: vi.fn(() => false),
      on: vi.fn(),
      removeListener: vi.fn()
    }
    const dispose = registerIpcHandlers(
      window as never,
      fallbackRuntime as never,
      'CommandOrControl+Shift+Space',
      {} as never,
      {} as never,
      { clear: vi.fn() } as never,
      {} as never,
      { claimDueSchedules: vi.fn(() => []) } as never,
      { clear: vi.fn() } as never,
      {} as never,
      vi.fn(async () => {}),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      selectedRuntimes as never
    )
    const event = {
      sender: webContents,
      senderFrame: webContents.mainFrame
    }
    const selection = {
      provider: 'opencode' as const,
      profileId: '00000000-0000-4000-8000-000000000001'
    }

    await expect(
      electronMocks.handlers.get(ipcChannels.runtimeSettingsTest)?.(
        event,
        selection
      )
    ).resolves.toMatchObject({ id: 'opencode', available: true })
    expect(selectedRuntimes.testStatus).toHaveBeenCalledWith(selection)
    expect(fallbackRuntime.testConnection).not.toHaveBeenCalled()

    await expect(
      electronMocks.handlers.get(ipcChannels.runtimeSettingsTest)?.(
        event,
        { provider: 'opencode', profileId: 'not-a-uuid' }
      )
    ).rejects.toThrow()
    expect(selectedRuntimes.testStatus).toHaveBeenCalledOnce()

    await dispose()
  })
})

describe('registerIpcHandlers Runtime config actions', () => {
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

  it('opens only configured files or the fixed Runtime config directory', async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-runtime-config-')
    )
    temporaryDirectories.push(temporaryDirectory)
    const configPath = join(temporaryDirectory, 'config.yaml')
    await writeFile(configPath, 'name: Test', 'utf8')
    const getPublicSettings = vi.fn(async () => ({
      opencodeConfigPath: '',
      continueConfigPath: configPath
    }))
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
    const dispose = registerIpcHandlers(
      window as never,
      { capability: 'text' } as never,
      'CommandOrControl+Shift+Space',
      { getPublicSettings } as never,
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
    const canonicalConfigPath = await realpath(configPath)

    await electronMocks.handlers.get(
      ipcChannels.runtimeSettingsOpenConfig
    )?.(event, {
      runtime: 'continue',
      action: 'open-file'
    })
    expect(electronMocks.openPath).toHaveBeenCalledWith(
      canonicalConfigPath
    )

    await electronMocks.handlers.get(
      ipcChannels.runtimeSettingsOpenConfig
    )?.(event, {
      runtime: 'continue',
      action: 'show-file'
    })
    expect(electronMocks.showItemInFolder).toHaveBeenCalledWith(
      canonicalConfigPath
    )

    await expect(
      electronMocks.handlers.get(
        ipcChannels.runtimeSettingsOpenConfig
      )?.(event, {
        runtime: 'continue',
        action: 'open-file',
        path: join(temporaryDirectory, 'attacker-controlled.yaml')
      })
    ).rejects.toThrow()
    expect(getPublicSettings).toHaveBeenCalledTimes(2)

    getPublicSettings.mockResolvedValueOnce({
      opencodeConfigPath: '',
      continueConfigPath: process.execPath
    })
    await expect(
      electronMocks.handlers.get(
        ipcChannels.runtimeSettingsOpenConfig
      )?.(event, {
        runtime: 'continue',
        action: 'open-file'
      })
    ).rejects.toThrow('Runtime 配置文件类型不支持直接打开')
    expect(electronMocks.openPath).toHaveBeenCalledTimes(1)

    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = temporaryDirectory
    try {
      await electronMocks.handlers.get(
        ipcChannels.runtimeSettingsOpenConfig
      )?.(event, {
        runtime: 'opencode',
        action: 'open-directory'
      })
      expect(electronMocks.openPath).toHaveBeenLastCalledWith(
        await realpath(join(temporaryDirectory, 'opencode'))
      )
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome
      }
    }

    await expect(
      electronMocks.handlers.get(
        ipcChannels.runtimeSettingsOpenConfig
      )?.(
        {
          sender: {},
          senderFrame: webContents.mainFrame
        },
        {
          runtime: 'continue',
          action: 'open-directory'
        }
      )
    ).rejects.toThrow('拒绝来自未知窗口的 IPC 请求')
    await dispose()
  })
})

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
    smartRoutingEnabled = false,
    selectedRuntimes?: Record<string, unknown>,
    knowledgeServiceOverride?: Record<string, unknown>,
    knowledgeGateway?: Record<string, unknown>
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
      (knowledgeServiceOverride ?? {
        database: { listKnowledgeBases: vi.fn(() => []) }
      }) as never,
      assistantDatabase as never,
      approvalBroker as never,
      {} as never,
      vi.fn(async () => {}),
      onBeforeClearLocalData,
      undefined,
      subagentService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      selectedRuntimes as never,
      undefined,
      knowledgeGateway as never
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
      statusHandler: electronMocks.handlers.get(ipcChannels.agentStatus),
      cancelHandler: electronMocks.handlers.get(ipcChannels.agentCancel),
      knowledgeSearchHandler: electronMocks.handlers.get(
        ipcChannels.knowledgeSearch
      ),
      webContents
    }
  }

  const trustedEvent = (webContents: {
    mainFrame: { url: string }
  }) => ({
    sender: webContents,
    senderFrame: webContents.mainFrame
  })

  it('rejects unknown knowledge scope and creates no capability for empty scope', async () => {
    const libraryId = '11111111-1111-4111-8111-111111111111'
    const runtime = {
      runtimeId: 'model',
      capability: 'chat',
      supportsToolExecution: true,
      async *run(request: { requestId: string }) {
        yield { requestId: request.requestId, type: 'done' }
      }
    }
    const knowledgeGateway = {
      grant: vi.fn(() => 'capability'),
      drainReferences: vi.fn(() => []),
      revoke: vi.fn()
    }
    const harness = createHarness(
      runtime,
      undefined,
      'always',
      undefined,
      false,
      undefined,
      {
        database: {
          listKnowledgeBases: vi.fn(() => [
            { id: libraryId, name: 'Known' }
          ])
        }
      },
      knowledgeGateway
    )
    const event = trustedEvent(harness.webContents)

    await expect(
      harness.handler?.(event, {
        requestId: '00000000-0000-4000-8000-000000000021',
        conversationId: 'unknown-scope',
        prompt: 'test',
        workMode: 'ask',
        knowledgeLibraryIds: [
          '22222222-2222-4222-8222-222222222222'
        ]
      })
    ).rejects.toThrow('不存在的知识库')
    expect(knowledgeGateway.grant).not.toHaveBeenCalled()

    await harness.handler?.(event, {
      requestId: '00000000-0000-4000-8000-000000000022',
      conversationId: 'empty-scope',
      prompt: 'test',
      workMode: 'ask',
      knowledgeLibraryIds: []
    })
    await vi.waitFor(() =>
      expect(harness.assistantDatabase.updateTaskStatus).toHaveBeenCalledWith(
        '00000000-0000-4000-8000-000000000022',
        'completed'
      )
    )
    expect(knowledgeGateway.grant).not.toHaveBeenCalled()
    await harness.dispose()
  })

  it('accepts an authorized knowledge library after the first 100 entries', async () => {
    const libraries = Array.from({ length: 101 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${index
        .toString(16)
        .padStart(12, '0')}`,
      name: `Library ${index}`
    }))
    const listKnowledgeBases = vi.fn(() => libraries)
    const knowledgeGateway = {
      grant: vi.fn(() => 'capability'),
      drainReferences: vi.fn(() => []),
      revoke: vi.fn()
    }
    const runtime = {
      runtimeId: 'model',
      capability: 'chat',
      supportsToolExecution: true,
      async *run(request: { requestId: string }) {
        yield { requestId: request.requestId, type: 'done' }
      }
    }
    const harness = createHarness(
      runtime,
      undefined,
      'always',
      undefined,
      false,
      undefined,
      { database: { listKnowledgeBases } },
      knowledgeGateway
    )
    const requestId = '00000000-0000-4000-8000-000000000024'
    await expect(
      harness.handler?.(trustedEvent(harness.webContents), {
        requestId,
        conversationId: 'later-library',
        prompt: 'search',
        workMode: 'ask',
        knowledgeLibraryIds: [libraries[100]!.id]
      })
    ).resolves.toBeUndefined()
    await vi.waitFor(() =>
      expect(harness.assistantDatabase.updateTaskStatus).toHaveBeenCalledWith(
        requestId,
        'completed'
      )
    )
    expect(listKnowledgeBases).toHaveBeenCalledWith(500)
    expect(knowledgeGateway.grant).toHaveBeenCalledWith(
      requestId,
      [libraries[100]!.id],
      expect.any(AbortSignal)
    )
    await harness.dispose()
  })

  it('emits drained knowledge references immediately before done', async () => {
    const libraryId = '11111111-1111-4111-8111-111111111111'
    const reference = {
      libraryId,
      libraryName: 'Known',
      documentId: '33333333-3333-4333-8333-333333333333',
      documentName: 'Doc',
      sourceName: 'Source',
      snippet: 'Evidence',
      rank: 1
    }
    const runtime = {
      runtimeId: 'model',
      capability: 'chat',
      supportsToolExecution: true,
      async *run(request: {
        requestId: string
        knowledgeCapabilityToken?: string
      }) {
        expect(request.knowledgeCapabilityToken).toBe('capability')
        yield { requestId: request.requestId, type: 'done' }
      }
    }
    const knowledgeGateway = {
      grant: vi.fn(() => 'capability'),
      drainReferences: vi.fn(() => [reference]),
      revoke: vi.fn()
    }
    const harness = createHarness(
      runtime,
      undefined,
      'always',
      undefined,
      false,
      undefined,
      {
        database: {
          listKnowledgeBases: vi.fn(() => [
            { id: libraryId, name: 'Known' }
          ])
        }
      },
      knowledgeGateway
    )
    const requestId = '00000000-0000-4000-8000-000000000023'
    await harness.handler?.(trustedEvent(harness.webContents), {
      requestId,
      conversationId: 'scoped',
      prompt: 'search',
      workMode: 'ask',
      knowledgeLibraryIds: [libraryId, libraryId]
    })
    await vi.waitFor(() =>
      expect(harness.assistantDatabase.updateTaskStatus).toHaveBeenCalledWith(
        requestId,
        'completed'
      )
    )
    expect(knowledgeGateway.grant).toHaveBeenCalledWith(
      requestId,
      [libraryId],
      expect.any(AbortSignal)
    )
    const publicEvents = harness.webContents.send.mock.calls
      .filter(([channel]) => channel === ipcChannels.agentEvent)
      .map(([, payload]) => payload)
    expect(publicEvents.slice(-2)).toEqual([
      {
        requestId,
        type: 'source-references',
        references: [reference]
      },
      { requestId, type: 'done' }
    ])
    expect(knowledgeGateway.revoke).toHaveBeenCalledWith('capability')
    await harness.dispose()
  })

  it('returns no results for an explicitly empty knowledge search scope', async () => {
    const searchHybridMany = vi.fn(() => {
      throw new Error('must not search')
    })
    const harness = createHarness(
      {
        capability: 'chat',
        supportsToolExecution: true
      },
      undefined,
      'always',
      undefined,
      false,
      undefined,
      {
        database: { listKnowledgeBases: vi.fn(() => []) },
        searchHybridMany
      }
    )
    await expect(
      harness.knowledgeSearchHandler?.(
        trustedEvent(harness.webContents),
        { libraryIds: [], query: 'anything' }
      )
    ).resolves.toEqual([])
    expect(searchHybridMany).not.toHaveBeenCalled()
    await harness.dispose()
  })

  it('routes status and concurrent conversations to their selected runtimes', async () => {
    const firstProfileId = '00000000-0000-4000-8000-000000000001'
    const secondProfileId = '00000000-0000-4000-8000-000000000002'
    const firstSelection = {
      provider: 'model' as const,
      profileId: firstProfileId
    }
    const secondSelection = {
      provider: 'model' as const,
      profileId: secondProfileId
    }
    const firstRun = vi.fn()
    const secondRun = vi.fn()
    const createRuntime = (
      label: string,
      run: typeof firstRun
    ): Record<string, unknown> => ({
      runtimeId: 'model',
      capability: 'chat',
      requiresToolApproval: false,
      supportsToolExecution: true,
      getStatus: vi.fn(async () => ({
        id: 'model',
        label,
        available: true,
        supportsToolExecution: true
      })),
      dispose: vi.fn(async () => undefined),
      async *run(request: { requestId: string; conversationId: string }) {
        run(request)
        yield { requestId: request.requestId, type: 'done' }
      }
    })
    const firstRuntime = createRuntime('model-one', firstRun)
    const secondRuntime = createRuntime('model-two', secondRun)
    const selectedRuntimes = {
      getStatus: vi.fn(async () => ({
        id: 'model',
        label: 'model-two',
        available: true,
        supportsToolExecution: true
      })),
      getRuntime: vi.fn(async (selection: typeof firstSelection) =>
        selection.profileId === firstProfileId
          ? firstRuntime
          : secondRuntime
      ),
      releaseConversation: vi.fn(async () => undefined)
    }
    const fallbackRuntime = {
      runtimeId: 'model',
      capability: 'chat',
      requiresToolApproval: false,
      supportsToolExecution: true,
      getStatus: vi.fn(async () => ({
        id: 'model',
        label: 'fallback',
        available: true,
        supportsToolExecution: true
      })),
      run: vi.fn(),
      dispose: vi.fn(async () => undefined)
    }
    const harness = createHarness(
      fallbackRuntime,
      undefined,
      'always',
      undefined,
      false,
      selectedRuntimes
    )
    const event = trustedEvent(harness.webContents)

    await expect(
      harness.statusHandler?.(event, secondSelection)
    ).resolves.toEqual(
      expect.objectContaining({ label: 'model-two' })
    )
    expect(selectedRuntimes.getStatus).toHaveBeenCalledWith(
      secondSelection
    )

    await Promise.all([
      harness.handler?.(event, {
        requestId: '00000000-0000-4000-8000-000000000011',
        conversationId: 'conversation-one',
        prompt: 'first request',
        workMode: 'ask',
        runtimeSelection: firstSelection
      }),
      harness.handler?.(event, {
        requestId: '00000000-0000-4000-8000-000000000012',
        conversationId: 'conversation-two',
        prompt: 'second request',
        workMode: 'ask',
        runtimeSelection: secondSelection
      })
    ])

    await vi.waitFor(() => {
      expect(firstRun).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conversation-one',
          runtimeSelection: firstSelection
        })
      )
      expect(secondRun).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conversation-two',
          runtimeSelection: secondSelection
        })
      )
    })
    expect(fallbackRuntime.run).not.toHaveBeenCalled()
    expect(selectedRuntimes.getRuntime).toHaveBeenCalledWith(
      firstSelection
    )
    expect(selectedRuntimes.getRuntime).toHaveBeenCalledWith(
      secondSelection
    )
    await harness.dispose()
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
    'preserves read-only Ask mode at the %s Runtime boundary',
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
      expect(received?.request.workMode).toBe('ask')
      expect(received?.authorize).toBeUndefined()
      expect(harness.approvalBroker.request).not.toHaveBeenCalled()
      expect(
        harness.assistantDatabase.createTask
      ).toHaveBeenCalledWith(
        expect.objectContaining({ id: requestId, workMode: 'ask' })
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

    await expect(
      harness.handler?.(trustedEvent(harness.webContents), {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'write a file',
        workMode: 'execute'
      })
    ).rejects.toThrow('当前 Runtime 不支持工具执行')
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
