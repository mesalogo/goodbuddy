import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { AGENT_PROTOCOL_LIMITS } from '../../shared/agent-protocol'
import {
  REMOTE_MODEL_GATEWAY_LIMITS
} from '../../shared/remote-model-gateway-contracts'
import {
  createModelBridgeRequestMessage,
  decodeModelBridgeMessage,
  encodeModelBridgeMessage,
  modelBridgeDeliveryAckMessageSchema,
  type ModelBridgeIdentity,
  type ModelBridgePolicy
} from '../../shared/model-bridge-contracts'
import type { RuntimeProtocolBinaryFrame } from './protocol-remote-runtime-channel'
import {
  MainModelBridgeDispatchError
} from './main-model-bridge-dispatcher'
import {
  MainModelBridgeSession
} from './main-model-bridge-session'

const profileDigest = `sha256:${'a'.repeat(64)}`
const policy: ModelBridgePolicy = {
  protocol: 'openai-responses',
  model: 'gpt-test',
  modelProfileDigest: profileDigest,
  supportsImageInput: false
}

class FakeBlobChannel {
  readonly channelId = `model-${randomUUID()}`
  readonly channelEpoch = '19'
  readonly sent: Uint8Array[] = []
  consumed = 0
  closed = false
  closeNotifications = 0
  #frames: RuntimeProtocolBinaryFrame[] = []
  #waiters: Array<{
    resolve: (frame: RuntimeProtocolBinaryFrame) => void
    reject: (error: unknown) => void
    signal?: AbortSignal
    abort?: () => void
  }> = []
  #listeners = new Set<() => void>()

  send(payload: Uint8Array, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    this.sent.push(new Uint8Array(payload))
    return Promise.resolve()
  }

  receive(signal?: AbortSignal): Promise<RuntimeProtocolBinaryFrame> {
    signal?.throwIfAborted()
    const frame = this.#frames.shift()
    if (frame !== undefined) {
      return Promise.resolve(frame)
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal }
      if (signal !== undefined) {
        const abort = (): void => {
          const index = this.#waiters.indexOf(waiter)
          if (index >= 0) {
            this.#waiters.splice(index, 1)
          }
          reject(signal.reason)
        }
        Object.assign(waiter, { abort })
        signal.addEventListener('abort', abort, { once: true })
      }
      this.#waiters.push(waiter)
    })
  }

  push(payload: Uint8Array): void {
    let consumed = false
    const frame: RuntimeProtocolBinaryFrame = {
      payload: new Uint8Array(payload),
      sequence: String(this.consumed + this.#frames.length + 1),
      consume: async () => {
        if (!consumed) {
          consumed = true
          this.consumed += 1
        }
      }
    }
    const waiter = this.#waiters.shift()
    if (waiter === undefined) {
      this.#frames.push(frame)
      return
    }
    if (waiter.abort !== undefined) {
      waiter.signal?.removeEventListener('abort', waiter.abort)
    }
    waiter.resolve(frame)
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(new Error('transport closed'))
    }
    for (const listener of this.#listeners) {
      listener()
    }
  }

  async closeWithNotification(): Promise<void> {
    this.closeNotifications += 1
    this.close()
  }

  onClose(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
}

function identity(roundIndex: number): ModelBridgeIdentity {
  return {
    bindingId: 'binding-1',
    promptOperationId: 'prompt-1',
    requestId: `request-${roundIndex}`,
    roundIndex,
    modelProfileDigest: profileDigest,
    messageId: `message-${roundIndex}`
  }
}

function request(bodyBytes = 1) {
  return {
    method: 'POST' as const,
    path: '/v1/responses' as const,
    headers: { 'content-type': 'application/json' },
    bodyBase64: Buffer.alloc(bodyBytes, 7).toString('base64')
  }
}

const response = {
  status: 200,
  headers: { 'content-type': 'application/json' },
  bodyBase64: Buffer.from('{"ok":true}').toString('base64')
}

async function pushRequest(
  channel: FakeBlobChannel,
  roundIndex: number,
  options: {
    bodyBytes?: number
    requestPolicy?: ModelBridgePolicy
  } = {}
) {
  const message = await createModelBridgeRequestMessage({
    identity: {
      ...identity(roundIndex),
      modelProfileDigest:
        options.requestPolicy?.modelProfileDigest ?? profileDigest
    },
    policy: options.requestPolicy ?? policy,
    request: request(options.bodyBytes)
  })
  const payload = await encodeModelBridgeMessage(message)
  channel.push(payload)
  return { message, payload }
}

async function sentMessage(
  channel: FakeBlobChannel,
  offset = 0
) {
  await vi.waitFor(() =>
    expect(channel.sent.length).toBeGreaterThan(offset)
  )
  return {
    message: await decodeModelBridgeMessage(channel.sent[offset]!),
    nextOffset: offset + 1
  }
}

async function acknowledge(
  channel: FakeBlobChannel,
  requestIdentity: ModelBridgeIdentity,
  requestDigest: string
): Promise<void> {
  const acknowledgment = modelBridgeDeliveryAckMessageSchema.parse({
    protocol: 'goodbuddy-model-bridge-v1',
    kind: 'response-delivered',
    identity: requestIdentity,
    requestDigest
  })
  channel.push(await encodeModelBridgeMessage(acknowledgment))
}

function fixture(
  overrides: Partial<
    ConstructorParameters<typeof MainModelBridgeSession>[0]
  > & { channel?: FakeBlobChannel } = {}
) {
  const channel = overrides.channel ?? new FakeBlobChannel()
  const dispatch = vi.fn(async () => response)
  const onDelivered = vi.fn(async () => undefined)
  const finalizePrompt = vi.fn(async () => undefined)
  const poison = vi.fn(async () => undefined)
  const session = new MainModelBridgeSession({
    identity: {
      bindingId: 'binding-1',
      promptOperationId: 'prompt-1'
    },
    policy,
    channel,
    isCurrentGeneration: () => true,
    dispatch,
    onDelivered,
    finalizePrompt,
    poison,
    requestTimeoutMs: 1_000,
    closeTimeoutMs: 100,
    ...overrides
  })
  return {
    channel,
    dispatch,
    onDelivered,
    finalizePrompt,
    poison,
    session
  }
}

describe('MainModelBridgeSession', () => {
  it('reports provider uncertainty only after a model request begins', async () => {
    const dispatch = vi.fn(
      () => new Promise<typeof response>(() => undefined)
    )
    const bridge = fixture({ dispatch })
    expect(
      bridge.session.providerDeliveryMayBeUncertain
    ).toBe(false)

    await pushRequest(bridge.channel, 0)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    expect(
      bridge.session.providerDeliveryMayBeUncertain
    ).toBe(true)

    await bridge.session.close('prompt-cancelled')
  })

  it('accepts one bounded request message and records delivery', async () => {
    const bridge = fixture()
    const sent = await pushRequest(bridge.channel, 0, {
      bodyBytes: 600 * 1024
    })
    expect(sent.payload.byteLength).toBeGreaterThan(600 * 1024)
    expect(sent.payload.byteLength).toBeLessThanOrEqual(
      AGENT_PROTOCOL_LIMITS.maximumBlobFrameBytes
    )
    const outgoing = await sentMessage(bridge.channel)
    expect(outgoing.message).toMatchObject({
      kind: 'response',
      identity: sent.message.identity,
      requestDigest: sent.message.requestDigest,
      response
    })
    expect(bridge.channel.consumed).toBe(1)

    await acknowledge(
      bridge.channel,
      sent.message.identity,
      sent.message.requestDigest
    )
    await vi.waitFor(() =>
      expect(bridge.onDelivered).toHaveBeenCalledOnce()
    )
    await expect(bridge.session.close()).resolves.toEqual({
      clean: true,
      poisoned: false
    })
    expect(bridge.finalizePrompt).toHaveBeenCalledOnce()
    expect(bridge.poison).not.toHaveBeenCalled()
    expect(bridge.channel.closeNotifications).toBe(1)
  })

  it('sends one bounded response message and records its delivery ACK', async () => {
    const largeResponse = {
      ...response,
      bodyBase64: Buffer.alloc(600 * 1024, 3).toString('base64')
    }
    const bridge = fixture({
      dispatch: vi.fn(async () => largeResponse)
    })
    const sent = await pushRequest(bridge.channel, 0)
    const outgoing = await sentMessage(bridge.channel)
    expect(outgoing.nextOffset).toBe(1)
    expect(outgoing.message).toMatchObject({
      kind: 'response',
      response: largeResponse
    })

    await acknowledge(
      bridge.channel,
      sent.message.identity,
      sent.message.requestDigest
    )
    await vi.waitFor(() =>
      expect(bridge.onDelivered).toHaveBeenCalledOnce()
    )
    await expect(bridge.session.close()).resolves.toEqual({
      clean: true,
      poisoned: false
    })
  })

  it('delivers a maximum-sized response in one bounded message', async () => {
    const channel = new FakeBlobChannel()
    const largeResponse = {
      ...response,
      bodyBase64: Buffer.alloc(
        REMOTE_MODEL_GATEWAY_LIMITS.maximumResponseBodyBytes,
        3
      ).toString('base64')
    }
    const bridge = fixture({
      channel,
      dispatch: vi.fn(async () => largeResponse),
      requestTimeoutMs: 10_000
    })
    const requestMessage = await pushRequest(channel, 0)
    const outgoing = await sentMessage(channel)
    expect(outgoing.nextOffset).toBe(1)
    expect(channel.sent).toHaveLength(1)
    expect(channel.sent[0]!.byteLength).toBeLessThanOrEqual(
      AGENT_PROTOCOL_LIMITS.maximumBlobFrameBytes
    )
    expect(outgoing.message).toMatchObject({
      kind: 'response',
      response: largeResponse
    })
    await acknowledge(
      channel,
      requestMessage.message.identity,
      requestMessage.message.requestDigest
    )
    await vi.waitFor(() =>
      expect(bridge.onDelivered).toHaveBeenCalledOnce()
    )
    expect(bridge.poison).not.toHaveBeenCalled()
    await expect(bridge.session.close()).resolves.toEqual({
      clean: true,
      poisoned: false
    })
  })

  it('reports prompt authority finalization failure as poisoned', async () => {
    const bridge = fixture({
      finalizePrompt: async () => {
        throw new Error('SQLite unavailable')
      }
    })

    await expect(bridge.session.close()).resolves.toEqual({
      clean: false,
      poisoned: true
    })
    expect(bridge.poison).toHaveBeenCalledWith(
      'binding-1',
      'prompt-1',
      'model-prompt-finalization-failed'
    )
  })

  it('reports prompt authority finalization timeout as poisoned', async () => {
    const bridge = fixture({
      finalizePrompt: async () => await new Promise(() => undefined),
      closeTimeoutMs: 10
    })

    await expect(bridge.session.close()).resolves.toEqual({
      clean: false,
      poisoned: true
    })
    expect(bridge.poison).toHaveBeenCalledWith(
      'binding-1',
      'prompt-1',
      'model-prompt-finalization-failed'
    )
  })

  it('enforces exact policy before dispatch with a definitive error', async () => {
    const bridge = fixture()
    const mismatched = {
      ...policy,
      model: 'another-model',
      modelProfileDigest: `sha256:${'b'.repeat(64)}`
    }
    await pushRequest(bridge.channel, 0, {
      requestPolicy: mismatched
    })
    const outgoing = await sentMessage(bridge.channel)
    expect(outgoing.message).toMatchObject({
      kind: 'error',
      error: {
        poisoned: false,
        outcomeUnknown: false,
        retryable: false
      }
    })
    expect(bridge.dispatch).not.toHaveBeenCalled()
    expect(bridge.poison).not.toHaveBeenCalled()
    await bridge.session.close()
  })

  it('rejects an exact binding or prompt identity mismatch before dispatch', async () => {
    const bridge = fixture()
    const message = await createModelBridgeRequestMessage({
      identity: {
        ...identity(0),
        bindingId: 'different-binding'
      },
      policy,
      request: request()
    })
    bridge.channel.push(await encodeModelBridgeMessage(message))
    const outgoing = await sentMessage(bridge.channel)
    expect(outgoing.message).toMatchObject({
      kind: 'error',
      error: {
        code: 'request-identity-mismatch',
        poisoned: false
      }
    })
    expect(bridge.dispatch).not.toHaveBeenCalled()
    expect(bridge.poison).not.toHaveBeenCalled()
    await bridge.session.close()
  })

  it('supports sequential rounds only after each delivery ACK', async () => {
    const bridge = fixture()
    let offset = 0
    for (let round = 0; round < 2; round += 1) {
      const sent = await pushRequest(bridge.channel, round)
      const outgoing = await sentMessage(bridge.channel, offset)
      offset = outgoing.nextOffset
      await acknowledge(
        bridge.channel,
        sent.message.identity,
        sent.message.requestDigest
      )
    }
    await vi.waitFor(() =>
      expect(bridge.onDelivered).toHaveBeenCalledTimes(2)
    )
    expect(bridge.dispatch).toHaveBeenCalledTimes(2)
    await bridge.session.close()
  })

  it('poisons once when another request arrives before delivery ACK', async () => {
    const bridge = fixture()
    await pushRequest(bridge.channel, 0)
    await sentMessage(bridge.channel)
    await pushRequest(bridge.channel, 1)
    await expect(bridge.session.closed).resolves.toEqual({
      clean: false,
      poisoned: true
    })
    expect(bridge.dispatch).toHaveBeenCalledOnce()
    expect(bridge.poison).toHaveBeenCalledOnce()
  })

  it('poisons once when transport closes after response and before ACK', async () => {
    const bridge = fixture()
    await pushRequest(bridge.channel, 0)
    await sentMessage(bridge.channel)
    bridge.channel.close()
    await expect(bridge.session.closed).resolves.toEqual({
      clean: false,
      poisoned: true
    })
    expect(bridge.poison).toHaveBeenCalledOnce()
  })

  it('allows an in-flight delivery ACK to finish during clean prompt close', async () => {
    const bridge = fixture()
    const sent = await pushRequest(bridge.channel, 0)
    await sentMessage(bridge.channel)
    const closing = bridge.session.close('prompt-completed')
    await acknowledge(
      bridge.channel,
      sent.message.identity,
      sent.message.requestDigest
    )
    await expect(closing).resolves.toEqual({
      clean: true,
      poisoned: false
    })
    expect(bridge.onDelivered).toHaveBeenCalledOnce()
    expect(bridge.poison).not.toHaveBeenCalled()
  })

  it('keeps an explicitly pre-dispatch failure definitive without consuming the round', async () => {
    const definitive = new MainModelBridgeDispatchError(
      'policy-rejected',
      { outcomeUnknown: false, postDispatch: false }
    )
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(definitive)
      .mockResolvedValueOnce(response)
    const bridge = fixture({ dispatch })
    await pushRequest(bridge.channel, 0)
    const first = await sentMessage(bridge.channel)
    expect(first.message).toMatchObject({
      kind: 'error',
      error: { poisoned: false, outcomeUnknown: false }
    })
    const secondRequest = await pushRequest(bridge.channel, 0)
    const second = await sentMessage(
      bridge.channel,
      first.nextOffset
    )
    expect(second.message.kind).toBe('response')
    await acknowledge(
      bridge.channel,
      secondRequest.message.identity,
      secondRequest.message.requestDigest
    )
    await vi.waitFor(() =>
      expect(bridge.onDelivered).toHaveBeenCalledOnce()
    )
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(bridge.poison).not.toHaveBeenCalled()
    await bridge.session.close()
  })

  it('times out an uncooperative dispatch, poisons, and never retries', async () => {
    const dispatch = vi.fn(
      () => new Promise<typeof response>(() => undefined)
    )
    const bridge = fixture({
      dispatch,
      requestTimeoutMs: 10
    })
    await pushRequest(bridge.channel, 0)
    await expect(bridge.session.closed).resolves.toEqual({
      clean: false,
      poisoned: true
    })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(bridge.poison).toHaveBeenCalledOnce()
  })

  it('cancels an active dispatch by poisoning once without retry', async () => {
    const dispatch = vi.fn(
      () => new Promise<typeof response>(() => undefined)
    )
    const bridge = fixture({ dispatch })
    await pushRequest(bridge.channel, 0)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    await expect(
      bridge.session.close('prompt-cancelled')
    ).resolves.toEqual({
      clean: false,
      poisoned: true
    })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(bridge.poison).toHaveBeenCalledOnce()
  })
})
