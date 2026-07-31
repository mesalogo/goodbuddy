import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DesktopApi,
  RuntimeSettings
} from '../../shared/contracts'
import { SettingsPanel } from './SettingsPanel'

const modelProfileId = '00000000-0000-4000-8000-000000000001'
const runtimeSettings: RuntimeSettings = {
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
  workspacePath: 'C:\\Workspace',
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
}

const getRuntime = vi.fn(async () => runtimeSettings)
const updateRuntime = vi.fn<DesktopApi['settings']['updateRuntime']>(
  async (input) => ({
    ...runtimeSettings,
    ...input,
    modelProfiles: (input.modelProfiles ?? []).map(
      ({ apiKey, ...profile }) => ({
        ...profile,
        apiKeyConfigured: apiKey.action === 'replace',
        credentialSource:
          apiKey.action === 'replace'
            ? ('encrypted' as const)
            : ('none' as const)
      })
    ),
    defaultModelProfileId:
      input.defaultModelProfileId ?? modelProfileId,
    opencodeModelSource:
      input.opencodeModelSource ?? { kind: 'platform' },
    continueModelSource:
      input.continueModelSource ?? { kind: 'platform' },
    apiKeyConfigured: false,
    credentialSource: 'none',
    secureStorageAvailable: true
  })
)
const detectAgentRuntimes = vi.fn<
  DesktopApi['settings']['detectAgentRuntimes']
>(async () => ({
  opencode: {
    available: true,
    path: 'C:\\Tools\\opencode.exe',
    version: '1.2.3',
    detail: '通过 PATH 检测'
  },
  continue: {
    available: false,
    detail: '未检测到 Continue'
  }
}))
const selectRuntimeFile = vi.fn<
  DesktopApi['settings']['selectRuntimeFile']
>(async (kind) =>
  kind === 'continueBinary' ? 'C:\\Tools\\cn.exe' : undefined
)
const capabilitySnapshot = {
  skills: [
    {
      id: 'document-writing',
      name: '文档写作',
      description: '起草专业办公文档',
      version: '1.0.0',
      tags: ['文档', '办公'],
      source: 'builtin' as const,
      digest: 'a'.repeat(64),
      enabled: true,
      assignments: ['model', 'opencode', 'continue'] as (
        | 'model'
        | 'opencode'
        | 'continue'
      )[]
    }
  ],
  mcpServers: []
}
const getCapabilitySnapshot = vi.fn(async () => capabilitySnapshot)
const setSkillEnabled = vi.fn(async (_skillId: string, enabled: boolean) => ({
  ...capabilitySnapshot,
  skills: capabilitySnapshot.skills.map((skill) => ({
    ...skill,
    enabled
  }))
}))

describe('SettingsPanel runtime files', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'goodbuddy', {
      configurable: true,
      value: {
        settings: {
          getRuntime,
          updateRuntime,
          selectWorkspace: vi.fn(async () => undefined),
          detectAgentRuntimes,
          selectRuntimeFile,
          testRuntime: vi.fn(async () => ({
            id: 'continue',
            label: 'Continue',
            available: true,
            detail: 'Ready'
          }))
        },
        capabilities: {
          getSnapshot: getCapabilitySnapshot,
          importSkill: vi.fn(async () => capabilitySnapshot),
          removeSkill: vi.fn(async () => capabilitySnapshot),
          setSkillEnabled,
          setSkillAssignments: vi.fn(async () => capabilitySnapshot),
          saveMcpServer: vi.fn(async () => capabilitySnapshot),
          removeMcpServer: vi.fn(async () => capabilitySnapshot),
          testMcpServer: vi.fn(async () => ({
            toolCount: 0,
            tools: []
          }))
        }
      } as unknown as DesktopApi
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('automatically detects runtimes and displays path, version, and detail', async () => {
    render(
      <SettingsPanel
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    expect(detectAgentRuntimes).toHaveBeenCalledOnce()
    expect(
      await screen.findByText(
        'C:\\Tools\\opencode.exe · 1.2.3 · 通过 PATH 检测'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(/未找到可执行文件 · 未检测到 Continue/)
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重新检测' }))
    await waitFor(() =>
      expect(detectAgentRuntimes).toHaveBeenCalledTimes(2)
    )
  })

  it('selects, warns about, clears, and saves a custom binary', async () => {
    render(
      <SettingsPanel
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    const input = await screen.findByLabelText('Continue 可执行文件路径')
    const field = input.closest('label')
    if (!field) {
      throw new Error('Missing Continue binary field')
    }
    fireEvent.click(within(field).getByRole('button', { name: '选择' }))

    await waitFor(() =>
      expect(selectRuntimeFile).toHaveBeenCalledWith('continueBinary')
    )
    await waitFor(() => expect(input).toHaveValue('C:\\Tools\\cn.exe'))
    expect(
      screen.getByText(/自定义 Continue 可执行文件将以当前用户权限运行/)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/仅在实际请求高风险工具时暂停/)
    ).toBeInTheDocument()

    fireEvent.click(within(field).getByRole('button', { name: '清除' }))
    expect(input).toHaveValue('')

    fireEvent.change(input, { target: { value: 'C:\\Tools\\cn.exe' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() =>
      expect(updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          continueBinaryPath: 'C:\\Tools\\cn.exe',
          continueConfigPath: '',
          continueMode: 'chat',
          opencodeBinaryPath: '',
          opencodeConfigPath: ''
        })
      )
    )
  })

  it('adds model connections and assigns one to OpenCode', async () => {
    render(
      <SettingsPanel
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: '模型连接' }))
    await screen.findByDisplayValue('默认模型')
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    const nameInputs = screen.getAllByLabelText('名称')
    fireEvent.change(nameInputs[1]!, {
      target: { value: 'OpenCode 独立模型' }
    })
    const radios = screen.getAllByRole('radio', {
      name: '默认连接'
    })
    fireEvent.click(radios[1]!)
    fireEvent.click(screen.getByRole('tab', { name: 'Agent Runtime' }))
    const sourceSelect = screen.getAllByLabelText('模型连接')[0]!
    const sourceOptions = within(sourceSelect).getAllByRole('option')
    fireEvent.change(sourceSelect, {
      target: {
        value: (sourceOptions.at(-1) as HTMLOptionElement).value
      }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() =>
      expect(updateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProfiles: expect.arrayContaining([
            expect.objectContaining({ name: '默认模型' }),
            expect.objectContaining({ name: 'OpenCode 独立模型' })
          ]),
          opencodeModelSource: expect.objectContaining({
            kind: 'profile'
          })
        })
      )
    )
  })

  it('shows Skills and MCP as first-class settings tabs', async () => {
    render(
      <SettingsPanel
        open
        onClearLocalData={vi.fn(async () => {})}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Skills' }))
    expect(await screen.findByText('文档写作')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('启用 文档写作'))
    await waitFor(() =>
      expect(setSkillEnabled).toHaveBeenCalledWith(
        'document-writing',
        false
      )
    )

    fireEvent.click(screen.getByRole('tab', { name: 'MCP' }))
    expect(
      await screen.findByText('尚未配置 MCP Server')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /添加 Server/ })
    ).toBeInTheDocument()
  })
})
