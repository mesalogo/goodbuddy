import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteChannelClosedError, RemoteOperationTimeoutError } from '../agent/acp-remote-runtime'
import { ProtocolRemoteRuntimeChannelError } from './protocol-remote-runtime-channel'
import { RemoteAgentConnectionError } from './remote-agent-connection-manager'
import { isTransientRemoteRecoveryError, recoverRemoteTaskWithRetry, REMOTE_TASK_RECOVERY_DELAYS_MS } from './remote-task-recovery'

vi.mock('node:timers/promises', () => {
  const setTimeoutPromise = (ms: number, _value: unknown, { signal }: { signal: AbortSignal }) => new Promise<void>((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
  return { setTimeout: setTimeoutPromise, default: { setTimeout: setTimeoutPromise } }
})

afterEach(() => vi.useRealTimers())

describe('remote task reattachment retry', () => {
  it('backs off transient failures and stops after success', async () => {
    vi.useFakeTimers()
    const recover = vi.fn().mockRejectedValueOnce(new RemoteChannelClosedError('读取 Agent 语义记录'))
      .mockRejectedValueOnce(new RemoteAgentConnectionError('offline', 'transient', 'network'))
      .mockResolvedValue(undefined)
    const retried = vi.fn()
    const pending = recoverRemoteTaskWithRetry(recover, new AbortController().signal, retried)
    await vi.advanceTimersByTimeAsync(999)
    expect(recover).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(recover).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2_000)
    await pending
    expect(recover).toHaveBeenCalledTimes(3)
    expect(retried.mock.calls.map(call => call.slice(1))).toEqual([[1, 1_000], [2, 2_000]])
  })

  it('bounds persistent network failures and retains the last error', async () => {
    vi.useFakeTimers()
    const error = new RemoteOperationTimeoutError('读取 Agent 语义记录')
    const recover = vi.fn().mockRejectedValue(error)
    const pending = expect(recoverRemoteTaskWithRetry(recover, new AbortController().signal, vi.fn())).rejects.toBe(error)
    await vi.runAllTimersAsync()
    await pending
    expect(recover).toHaveBeenCalledTimes(REMOTE_TASK_RECOVERY_DELAYS_MS.length + 1)
  })

  it('cancels backoff immediately without starting another attempt', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const recover = vi.fn().mockRejectedValue(new RemoteChannelClosedError('读取'))
    const pending = expect(recoverRemoteTaskWithRetry(recover, controller.signal, vi.fn())).rejects.toThrow('shutdown')
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(new Error('shutdown'))
    await pending
    await vi.runAllTimersAsync()
    expect(recover).toHaveBeenCalledOnce()
  })

  it.each([
    new RemoteAgentConnectionError('authentication failed', 'terminal', 'authentication'),
    new ProtocolRemoteRuntimeChannelError('identity changed', 'binding-mismatch'),
    new DOMException('cancelled', 'AbortError'),
    new Error('invalid transcript'),
    new TypeError('programming error')
  ])('does not automatically retry terminal or unknown errors: %s', async error => {
    const recover = vi.fn().mockRejectedValue(error)
    expect(isTransientRemoteRecoveryError(error)).toBe(false)
    await expect(recoverRemoteTaskWithRetry(recover, new AbortController().signal, vi.fn())).rejects.toBe(error)
    expect(recover).toHaveBeenCalledOnce()
  })
})
