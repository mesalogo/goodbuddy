import { EventEmitter } from 'node:events'
import type { ClientChannel } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROTOCOL_FAILURE_STDERR_PREFIX,
  AGENT_PROTOCOL_LIMITS,
  AGENT_PROTOCOL_VERSION,
  encodeAgentFrame,
  type AgentFrame,
  type AttachPreface,
  type AttachWelcome
} from '../../shared/agent-protocol'
import { verifyAgentInstallationId } from '../ssh/ssh-agent-command'
import {
  AgentAttachTransport,
  AgentAttachTransportError
} from './agent-attach-transport'

class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter()
  readonly writes: Buffer[] = []
  readonly callbacks: Array<(error?: Error | null) => void> = []
  destroyed = false
  paused = false
  autoComplete = true
  onWrite?: (bytes: Buffer) => void

  write(
    bytes: Uint8Array,
    callback?: (error?: Error | null) => void
  ): boolean {
    const buffer = Buffer.from(bytes)
    this.writes.push(buffer)
    this.onWrite?.(buffer)
    if (callback !== undefined) {
      if (this.autoComplete) {
        queueMicrotask(() => callback())
      } else {
        this.callbacks.push(callback)
      }
    }
    return true
  }

  pause(): this {
    this.paused = true
    return this
  }

  resume(): this {
    this.paused = false
    return this
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true
      this.emit('close')
    }
    return this
  }

  completeWrite(error?: Error | null): void {
    this.callbacks.shift()?.(error)
  }

  remote(bytes: Uint8Array): void {
    this.emit('data', Buffer.from(bytes))
  }
}

const preface: AttachPreface = {
  type: 'goodbuddy-agent-attach',
  protocol: AGENT_PROTOCOL_VERSION,
  goodBuddyVersion: '0.11.0',
  controllerId: 'controller-1',
  clientNonce: 'client-nonce-1',
  hostRevision: 2,
  hostKeyGeneration: 3
}

const welcome: AttachWelcome = {
  type: 'goodbuddy-agent-welcome',
  protocol: AGENT_PROTOCOL_VERSION,
  connectionId: 'connection-1',
  generation: 2,
  installationId: 'agent-v1',
  binaryDigest: `sha256:${'a'.repeat(64)}`,
  daemonBootId: 'boot-1',
  serverNonce: 'server-nonce-1'
}

function packet(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  const bytes = Buffer.alloc(4 + body.byteLength)
  bytes.writeUInt32BE(body.byteLength, 0)
  body.copy(bytes, 4)
  return bytes
}

function frame(
  overrides: Partial<AgentFrame['header']> = {},
  payload = Buffer.from('payload')
): AgentFrame {
  return {
    header: {
      protocolMajor: AGENT_PROTOCOL_VERSION.major,
      protocolMinor: AGENT_PROTOCOL_VERSION.minor,
      connectionId: 'connection-1',
      generation: 2,
      channelId: 'channel-1',
      channelEpoch: '1',
      direction: 'agent-to-main',
      sequence: '1',
      kind: 'acp',
      payloadLength: payload.byteLength,
      ...overrides
    },
    payload
  }
}

function connect(
  channel: FakeChannel,
  options: { timeoutMs?: number } = {}
): Promise<AgentAttachTransport> {
  return AgentAttachTransport.connect({
    sshLease: {
      openAgentAttach: vi.fn(async () => channel as unknown as ClientChannel)
    },
    installationId: verifyAgentInstallationId('agent-v1'),
    preface,
    timeoutMs: options.timeoutMs
  })
}

describe('AgentAttachTransport', () => {
  it('handles a split welcome and a coalesced first binary frame', async () => {
    const channel = new FakeChannel()
    const encodedFrame = encodeAgentFrame(frame())
    channel.onWrite = () => {
      const response = Buffer.concat([packet(welcome), encodedFrame])
      queueMicrotask(() => {
        channel.remote(response.subarray(0, 2))
        channel.remote(response.subarray(2, 9))
        channel.remote(response.subarray(9))
      })
    }
    const transport = await connect(channel)
    expect(transport.welcome).toEqual(welcome)
    expect((await transport.receive()).payload).toEqual(
      Buffer.from('payload')
    )
    transport.dispose()
  })

  it('rejects oversized welcome packets and attach timeouts', async () => {
    const oversized = new FakeChannel()
    oversized.onWrite = () => {
      const length = Buffer.alloc(4)
      length.writeUInt32BE(4_097)
      queueMicrotask(() => oversized.remote(length))
    }
    await expect(connect(oversized)).rejects.toMatchObject({
      code: 'malformed'
    })

    const stalled = new FakeChannel()
    await expect(connect(stalled, { timeoutMs: 5 })).rejects.toMatchObject({
      code: 'timeout'
    })
    expect(stalled.destroyed).toBe(true)

    let observedSignal: AbortSignal | undefined
    const bootstrap = AgentAttachTransport.connect({
      sshLease: {
        openAgentAttach: vi.fn(
          async (_installationId, signal?: AbortSignal) => {
            observedSignal = signal
            await new Promise<void>((_resolve, reject) => {
              signal?.addEventListener(
                'abort',
                () => reject(signal.reason),
                { once: true }
              )
            })
            throw new Error('unreachable')
          }
        )
      },
      installationId: verifyAgentInstallationId('agent-v1'),
      preface,
      timeoutMs: 5
    })
    await expect(bootstrap).rejects.toMatchObject({
      code: 'timeout'
    })
    expect(observedSignal?.aborted).toBe(true)
  })

  it('fails closed on a stale generation frame', async () => {
    const channel = new FakeChannel()
    channel.onWrite = () => {
      queueMicrotask(() => channel.remote(packet(welcome)))
    }
    const transport = await connect(channel)
    channel.remote(
      encodeAgentFrame(frame({ generation: 1 }))
    )
    expect(() => transport.receive()).toThrow(
      AgentAttachTransportError
    )
    expect(transport.closed).toBe(true)
  })

  it('extracts only a bounded Agent protocol failure category', async () => {
    const channel = new FakeChannel()
    channel.onWrite = () => {
      queueMicrotask(() => channel.remote(packet(welcome)))
    }
    const transport = await connect(channel)
    const closed = new Promise<AgentAttachTransportError>((resolve) => {
      transport.onClose(resolve)
    })
    channel.stderr.emit(
      'data',
      `${AGENT_PROTOCOL_FAILURE_STDERR_PREFIX}dispatch/process\n`
    )
    channel.emit('close')
    await expect(closed).resolves.toMatchObject({
      code: 'closed',
      diagnostic: 'dispatch/process'
    })
  })

  it('does not copy remote stderr into attach diagnostics', async () => {
    const channel = new FakeChannel()
    channel.onWrite = () => {
      queueMicrotask(() => {
        channel.stderr.emit(
          'data',
          'secret-value host-00000000-0000-4000-8000-000000000001'
        )
        channel.emit('close')
      })
    }

    await expect(connect(channel)).rejects.toMatchObject({
      code: 'closed',
      message:
        'Agent attach closed during handshake with diagnostic output'
    })
  })

  it('writes every frame in caller FIFO order', async () => {
    const channel = new FakeChannel()
    channel.onWrite = () => {
      if (channel.writes.length === 1) {
        queueMicrotask(() => channel.remote(packet(welcome)))
      }
    }
    const transport = await connect(channel)
    channel.autoComplete = false
    const firstFrame = frame(
      { direction: 'main-to-agent', kind: 'blob', channelId: 'one' },
      Buffer.from('one')
    )
    const secondFrame = frame(
      { direction: 'main-to-agent', kind: 'blob', channelId: 'two' },
      Buffer.from('two')
    )
    const controlFrame = frame(
      { direction: 'main-to-agent', kind: 'control', channelId: 'three' },
      Buffer.from('{}')
    )
    const first = transport.send(firstFrame)
    const second = transport.send(secondFrame)
    const control = transport.send(controlFrame)

    expect(channel.writes).toHaveLength(2)
    expect(channel.writes[1]).toEqual(Buffer.from(encodeAgentFrame(firstFrame)))
    channel.completeWrite()
    await vi.waitFor(() => expect(channel.writes).toHaveLength(3))
    expect(channel.writes[2]).toEqual(Buffer.from(encodeAgentFrame(secondFrame)))
    channel.completeWrite()
    await vi.waitFor(() => expect(channel.writes).toHaveLength(4))
    expect(channel.writes[3]).toEqual(Buffer.from(encodeAgentFrame(controlFrame)))
    channel.completeWrite()
    await Promise.all([first, second, control])
    transport.dispose()
  })

  it('rejects an active write when the SSH transport fails', async () => {
    const channel = new FakeChannel()
    channel.onWrite = () => {
      if (channel.writes.length === 1) {
        queueMicrotask(() => channel.remote(packet(welcome)))
      }
    }
    const transport = await connect(channel)
    channel.autoComplete = false
    const pending = transport.send(
      frame(
        {
          direction: 'main-to-agent',
          kind: 'blob'
        },
        Buffer.of(1)
      )
    )

    channel.emit('error', new Error('SSH channel failed'))

    await expect(pending).rejects.toMatchObject({ code: 'closed' })
    expect(transport.closed).toBe(true)
    channel.completeWrite()
  })

  it('normalizes an active SSH write callback failure', async () => {
    const channel = new FakeChannel()
    channel.onWrite = () => {
      if (channel.writes.length === 1) {
        queueMicrotask(() => channel.remote(packet(welcome)))
      }
    }
    const transport = await connect(channel)
    channel.autoComplete = false
    const pending = transport.send(
      frame(
        {
          direction: 'main-to-agent',
          kind: 'blob'
        },
        Buffer.of(1)
      )
    )

    channel.completeWrite(new Error('SSH write failed'))

    await expect(pending).rejects.toMatchObject({
      code: 'closed',
      message: 'Failed to write an Agent frame'
    })
    expect(transport.closed).toBe(true)
  })

  it('writes one maximum-sized blob frame in one SSH write', async () => {
    const channel = new FakeChannel()
    channel.onWrite = () => {
      if (channel.writes.length === 1) {
        queueMicrotask(() => channel.remote(packet(welcome)))
      }
    }
    const transport = await connect(channel)
    const blob = frame(
      { direction: 'main-to-agent', kind: 'blob' },
      Buffer.alloc(AGENT_PROTOCOL_LIMITS.maximumBlobFrameBytes)
    )

    await transport.send(blob)

    expect(channel.writes).toHaveLength(2)
    expect(channel.writes[1]).toEqual(Buffer.from(encodeAgentFrame(blob)))
    transport.dispose()
  })

  it('rejects an oversized blob before writing to SSH', async () => {
    const channel = new FakeChannel()
    channel.onWrite = () => {
      if (channel.writes.length === 1) {
        queueMicrotask(() => channel.remote(packet(welcome)))
      }
    }
    const transport = await connect(channel)

    await expect(
      transport.send(
        frame(
          { direction: 'main-to-agent', kind: 'blob' },
          Buffer.alloc(AGENT_PROTOCOL_LIMITS.maximumBlobFrameBytes + 1)
        )
      )
    ).rejects.toMatchObject({ code: 'malformed' })
    expect(channel.writes).toHaveLength(1)
    transport.dispose()
  })
})
