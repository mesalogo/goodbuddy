import { randomUUID } from 'node:crypto'
import {
  AGENT_PROTOCOL_VERSION,
  agentIdentifierSchema,
  type AgentFrame
} from '../shared/agent-protocol'
import {
  createModelBridgeRequestMessage,
  decodeModelBridgeMessage,
  encodeModelBridgeMessage,
  modelBridgeDeliveryAckMessageSchema,
  type ModelBridgeError,
  type ModelBridgeIdentity,
  type ModelBridgePolicy,
  type ModelBridgeResponseMessage
} from '../shared/model-bridge-contracts'
import type {
  RemoteModelGatewayRequest,
  RemoteModelGatewayResponse
} from '../shared/remote-model-gateway-contracts'

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

export type ModelBridgeClientBinding = {
  bindingId: string
  promptOperationId: string
  controllerId: string
  controllerGeneration: number
  connectionId: string
  acpChannelEpoch: string
  channelId: string
  channelEpoch: string
  runtimeId: string
  workspaceIdentity: string
  policy: ModelBridgePolicy
  deadlineAt: string
}

export type ModelBridgeClientExchange = {
  response: RemoteModelGatewayResponse
  acknowledgeDelivery(): Promise<void>
  failDelivery(reason?: unknown): Promise<void>
}

export class ModelBridgeClientError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'cancelled'
      | 'capacity'
      | 'identity'
      | 'poisoned'
      | 'remote'
      | 'timeout'
      | 'transport',
    readonly poisoned = false,
    readonly outcomeUnknown = false
  ) {
    super(message)
    this.name = 'ModelBridgeClientError'
  }
}

type ActiveRequest = {
  identity: ModelBridgeIdentity
  requestDigest: string
  resolve: (message: ModelBridgeResponseMessage) => void
  reject: (error: unknown) => void
  timeout: NodeJS.Timeout
  responseReceived: boolean
  providerDispatchPossible: boolean
  settled: boolean
}

export class ModelBridgeBlobClient {
  readonly binding: ModelBridgeClientBinding
  readonly #sendBlobFrame: (frame: AgentFrame) => Promise<void>
  readonly #onPoison: (error: ModelBridgeClientError) => void | Promise<void>
  readonly #now: () => number
  readonly #requestTimeoutMs: number
  readonly #randomMessageId: () => string
  #nextRoundIndex = 0
  #nextOutboundSequence = 1n
  #active?: ActiveRequest
  #closed = false
  #poisoned = false

  constructor(options: {
    binding: ModelBridgeClientBinding
    sendBlobFrame: (frame: AgentFrame) => Promise<void>
    onPoison: (error: ModelBridgeClientError) => void | Promise<void>
    now?: () => number
    requestTimeoutMs?: number
    randomMessageId?: () => string
  }) {
    this.binding = options.binding
    this.#sendBlobFrame = options.sendBlobFrame
    this.#onPoison = options.onPoison
    this.#now = options.now ?? Date.now
    this.#requestTimeoutMs = boundedTimeout(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    )
    this.#randomMessageId =
      options.randomMessageId ??
      (() => `bridge-${randomUUID()}`)
  }

  get poisoned(): boolean {
    return this.#poisoned
  }

  get active(): boolean {
    return this.#active !== undefined
  }

  async exchange(
    request: RemoteModelGatewayRequest,
    context: { requestId: string; signal: AbortSignal }
  ): Promise<ModelBridgeClientExchange> {
    this.#assertAvailable()
    if (this.#active !== undefined) {
      throw new ModelBridgeClientError(
        'Only one model request may be active',
        'capacity'
      )
    }
    context.signal.throwIfAborted()
    this.#assertRequest(request)
    const roundIndex = this.#nextRoundIndex
    const messageId = agentIdentifierSchema.parse(
      this.#randomMessageId()
    )
    const identity: ModelBridgeIdentity = {
      bindingId: this.binding.bindingId,
      promptOperationId: this.binding.promptOperationId,
      requestId: agentIdentifierSchema.parse(context.requestId),
      roundIndex,
      modelProfileDigest:
        this.binding.policy.modelProfileDigest,
      messageId
    }
    const message = await createModelBridgeRequestMessage({
      identity,
      policy: this.binding.policy,
      request
    })
    context.signal.throwIfAborted()
    const payload = await encodeModelBridgeMessage(message)
    context.signal.throwIfAborted()
    this.#assertAvailable()

    const response = new Promise<ModelBridgeResponseMessage>(
      (resolve, reject) => {
        const remaining = Math.max(
          1,
          Date.parse(this.binding.deadlineAt) - this.#now()
        )
        const timeout = setTimeout(() => {
          const active = this.#active
          if (active?.identity.messageId !== messageId) {
            return
          }
          const error = new ModelBridgeClientError(
            'Model bridge response timed out',
            'timeout',
            true,
            true
          )
          active.settled = true
          active.reject(error)
          void this.#poison(error)
        }, Math.min(this.#requestTimeoutMs, remaining))
        timeout.unref?.()
        this.#active = {
          identity,
          requestDigest: message.requestDigest,
          resolve,
          reject,
          timeout,
          responseReceived: false,
          providerDispatchPossible: false,
          settled: false
        }
      }
    )
    // Cancellation can end the send loop before it reaches `await response`.
    // Keep the original rejection for that await while preventing an orphaned
    // internal promise from becoming an unhandled rejection.
    void response.catch(() => undefined)
    const onAbort = (): void => {
      const active = this.#active
      if (active?.identity.messageId !== messageId) {
        return
      }
      const error = new ModelBridgeClientError(
        'Model bridge request was cancelled',
        'cancelled',
        active.responseReceived || active.providerDispatchPossible,
        active.responseReceived || active.providerDispatchPossible
      )
      active.settled = true
      active.reject(error)
      if (active.responseReceived || active.providerDispatchPossible) {
        void this.#poison(error)
      } else {
        this.#clearActive(active)
      }
    }
    context.signal.addEventListener('abort', onAbort, { once: true })
    if (context.signal.aborted) {
      onAbort()
    }
    try {
      context.signal.throwIfAborted()
      const dispatchActive = this.#currentActive()
      if (
        dispatchActive === undefined ||
        dispatchActive.identity.messageId !== messageId
      ) {
        throw new ModelBridgeClientError(
          'Model request lost its active identity before dispatch',
          'cancelled'
        )
      }
      dispatchActive.providerDispatchPossible = true
      try {
        await this.#send(payload)
      } catch {
        const error = new ModelBridgeClientError(
          'Model request transmission was uncertain',
          'transport',
          true,
          true
        )
        await this.#poison(error)
        throw error
      }
      const deliveredResponse = await response
      const active = this.#currentActive()
      if (
        active === undefined ||
        active.identity.messageId !== messageId
      ) {
        throw new ModelBridgeClientError(
          'Model bridge response lost its active identity',
          'identity',
          true,
          true
        )
      }
      active.responseReceived = true
      let deliveryFinished = false
      return {
        response: deliveredResponse.response,
        acknowledgeDelivery: async () => {
          if (deliveryFinished) {
            throw new ModelBridgeClientError(
              'Model bridge delivery was already finalized',
              'identity',
              true,
              true
            )
          }
          deliveryFinished = true
          try {
            const acknowledgment =
              modelBridgeDeliveryAckMessageSchema.parse({
                protocol: 'goodbuddy-model-bridge-v1',
                kind: 'response-delivered',
                identity,
                requestDigest: active.requestDigest
              })
            await this.#send(
              await encodeModelBridgeMessage(acknowledgment)
            )
            this.#nextRoundIndex += 1
            this.#clearActive(active)
          } catch {
            const error = new ModelBridgeClientError(
              'Model bridge delivery acknowledgment failed',
              'transport',
              true,
              true
            )
            await this.#poison(error)
            throw error
          }
        },
        failDelivery: async () => {
          if (deliveryFinished) {
            return
          }
          deliveryFinished = true
          const error = new ModelBridgeClientError(
            'Provider response delivery was not acknowledged',
            'poisoned',
            true,
            true
          )
          await this.#poison(error)
        }
      }
    } catch (error) {
      const active = this.#currentActive()
      if (
        active !== undefined &&
        active.identity.messageId === messageId &&
        !active.responseReceived
      ) {
        this.#clearActive(active)
      }
      throw error
    } finally {
      context.signal.removeEventListener('abort', onAbort)
    }
  }

  async onBlobFrame(frame: AgentFrame): Promise<void> {
    if (
      this.#closed ||
      frame.header.kind !== 'blob' ||
      frame.header.direction !== 'main-to-agent' ||
      frame.header.connectionId !== this.binding.connectionId ||
      frame.header.generation !==
        this.binding.controllerGeneration ||
      frame.header.channelId !== this.binding.channelId ||
      frame.header.channelEpoch !== this.binding.channelEpoch
    ) {
      throw new ModelBridgeClientError(
        'Blob frame does not match the active model bridge',
        'identity'
      )
    }
    const active = this.#active
    if (active === undefined) {
      throw new ModelBridgeClientError(
        'No model request is awaiting blob data',
        'identity'
      )
    }
    try {
      const message = await decodeModelBridgeMessage(frame.payload, {
        expectedIdentity: active.identity,
        expectedRequestDigest: active.requestDigest
      })
      if (message.kind === 'response') {
        active.responseReceived = true
        active.settled = true
        clearTimeout(active.timeout)
        active.resolve(message)
        return
      }
      if (message.kind === 'error') {
        const error = remoteError(message.error)
        active.settled = true
        clearTimeout(active.timeout)
        active.reject(error)
        if (message.error.poisoned || message.error.outcomeUnknown) {
          await this.#poison(error)
        } else {
          this.#clearActive(active)
        }
        return
      }
      throw new ModelBridgeClientError(
        'Main sent an invalid model bridge message kind',
        'identity',
        true,
        true
      )
    } catch (error) {
      if (!active.settled) {
        active.settled = true
        active.reject(error)
      }
      const poisoned =
        error instanceof ModelBridgeClientError
          ? error
          : new ModelBridgeClientError(
              'Model bridge response framing failed',
              'identity',
              true,
              true
            )
      await this.#poison(poisoned)
      throw error
    }
  }

  async close(options: { poisonIfActive: boolean }): Promise<void> {
    if (this.#closed) {
      return
    }
    this.#closed = true
    const active = this.#active
    if (active !== undefined) {
      const error = new ModelBridgeClientError(
        'Model bridge closed with an active request',
        options.poisonIfActive ? 'poisoned' : 'cancelled',
        options.poisonIfActive,
        options.poisonIfActive
      )
      active.reject(error)
      if (options.poisonIfActive) {
        await this.#poison(error)
      } else {
        this.#clearActive(active)
      }
    }
  }

  #assertRequest(request: RemoteModelGatewayRequest): void {
    const policy = this.binding.policy
    const body = parseJsonBody(request.bodyBase64)
    if (typeof body?.model === 'string' && body.model !== policy.model) {
      throw new ModelBridgeClientError(
        'Model request does not match the prepared profile',
        'identity'
      )
    }
  }

  #assertAvailable(): void {
    if (this.#poisoned) {
      throw new ModelBridgeClientError(
        'Model bridge is permanently poisoned',
        'poisoned',
        true,
        true
      )
    }
    if (this.#closed) {
      throw new ModelBridgeClientError(
        'Model bridge is closed',
        'cancelled'
      )
    }
  }

  async #send(payload: Uint8Array): Promise<void> {
    const sequence = this.#nextOutboundSequence.toString()
    await this.#sendBlobFrame({
      header: {
        protocolMajor: AGENT_PROTOCOL_VERSION.major,
        protocolMinor: AGENT_PROTOCOL_VERSION.minor,
        connectionId: this.binding.connectionId,
        generation: this.binding.controllerGeneration,
        channelId: this.binding.channelId,
        channelEpoch: this.binding.channelEpoch,
        direction: 'agent-to-main',
        sequence,
        kind: 'blob',
        payloadLength: payload.byteLength
      },
      payload
    })
    this.#nextOutboundSequence += 1n
  }

  #clearActive(active: ActiveRequest): void {
    clearTimeout(active.timeout)
    if (this.#active === active) {
      this.#active = undefined
    }
  }

  #currentActive(): ActiveRequest | undefined {
    return this.#active
  }

  async #poison(error: ModelBridgeClientError): Promise<void> {
    if (this.#poisoned) {
      return
    }
    this.#poisoned = true
    const active = this.#active
    if (active !== undefined) {
      this.#clearActive(active)
    }
    await this.#onPoison(error)
  }
}

function remoteError(error: ModelBridgeError): ModelBridgeClientError {
  return new ModelBridgeClientError(
    error.message,
    error.poisoned || error.outcomeUnknown ? 'poisoned' : 'remote',
    error.poisoned,
    error.outcomeUnknown
  )
}

function parseJsonBody(
  bodyBase64: string
): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(bodyBase64, 'base64').toString('utf8')
    )
    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function boundedTimeout(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 300_000
  ) {
    throw new RangeError('Invalid model bridge timeout')
  }
  return value
}
