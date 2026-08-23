import {
  cleanup,
  fireEvent,
  render,
  screen,
  within
} from '@testing-library/react'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import {
  EmbeddingSettingsSection,
  type EmbeddingSettingsSectionProps
} from './EmbeddingSettingsSection'
import { changeUiLocale } from './i18n'

const connections: EmbeddingSettingsSectionProps['connections'] = [
  {
    id: 'builtin',
    name: 'GoodBuddy 内置',
    kind: 'builtin',
    model: 'granite-embedding-107m',
    statusText: '尚未安装',
    installed: false
  },
  {
    id: 'custom',
    name: '公司向量服务',
    kind: 'openai-compatible',
    model: 'bge-m3',
    endpoint: 'https://vectors.example/v1/embeddings',
    authentication: 'api-key',
    apiKey: '',
    apiKeyConfigured: true,
    statusText: '已配置凭据'
  }
]

function renderSection(
  overrides: Partial<EmbeddingSettingsSectionProps> = {}
): EmbeddingSettingsSectionProps {
  const props: EmbeddingSettingsSectionProps = {
    connections,
    currentConnectionId: 'custom',
    selectedConnectionId: 'custom',
    enabled: true,
    secureStorageAvailable: true,
    onEnabledChange: vi.fn(),
    onAddConnection: vi.fn(),
    onSelectConnection: vi.fn(),
    onSetCurrent: vi.fn(),
    onUpdateConnection: vi.fn(),
    onDeleteConnection: vi.fn(),
    onDownloadBuiltin: vi.fn(),
    onCancelBuiltin: vi.fn(),
    onImportBuiltin: vi.fn(),
    onRemoveBuiltin: vi.fn(),
    onTestConnection: vi.fn(),
    ...overrides
  }
  render(<EmbeddingSettingsSection {...props} />)
  return props
}

beforeEach(async () => {
  await changeUiLocale('zh-CN')
})

afterEach(cleanup)

describe('EmbeddingSettingsSection', () => {
  it('uses the LLM connection manager layout with one visible title', () => {
    renderSection()

    expect(screen.getAllByText('向量模型连接')).toHaveLength(1)
    const section = screen.getByRole('region', { name: '向量模型' })
    expect(section.querySelectorAll('.model-connection-manager')).toHaveLength(1)
    expect(section.querySelector('.model-connection-list')).toBeInTheDocument()
    expect(section.querySelector('.model-connection-detail')).toBeInTheDocument()
    expect(
      screen.getByRole('list', { name: '向量模型连接列表' })
    ).toBeInTheDocument()
    expect(screen.getByText('当前使用')).toBeInTheDocument()
    expect(
      screen.getByText(
        '建立索引时会向 vectors.example 发送知识分块，检索时会发送查询。'
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/Agent Runtime/u)).not.toBeInTheDocument()
  })

  it('selects a peer connection without changing the current draft', () => {
    const props = renderSection()

    fireEvent.click(
      screen.getByRole('button', {
        name: '编辑向量模型连接 GoodBuddy 内置'
      })
    )

    expect(props.onSelectConnection).toHaveBeenCalledWith('builtin')
    expect(props.onSetCurrent).not.toHaveBeenCalled()
  })

  it('keeps custom definitions editable while retrieval is disabled', () => {
    const props = renderSection({ enabled: false })

    expect(screen.getByRole('radio', { name: '当前连接' })).toBeDisabled()
    expect(
      screen.getByRole('button', {
        name: '测试向量模型连接 公司向量服务'
      })
    ).toBeDisabled()
    const endpoint = screen.getByLabelText('向量接口 URL')
    expect(endpoint).toBeEnabled()
    fireEvent.change(endpoint, {
      target: { value: 'https://new.example/v1/embeddings' }
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: '删除向量模型连接 公司向量服务'
      })
    )
    expect(props.onUpdateConnection).toHaveBeenCalledWith('custom', {
      endpoint: 'https://new.example/v1/embeddings'
    })
    expect(props.onDeleteConnection).toHaveBeenCalledWith('custom')
  })

  it('shows read-only builtin metadata and model actions', () => {
    const props = renderSection({
      enabled: false,
      selectedConnectionId: 'builtin'
    })
    const detail = document.querySelector<HTMLElement>(
      '.model-connection-detail'
    )!

    expect(within(detail).getByText('granite-embedding-107m')).toBeInTheDocument()
    expect(within(detail).getByText('尚未安装')).toBeInTheDocument()
    expect(within(detail).queryByText(/本机知识分块/u)).not.toBeInTheDocument()
    expect(within(detail).queryByText(/知识分块和查询/u)).not.toBeInTheDocument()
    expect(within(detail).queryByRole('textbox')).not.toBeInTheDocument()
    const download = within(detail).getByRole('button', {
      name: '下载 GoodBuddy 内置'
    })
    expect(download).toBeEnabled()
    fireEvent.click(download)
    fireEvent.click(
      within(detail).getByRole('button', {
        name: '从 ZIP 导入 GoodBuddy 内置'
      })
    )
    expect(props.onDownloadBuiltin).toHaveBeenCalledWith(
      'granite-embedding-107m'
    )
    expect(props.onImportBuiltin).toHaveBeenCalledWith(
      'granite-embedding-107m'
    )
  })

  it('identifies a loopback custom endpoint without showing a remote warning', () => {
    renderSection({
      connections: [
        {
          ...connections[1]!,
          endpoint: 'http://127.0.0.1:11434/v1/embeddings'
        }
      ],
      currentConnectionId: 'custom',
      selectedConnectionId: 'custom'
    })

    expect(
      screen.getByText(
        '知识分块和查询将发送到此设备上的 127.0.0.1:11434。'
      )
    ).toHaveClass('settings-notice')
  })

  it('renders diagnostic dimensions and latency in the selected detail', () => {
    renderSection({
      diagnostic: {
        status: 'available',
        provider: 'openai-compatible',
        model: 'bge-m3',
        checkedAt: 1_700_000_000_000,
        latencyMs: 126,
        dimensions: 1_536
      }
    })

    expect(screen.getByText('测试成功')).toBeInTheDocument()
    expect(
      screen.getByText('服务返回 1536 维向量，耗时 126 毫秒。')
    ).toBeInTheDocument()
  })
})
