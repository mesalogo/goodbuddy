import { describe, expect, it } from 'vitest'
import {
  AGENT_PROTOCOL_LIMITS,
  AGENT_PROTOCOL_VERSION,
  AgentChannelState,
  CanonicalPayloadError,
  MAXIMUM_ENCODED_AGENT_FRAME_BYTES,
  acpReplayChannelRequestSchema,
  acpResumeChannelResultSchema,
  agentFrameHeaderSchema,
  attachPrefaceSchema,
  canonicalJson,
  controllerResumeRequestSchema,
  controllerResumeResultSchema,
  decodeAgentFrame,
  daemonStatusSchema,
  daemonCapabilitiesSchema,
  digestCanonicalOperation,
  encodeAgentFrame,
  jsonRpcMessageSchema,
  operationIdentitySchema,
  type AgentFrameHeader
} from '.'

const header: AgentFrameHeader = {
  protocolMajor: AGENT_PROTOCOL_VERSION.major,
  protocolMinor: AGENT_PROTOCOL_VERSION.minor,
  connectionId: 'connection-1',
  generation: 3,
  channelId: 'control-1',
  channelEpoch: '7',
  direction: 'main-to-agent',
  sequence: '42',
  kind: 'control',
  payloadLength: 0
}

describe('agent protocol contracts', () => {
  it('strictly rejects unknown operation identity fields and malformed digests', () => {
    const base = {
      controllerId: 'controller-1',
      operationId: 'operation-1',
      scope: {
        kind: 'workspace' as const,
        workspaceIdentity: 'workspace-1'
      },
      method: 'workspace/writeTextAtomic',
      payloadDigest: `sha256:${'a'.repeat(64)}`
    }
    expect(operationIdentitySchema.parse(base)).toEqual(base)
    expect(() =>
      operationIdentitySchema.parse({ ...base, transportGeneration: 4 })
    ).toThrow()
    expect(() =>
      operationIdentitySchema.parse({
        ...base,
        payloadDigest: 'not-a-digest'
      })
    ).toThrow()
  })

  it('canonicalizes object keys without changing array order', () => {
    expect(
      canonicalJson({
        z: 1,
        nested: { beta: true, alpha: null },
        list: [3, 2, 1]
      })
    ).toBe(
      '{"list":[3,2,1],"nested":{"alpha":null,"beta":true},"z":1}'
    )
    expect(canonicalJson({ value: -0 })).toBe('{"value":0}')
  })

  it('produces the same operation digest for equivalent key order', async () => {
    const scope = {
      kind: 'workspace' as const,
      workspaceIdentity: 'workspace-1'
    }
    const first = await digestCanonicalOperation({
      method: 'workspace/writeTextAtomic',
      scope,
      payload: { path: 'a.ts', content: 'x' }
    })
    const second = await digestCanonicalOperation({
      method: 'workspace/writeTextAtomic',
      scope,
      payload: { content: 'x', path: 'a.ts' }
    })
    expect(first).toBe(second)
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/u)
  })

  it('rejects non-JSON and cyclic digest inputs instead of silently dropping values', () => {
    expect(() => canonicalJson({ missing: undefined })).toThrow(
      CanonicalPayloadError
    )
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(
      CanonicalPayloadError
    )
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(() => canonicalJson(cyclic)).toThrow(CanonicalPayloadError)
  })

  it('strictly distinguishes all JSON-RPC message variants', () => {
    const messages = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'agent/status',
        params: {}
      },
      {
        jsonrpc: '2.0',
        method: 'channel/close',
        params: { channelId: 'channel-1', channelEpoch: '1' }
      },
      { jsonrpc: '2.0', id: 'request-1', result: null },
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' }
      }
    ]
    for (const message of messages) {
      expect(jsonRpcMessageSchema.parse(message)).toEqual(message)
    }
    expect(() =>
      jsonRpcMessageSchema.parse({
        ...messages[0],
        result: null
      })
    ).toThrow()
    expect(() =>
      jsonRpcMessageSchema.parse({
        jsonrpc: '2.0',
        id: null,
        method: 'agent/status'
      })
    ).toThrow()
    expect(() =>
      jsonRpcMessageSchema.parse({
        ...messages[1],
        unexpected: true
      })
    ).toThrow()
  })

  it('validates attach, capability, and controller synchronization boundaries', () => {
    const preface = {
      type: 'goodbuddy-agent-attach' as const,
      protocol: AGENT_PROTOCOL_VERSION,
      goodBuddyVersion: '0.11.0',
      controllerId: 'controller-1',
      clientNonce: 'nonce-1',
      hostRevision: 2,
      hostKeyGeneration: 3
    }
    expect(attachPrefaceSchema.parse(preface)).toEqual(preface)
    expect(() =>
      attachPrefaceSchema.parse({ ...preface, connectionId: 'client-chosen' })
    ).toThrow()

    const capabilities = {
      generation: 1,
      capabilities: [
        { name: 'workspace/read', version: 1, critical: true }
      ],
      runtimes: []
    }
    expect(daemonCapabilitiesSchema.parse(capabilities)).toEqual(
      capabilities
    )
    expect(() =>
      daemonCapabilitiesSchema.parse({
        ...capabilities,
        capabilities: [
          ...capabilities.capabilities,
          capabilities.capabilities[0]
        ]
      })
    ).toThrow(/unique/iu)

    const resume = {
      previousGeneration: 1,
      previousConnectionId: 'connection-1',
      daemonBootId: 'boot-1',
      capabilityGeneration: 1
    }
    expect(controllerResumeRequestSchema.parse(resume)).toEqual(resume)
    expect(() =>
      controllerResumeRequestSchema.parse({
        ...resume,
        controllerId: 'controller-from-client'
      })
    ).toThrow()
    expect(() =>
      controllerResumeRequestSchema.parse({
        ...resume,
        eventCursors: []
      })
    ).toThrow()

    const resumeResult = {
      resumed: true,
      generation: 2,
      daemonBootId: 'boot-1',
      capabilityGeneration: 1,
      leaseDeadlineAt: '2030-01-01T00:00:00.000Z'
    }
    expect(controllerResumeResultSchema.parse(resumeResult)).toEqual(
      resumeResult
    )
    expect(() =>
      controllerResumeResultSchema.parse({
        ...resumeResult,
        synchronizationRequired: true
      })
    ).toThrow()
  })

  it('accepts only the detached on-demand Agent supervisor', () => {
    const status = {
      state: 'ready' as const,
      installationId: 'agent-v1',
      binaryDigest: `sha256:${'a'.repeat(64)}`,
      daemonBootId: 'boot-1',
      agentVersion: '1.0.0',
      protocol: AGENT_PROTOCOL_VERSION,
      platform: 'linux' as const,
      architecture: 'x64' as const,
      supervisor: 'detached-on-demand' as const,
      remoteUserIdentity: 'user-1',
      draining: false
    }
    expect(daemonStatusSchema.parse(status)).toEqual(status)
    expect(() =>
      daemonStatusSchema.parse({
        ...status,
        supervisor: 'systemd-user'
      })
    ).toThrow()
  })

  it('types the two-phase ACP resume with stable binding identity and authoritative cursors', () => {
    expect(
      acpResumeChannelResultSchema.parse({
        bindingId: 'binding-1',
        channelId: 'binding-1',
        channelEpoch: '9',
        deadlineAt: '2030-01-01T00:00:00.000Z',
        cursors: {
          lastOutboundJournaledSequence: '3',
          lastOutboundDeliveredSequence: '2',
          lastInboundJournaledSequence: '5',
          lastMainAckSequence: '4'
        }
      })
    ).toMatchObject({
      bindingId: 'binding-1',
      channelEpoch: '9'
    })
    expect(() =>
      acpReplayChannelRequestSchema.parse({
        bindingId: 'binding-1',
        channelId: 'binding-1',
        channelEpoch: '9',
        acknowledgedSequence: '4',
        providerResponse: { secret: true }
      })
    ).toThrow()
  })
})

describe('agent binary frames', () => {
  it('sequences data and durable ACK frames independently', () => {
    const channel = new AgentChannelState({
      connectionId: 'connection-1',
      generation: 3,
      channelId: 'acp-1',
      channelEpoch: '7',
      inboundDirection: 'main-to-agent'
    })
    const inbound = (
      kind: AgentFrameHeader['kind'],
      sequence: string
    ): AgentFrameHeader => ({
      ...header,
      channelId: 'acp-1',
      direction: 'main-to-agent',
      kind,
      sequence
    })
    expect(() => channel.acceptInbound(inbound('acp', '1'))).not.toThrow()
    expect(() =>
      channel.acceptInbound(inbound('ack', '1'))
    ).not.toThrow()
    expect(() => channel.acceptInbound(inbound('acp', '2'))).not.toThrow()

    const outbound = (
      kind: AgentFrameHeader['kind']
    ): AgentFrameHeader =>
      channel.reserveOutbound({
        ...header,
        channelId: 'acp-1',
        direction: 'agent-to-main',
        kind
      })
    expect(outbound('acp').sequence).toBe('1')
    expect(outbound('ack').sequence).toBe('1')
    expect(outbound('acp').sequence).toBe('2')
  })

  it('round-trips raw ACP bytes and all routing identity', () => {
    const payload = new Uint8Array([0, 10, 255, 42])
    const bytes = encodeAgentFrame({
      header: { ...header, kind: 'acp' },
      payload
    })
    const decoded = decodeAgentFrame(bytes, {
      protocolMajor: AGENT_PROTOCOL_VERSION.major,
      maximumProtocolMinor: AGENT_PROTOCOL_VERSION.minor,
      connectionId: 'connection-1',
      generation: 3
    })
    expect(decoded.header).toEqual({
      ...header,
      kind: 'acp',
      payloadLength: payload.byteLength
    })
    expect(decoded.payload).toEqual(payload)
  })

  it.each([
    ['control', AGENT_PROTOCOL_LIMITS.maximumControlFrameBytes],
    ['acp', AGENT_PROTOCOL_LIMITS.maximumAcpFrameBytes],
    ['blob', AGENT_PROTOCOL_LIMITS.maximumBlobFrameBytes],
    ['ack', AGENT_PROTOCOL_LIMITS.maximumAckFrameBytes]
  ] as const)('enforces the %s frame limit', (kind, maximum) => {
    expect(() =>
      agentFrameHeaderSchema.parse({
        ...header,
        kind,
        payloadLength: maximum + 1
      })
    ).toThrow()
  })

  it('keeps the encoded frame bound aligned with maximum identifiers and payload', () => {
    const maximumIdentifier = 'a'.repeat(
      AGENT_PROTOCOL_LIMITS.maximumIdentifierBytes
    )
    const encoded = encodeAgentFrame({
      header: {
        ...header,
        connectionId: maximumIdentifier,
        channelId: maximumIdentifier,
        kind: 'blob'
      },
      payload: new Uint8Array(
        AGENT_PROTOCOL_LIMITS.maximumBlobFrameBytes
      )
    })
    expect(encoded.byteLength).toBe(MAXIMUM_ENCODED_AGENT_FRAME_BYTES)
  })

  it('rejects generation mismatch, trailing bytes, and incomplete frames', () => {
    const encoded = encodeAgentFrame({
      header,
      payload: new Uint8Array([1])
    })
    expect(() =>
      decodeAgentFrame(encoded, { generation: 4 })
    ).toThrow(/generation/iu)
    const trailing = new Uint8Array(encoded.byteLength + 1)
    trailing.set(encoded)
    expect(() => decodeAgentFrame(trailing)).toThrow(/Trailing/iu)
    expect(() =>
      decodeAgentFrame(encoded.subarray(0, encoded.byteLength - 1))
    ).toThrow(/Incomplete/iu)
  })

  it('rejects unnegotiated major and minor versions', () => {
    const encoded = encodeAgentFrame({
      header: { ...header, protocolMajor: 2, protocolMinor: 4 },
      payload: new Uint8Array()
    })
    expect(() =>
      decodeAgentFrame(encoded, {
        protocolMajor: 1,
        maximumProtocolMinor: 3
      })
    ).toThrow(/major/iu)
    expect(() =>
      decodeAgentFrame(encoded, {
        protocolMajor: 2,
        maximumProtocolMinor: 3
      })
    ).toThrow(/minor/iu)
  })
})
