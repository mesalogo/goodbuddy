import { isDeepStrictEqual } from 'node:util'
import {
  MODEL_BRIDGE_LIMITS,
  MODEL_BRIDGE_PROTOCOL,
  decodeModelBridgeMessage,
  encodeModelBridgeMessage,
  modelBridgeErrorMessageSchema,
  modelBridgePolicySchema,
  modelBridgeResponseMessageSchema,
  type ModelBridgeIdentity,
  type ModelBridgePolicy,
  type ModelBridgeRequestMessage
} from '../../shared/model-bridge-contracts'
import type { RuntimeProtocolBinaryChannel } from './protocol-remote-runtime-channel'
import {
  dispatchFailureCode,
  dispatchFailureIsUncertain,
  validateMainModelBridgeDispatchResponse,
  type MainModelBridgeDelivered,
  type MainModelBridgeDispatch,
  type MainModelBridgeFinalizePrompt,
  type MainModelBridgePoison
} from './main-model-bridge-dispatcher'

const DEFAULT_REQUEST_TIMEOUT_MS = 180_000
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000

export type MainModelBridgeSessionIdentity = {
  bindingId: string
  promptOperationId: string
}

export type MainModelBridgeSessionOptions = {
  identity: MainModelBridgeSessionIdentity
  policy: ModelBridgePolicy
  channel: RuntimeProtocolBinaryChannel
  isCurrentGeneration(): boolean
  dispatch: MainModelBridgeDispatch
  onDelivered: MainModelBridgeDelivered
  finalizePrompt: MainModelBridgeFinalizePrompt
  poison: MainModelBridgePoison
  requestTimeoutMs?: number
  closeTimeoutMs?: number
}

export type MainModelBridgeSessionCloseResult = {
  clean: boolean
  poisoned: boolean
}

type RequestPhase =
  | 'receiving'
  | 'dispatching'
  | 'sending-response'
  | 'awaiting-delivery'

type ActiveExchange = {
  request: ModelBridgeRequestMessage
  phase: RequestPhase
}

export class MainModelBridgeSession {
  readonly version = MODEL_BRIDGE_PROTOCOL
  readonly channelId: string
  readonly channelEpoch: string
  readonly policy: ModelBridgePolicy
  readonly closed: Promise<MainModelBridgeSessionCloseResult>

  readonly #identity: MainModelBridgeSessionIdentity
  readonly #channel: RuntimeProtocolBinaryChannel
  readonly #isCurrentGeneration: () => boolean
  readonly #dispatch: MainModelBridgeDispatch
  readonly #onDelivered: MainModelBridgeDelivered
  readonly #finalizePrompt: MainModelBridgeFinalizePrompt
  readonly #poisonCallback: MainModelBridgePoison
  readonly #requestTimeoutMs: number
  readonly #closeTimeoutMs: number
  readonly #lifetime = new AbortController()
  readonly #closedResolve: (
    result: MainModelBridgeSessionCloseResult
  ) => void
  #nextRoundIndex = 0
  #active?: ActiveExchange
  #receivingRequest = false
  #poisoned = false
  #closing = false
  #closePromise?: Promise<MainModelBridgeSessionCloseResult>
  #poisonPromise?: Promise<void>
  #idleWaiters = new Set<() => void>()
  #unsubscribeClose: () => void = () => undefined

  constructor(options: MainModelBridgeSessionOptions) {
    this.#identity = options.identity
    this.policy = modelBridgePolicySchema.parse(options.policy)
    this.#channel = options.channel
    this.channelId = options.channel.channelId
    this.channelEpoch = options.channel.channelEpoch
    this.#isCurrentGeneration = options.isCurrentGeneration
    this.#dispatch = options.dispatch
    this.#onDelivered = options.onDelivered
    this.#finalizePrompt = options.finalizePrompt
    this.#poisonCallback = options.poison
    this.#requestTimeoutMs = boundedTimeout(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS
    )
    this.#closeTimeoutMs = boundedTimeout(
      options.closeTimeoutMs,
      DEFAULT_CLOSE_TIMEOUT_MS
    )
    let resolveClosed: (
      result: MainModelBridgeSessionCloseResult
    ) => void = () => undefined
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve
    })
    this.#closedResolve = resolveClosed
    this.#unsubscribeClose = this.#channel.onClose(() => {
      void this.#closeFromTransport()
    })
    void this.#run()
  }

  get preparation(): {
    version: typeof MODEL_BRIDGE_PROTOCOL
    channelId: string
    channelEpoch: string
    policy: ModelBridgePolicy
  } {
    return {
      version: this.version,
      channelId: this.channelId,
      channelEpoch: this.channelEpoch,
      policy: this.policy
    }
  }

  get providerDeliveryMayBeUncertain(): boolean {
    return this.#active !== undefined || this.#receivingRequest
  }

  async close(reason = 'prompt-completed'): Promise<MainModelBridgeSessionCloseResult> {
    if (
      reason === 'prompt-completed' &&
      this.#active?.phase === 'awaiting-delivery'
    ) {
      await this.#waitForIdle()
    }
    return await this.#beginClose(true, reason)
  }

  async #run(): Promise<void> {
    try {
      while (!this.#closing) {
        this.#assertCurrent()
        const message = await this.#receiveMessage()
        if (message.kind !== 'request') {
          throw new Error(
            'Model bridge received a message without an active request'
          )
        }
        const request = message
        const preDispatchError = this.#validateRequest(request)
        if (preDispatchError !== undefined) {
          await this.#sendError(
            request.identity,
            request.requestDigest,
            preDispatchError,
            false
          )
          continue
        }

        this.#active = { request, phase: 'dispatching' }
        const controller = new AbortController()
        const timeout = setTimeout(() => {
          controller.abort(
            new DOMException(
              'Remote model bridge request timed out',
              'TimeoutError'
            )
          )
        }, this.#requestTimeoutMs)
        timeout.unref?.()
        const abort = (): void => controller.abort(this.#lifetime.signal.reason)
        this.#lifetime.signal.addEventListener('abort', abort, {
          once: true
        })
        try {
          let response: unknown
          try {
            response = await raceWithAbort(
              this.#dispatch(
                {
                  identity: request.identity,
                  policy: request.policy,
                  request: request.request,
                  requestDigest: request.requestDigest
                },
                controller.signal
              ),
              controller.signal
            )
          } catch (error) {
            const uncertain =
              controller.signal.aborted ||
              dispatchFailureIsUncertain(error)
            if (uncertain) {
              await this.#poisonAndWait(
                'model-dispatch-outcome-unknown'
              )
            }
            await this.#sendError(
              request.identity,
              request.requestDigest,
              dispatchFailureCode(error),
              uncertain
            )
            this.#clearActive()
            if (uncertain) {
              await this.#beginClose(true, 'model-dispatch-outcome-unknown')
              return
            }
            continue
          }

          let parsedResponse
          try {
            parsedResponse =
              validateMainModelBridgeDispatchResponse(response)
          } catch {
            await this.#poisonAndWait('model-response-invalid')
            await this.#sendError(
              request.identity,
              request.requestDigest,
              'response-invalid',
              true
            )
            await this.#beginClose(true, 'model-response-invalid')
            return
          }
          this.#active.phase = 'sending-response'
          const responseMessage = modelBridgeResponseMessageSchema.parse({
            protocol: MODEL_BRIDGE_PROTOCOL,
            kind: 'response',
            identity: request.identity,
            requestDigest: request.requestDigest,
            response: parsedResponse
          })
          try {
            await this.#sendMessage(responseMessage, controller.signal)
          } catch {
            await this.#poisonAndWait(
              'model-response-send-failed'
            )
            await this.#beginClose(false, 'model-response-send-failed')
            return
          }
          this.#active.phase = 'awaiting-delivery'
          const acknowledgment = await this.#receiveMessage(
            request.identity,
            request.requestDigest
          )
          if (acknowledgment.kind !== 'response-delivered') {
            await this.#poisonAndWait(
              'model-delivery-ack-invalid'
            )
            await this.#beginClose(true, 'model-delivery-ack-invalid')
            return
          }
          await raceWithAbort(
            Promise.resolve(
              this.#onDelivered(
                request.identity,
                request.requestDigest
              )
            ),
            controller.signal
          )
          this.#nextRoundIndex += 1
          this.#clearActive()
        } finally {
          clearTimeout(timeout)
          this.#lifetime.signal.removeEventListener('abort', abort)
        }
      }
    } catch {
      if (!this.#closing) {
        if (this.#active !== undefined) {
          await this.#poisonAndWait(
            this.#active.phase === 'awaiting-delivery'
              ? 'model-delivery-ack-missing'
              : 'model-bridge-transport-lost'
          )
        }
        await this.#beginClose(false, 'model-bridge-transport-lost')
      }
    }
  }

  async #receiveMessage(
    expectedIdentity?: ModelBridgeIdentity,
    expectedRequestDigest?: string
  ) {
    const frame = await this.#channel.receive(this.#lifetime.signal)
    if (expectedIdentity === undefined) {
      this.#receivingRequest = true
    }
    try {
      this.#assertCurrent()
      const message = await decodeModelBridgeMessage(frame.payload, {
        expectedIdentity,
        expectedRequestDigest,
        maximumMessageBytes: MODEL_BRIDGE_LIMITS.maximumMessageBytes
      })
      await frame.consume()
      if (expectedIdentity === undefined) {
        this.#receivingRequest = false
      }
      return message
    } catch (error) {
      await frame.consume().catch(() => undefined)
      throw error
    }
  }

  #validateRequest(request: ModelBridgeRequestMessage): string | undefined {
    if (
      request.identity.bindingId !== this.#identity.bindingId ||
      request.identity.promptOperationId !==
        this.#identity.promptOperationId ||
      request.identity.roundIndex !== this.#nextRoundIndex ||
      request.identity.modelProfileDigest !==
        this.policy.modelProfileDigest ||
      !isDeepStrictEqual(request.policy, this.policy)
    ) {
      return 'request-identity-mismatch'
    }
    return undefined
  }

  async #sendError(
    identity: ModelBridgeIdentity,
    requestDigest: string,
    code: string,
    uncertain: boolean
  ): Promise<void> {
    const message = modelBridgeErrorMessageSchema.parse({
      protocol: MODEL_BRIDGE_PROTOCOL,
      kind: 'error',
      identity,
      requestDigest,
      error: {
        code: safeErrorCode(code),
        message: uncertain
          ? 'Remote model request outcome is unknown'
          : 'Remote model request was rejected',
        retryable: false,
        poisoned: uncertain,
        outcomeUnknown: uncertain
      }
    })
    await this.#sendMessage(message, this.#lifetime.signal)
  }

  async #sendMessage(
    message: unknown,
    signal: AbortSignal
  ): Promise<void> {
    const payload = await encodeModelBridgeMessage(message)
    this.#assertCurrent()
    await this.#channel.send(payload, signal)
  }

  #assertCurrent(): void {
    if (
      this.#closing ||
      this.#lifetime.signal.aborted ||
      !this.#isCurrentGeneration()
    ) {
      throw new Error('Model bridge transport generation is stale')
    }
  }

  #poison(reason: string): Promise<void> {
    if (this.#poisonPromise !== undefined) {
      return this.#poisonPromise
    }
    this.#poisoned = true
    this.#poisonPromise = Promise.resolve()
      .then(() =>
        this.#poisonCallback(
          this.#identity.bindingId,
          this.#identity.promptOperationId,
          reason
        )
      )
      .then(() => undefined)
      .catch(() => undefined)
    return this.#poisonPromise
  }

  async #poisonAndWait(reason: string): Promise<void> {
    await settleWithin(
      this.#poison(reason),
      this.#closeTimeoutMs
    ).catch(() => undefined)
  }

  #closeFromTransport(): Promise<MainModelBridgeSessionCloseResult> {
    return this.#beginClose(false, 'model-bridge-transport-lost')
  }

  #beginClose(
    notifyPeer: boolean,
    reason: string
  ): Promise<MainModelBridgeSessionCloseResult> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise
    }
    this.#closing = true
    if (this.#active !== undefined || this.#receivingRequest) {
      void this.#poison(reason)
    }
    this.#lifetime.abort(
      new DOMException('Model bridge closed', 'AbortError')
    )
    this.#closePromise = Promise.resolve().then(async () => {
      try {
        if (
          !this.#poisoned &&
          this.#active === undefined &&
          !this.#receivingRequest
        ) {
          try {
            await settleWithin(
              Promise.resolve(
                this.#finalizePrompt(this.#identity)
              ),
              this.#closeTimeoutMs
            )
          } catch {
            await this.#poisonAndWait(
              'model-prompt-finalization-failed'
            )
          }
        }
        if (notifyPeer) {
          const closable = this.#channel as RuntimeProtocolBinaryChannel & {
            closeWithNotification?: () => Promise<void>
          }
          if (closable.closeWithNotification !== undefined) {
            await settleWithin(
              closable.closeWithNotification(),
              this.#closeTimeoutMs
            )
          } else {
            this.#channel.close()
          }
        } else {
          this.#channel.close()
        }
      } catch {
        this.#channel.close()
        if (this.#active !== undefined) {
          await this.#poisonAndWait('model-bridge-close-failed')
        }
      }
      if (this.#poisonPromise !== undefined) {
        await settleWithin(
          this.#poisonPromise,
          this.#closeTimeoutMs
        ).catch(() => undefined)
      }
      this.#unsubscribeClose()
      const result = {
        clean: !this.#poisoned,
        poisoned: this.#poisoned
      }
      this.#closedResolve(result)
      return result
    })
    return this.#closePromise
  }

  #clearActive(): void {
    this.#active = undefined
    for (const resolve of this.#idleWaiters) {
      resolve()
    }
    this.#idleWaiters.clear()
  }

  async #waitForIdle(): Promise<void> {
    if (this.#active === undefined) {
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          this.#idleWaiters.add(resolve)
        }),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.#closeTimeoutMs)
          timer.unref?.()
        })
      ])
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      this.#idleWaiters.clear()
    }
  }
}

function safeErrorCode(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
    ? value
    : 'dispatch-failed'
}

function boundedTimeout(
  value: number | undefined,
  fallback: number
): number {
  const timeout = value ?? fallback
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 300_000
  ) {
    throw new RangeError('Model bridge timeout is invalid')
  }
  return timeout
}

async function settleWithin(
  promise: Promise<void>,
  timeoutMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Model bridge close timed out')),
          timeoutMs
        )
        timer.unref?.()
      })
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  signal.throwIfAborted()
  let abort = (): void => undefined
  const aborted = new Promise<never>((_, reject) => {
    abort = (): void => {
      reject(
        signal.reason ??
          new DOMException('Model bridge aborted', 'AbortError')
      )
    }
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
