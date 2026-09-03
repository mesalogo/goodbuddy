import { describe, expect, it } from 'vitest'
import {
  MODEL_BRIDGE_LIMITS,
  MODEL_BRIDGE_PROTOCOL,
  ModelBridgeCodecError,
  createModelBridgeRequestMessage,
  decodeModelBridgeMessage,
  digestModelBridgeRequest,
  encodeModelBridgeMessage,
  modelBridgeErrorMessageSchema,
  modelBridgeDeliveryAckMessageSchema,
  modelBridgeIdentitySchema,
  modelBridgePolicySchema,
  type ModelBridgeIdentity
} from './model-bridge-contracts'
import { remoteModelGatewayRequestSchema } from './remote-model-gateway-contracts'

const digest = `sha256:${'a'.repeat(64)}`
const identity: ModelBridgeIdentity = {
  bindingId: 'binding-1',
  promptOperationId: 'prompt-1',
  requestId: 'request-1',
  roundIndex: 2,
  modelProfileDigest: digest,
  messageId: 'message-1'
}
const policy = {
  protocol: 'anthropic-messages',
  model: 'claude-test',
  modelProfileDigest: digest,
  supportsImageInput: true
} as const
const request = {
  method: 'POST',
  path: '/v1/messages',
  headers: {
    accept: 'application/json',
    'content-type': 'application/json'
  },
  bodyBase64: Buffer.from(
    JSON.stringify({
      model: 'claude-test',
      messages: [{ role: 'user', content: '你好' }]
    })
  ).toString('base64')
} as const

describe('model bridge contracts and codec', () => {
  it('round trips one bounded request message with an exact digest', async () => {
    const message = await createModelBridgeRequestMessage({
      identity,
      policy,
      request
    })
    expect(message.requestDigest).toBe(
      await digestModelBridgeRequest(request)
    )

    const payload = await encodeModelBridgeMessage(message)
    expect(payload.byteLength).toBeLessThanOrEqual(
      MODEL_BRIDGE_LIMITS.maximumMessageBytes
    )
    await expect(
      decodeModelBridgeMessage(payload, { expectedIdentity: identity })
    ).resolves.toEqual(message)
  })

  it('uses representation safety rather than a fixed round quota', () => {
    expect(
      modelBridgeIdentitySchema.parse({
        ...identity,
        roundIndex: 100_001
      }).roundIndex
    ).toBe(100_001)
  })

  it('deterministically encodes a large request as one message', async () => {
    const message = await createModelBridgeRequestMessage({
      identity,
      policy,
      request: {
        ...request,
        bodyBase64: Buffer.alloc(600 * 1024, 7).toString('base64')
      }
    })
    const left = await encodeModelBridgeMessage(message)
    const right = await encodeModelBridgeMessage(message)

    expect(left).toEqual(right)
    expect(left.byteLength).toBeGreaterThan(600 * 1024)
    await expect(decodeModelBridgeMessage(left)).resolves.toEqual(message)
  })

  it('round trips response, error, and delivery ACK messages', async () => {
    const requestDigest = await digestModelBridgeRequest(request)
    const response = {
      protocol: MODEL_BRIDGE_PROTOCOL,
      kind: 'response',
      identity,
      requestDigest,
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyBase64: Buffer.from('{"ok":true}').toString('base64')
      }
    } as const
    await expect(
      decodeModelBridgeMessage(await encodeModelBridgeMessage(response))
    ).resolves.toEqual(response)

    const error = modelBridgeErrorMessageSchema.parse({
      protocol: MODEL_BRIDGE_PROTOCOL,
      kind: 'error',
      identity,
      requestDigest,
      error: {
        code: 'dispatch-outcome-unknown',
        message: 'Provider dispatch outcome cannot be established',
        retryable: false,
        poisoned: true,
        outcomeUnknown: true
      }
    })
    await expect(
      decodeModelBridgeMessage(await encodeModelBridgeMessage(error))
    ).resolves.toEqual(error)

    const delivery = modelBridgeDeliveryAckMessageSchema.parse({
      protocol: MODEL_BRIDGE_PROTOCOL,
      kind: 'response-delivered',
      identity,
      requestDigest
    })
    await expect(
      decodeModelBridgeMessage(await encodeModelBridgeMessage(delivery))
    ).resolves.toEqual(delivery)
  })

  it('rejects malformed, noncanonical, and oversized messages', async () => {
    await expect(
      decodeModelBridgeMessage(new Uint8Array([0xff]))
    ).rejects.toBeInstanceOf(ModelBridgeCodecError)
    await expect(
      decodeModelBridgeMessage(Buffer.from('{ "kind": "request" }'))
    ).rejects.toMatchObject({ code: 'invalid-message' })

    const message = await createModelBridgeRequestMessage({
      identity,
      policy,
      request
    })
    const payload = await encodeModelBridgeMessage(message)
    await expect(
      decodeModelBridgeMessage(payload, { maximumMessageBytes: 10 })
    ).rejects.toMatchObject({ code: 'oversized' })
    await expect(
      decodeModelBridgeMessage(
        Buffer.alloc(MODEL_BRIDGE_LIMITS.maximumMessageBytes + 1)
      )
    ).rejects.toMatchObject({ code: 'oversized' })
  })

  it('rejects mismatched identities and request digests', async () => {
    const message = await createModelBridgeRequestMessage({
      identity,
      policy,
      request
    })
    const payload = await encodeModelBridgeMessage(message)
    await expect(
      decodeModelBridgeMessage(payload, {
        expectedIdentity: { ...identity, roundIndex: 3 }
      })
    ).rejects.toMatchObject({ code: 'identity-mismatch' })
    await expect(
      decodeModelBridgeMessage(payload, {
        expectedRequestDigest: `sha256:${'b'.repeat(64)}`
      })
    ).rejects.toMatchObject({ code: 'digest-mismatch' })

    await expect(
      encodeModelBridgeMessage({
        ...message,
        requestDigest: `sha256:${'b'.repeat(64)}`
      })
    ).rejects.toMatchObject({ code: 'digest-mismatch' })
    expect(() =>
      modelBridgePolicySchema.parse({
        ...policy,
        baseUrl: 'https://provider.example',
        apiKey: 'must-not-cross'
      })
    ).toThrow()
    expect(() =>
      modelBridgePolicySchema.parse({
        ...policy,
        maximumOutputTokens: 65_537,
        maximumModelCalls: 8,
        maximumTotalOutputTokens: 32_768
      })
    ).toThrow()
    await expect(
      createModelBridgeRequestMessage({
        identity,
        policy: {
          ...policy,
          modelProfileDigest: `sha256:${'b'.repeat(64)}`
        },
        request
      })
    ).rejects.toThrow()
  })

  it('rejects noncanonical base64 and protocol path mismatches', async () => {
    expect(() =>
      remoteModelGatewayRequestSchema.parse({
        ...request,
        bodyBase64: 'AB=='
      })
    ).toThrow()
    await expect(
      createModelBridgeRequestMessage({
        identity,
        policy,
        request: { ...request, path: '/v1/responses' }
      })
    ).rejects.toThrow()
  })
})