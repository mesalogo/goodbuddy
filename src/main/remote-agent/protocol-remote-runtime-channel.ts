import { z } from 'zod'
import {
  AGENT_PROTOCOL_LIMITS,
  ChannelProtocolError,
  acpCompletePromptRequestSchema as promptCompletionRequestSchema,
  acpCompletePromptResultSchema as promptCompletionResultSchema,
  acpCloseChannelRequestSchema,
  acpCloseChannelResultSchema,
  acpBindingCursorsSchema as cursorResultSchema,
  acpCancellationReasonSchema as cancellationReasonSchema,
  acpEscalateCancellationRequestSchema as cancellationEscalationRequestSchema,
  acpEscalateCancellationResultSchema as cancellationEscalationResultSchema,
  acpGetCursorsRequestSchema as getCursorsRequestSchema,
  acpOpenChannelRequestSchema,
  acpOpenChannelResultSchema,
  acpReplayChannelResultSchema,
  acpReconcilePromptRequestSchema as promptReconciliationRequestSchema,
  acpReconcilePromptResultSchema as promptReconciliationResultSchema,
  acpResumeChannelResultSchema
} from '../../shared/agent-protocol'
import { AgentFrameError } from '../../shared/agent-protocol/frame'
import {
  assertRemotePromptAcceptanceMatchesPreparation,
  remotePromptOperationAcceptanceSchema,
  remotePromptOperationPreparationSchema
} from '../../shared/remote-agent-contracts'
import {
  modelBridgePolicySchema
} from '../../shared/model-bridge-contracts'
import type {
  RemoteModelBridgeOpenRequest,
  RemoteModelBridgeSession,
  RemoteCancellationEscalation,
  RemotePromptOperationCompletion,
  RemotePromptOperationCompletionResult,
  RemotePromptOperationReconciliation,
  RemotePromptOperationReconciliationResult,
  RemoteRuntimeChannel,
  RemoteRuntimeChannelCapabilities,
  RuntimeSessionBindingCursors
} from '../agent/remote-runtime-channel'
import { StaleRemoteRuntimeGenerationError } from '../agent/remote-runtime-channel'
import {
  AgentProtocolClientError,
  AgentRpcError,
  type AgentProtocolMethod,
  type AgentProtocolParams,
  type AgentProtocolRequestOptions,
  type AgentProtocolResult
} from './agent-protocol-client'
import { AgentAttachTransportError } from './agent-attach-transport'
import type { RemoteAgentConnection } from './remote-agent-connection-manager'
import {
  MainModelBridgeSession
} from './main-model-bridge-session'
import type {
  MainModelBridgeDelivered,
  MainModelBridgeDispatch,
  MainModelBridgeFinalizePrompt,
  MainModelBridgePoison
} from './main-model-bridge-dispatcher'

const RUNTIME_ACP_CAPABILITY = 'runtime/acp'
const RUNTIME_ACP_CAPABILITY_VERSION = 3
const RUNTIME_MODEL_BRIDGE_CAPABILITY = 'runtime/model-bridge'
const RUNTIME_MODEL_BRIDGE_CAPABILITY_VERSION = 1
const DEFAULT_CONTROL_TIMEOUT_MS = 15_000
const DEFAULT_MAXIMUM_PENDING_CONTROL_REQUESTS = 32
const MAXIMUM_PENDING_OUTPUT_WRITES = 256
const MAXIMUM_OUTPUT_WRITE_BYTES =
  AGENT_PROTOCOL_LIMITS.maximumBufferedProtocolBytes

export type RuntimeProtocolMethod =
  Extract<AgentProtocolMethod, `runtime/${string}`>
export type RuntimeProtocolParams<M extends RuntimeProtocolMethod> =
  AgentProtocolParams<M>
export type RuntimeProtocolResult<M extends RuntimeProtocolMethod> =
  AgentProtocolResult<M>

export type RuntimeProtocolRequestOptions = AgentProtocolRequestOptions

export interface RuntimeProtocolBinaryFrame {
  readonly payload: Uint8Array
  readonly sequence: string
  consume(): Promise<void>
}

export interface RuntimeProtocolBinaryChannel {
  readonly channelId: string
  readonly channelEpoch: string
  send(payload: Uint8Array, signal?: AbortSignal): Promise<void>
  receive(signal?: AbortSignal): Promise<RuntimeProtocolBinaryFrame>
  close(error?: unknown): void
  closeWithNotification?(): Promise<void>
  onClose(listener: (error?: unknown) => void): () => void
}

/**
 * Narrow protocol surface needed by this channel.
 */
export interface RuntimeProtocolClient {
  readonly generation: number
  request<M extends RuntimeProtocolMethod>(
    method: M,
    params: RuntimeProtocolParams<M>,
    options?: RuntimeProtocolRequestOptions
  ): Promise<RuntimeProtocolResult<M>>
  registerBinaryChannel(input: {
    channelId: string
    channelEpoch: string
    kind: 'acp'
    nextInboundSequence?: string
    nextOutboundSequence?: string
  }): RuntimeProtocolBinaryChannel
  allocateBinaryChannel?(input: {
    kind: 'blob'
  }): RuntimeProtocolBinaryChannel
  onClose(listener: (error?: unknown) => void): () => void
}

export type RuntimeProtocolConnection = Pick<
  RemoteAgentConnection,
  'identity' | 'status' | 'capabilities' | 'state'
> & {
  readonly client: RuntimeProtocolClient
  reconnect?(signal?: AbortSignal): Promise<void>
  onClientChange?(listener: () => void): () => void
  updateAcpBinding(
    bindingId: string,
    binding:
      | {
          bindingId: string
          channelId: string
          channelEpoch: string
          cursors: z.infer<typeof cursorResultSchema>
        }
      | undefined
  ): Promise<void>
  flushAcpBindings(): Promise<void>
  release?(): void
  onClose?(listener: () => void): () => void
}

export type ProtocolRemoteRuntimeChannelOptions = {
  connection: RuntimeProtocolConnection
  openIdentity: z.input<typeof acpOpenChannelRequestSchema>
  signal?: AbortSignal
  releaseConnectionOnClose?: boolean
  controlTimeoutMs?: number
  maximumPendingControlRequests?: number
  modelBridge?: {
    dispatch: MainModelBridgeDispatch
    onDelivered: MainModelBridgeDelivered
    finalizePrompt: MainModelBridgeFinalizePrompt
    poison: MainModelBridgePoison
    requestTimeoutMs?: number
    closeTimeoutMs?: number
  }
}

export class ProtocolRemoteRuntimeChannelError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'capability-mismatch'
      | 'binding-mismatch'
      | 'protocol'
      | 'capacity'
      | 'closed'
      | 'remote'
      | 'transport'
      | 'aborted',
    details: {
      remoteMethod?: RuntimeProtocolMethod
      remoteRpcCode?: number
      remoteServiceCode?: string
      remoteRequestOutcome?: 'rejected'
    } = {}
  ) {
    super(message)
    this.name = 'ProtocolRemoteRuntimeChannelError'
    this.remoteMethod = details.remoteMethod
    this.remoteRpcCode = details.remoteRpcCode
    this.remoteServiceCode = details.remoteServiceCode
    this.remoteRequestOutcome = details.remoteRequestOutcome
  }

  readonly remoteMethod?: RuntimeProtocolMethod
  readonly remoteRpcCode?: number
  readonly remoteServiceCode?: string
  readonly remoteRequestOutcome?: 'rejected'
}

type OpenState = {
  connection: RuntimeProtocolConnection
  client: RuntimeProtocolClient
  openIdentity: z.infer<typeof acpOpenChannelRequestSchema>
  openResult: z.infer<typeof acpOpenChannelResultSchema>
  binary: RuntimeProtocolBinaryChannel
  generation: number
  capabilityGeneration: number
  daemonBootId: string
  releaseConnectionOnClose: boolean
  controlTimeoutMs: number
  maximumPendingControlRequests: number
  modelBridge: ProtocolRemoteRuntimeChannelOptions['modelBridge']
}

/**
 * Opens a stable ACP binding before registering its binary channel.
 * Mutating Runtime requests are issued once and are never replayed here.
 */
export async function createProtocolRemoteRuntimeChannel(
  options: ProtocolRemoteRuntimeChannelOptions
): Promise<ProtocolRemoteRuntimeChannel> {
  const openIdentity = acpOpenChannelRequestSchema.parse(
    options.openIdentity
  )
  const controlTimeoutMs = boundedInteger(
    options.controlTimeoutMs,
    DEFAULT_CONTROL_TIMEOUT_MS,
    1,
    120_000
  )
  const maximumPendingControlRequests = boundedInteger(
    options.maximumPendingControlRequests,
    DEFAULT_MAXIMUM_PENDING_CONTROL_REQUESTS,
    1,
    256
  )
  const connection = options.connection
  const client = currentOpenClient(connection)
  const generation = client.generation
  const capabilities = connection.capabilities
  const capabilityGeneration = capabilities.generation
  const runtime = assertRuntimeCapability(
    capabilities,
    openIdentity.runtimeId,
    openIdentity.runtimeBundleDigest,
    options.modelBridge !== undefined
  )

  let openResult: z.infer<typeof acpOpenChannelResultSchema>
  try {
    const raw = await requestWithTimeout(
      client,
      'runtime/openAcpChannel',
      openIdentity,
      controlTimeoutMs,
      options.signal
    )
    openResult = parseRemoteResult(
      acpOpenChannelResultSchema,
      raw,
      'Remote Runtime open response is invalid'
    )
  } catch (error) {
    if (options.releaseConnectionOnClose) {
      connection.release?.()
    }
    throw redactProtocolFailure(
      error,
      'runtime/openAcpChannel',
      options.signal
    )
  }

  if (
    !matchesGeneration(
      connection,
      client,
      generation,
      capabilityGeneration
    )
  ) {
    if (options.releaseConnectionOnClose) {
      connection.release?.()
    }
    throw new StaleRemoteRuntimeGenerationError()
  }
  if (
    openResult.bindingId !== openIdentity.bindingId ||
    openResult.channelId !== openIdentity.bindingId ||
    openResult.acpCapabilitiesDigest !== runtime.acpCapabilitiesDigest
  ) {
    await bestEffortCloseOpenBinding(
      client,
      openIdentity.bindingId,
      openResult,
      controlTimeoutMs
    )
    if (options.releaseConnectionOnClose) {
      connection.release?.()
    }
    throw new ProtocolRemoteRuntimeChannelError(
      'Remote Runtime open identity does not match the requested binding',
      'binding-mismatch'
    )
  }

  let binary: RuntimeProtocolBinaryChannel
  try {
    binary = client.registerBinaryChannel({
      channelId: openResult.channelId,
      channelEpoch: openResult.channelEpoch,
      kind: 'acp'
    })
  } catch {
    await bestEffortCloseOpenBinding(
      client,
      openIdentity.bindingId,
      openResult,
      controlTimeoutMs
    )
    if (options.releaseConnectionOnClose) {
      connection.release?.()
    }
    throw new ProtocolRemoteRuntimeChannelError(
      'Remote Runtime binary channel could not be registered',
      'transport'
    )
  }
  if (
    binary.channelId !== openResult.channelId ||
    binary.channelEpoch !== openResult.channelEpoch
  ) {
    binary.close()
    await bestEffortCloseOpenBinding(
      client,
      openIdentity.bindingId,
      openResult,
      controlTimeoutMs
    )
    if (options.releaseConnectionOnClose) {
      connection.release?.()
    }
    throw new ProtocolRemoteRuntimeChannelError(
      'Remote Runtime binary channel identity is invalid',
      'binding-mismatch'
    )
  }

  try {
    await connection.updateAcpBinding(openIdentity.bindingId, {
      bindingId: openIdentity.bindingId,
      channelId: openResult.channelId,
      channelEpoch: openResult.channelEpoch,
      cursors: {
        lastOutboundJournaledSequence: '0',
        lastOutboundDeliveredSequence: '0',
        lastInboundJournaledSequence: '0',
        lastMainAckSequence: '0'
      }
    })
    await connection.flushAcpBindings()
  } catch {
    binary.close()
    await bestEffortCloseOpenBinding(
      client,
      openIdentity.bindingId,
      openResult,
      controlTimeoutMs
    )
    if (options.releaseConnectionOnClose) {
      connection.release?.()
    }
    throw new ProtocolRemoteRuntimeChannelError(
      'Remote Runtime recovery identity could not be persisted',
      'transport'
    )
  }

  return new ProtocolRemoteRuntimeChannel({
    connection,
    client,
    openIdentity,
    openResult,
    binary,
    generation,
    capabilityGeneration,
    daemonBootId: connection.status.daemonBootId,
    releaseConnectionOnClose:
      options.releaseConnectionOnClose ?? false,
    controlTimeoutMs,
    maximumPendingControlRequests,
    modelBridge: options.modelBridge
  })
}

export class ProtocolRemoteRuntimeChannel
  implements RemoteRuntimeChannel
{
  readonly input: ReadableStream<Uint8Array>
  readonly output: WritableStream<Uint8Array>
  readonly channelEpoch: string
  readonly advertisedAcpCapabilitiesDigest: string
  readonly capabilities: RemoteRuntimeChannelCapabilities = {
    cancellationEscalation: true,
    promptOperationReconciliation: true,
    modelBridge: false
  }
  readonly closed: Promise<void>

  readonly #state: OpenState
  readonly #lifetime = new AbortController()
  readonly #closedResolve: () => void
  #readController?: ReadableStreamDefaultController<Uint8Array>
  #writeController?: WritableStreamDefaultController
  #pendingFrame?: RuntimeProtocolBinaryFrame
  #inboundPersistence?: Promise<void>
  #cursorPersistenceTail: Promise<void> = Promise.resolve()
  #paused = false
  #pauseWaiters = new Set<() => void>()
  #pendingControlRequests = 0
  #activeBinarySends = 0
  #recovering = false
  #recoveryPromise?: Promise<void>
  #recoveryWaiters = new Set<() => void>()
  #recoveryDeadlineAt?: number
  #recoverySignal?: AbortSignal
  #transportDiagnostic?: string
  #removeRecoveryAbort?: () => void
  #lastDeliveredInboundSequence = 0n
  #lastAcknowledgedInboundSequence = 0n
  #durableAcknowledgedInboundSequence = 0n
  #lastOutboundSentSequence = 0n
  #recoveryCursors: z.infer<typeof cursorResultSchema> = {
    lastOutboundJournaledSequence: '0',
    lastOutboundDeliveredSequence: '0',
    lastInboundJournaledSequence: '0',
    lastMainAckSequence: '0'
  }
  #closing = false
  #closePromise?: Promise<void>
  #released = false
  #modelBridges = new Set<MainModelBridgeSession>()
  #unsubscribeClientClose: () => void = () => undefined
  #unsubscribeConnectionClose: () => void = () => undefined
  #unsubscribeBinaryClose: () => void = () => undefined
  #unsubscribeClientChange: () => void = () => undefined

  constructor(state: OpenState) {
    this.#state = state
    this.channelEpoch = state.openResult.channelEpoch
    this.advertisedAcpCapabilitiesDigest =
      state.openResult.acpCapabilitiesDigest
    this.capabilities.modelBridge = state.modelBridge !== undefined
    let resolveClosed = (): void => undefined
    this.closed = new Promise<void>((resolve) => {
      resolveClosed = resolve
    })
    this.#closedResolve = resolveClosed

    this.input = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.#readController = controller
        },
        pull: async (controller) => {
          await this.#pullInput(controller)
        },
        cancel: async () => {
          await this.close()
        }
      },
      { highWaterMark: 0 }
    )
    let pendingWriteBytes = 0
    let pendingWrites = 0
    this.output = new WritableStream<Uint8Array>(
      {
        start: (controller) => {
          this.#writeController = controller
        },
        write: async (chunk) => {
          try {
            await this.#writeOutput(chunk)
          } finally {
            pendingWriteBytes -= chunk.byteLength
            pendingWrites -= 1
          }
        },
        close: async () => {
          await this.close()
        },
        abort: async () => {
          await this.close()
        }
      },
      {
        highWaterMark: MAXIMUM_OUTPUT_WRITE_BYTES,
        size: (chunk) => {
          if (
            chunk.byteLength > MAXIMUM_OUTPUT_WRITE_BYTES ||
            pendingWrites >= MAXIMUM_PENDING_OUTPUT_WRITES ||
            pendingWriteBytes + chunk.byteLength >
              MAXIMUM_OUTPUT_WRITE_BYTES
          ) {
            throw new ProtocolRemoteRuntimeChannelError(
              'Remote Runtime output queue limit reached',
              'capacity'
            )
          }
          pendingWrites += 1
          pendingWriteBytes += chunk.byteLength
          return chunk.byteLength
        }
      }
    )

    this.#subscribeTransport(state.client, state.binary)
    this.#unsubscribeConnectionClose =
      state.connection.onClose?.(() => {
        void this.#transportInterrupted()
      }) ?? (() => undefined)
    this.#unsubscribeClientChange =
      state.connection.onClientChange?.(() => {
        if (this.#recovering) {
          this.#wakeRecoveryWaiters()
        }
      }) ?? (() => undefined)
  }

  get generation(): number {
    return this.#state.generation
  }

  isCurrentGeneration(): boolean {
    return (
      !this.#closing &&
      (this.#recovering ||
        matchesGeneration(
          this.#state.connection,
          this.#state.client,
          this.generation,
          this.#state.capabilityGeneration
        ))
    )
  }

  async getBindingCursors(
    bindingId: string
  ): Promise<RuntimeSessionBindingCursors> {
    this.#assertBinding(bindingId)
    await this.#flushRecoveryPersistence()
    const raw = await this.#request(
      'runtime/getAcpCursors',
      getCursorsRequestSchema.parse({ bindingId })
    )
    const remoteCursors = parseRemoteResult(
      cursorResultSchema,
      raw,
      'Remote Runtime cursor response is invalid'
    )
    await this.#persistRecoveryCursors(remoteCursors)
    await this.#flushRecoveryPersistence()
    return this.#recoveryCursors
  }

  async preparePrompt(
    preparation: z.input<typeof remotePromptOperationPreparationSchema>
  ): Promise<
    z.infer<typeof remotePromptOperationAcceptanceSchema>
  > {
    const parsed = remotePromptOperationPreparationSchema.parse(
      preparation
    )
    this.#assertPreparationIdentity(parsed)
    const raw = await this.#request(
      'runtime/preparePrompt',
      parsed
    )
    const acceptance = parseRemoteResult(
      remotePromptOperationAcceptanceSchema,
      raw,
      'Remote Runtime prompt acceptance is invalid'
    )
    try {
      assertRemotePromptAcceptanceMatchesPreparation(
        parsed,
        acceptance
      )
    } catch {
      throw new ProtocolRemoteRuntimeChannelError(
        'Remote Runtime prompt acceptance identity is invalid',
        'binding-mismatch'
      )
    }
    this.#assertCurrent()
    return acceptance
  }

  setRecoveryBoundary(
    deadlineAt: string,
    signal: AbortSignal
  ): void {
    const deadline = Date.parse(deadlineAt)
    if (!Number.isFinite(deadline)) {
      throw new ProtocolRemoteRuntimeChannelError(
        'Remote Runtime recovery deadline is invalid',
        'protocol'
      )
    }
    this.clearRecoveryBoundary()
    this.#recoveryDeadlineAt = deadline
    this.#recoverySignal = signal
    const abort = (): void => {
      this.#wakeRecoveryWaiters()
      if (this.#recovering) {
        void this.#fatalTransport(
          new ProtocolRemoteRuntimeChannelError(
            'Remote Runtime recovery was aborted',
            'aborted'
          )
        )
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    this.#removeRecoveryAbort = () =>
      signal.removeEventListener('abort', abort)
  }

  clearRecoveryBoundary(): void {
    this.#removeRecoveryAbort?.()
    this.#removeRecoveryAbort = undefined
    this.#recoverySignal = undefined
    this.#recoveryDeadlineAt = undefined
  }

  async openModelBridge(
    request: RemoteModelBridgeOpenRequest
  ): Promise<RemoteModelBridgeSession> {
    this.#assertBinding(request.bindingId)
    if (
      request.promptOperationId !== request.requestId ||
      this.#state.modelBridge === undefined ||
      this.#state.client.allocateBinaryChannel === undefined
    ) {
      throw new ProtocolRemoteRuntimeChannelError(
        'Remote Runtime model bridge is unavailable or its prompt identity is invalid',
        'capability-mismatch'
      )
    }
    const policy = modelBridgePolicySchema.parse(request.policy)
    let binary: RuntimeProtocolBinaryChannel
    try {
      binary = this.#state.client.allocateBinaryChannel({
        kind: 'blob'
      })
    } catch {
      throw new ProtocolRemoteRuntimeChannelError(
        'Remote Runtime model bridge channel could not be allocated',
        'transport'
      )
    }
    try {
      this.#assertCurrent()
      const session = new MainModelBridgeSession({
        identity: {
          bindingId: request.bindingId,
          promptOperationId: request.promptOperationId
        },
        policy,
        channel: binary,
        isCurrentGeneration: () => this.isCurrentGeneration(),
        dispatch: this.#state.modelBridge.dispatch,
        onDelivered: this.#state.modelBridge.onDelivered,
        finalizePrompt: this.#state.modelBridge.finalizePrompt,
        poison: this.#state.modelBridge.poison,
        requestTimeoutMs:
          this.#state.modelBridge.requestTimeoutMs,
        closeTimeoutMs:
          this.#state.modelBridge.closeTimeoutMs
      })
      this.#modelBridges.add(session)
      void session.closed.finally(() => {
        this.#modelBridges.delete(session)
      })
      return session
    } catch (error) {
      binary.close(error)
      throw error
    }
  }

  async setInboundPaused(paused: boolean): Promise<void> {
    this.#assertCurrent()
    this.#paused = paused
    if (!paused) {
      this.#resumeInput()
    }
  }

  async completePromptOperation(
    operation: RemotePromptOperationCompletion
  ): Promise<RemotePromptOperationCompletionResult> {
    this.#assertBinding(operation.bindingId)
    await this.#flushRecoveryPersistence()
    const request = promptCompletionRequestSchema.parse(operation)
    const raw = await this.#request('runtime/completePrompt', request)
    const result = parseRemoteResult(
      promptCompletionResultSchema,
      raw,
      'Remote Runtime completion response is invalid'
    )
    if (
      result.bindingId !== request.bindingId ||
      result.operationId !== request.operationId ||
      result.requestId !== request.requestId
    ) {
      throw new ProtocolRemoteRuntimeChannelError(
        'Remote Runtime completion identity is invalid',
        'binding-mismatch'
      )
    }
    return result
  }

  async escalateCancellation(
    escalation: RemoteCancellationEscalation
  ): Promise<void> {
    this.#assertBinding(escalation.bindingId)
    const request = cancellationEscalationRequestSchema.parse({
      bindingId: escalation.bindingId,
      sessionId: escalation.sessionId,
      operationId: escalation.operationId,
      requestId: escalation.requestId,
      reason: redactCancellationReason(escalation.reason)
    })
    const raw = await this.#request(
      'runtime/escalateCancellation',
      request
    )
    const result = parseRemoteResult(
      cancellationEscalationResultSchema,
      raw,
      'Remote Runtime cancellation response is invalid'
    )
    if (result.bindingId !== escalation.bindingId) {
      throw new ProtocolRemoteRuntimeChannelError(
        'Remote Runtime cancellation binding is invalid',
        'binding-mismatch'
      )
    }
  }

  async reconcilePromptOperation(
    operation: RemotePromptOperationReconciliation
  ): Promise<RemotePromptOperationReconciliationResult> {
    this.#assertBinding(operation.bindingId)
    const request = promptReconciliationRequestSchema.parse(operation)
    const raw = await this.#request(
      'runtime/reconcilePrompt',
      request
    )
    return parseRemoteResult(
      promptReconciliationResultSchema,
      raw,
      'Remote Runtime reconciliation response is invalid'
    )
  }

  close(): Promise<void> {
    return this.#beginClose(true)
  }

  async #pullInput(
    controller: ReadableStreamDefaultController<Uint8Array>
  ): Promise<void> {
    try {
      for (;;) {
        await this.#waitUntilReadable()
        if (this.#closing) {
          return
        }
        const binary = this.#state.binary
        const frame =
          this.#pendingFrame ??
          (await binary.receive(this.#lifetime.signal))
        this.#pendingFrame = frame
        await this.#waitUntilReadable()
        if (this.#closing) {
          return
        }
        if (binary !== this.#state.binary) {
          this.#pendingFrame = undefined
          continue
        }
        this.#assertCurrent()
        const sequence = BigInt(frame.sequence)
        if (sequence > this.#lastDeliveredInboundSequence + 1n) {
          throw new ProtocolRemoteRuntimeChannelError(
            'Remote Runtime replay output sequence is not contiguous',
            'protocol'
          )
        }
        this.#pendingFrame = undefined
        const emitted = sequence > this.#lastDeliveredInboundSequence
        const persistence = this.#consumeInboundFrame(
          frame,
          sequence,
          emitted,
          controller
        )
        this.#inboundPersistence = persistence
        try {
          await persistence
        } finally {
          if (this.#inboundPersistence === persistence) {
            this.#inboundPersistence = undefined
          }
        }
        if (!emitted) {
          continue
        }
        return
      }
    } catch (error) {
      if (this.#closing || this.#lifetime.signal.aborted) {
        return
      }
      if (
        error instanceof ProtocolRemoteRuntimeChannelError &&
        (error.reason === 'protocol' ||
          error.reason === 'binding-mismatch')
      ) {
        await this.#fatalTransport(error)
        return
      }
      if (!this.#recovering) {
        void this.#transportInterrupted()
      }
    }
  }

  async #writeOutput(chunk: Uint8Array): Promise<void> {
    await this.#waitForRecovery()
    this.#assertCurrent()
    if (chunk.byteLength > MAXIMUM_OUTPUT_WRITE_BYTES) {
      throw new ProtocolRemoteRuntimeChannelError(
        'Remote Runtime output write exceeds the bounded queue',
        'capacity'
      )
    }
    try {
      for (
        let offset = 0;
        offset < chunk.byteLength;
        offset += AGENT_PROTOCOL_LIMITS.maximumAcpFrameBytes
      ) {
        this.#assertCurrent()
        const end = Math.min(
          chunk.byteLength,
          offset + AGENT_PROTOCOL_LIMITS.maximumAcpFrameBytes
        )
        const frame = new Uint8Array(chunk.subarray(offset, end))
        const binary = this.#state.binary
        this.#activeBinarySends += 1
        try {
          await binary.send(frame, this.#lifetime.signal)
          this.#lastOutboundSentSequence += 1n
        } finally {
          this.#activeBinarySends -= 1
        }
      }
    } catch (error) {
      if (error instanceof StaleRemoteRuntimeGenerationError) {
        throw error
      }
      if (this.#closing || this.#lifetime.signal.aborted) {
        throw new ProtocolRemoteRuntimeChannelError(
          'Remote Runtime channel is closed',
          'closed'
        )
      }
      await this.#fatalTransport(
        new ProtocolRemoteRuntimeChannelError(
          'Remote Runtime ACP input delivery is uncertain',
          'transport'
        )
      )
      throw new ProtocolRemoteRuntimeChannelError(
        'Remote Runtime ACP input delivery is uncertain',
        'transport'
      )
    }
  }

  async #request<M extends RuntimeProtocolMethod>(
    method: M,
    params: RuntimeProtocolParams<M>
  ): Promise<RuntimeProtocolResult<M>> {
    await this.#waitForRecovery()
    this.#assertCurrent()
    if (
      this.#pendingControlRequests >=
      this.#state.maximumPendingControlRequests
    ) {
      throw new ProtocolRemoteRuntimeChannelError(
        'Remote Runtime control request limit reached',
        'capacity'
      )
    }
    this.#pendingControlRequests += 1
    try {
      const result = await requestWithTimeout(
        this.#state.client,
        method,
        params,
        this.#state.controlTimeoutMs,
        this.#lifetime.signal
      )
      this.#assertCurrent()
      return result
    } catch (error) {
      if (error instanceof StaleRemoteRuntimeGenerationError) {
        throw error
      }
      throw redactProtocolFailure(error, method)
    } finally {
      this.#pendingControlRequests -= 1
    }
  }

  #assertCurrent(): void {
    if (this.#closing) {
      throw new ProtocolRemoteRuntimeChannelError(
        'Remote Runtime channel is closed',
        'closed'
      )
    }
    if (!this.isCurrentGeneration()) {
      throw new StaleRemoteRuntimeGenerationError()
    }
  }

  #assertBinding(bindingId: string): void {
    this.#assertCurrent()
    if (bindingId !== this.#state.openIdentity.bindingId) {
      throw new ProtocolRemoteRuntimeChannelError(
        'Remote Runtime binding identity does not match',
        'binding-mismatch'
      )
    }
  }

  #assertPreparationIdentity(
    preparation: z.infer<
      typeof remotePromptOperationPreparationSchema
    >
  ): void {
    this.#assertBinding(preparation.bindingId)
    if (
      preparation.runtimeId !== this.#state.openIdentity.runtimeId ||
      preparation.runtimeBundleDigest !==
        this.#state.openIdentity.runtimeBundleDigest ||
      preparation.workspaceIdentity !==
        this.#state.openIdentity.workspaceIdentity ||
      preparation.channelEpoch !== this.channelEpoch ||
      preparation.connectionGeneration !== this.generation
    ) {
      throw new ProtocolRemoteRuntimeChannelError(
        'Remote Runtime prompt identity does not match the open channel',
        'binding-mismatch'
      )
    }
  }

  async #waitUntilResumed(): Promise<void> {
    while (this.#paused && !this.#closing) {
      await new Promise<void>((resolve) => {
        this.#pauseWaiters.add(resolve)
      })
    }
  }

  async #waitUntilReadable(): Promise<void> {
    await this.#waitUntilResumed()
    await this.#waitForRecovery()
  }

  async #waitForRecovery(): Promise<void> {
    while (this.#recovering && !this.#closing) {
      const recovery = this.#recoveryPromise
      if (recovery !== undefined) {
        await recovery
      } else {
        await new Promise<void>((resolve) => {
          this.#recoveryWaiters.add(resolve)
        })
      }
    }
  }

  #wakeRecoveryWaiters(): void {
    for (const resolve of this.#recoveryWaiters) {
      resolve()
    }
    this.#recoveryWaiters.clear()
  }

  #resumeInput(): void {
    for (const resolve of this.#pauseWaiters) {
      resolve()
    }
    this.#pauseWaiters.clear()
  }

  #subscribeTransport(
    client: RuntimeProtocolClient,
    binary: RuntimeProtocolBinaryChannel
  ): void {
    this.#unsubscribeClientClose()
    this.#unsubscribeBinaryClose()
    this.#unsubscribeClientClose = client.onClose((error) => {
      this.#captureTransportDiagnostic(error)
      void this.#transportInterrupted()
    })
    this.#unsubscribeBinaryClose = binary.onClose((error) => {
      this.#captureTransportDiagnostic(error)
      void this.#transportInterrupted()
    })
  }

  #captureTransportDiagnostic(error: unknown): void {
    this.#transportDiagnostic ??= boundedTransportDiagnostic(error)
  }

  #transportInterrupted(): Promise<void> {
    if (this.#closing) {
      return this.closed
    }
    if (this.#recoveryPromise !== undefined) {
      return this.#recoveryPromise
    }
    const providerDeliveryMayBeUncertain = [
      ...this.#modelBridges
    ].some(
      (bridge) => bridge.providerDeliveryMayBeUncertain
    )
    if (
      this.#recoveryDeadlineAt === undefined ||
      this.#recoverySignal === undefined ||
      this.#recoverySignal.aborted ||
      Date.now() >= this.#recoveryDeadlineAt ||
      this.#activeBinarySends > 0 ||
      this.#pendingControlRequests > 0 ||
      providerDeliveryMayBeUncertain ||
      this.#state.connection.reconnect === undefined
    ) {
      return this.#fatalTransport(
        new ProtocolRemoteRuntimeChannelError(
          appendTransportDiagnostic(
            this.#activeBinarySends > 0
            ? 'Remote Runtime ACP input delivery is uncertain'
            : providerDeliveryMayBeUncertain
              ? 'Remote Runtime model provider delivery is uncertain'
              : 'Remote Runtime transport cannot be recovered safely',
            this.#transportDiagnostic
          ),
          'transport'
        )
      )
    }
    this.#recovering = true
    this.#pendingFrame = undefined
    this.#unsubscribeClientClose()
    this.#unsubscribeBinaryClose()
    const recovery = this.#recoverTransport()
      .catch(async (error: unknown) => {
        await this.#fatalTransport(
          error instanceof Error
            ? error
            : new ProtocolRemoteRuntimeChannelError(
                'Remote Runtime transport recovery failed',
                'transport'
              )
        )
      })
      .finally(() => {
        this.#recovering = false
        this.#recoveryPromise = undefined
        this.#wakeRecoveryWaiters()
      })
    this.#recoveryPromise = recovery
    return recovery
  }

  async #recoverTransport(): Promise<void> {
    await this.#flushRecoveryPersistence()
    const deadlineAt = this.#recoveryDeadlineAt!
    const callerSignal = this.#recoverySignal!
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) {
      throw new ProtocolRemoteRuntimeChannelError(
        'Remote Runtime recovery deadline expired',
        'aborted'
      )
    }
    const recoveryController = new AbortController()
    const abort = (): void => {
      recoveryController.abort(
        callerSignal.reason ??
          new DOMException(
            'Remote Runtime recovery aborted',
            'AbortError'
          )
      )
    }
    callerSignal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => {
      recoveryController.abort(
        new DOMException(
          'Remote Runtime recovery timed out',
          'TimeoutError'
        )
      )
    }, remaining)
    try {
      await this.#state.connection.reconnect!(
        recoveryController.signal
      )
      recoveryController.signal.throwIfAborted()
      const client = currentOpenClient(this.#state.connection)
      const capabilities = this.#state.connection.capabilities
      if (
        client.generation <= this.#state.generation ||
        this.#state.connection.status.daemonBootId !==
          this.#state.daemonBootId ||
        capabilities.generation !==
          this.#state.capabilityGeneration
      ) {
        throw new ProtocolRemoteRuntimeChannelError(
          'Remote Runtime reconnect identity changed',
          'binding-mismatch'
        )
      }
      assertRuntimeCapability(
        capabilities,
        this.#state.openIdentity.runtimeId,
        this.#state.openIdentity.runtimeBundleDigest,
        this.#state.modelBridge !== undefined
      )
      const resume = parseRemoteResult(
        acpResumeChannelResultSchema,
        await requestWithTimeout(
          client,
          'runtime/resumeAcpChannel',
          {
            bindingId: this.#state.openIdentity.bindingId,
            channelId: this.#state.openResult.channelId,
            channelEpoch: this.#state.openResult.channelEpoch
          },
          Math.min(
            this.#state.controlTimeoutMs,
            Math.max(1, deadlineAt - Date.now())
          ),
          recoveryController.signal
        ),
        'Remote Runtime resume response is invalid'
      )
      if (
        resume.bindingId !== this.#state.openIdentity.bindingId ||
        resume.channelId !== this.#state.openResult.channelId ||
        resume.channelEpoch !== this.#state.openResult.channelEpoch ||
        Date.parse(resume.deadlineAt) !== deadlineAt ||
        BigInt(resume.cursors.lastOutboundDeliveredSequence) !==
          BigInt(resume.cursors.lastOutboundJournaledSequence) ||
        BigInt(resume.cursors.lastOutboundJournaledSequence) !==
          this.#lastOutboundSentSequence ||
        this.#durableAcknowledgedInboundSequence >
          BigInt(resume.cursors.lastInboundJournaledSequence)
      ) {
        throw new ProtocolRemoteRuntimeChannelError(
          'Remote Runtime resume identity or delivery proof is invalid',
          'binding-mismatch'
        )
      }
      const binary = client.registerBinaryChannel({
        channelId: resume.channelId,
        channelEpoch: resume.channelEpoch,
        kind: 'acp',
        nextOutboundSequence: (
          BigInt(
            resume.cursors.lastOutboundJournaledSequence
          ) + 1n
        ).toString(),
        nextInboundSequence: (
          BigInt(resume.cursors.lastMainAckSequence) + 1n
        ).toString()
      })
      this.#state.client = client
      this.#state.binary = binary
      this.#state.generation = client.generation
      this.#subscribeTransport(client, binary)
      const replay = parseRemoteResult(
        acpReplayChannelResultSchema,
        await requestWithTimeout(
          client,
          'runtime/replayAcpChannel',
          {
            bindingId: this.#state.openIdentity.bindingId,
            channelId: this.#state.openResult.channelId,
            channelEpoch: this.#state.openResult.channelEpoch,
            acknowledgedSequence:
              resume.cursors.lastMainAckSequence
          },
          Math.min(
            this.#state.controlTimeoutMs,
            Math.max(1, deadlineAt - Date.now())
          ),
          recoveryController.signal
        ),
        'Remote Runtime replay response is invalid'
      )
      if (
        replay.bindingId !== this.#state.openIdentity.bindingId ||
        replay.channelId !== this.#state.openResult.channelId ||
        replay.channelEpoch !== this.#state.openResult.channelEpoch ||
        BigInt(replay.replayedThroughSequence) <
          BigInt(resume.cursors.lastInboundJournaledSequence) ||
        !replay.live
      ) {
        throw new ProtocolRemoteRuntimeChannelError(
          'Remote Runtime replay did not reach live state',
          'protocol'
        )
      }
      await this.#persistRecoveryCursors({
        ...resume.cursors,
        lastInboundJournaledSequence:
          replay.replayedThroughSequence,
        lastMainAckSequence:
          BigInt(resume.cursors.lastMainAckSequence) >
          this.#durableAcknowledgedInboundSequence
            ? resume.cursors.lastMainAckSequence
            : this.#durableAcknowledgedInboundSequence.toString()
      })
      await this.#flushRecoveryPersistence()
    } finally {
      clearTimeout(timeout)
      callerSignal.removeEventListener('abort', abort)
    }
  }

  async #persistObservedAck(sequenceValue: bigint): Promise<void> {
    const sequence = sequenceValue.toString()
    const cursors = cursorResultSchema.parse({
      ...this.#recoveryCursors,
      lastInboundJournaledSequence:
        BigInt(this.#recoveryCursors.lastInboundJournaledSequence) >
        sequenceValue
          ? this.#recoveryCursors.lastInboundJournaledSequence
          : sequence,
      lastMainAckSequence: sequence
    })
    await this.#persistRecoveryCursors(cursors)
  }

  async #consumeInboundFrame(
    frame: RuntimeProtocolBinaryFrame,
    sequence: bigint,
    emitted: boolean,
    controller: ReadableStreamDefaultController<Uint8Array>
  ): Promise<void> {
    if (emitted) {
      this.#lastDeliveredInboundSequence = sequence
      controller.enqueue(new Uint8Array(frame.payload))
    }
    await this.#persistObservedAck(sequence)
    await this.#flushCursorPersistence()
    this.#durableAcknowledgedInboundSequence =
      this.#durableAcknowledgedInboundSequence > sequence
        ? this.#durableAcknowledgedInboundSequence
        : sequence
    await frame.consume()
    this.#lastAcknowledgedInboundSequence =
      this.#lastAcknowledgedInboundSequence > sequence
        ? this.#lastAcknowledgedInboundSequence
        : sequence
  }

  async #persistRecoveryCursors(
    cursors: z.infer<typeof cursorResultSchema>
  ): Promise<void> {
    const parsed = cursorResultSchema.parse(cursors)
    const persistence = this.#cursorPersistenceTail
      .catch(() => undefined)
      .then(async () => {
        const merged = mergeMonotonicCursors(
          this.#recoveryCursors,
          parsed
        )
        if (sameCursors(merged, this.#recoveryCursors)) {
          return
        }
        await this.#state.connection.updateAcpBinding(
          this.#state.openIdentity.bindingId,
          {
            bindingId: this.#state.openIdentity.bindingId,
            channelId: this.#state.openResult.channelId,
            channelEpoch: this.#state.openResult.channelEpoch,
            cursors: merged
          }
        )
        this.#recoveryCursors = merged
      })
    this.#cursorPersistenceTail = persistence
    await persistence
  }

  async #flushRecoveryPersistence(): Promise<void> {
    await this.#inboundPersistence
    await this.#flushCursorPersistence()
  }

  async #flushCursorPersistence(): Promise<void> {
    for (;;) {
      const persistence = this.#cursorPersistenceTail
      await persistence
      await this.#state.connection.flushAcpBindings()
      if (persistence === this.#cursorPersistenceTail) {
        break
      }
    }
  }

  async #fatalTransport(error: Error): Promise<void> {
    if (this.#closing) {
      return await this.closed
    }
    try {
      this.#readController?.error(error)
    } catch {
      // The stream may already have been cancelled or errored.
    }
    try {
      this.#writeController?.error(error)
    } catch {
      // The stream may already have been closed or errored.
    }
    await this.#beginClose(false)
  }

  #beginClose(requestRemoteClose: boolean): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise
    }
    if (this.#closing) {
      return this.closed
    }
    const canRequestRemoteClose =
      requestRemoteClose &&
      matchesGeneration(
        this.#state.connection,
        this.#state.client,
        this.generation,
        this.#state.capabilityGeneration
      )
    this.#closing = true
    this.clearRecoveryBoundary()
    this.#lifetime.abort(
      new DOMException('Remote Runtime channel closed', 'AbortError')
    )
    const bridgeCloses = [...this.#modelBridges].map(async (bridge) => {
      await bridge.close('acp-channel-closed')
    })
    this.#resumeInput()
    this.#wakeRecoveryWaiters()
    this.#state.binary.close()
    try {
      this.#readController?.close()
    } catch {
      // The stream may already have been cancelled or errored.
    }
    try {
      this.#writeController?.error(
        new ProtocolRemoteRuntimeChannelError(
          'Remote Runtime channel is closed',
          'closed'
        )
      )
    } catch {
      // The stream may already have been closed or errored.
    }
    this.#closePromise = (async () => {
      await Promise.allSettled(bridgeCloses)
      await this.#flushRecoveryPersistence().catch(() => undefined)
      if (canRequestRemoteClose) {
        const remoteClosed = await bestEffortCloseOpenBinding(
          this.#state.client,
          this.#state.openIdentity.bindingId,
          this.#state.openResult,
          this.#state.controlTimeoutMs
        )
        if (remoteClosed) {
          await this.#state.connection
            .updateAcpBinding(
              this.#state.openIdentity.bindingId,
              undefined
            )
            .catch(() => undefined)
          await this.#state.connection
            .flushAcpBindings()
            .catch(() => undefined)
        }
      }
      this.#finishClose()
    })()
    return this.#closePromise
  }

  #finishClose(): void {
    this.#unsubscribeClientClose()
    this.#unsubscribeConnectionClose()
    this.#unsubscribeBinaryClose()
    this.#unsubscribeClientChange()
    if (
      this.#state.releaseConnectionOnClose &&
      !this.#released
    ) {
      this.#released = true
      this.#state.connection.release?.()
    }
    this.#closedResolve()
  }
}

function boundedTransportDiagnostic(
  error: unknown
): string | undefined {
  const parts: string[] = []
  let current = error
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof AgentProtocolClientError) {
      parts.push(`client-${current.code}`)
      current = current.cause
      continue
    }
    if (current instanceof AgentAttachTransportError) {
      parts.push(`attach-${current.code}`)
      if (current.diagnostic !== undefined) {
        parts.push(`agent-${current.diagnostic}`)
      }
      current = current.cause
      continue
    }
    if (current instanceof ChannelProtocolError) {
      parts.push(`channel-${current.code}`)
    } else if (current instanceof AgentFrameError) {
      parts.push(`frame-${current.code}`)
    }
    break
  }
  return parts.length === 0 ? undefined : parts.join('/')
}

function appendTransportDiagnostic(
  message: string,
  diagnostic: string | undefined
): string {
  return diagnostic === undefined
    ? message
    : `${message} (${diagnostic})`
}

function currentOpenClient(
  connection: RuntimeProtocolConnection
): RuntimeProtocolClient {
  if (connection.state !== 'ready') {
    throw new StaleRemoteRuntimeGenerationError()
  }
  try {
    const client = connection.client
    if (
      !Number.isSafeInteger(client.generation) ||
      client.generation < 1
    ) {
      throw new StaleRemoteRuntimeGenerationError()
    }
    return client
  } catch (error) {
    if (error instanceof StaleRemoteRuntimeGenerationError) {
      throw error
    }
    throw new StaleRemoteRuntimeGenerationError()
  }
}

function mergeMonotonicCursors(
  current: z.infer<typeof cursorResultSchema>,
  observed: z.infer<typeof cursorResultSchema>
): z.infer<typeof cursorResultSchema> {
  return cursorResultSchema.parse({
    lastOutboundJournaledSequence: maximumSequence(
      current.lastOutboundJournaledSequence,
      observed.lastOutboundJournaledSequence
    ),
    lastOutboundDeliveredSequence: maximumSequence(
      current.lastOutboundDeliveredSequence,
      observed.lastOutboundDeliveredSequence
    ),
    lastInboundJournaledSequence: maximumSequence(
      current.lastInboundJournaledSequence,
      observed.lastInboundJournaledSequence
    ),
    lastMainAckSequence: maximumSequence(
      current.lastMainAckSequence,
      observed.lastMainAckSequence
    )
  })
}

function maximumSequence(left: string, right: string): string {
  return BigInt(left) >= BigInt(right) ? left : right
}

function sameCursors(
  left: z.infer<typeof cursorResultSchema>,
  right: z.infer<typeof cursorResultSchema>
): boolean {
  return (
    left.lastOutboundJournaledSequence ===
      right.lastOutboundJournaledSequence &&
    left.lastOutboundDeliveredSequence ===
      right.lastOutboundDeliveredSequence &&
    left.lastInboundJournaledSequence ===
      right.lastInboundJournaledSequence &&
    left.lastMainAckSequence === right.lastMainAckSequence
  )
}

function matchesGeneration(
  connection: RuntimeProtocolConnection,
  client: RuntimeProtocolClient,
  generation: number,
  capabilityGeneration: number
): boolean {
  try {
    return (
      connection.state === 'ready' &&
      connection.client === client &&
      client.generation === generation &&
      connection.capabilities.generation === capabilityGeneration
    )
  } catch {
    return false
  }
}

function assertRuntimeCapability(
  capabilities: RuntimeProtocolConnection['capabilities'],
  runtimeId: string,
  runtimeBundleDigest: string,
  requireModelBridge: boolean
): RuntimeProtocolConnection['capabilities']['runtimes'][number] {
  const capability = capabilities.capabilities.find(
    (entry) => entry.name === RUNTIME_ACP_CAPABILITY
  )
  const runtimes = capabilities.runtimes.filter(
    (entry) => entry.runtimeId === runtimeId
  )
  const modelBridgeCapability = capabilities.capabilities.find(
    (entry) => entry.name === RUNTIME_MODEL_BRIDGE_CAPABILITY
  )
  if (
    !Number.isSafeInteger(capabilities.generation) ||
    capabilities.generation < 1 ||
    capability === undefined ||
    capability.version !== RUNTIME_ACP_CAPABILITY_VERSION ||
    !capability.critical ||
    (requireModelBridge &&
      (modelBridgeCapability === undefined ||
        modelBridgeCapability.version !==
          RUNTIME_MODEL_BRIDGE_CAPABILITY_VERSION ||
        !modelBridgeCapability.critical)) ||
    runtimes.length !== 1 ||
    runtimes[0]!.bundleDigest !== runtimeBundleDigest
  ) {
    throw new ProtocolRemoteRuntimeChannelError(
      'Remote Agent Runtime capability does not exactly match the requested Runtime',
      'capability-mismatch'
    )
  }
  return runtimes[0]!
}

async function requestWithTimeout<M extends RuntimeProtocolMethod>(
  client: RuntimeProtocolClient,
  method: M,
  params: RuntimeProtocolParams<M>,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<RuntimeProtocolResult<M>> {
  const controller = new AbortController()
  const abort = (): void => {
    controller.abort(
      new DOMException('Remote Runtime request aborted', 'AbortError')
    )
  }
  externalSignal?.throwIfAborted()
  externalSignal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => {
    controller.abort(
      new DOMException('Remote Runtime request timed out', 'TimeoutError')
    )
  }, timeoutMs)
  try {
    return await client.request(method, params, {
      signal: controller.signal
    })
  } finally {
    clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', abort)
  }
}

async function bestEffortCloseOpenBinding(
  client: RuntimeProtocolClient,
  bindingId: string,
  openResult: z.infer<typeof acpOpenChannelResultSchema>,
  timeoutMs: number
): Promise<boolean> {
  const request = acpCloseChannelRequestSchema.parse({
    bindingId,
    channelId: openResult.channelId,
    channelEpoch: openResult.channelEpoch,
    reason: 'released'
  })
  try {
    const raw = await requestWithTimeout(
      client,
      'runtime/closeAcpChannel',
      request,
      timeoutMs
    )
    const result = acpCloseChannelResultSchema.safeParse(raw)
    if (
      !result.success ||
      result.data.bindingId !== bindingId ||
      result.data.channelEpoch !== openResult.channelEpoch ||
      !result.data.closed
    ) {
      return false
    }
    return true
  } catch {
    // Local cleanup must complete even when the remote transport is gone.
    return false
  }
}

function parseRemoteResult<T>(
  schema: z.ZodType<T>,
  value: unknown,
  message: string
): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new ProtocolRemoteRuntimeChannelError(message, 'protocol')
  }
  return parsed.data
}

function redactProtocolFailure(
  error: unknown,
  method: RuntimeProtocolMethod,
  externalSignal?: AbortSignal
): Error {
  if (error instanceof StaleRemoteRuntimeGenerationError) {
    return error
  }
  if (error instanceof ProtocolRemoteRuntimeChannelError) {
    return error
  }
  if (externalSignal?.aborted) {
    return new ProtocolRemoteRuntimeChannelError(
      'Remote Runtime request was aborted',
      'aborted'
    )
  }
  if (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  ) {
    return new ProtocolRemoteRuntimeChannelError(
      error.name === 'TimeoutError'
        ? 'Remote Runtime request timed out'
        : 'Remote Runtime request was aborted',
      'aborted'
    )
  }
  if (error instanceof AgentRpcError) {
    const serviceCode = safeRemoteServiceCode(error.data)
    const detail = [
      `RPC ${error.rpcCode}`,
      ...(serviceCode === undefined ? [] : [serviceCode])
    ].join(', ')
    return new ProtocolRemoteRuntimeChannelError(
      `Remote Runtime ${method} was rejected (${detail})`,
      'remote',
      {
        remoteMethod: method,
        remoteRpcCode: error.rpcCode,
        ...(serviceCode === undefined
          ? {}
          : { remoteServiceCode: serviceCode }),
        remoteRequestOutcome: 'rejected'
      }
    )
  }
  return new ProtocolRemoteRuntimeChannelError(
    `Remote Runtime ${method} protocol request failed`,
    'transport'
  )
}

function safeRemoteServiceCode(data: unknown): string | undefined {
  if (
    data === null ||
    typeof data !== 'object' ||
    !('code' in data) ||
    typeof data.code !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/u.test(data.code)
  ) {
    return undefined
  }
  return data.code
}

function redactCancellationReason(
  reason: unknown
): z.infer<typeof cancellationReasonSchema> {
  if (reason === undefined || reason === null) {
    return 'unspecified'
  }
  if (reason instanceof DOMException) {
    if (reason.name === 'TimeoutError') {
      return 'timeout'
    }
    if (reason.name === 'AbortError') {
      return 'aborted'
    }
    return 'error'
  }
  if (reason instanceof Error) {
    return reason.name === 'TimeoutError' ? 'timeout' : 'error'
  }
  return 'requested'
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) {
    return fallback
  }
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError('Remote Runtime channel limit is invalid')
  }
  return value
}
