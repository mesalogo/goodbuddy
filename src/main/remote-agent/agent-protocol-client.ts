import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import {
  AGENT_PROTOCOL_LIMITS,
  AGENT_PROTOCOL_VERSION,
  AgentConnectionChannels,
  acpBindingCursorsSchema,
  acpCompletePromptRequestSchema,
  acpCompletePromptResultSchema,
  acpEscalateCancellationRequestSchema,
  acpEscalateCancellationResultSchema,
  acpGetCursorsRequestSchema,
  acpCloseChannelRequestSchema,
  acpCloseChannelResultSchema,
  acpOpenChannelRequestSchema,
  acpOpenChannelResultSchema,
  acpReplayChannelRequestSchema,
  acpReplayChannelResultSchema,
  acpReconcilePromptRequestSchema,
  acpReconcilePromptResultSchema,
  acpResumeChannelRequestSchema,
  acpResumeChannelResultSchema,
  channelCloseRequestSchema,
  controllerResumeRequestSchema,
  controllerResumeResultSchema,
  daemonCapabilitiesSchema,
  daemonStatusSchema,
  jsonRpcMessageSchema,
  jsonRpcNotificationSchema,
  frameAcknowledgmentSchema,
  maximumPayloadLength,
  type AgentChannelState,
  type AgentFrame,
  type AgentFrameKind
} from '../../shared/agent-protocol'
import {
  remotePromptOperationAcceptanceSchema,
  remotePromptOperationPreparationSchema,
  remoteOwnedPromptAttachRequestSchema,
  remoteOwnedPromptStartRequestSchema,
  remoteOwnedPromptStartResultSchema,
  remoteSemanticTranscriptAckRequestSchema,
  remoteSemanticTranscriptAckResultSchema,
  remoteSemanticTranscriptPageRequestSchema,
  remoteSemanticTranscriptPageResultSchema,
  remoteGitDiffRequestSchema,
  remoteGitDiffResultSchema,
  remoteGitStatusRequestSchema,
  remoteGitStatusResultSchema,
  remoteWorkspaceApplyChangeSetRequestSchema,
  remoteWorkspaceApplyChangeSetResultSchema,
  remoteWorkspaceCloseRequestSchema,
  remoteWorkspaceCloseResultSchema,
  remoteWorkspaceListRequestSchema,
  remoteWorkspaceListResultSchema,
  remoteWorkspaceOpenRequestSchema,
  remoteWorkspaceOpenResultSchema,
  remoteWorkspaceReadTextRequestSchema,
  remoteWorkspaceReadTextResultSchema,
  remoteWorkspaceResumeRequestSchema,
  remoteWorkspaceResumeResultSchema,
  remoteWorkspaceSearchRequestSchema,
  remoteWorkspaceSearchResultSchema,
  remoteWorkspaceStatRequestSchema,
  remoteWorkspaceStatResultSchema,
  remoteWorkspaceValidateRequestSchema,
  remoteWorkspaceValidateResultSchema,
  remoteWorkspaceWriteResultSchema,
  remoteWorkspaceWriteTextAtomicRequestSchema
} from '../../shared/remote-agent-contracts'
import type { AgentAttachTransport } from './agent-attach-transport'

const MAXIMUM_PENDING_REQUESTS = 256
const MAXIMUM_RETIRED_CHANNELS = 4_096
const MAXIMUM_CHANNEL_QUEUE_ITEMS = 256
const MAXIMUM_CHANNEL_QUEUE_BYTES =
  AGENT_PROTOCOL_LIMITS.maximumBufferedProtocolBytes
const CHANNEL_CLOSE_METHOD = 'channel/close'

const emptyParamsSchema = z.object({}).strict()

type MethodDefinition = {
  params: z.ZodType
  result: z.ZodType
}

/**
 * Deliberately closed method registry. Adding a wire method requires adding
 * shared schemas here; callers cannot send arbitrary JSON-RPC method names.
 */
export const AGENT_PROTOCOL_METHODS = {
  'agent/status': {
    params: emptyParamsSchema,
    result: daemonStatusSchema
  },
  'agent/doctor': {
    params: emptyParamsSchema,
    result: daemonStatusSchema
  },
  'agent/capabilities': {
    params: emptyParamsSchema,
    result: daemonCapabilitiesSchema
  },
  'controller/resume': {
    params: controllerResumeRequestSchema,
    result: controllerResumeResultSchema
  },
  'workspace/validate': {
    params: remoteWorkspaceValidateRequestSchema,
    result: remoteWorkspaceValidateResultSchema
  },
  'workspace/open': {
    params: remoteWorkspaceOpenRequestSchema,
    result: remoteWorkspaceOpenResultSchema
  },
  'workspace/resume': {
    params: remoteWorkspaceResumeRequestSchema,
    result: remoteWorkspaceResumeResultSchema
  },
  'workspace/close': {
    params: remoteWorkspaceCloseRequestSchema,
    result: remoteWorkspaceCloseResultSchema
  },
  'workspace/list': {
    params: remoteWorkspaceListRequestSchema,
    result: remoteWorkspaceListResultSchema
  },
  'workspace/stat': {
    params: remoteWorkspaceStatRequestSchema,
    result: remoteWorkspaceStatResultSchema
  },
  'workspace/readText': {
    params: remoteWorkspaceReadTextRequestSchema,
    result: remoteWorkspaceReadTextResultSchema
  },
  'workspace/search': {
    params: remoteWorkspaceSearchRequestSchema,
    result: remoteWorkspaceSearchResultSchema
  },
  'workspace/writeTextAtomic': {
    params: remoteWorkspaceWriteTextAtomicRequestSchema,
    result: remoteWorkspaceWriteResultSchema
  },
  'workspace/applyChangeSet': {
    params: remoteWorkspaceApplyChangeSetRequestSchema,
    result: remoteWorkspaceApplyChangeSetResultSchema
  },
  'git/status': {
    params: remoteGitStatusRequestSchema,
    result: remoteGitStatusResultSchema
  },
  'git/diff': {
    params: remoteGitDiffRequestSchema,
    result: remoteGitDiffResultSchema
  },
  'runtime/openAcpChannel': {
    params: acpOpenChannelRequestSchema,
    result: acpOpenChannelResultSchema
  },
  'runtime/closeAcpChannel': {
    params: acpCloseChannelRequestSchema,
    result: acpCloseChannelResultSchema
  },
  'runtime/resumeAcpChannel': {
    params: acpResumeChannelRequestSchema,
    result: acpResumeChannelResultSchema
  },
  'runtime/replayAcpChannel': {
    params: acpReplayChannelRequestSchema,
    result: acpReplayChannelResultSchema
  },
  'runtime/preparePrompt': {
    params: remotePromptOperationPreparationSchema,
    result: remotePromptOperationAcceptanceSchema
  },
  'runtime/startPrompt': {
    params: remoteOwnedPromptStartRequestSchema,
    result: remoteOwnedPromptStartResultSchema
  },
  'runtime/attachPrompt': {
    params: remoteOwnedPromptAttachRequestSchema,
    result: remoteOwnedPromptStartResultSchema
  },
  'runtime/pagePromptTranscript': {
    params: remoteSemanticTranscriptPageRequestSchema,
    result: remoteSemanticTranscriptPageResultSchema
  },
  'runtime/ackPromptTranscript': {
    params: remoteSemanticTranscriptAckRequestSchema,
    result: remoteSemanticTranscriptAckResultSchema
  },
  'runtime/completePrompt': {
    params: acpCompletePromptRequestSchema,
    result: acpCompletePromptResultSchema
  },
  'runtime/getAcpCursors': {
    params: acpGetCursorsRequestSchema,
    result: acpBindingCursorsSchema
  },
  'runtime/escalateCancellation': {
    params: acpEscalateCancellationRequestSchema,
    result: acpEscalateCancellationResultSchema
  },
  'runtime/reconcilePrompt': {
    params: acpReconcilePromptRequestSchema,
    result: acpReconcilePromptResultSchema
  }
} as const satisfies Record<string, MethodDefinition>

export type AgentProtocolMethod = keyof typeof AGENT_PROTOCOL_METHODS
export type AgentProtocolParams<M extends AgentProtocolMethod> = z.infer<
  (typeof AGENT_PROTOCOL_METHODS)[M]['params']
>
export type AgentProtocolResult<M extends AgentProtocolMethod> = z.infer<
  (typeof AGENT_PROTOCOL_METHODS)[M]['result']
>

export type AgentProtocolRequestOptions = {
  signal?: AbortSignal
}

export class AgentRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'AgentRpcError'
  }
}

export class AgentProtocolClientError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'closed'
      | 'protocol'
      | 'capacity'
      | 'aborted',
    readonly cause?: unknown
  ) {
    super(message)
    this.name = 'AgentProtocolClientError'
  }
}

type PendingRequest = {
  channel: AgentChannelState
  requestId: string
  method: AgentProtocolMethod
  resultSchema: z.ZodType
  response?: { result?: unknown; error?: AgentRpcError }
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  abort?: () => void
  canceled: boolean
  nextDataSequence: bigint
  nextAckSequence: bigint
}

type AbandonedRequest = {
  channelId: string
  channelEpoch: string
  requestId: string
  nextDataSequence: bigint
  nextAckSequence: bigint
  responseSeen: boolean
}

type QueuedBinaryFrame = {
  frame: AgentFrame
  consumed: boolean
}

type BinaryWaiter = {
  resolve: (frame: AgentConsumedFrame) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  abort?: () => void
}

export type AgentConsumedFrame = {
  payload: Uint8Array
  sequence: string
  consume(): Promise<void>
}

export class AgentProtocolBinaryChannel {
  readonly #client: AgentProtocolClient
  readonly state: AgentChannelState
  readonly kind: Extract<AgentFrameKind, 'acp' | 'blob'>
  #queue: QueuedBinaryFrame[] = []
  #queueBytes = 0
  #waiters: BinaryWaiter[] = []
  #closeListeners = new Set<(error?: unknown) => void>()
  #closed = false

  constructor(
    client: AgentProtocolClient,
    state: AgentChannelState,
    kind: Extract<AgentFrameKind, 'acp' | 'blob'>
  ) {
    this.#client = client
    this.state = state
    this.kind = kind
  }

  get channelId(): string {
    return this.state.channelId
  }

  get channelEpoch(): string {
    return this.state.channelEpoch
  }

  async send(payload: Uint8Array, signal?: AbortSignal): Promise<void> {
    this.#assertOpen()
    signal?.throwIfAborted()
    if (payload.byteLength > maximumPayloadLength(this.kind)) {
      throw new AgentProtocolClientError(
        'Binary Agent frame exceeds its protocol limit',
        'protocol'
      )
    }
    await this.#client.sendOnChannel(this.state, this.kind, payload)
  }

  /**
   * Main-owned binary channels announce their terminal state to the Agent
   * before releasing the local channel identity. The notification is never
   * replayed.
   */
  async closeWithNotification(): Promise<void> {
    await this.#client.closeBinaryChannel(this, true)
  }

  receive(signal?: AbortSignal): Promise<AgentConsumedFrame> {
    this.#assertOpen()
    signal?.throwIfAborted()
    const queued = this.#queue.shift()
    if (queued !== undefined) {
      this.#queueBytes -= queued.frame.payload.byteLength
      return Promise.resolve(this.#consumable(queued))
    }
    if (this.#waiters.length >= MAXIMUM_CHANNEL_QUEUE_ITEMS) {
      return Promise.reject(
        new AgentProtocolClientError(
          'Too many binary Agent frame readers',
          'capacity'
        )
      )
    }
    return new Promise((resolve, reject) => {
      const waiter: BinaryWaiter = { resolve, reject, signal }
      if (signal !== undefined) {
        waiter.abort = (): void => {
          const index = this.#waiters.indexOf(waiter)
          if (index >= 0) {
            this.#waiters.splice(index, 1)
          }
          reject(signal.reason)
        }
        signal.addEventListener('abort', waiter.abort, { once: true })
      }
      this.#waiters.push(waiter)
    })
  }

  onClose(listener: (error?: unknown) => void): () => void {
    if (this.#closed) {
      queueMicrotask(listener)
      return () => undefined
    }
    this.#closeListeners.add(listener)
    return () => this.#closeListeners.delete(listener)
  }

  accept(frame: AgentFrame): void {
    this.#assertOpen()
    const queued: QueuedBinaryFrame = { frame, consumed: false }
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) {
      if (waiter.abort !== undefined) {
        waiter.signal?.removeEventListener('abort', waiter.abort)
      }
      waiter.resolve(this.#consumable(queued))
      return
    }
    if (
      this.#queue.length >= MAXIMUM_CHANNEL_QUEUE_ITEMS ||
      this.#queueBytes + frame.payload.byteLength >
        MAXIMUM_CHANNEL_QUEUE_BYTES
    ) {
      throw new AgentProtocolClientError(
        'Binary Agent receive queue is full',
        'capacity'
      )
    }
    this.#queue.push(queued)
    this.#queueBytes += frame.payload.byteLength
  }

  close(error?: unknown): void {
    if (this.#closed) {
      return
    }
    this.#closed = true
    this.state.close()
    for (const waiter of this.#waiters.splice(0)) {
      if (waiter.abort !== undefined) {
        waiter.signal?.removeEventListener('abort', waiter.abort)
      }
      waiter.reject(
        error ??
          new AgentProtocolClientError(
            'Binary Agent channel closed',
            'closed'
          )
      )
    }
    this.#queue = []
    this.#queueBytes = 0
    for (const listener of this.#closeListeners) {
      listener(error)
    }
    this.#closeListeners.clear()
    this.#client.releaseBinaryChannel(this)
  }

  #consumable(queued: QueuedBinaryFrame): AgentConsumedFrame {
    return {
      payload: queued.frame.payload,
      sequence: queued.frame.header.sequence,
      consume: async () => {
        if (queued.consumed) {
          return
        }
        queued.consumed = true
        if (this.kind === 'acp') {
          await this.#client.sendFrameAcknowledgment(
            this.state,
            queued.frame.header.sequence
          )
        }
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new AgentProtocolClientError(
        'Binary Agent channel is closed',
        'closed'
      )
    }
  }
}

export class AgentProtocolClient {
  readonly #transport: AgentAttachTransport
  readonly #channels: AgentConnectionChannels
  readonly #pending = new Map<string, PendingRequest>()
  readonly #abandoned = new Map<string, AbandonedRequest>()
  readonly #binaryChannels = new Map<string, AgentProtocolBinaryChannel>()
  readonly #retired = new Set<string>()
  readonly #allocatedEpochs = new Set<string>()
  #nextChannelEpoch = 1n
  #nextChannelNumber = 1
  #closed = false
  #closeError?: AgentProtocolClientError
  #unsubscribeClose: () => void
  #closeListeners = new Set<(error: AgentProtocolClientError) => void>()

  constructor(transport: AgentAttachTransport) {
    this.#transport = transport
    this.#channels = new AgentConnectionChannels({
      connectionId: transport.welcome.connectionId,
      generation: transport.welcome.generation
    })
    this.#unsubscribeClose = transport.onClose((error) => {
      this.#close(
        new AgentProtocolClientError(
          'Agent protocol transport closed',
          'closed',
          error
        )
      )
    })
    void this.#readLoop()
  }

  get connectionId(): string {
    return this.#transport.welcome.connectionId
  }

  get generation(): number {
    return this.#transport.welcome.generation
  }

  get welcome(): AgentAttachTransport['welcome'] {
    return this.#transport.welcome
  }

  onClose(
    listener: (error: AgentProtocolClientError) => void
  ): () => void {
    if (this.#closeError !== undefined) {
      queueMicrotask(() => listener(this.#closeError!))
      return () => undefined
    }
    this.#closeListeners.add(listener)
    return () => this.#closeListeners.delete(listener)
  }

  request<M extends AgentProtocolMethod>(
    method: M,
    params: AgentProtocolParams<M>,
    options: AgentProtocolRequestOptions = {}
  ): Promise<AgentProtocolResult<M>> {
    this.#assertOpen()
    options.signal?.throwIfAborted()
    if (
      this.#pending.size + this.#abandoned.size >=
      MAXIMUM_PENDING_REQUESTS
    ) {
      return Promise.reject(
        new AgentProtocolClientError(
          'Agent protocol request tracking limit reached',
          'capacity'
        )
      )
    }
    const definition = AGENT_PROTOCOL_METHODS[method]
    const parsedParams = definition.params.parse(params)
    const { state, requestId } = this.#allocateChannel('control')
    return new Promise<AgentProtocolResult<M>>((resolve, reject) => {
      const pending: PendingRequest = {
        channel: state,
        requestId,
        method,
        resultSchema: definition.result,
        resolve: (value) => resolve(value as AgentProtocolResult<M>),
        reject,
        signal: options.signal,
        canceled: false,
        nextDataSequence: 1n,
        nextAckSequence: 1n
      }
      if (options.signal !== undefined) {
        pending.abort = (): void => {
          if (pending.canceled) {
            return
          }
          pending.canceled = true
          this.#abandonPending(pending)
          reject(
            options.signal?.reason ??
              new DOMException('Aborted', 'AbortError')
          )
        }
        options.signal.addEventListener('abort', pending.abort, {
          once: true
        })
      }
      this.#pending.set(state.channelId, pending)
      const request = {
        jsonrpc: '2.0' as const,
        id: requestId,
        method,
        params: parsedParams
      }
      void this.sendOnChannel(
        state,
        'control',
        Buffer.from(JSON.stringify(request), 'utf8')
      ).catch((error: unknown) => {
        this.#retirePending(pending, error)
      })
    })
  }

  registerBinaryChannel(input: {
    channelId: string
    channelEpoch: string
    kind: Extract<AgentFrameKind, 'acp' | 'blob'>
    nextInboundSequence?: string
    nextOutboundSequence?: string
  }): AgentProtocolBinaryChannel {
    this.#assertOpen()
    if (this.#allocatedEpochs.has(input.channelEpoch)) {
      throw new AgentProtocolClientError(
        'Agent channel epoch cannot be reused in a connection',
        'protocol'
      )
    }
    const state = this.#channels.open({
      channelId: input.channelId,
      channelEpoch: input.channelEpoch,
      inboundDirection: 'agent-to-main',
      ...(input.nextInboundSequence === undefined
        ? {}
        : { nextInboundSequence: input.nextInboundSequence }),
      ...(input.nextOutboundSequence === undefined
        ? {}
        : { nextOutboundSequence: input.nextOutboundSequence })
    })
    const channel = new AgentProtocolBinaryChannel(
      this,
      state,
      input.kind
    )
    this.#allocatedEpochs.add(input.channelEpoch)
    this.#binaryChannels.set(input.channelId, channel)
    return channel
  }

  /**
   * Allocates and registers a Main-authoritative binary channel before the
   * Agent has any authority for that channel identity.
   */
  allocateBinaryChannel(input: {
    kind: Extract<AgentFrameKind, 'blob'>
  }): AgentProtocolBinaryChannel {
    this.#assertOpen()
    const { state } = this.#allocateChannel(input.kind)
    const channel = new AgentProtocolBinaryChannel(
      this,
      state,
      input.kind
    )
    this.#binaryChannels.set(state.channelId, channel)
    return channel
  }

  async closeBinaryChannel(
    channel: AgentProtocolBinaryChannel,
    notifyPeer: boolean
  ): Promise<void> {
    if (this.#binaryChannels.get(channel.channelId) !== channel) {
      channel.close()
      return
    }
    try {
      if (notifyPeer && !this.#closed) {
        const notification = jsonRpcNotificationSchema.parse({
          jsonrpc: '2.0',
          method: CHANNEL_CLOSE_METHOD,
          params: channelCloseRequestSchema.parse({
            channelId: channel.channelId,
            channelEpoch: channel.channelEpoch
          })
        })
        await this.sendOnChannel(
          channel.state,
          'control',
          Buffer.from(JSON.stringify(notification), 'utf8')
        )
      }
    } finally {
      channel.close()
    }
  }

  releaseBinaryChannel(channel: AgentProtocolBinaryChannel): void {
    if (this.#binaryChannels.get(channel.channelId) !== channel) {
      return
    }
    this.#binaryChannels.delete(channel.channelId)
    this.#channels.close(channel.channelId)
    this.#retireId(channel.channelId)
  }

  async sendOnChannel(
    channel: AgentChannelState,
    kind: AgentFrameKind,
    payload: Uint8Array
  ): Promise<void> {
    this.#assertOpen()
    await this.#transport.send(
      this.#reserveOutboundFrame(channel, kind, payload)
    )
  }

  #reserveOutboundFrame(
    channel: AgentChannelState,
    kind: AgentFrameKind,
    payload: Uint8Array
  ): AgentFrame {
    return {
      header: channel.reserveOutbound({
        protocolMajor: AGENT_PROTOCOL_VERSION.major,
        protocolMinor: AGENT_PROTOCOL_VERSION.minor,
        connectionId: this.connectionId,
        generation: this.generation,
        channelId: channel.channelId,
        channelEpoch: channel.channelEpoch,
        direction: 'main-to-agent',
        kind,
        payloadLength: payload.byteLength
      }),
      payload
    }
  }

  async sendFrameAcknowledgment(
    channel: AgentChannelState,
    acknowledgedSequence: string
  ): Promise<void> {
    const value = frameAcknowledgmentSchema.parse({
      acknowledgedSequence
    })
    await this.sendOnChannel(
      channel,
      'ack',
      Buffer.from(JSON.stringify(value), 'utf8')
    )
  }

  dispose(): void {
    this.#close(
      new AgentProtocolClientError(
        'Agent protocol client was disposed',
        'closed'
      )
    )
    this.#transport.dispose()
  }

  async #readLoop(): Promise<void> {
    try {
      while (!this.#closed) {
        const frame = await this.#transport.receive()
        await this.#acceptFrame(frame)
      }
    } catch (error) {
      if (!this.#closed) {
        this.#close(
          new AgentProtocolClientError(
            'Agent protocol reader failed',
            'protocol',
            error
          )
        )
      }
    }
  }

  async #acceptFrame(frame: AgentFrame): Promise<void> {
    const binary = this.#binaryChannels.get(frame.header.channelId)
    if (binary !== undefined) {
      binary.state.acceptInbound(frame.header)
      if (frame.header.kind === 'ack') {
        parseFrameAcknowledgment(frame)
      } else if (frame.header.kind === binary.kind) {
        binary.accept(frame)
      } else if (frame.header.kind === 'control') {
        await this.#acceptBinaryClose(binary, frame)
      } else {
        throw new AgentProtocolClientError(
          'Unexpected frame kind on binary Agent channel',
          'protocol'
        )
      }
      return
    }
    const abandoned = this.#abandoned.get(frame.header.channelId)
    if (abandoned !== undefined) {
      this.#acceptAbandonedFrame(abandoned, frame)
      return
    }
    const pending = this.#pending.get(frame.header.channelId)
    if (pending === undefined) {
      if (this.#retired.has(frame.header.channelId)) {
        throw new AgentProtocolClientError(
          'Received a stale frame for a retired Agent channel',
          'protocol'
        )
      }
      throw new AgentProtocolClientError(
        'Received a frame for an unknown Agent channel',
        'protocol'
      )
    }
    pending.channel.acceptInbound(frame.header)
    if (frame.header.kind === 'ack') {
      parseFrameAcknowledgment(frame)
      pending.nextAckSequence += 1n
      return
    }
    if (frame.header.kind !== 'control') {
      throw new AgentProtocolClientError(
        'Control request channel received a non-control frame',
        'protocol'
      )
    }
    pending.nextDataSequence += 1n
    const message = parseControl(frame)
    if ('method' in message) {
      if (message.method !== CHANNEL_CLOSE_METHOD) {
        throw new AgentProtocolClientError(
          'Agent sent an unsupported control notification',
          'protocol'
        )
      }
      const close = channelCloseRequestSchema.parse(message.params)
      if (
        close.channelId !== pending.channel.channelId ||
        close.channelEpoch !== pending.channel.channelEpoch ||
        pending.response === undefined
      ) {
        throw new AgentProtocolClientError(
          'Agent channel close did not match a completed response',
          'protocol'
        )
      }
      this.#settlePending(pending)
      return
    }
    if (
      message.id !== pending.requestId ||
      pending.response !== undefined
    ) {
      throw new AgentProtocolClientError(
        'Agent response identity is invalid',
        'protocol'
      )
    }
    if ('error' in message) {
      pending.response = {
        error: new AgentRpcError(
          message.error.code,
          message.error.message,
          message.error.data
        )
      }
    } else {
      pending.response = {
        result: pending.resultSchema.parse(message.result)
      }
    }
  }

  #acceptAbandonedFrame(
    abandoned: AbandonedRequest,
    frame: AgentFrame
  ): void {
    if (
      frame.header.channelEpoch !== abandoned.channelEpoch ||
      frame.header.direction !== 'agent-to-main'
    ) {
      throw new AgentProtocolClientError(
        'Abandoned Agent channel identity is invalid',
        'protocol'
      )
    }
    const expected =
      frame.header.kind === 'ack'
        ? abandoned.nextAckSequence
        : abandoned.nextDataSequence
    if (BigInt(frame.header.sequence) !== expected) {
      throw new AgentProtocolClientError(
        'Abandoned Agent channel sequence is invalid',
        'protocol'
      )
    }
    if (frame.header.kind === 'ack') {
      parseFrameAcknowledgment(frame)
      abandoned.nextAckSequence += 1n
      return
    }
    if (frame.header.kind !== 'control') {
      throw new AgentProtocolClientError(
        'Abandoned request received an invalid frame kind',
        'protocol'
      )
    }
    abandoned.nextDataSequence += 1n
    const message = parseControl(frame)
    if ('method' in message) {
      if (message.method !== CHANNEL_CLOSE_METHOD) {
        throw new AgentProtocolClientError(
          'Abandoned request received an invalid notification',
          'protocol'
        )
      }
      const close = channelCloseRequestSchema.parse(message.params)
      if (
        close.channelId !== abandoned.channelId ||
        close.channelEpoch !== abandoned.channelEpoch ||
        !abandoned.responseSeen
      ) {
        throw new AgentProtocolClientError(
          'Abandoned Agent channel close identity is invalid',
          'protocol'
        )
      }
      this.#abandoned.delete(abandoned.channelId)
      this.#retireId(abandoned.channelId)
      return
    }
    if (
      message.id !== abandoned.requestId ||
      abandoned.responseSeen
    ) {
      throw new AgentProtocolClientError(
        'Abandoned Agent response identity is invalid',
        'protocol'
      )
    }
    abandoned.responseSeen = true
  }

  async #acceptBinaryClose(
    binary: AgentProtocolBinaryChannel,
    frame: AgentFrame
  ): Promise<void> {
    const message = parseControl(frame)
    const notification = jsonRpcNotificationSchema.parse(message)
    if (notification.method !== CHANNEL_CLOSE_METHOD) {
      throw new AgentProtocolClientError(
        'Unexpected binary channel control message',
        'protocol'
      )
    }
    const close = channelCloseRequestSchema.parse(notification.params)
    if (
      close.channelId !== binary.channelId ||
      close.channelEpoch !== binary.channelEpoch
    ) {
      throw new AgentProtocolClientError(
        'Binary channel close identity mismatch',
        'protocol'
      )
    }
    binary.close()
  }

  #allocateChannel(kind: AgentFrameKind): {
    state: AgentChannelState
    requestId: string
  } {
    const entropy = randomBytes(8).toString('hex')
    const channelId = `main-${this.#nextChannelNumber}-${entropy}`
    this.#nextChannelNumber += 1
    while (
      this.#allocatedEpochs.has(this.#nextChannelEpoch.toString())
    ) {
      this.#nextChannelEpoch += 1n
    }
    const channelEpoch = this.#nextChannelEpoch.toString()
    this.#nextChannelEpoch += 1n
    this.#allocatedEpochs.add(channelEpoch)
    return {
      state: this.#channels.open({
        channelId,
        channelEpoch,
        inboundDirection: 'agent-to-main'
      }),
      requestId: `${kind}-${entropy}`
    }
  }

  #settlePending(pending: PendingRequest): void {
    const response = pending.response
    if (response === undefined) {
      throw new AgentProtocolClientError(
        'Agent channel closed before its response',
        'protocol'
      )
    }
    this.#pending.delete(pending.channel.channelId)
    this.#channels.close(pending.channel.channelId)
    this.#retireId(pending.channel.channelId)
    if (pending.abort !== undefined) {
      pending.signal?.removeEventListener('abort', pending.abort)
    }
    if (pending.canceled) {
      return
    }
    if (response.error !== undefined) {
      pending.reject(response.error)
    } else {
      pending.resolve(response.result)
    }
  }

  #retirePending(pending: PendingRequest, error: unknown): void {
    if (!this.#pending.delete(pending.channel.channelId)) {
      if (this.#abandoned.delete(pending.channel.channelId)) {
        this.#retireId(pending.channel.channelId)
      }
      return
    }
    this.#channels.close(pending.channel.channelId)
    this.#retireId(pending.channel.channelId)
    if (pending.abort !== undefined) {
      pending.signal?.removeEventListener('abort', pending.abort)
    }
    if (!pending.canceled) {
      pending.reject(error)
    }
  }

  #abandonPending(pending: PendingRequest): void {
    if (!this.#pending.delete(pending.channel.channelId)) {
      return
    }
    if (pending.abort !== undefined) {
      pending.signal?.removeEventListener('abort', pending.abort)
    }
    this.#channels.close(pending.channel.channelId)
    this.#abandoned.set(pending.channel.channelId, {
      channelId: pending.channel.channelId,
      channelEpoch: pending.channel.channelEpoch,
      requestId: pending.requestId,
      nextDataSequence: pending.nextDataSequence,
      nextAckSequence: pending.nextAckSequence,
      responseSeen: pending.response !== undefined
    })
  }

  #retireId(channelId: string): void {
    this.#retired.add(channelId)
    if (this.#retired.size > MAXIMUM_RETIRED_CHANNELS) {
      this.#close(
        new AgentProtocolClientError(
          'Agent channel identity lifetime exhausted',
          'capacity'
        )
      )
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw (
        this.#closeError ??
        new AgentProtocolClientError(
          'Agent protocol client is closed',
          'closed'
        )
      )
    }
  }

  #close(error: AgentProtocolClientError): void {
    if (this.#closed) {
      return
    }
    this.#closed = true
    this.#closeError = error
    this.#unsubscribeClose()
    for (const pending of this.#pending.values()) {
      if (pending.abort !== undefined) {
        pending.signal?.removeEventListener('abort', pending.abort)
      }
      if (!pending.canceled) {
        pending.reject(error)
      }
    }
    this.#pending.clear()
    this.#abandoned.clear()
    for (const channel of this.#binaryChannels.values()) {
      channel.close(error)
    }
    this.#binaryChannels.clear()
    for (const listener of this.#closeListeners) {
      listener(error)
    }
    this.#closeListeners.clear()
  }
}

function parseControl(frame: AgentFrame) {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(frame.payload).toString('utf8'))
  } catch (error) {
    throw new AgentProtocolClientError(
      'Agent sent invalid JSON control payload',
      'protocol',
      error
    )
  }
  return jsonRpcMessageSchema.parse(value)
}

function parseFrameAcknowledgment(frame: AgentFrame): void {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(frame.payload).toString('utf8'))
  } catch (error) {
    throw new AgentProtocolClientError(
      'Agent sent invalid frame ACK JSON',
      'protocol',
      error
    )
  }
  frameAcknowledgmentSchema.parse(value)
}
