import type { Socket } from 'node:net'
import {
  AGENT_PROTOCOL_LIMITS,
  AGENT_PROTOCOL_VERSION,
  agentProtocolFailureCategorySchema,
  agentIdentifierSchema,
  agentSequenceSchema,
  channelCloseRequestSchema,
  controllerResumeRequestSchema,
  controllerResumeResultSchema,
  daemonCapabilitiesSchema,
  daemonStatusSchema,
  frameAcknowledgmentSchema,
  jsonRpcNotificationSchema,
  jsonRpcRequestSchema,
  positiveAgentSequenceSchema,
  type DaemonCapabilities,
  type AgentProtocolFailureCategory,
  type FrameAcknowledgment,
  type JsonRpcNotification,
  type JsonRpcRequest
} from '../shared/agent-protocol'
import {
  AGENT_FRAME_FIXED_HEADER_BYTES,
  MAXIMUM_ENCODED_AGENT_FRAME_BYTES,
  decodeAgentFrame,
  encodeAgentFrame,
  inspectAgentFramePrefix,
  type AgentFrame
} from '../shared/agent-protocol/frame'
import {
  AgentConnectionChannels,
  type AgentChannelState
} from '../shared/agent-protocol/channel-state'
import type { ControllerLease, ControllerRegistry } from './controller-registry'
import type { EventJournal } from './event-journal'

type IncomingQueueLimits = {
  maximumItems: number
  maximumBytes: number
  maximumBufferedBytes: number
}

type AdmittedFrame = {
  frame: AgentFrame
  channel: AgentChannelState
  encodedByteLength: number
  request?: JsonRpcRequest | JsonRpcNotification
  acknowledgment?: FrameAcknowledgment
}

const DEFAULT_INCOMING_QUEUE_LIMITS: IncomingQueueLimits = {
  maximumItems: AGENT_PROTOCOL_LIMITS.maximumChannelsPerConnection * 4,
  maximumBytes: AGENT_PROTOCOL_LIMITS.maximumBufferedProtocolBytes,
  maximumBufferedBytes: MAXIMUM_ENCODED_AGENT_FRAME_BYTES
}
const CHANNEL_CLOSE_METHOD = 'channel/close'
const WORKSPACE_READ_METHODS = [
  'workspace/validate',
  'workspace/open',
  'workspace/resume',
  'workspace/close',
  'workspace/list',
  'workspace/stat',
  'workspace/readText',
  'workspace/search',
  'git/status',
  'git/diff'
] as const
const RUNTIME_ACP_METHODS = [
  'runtime/openAcpChannel',
  'runtime/closeAcpChannel',
  'runtime/resumeAcpChannel',
  'runtime/replayAcpChannel',
  'runtime/preparePrompt',
  'runtime/completePrompt',
  'runtime/getAcpCursors',
  'runtime/escalateCancellation',
  'runtime/reconcilePrompt'
] as const

export type ProtocolMethodContext = {
  controller: ControllerLease
  channelId: string
  signal?: AbortSignal
}

export type ProtocolMethodHandler = (
  params: unknown,
  context: ProtocolMethodContext
) => unknown | Promise<unknown>

export class AgentProtocolServer {
  readonly #controllers: ControllerRegistry
  readonly #events: EventJournal
  readonly #status: () => unknown | Promise<unknown>
  readonly #runtimes: () =>
    | DaemonCapabilities['runtimes']
    | Promise<DaemonCapabilities['runtimes']>
  readonly #methods: Readonly<Record<string, ProtocolMethodHandler>>
  readonly #onAcpFrame?: (
    frame: AgentFrame,
    context: ProtocolMethodContext
  ) => void | Promise<void>
  readonly #onBlobFrame?: (
    frame: AgentFrame,
    context: ProtocolMethodContext
  ) => void | Promise<void>
  readonly #authorizeBlobFrame?: (
    frame: AgentFrame,
    controller: ControllerLease
  ) => boolean
  readonly #incomingQueueLimits: IncomingQueueLimits
  readonly #onProtocolFailure?: (input: {
    connectionId: string
    category: AgentProtocolFailureCategory
  }) => void
  readonly #connections = new Map<string, ProtocolConnection>()

  constructor(options: {
    controllers: ControllerRegistry
    events: EventJournal
    status: () => unknown | Promise<unknown>
    runtimes?: () =>
      | DaemonCapabilities['runtimes']
      | Promise<DaemonCapabilities['runtimes']>
    methods?: Readonly<Record<string, ProtocolMethodHandler>>
    onAcpFrame?: (
      frame: AgentFrame,
      context: ProtocolMethodContext
    ) => void | Promise<void>
    onBlobFrame?: (
      frame: AgentFrame,
      context: ProtocolMethodContext
    ) => void | Promise<void>
    authorizeBlobFrame?: (
      frame: AgentFrame,
      controller: ControllerLease
    ) => boolean
    onProtocolFailure?: (input: {
      connectionId: string
      category: AgentProtocolFailureCategory
    }) => void
    incomingQueueLimits?: Partial<IncomingQueueLimits>
  }) {
    this.#controllers = options.controllers
    this.#events = options.events
    this.#status = options.status
    this.#runtimes = options.runtimes ?? (() => [])
    this.#methods = options.methods ?? {}
    this.#onAcpFrame = options.onAcpFrame
    this.#onBlobFrame = options.onBlobFrame
    this.#authorizeBlobFrame = options.authorizeBlobFrame
    this.#onProtocolFailure = options.onProtocolFailure
    this.#incomingQueueLimits = incomingQueueLimits(
      options.incomingQueueLimits
    )
  }

  accept(socket: Socket, controller: ControllerLease): void {
    const connection = new ProtocolConnection({
      socket,
      controller,
      controllers: this.#controllers,
      methods: {
        'agent/status': async (params) => {
          emptyParams(params)
          return daemonStatusSchema.parse(await this.#status())
        },
        'agent/doctor': async (params) => {
          emptyParams(params)
          return daemonStatusSchema.parse(await this.#status())
        },
        'agent/capabilities': async (params) => {
          emptyParams(params)
          const current = this.#controllers.assertCurrent(
            controller.controllerId,
            controller.generation
          )
          const runtimeAcpImplemented =
            this.#onAcpFrame !== undefined &&
            RUNTIME_ACP_METHODS.every(
              (method) => this.#methods[method] !== undefined
            )
          const modelBridgeImplemented =
            runtimeAcpImplemented &&
            this.#onBlobFrame !== undefined &&
            this.#authorizeBlobFrame !== undefined
          const runtimes = runtimeAcpImplemented
            ? await this.#runtimes()
            : []
          return daemonCapabilitiesSchema.parse({
            generation: current.capabilityGeneration,
            capabilities: [
              { name: 'agent/control', version: 1, critical: true },
              ...(WORKSPACE_READ_METHODS.every(
                (method) => this.#methods[method] !== undefined
              )
                ? [
                    {
                      name: 'workspace/read',
                      version: 1,
                      critical: true
                    }
                  ]
                : []),
              ...(runtimes.length > 0
                ? [
                    {
                      name: 'runtime/acp',
                      version: 3,
                      critical: true
                    },
                    ...(modelBridgeImplemented
                      ? [
                          {
                            name: 'runtime/model-bridge',
                            version: 1,
                            critical: true
                          }
                        ]
                      : [])
                  ]
                : [])
            ],
            runtimes
          })
        },
        'controller/resume': async (params) => {
          const request = controllerResumeRequestSchema.parse(params)
          const status = daemonStatusSchema.parse(await this.#status())
          if (
            request.daemonBootId !== status.daemonBootId ||
            request.previousGeneration >= controller.generation
          ) {
            return controllerResumeResultSchema.parse({
              resumed: false,
              generation: controller.generation,
              daemonBootId: status.daemonBootId,
              capabilityGeneration: controller.capabilityGeneration,
              leaseDeadlineAt: new Date(
                controller.leaseExpiresAt
              ).toISOString()
            })
          }
          let resumed: ControllerLease
          try {
            resumed = this.#controllers.takeover(
              controller.controllerId,
              controller.generation,
              request
            )
          } catch {
            return controllerResumeResultSchema.parse({
              resumed: false,
              generation: controller.generation,
              daemonBootId: status.daemonBootId,
              capabilityGeneration: controller.capabilityGeneration,
              leaseDeadlineAt: new Date(
                controller.leaseExpiresAt
              ).toISOString()
            })
          }
          this.#connections
            .get(request.previousConnectionId)
            ?.fence()
          return controllerResumeResultSchema.parse({
            resumed: true,
            generation: resumed.generation,
            daemonBootId: status.daemonBootId,
            capabilityGeneration: resumed.capabilityGeneration,
            leaseDeadlineAt: new Date(
              resumed.leaseExpiresAt
            ).toISOString()
          })
        },
        ...this.#methods
      },
      events: this.#events,
      onAcpFrame: this.#onAcpFrame,
      onBlobFrame: this.#onBlobFrame,
      incomingQueueLimits: this.#incomingQueueLimits,
      onClose: (category) => {
        if (category !== undefined) {
          this.#onProtocolFailure?.({
            connectionId: controller.connectionId,
            category
          })
        }
        if (
          this.#connections.get(controller.connectionId) === connection
        ) {
          this.#connections.delete(controller.connectionId)
        }
      }
    })
    this.#connections.set(controller.connectionId, connection)
    connection.start()
  }

  async sendAcpFrame(frame: AgentFrame): Promise<void> {
    const connection = this.#connections.get(
      frame.header.connectionId
    )
    if (connection === undefined) {
      throw new Error('ACP controller connection is unavailable')
    }
    this.#controllers.assertCurrent(
      connection.controller.controllerId,
      connection.controller.generation
    )
    await connection.sendAcpFrame(frame)
  }

  async sendBlobFrame(frame: AgentFrame): Promise<void> {
    const connection = this.#connections.get(
      frame.header.connectionId
    )
    if (connection === undefined) {
      throw new Error('Blob controller connection is unavailable')
    }
    this.#controllers.assertCurrent(
      connection.controller.controllerId,
      connection.controller.generation
    )
    if (
      this.#authorizeBlobFrame === undefined ||
      !this.#authorizeBlobFrame(frame, connection.controller)
    ) {
      throw new Error(
        'Outgoing blob channel has no active prompt authority'
      )
    }
    await connection.sendBlobFrame(frame)
  }
}

class ProtocolConnection {
  readonly #socket: Socket
  readonly #controller: ControllerLease
  readonly #controllers: ControllerRegistry
  readonly #methods: Readonly<Record<string, ProtocolMethodHandler>>
  readonly #events: EventJournal
  readonly #onAcpFrame?: (
    frame: AgentFrame,
    context: ProtocolMethodContext
  ) => void | Promise<void>
  readonly #onBlobFrame?: (
    frame: AgentFrame,
    context: ProtocolMethodContext
  ) => void | Promise<void>
  readonly #channels: AgentConnectionChannels
  readonly #incomingQueueLimits: IncomingQueueLimits
  readonly #onClose: (
    category?: AgentProtocolFailureCategory
  ) => void
  readonly #channelKinds = new Map<
    string,
    'control' | 'acp' | 'blob'
  >()
  #inputChunks: Buffer[] = []
  #inputHeadOffset = 0
  #bufferedInputBytes = 0
  #queue: AdmittedFrame[] = []
  #queuedBytes = 0
  #draining = false
  #closed = false
  #writeTail: Promise<void> = Promise.resolve()
  readonly #abortController = new AbortController()
  #takeoverProven = false

  get controller(): ControllerLease {
    return this.#controller
  }

  constructor(options: {
    socket: Socket
    controller: ControllerLease
    controllers: ControllerRegistry
    methods: Readonly<Record<string, ProtocolMethodHandler>>
    events: EventJournal
    onAcpFrame?: (
      frame: AgentFrame,
      context: ProtocolMethodContext
    ) => void | Promise<void>
    onBlobFrame?: (
      frame: AgentFrame,
      context: ProtocolMethodContext
    ) => void | Promise<void>
    incomingQueueLimits: IncomingQueueLimits
    onClose: (
      category?: AgentProtocolFailureCategory
    ) => void
  }) {
    this.#socket = options.socket
    this.#controller = options.controller
    this.#controllers = options.controllers
    this.#methods = options.methods
    this.#events = options.events
    this.#onAcpFrame = options.onAcpFrame
    this.#onBlobFrame = options.onBlobFrame
    this.#incomingQueueLimits = options.incomingQueueLimits
    this.#onClose = options.onClose
    this.#channels = new AgentConnectionChannels({
      connectionId: options.controller.connectionId,
      generation: options.controller.generation
    })
  }

  start(): void {
    this.#socket.on('data', (chunk: Buffer) => {
      if (this.#closed) {
        return
      }
      this.#socket.pause()
      if (
        this.#queuedBytes +
          this.#bufferedInputBytes +
          chunk.byteLength >
        this.#incomingQueueLimits.maximumBytes +
          this.#incomingQueueLimits.maximumBufferedBytes
      ) {
        this.#close('input-overflow')
        return
      }
      if (chunk.byteLength > 0) {
        this.#inputChunks.push(chunk)
        this.#bufferedInputBytes += chunk.byteLength
      }
      try {
        this.#pumpInput()
      } catch (error) {
        this.#close(protocolFailureCategory('input', error))
      }
    })
    this.#socket.once('error', () => this.#close('socket-error'))
    this.#socket.once('close', () => this.#close())
  }

  fence(): void {
    this.#close()
  }

  async sendAcpFrame(frame: AgentFrame): Promise<void> {
    if (
      frame.header.kind !== 'acp' ||
      frame.header.direction !== 'agent-to-main' ||
      frame.header.connectionId !== this.#controller.connectionId ||
      frame.header.generation !== this.#controller.generation
    ) {
      throw new Error('Outgoing ACP frame identity is invalid')
    }
    const channel = this.#channels.get(frame.header.channelId)
    if (
      channel === undefined ||
      channel.channelEpoch !== frame.header.channelEpoch
    ) {
      throw new Error('Outgoing ACP channel is unavailable')
    }
    this.#assertOrBindChannelKind(channel.channelId, 'acp')
    const header = channel.reserveOutbound({
      protocolMajor: AGENT_PROTOCOL_VERSION.major,
      protocolMinor: AGENT_PROTOCOL_VERSION.minor,
      connectionId: this.#controller.connectionId,
      generation: this.#controller.generation,
      channelId: channel.channelId,
      channelEpoch: channel.channelEpoch,
      direction: 'agent-to-main',
      kind: 'acp',
      payloadLength: frame.payload.byteLength
    })
    if (header.sequence !== frame.header.sequence) {
      throw new Error('Outgoing ACP sequence does not match its journal')
    }
    await this.#writeEncoded({ header, payload: frame.payload })
  }

  async sendBlobFrame(frame: AgentFrame): Promise<void> {
    if (
      frame.header.kind !== 'blob' ||
      frame.header.direction !== 'agent-to-main' ||
      frame.header.connectionId !== this.#controller.connectionId ||
      frame.header.generation !== this.#controller.generation
    ) {
      throw new Error('Outgoing blob frame identity is invalid')
    }
    let channel = this.#channels.get(frame.header.channelId)
    if (channel === undefined) {
      channel = this.#channels.open({
        channelId: frame.header.channelId,
        channelEpoch: frame.header.channelEpoch,
        inboundDirection: 'main-to-agent'
      })
    }
    if (channel.channelEpoch !== frame.header.channelEpoch) {
      throw new Error('Outgoing blob channel is unavailable')
    }
    this.#assertOrBindChannelKind(channel.channelId, 'blob')
    const header = channel.reserveOutbound({
      protocolMajor: AGENT_PROTOCOL_VERSION.major,
      protocolMinor: AGENT_PROTOCOL_VERSION.minor,
      connectionId: this.#controller.connectionId,
      generation: this.#controller.generation,
      channelId: channel.channelId,
      channelEpoch: channel.channelEpoch,
      direction: 'agent-to-main',
      kind: 'blob',
      payloadLength: frame.payload.byteLength
    })
    if (header.sequence !== frame.header.sequence) {
      throw new Error('Outgoing blob sequence does not match its channel')
    }
    await this.#writeEncoded({ header, payload: frame.payload })
  }

  #pumpInput(): void {
    while (
      !this.#closed &&
      this.#bufferedInputBytes >= AGENT_FRAME_FIXED_HEADER_BYTES
    ) {
      const prefix = inspectAgentFramePrefix(
        this.#peekInput(AGENT_FRAME_FIXED_HEADER_BYTES)
      )
      const frameLength = prefix.encodedByteLength
      if (frameLength > MAXIMUM_ENCODED_AGENT_FRAME_BYTES) {
        throw new Error('Invalid incoming frame length')
      }
      if (this.#bufferedInputBytes < frameLength) {
        break
      }
      if (frameLength > this.#incomingQueueLimits.maximumBytes) {
        throw new Error('Incoming frame exceeds queue byte limit')
      }
      if (
        this.#queue.length >= this.#incomingQueueLimits.maximumItems ||
        this.#queuedBytes + frameLength >
          this.#incomingQueueLimits.maximumBytes
      ) {
        this.#startDrain()
        return
      }
      const encoded = this.#takeInput(frameLength)
      const admitted = this.#admitFrame(encoded, frameLength)
      this.#queue.push(admitted)
      this.#queuedBytes += frameLength
    }
    this.#startDrain()
    if (
      !this.#closed &&
      !this.#draining &&
      this.#queue.length < this.#incomingQueueLimits.maximumItems &&
      this.#queuedBytes < this.#incomingQueueLimits.maximumBytes
    ) {
      this.#socket.resume()
    }
  }

  #peekInput(byteLength: number): Buffer {
    const first = this.#inputChunks[0]
    if (first === undefined || byteLength > this.#bufferedInputBytes) {
      throw new Error('Incoming frame is incomplete')
    }
    const available = first.byteLength - this.#inputHeadOffset
    if (available >= byteLength) {
      return first.subarray(
        this.#inputHeadOffset,
        this.#inputHeadOffset + byteLength
      )
    }
    const result = Buffer.allocUnsafe(byteLength)
    let written = 0
    let index = 0
    let offset = this.#inputHeadOffset
    while (written < byteLength) {
      const chunk = this.#inputChunks[index]
      if (chunk === undefined) {
        throw new Error('Incoming frame is incomplete')
      }
      const copied = Math.min(
        chunk.byteLength - offset,
        byteLength - written
      )
      chunk.copy(result, written, offset, offset + copied)
      written += copied
      index += 1
      offset = 0
    }
    return result
  }

  #takeInput(byteLength: number): Buffer {
    const first = this.#inputChunks[0]
    if (first === undefined || byteLength > this.#bufferedInputBytes) {
      throw new Error('Incoming frame is incomplete')
    }
    const available = first.byteLength - this.#inputHeadOffset
    let result: Buffer
    if (available >= byteLength) {
      result = first.subarray(
        this.#inputHeadOffset,
        this.#inputHeadOffset + byteLength
      )
    } else {
      result = this.#peekInput(byteLength)
    }
    let remaining = byteLength
    while (remaining > 0) {
      const chunk = this.#inputChunks[0]!
      const inChunk = chunk.byteLength - this.#inputHeadOffset
      if (remaining < inChunk) {
        this.#inputHeadOffset += remaining
        remaining = 0
      } else {
        remaining -= inChunk
        this.#inputChunks.shift()
        this.#inputHeadOffset = 0
      }
    }
    this.#bufferedInputBytes -= byteLength
    return result
  }

  #admitFrame(
    encoded: Uint8Array,
    encodedByteLength: number
  ): AdmittedFrame {
    this.#controllers.assertCurrent(
      this.#controller.controllerId,
      this.#controller.generation
    )
    const frame = decodeAgentFrame(encoded, {
      protocolMajor: AGENT_PROTOCOL_VERSION.major,
      maximumProtocolMinor: AGENT_PROTOCOL_VERSION.minor,
      connectionId: this.#controller.connectionId,
      generation: this.#controller.generation
    })
    let channel = this.#channels.get(frame.header.channelId)
    if (channel === undefined) {
      channel = this.#channels.open({
        channelId: frame.header.channelId,
        channelEpoch: frame.header.channelEpoch,
        inboundDirection: 'main-to-agent'
      })
    }
    channel.acceptInbound(frame.header)
    if (frame.header.kind === 'ack') {
      const acknowledgment = frameAcknowledgmentSchema.parse(
        JSON.parse(Buffer.from(frame.payload).toString('utf8'))
      )
      return {
        frame,
        channel,
        encodedByteLength,
        acknowledgment
      }
    }
    if (frame.header.kind === 'control') {
      const request = parseJsonRpc(frame)
      if (request.method !== CHANNEL_CLOSE_METHOD) {
        this.#assertOrBindChannelKind(channel.channelId, 'control')
      } else if (!this.#channelKinds.has(channel.channelId)) {
        this.#channelKinds.set(channel.channelId, 'control')
      }
      if ('id' in request || request.method === CHANNEL_CLOSE_METHOD) {
        channel.beginClose()
      }
      return { frame, channel, encodedByteLength, request }
    }
    if (frame.header.kind === 'acp' && this.#onAcpFrame !== undefined) {
      this.#assertOrBindChannelKind(channel.channelId, 'acp')
      return { frame, channel, encodedByteLength }
    }
    if (frame.header.kind === 'blob' && this.#onBlobFrame !== undefined) {
      this.#assertOrBindChannelKind(channel.channelId, 'blob')
      return { frame, channel, encodedByteLength }
    }
    throw new Error('No handler is registered for this channel kind')
  }

  #startDrain(): void {
    if (this.#draining || this.#closed || this.#queue.length === 0) {
      return
    }
    this.#draining = true
    void this.#drain()
  }

  async #drain(): Promise<void> {
    try {
      while (!this.#closed) {
        const admitted = this.#queue.shift()
        if (admitted === undefined) {
          break
        }
        this.#queuedBytes -= admitted.encodedByteLength
        await this.#dispatchFrame(admitted)
      }
    } catch (error) {
      this.#close(protocolFailureCategory('dispatch', error))
    } finally {
      this.#draining = false
      if (!this.#closed) {
        try {
          this.#pumpInput()
        } catch (error) {
          this.#close(protocolFailureCategory('input', error))
        }
      }
    }
  }

  #acceptFrameAcknowledgment(admitted: AdmittedFrame): void {
    this.#controllers.assertCurrent(
      this.#controller.controllerId,
      this.#controller.generation
    )
    const { channel, acknowledgment } = admitted
    if (
      acknowledgment === undefined ||
      this.#channelKinds.get(channel.channelId) !== 'acp'
    ) {
      throw new Error('Frame ACK does not match an ACP channel')
    }
    this.#events.acknowledgeAcpFromMain({
      bindingId: channel.channelId,
      channelEpoch: channel.channelEpoch,
      sequence: acknowledgment.acknowledgedSequence
    })
  }

  async #dispatchFrame(admitted: AdmittedFrame): Promise<void> {
    this.#controllers.assertCurrent(
      this.#controller.controllerId,
      this.#controller.generation
    )
    const { frame, channel } = admitted
    if (frame.header.kind === 'ack') {
      this.#acceptFrameAcknowledgment(admitted)
      return
    }
    if (frame.header.kind === 'blob') {
      if (this.#onBlobFrame === undefined) {
        throw new Error('No blob Runtime channel is bound')
      }
      await this.#onBlobFrame(frame, {
        controller: this.#controller,
        channelId: channel.channelId,
        signal: this.#abortController.signal
      })
      return
    }
    if (frame.header.kind === 'acp') {
      if (this.#onAcpFrame === undefined) {
        throw new Error('No ACP runtime channel is bound')
      }
      this.#events.appendAcpFrame({
        controllerId: this.#controller.controllerId,
        bindingId: frame.header.channelId,
        channelEpoch: frame.header.channelEpoch,
        direction: 'main-to-runtime',
        sequence: frame.header.sequence,
        payload: frame.payload
      })
      await this.#onAcpFrame(frame, {
        controller: this.#controller,
        channelId: channel.channelId,
        signal: this.#abortController.signal
      })
      this.#events.markAcpDelivered({
        bindingId: frame.header.channelId,
        channelEpoch: frame.header.channelEpoch,
        sequence: frame.header.sequence
      })
      return
    }
    if (frame.header.kind !== 'control') {
      throw new Error('No handler is registered for this channel kind')
    }
    const request = admitted.request
    if (request === undefined) {
      throw new Error('Control request was not admitted')
    }
    if (request.method === CHANNEL_CLOSE_METHOD) {
      await this.#acceptChannelClose(request, channel)
      return
    }
    if (!('id' in request)) {
      await this.#invokeNotification(request, channel)
    } else {
      await this.#invokeRequest(request, channel)
      await this.#sendChannelClose(channel)
      this.#channels.close(channel.channelId)
      this.#channelKinds.delete(channel.channelId)
      return
    }
  }

  async #acceptChannelClose(
    request: JsonRpcRequest | JsonRpcNotification,
    channel: AgentChannelState
  ): Promise<void> {
    const params = channelCloseParams(request.params)
    if (
      params.channelId !== channel.channelId ||
      params.channelEpoch !== channel.channelEpoch
    ) {
      throw new Error('Channel close target does not match its frame')
    }
    if ('id' in request) {
      await this.#sendJson(channel, {
        jsonrpc: '2.0',
        id: request.id,
        result: { closed: true }
      })
    }
    this.#channels.close(channel.channelId)
    this.#channelKinds.delete(channel.channelId)
  }

  async #invokeRequest(
    request: JsonRpcRequest,
    channel: AgentChannelState
  ): Promise<void> {
    const handler = this.#methods[request.method]
    if (handler === undefined) {
      await this.#sendJson(channel, {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: 'Method not found' }
      })
      return
    }
    try {
      if (
        (request.method === 'runtime/resumeAcpChannel' ||
          request.method === 'runtime/replayAcpChannel') &&
        !this.#takeoverProven
      ) {
        throw new Error('Controller takeover has not been proven')
      }
      const result = await handler(request.params, {
        controller: this.#controller,
        channelId: channel.channelId,
        signal: this.#abortController.signal
      })
      if (request.method === 'runtime/resumeAcpChannel') {
        this.#bindResumedAcpChannel(result)
      }
      if (
        request.method === 'controller/resume' &&
        result !== null &&
        typeof result === 'object' &&
        !Array.isArray(result) &&
        (result as { resumed?: unknown }).resumed === true
      ) {
        this.#takeoverProven = true
      }
      await this.#sendJson(channel, {
        jsonrpc: '2.0',
        id: request.id,
        result: result ?? null
      })
    } catch (error) {
      const serviceCode = typedErrorCode(error)
      await this.#sendJson(channel, {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: serviceCode === undefined ? -32602 : -32000,
          message: error instanceof Error ? error.message : 'Invalid request',
          ...(serviceCode === undefined
            ? {}
            : { data: { code: serviceCode } })
        }
      })
    }
  }

  #bindResumedAcpChannel(result: unknown): void {
    if (
      result === null ||
      typeof result !== 'object' ||
      Array.isArray(result)
    ) {
      throw new Error('Runtime resume result is invalid')
    }
    const value = result as Record<string, unknown>
    const bindingId = agentIdentifierSchema.parse(value.bindingId)
    const channelId = agentIdentifierSchema.parse(value.channelId)
    const channelEpoch = positiveAgentSequenceSchema.parse(
      value.channelEpoch
    )
    if (bindingId !== channelId) {
      throw new Error('Runtime resume channel identity is invalid')
    }
    const cursors =
      value.cursors === null ||
      typeof value.cursors !== 'object' ||
      Array.isArray(value.cursors)
        ? undefined
        : (value.cursors as Record<string, unknown>)
    if (cursors === undefined) {
      throw new Error('Runtime resume cursors are invalid')
    }
    const nextInboundSequence = (
      BigInt(agentSequenceSchema.parse(cursors.lastOutboundJournaledSequence)) +
      1n
    ).toString()
    const nextOutboundSequence = (
      BigInt(agentSequenceSchema.parse(cursors.lastMainAckSequence)) + 1n
    ).toString()
    const existing = this.#channels.get(channelId)
    if (existing !== undefined) {
      if (existing.channelEpoch !== channelEpoch) {
        throw new Error('Runtime resume channel epoch conflicts')
      }
      return
    }
    this.#channels.open({
      channelId,
      channelEpoch,
      inboundDirection: 'main-to-agent',
      nextInboundSequence,
      nextOutboundSequence
    })
    this.#assertOrBindChannelKind(channelId, 'acp')
  }

  async #invokeNotification(
    request: JsonRpcNotification,
    channel: AgentChannelState
  ): Promise<void> {
    const handler = this.#methods[request.method]
    if (handler !== undefined) {
      await handler(request.params, {
        controller: this.#controller,
        channelId: channel.channelId,
        signal: this.#abortController.signal
      })
    }
  }

  async #sendJson(
    channel: AgentChannelState,
    value: Record<string, unknown>
  ): Promise<void> {
    await this.#send(
      channel,
      'control',
      Buffer.from(JSON.stringify(value), 'utf8')
    )
  }

  async #sendChannelClose(channel: AgentChannelState): Promise<void> {
    await this.#sendJson(channel, {
      jsonrpc: '2.0',
      method: CHANNEL_CLOSE_METHOD,
      params: {
        channelId: channel.channelId,
        channelEpoch: channel.channelEpoch
      }
    })
  }

  async #send(
    channel: AgentChannelState,
    kind: 'control' | 'ack',
    payload: Uint8Array
  ): Promise<void> {
    const header = channel.reserveOutbound({
      protocolMajor: AGENT_PROTOCOL_VERSION.major,
      protocolMinor: AGENT_PROTOCOL_VERSION.minor,
      connectionId: this.#controller.connectionId,
      generation: this.#controller.generation,
      channelId: channel.channelId,
      channelEpoch: channel.channelEpoch,
      direction: 'agent-to-main',
      kind,
      payloadLength: payload.byteLength
    })
    await this.#writeEncoded({ header, payload })
  }

  async #writeEncoded(frame: AgentFrame): Promise<void> {
    const encoded = encodeAgentFrame(frame)
    const write = this.#writeTail.then(
      async () =>
        await new Promise<void>((resolve, reject) => {
          this.#socket.write(encoded, (error) => {
            if (error === null || error === undefined) {
              resolve()
            } else {
              reject(error)
            }
          })
        })
    )
    this.#writeTail = write
    await write
  }

  #close(category?: AgentProtocolFailureCategory): void {
    if (this.#closed) {
      return
    }
    this.#closed = true
    this.#abortController.abort(
      new Error('Protocol connection closed')
    )
    this.#queue = []
    this.#queuedBytes = 0
    this.#inputChunks = []
    this.#inputHeadOffset = 0
    this.#bufferedInputBytes = 0
    this.#channelKinds.clear()
    try {
      this.#controllers.disconnect(
        this.#controller.controllerId,
        this.#controller.generation
      )
    } catch {
      // A newer generation already superseded this connection.
    }
    this.#onClose(category)
    this.#socket.destroy()
  }

  #assertOrBindChannelKind(
    channelId: string,
    kind: 'control' | 'acp' | 'blob'
  ): void {
    const existing = this.#channelKinds.get(channelId)
    if (existing !== undefined && existing !== kind) {
      throw new Error(
        `Channel kind cannot change from ${existing} to ${kind}`
      )
    }
    if (existing === undefined) {
      this.#channelKinds.set(channelId, kind)
    }
  }
}

function protocolFailureCategory(
  stage: string,
  error: unknown
): AgentProtocolFailureCategory {
  const code = typedErrorCode(error)
  return agentProtocolFailureCategorySchema.parse(
    code === undefined ? stage : `${stage}/${code}`
  )
}

function typedErrorCode(error: unknown): string | undefined {
  if (
    error === null ||
    typeof error !== 'object' ||
    !('code' in error) ||
    typeof error.code !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/u.test(error.code)
  ) {
    return undefined
  }
  return error.code
}

function parseJsonRpc(
  frame: AgentFrame
): JsonRpcRequest | JsonRpcNotification {
  const value: unknown = JSON.parse(Buffer.from(frame.payload).toString('utf8'))
  const request = jsonRpcRequestSchema.safeParse(value)
  if (request.success) {
    return request.data
  }
  return jsonRpcNotificationSchema.parse(value)
}

function objectParams(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Method params must be an object')
  }
  return value as Record<string, unknown>
}

function emptyParams(value: unknown): void {
  const params = objectParams(value)
  if (Object.keys(params).length !== 0) {
    throw new Error('Method params must be an empty object')
  }
}

function channelCloseParams(value: unknown): {
  channelId: string
  channelEpoch: string
} {
  return channelCloseRequestSchema.parse(value)
}

function incomingQueueLimits(
  input: Partial<IncomingQueueLimits> | undefined
): IncomingQueueLimits {
  const limits = {
    ...DEFAULT_INCOMING_QUEUE_LIMITS,
    ...input
  }
  for (const [name, value] of Object.entries(limits)) {
    const maximum =
      name === 'maximumItems'
        ? DEFAULT_INCOMING_QUEUE_LIMITS.maximumItems
        : name === 'maximumBytes'
          ? DEFAULT_INCOMING_QUEUE_LIMITS.maximumBytes
          : DEFAULT_INCOMING_QUEUE_LIMITS.maximumBufferedBytes
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new RangeError(`Invalid incoming queue ${name}`)
    }
  }
  return limits
}
