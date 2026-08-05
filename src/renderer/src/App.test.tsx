import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentEvent,
  BrowserLiveState,
  DesktopApi
} from '../../shared/contracts'
import App from './App'

let agentListener: ((event: AgentEvent) => void) | undefined
let browserListener: ((state: BrowserLiveState) => void) | undefined
let newConversationListener: (() => void) | undefined
let maximizedChangedListener: ((maximized: boolean) => void) | undefined
const removeMaximizedChangedListener = vi.fn()
const run = vi.fn<DesktopApi['agent']['run']>()
const modelProfileId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000101'
const project = {
  id: projectId,
  name: '默认项目',
  description: '测试项目',
  rootPath: 'C:\\Users\\test',
  defaultWorkMode: 'ask' as const,
  status: 'active' as const,
  createdAt: '2026-07-31T00:00:00.000Z',
  updatedAt: '2026-07-31T00:00:00.000Z'
}

const api: DesktopApi = {
  app: {
    getInfo: vi.fn(async () => ({
      name: 'GoodBuddy',
      version: '0.1.0',
      platform: 'win32',
      arch: 'x64',
      shortcut: 'CommandOrControl+Shift+Space'
    })),
    show: vi.fn(async () => {}),
    hide: vi.fn(async () => {}),
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    isMaximized: vi.fn(async () => false),
    onMaximizedChanged: vi.fn((listener) => {
      maximizedChangedListener = listener
      return removeMaximizedChangedListener
    }),
    clearLocalData: vi.fn(async () => {}),
    onNewConversation: vi.fn((listener) => {
      newConversationListener = listener
      return () => {
        newConversationListener = undefined
      }
    }),
    onOpenSettings: vi.fn(() => () => {})
  },
  agent: {
    getStatus: vi.fn<DesktopApi['agent']['getStatus']>(async () => ({
      id: 'model' as const,
      label: 'sonnet-5',
      available: true,
      supportsToolExecution: true,
      detail: 'Ready'
    })),
    run,
    cancel: vi.fn(async () => {}),
    respondApproval: vi.fn(async () => {}),
    onEvent: vi.fn((listener) => {
      agentListener = listener
      return () => {
        agentListener = undefined
      }
    })
  },
  browser: {
    stop: vi.fn(async () => {}),
    onState: vi.fn((listener) => {
      browserListener = listener
      return () => {
        browserListener = undefined
      }
    })
  },
  settings: {
    getRuntime: vi.fn<DesktopApi['settings']['getRuntime']>(async () => ({
      provider: 'auto',
      modelBaseUrl: 'https://bigtoken.ai',
      modelName: 'sonnet-5',
      modelProtocol: 'anthropic-messages',
      modelAuthentication: 'api-key',
      imageGenerationQuality: 'auto',
      opencodeBaseUrl: '',
      opencodeEmbedded: false,
      opencodeBinaryPath: '',
      opencodeConfigPath: '',
      continueBinaryPath: '',
      continueConfigPath: '',
      continueMode: 'chat',
      runtimeSandboxMode: 'auto',
      subagentSmartRoutingEnabled: false,
      knowledgeEmbeddingEnabled: false,
      knowledgeEmbeddingBaseUrl:
        'http://127.0.0.1:11434/v1/embeddings',
      knowledgeEmbeddingModel: 'nomic-embed-text',
      knowledgeEmbeddingApiKeyConfigured: false,
      knowledgeEmbeddingCredentialSource: 'none',
      workspacePath: 'C:\\Users\\test',
      apiKeyConfigured: false,
      credentialSource: 'none',
      modelProfiles: [
        {
          id: modelProfileId,
          name: '默认模型',
          baseUrl: 'https://bigtoken.ai',
          modelName: 'sonnet-5',
          protocol: 'anthropic-messages',
          authentication: 'api-key',
          imageGenerationQuality: 'auto',
          apiKeyConfigured: false,
          credentialSource: 'none'
        }
      ],
      defaultModelProfileId: modelProfileId,
      opencodeModelSource: { kind: 'platform' },
      continueModelSource: { kind: 'platform' },
      secureStorageAvailable: true,
      toolApproval: 'always'
    })),
    updateRuntime: vi.fn<DesktopApi['settings']['updateRuntime']>(
      async (input) => ({
        provider: input.provider,
        modelBaseUrl: input.modelBaseUrl,
        modelName: input.modelName,
        modelProtocol: input.modelProtocol,
        modelAuthentication: input.modelAuthentication,
        imageGenerationQuality: input.imageGenerationQuality,
        opencodeBaseUrl: input.opencodeBaseUrl,
        opencodeEmbedded: input.opencodeEmbedded,
        opencodeBinaryPath: input.opencodeBinaryPath,
        opencodeConfigPath: input.opencodeConfigPath,
        continueBinaryPath: input.continueBinaryPath,
        continueConfigPath: input.continueConfigPath,
        continueMode: input.continueMode,
        runtimeSandboxMode: input.runtimeSandboxMode,
        subagentSmartRoutingEnabled:
          input.subagentSmartRoutingEnabled ?? false,
        knowledgeEmbeddingEnabled: input.knowledgeEmbeddingEnabled,
        knowledgeEmbeddingBaseUrl: input.knowledgeEmbeddingBaseUrl,
        knowledgeEmbeddingModel: input.knowledgeEmbeddingModel,
        knowledgeEmbeddingApiKeyConfigured:
          input.knowledgeEmbeddingApiKey?.action === 'replace',
        knowledgeEmbeddingCredentialSource:
          input.knowledgeEmbeddingApiKey?.action === 'replace'
            ? 'encrypted'
            : 'none',
        workspacePath: input.workspacePath,
        apiKeyConfigured: input.apiKey.action === 'replace',
        credentialSource:
          input.apiKey.action === 'replace' ? 'encrypted' : 'none',
        modelProfiles: (
          input.modelProfiles ?? [
            {
              id: modelProfileId,
              name: '默认模型',
              baseUrl: input.modelBaseUrl,
              modelName: input.modelName,
              protocol: input.modelProtocol,
              authentication: input.modelAuthentication,
              imageGenerationQuality:
                input.imageGenerationQuality,
              apiKey: input.apiKey
            }
          ]
        ).map(({ apiKey, ...profile }) => ({
          ...profile,
          apiKeyConfigured: apiKey.action === 'replace',
          credentialSource:
            apiKey.action === 'replace'
              ? ('encrypted' as const)
              : ('none' as const)
        })),
        defaultModelProfileId:
          input.defaultModelProfileId ?? modelProfileId,
        opencodeModelSource:
          input.opencodeModelSource ?? { kind: 'platform' },
        continueModelSource:
          input.continueModelSource ?? { kind: 'platform' },
        secureStorageAvailable: true,
        toolApproval: input.toolApproval
      })
    ),
    selectWorkspace: vi.fn(async () => undefined),
    detectAgentRuntimes: vi.fn<
      DesktopApi['settings']['detectAgentRuntimes']
    >(async () => ({
      opencode: {
        available: false,
        detail: '未检测到 OpenCode'
      },
      continue: {
        available: false,
        detail: '未检测到 Continue'
      }
    })),
    selectRuntimeFile: vi.fn(async () => undefined),
    testRuntime: vi.fn<DesktopApi['settings']['testRuntime']>(
      async () => ({
        id: 'model',
        label: 'sonnet-5',
        available: true,
        supportsToolExecution: true,
        detail: 'Ready'
      })
    )
  },
  projects: {
    list: vi.fn(async () => [project]),
    create: vi.fn(async (input) => ({
      ...project,
      ...input,
      id: crypto.randomUUID()
    })),
    update: vi.fn(async (_projectId, input) => ({
      ...project,
      ...input,
      id: _projectId
    })),
    setArchived: vi.fn(async () => {})
  },
  conversations: {
    list: vi.fn(async () => []),
    replace: vi.fn(async () => {})
  },
  workspace: {
    getChanges: vi.fn(async () => ({
      rootPath: 'C:\\Workspace',
      available: true,
      status: '',
      patch: '',
      files: [],
      truncated: false
    })),
    listDirectory: vi.fn(async (path: string) => ({
      path,
      entries: [],
      truncated: false
    })),
    readFile: vi.fn(async (path: string) => ({
      path,
      name: path.split('/').at(-1) ?? path,
      content: '',
      mimeType: 'text/plain' as const,
      size: 0
    }))
  },
  tasks: {
    list: vi.fn(async () => []),
    setStatus: vi.fn(async () => {})
  },
  usage: {
    getTokenSummary: vi.fn(async () => ({
      totals: {
        callCount: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0
      },
      records: []
    }))
  },
  artifacts: {
    list: vi.fn(async () => []),
    get: vi.fn(async () => {
      throw new Error('Artifact not found')
    }),
    importFiles: vi.fn(async () => [])
  },
  memory: {
    list: vi.fn(async () => []),
    create: vi.fn(async (input) => ({
      ...input,
      id: crypto.randomUUID(),
      confidence: 1,
      salience: 1,
      status: 'confirmed' as const,
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z'
    })),
    setStatus: vi.fn(async () => {}),
    remove: vi.fn(async () => {})
  },
  schedules: {
    list: vi.fn(async () => []),
    create: vi.fn(async (input) => ({
      ...input,
      id: crypto.randomUUID(),
      enabled: true,
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z'
    })),
    setEnabled: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    runNow: vi.fn(async () => {})
  },
  heartbeats: {
    list: vi.fn(async () => []),
    create: vi.fn(async (input) => ({
      ...input,
      id: crypto.randomUUID(),
      nextRunAt: '2026-08-01T09:00:00.000Z',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z'
    })),
    update: vi.fn(async (heartbeatId, input) => ({
      ...input,
      id: heartbeatId,
      nextRunAt: '2026-08-01T09:00:00.000Z',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z'
    })),
    setPaused: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    runNow: vi.fn(async (heartbeatId) => ({
      id: crypto.randomUUID(),
      configId: heartbeatId,
      trigger: 'manual' as const,
      scheduledFor: '2026-08-01T00:00:00.000Z',
      status: 'completed' as const,
      attemptCount: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z'
    })),
    history: vi.fn(async () => ({ runs: [], entries: [] }))
  },
  experts: {
    list: vi.fn(async () => []),
    create: vi.fn(async (input) => ({
      ...input,
      id: crypto.randomUUID(),
      enabled: true,
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z'
    })),
    update: vi.fn(async (expertId, input) => ({
      ...input,
      id: expertId,
      enabled: true,
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-08-04T00:00:00.000Z'
    })),
    remove: vi.fn(async () => {})
  },
  capabilities: {
    getSnapshot: vi.fn(async () => ({
      skills: [],
      mcpServers: []
    })),
    importSkill: vi.fn(async () => ({
      skills: [],
      mcpServers: []
    })),
    removeSkill: vi.fn(async () => ({
      skills: [],
      mcpServers: []
    })),
    setSkillEnabled: vi.fn(async () => ({
      skills: [],
      mcpServers: []
    })),
    setSkillAssignments: vi.fn(async () => ({
      skills: [],
      mcpServers: []
    })),
    saveMcpServer: vi.fn(async () => ({
      skills: [],
      mcpServers: []
    })),
    removeMcpServer: vi.fn(async () => ({
      skills: [],
      mcpServers: []
    })),
    testMcpServer: vi.fn(async () => ({
      toolCount: 0,
      tools: []
    }))
  },
  context: {
    selectFiles: vi.fn(async () => []),
    captureScreen: vi.fn(async () => {
      throw new Error('not used')
    }),
    listWindows: vi.fn(async () => []),
    captureWindow: vi.fn(async () => {
      throw new Error('not used')
    }),
    readClipboard: vi.fn(async () => {
      throw new Error('not used')
    }),
    remove: vi.fn(async () => {})
  },
  knowledge: {
    getSnapshot: vi.fn(async () => ({
      libraries: [],
      sources: [],
      documents: [],
      graphNodes: [],
      graphRelations: [],
      evidence: []
    })),
    createLibrary: vi.fn(async (input) => ({
      ...input,
      id: crypto.randomUUID(),
      sourceCount: 0,
      documentCount: 0,
      indexedDocumentCount: 0
    })),
    updateLibrary: vi.fn(async () => {}),
    deleteLibrary: vi.fn(async () => {}),
    selectFiles: vi.fn(async () => {}),
    selectDirectory: vi.fn(async () => {}),
    importDroppedFiles: vi.fn(async () => {}),
    importUrl: vi.fn(async () => {}),
    syncSource: vi.fn(async () => {}),
    pauseSource: vi.fn(async () => {}),
    retrySource: vi.fn(async () => {}),
    removeSource: vi.fn(async () => {}),
    search: vi.fn(async () => []),
    createEntity: vi.fn(async () => {}),
    updateEntity: vi.fn(async () => {}),
    moveEntity: vi.fn(async () => {}),
    deleteEntity: vi.fn(async () => {}),
    mergeEntities: vi.fn(async () => {}),
    createRelation: vi.fn(async () => {}),
    updateRelation: vi.fn(async () => {}),
    deleteRelation: vi.fn(async () => {})
  }
}

describe('App', () => {
  beforeEach(() => {
    localStorage.clear()
    delete document.documentElement.dataset.theme
    document.documentElement.style.colorScheme = ''
    vi.clearAllMocks()
    newConversationListener = undefined
    browserListener = undefined
    maximizedChangedListener = undefined
    vi.mocked(api.agent.getStatus).mockResolvedValue({
      id: 'model',
      label: 'sonnet-5',
      available: true,
      supportsToolExecution: true,
      detail: 'Ready'
    })
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: api
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('provides custom minimize, maximize, and close controls', async () => {
    const { unmount } = render(<App />)

    fireEvent.click(screen.getByLabelText('最小化窗口'))
    fireEvent.click(screen.getByLabelText('最大化窗口'))
    fireEvent.click(screen.getByLabelText('关闭窗口'))

    await waitFor(() => {
      expect(api.app.minimize).toHaveBeenCalledOnce()
      expect(api.app.toggleMaximize).toHaveBeenCalledOnce()
      expect(api.app.close).toHaveBeenCalledOnce()
    })
    act(() => maximizedChangedListener?.(true))
    expect(await screen.findByLabelText('还原窗口')).toBeInTheDocument()
    act(() => maximizedChangedListener?.(false))
    expect(screen.getByLabelText('最大化窗口')).toBeInTheDocument()

    unmount()
    expect(removeMaximizedChangedListener).toHaveBeenCalledOnce()
  })

  it('keeps rendering when an older preload has no browser bridge', async () => {
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        ...api,
        browser: undefined
      }
    })

    render(<App />)

    expect(
      await screen.findByLabelText('向 GoodBuddy 提问')
    ).toBeInTheDocument()
  })

  it('keeps conversation actions in the conversation list', async () => {
    const { container } = render(<App />)
    const topbar = container.querySelector<HTMLElement>('.topbar')
    const conversationList =
      container.querySelector<HTMLElement>('.conversation-list')
    expect(topbar).not.toBeNull()
    expect(conversationList).not.toBeNull()
    if (!topbar || !conversationList) {
      return
    }

    expect(within(topbar).queryByLabelText('专家角色')).not.toBeInTheDocument()
    expect(screen.getByLabelText('专家角色').closest('.composer')).not.toBeNull()

    const appMenuTrigger = within(topbar).getByLabelText('应用菜单')
    fireEvent.click(appMenuTrigger)
    expect(
      screen.queryByRole('menuitem', { name: '重命名会话' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: '安全与 Runtime 设置' })
    ).toBeVisible()
    await waitFor(() =>
      expect(
        screen.getByRole('menuitem', { name: '安全与 Runtime 设置' })
      ).toHaveFocus()
    )
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: '使用帮助' })).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(appMenuTrigger).toHaveFocus()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    const conversationMenuTrigger = within(
      conversationList
    ).getByLabelText('更多会话操作 新对话')
    fireEvent.click(conversationMenuTrigger)
    const renameButton = within(conversationList).getByRole('button', {
      name: '重命名会话'
    })
    expect(renameButton).toBeVisible()
    expect(
      within(conversationList).getByRole('button', {
        name: '复制完整会话'
      })
    ).toBeVisible()
    expect(
      within(conversationList).getByRole('button', {
        name: '导出 Markdown'
      })
    ).toBeVisible()

    fireEvent.click(renameButton)
    const renameInput = within(conversationList).getByLabelText(
      '重命名会话 新对话'
    )
    fireEvent.change(renameInput, {
      target: { value: '重命名后的会话' }
    })
    fireEvent.submit(renameInput.closest('form')!)
    expect(
      within(conversationList).getByText('重命名后的会话')
    ).toBeInTheDocument()
    await waitFor(() => expect(conversationMenuTrigger).toHaveFocus())

    fireEvent.click(screen.getByRole('button', { name: '知识库' }))
    fireEvent.click(
      within(conversationList).getByLabelText(
        '更多会话操作 重命名后的会话'
      )
    )
    fireEvent.click(
      within(conversationList).getByRole('button', {
        name: '复制完整会话'
      })
    )
    expect(await screen.findByRole('status')).toBeVisible()
  })

  it('sends a prompt and renders streamed agent content', async () => {
    render(<App />)

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '帮我分析项目' }
    })
    await waitFor(() => expect(screen.getByLabelText('发送')).toBeEnabled())
    fireEvent.click(screen.getByLabelText('发送'))

    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    expect(request?.prompt).toBe('帮我分析项目')
    const userMessage = screen
      .getAllByText('帮我分析项目')
      .map((element) => element.closest('article'))
      .find((element) => element?.classList.contains('message--user'))
    expect(userMessage).toHaveClass('message--user')

    act(() => {
      if (!request) {
        throw new Error('Missing request')
      }
      agentListener?.({
        requestId: request.requestId,
        type: 'text',
        delta: '这是'
      })
      agentListener?.({
        requestId: request.requestId,
        type: 'text',
        delta: '回答内容'
      })
      agentListener?.({
        requestId: request.requestId,
        type: 'done'
      })
    })

    expect(await screen.findByText('这是回答内容')).toBeInTheDocument()
    expect(screen.getByText('项目：默认项目')).toHaveClass('scope-badge')
  })

  it('keeps a running response visible when cancellation fails', async () => {
    vi.mocked(api.agent.cancel).mockRejectedValueOnce(
      new Error('cancel failed')
    )
    render(<App />)

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '开始一个长任务' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())

    fireEvent.click(await screen.findByLabelText('停止生成'))

    await waitFor(() =>
      expect(api.agent.cancel).toHaveBeenCalledOnce()
    )
    expect(
      await screen.findByText(/停止生成失败，请重试/u)
    ).toBeInTheDocument()
    expect(screen.getByLabelText('停止生成')).toBeInTheDocument()
  })

  it('keeps sent documents and images in conversation history', async () => {
    const documentAttachment = {
      id: '00000000-0000-4000-8000-000000000301',
      name: '需求说明.md',
      size: 2_048,
      preview: '需要保留在用户消息中的文档',
      kind: 'text' as const
    }
    const imageAttachment = {
      id: '00000000-0000-4000-8000-000000000302',
      name: '页面截图.png',
      size: 4_096,
      preview: '1280 × 720',
      kind: 'image' as const,
      thumbnailUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
      contentUrl:
        'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2Q=='
    }
    vi.mocked(api.context.selectFiles).mockResolvedValueOnce([
      documentAttachment,
      imageAttachment
    ])
    render(<App />)

    fireEvent.click(await screen.findByLabelText('添加附件'))
    expect(await screen.findByText('需求说明.md')).toBeInTheDocument()
    expect(screen.getByText('页面截图.png')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '分析这些附件' }
    })
    fireEvent.click(screen.getByLabelText('发送'))

    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(run.mock.calls[0]?.[0].contextIds).toEqual([
      documentAttachment.id,
      imageAttachment.id
    ])
    const userArticle = screen
      .getAllByText('分析这些附件')
      .map((element) => element.closest('article'))
      .find((element) => element?.classList.contains('message--user'))
    expect(userArticle).not.toBeNull()
    if (!userArticle) {
      return
    }
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})
    expect(within(userArticle).getByText('需求说明.md')).toBeInTheDocument()
    expect(within(userArticle).getByText('2 KB')).toBeInTheDocument()
    expect(
      within(userArticle).getByRole('img', { name: '页面截图.png' })
    ).toHaveAttribute('src', imageAttachment.contentUrl)
    fireEvent.click(
      within(userArticle).getByRole('button', {
        name: '查看图片 页面截图.png'
      })
    )
    const imageDialog = await screen.findByRole('dialog', {
      name: '页面截图.png'
    })
    expect(
      within(imageDialog).getByRole('img', { name: '页面截图.png' })
    ).toHaveAttribute('src', imageAttachment.contentUrl)
    fireEvent.click(
      within(imageDialog).getByRole('button', {
        name: '关闭图片查看器'
      })
    )
    expect(
      screen.queryByRole('dialog', { name: '页面截图.png' })
    ).not.toBeInTheDocument()
    fireEvent.click(
      within(userArticle).getByRole('button', {
        name: '下载图片 页面截图.png'
      })
    )
    expect(anchorClick).toHaveBeenCalledOnce()
    await waitFor(
      () =>
        expect(api.conversations.replace).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              messages: expect.arrayContaining([
                expect.objectContaining({
                  role: 'user',
                  attachments: [
                    documentAttachment,
                    imageAttachment
                  ]
                })
              ])
            })
          ])
        ),
      { timeout: 2_000 }
    )
  })

  it('sends and renders five selected images together', async () => {
    const imageAttachments = Array.from({ length: 5 }, (_, index) => ({
      id: `00000000-0000-4000-8000-00000000031${index}`,
      name: `参考图-${index + 1}.png`,
      size: 4_096,
      preview: '640 × 480',
      kind: 'image' as const,
      thumbnailUrl:
        'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2Q==',
      contentUrl:
        'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2Q=='
    }))
    vi.mocked(api.context.selectFiles).mockResolvedValueOnce(imageAttachments)
    render(<App />)

    fireEvent.click(await screen.findByLabelText('添加附件'))
    await waitFor(() =>
      expect(screen.getAllByText(/^参考图-\d\.png$/u)).toHaveLength(5)
    )
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '比较这五张图片' }
    })
    fireEvent.click(screen.getByLabelText('发送'))

    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(run.mock.calls[0]?.[0].contextIds).toEqual(
      imageAttachments.map((attachment) => attachment.id)
    )
    const userArticle = screen
      .getAllByText('比较这五张图片')
      .map((element) => element.closest('article'))
      .find((element) => element?.classList.contains('message--user'))
    expect(userArticle).not.toBeNull()
    if (!userArticle) {
      return
    }
    expect(within(userArticle).getAllByRole('img')).toHaveLength(5)
    expect(within(userArticle).getByLabelText('消息附件')).toHaveClass(
      'message-attachments'
    )
  })

  it('lists capturable application windows vertically before capture', async () => {
    vi.mocked(api.context.listWindows).mockResolvedValueOnce([
      { id: 'window-1', name: 'Visual Studio Code' },
      { id: 'window-2', name: 'Browser' },
      { id: 'window-3', name: 'Terminal' }
    ])
    vi.mocked(api.context.captureWindow).mockResolvedValueOnce({
      id: '00000000-0000-4000-8000-000000000303',
      name: '窗口-Browser.jpg',
      size: 120_000,
      preview: '1280 × 800',
      kind: 'image',
      thumbnailUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
    })
    render(<App />)

    fireEvent.click(await screen.findByLabelText('捕获应用窗口'))

    const dialog = await screen.findByRole('dialog', {
      name: '选择应用窗口'
    })
    const list = within(dialog).getByLabelText('可捕获的应用窗口')
    expect(list).toHaveClass('window-capture-dialog__list')
    expect(within(list).getAllByRole('button')).toHaveLength(3)

    fireEvent.click(
      within(list).getByRole('button', { name: 'Browser' })
    )
    await waitFor(() =>
      expect(api.context.captureWindow).toHaveBeenCalledWith('window-2')
    )
    expect(
      await screen.findByText('窗口-Browser.jpg')
    ).toBeInTheDocument()
  })

  it('keeps a draft in chat when Enter is pressed while the runtime loads', async () => {
    vi.mocked(api.agent.getStatus).mockReturnValue(
      new Promise(() => {})
    )
    render(<App />)

    const composer = screen.getByLabelText('向 GoodBuddy 提问')
    fireEvent.change(composer, {
      target: { value: '等待 Runtime' }
    })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(composer).toHaveValue('等待 Runtime')
    expect(
      screen.queryByRole('heading', { name: '设置中心' })
    ).not.toBeInTheDocument()
    expect(
      await screen.findByText('Agent Runtime 正在加载，请稍后重试')
    ).toBeInTheDocument()
    expect(run).not.toHaveBeenCalled()
  })

  it('keeps a new-conversation draft in chat when the runtime is unavailable', async () => {
    vi.mocked(api.agent.getStatus).mockResolvedValue({
      id: 'setup',
      label: '需要配置模型',
      available: false,
      supportsToolExecution: false,
      detail: '请配置模型'
    })
    render(<App />)

    expect(
      await screen.findByRole('heading', { name: '设置中心' })
    ).toBeInTheDocument()
    const newConversation = screen.getByRole('button', {
      name: /新建对话/u
    })
    fireEvent.click(newConversation)

    const composer = screen.getByLabelText('向 GoodBuddy 提问')
    await waitFor(() => expect(composer).toHaveFocus())
    fireEvent.change(composer, {
      target: { value: '保留这条草稿' }
    })
    fireEvent.keyDown(composer, { key: 'Enter' })

    expect(composer).toHaveValue('保留这条草稿')
    expect(
      screen.queryByRole('heading', { name: '设置中心' })
    ).not.toBeInTheDocument()
    expect(
      await screen.findByText(/请先配置可用的模型或 Agent Runtime/u)
    ).toBeInTheDocument()
    expect(run).not.toHaveBeenCalled()
  })

  it('opens chat and focuses the composer for tray conversations', async () => {
    render(<App />)

    fireEvent.click(await screen.findByText('本地工作区'))
    expect(
      await screen.findByRole('heading', { name: '设置中心' })
    ).toBeInTheDocument()

    act(() => newConversationListener?.())

    const composer = await screen.findByLabelText('向 GoodBuddy 提问')
    await waitFor(() => expect(composer).toHaveFocus())
  })

  it('reuses the active empty conversation and preserves its draft', async () => {
    render(<App />)

    const composer = await screen.findByLabelText('向 GoodBuddy 提问')
    fireEvent.change(composer, {
      target: { value: '尚未发送的草稿' }
    })
    const newConversation = screen.getByRole('button', {
      name: /新建对话/u
    })
    fireEvent.click(newConversation)
    fireEvent.click(newConversation)

    expect(composer).toHaveValue('尚未发送的草稿')
    expect(
      screen.getAllByRole('button', { name: '删除对话 新对话' })
    ).toHaveLength(1)
  })

  it('coalesces batched new-conversation requests after a used conversation', async () => {
    render(<App />)

    fireEvent.change(await screen.findByLabelText('向 GoodBuddy 提问'), {
      target: { value: '已有内容' }
    })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const requestId = run.mock.calls[0]?.[0].requestId
    act(() => {
      if (requestId) {
        agentListener?.({ requestId, type: 'done' })
      }
      newConversationListener?.()
      newConversationListener?.()
    })

    expect(
      screen.getAllByRole('button', { name: /^删除对话/u })
    ).toHaveLength(2)
  })

  it('opens a workspace Markdown file in the right-side preview', async () => {
    vi.mocked(api.workspace.listDirectory).mockResolvedValue({
      path: '',
      entries: [
        {
          name: 'README.md',
          path: 'README.md',
          type: 'file'
        }
      ],
      truncated: false
    })
    vi.mocked(api.workspace.readFile).mockResolvedValue({
      path: 'README.md',
      name: 'README.md',
      content: '# 工作区说明',
      mimeType: 'text/markdown',
      size: 19
    })
    render(<App />)

    fireEvent.click(screen.getByLabelText('切换助手工作栏'))
    fireEvent.click(await screen.findByRole('tab', { name: '工作区' }))
    fireEvent.click(
      await screen.findByRole('button', { name: /README\.md/u })
    )

    expect(
      await screen.findByRole('heading', { name: '工作区说明' })
    ).toBeInTheDocument()
    expect(api.workspace.readFile).toHaveBeenCalledWith(
      projectId,
      'README.md'
    )
  })

  it('refreshes generated workspace files when a run completes', async () => {
    vi.mocked(api.workspace.getChanges)
      .mockResolvedValueOnce({
        rootPath: project.rootPath,
        available: true,
        status: '',
        patch: '',
        files: [],
        truncated: false
      })
      .mockResolvedValueOnce({
        rootPath: project.rootPath,
        available: true,
        status: '?? generated.md',
        patch: '',
        files: [{ path: 'generated.md', status: '??' }],
        truncated: false
      })
    render(<App />)

    fireEvent.click(screen.getByLabelText('切换助手工作栏'))
    fireEvent.click(await screen.findByRole('tab', { name: '工作区' }))
    await waitFor(() =>
      expect(api.workspace.getChanges).toHaveBeenCalledOnce()
    )
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '生成文件' }
    })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const requestId = run.mock.calls[0]?.[0].requestId
    act(() => {
      if (requestId) {
        agentListener?.({ requestId, type: 'done' })
      }
    })

    expect(await screen.findByText('generated.md')).toBeInTheDocument()
  })

  it('ignores stale Git changes after switching projects', async () => {
    const secondProject = {
      ...project,
      id: '00000000-0000-4000-8000-000000000102',
      name: '第二项目',
      rootPath: 'C:\\Second'
    }
    vi.mocked(api.projects.list).mockResolvedValueOnce([
      project,
      secondProject
    ])
    let resolveFirst:
      | ((value: Awaited<ReturnType<DesktopApi['workspace']['getChanges']>>) => void)
      | undefined
    let resolveSecond:
      | ((value: Awaited<ReturnType<DesktopApi['workspace']['getChanges']>>) => void)
      | undefined
    vi.mocked(api.workspace.getChanges)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve
          })
      )
    render(<App />)

    fireEvent.click(screen.getByLabelText('切换助手工作栏'))
    fireEvent.click(await screen.findByRole('tab', { name: '工作区' }))
    await waitFor(() =>
      expect(api.workspace.getChanges).toHaveBeenCalledWith(projectId)
    )
    fireEvent.change(screen.getByLabelText('当前项目'), {
      target: { value: secondProject.id }
    })
    await waitFor(() =>
      expect(api.workspace.getChanges).toHaveBeenCalledWith(
        secondProject.id
      )
    )

    resolveSecond?.({
      rootPath: secondProject.rootPath,
      available: true,
      status: '?? second.md',
      patch: '',
      files: [{ path: 'second.md', status: '??' }],
      truncated: false
    })
    expect(await screen.findByText('second.md')).toBeInTheDocument()
    resolveFirst?.({
      rootPath: project.rootPath,
      available: true,
      status: '?? stale.md',
      patch: '',
      files: [{ path: 'stale.md', status: '??' }],
      truncated: false
    })

    await waitFor(() =>
      expect(screen.queryByText('stale.md')).not.toBeInTheDocument()
    )
    expect(screen.getByText('second.md')).toBeInTheDocument()
  })

  it('applies and persists a dark appearance from Settings', async () => {
    render(<App />)

    fireEvent.click(await screen.findByText('本地工作区'))
    fireEvent.click(screen.getByRole('tab', { name: '外观' }))
    fireEvent.click(screen.getByRole('radio', { name: /暗色/u }))

    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe('dark')
    )
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(localStorage.getItem('goodbuddy.appearance-theme')).toBe(
      'dark'
    )
  })

  it('loads token usage in activity and refreshes it when a run finishes', async () => {
    vi.mocked(api.usage.getTokenSummary).mockResolvedValueOnce({
      totals: {
        callCount: 1,
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 120
      },
      records: [
        {
          requestId: 'usage-request-1',
          projectId,
          projectName: project.name,
          conversationId: 'usage-conversation-1',
          conversationTitle: '用量会话',
          runtime: 'model',
          provider: 'anthropic',
          model: 'sonnet-5',
          callCount: 1,
          input: 100,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 120
        }
      ]
    })

    render(<App />)
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '统计用量' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    if (!request) {
      throw new Error('Missing request')
    }

    fireEvent.click(screen.getByText('任务与活动'))
    const stats = await screen.findByLabelText('Token 用量统计')
    expect(
      screen.getByRole('heading', { level: 1, name: '任务与活动' })
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('专家角色')).not.toBeInTheDocument()
    expect(
      screen.queryByLabelText('切换助手工作栏')
    ).not.toBeInTheDocument()
    await waitFor(() =>
      expect(api.usage.getTokenSummary).toHaveBeenCalledOnce()
    )
    expect(within(stats).getByText('120')).toBeInTheDocument()

    vi.mocked(api.usage.getTokenSummary).mockResolvedValueOnce({
      totals: {
        callCount: 2,
        input: 300,
        output: 45,
        cacheRead: 10,
        cacheWrite: 5,
        totalTokens: 360
      },
      records: [
        {
          requestId: request.requestId,
          projectId,
          projectName: project.name,
          conversationId: request.conversationId,
          conversationTitle: '用量会话',
          runtime: 'model',
          provider: 'anthropic',
          model: 'sonnet-5',
          callCount: 2,
          input: 300,
          output: 45,
          cacheRead: 10,
          cacheWrite: 5,
          totalTokens: 360
        }
      ]
    })
    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'done'
      })
    })

    await waitFor(() =>
      expect(api.usage.getTokenSummary).toHaveBeenCalledTimes(2)
    )
    expect(within(stats).getByText('345')).toBeInTheDocument()
  })

  it('offers only Ask and Execute in visible work mode controls', async () => {
    render(<App />)

    const mode = await screen.findByLabelText('工作模式')
    expect(
      within(mode)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['Ask · 只读问答', 'Execute · 受控执行'])

    fireEvent.click(screen.getByLabelText('新建项目'))
    const dialog = screen.getByRole('dialog', { name: '新建项目' })
    const defaultMode = within(dialog).getByRole('combobox', {
      name: '默认模式'
    })
    expect(
      within(defaultMode)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['Ask · 只读问答', 'Execute · 受控执行'])
    expect(screen.queryByRole('option', { name: /Plan/u })).toBeNull()
  })

  it('normalizes a legacy Plan project default to Ask', async () => {
    vi.mocked(api.projects.list).mockResolvedValueOnce([
      {
        ...project,
        defaultWorkMode: 'plan'
      }
    ])
    render(<App />)

    const mode = await screen.findByLabelText('工作模式')
    expect(mode).toHaveValue('ask')
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '制定发布方案' }
    })
    fireEvent.click(screen.getByLabelText('发送'))

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: '制定发布方案',
          workMode: 'ask'
        })
      )
    )
  })

  it.each([
    ['opencode', 'OpenCode'],
    ['continue', 'Continue CLI']
  ] as const)(
    'locks %s to Execute and submits without a mode choice',
    async (runtimeId, label) => {
    vi.mocked(api.agent.getStatus).mockResolvedValue({
      id: runtimeId,
      label,
      available: true,
      supportsToolExecution: true,
      detail: 'Ready'
    })
    render(<App />)

    const mode = await screen.findByLabelText('工作模式')
    expect(mode).toHaveValue('execute')
    expect(mode).toBeDisabled()
    expect(mode.closest('.composer')).not.toBeNull()
    expect(
      await screen.findByText(
        new RegExp(`${label} 固定为 Execute.*不会弹出 GoodBuddy 审批`)
      )
    ).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '执行任务' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: '执行任务',
          workMode: 'execute'
        })
      )
    )
    }
  )

  it('restores the direct-model mode after leaving an Agent Runtime', async () => {
    vi.mocked(api.agent.getStatus)
      .mockResolvedValueOnce({
        id: 'opencode',
        label: 'OpenCode',
        available: true,
        supportsToolExecution: true,
        detail: 'Ready'
      })
      .mockResolvedValueOnce({
        id: 'model',
        label: 'sonnet-5',
        available: true,
        supportsToolExecution: false,
        detail: 'Ready'
      })
    render(<App />)

    const mode = await screen.findByLabelText('工作模式')
    expect(mode).toHaveValue('execute')
    expect(mode).toBeDisabled()

    fireEvent.click(await screen.findByRole('button', { name: /OpenCode/u }))
    fireEvent.click(
      screen.getByRole('menuitemradio', { name: /默认模型/u })
    )

    await waitFor(() => {
      expect(mode).toHaveValue('ask')
      expect(mode).toBeEnabled()
    })
  })

  it('disables Execute for a runtime without tool support', async () => {
    vi.mocked(api.agent.getStatus).mockResolvedValue({
      id: 'model',
      label: 'legacy-model',
      available: true,
      supportsToolExecution: false,
      detail: 'Ready'
    })
    render(<App />)

    const mode = await screen.findByLabelText('工作模式')
    expect(
      within(mode).getByRole('option', {
        name: 'Execute · 受控执行'
      })
    ).toBeDisabled()
    expect(mode).toHaveValue('ask')
  })

  it('allows a direct model to submit Execute with GoodBuddy approvals', async () => {
    vi.mocked(api.agent.getStatus).mockResolvedValue({
      id: 'model',
      label: 'sonnet-5',
      available: true,
      supportsToolExecution: true,
      detail: 'Ready'
    })
    render(<App />)

    const mode = await screen.findByLabelText('工作模式')
    fireEvent.change(mode, { target: { value: 'execute' } })
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '读取项目文件' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: '读取项目文件',
          workMode: 'execute'
        })
      )
    )
    expect(mode).toBeEnabled()
  })

  it('terminalizes tools and activity when a request is cancelled', async () => {
    vi.mocked(api.agent.getStatus).mockResolvedValue({
      id: 'opencode',
      label: 'OpenCode',
      available: true,
      supportsToolExecution: true,
      detail: 'Ready'
    })
    render(<App />)
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '执行长任务' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    if (!request) {
      throw new Error('Missing request')
    }

    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'tool',
        callId: 'call-1',
        name: 'bash',
        state: 'running',
        summary: 'OpenCode 工具：bash'
      })
      agentListener?.({
        requestId: request.requestId,
        type: 'error',
        status: 'cancelled',
        message: '请求已取消'
      })
    })

    expect(await screen.findByText('已取消')).toBeInTheDocument()
    fireEvent.click(screen.getByText('任务与活动'))
    expect((await screen.findAllByText('已取消')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '进行中' }))
    expect(
      screen.getByText('当前没有等待中或正在运行的活动。')
    ).toBeInTheDocument()
  })

  it('switches runtime profiles from the composer dropdown', async () => {
    render(<App />)

    const runtimeButton = await screen.findByRole('button', {
      name: /sonnet-5/u
    })
    fireEvent.click(runtimeButton)
    expect(
      await screen.findByRole('menu', { name: 'Runtime 和模型' })
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('menuitemradio', {
        name: /默认模型.*sonnet-5/u
      })
    )

    await waitFor(() =>
      expect(api.settings.updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'model',
          defaultModelProfileId: modelProfileId
        })
      )
    )
    expect(
      screen.queryByRole('heading', { name: '设置中心' })
    ).not.toBeInTheDocument()
  })

  it('opens project creation as an unobscured dialog', async () => {
    render(<App />)

    const newProjectButton = await screen.findByLabelText('新建项目')
    fireEvent.click(newProjectButton)
    let dialog = screen.getByRole('dialog', { name: '新建项目' })
    expect(dialog).toHaveClass('project-create-card')
    expect(within(dialog).getByRole('button', { name: '创建' }))
      .toBeDisabled()
    expect(within(dialog).getByLabelText('名称')).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(
      screen.queryByRole('dialog', { name: '新建项目' })
    ).not.toBeInTheDocument()
    expect(newProjectButton).toHaveFocus()

    fireEvent.click(newProjectButton)
    dialog = screen.getByRole('dialog', { name: '新建项目' })

    fireEvent.change(within(dialog).getByLabelText('名称'), {
      target: { value: '新项目' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '创建' }))

    await waitFor(() =>
      expect(api.projects.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '新项目',
          rootPath: ''
        })
      )
    )
  })

  it('keeps project input when creation fails', async () => {
    vi.mocked(api.projects.create).mockRejectedValueOnce(
      new Error('项目目录不可用')
    )
    render(<App />)

    fireEvent.click(await screen.findByLabelText('新建项目'))
    const dialog = screen.getByRole('dialog', { name: '新建项目' })
    const nameInput = within(dialog).getByLabelText('名称')
    fireEvent.change(nameInput, {
      target: { value: '保留的项目名称' }
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: '创建' })
    )

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '项目目录不可用'
    )
    expect(nameInput).toHaveValue('保留的项目名称')
    expect(
      screen.getByRole('dialog', { name: '新建项目' })
    ).toBeInTheDocument()
  })

  it('marks an image model and renders its generated artifact', async () => {
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})
    vi.mocked(api.agent.getStatus).mockResolvedValueOnce({
      id: 'model',
      label: 'gpt-image-2',
      available: true,
      supportsToolExecution: false,
      detail: 'OpenAI Images Generations',
      capability: 'image-generation'
    })
    render(<App />)

    expect((await screen.findAllByText('生图')).length).toBeGreaterThan(0)
    expect(screen.getByLabelText('向 GoodBuddy 提问')).toHaveAttribute(
      'placeholder',
      '描述你想生成的图片…'
    )
    await waitFor(() =>
      expect(api.artifacts.list).toHaveBeenCalled()
    )

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '生成一只蓝色的猫' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    if (!request) {
      throw new Error('Missing request')
    }
    const artifactId = '00000000-0000-4000-8000-000000000301'
    vi.mocked(api.artifacts.get).mockResolvedValueOnce(
      {
        id: artifactId,
        projectId,
        taskId: request.requestId,
        kind: 'image',
        title: '生成一只蓝色的猫',
        mimeType: 'image/png',
        content:
          'data:image/png;base64,iVBORw0KGgoAAAAAAAAAAAAA',
        byteSize: 42,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z'
      }
    )

    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'artifact',
        artifactId,
        kind: 'image',
        title: '生成一只蓝色的猫'
      })
    })

    expect(
      await screen.findByRole('img', { name: '生成一只蓝色的猫' })
    ).toHaveAttribute('src', expect.stringMatching(/^data:image\/png/u))
    fireEvent.click(
      screen.getByRole('button', {
        name: '下载图片 生成一只蓝色的猫'
      })
    )
    expect(anchorClick).toHaveBeenCalledOnce()

    fireEvent.click(
      screen.getByRole('button', {
        name: '查看图片 生成一只蓝色的猫'
      })
    )
    const imageDialog = await screen.findByRole('dialog', {
      name: '生成一只蓝色的猫'
    })
    expect(
      within(imageDialog).getByRole('img', {
        name: '生成一只蓝色的猫'
      })
    ).toHaveAttribute('src', expect.stringMatching(/^data:image\/png/u))
    fireEvent.click(
      within(imageDialog).getByRole('button', { name: '下载图片' })
    )
    expect(anchorClick).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(imageDialog, { key: 'Escape' })
    expect(
      screen.queryByRole('dialog', { name: '生成一只蓝色的猫' })
    ).not.toBeInTheDocument()
    anchorClick.mockRestore()
  })

  it('can dispatch a request to the parallel expert team', async () => {
    render(<App />)

    fireEvent.change(screen.getByLabelText('专家角色'), {
      target: { value: 'team' }
    })
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '制定发布计划' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          teamMode: true,
          expertId: undefined,
          prompt: '制定发布计划'
        })
      )
    )
  })

  it('requests smart routing only when enabled without an explicit expert', async () => {
    const settings = await api.settings.getRuntime()
    vi.mocked(api.settings.getRuntime).mockResolvedValueOnce({
      ...settings,
      subagentSmartRoutingEnabled: true
    })
    render(<App />)

    fireEvent.change(await screen.findByLabelText('向 GoodBuddy 提问'), {
      target: { value: '分析发布风险' }
    })
    fireEvent.click(screen.getByLabelText('发送'))

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          smartRouting: true,
          expertId: undefined,
          teamMode: false,
          workMode: 'ask'
        })
      )
    )
  })

  it('gives an explicitly selected expert priority over smart routing', async () => {
    const expertId = '00000000-0000-4000-8000-000000000501'
    const settings = await api.settings.getRuntime()
    vi.mocked(api.settings.getRuntime).mockResolvedValueOnce({
      ...settings,
      subagentSmartRoutingEnabled: true
    })
    vi.mocked(api.experts.list).mockResolvedValueOnce([
      {
        id: expertId,
        name: '发布专家',
        description: '检查发布风险',
        systemInstructions: 'Review release risks.',
        routingKeywords: ['发布', '风险'],
        enabled: true,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z'
      }
    ])
    render(<App />)

    await screen.findByRole('option', { name: '发布专家' })
    fireEvent.change(screen.getByLabelText('专家角色'), {
      target: { value: expertId }
    })
    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '检查发布方案' }
    })
    fireEvent.click(screen.getByLabelText('发送'))

    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          expertId,
          smartRouting: undefined,
          teamMode: false
        })
      )
    )
  })

  it('shows bounded Subagent states and records child expert activity', async () => {
    render(<App />)
    fireEvent.change(await screen.findByLabelText('向 GoodBuddy 提问'), {
      target: { value: '分析复杂问题' }
    })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    if (!request) {
      throw new Error('Missing request')
    }

    const events = [
      {
        childTaskId: '00000000-0000-4000-8000-000000000601',
        expertId: '00000000-0000-4000-8000-000000000701',
        expertName: '研究专家',
        routingMode: 'smart' as const,
        state: 'queued' as const
      },
      {
        childTaskId: '00000000-0000-4000-8000-000000000602',
        expertId: '00000000-0000-4000-8000-000000000702',
        expertName: '代码专家',
        routingMode: 'manual' as const,
        state: 'running' as const
      },
      {
        childTaskId: '00000000-0000-4000-8000-000000000603',
        expertId: '00000000-0000-4000-8000-000000000703',
        expertName: '安全专家',
        routingMode: 'smart' as const,
        state: 'failed' as const,
        error: '无法读取必要上下文'
      },
      {
        childTaskId: '00000000-0000-4000-8000-000000000604',
        expertId: '00000000-0000-4000-8000-000000000704',
        expertName: '第四位专家',
        routingMode: 'smart' as const,
        state: 'completed' as const
      }
    ]
    act(() => {
      for (const event of events) {
        agentListener?.({
          requestId: request.requestId,
          type: 'subagent',
          ...event
        })
      }
    })

    const statusRegion = await screen.findByLabelText('子专家状态')
    expect(within(statusRegion).getByText('研究专家')).toBeInTheDocument()
    expect(within(statusRegion).getByText('等待中')).toBeInTheDocument()
    expect(within(statusRegion).getByText('代码专家')).toBeInTheDocument()
    expect(within(statusRegion).getByText('进行中')).toBeInTheDocument()
    expect(within(statusRegion).getByText('安全专家')).toBeInTheDocument()
    expect(within(statusRegion).getByText('失败')).toBeInTheDocument()
    expect(
      within(statusRegion).getByText('无法读取必要上下文')
    ).toBeInTheDocument()
    expect(
      within(statusRegion).queryByText('第四位专家')
    ).not.toBeInTheDocument()

    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'subagent',
        ...events[0]!,
        state: 'completed'
      })
      agentListener?.({
        requestId: request.requestId,
        type: 'subagent',
        ...events[1]!,
        state: 'cancelled',
        reason: '父任务已停止'
      })
    })
    expect(within(statusRegion).getByText('已完成')).toBeInTheDocument()
    expect(within(statusRegion).getByText('已取消')).toBeInTheDocument()
    expect(within(statusRegion).getByText('父任务已停止')).toBeInTheDocument()

    fireEvent.click(screen.getByText('任务与活动'))
    expect(await screen.findAllByText('子专家')).toHaveLength(4)
    expect(screen.getAllByText(/智能路由/u).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/手动指定/u).length).toBeGreaterThan(0)
  })

  it('offers once, session, permanent, and deny for a tool call', async () => {
    render(<App />)

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '运行工具' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const request = run.mock.calls[0]?.[0]
    if (!request) {
      throw new Error('Missing request')
    }

    act(() => {
      agentListener?.({
        requestId: request.requestId,
        type: 'approval',
        approvalId: crypto.randomUUID(),
        title: 'Continue 请求调用 Bash',
        description: '确认工具调用',
        toolName: 'Bash',
        argumentSummary: 'echo safe',
        allowPermanent: true
      })
    })

    expect(await screen.findByText('仅此次')).toBeInTheDocument()
    expect(screen.getByText('此会话')).toBeInTheDocument()
    expect(screen.getByText('永久允许')).toBeInTheDocument()
    expect(screen.getAllByText('拒绝')).toHaveLength(2)
    fireEvent.click(screen.getByText('此会话'))
    await waitFor(() =>
      expect(api.agent.respondApproval).toHaveBeenCalledWith(
        expect.any(String),
        'session'
      )
    )
  })

  it('configures a runtime without reading an existing API key', async () => {
    render(<App />)

    fireEvent.click(await screen.findByText('本地工作区'))
    expect(
      await screen.findByRole('heading', {
        name: '设置中心'
      })
    ).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '设置中心' }))
      .toBeInTheDocument()
    expect(
      screen.getByRole('tab', { name: 'Agent Runtime' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('tab', { name: '安全与数据' })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '模型连接' }))

    const apiKeyInput = screen.getByLabelText('API Key')
    expect(apiKeyInput).toHaveValue('')
    fireEvent.change(apiKeyInput, {
      target: { value: 'test-api-key' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() =>
      expect(api.settings.updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: {
            action: 'replace',
            value: 'test-api-key'
          }
        })
      )
    )
    await waitFor(() => expect(apiKeyInput).toHaveValue(''))
  })

  it('opens the global assistant sidebar and switches work tabs', async () => {
    render(<App />)

    const sidebar = screen.getByLabelText('助手工作栏')
    expect(sidebar).not.toHaveClass('assistant-sidebar--open')
    fireEvent.click(screen.getByLabelText('切换助手工作栏'))
    expect(sidebar).toHaveClass('assistant-sidebar--open')

    fireEvent.click(screen.getByRole('tab', { name: '上下文' }))
    expect(
      screen.getByText('尚未添加文件、截图或剪贴板内容。')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '任务中心' }))
    expect(
      screen.getByText(/查看当前和最近请求的运行状态/)
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '成果库' }))
    expect(screen.getByText('对话与导入成果')).toBeInTheDocument()
    expect(
      screen.getByText(/保存并预览由对话生成或手动导入/)
    ).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('关闭助手工作栏'))
    expect(sidebar).not.toHaveClass('assistant-sidebar--open')
  })

  it('opens the live browser tab for the active conversation and can stop it', async () => {
    render(<App />)

    fireEvent.change(screen.getByLabelText('向 GoodBuddy 提问'), {
      target: { value: '打开示例网页' }
    })
    fireEvent.click(await screen.findByLabelText('发送'))
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    const conversationId = run.mock.calls[0]?.[0].conversationId
    expect(conversationId).toBeTruthy()

    act(() => {
      browserListener?.({
        conversationId: conversationId ?? '',
        status: 'ready',
        url: 'https://example.com/',
        frameDataUrl: 'data:image/jpeg;base64,/9j/2Q==',
        updatedAt: Date.now()
      })
    })

    expect(screen.getByLabelText('助手工作栏')).toHaveClass(
      'assistant-sidebar--open'
    )
    expect(
      screen.getByRole('tab', { name: '浏览器' })
    ).toHaveAttribute('aria-selected', 'true')
    expect(
      screen.getByAltText('Agent 实时浏览器画面')
    ).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,/9j/2Q=='
    )
    fireEvent.click(
      screen.getByRole('button', { name: '停止浏览器' })
    )
    await waitFor(() =>
      expect(api.browser.stop).toHaveBeenCalledWith(conversationId)
    )
  })

  it('opens Smart Heartbeat as a first-class workspace', async () => {
    render(<App />)

    fireEvent.click(
      screen.getByRole('button', { name: '智能心跳' })
    )

    expect(
      await screen.findByRole('heading', { name: '智能心跳' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('tab', { name: '成长概览' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '配置智能心跳' })
    ).toBeInTheDocument()
    expect(
      screen.queryByLabelText('切换助手工作栏')
    ).not.toBeInTheDocument()
  })

  it('gives the knowledge workspace the full content width', async () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '知识库' }))

    expect(
      await screen.findByLabelText('知识工作区')
    ).toBeInTheDocument()
    expect(
      screen.queryByLabelText('切换助手工作栏')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByLabelText('专家角色')
    ).not.toBeInTheDocument()
  })

  it('keeps Smart Heartbeat available when the runtime is not configured', async () => {
    vi.mocked(api.agent.getStatus).mockResolvedValue({
      id: 'setup',
      label: '需要配置模型',
      available: false,
      supportsToolExecution: false,
      detail: '请配置模型'
    })
    render(<App />)

    expect(
      await screen.findByRole('heading', { name: '设置中心' })
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(api.agent.getStatus).toHaveBeenCalledOnce()
    )
    fireEvent.click(
      screen.getByRole('button', { name: '智能心跳' })
    )

    expect(
      await screen.findByRole('heading', { name: '智能心跳' })
    ).toBeInTheDocument()
    expect(api.agent.getStatus).toHaveBeenCalledOnce()
  })
})
