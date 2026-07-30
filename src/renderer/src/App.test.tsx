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
    onNewConversation: vi.fn(() => () => {})
  },
  agent: {
    getStatus: vi.fn<DesktopApi['agent']['getStatus']>(async () => ({
      id: 'demo' as const,
      label: '演示模式',
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
      bigtokenBaseUrl: 'https://bigtoken.ai',
      bigtokenModel: 'sonnet-5',
      apiKeyConfigured: false,
      credentialSource: 'none',
      secureStorageAvailable: true,
      toolApproval: 'always'
    })),
    updateRuntime: vi.fn<DesktopApi['settings']['updateRuntime']>(
      async (input) => ({
        provider: input.provider,
        bigtokenBaseUrl: input.bigtokenBaseUrl,
        bigtokenModel: input.bigtokenModel,
        apiKeyConfigured: input.apiKey.action === 'replace',
        credentialSource:
          input.apiKey.action === 'replace' ? 'encrypted' : 'none',
        secureStorageAvailable: true,
        toolApproval: input.toolApproval
      })
    )
  },
  context: {
    selectFiles: vi.fn(async () => []),
    remove: vi.fn(async () => {})
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

  it('configures a runtime without reading an existing API key', async () => {
    render(<App />)

    fireEvent.click(await screen.findByText('本地工作区'))
    expect(
      await screen.findByRole('heading', {
        name: '模型与 Agent Runtime'
      })
    ).toBeInTheDocument()

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
})
