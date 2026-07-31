import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, DesktopApi } from '../../shared/contracts'
import App from './App'

let agentListener: ((event: AgentEvent) => void) | undefined
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
    onNewConversation: vi.fn(() => () => {}),
    onOpenSettings: vi.fn(() => () => {})
  },
  agent: {
    getStatus: vi.fn<DesktopApi['agent']['getStatus']>(async () => ({
      id: 'model' as const,
      label: 'sonnet-5',
      available: true,
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
      opencodeBaseUrl: '',
      opencodeEmbedded: false,
      opencodeBinaryPath: '',
      opencodeConfigPath: '',
      continueBinaryPath: '',
      continueConfigPath: '',
      continueMode: 'chat',
      workspacePath: 'C:\\Users\\test',
      apiKeyConfigured: false,
      credentialSource: 'none',
      modelProfiles: [
        {
          id: modelProfileId,
          name: '默认模型',
          baseUrl: 'https://bigtoken.ai',
          modelName: 'sonnet-5',
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
        opencodeBaseUrl: input.opencodeBaseUrl,
        opencodeEmbedded: input.opencodeEmbedded,
        opencodeBinaryPath: input.opencodeBinaryPath,
        opencodeConfigPath: input.opencodeConfigPath,
        continueBinaryPath: input.continueBinaryPath,
        continueConfigPath: input.continueConfigPath,
        continueMode: input.continueMode,
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
    list: vi.fn(async () => [])
  },
  artifacts: {
    list: vi.fn(async () => []),
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
    vi.clearAllMocks()
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
})
