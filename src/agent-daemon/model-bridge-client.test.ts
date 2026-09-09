import { describe, expect, it, vi } from 'vitest'
import { UNBOUNDED_REMOTE_PROMPT_DEADLINE } from '../shared/remote-agent-contracts'
import {
  decodeModelBridgeMessage,
  encodeModelBridgeMessage,
  type ModelBridgePolicy,
  type ModelBridgeRequestMessage
} from '../shared/model-bridge-contracts'
import {
  AGENT_PROTOCOL_VERSION,
  AGENT_PROTOCOL_LIMITS,
  type AgentFrame
} from '../shared/agent-protocol'
import {
  ModelBridgeBlobClient,
  ModelBridgeClientError
} from './model-bridge-client'

const digest = (character: string): string =>
  `sha256:${character.repeat(64)}`

const policy: ModelBridgePolicy = {
  protocol: 'openai-responses',
  model: 'private-model',
  modelProfileDigest: digest('a'),
  supportsImageInput: false
}

function createHarness(policyOverride: Partial<ModelBridgePolicy> = {}) {
  const sent: AgentFrame[] = []
  const poisoned = vi.fn()
  let nextId = 0
  const client = new ModelBridgeBlobClient({
    binding: {
      bindingId: 'binding-1',
      promptOperationId: 'prompt-1',
      controllerId: 'controller-1',
      controllerGeneration: 2,
      connectionId: 'connection-1',
      acpChannelEpoch: '4',
      channelId: 'model-channel-1',
      channelEpoch: '9',
      runtimeId: 'opencode',
      workspaceIdentity: 'workspace-1',
      policy: { ...policy, ...policyOverride },
      deadlineAt: new Date(Date.now() + 60_000).toISOString()
    },
    sendBlobFrame: async (frame) => {
      sent.push(frame)
    },
    onPoison: poisoned,
    randomMessageId: () => `message-${nextId++}`
  })
  return { client, sent, poisoned }
}

const request = {
  method: 'POST' as const,
  path: '/v1/responses' as const,
  headers: { 'content-type': 'application/json' },
  bodyBase64: Buffer.from(
    JSON.stringify({ model: 'private-model', max_output_tokens: 100 })
  ).toString('base64')
}

async function outboundRequest(
  sent: AgentFrame[],
  index = 0
): Promise<ModelBridgeRequestMessage> {
  await waitFor(() => {
    if (sent.length <= index) return false
    try { JSON.parse(Buffer.concat(sent.slice(index).map(frame => frame.payload)).toString()); return true }
    catch { return false }
  })
  const decoded = await decodeModelBridgeMessage(Buffer.concat(sent.slice(index).map(frame => frame.payload)))
  if (decoded.kind !== 'request') {
    throw new Error('Expected request')
  }
  return decoded
}

async function deliverResponse(
  client: ModelBridgeBlobClient,
  outbound: ModelBridgeRequestMessage,
  bodyBytes = 12
): Promise<void> {
  const payload = await encodeModelBridgeMessage({
        protocol: 'goodbuddy-model-bridge-v1',
        kind: 'response',
        identity: outbound.identity,
        requestDigest: outbound.requestDigest,
        response: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          bodyBase64: Buffer.alloc(bodyBytes, 2).toString('base64')
        }
      })
  for (let offset = 0; offset < payload.length; offset += AGENT_PROTOCOL_LIMITS.maximumBlobFrameBytes) {
    await client.onBlobFrame(incomingFrame(
      payload.subarray(offset, offset + AGENT_PROTOCOL_LIMITS.maximumBlobFrameBytes),
      offset / AGENT_PROTOCOL_LIMITS.maximumBlobFrameBytes + 1
    ))
  }
}

describe('Agent model bridge blob client', () => {
  it.each(['finite', 'unbounded'])('waits for the prompt deadline without a fixed provider timeout: %s', async (kind) => {
    vi.useFakeTimers()
    try {
      const fixture = createHarness()
      fixture.client.binding.deadlineAt = kind === 'finite'
        ? new Date(Date.now() + 60 * 60_000).toISOString()
        : UNBOUNDED_REMOTE_PROMPT_DEADLINE
      const controller = new AbortController()
      const pending = fixture.client.exchange(request, {
        requestId: 'request-long', signal: controller.signal
      })
      const rejected = expect(pending).rejects.toMatchObject({
        code: kind === 'finite' ? 'timeout' : 'cancelled'
      })
      await vi.waitFor(() => expect(fixture.sent).toHaveLength(1))
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(fixture.poisoned).not.toHaveBeenCalled()
      if (kind === 'finite') {
        await vi.advanceTimersByTimeAsync(50 * 60_000)
      } else {
        controller.abort()
      }
      await rejected
      await fixture.client.close({ poisonIfActive: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses exact sequential identities and two-phase delivery', async () => {
    const fixture = createHarness()
    const pending = fixture.client.exchange(request, {
      requestId: 'request-local-1',
      signal: new AbortController().signal
    })
    const outbound = await outboundRequest(fixture.sent)
    expect(outbound).toMatchObject({
      identity: {
        bindingId: 'binding-1',
        promptOperationId: 'prompt-1',
        requestId: 'request-local-1',
        roundIndex: 0,
        modelProfileDigest: digest('a'),
        messageId: 'message-0'
      },
      policy
    })

    await deliverResponse(fixture.client, outbound)
    const exchange = await pending
    expect(exchange.response.status).toBe(200)
    expect(fixture.sent).toHaveLength(1)

    await exchange.acknowledgeDelivery()
    expect(fixture.sent).toHaveLength(2)
    await expect(
      decodeModelBridgeMessage(fixture.sent[1]!.payload)
    ).resolves.toMatchObject({
      kind: 'response-delivered',
      identity: outbound.identity,
      requestDigest: outbound.requestDigest
    })
    expect(fixture.poisoned).not.toHaveBeenCalled()
  })

  it('receives a response across bounded blob frames', async () => {
    const fixture = createHarness()
    const pending = fixture.client.exchange(request, {
      requestId: 'request-large-response',
      signal: new AbortController().signal
    })
    const outbound = await outboundRequest(fixture.sent)
    await deliverResponse(fixture.client, outbound, 2 * 1024 * 1024)

    const exchange = await pending
    expect(
      Buffer.from(exchange.response.bodyBase64, 'base64').byteLength
    ).toBe(2 * 1024 * 1024)
    await exchange.acknowledgeDelivery()
    expect(fixture.sent).toHaveLength(2)
    expect(fixture.poisoned).not.toHaveBeenCalled()
  })

  it('sends a large request across bounded blob frames', async () => {
    const fixture = createHarness()
    const pending = fixture.client.exchange(
      {
        ...request,
        bodyBase64: Buffer.alloc(2 * 1024 * 1024, 1).toString('base64')
      },
      {
        requestId: 'request-large',
        signal: new AbortController().signal
      }
    )
    const outbound = await outboundRequest(fixture.sent)
    expect(fixture.sent.length).toBeGreaterThan(1)
    expect(fixture.sent.every(frame => frame.payload.length <= AGENT_PROTOCOL_LIMITS.maximumBlobFrameBytes)).toBe(true)
    expect(outbound.identity.roundIndex).toBe(0)
    await fixture.client.close({ poisonIfActive: false })
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('does not send after cancellation during request preparation', async () => {
    const fixture = createHarness()
    const controller = new AbortController()
    const pending = fixture.client.exchange(
      {
        ...request,
        bodyBase64: Buffer.alloc(700_000, 1).toString('base64')
      },
      {
        requestId: 'request-cancelled-during-prepare',
        signal: controller.signal
      }
    )
    controller.abort()

    await expect(pending).rejects.toThrow()
    expect(fixture.sent).toHaveLength(0)
    expect(fixture.poisoned).not.toHaveBeenCalled()
  })

  it('does not dispatch when detach closes the bridge during request preparation', async () => {
    const fixture = createHarness()
    const pending = fixture.client.exchange(
      {
        ...request,
        bodyBase64: Buffer.alloc(700_000, 1).toString('base64')
      },
      {
        requestId: 'request-closed-during-prepare',
        signal: new AbortController().signal
      }
    )
    await fixture.client.close({ poisonIfActive: false })

    await expect(pending).rejects.toMatchObject({
      code: 'cancelled',
      poisoned: false,
      outcomeUnknown: false
    })
    expect(fixture.sent).toHaveLength(0)
    expect(fixture.poisoned).not.toHaveBeenCalled()
  })

  it('poisons cancellation after the complete request write starts', async () => {
    const sent: AgentFrame[] = []
    const poisoned = vi.fn()
    const controller = new AbortController()
    const client = new ModelBridgeBlobClient({
      binding: {
        bindingId: 'binding-1',
        promptOperationId: 'prompt-1',
        controllerId: 'controller-1',
        controllerGeneration: 2,
        connectionId: 'connection-1',
        acpChannelEpoch: '4',
        channelId: 'model-channel-1',
        channelEpoch: '9',
        runtimeId: 'opencode',
        workspaceIdentity: 'workspace-1',
        policy,
        deadlineAt: new Date(Date.now() + 60_000).toISOString()
      },
      sendBlobFrame: async (frame) => {
        sent.push(frame)
        controller.abort()
      },
      onPoison: poisoned,
      randomMessageId: () => 'message-cancelled-after-write'
    })

    await expect(
      client.exchange(request, {
        requestId: 'request-cancelled-after-write',
        signal: controller.signal
      })
    ).rejects.toThrow()
    expect(sent).toHaveLength(1)
    await waitFor(() => poisoned.mock.calls.length === 1)
    expect(client.poisoned).toBe(true)
  })

  it('does not impose a model output-token quota', async () => {
    const fixture = createHarness()
    const pending = fixture.client.exchange(
      {
        ...request,
        bodyBase64: Buffer.from(
          JSON.stringify({
            model: 'private-model',
            max_output_tokens: 1_000_000
          })
        ).toString('base64')
      },
      {
        requestId: 'request-with-provider-limit',
        signal: new AbortController().signal
      }
    )
    await outboundRequest(fixture.sent)
    await fixture.client.close({ poisonIfActive: false })
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('does not consume a round for a definitive rejection', async () => {
    const fixture = createHarness()
    const firstPending = fixture.client.exchange(request, {
      requestId: 'request-first',
      signal: new AbortController().signal
    })
    const first = await outboundRequest(fixture.sent)
    await fixture.client.onBlobFrame(
      incomingFrame(
        await encodeModelBridgeMessage({
          protocol: 'goodbuddy-model-bridge-v1',
          kind: 'error',
          identity: first.identity,
          requestDigest: first.requestDigest,
          error: {
            code: 'policy-rejected',
            message: 'Remote model request was rejected',
            retryable: false,
            poisoned: false,
            outcomeUnknown: false
          }
        }),
        1
      )
    )
    await expect(firstPending).rejects.toMatchObject({ code: 'remote' })

    const secondPending = fixture.client.exchange(request, {
      requestId: 'request-second',
      signal: new AbortController().signal
    })
    const second = await outboundRequest(fixture.sent, 1)
    expect(second.identity.roundIndex).toBe(0)
    await fixture.client.close({ poisonIfActive: false })
    await expect(secondPending).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('rejects a malformed response and poisons the binding', async () => {
    const fixture = createHarness()
    const pending = fixture.client.exchange(request, {
      requestId: 'request-malformed',
      signal: new AbortController().signal
    })
    await outboundRequest(fixture.sent)
    await expect(
      fixture.client.onBlobFrame(
        incomingFrame(Buffer.from('{ "not": "canonical" }\n'), 1)
      )
    ).rejects.toBeInstanceOf(Error)
    await expect(pending).rejects.toBeInstanceOf(Error)
    expect(fixture.client.poisoned).toBe(true)
  })

  it('permanently poisons delivery that ends before the helper ACK', async () => {
    const fixture = createHarness()
    const pending = fixture.client.exchange(request, {
      requestId: 'request-uncertain',
      signal: new AbortController().signal
    })
    const outbound = await outboundRequest(fixture.sent)
    await deliverResponse(fixture.client, outbound, 0)
    const exchange = await pending
    await exchange.failDelivery()
    expect(fixture.client.poisoned).toBe(true)
    expect(fixture.poisoned).toHaveBeenCalledOnce()
    await expect(
      fixture.client.exchange(request, {
        requestId: 'request-after-poison',
        signal: new AbortController().signal
      })
    ).rejects.toBeInstanceOf(ModelBridgeClientError)
  })
})

function incomingFrame(payload: Uint8Array, sequence: number): AgentFrame {
  return {
    header: {
      protocolMajor: AGENT_PROTOCOL_VERSION.major,
      protocolMinor: AGENT_PROTOCOL_VERSION.minor,
      connectionId: 'connection-1',
      generation: 2,
      channelId: 'model-channel-1',
      channelEpoch: '9',
      direction: 'main-to-agent',
      sequence: String(sequence),
      kind: 'blob',
      payloadLength: payload.byteLength
    },
    payload
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for model bridge')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
}
