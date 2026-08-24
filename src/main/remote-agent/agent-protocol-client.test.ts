import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROTOCOL_LIMITS,
  AGENT_PROTOCOL_VERSION,
  type AgentFrame,
  type AttachWelcome
} from '../../shared/agent-protocol'
import type { AgentAttachTransport } from './agent-attach-transport'
import {
  AgentProtocolClient,
  AgentProtocolClientError
} from './agent-protocol-client'

class FakeTransport {
  readonly welcome: AttachWelcome = {
    type: 'goodbuddy-agent-welcome',
    protocol: AGENT_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    generation: 3,
    installationId: 'agent-v1',
    binaryDigest: `sha256:${'a'.repeat(64)}`,
    daemonBootId: 'boot-1',
    serverNonce: 'server-nonce'
  }
  readonly sent: AgentFrame[] = []
  #frames: AgentFrame[] = []
  #readers: Array<{
    resolve: (frame: AgentFrame) => void
    reject: (error: unknown) => void
  }> = []
  #close?: (error: Error) => void

  send(frame: AgentFrame): Promise<void> {
    this.sent.push(frame)
    return Promise.resolve()
  }

  receive(): Promise<AgentFrame> {
    const frame = this.#frames.shift()
    if (frame !== undefined) {
      return Promise.resolve(frame)
    }
    return new Promise((resolve, reject) => {
      this.#readers.push({ resolve, reject })
    })
  }

  remote(frame: AgentFrame): void {
    const reader = this.#readers.shift()
    if (reader !== undefined) {
      reader.resolve(frame)
    } else {
      this.#frames.push(frame)
    }
  }

  onClose(listener: (error: Error) => void): () => void {
    this.#close = listener
    return () => {
      this.#close = undefined
    }
  }

  dispose(): void {
    const error = new Error('disposed')
    this.#close?.(error)
    for (const reader of this.#readers.splice(0)) {
      reader.reject(error)
    }
  }
}

function inbound(
  outbound: AgentFrame,
  sequence: string,
  kind: AgentFrame['header']['kind'],
  value: unknown
): AgentFrame {
  const payload =
    value instanceof Uint8Array
      ? value
      : Buffer.from(JSON.stringify(value), 'utf8')
  return {
    header: {
      ...outbound.header,
      direction: 'agent-to-main',
      sequence,
      kind,
      payloadLength: payload.byteLength
    },
    payload
  }
}

async function waitForSent(
  transport: FakeTransport,
  count: number
): Promise<void> {
  await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThanOrEqual(count))
}

describe('AgentProtocolClient', () => {
  it('strictly resolves a typed response only after matching channel close', async () => {
    const transport = new FakeTransport()
    const client = new AgentProtocolClient(
      transport as unknown as AgentAttachTransport
    )
    const result = client.request('agent/status', {})
    await waitForSent(transport, 1)
    const requestFrame = transport.sent[0]!
    const request = JSON.parse(
      Buffer.from(requestFrame.payload).toString('utf8')
    ) as { id: string }
    transport.remote(
      inbound(requestFrame, '1', 'control', {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          state: 'ready',
          installationId: 'agent-v1',
          binaryDigest: `sha256:${'a'.repeat(64)}`,
          daemonBootId: 'boot-1',
          agentVersion: '1.0.0',
          protocol: AGENT_PROTOCOL_VERSION,
          platform: 'linux',
          architecture: 'x64',
          supervisor: 'detached-on-demand',
          remoteUserIdentity: 'user-1',
          draining: false
        }
      })
    )
    let settled = false
    void result.finally(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    transport.remote(
      inbound(requestFrame, '2', 'control', {
        jsonrpc: '2.0',
        method: 'channel/close',
        params: {
          channelId: requestFrame.header.channelId,
          channelEpoch: requestFrame.header.channelEpoch
        }
      })
    )
    await expect(result).resolves.toMatchObject({ state: 'ready' })
    client.dispose()
  })

  it('bounds abandoned waiters within request capacity', async () => {
    const transport = new FakeTransport()
    const client = new AgentProtocolClient(
      transport as unknown as AgentAttachTransport
    )
    for (let index = 0; index < 256; index += 1) {
      const controller = new AbortController()
      const request = client.request('agent/status', {}, {
        signal: controller.signal
      })
      controller.abort(new Error('cancelled waiter'))
      await expect(request).rejects.toThrow('cancelled waiter')
    }
    await expect(
      client.request('agent/status', {})
    ).rejects.toMatchObject({
      code: 'capacity'
    })
    client.dispose()
  })

  it('retains response sequence state when cancellation races channel close', async () => {
    const transport = new FakeTransport()
    const client = new AgentProtocolClient(
      transport as unknown as AgentAttachTransport
    )
    const closed = vi.fn()
    client.onClose(closed)
    const controller = new AbortController()
    const result = client.request('agent/status', {}, {
      signal: controller.signal
    })
    await waitForSent(transport, 1)
    const requestFrame = transport.sent[0]!
    const request = JSON.parse(
      Buffer.from(requestFrame.payload).toString('utf8')
    ) as { id: string }
    transport.remote(
      inbound(requestFrame, '1', 'control', {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          state: 'ready',
          installationId: 'agent-v1',
          binaryDigest: `sha256:${'a'.repeat(64)}`,
          daemonBootId: 'boot-1',
          agentVersion: '1.0.0',
          protocol: AGENT_PROTOCOL_VERSION,
          platform: 'linux',
          architecture: 'x64',
          supervisor: 'detached-on-demand',
          remoteUserIdentity: 'user-1',
          draining: false
        }
      })
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    controller.abort(new Error('cancelled after response'))
    await expect(result).rejects.toThrow('cancelled after response')

    transport.remote(
      inbound(requestFrame, '2', 'control', {
        jsonrpc: '2.0',
        method: 'channel/close',
        params: {
          channelId: requestFrame.header.channelId,
          channelEpoch: requestFrame.header.channelEpoch
        }
      })
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(closed).not.toHaveBeenCalled()
    const nextRequest = client.request('agent/status', {})
    void nextRequest.catch(() => undefined)
    client.dispose()
  })

  it('acknowledges durable ACP output only after consumption', async () => {
    const transport = new FakeTransport()
    const client = new AgentProtocolClient(
      transport as unknown as AgentAttachTransport
    )
    const channel = client.registerBinaryChannel({
      channelId: 'binding-1',
      channelEpoch: '9',
      kind: 'acp'
    })
    const payload = Buffer.from('runtime event')
    transport.remote({
      header: {
        protocolMajor: AGENT_PROTOCOL_VERSION.major,
        protocolMinor: AGENT_PROTOCOL_VERSION.minor,
        connectionId: 'connection-1',
        generation: 3,
        channelId: 'binding-1',
        channelEpoch: '9',
        direction: 'agent-to-main',
        sequence: '1',
        kind: 'acp',
        payloadLength: payload.byteLength
      },
      payload
    })
    const received = await channel.receive()
    expect(transport.sent).toHaveLength(0)
    await received.consume()
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]!.header.kind).toBe('ack')
    expect(transport.sent[0]!.header.sequence).toBe('1')
    expect(
      JSON.parse(Buffer.from(transport.sent[0]!.payload).toString('utf8'))
    ).toEqual({
      acknowledgedSequence: '1'
    })

    await channel.send(Buffer.from('next input'))
    expect(transport.sent[1]!.header.kind).toBe('acp')
    expect(transport.sent[1]!.header.sequence).toBe('1')

    const nextPayload = Buffer.from('next runtime event')
    transport.remote({
      header: {
        protocolMajor: AGENT_PROTOCOL_VERSION.major,
        protocolMinor: AGENT_PROTOCOL_VERSION.minor,
        connectionId: 'connection-1',
        generation: 3,
        channelId: 'binding-1',
        channelEpoch: '9',
        direction: 'agent-to-main',
        sequence: '2',
        kind: 'acp',
        payloadLength: nextPayload.byteLength
      },
      payload: nextPayload
    })
    await expect(channel.receive()).resolves.toMatchObject({
      sequence: '2',
      payload: nextPayload
    })
    client.dispose()
  })

  it('seeds resumed ACP data sequences from authoritative cursors', async () => {
    const transport = new FakeTransport()
    const client = new AgentProtocolClient(
      transport as unknown as AgentAttachTransport
    )
    const channel = client.registerBinaryChannel({
      channelId: 'binding-resumed',
      channelEpoch: '12',
      kind: 'acp',
      nextInboundSequence: '7',
      nextOutboundSequence: '5'
    })
    await channel.send(Buffer.from('new-only-input'))
    expect(transport.sent[0]!.header.sequence).toBe('5')

    const payload = Buffer.from('replayed-output')
    transport.remote({
      header: {
        protocolMajor: AGENT_PROTOCOL_VERSION.major,
        protocolMinor: AGENT_PROTOCOL_VERSION.minor,
        connectionId: 'connection-1',
        generation: 3,
        channelId: 'binding-resumed',
        channelEpoch: '12',
        direction: 'agent-to-main',
        sequence: '7',
        kind: 'acp',
        payloadLength: payload.byteLength
      },
      payload
    })
    await expect(channel.receive()).resolves.toMatchObject({
      sequence: '7',
      payload
    })
    client.dispose()
  })

  it('notifies binary channel close listeners exactly once', () => {
    const transport = new FakeTransport()
    const client = new AgentProtocolClient(
      transport as unknown as AgentAttachTransport
    )
    const channel = client.registerBinaryChannel({
      channelId: 'binding-close',
      channelEpoch: '11',
      kind: 'acp'
    })
    const closed = vi.fn()
    channel.onClose(closed)
    channel.close()
    channel.close()
    expect(closed).toHaveBeenCalledOnce()
    client.dispose()
  })

  it('allocates unique Main-owned blob channels and closes with a matching notification', async () => {
    const transport = new FakeTransport()
    const client = new AgentProtocolClient(
      transport as unknown as AgentAttachTransport
    )
    const first = client.allocateBinaryChannel({ kind: 'blob' })
    const second = client.allocateBinaryChannel({ kind: 'blob' })
    expect(first.channelId).not.toBe(second.channelId)
    expect(first.channelEpoch).not.toBe(second.channelEpoch)

    await first.closeWithNotification()
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]!.header).toMatchObject({
      channelId: first.channelId,
      channelEpoch: first.channelEpoch,
      kind: 'control',
      direction: 'main-to-agent'
    })
    expect(
      JSON.parse(Buffer.from(transport.sent[0]!.payload).toString('utf8'))
    ).toEqual({
      jsonrpc: '2.0',
      method: 'channel/close',
      params: {
        channelId: first.channelId,
        channelEpoch: first.channelEpoch
      }
    })
    expect(() =>
      client.registerBinaryChannel({
        channelId: first.channelId,
        channelEpoch: first.channelEpoch,
        kind: 'blob'
      })
    ).toThrow()
    second.close()
    client.dispose()
  })

  it('sends one bounded blob message as one protocol frame', async () => {
    const transport = new FakeTransport()
    const client = new AgentProtocolClient(
      transport as unknown as AgentAttachTransport
    )
    const channel = client.allocateBinaryChannel({ kind: 'blob' })
    const payload = Buffer.alloc(
      AGENT_PROTOCOL_LIMITS.maximumBlobFrameBytes
    )

    await channel.send(payload)

    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]!.header).toMatchObject({
      kind: 'blob',
      sequence: '1'
    })
    expect(transport.sent[0]!.payload.byteLength).toBe(
      payload.byteLength
    )
    await expect(
      channel.send(
        Buffer.alloc(AGENT_PROTOCOL_LIMITS.maximumBlobFrameBytes + 1)
      )
    ).rejects.toMatchObject({ code: 'protocol' })
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(
      channel.send(Buffer.of(1), controller.signal)
    ).rejects.toThrow(/cancelled/iu)
    expect(transport.sent).toHaveLength(1)
    channel.close()
    client.dispose()
  })

  it('receives sequential blob messages without transport ACK traffic', async () => {
    const transport = new FakeTransport()
    const client = new AgentProtocolClient(
      transport as unknown as AgentAttachTransport
    )
    const channel = client.allocateBinaryChannel({ kind: 'blob' })
    for (let index = 1; index <= 3; index += 1) {
      const payload = Buffer.alloc(128 * 1024, index)
      transport.remote({
        header: {
          protocolMajor: AGENT_PROTOCOL_VERSION.major,
          protocolMinor: AGENT_PROTOCOL_VERSION.minor,
          connectionId: 'connection-1',
          generation: 3,
          channelId: channel.channelId,
          channelEpoch: channel.channelEpoch,
          direction: 'agent-to-main',
          sequence: String(index),
          kind: 'blob',
          payloadLength: payload.byteLength
        },
        payload
      })
      const frame = await channel.receive()
      expect(frame.payload[0]).toBe(index)
      await frame.consume()
    }
    expect(transport.sent).toHaveLength(0)
    channel.close()
    client.dispose()
  })

  it.each([
    {
      label: 'unknown Agent-first channel',
      frame: {
        channelId: 'agent-first',
        channelEpoch: '90',
        generation: 3,
        kind: 'blob' as const
      }
    },
    {
      label: 'cross-kind frame',
      frame: {
        channelId: 'allocated',
        channelEpoch: 'allocated',
        generation: 3,
        kind: 'acp' as const
      }
    },
    {
      label: 'stale epoch',
      frame: {
        channelId: 'allocated',
        channelEpoch: '91',
        generation: 3,
        kind: 'blob' as const
      }
    },
    {
      label: 'stale generation',
      frame: {
        channelId: 'allocated',
        channelEpoch: 'allocated',
        generation: 2,
        kind: 'blob' as const
      }
    }
  ])('rejects a $label', async ({ frame }) => {
    const transport = new FakeTransport()
    const client = new AgentProtocolClient(
      transport as unknown as AgentAttachTransport
    )
    const closed = new Promise<AgentProtocolClientError>((resolve) => {
      client.onClose(resolve)
    })
    const allocated = client.allocateBinaryChannel({ kind: 'blob' })
    const payload = Buffer.from('invalid')
    transport.remote({
      header: {
        protocolMajor: AGENT_PROTOCOL_VERSION.major,
        protocolMinor: AGENT_PROTOCOL_VERSION.minor,
        connectionId: 'connection-1',
        generation: frame.generation,
        channelId:
          frame.channelId === 'allocated'
            ? allocated.channelId
            : frame.channelId,
        channelEpoch:
          frame.channelEpoch === 'allocated'
            ? allocated.channelEpoch
            : frame.channelEpoch,
        direction: 'agent-to-main',
        sequence: '1',
        kind: frame.kind,
        payloadLength: payload.byteLength
      },
      payload
    })
    await expect(closed).resolves.toBeInstanceOf(
      AgentProtocolClientError
    )
    expect(() => client.request('agent/status', {})).toThrow(
      AgentProtocolClientError
    )
  })

  it('relies on SSH transport backpressure instead of peer credit', async () => {
    const transport = new FakeTransport()
    const client = new AgentProtocolClient(
      transport as unknown as AgentAttachTransport
    )
    const channel = client.registerBinaryChannel({
      channelId: 'binding-2',
      channelEpoch: '10',
      kind: 'acp'
    })
    await channel.send(Buffer.alloc(300 * 1024))
    expect(transport.sent[0]!.payload).toHaveLength(300 * 1024)
    client.dispose()
  })

  it('fails closed on a mismatched response ID', async () => {
    const transport = new FakeTransport()
    const client = new AgentProtocolClient(
      transport as unknown as AgentAttachTransport
    )
    const request = client.request('agent/status', {})
    await waitForSent(transport, 1)
    transport.remote(
      inbound(transport.sent[0]!, '1', 'control', {
        jsonrpc: '2.0',
        id: 'wrong-request',
        result: null
      })
    )
    await expect(request).rejects.toBeInstanceOf(
      AgentProtocolClientError
    )
    expect(() => client.request('agent/status', {})).toThrow(
      AgentProtocolClientError
    )
  })
})
