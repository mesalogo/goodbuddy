import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeNativeClientActions, type RuntimeNativeClientApi } from './RuntimeNativeClientActions'
import { changeUiLocale } from './i18n'
import type { TerminalSnapshot } from '../../shared/terminal-contracts'

const terminal: TerminalSnapshot = {
  sessionId: '00000000-0000-4000-8000-000000000123', target: { type: 'local' },
  title: 'Continue', targetLabel: 'Local', state: 'running', shell: 'continue',
  workingDirectory: '/project', size: { cols: 80, rows: 24 }, lastSequence: 0, exit: null, error: null
}
const api = {
  openRuntimeNativeClient: vi.fn<RuntimeNativeClientApi['openRuntimeNativeClient']>(),
  getRuntimeNativeClient: vi.fn<RuntimeNativeClientApi['getRuntimeNativeClient']>(),
  stopRuntimeNativeClient: vi.fn<RuntimeNativeClientApi['stopRuntimeNativeClient']>()
}
const props = {
  browser: false, contextKey: 'first', conversationId: 'conversation',
  prepareConversation: vi.fn(async () => 'conversation'), onTerminal: vi.fn(), notify: vi.fn()
}

beforeEach(async () => {
  vi.resetAllMocks()
  await changeUiLocale('en-US')
  props.prepareConversation.mockResolvedValue('conversation')
  api.getRuntimeNativeClient.mockResolvedValue(null)
  api.stopRuntimeNativeClient.mockResolvedValue()
  vi.stubGlobal('goodbuddy', api)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RuntimeNativeClientActions', () => {
  it('saves the conversation before launch and prevents duplicate clicks while opening', async () => {
    let finish!: (result: Awaited<ReturnType<RuntimeNativeClientApi['openRuntimeNativeClient']>>) => void
    api.openRuntimeNativeClient.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    render(<RuntimeNativeClientActions {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open in terminal' }))
    await waitFor(() => expect(api.openRuntimeNativeClient).toHaveBeenCalledWith({ conversationId: 'conversation' }))
    expect(props.prepareConversation.mock.invocationCallOrder[0]).toBeLessThan(api.openRuntimeNativeClient.mock.invocationCallOrder[0]!)
    const pending = screen.getByRole('button', { name: 'Opening...' })
    expect(pending).toBeDisabled()
    fireEvent.click(pending)
    expect(api.openRuntimeNativeClient).toHaveBeenCalledTimes(1)
    await act(async () => finish({ kind: 'terminal', terminal }))
    expect(props.onTerminal).toHaveBeenCalledWith(terminal)
    expect(screen.getByRole('button', { name: 'Open in terminal' })).toBeEnabled()
  })

  it('refreshes the matching DS service on selection changes and stops only that service', async () => {
    api.getRuntimeNativeClient.mockResolvedValueOnce({ serviceId: 'first-service' }).mockResolvedValue({ serviceId: 'second-service' })
    const { rerender } = render(<RuntimeNativeClientActions {...props} browser />)
    await screen.findByRole('button', { name: 'Stop DSH service' })
    rerender(<RuntimeNativeClientActions {...props} browser contextKey="second" />)
    expect(screen.queryByRole('button', { name: 'Stop DSH service' })).not.toBeInTheDocument()
    await screen.findByRole('button', { name: 'Stop DSH service' })
    fireEvent.click(screen.getByRole('button', { name: 'Stop DSH service' }))
    expect(api.stopRuntimeNativeClient).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => {
      expect(api.stopRuntimeNativeClient).toHaveBeenCalledWith({ serviceId: 'second-service' })
      expect(screen.getByRole('button', { name: 'Open DSH Web' })).toBeEnabled()
      expect(screen.queryByRole('button', { name: 'Stop DSH service' })).not.toBeInTheDocument()
    })
  })

  it('reopens DS through Main and recovers the stop control after browser-open failure', async () => {
    api.openRuntimeNativeClient.mockRejectedValueOnce(new Error('Browser could not open'))
    render(<RuntimeNativeClientActions {...props} browser />)
    await waitFor(() => expect(api.getRuntimeNativeClient).toHaveBeenCalledTimes(1))
    api.getRuntimeNativeClient.mockResolvedValue({ serviceId: 'ready-service' })
    fireEvent.click(screen.getByRole('button', { name: 'Open DSH Web' }))
    await waitFor(() => {
      expect(props.notify).toHaveBeenCalledWith({ tone: 'error', message: 'Browser could not open' })
      expect(screen.getByRole('button', { name: 'Open DSH Web' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Stop DSH service' })).toBeEnabled()
    })
    api.openRuntimeNativeClient.mockResolvedValue({ kind: 'browser', serviceId: 'ready-service' })
    fireEvent.click(screen.getByRole('button', { name: 'Open DSH Web' }))
    await waitFor(() => expect(api.openRuntimeNativeClient).toHaveBeenCalledTimes(2))
    expect(props.onTerminal).not.toHaveBeenCalled()
  })

  it('does not display a service returned for an old selection', async () => {
    let finish!: (result: { serviceId: string }) => void
    api.getRuntimeNativeClient.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const { rerender } = render(<RuntimeNativeClientActions {...props} browser />)
    await waitFor(() => expect(api.getRuntimeNativeClient).toHaveBeenCalledTimes(1))
    rerender(<RuntimeNativeClientActions {...props} browser contextKey="second" />)
    await waitFor(() => expect(api.getRuntimeNativeClient).toHaveBeenCalledTimes(2))
    await act(async () => finish({ serviceId: 'old-service' }))
    expect(screen.queryByRole('button', { name: 'Stop DSH service' })).not.toBeInTheDocument()
  })

  it('retains controls and reports stop errors for retry', async () => {
    api.getRuntimeNativeClient.mockResolvedValue({ serviceId: 'service' })
    api.stopRuntimeNativeClient.mockRejectedValueOnce(new Error('Stop failed'))
    render(<RuntimeNativeClientActions {...props} browser />)
    fireEvent.click(await screen.findByRole('button', { name: 'Stop DSH service' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => {
      expect(props.notify).toHaveBeenCalledWith({ tone: 'error', message: 'Stop failed' })
      expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled()
    })
  })

  it('cancels inline confirmation and shows stopping on the confirmation button', async () => {
    await changeUiLocale('zh-CN')
    api.getRuntimeNativeClient.mockResolvedValue({ serviceId: 'service' })
    let finish!: () => void
    api.stopRuntimeNativeClient.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    render(<RuntimeNativeClientActions {...props} browser />)
    fireEvent.click(await screen.findByRole('button', { name: '停止DSH服务' }))
    expect(screen.getByRole('button', { name: '确认' })).toHaveAccessibleDescription('停止后此服务的网页会断开，进行中的请求将中断。')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('button', { name: '确认' })).not.toBeInTheDocument()
    expect(api.stopRuntimeNativeClient).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '停止DSH服务' }))
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    expect(screen.getByRole('button', { name: '正在停止…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '打开DSH Web' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    await act(async () => finish())
    expect(screen.getByRole('button', { name: '打开DSH Web' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument()
  })
})
