import { setTimeout as delay } from 'node:timers/promises'
import { RemoteChannelClosedError, RemoteOperationTimeoutError } from '../agent/acp-remote-runtime'
import { ProtocolRemoteRuntimeChannelError } from './protocol-remote-runtime-channel'
import { RemoteAgentConnectionError } from './remote-agent-connection-manager'

// Only reattach/read an already accepted task. Never wrap prompt submission
// or a tool invocation with this retry policy.
export const REMOTE_TASK_RECOVERY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const

export function isTransientRemoteRecoveryError(error: unknown): boolean {
  if (error instanceof RemoteAgentConnectionError) return error.disposition === 'transient'
  if (error instanceof RemoteChannelClosedError || error instanceof RemoteOperationTimeoutError) return true
  return error instanceof ProtocolRemoteRuntimeChannelError &&
    (error.reason === 'transport' || error.reason === 'closed')
}

export async function recoverRemoteTaskWithRetry(
  recover: () => Promise<void>,
  signal: AbortSignal,
  onRetry: (error: unknown, attempt: number, delayMs: number) => void
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted()
    try {
      await recover()
      return
    } catch (error) {
      const delayMs = REMOTE_TASK_RECOVERY_DELAYS_MS[attempt]
      if (signal.aborted || delayMs === undefined || !isTransientRemoteRecoveryError(error)) throw error
      onRetry(error, attempt + 1, delayMs)
      await delay(delayMs, undefined, { signal })
    }
  }
}
