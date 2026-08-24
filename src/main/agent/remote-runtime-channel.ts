import type {
  AcpBindingCursors,
  AcpCompletePromptRequest,
  AcpCompletePromptResult,
  AcpEscalateCancellationRequest,
  AcpReconcilePromptRequest,
  AcpReconcilePromptResult
} from '../../shared/agent-protocol'
import type {
  RemotePromptOperationAcceptance,
  RemotePromptOperationPreparation,
} from '../../shared/remote-agent-contracts'
import type {
  ModelBridgePolicy
} from '../../shared/model-bridge-contracts'

export type RemoteRuntimeChannelCapabilities = {
  cancellationEscalation: boolean
  promptOperationReconciliation: boolean
  modelBridge?: boolean
}

export type RuntimeSessionBindingCursors = AcpBindingCursors

export type RemoteCancellationEscalation = Omit<
  AcpEscalateCancellationRequest,
  'reason'
> & {
  reason: unknown
}

export type RemotePromptOperationReconciliation =
  AcpReconcilePromptRequest

export type RemotePromptOperationReconciliationResult =
  AcpReconcilePromptResult
export type RemotePromptOperationCompletion = AcpCompletePromptRequest
export type RemotePromptOperationCompletionResult =
  AcpCompletePromptResult

export type RemoteModelBridgeOpenRequest = {
  bindingId: string
  promptOperationId: string
  requestId: string
  policy: ModelBridgePolicy
}

export type RemoteModelBridgeCloseResult = {
  clean: boolean
  poisoned: boolean
}

export interface RemoteModelBridgeSession {
  readonly version: 'goodbuddy-model-bridge-v1'
  readonly channelId: string
  readonly channelEpoch: string
  readonly policy: ModelBridgePolicy
  readonly closed: Promise<RemoteModelBridgeCloseResult>
  close(reason?: string): Promise<RemoteModelBridgeCloseResult>
}

/**
 * A process-neutral, already authenticated ACP virtual channel.
 *
 * Implementations own framing, journaling and transport generation checks.
 * The runtime intentionally receives no SSH client, socket or command API.
 */
export interface RemoteRuntimeChannel {
  readonly input: ReadableStream<Uint8Array>
  readonly output: WritableStream<Uint8Array>
  readonly generation: number
  readonly channelEpoch: string
  /**
   * Signed Runtime capability identity advertised by the Agent before the
   * untrusted Runtime process starts.
   */
  readonly advertisedAcpCapabilitiesDigest: string
  readonly capabilities: RemoteRuntimeChannelCapabilities
  readonly closed: Promise<void>

  isCurrentGeneration(): boolean
  getBindingCursors(
    bindingId: string
  ): Promise<RuntimeSessionBindingCursors>
  /** Accepts the prompt and starts its Ask or Execute Runtime process. */
  preparePrompt(
    preparation: RemotePromptOperationPreparation
  ): Promise<RemotePromptOperationAcceptance>
  /**
   * Bounds same-daemon stream recovery to the signed prompt lifetime and
   * caller cancellation. Implementations that cannot recover may omit it.
   */
  setRecoveryBoundary?(
    deadlineAt: string,
    signal: AbortSignal
  ): void
  clearRecoveryBoundary?(): void
  /**
   * Allocates and registers a fresh Main-owned model channel for one prompt.
   * Legacy channels may omit this when the runtime is configured without a
   * model bridge.
   */
  openModelBridge?(
    request: RemoteModelBridgeOpenRequest
  ): Promise<RemoteModelBridgeSession>
  completePromptOperation(
    operation: RemotePromptOperationCompletion
  ): Promise<RemotePromptOperationCompletionResult>
  /**
   * Stops or resumes inbound ACP delivery. Pausing must take effect before
   * the returned promise resolves and must not advance the Main ACK cursor.
   */
  setInboundPaused(paused: boolean): Promise<void>
  escalateCancellation(
    escalation: RemoteCancellationEscalation
  ): Promise<void>
  reconcilePromptOperation(
    operation: RemotePromptOperationReconciliation
  ): Promise<RemotePromptOperationReconciliationResult>
  close(): Promise<void>
}

export class StaleRemoteRuntimeGenerationError extends Error {
  constructor() {
    super('远端 Runtime 连接代际已失效')
    this.name = 'StaleRemoteRuntimeGenerationError'
  }
}

export function isDefinitiveRemoteRuntimeRequestRejection(
  error: unknown,
  method: string
): boolean {
  if (
    error === null ||
    typeof error !== 'object' ||
    !('remoteRequestOutcome' in error) ||
    error.remoteRequestOutcome !== 'rejected' ||
    !('remoteMethod' in error) ||
    error.remoteMethod !== method
  ) {
    return false
  }
  return true
}

export function assertCurrentRemoteRuntimeGeneration(
  channel: RemoteRuntimeChannel
): void {
  if (!channel.isCurrentGeneration()) {
    throw new StaleRemoteRuntimeGenerationError()
  }
}
