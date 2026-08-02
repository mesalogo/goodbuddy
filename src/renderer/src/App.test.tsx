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
import type { AgentEvent, DesktopApi } from '../../shared/contracts'
import App from './App'

let agentListener: ((event: AgentEvent) => void) | undefined
let newConversationListener: (() => void) | undefined
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
      supportsToolExecution: false,
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
  settings: {
    getRuntime: vi.fn<DesktopApi['settings']['getRuntime']>(async () => ({
      provider: 'auto',
      modelBaseUrl: 'https://bigtoken.ai',
      modelName: 'sonnet-5',
      modelProtocol: 'anthropic-messages',
      modelAuthentication: 'api-key',
      opencodeBaseUrl: '',
      opencodeEmbedded: false,
      opencodeBinaryPath: '',
      opencodeConfigPath: '',
      continueBinaryPath: '',
      continueConfigPath: '',
      continueMode: 'chat',
      runtimeSandboxMode: 'auto',
      knowledgeEmbeddingEnabled: false,
      knowledgeEmbeddingBaseUrl: 'http://127.0.0.1:11434',
      knowledgeEmbeddingModel: 'nomic-embed-text',
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
        opencodeBaseUrl: input.opencodeBaseUrl,
        opencodeEmbedded: input.opencodeEmbedded,
        opencodeBinaryPath: input.opencodeBinaryPath,
        opencodeConfigPath: input.opencodeConfigPath,
        continueBinaryPath: input.continueBinaryPath,
        continueConfigPath: input.continueConfigPath,
        continueMode: input.continueMode,
        runtimeSandboxMode: input.runtimeSandboxMode,
        knowledgeEmbeddingEnabled: input.knowledgeEmbeddingEnabled,
        knowledgeEmbeddingBaseUrl: input.knowledgeEmbeddingBaseUrl,
        knowledgeEmbeddingModel: input.knowledgeEmbeddingModel,
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
        supportsToolExecution: false,
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
      truncated: false
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
    }))
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
    vi.mocked(api.agent.getStatus).mockResolvedValue({
      id: 'model',
      label: 'sonnet-5',
      available: true,
      supportsToolExecution: false,
      detail: 'Ready'
    })
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: api
    })
  })

  afterEach(() => {
    cleanup()
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
        delta: '这是回答内容'
      })
      agentListener?.({
        requestId: request.requestId,
        type: 'done'
      })
    })

    expect(await screen.findByText('这是回答内容')).toBeInTheDocument()
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

  it('shows and changes the work mode in the composer', async () => {
    vi.mocked(api.agent.getStatus).mockResolvedValue({
      id: 'opencode',
      label: 'OpenCode',
      available: true,
      supportsToolExecution: true,
      detail: 'Ready'
    })
    render(<App />)

    const mode = await screen.findByLabelText('工作模式')
    expect(mode).toHaveValue('ask')
    expect(mode.closest('.composer')).not.toBeNull()
    expect(
      await screen.findByText(/Ask 模式：只读问答，不会调用工具/)
    ).toBeInTheDocument()

    fireEvent.change(mode, { target: { value: 'execute' } })
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
  })

  it('disables Execute for a runtime without tool support', async () => {
    render(<App />)

    const mode = await screen.findByLabelText('工作模式')
    expect(
      within(mode).getByRole('option', {
        name: 'Execute · 受控执行'
      })
    ).toBeDisabled()
    expect(mode).toHaveValue('ask')
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

  it('marks an image model and renders its generated artifact', async () => {
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
    fireEvent.click(screen.getByRole('tab', { name: '成果' }))
    expect(screen.getByText('对话成果')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('关闭助手工作栏'))
    expect(sidebar).not.toHaveClass('assistant-sidebar--open')
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
