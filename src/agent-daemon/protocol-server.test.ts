import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_PROTOCOL_LIMITS,
  AGENT_PROTOCOL_VERSION,
  daemonCapabilitiesSchema,
  daemonStatusSchema
} from '../shared/agent-protocol'
import {
  decodeAgentFrame,
  encodeAgentFrame,
  type AgentFrame
} from '../shared/agent-protocol/frame'
import { ControllerRegistry, type ControllerLease } from './controller-registry'
import { EventJournal } from './event-journal'
import { AgentProtocolServer } from './protocol-server'

const temporaryPaths: string[] = []
const closeMethod = 'channel/close'
const daemonStatus = {
  state: 'ready' as const,
  installationId: 'installation-test',
  binaryDigest: `sha256:${'a'.repeat(64)}`,
  daemonBootId: 'boot-test',
  agentVersion: '0.11.0',
  protocol: AGENT_PROTOCOL_VERSION,
  platform: 'linux' as const,
  architecture: 'x64' as const,
  supervisor: 'detached-on-demand' as const,
  remoteUserIdentity: 'uid:1000',
  draining: false
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('AgentProtocolServer connection bounds', () => {
  it('accepts a frame fragmented into single-byte socket chunks', async () => {
    const harness = createHarness()
    const frame = controlRequest(
      harness.controller,
      'fragmented',
      '1',
      1,
      'agent/status'
    )
    for (const byte of frame) {
      harness.socket.receive(Uint8Array.of(byte))
    }
    await waitFor(() => harness.socket.writes.length === 2)
    expect(
      jsonPayload(decodeAgentFrame(harness.socket.writes[0]!))
    ).toMatchObject({ result: { state: 'ready' } })
    harness.close()
  })

  it('reports a bounded category when binary dispatch fails', async () => {
    const harness = createHarness({
      onAcpFrame: async () => {
        throw Object.assign(new Error('sensitive detail'), {
          code: 'process'
        })
      }
    })
    harness.socket.receive(
      binaryFrame(
        harness.controller,
        'binding-failed',
        '1',
        1,
        'acp',
        'prompt'
      )
    )
    await waitFor(() => harness.socket.destroyCalled)
    expect(harness.failures).toEqual([
      {
        connectionId: harness.controller.connectionId,
        category: 'dispatch/process'
      }
    ])
    harness.close()
  })

  it('pauses at the item cap and dispatches frames in FIFO order', async () => {
    const gate = deferred<void>()
    const calls: string[] = []
    const harness = createHarness({
      methods: {
        'test/wait': async (_params, context) => {
          calls.push(context.channelId)
          await gate.promise
          return { done: true }
        }
      },
      incomingQueueLimits: {
        maximumItems: 2,
        maximumBytes: 4096,
        maximumBufferedBytes: 4096
      }
    })
    const frames = ['one', 'two', 'three'].map((channelId) =>
      controlRequest(harness.controller, channelId, '1', 1, 'test/wait')
    )
    harness.socket.receive(Buffer.concat(frames.map(Buffer.from)))

    expect(harness.socket.paused).toBe(true)
    expect(calls).toEqual(['one'])
    expect(harness.socket.writes).toHaveLength(0)

    gate.resolve()
    await waitFor(() => harness.socket.writes.length === 6)
    expect(calls).toEqual(['one', 'two', 'three'])
    expect(harness.socket.maximumConcurrentWrites).toBe(1)
    expect(harness.socket.paused).toBe(false)
    harness.close()
  })

  it('writes bounded blob messages directly and honors channel close', async () => {
    const harness = createHarness({ authorizeBlobFrame: () => true })
    const maximum = Buffer.alloc(
      AGENT_PROTOCOL_LIMITS.maximumBlobFrameBytes
    )

    await harness.protocol.sendBlobFrame(
      outgoingBinaryFrame(
        harness.controller,
        'blob-direct',
        '1',
        1,
        'blob',
        maximum
      )
    )
    await harness.protocol.sendBlobFrame(
      outgoingBinaryFrame(
        harness.controller,
        'blob-direct',
        '1',
        2,
        'blob',
        Buffer.of(1)
      )
    )

    expect(harness.socket.writes).toHaveLength(2)
    expect(decodeAgentFrame(harness.socket.writes[0]!).payload).toHaveLength(
      maximum.byteLength
    )
    harness.socket.receive(
      controlNotification(
        harness.controller,
        'blob-direct',
        '1',
        1,
        closeMethod,
        { channelId: 'blob-direct', channelEpoch: '1' }
      )
    )
    await waitFor(() => !harness.socket.paused)
    await expect(
      harness.protocol.sendBlobFrame(
        outgoingBinaryFrame(
          harness.controller,
          'blob-direct',
          '1',
          3,
          'blob',
          Buffer.of(2)
        )
      )
    ).rejects.toThrow(/cannot be reused/iu)
    expect(harness.socket.destroyCalled).toBe(false)
    harness.close()
  })
  it('fails closed when a peer keeps flooding past the paused byte bound', async () => {
    const gate = deferred<void>()
    const harness = createHarness({
      methods: {
        'test/wait': async () => {
          await gate.promise
          return null
        }
      },
      incomingQueueLimits: {
        maximumItems: 1,
        maximumBytes: 512,
        maximumBufferedBytes: 512
      }
    })
    harness.socket.receive(
      controlRequest(harness.controller, 'one', '1', 1, 'test/wait')
    )
    expect(harness.socket.paused).toBe(true)
    harness.socket.receive(Buffer.alloc(1024))
    await waitFor(() => harness.socket.destroyCalled)
    expect(harness.socket.writes).toHaveLength(0)
    gate.resolve()
    harness.close()
  })

  it('retires request channels after a response and rejects ID reuse', async () => {
    const harness = createHarness()
    harness.socket.receive(
      controlRequest(
        harness.controller,
        'request-1',
        '1',
        1,
        'agent/status'
      )
    )
    await waitFor(() => harness.socket.writes.length === 2)
    const response = decodeAgentFrame(harness.socket.writes[0]!)
    const close = decodeAgentFrame(harness.socket.writes[1]!)
    expect(jsonPayload(response)).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: daemonStatus
    })
    expect(jsonPayload(close)).toEqual({
      jsonrpc: '2.0',
      method: closeMethod,
      params: { channelId: 'request-1', channelEpoch: '1' }
    })

    harness.socket.receive(
      controlRequest(
        harness.controller,
        'request-1',
        '2',
        1,
        'agent/status'
      )
    )
    await waitFor(() => harness.socket.destroyCalled)
    harness.close()
  })

  it('accepts an authenticated explicit close and prevents queued follow-up work', async () => {
    const calls: string[] = []
    const harness = createHarness({
      methods: {
        'test/record': () => {
          calls.push('called')
          return null
        }
      }
    })
    const close = controlNotification(
      harness.controller,
      'stream-1',
      '7',
      1,
      closeMethod,
      { channelId: 'stream-1', channelEpoch: '7' }
    )
    const followUp = controlNotification(
      harness.controller,
      'stream-1',
      '7',
      2,
      'test/record',
      {}
    )
    harness.socket.receive(Buffer.concat([Buffer.from(close), Buffer.from(followUp)]))
    await waitFor(() => harness.socket.destroyCalled)
    expect(calls).toEqual([])
    harness.close()
  })

  it('fails closed on malformed envelopes and malformed close controls', async () => {
    const malformedHarness = createHarness()
    const malformed = Buffer.from(
      controlRequest(
        malformedHarness.controller,
        'bad-frame',
        '1',
        1,
        'agent/status'
      )
    )
    malformed[0] = 0
    malformedHarness.socket.receive(malformed)
    await waitFor(() => malformedHarness.socket.destroyCalled)
    expect(malformedHarness.socket.writes).toHaveLength(0)
    malformedHarness.close()

    const closeHarness = createHarness()
    closeHarness.socket.receive(
      controlNotification(
        closeHarness.controller,
        'bad-close',
        '1',
        1,
        closeMethod,
        { channelId: 'another-channel', channelEpoch: '1' }
      )
    )
    await waitFor(() => closeHarness.socket.destroyCalled)
    expect(closeHarness.socket.writes).toHaveLength(0)
    closeHarness.close()
  })

  it('preserves stable typed service error codes', async () => {
    const harness = createHarness({
      methods: {
        'test/typed-error': () => {
          throw Object.assign(new Error('Read-only service'), {
            code: 'read-only'
          })
        }
      }
    })
    harness.socket.receive(
      controlRequest(
        harness.controller,
        'typed-error',
        '1',
        1,
        'test/typed-error'
      )
    )
    await waitFor(() => harness.socket.writes.length === 2)
    expect(jsonPayload(decodeAgentFrame(harness.socket.writes[0]!))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32000,
        message: 'Read-only service',
        data: { code: 'read-only' }
      }
    })
    harness.close()
  })

  it('returns strict status, doctor, and exact implemented capabilities', async () => {
    const methods = Object.fromEntries(
      [
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
      ].map((method) => [method, () => null])
    )
    const harness = createHarness({ methods })
    for (const [index, method] of [
      'agent/status',
      'agent/doctor',
      'agent/capabilities'
    ].entries()) {
      harness.socket.receive(
        controlRequest(
          harness.controller,
          `strict-${index}`,
          '1',
          index + 1,
          method
        )
      )
      await waitFor(() => harness.socket.writes.length === (index + 1) * 2)
      const response = decodeAgentFrame(
        harness.socket.writes[index * 2]!
      )
      const result = (
        jsonPayload(response) as { result: unknown }
      ).result
      if (method === 'agent/capabilities') {
        expect(daemonCapabilitiesSchema.parse(result)).toEqual({
          generation: harness.controller.capabilityGeneration,
          capabilities: [
            { name: 'agent/control', version: 1, critical: true },
            { name: 'workspace/read', version: 1, critical: true }
          ],
          runtimes: []
        })
      } else {
        expect(daemonStatusSchema.parse(result)).toEqual(daemonStatus)
      }
    }
    harness.close()
  })

  it('does not advertise workspace writes, runtime, ACP, or partial reads', async () => {
    const harness = createHarness({
      methods: {
        'workspace/readText': () => null,
        'workspace/writeTextAtomic': () => null,
        'runtime/openAcpChannel': () => null,
        'runtime/closeAcpChannel': () => null
      }
    })
    harness.socket.receive(
      controlRequest(
        harness.controller,
        'capabilities',
        '1',
        1,
        'agent/capabilities'
      )
    )
    await waitFor(() => harness.socket.writes.length === 2)
    const result = (
      jsonPayload(
        decodeAgentFrame(harness.socket.writes[0]!)
      ) as { result: unknown }
    ).result
    expect(daemonCapabilitiesSchema.parse(result)).toEqual({
      generation: harness.controller.capabilityGeneration,
      capabilities: [
        { name: 'agent/control', version: 1, critical: true }
      ],
      runtimes: []
    })
    harness.close()
  })

  it('advertises only a verified Runtime with ACP control and data handlers', async () => {
    const runtime = {
      runtimeId: 'opencode',
      version: '1.18.9',
      bundleDigest: `sha256:${'b'.repeat(64)}`,
      acpCapabilitiesDigest: `sha256:${'c'.repeat(64)}`,
      sessionLoad: false,
      sessionResume: false
    }
    const harness = createHarness({
      methods: {
        'runtime/openAcpChannel': () => null,
        'runtime/closeAcpChannel': () => null,
        'runtime/resumeAcpChannel': () => null,
        'runtime/replayAcpChannel': () => null,
        'runtime/preparePrompt': () => null,
        'runtime/completePrompt': () => null,
        'runtime/getAcpCursors': () => null,
        'runtime/escalateCancellation': () => null,
        'runtime/reconcilePrompt': () => null
      },
      onAcpFrame: async () => {},
      runtimes: async () => [runtime]
    })
    harness.socket.receive(
      controlRequest(
        harness.controller,
        'runtime-capabilities',
        '1',
        1,
        'agent/capabilities'
      )
    )
    await waitFor(() => harness.socket.writes.length === 2)
    const result = (
      jsonPayload(
        decodeAgentFrame(harness.socket.writes[0]!)
      ) as { result: unknown }
    ).result
    expect(daemonCapabilitiesSchema.parse(result)).toEqual({
      generation: harness.controller.capabilityGeneration,
      capabilities: [
        { name: 'agent/control', version: 1, critical: true },
        { name: 'runtime/acp', version: 3, critical: true }
      ],
      runtimes: [runtime]
    })
    harness.close()
  })

  it('advertises the critical model bridge only with blob composition', async () => {
    const runtime = {
      runtimeId: 'opencode',
      version: '1.18.9',
      bundleDigest: `sha256:${'b'.repeat(64)}`,
      acpCapabilitiesDigest: `sha256:${'c'.repeat(64)}`,
      sessionLoad: false,
      sessionResume: false
    }
    const methods = Object.fromEntries(
      [
        'runtime/openAcpChannel',
        'runtime/closeAcpChannel',
        'runtime/resumeAcpChannel',
        'runtime/replayAcpChannel',
        'runtime/preparePrompt',
        'runtime/completePrompt',
        'runtime/getAcpCursors',
        'runtime/escalateCancellation',
        'runtime/reconcilePrompt'
      ].map((method) => [method, () => null])
    )
    const harness = createHarness({
      methods,
      onAcpFrame: async () => {},
      onBlobFrame: async () => {},
      authorizeBlobFrame: () => true,
      runtimes: async () => [runtime]
    })
    harness.socket.receive(
      controlRequest(
        harness.controller,
        'bridge-capabilities',
        '1',
        1,
        'agent/capabilities'
      )
    )
    await waitFor(() => harness.socket.writes.length === 2)
    const result = (
      jsonPayload(
        decodeAgentFrame(harness.socket.writes[0]!)
      ) as { result: unknown }
    ).result
    expect(daemonCapabilitiesSchema.parse(result)).toMatchObject({
      capabilities: [
        { name: 'agent/control', version: 1, critical: true },
        { name: 'runtime/acp', version: 3, critical: true },
        {
          name: 'runtime/model-bridge',
          version: 1,
          critical: true
        }
      ]
    })
    harness.close()
  })

  it('locks channel kinds and rejects ACP/blob cross-injection', async () => {
    let handled = false
    const harness = createHarness({
      onBlobFrame: async () => {},
      methods: {
        'test/notify': async () => {
          handled = true
        }
      }
    })
    harness.socket.receive(
      controlNotification(
        harness.controller,
        'locked-channel',
        '5',
        1,
        'test/notify',
        {}
      )
    )
    await waitFor(() => handled)
    harness.socket.receive(
      binaryFrame(
        harness.controller,
        'locked-channel',
        '5',
        2,
        'blob',
        'injected'
      )
    )
    await waitFor(() => harness.socket.destroyCalled)
    harness.close()
  })

  it('rejects Agent-first blob output without exact prompt authority', async () => {
    const harness = createHarness({
      onBlobFrame: async () => {}
    })
    const payload = Buffer.from('request')
    await expect(
      harness.protocol.sendBlobFrame({
        header: {
          protocolMajor: AGENT_PROTOCOL_VERSION.major,
          protocolMinor: AGENT_PROTOCOL_VERSION.minor,
          connectionId: harness.controller.connectionId,
          generation: harness.controller.generation,
          channelId: 'unknown-blob-output',
          channelEpoch: '3',
          direction: 'agent-to-main',
          sequence: '1',
          kind: 'blob',
          payloadLength: payload.byteLength
        },
        payload
      })
    ).rejects.toThrow(/active prompt authority/iu)
    expect(harness.socket.writes).toHaveLength(0)
    harness.close()
  })

  it('routes bounded blob frames without adding them to ACP journals', async () => {
    const received: AgentFrame[] = []
    const harness = createHarness({
      onBlobFrame: async (frame) => {
        received.push(frame)
      }
    })
    harness.socket.receive(
      binaryFrame(
        harness.controller,
        'blob-channel',
        '11',
        1,
        'blob',
        'chunk'
      )
    )
    await waitFor(() => received.length === 1)
    expect(received).toHaveLength(1)
    expect(harness.socket.writes).toHaveLength(0)
    expect(harness.socket.destroyCalled).toBe(false)
    harness.close()
  })

  it('rejects non-empty status and capability params', async () => {
    const harness = createHarness()
    harness.socket.receive(
      controlFrame(harness.controller, 'bad-params', '1', 1, {
        jsonrpc: '2.0',
        id: 1,
        method: 'agent/status',
        params: { unexpected: true }
      })
    )
    await waitFor(() => harness.socket.writes.length === 2)
    expect(
      jsonPayload(decodeAgentFrame(harness.socket.writes[0]!))
    ).toMatchObject({
      error: { code: -32602, message: 'Method params must be an empty object' }
    })
    harness.close()
  })

  it('resumes with the current connection and capability generations', async () => {
    const harness = createHarness({ reconnect: true })
    const previous = harness.previousController!
    harness.socket.receive(
      controlFrame(harness.controller, 'resume', '1', 1, {
        jsonrpc: '2.0',
        id: 1,
        method: 'controller/resume',
        params: {
          previousGeneration: previous.generation,
          previousConnectionId: previous.connectionId,
          daemonBootId: daemonStatus.daemonBootId,
          capabilityGeneration: previous.capabilityGeneration
        }
      })
    )
    await waitFor(() => harness.socket.writes.length === 2)
    const result = (
      jsonPayload(
        decodeAgentFrame(harness.socket.writes[0]!)
      ) as { result: Record<string, unknown> }
    ).result
    expect(result).toMatchObject({
      resumed: true,
      generation: harness.controller.generation,
      daemonBootId: daemonStatus.daemonBootId,
      capabilityGeneration:
        harness.controller.capabilityGeneration
    })
    expect(result.leaseDeadlineAt).toEqual(expect.any(String))
    harness.close()
  })

  it('marks method context only after exact controller takeover', async () => {
    const takeoverStates: Array<boolean | undefined> = []
    const harness = createHarness({
      reconnect: true,
      methods: {
        'runtime/openAcpChannel': (_params, context) => {
          takeoverStates.push(context.controllerTakeoverProven)
          return null
        }
      }
    })
    const previous = harness.previousController!
    harness.socket.receive(
      controlFrame(harness.controller, 'before-resume', '1', 1, {
        jsonrpc: '2.0',
        id: 1,
        method: 'runtime/openAcpChannel',
        params: {}
      })
    )
    await waitFor(() => harness.socket.writes.length === 2)
    harness.socket.receive(
      controlFrame(harness.controller, 'resume', '1', 1, {
        jsonrpc: '2.0',
        id: 2,
        method: 'controller/resume',
        params: {
          previousGeneration: previous.generation,
          previousConnectionId: previous.connectionId,
          daemonBootId: daemonStatus.daemonBootId,
          capabilityGeneration: previous.capabilityGeneration
        }
      })
    )
    await waitFor(() => harness.socket.writes.length === 4)
    harness.socket.receive(
      controlFrame(harness.controller, 'after-resume', '1', 1, {
        jsonrpc: '2.0',
        id: 3,
        method: 'runtime/openAcpChannel',
        params: {}
      })
    )
    await waitFor(() => harness.socket.writes.length === 6)

    expect(takeoverStates).toEqual([false, true])
    harness.close()
  })

  it.each([
    ['previous connection', { previousConnectionId: 'connection-wrong' }],
    ['capability generation', { capabilityGeneration: 2 }],
    ['daemon boot', { daemonBootId: 'boot-wrong' }]
  ])('rejects takeover with mismatched %s', async (_label, override) => {
    const harness = createHarness({ reconnect: true })
    const previous = harness.previousController!
    harness.socket.receive(
      controlFrame(harness.controller, 'resume-mismatch', '1', 1, {
        jsonrpc: '2.0',
        id: 1,
        method: 'controller/resume',
        params: {
          previousGeneration: previous.generation,
          previousConnectionId: previous.connectionId,
          daemonBootId: daemonStatus.daemonBootId,
          capabilityGeneration: previous.capabilityGeneration,
          ...override
        }
      })
    )
    await waitFor(() => harness.socket.writes.length === 2)
    expect(
      (
        jsonPayload(
          decodeAgentFrame(harness.socket.writes[0]!)
        ) as { result: { resumed: boolean } }
      ).result.resumed
    ).toBe(false)
    harness.close()
  })
})

class FakeSocket extends EventEmitter {
  writes: Buffer[] = []
  paused = false
  destroyCalled = false
  maximumConcurrentWrites = 0
  #concurrentWrites = 0

  pause(): this {
    this.paused = true
    return this
  }

  resume(): this {
    this.paused = false
    return this
  }

  write(
    data: Uint8Array,
    callback?: (error?: Error | null) => void
  ): boolean {
    this.#concurrentWrites += 1
    this.maximumConcurrentWrites = Math.max(
      this.maximumConcurrentWrites,
      this.#concurrentWrites
    )
    this.writes.push(Buffer.from(data))
    queueMicrotask(() => {
      this.#concurrentWrites -= 1
      callback?.()
    })
    return true
  }

  destroy(): this {
    if (!this.destroyCalled) {
      this.destroyCalled = true
      queueMicrotask(() => this.emit('close'))
    }
    return this
  }

  receive(data: Uint8Array): void {
    this.emit('data', Buffer.from(data))
  }
}

type Harness = {
  socket: FakeSocket
  protocol: AgentProtocolServer
  controller: ControllerLease
  previousController?: ControllerLease
  failures: Array<{
    connectionId: string
    category: string
  }>
  close: () => void
}

function createHarness(
  options: {
    methods?: ConstructorParameters<typeof AgentProtocolServer>[0]['methods']
    incomingQueueLimits?: ConstructorParameters<
      typeof AgentProtocolServer
    >[0]['incomingQueueLimits']
    runtimes?: ConstructorParameters<
      typeof AgentProtocolServer
    >[0]['runtimes']
    onAcpFrame?: ConstructorParameters<
      typeof AgentProtocolServer
    >[0]['onAcpFrame']
    onBlobFrame?: ConstructorParameters<
      typeof AgentProtocolServer
    >[0]['onBlobFrame']
    authorizeBlobFrame?: ConstructorParameters<
      typeof AgentProtocolServer
    >[0]['authorizeBlobFrame']
    reconnect?: boolean
  } = {}
): Harness {
  const root = temporaryDirectory()
  const controllers = new ControllerRegistry()
  const previousController = options.reconnect
    ? controllers.attach('controller-test')
    : undefined
  if (previousController !== undefined) {
    controllers.disconnect(
      previousController.controllerId,
      previousController.generation
    )
  }
  const controller = controllers.attach('controller-test')
  const events = new EventJournal(resolve(root, 'events.sqlite'))
  const failures: Harness['failures'] = []
  const protocol = new AgentProtocolServer({
    controllers,
    events,
    status: () => daemonStatus,
    runtimes: options.runtimes,
    methods: options.methods,
    onAcpFrame: options.onAcpFrame,
    onBlobFrame: options.onBlobFrame,
    authorizeBlobFrame: options.authorizeBlobFrame,
    onProtocolFailure: (failure) => {
      failures.push(failure)
    },
    incomingQueueLimits: options.incomingQueueLimits
  })
  const socket = new FakeSocket()
  protocol.accept(socket as unknown as Socket, controller)
  return {
    socket,
    protocol,
    controller,
    failures,
    ...(previousController === undefined ? {} : { previousController }),
    close: () => {
      socket.destroy()
      events.close()
    }
  }
}

function binaryFrame(
  controller: ControllerLease,
  channelId: string,
  channelEpoch: string,
  sequence: number,
  kind: 'acp' | 'blob',
  value: string
): Uint8Array {
  const payload = Buffer.from(value)
  return encodeAgentFrame({
    header: {
      protocolMajor: AGENT_PROTOCOL_VERSION.major,
      protocolMinor: AGENT_PROTOCOL_VERSION.minor,
      connectionId: controller.connectionId,
      generation: controller.generation,
      channelId,
      channelEpoch,
      direction: 'main-to-agent',
      sequence: String(sequence),
      kind,
      payloadLength: payload.byteLength
    },
    payload
  })
}

function outgoingBinaryFrame(
  controller: ControllerLease,
  channelId: string,
  channelEpoch: string,
  sequence: number,
  kind: 'acp' | 'blob',
  payload: Uint8Array
): AgentFrame {
  return {
    header: {
      protocolMajor: AGENT_PROTOCOL_VERSION.major,
      protocolMinor: AGENT_PROTOCOL_VERSION.minor,
      connectionId: controller.connectionId,
      generation: controller.generation,
      channelId,
      channelEpoch,
      direction: 'agent-to-main',
      sequence: String(sequence),
      kind,
      payloadLength: payload.byteLength
    },
    payload
  }
}

function controlRequest(
  controller: ControllerLease,
  channelId: string,
  channelEpoch: string,
  id: number,
  method: string
): Uint8Array {
  return controlFrame(controller, channelId, channelEpoch, 1, {
    jsonrpc: '2.0',
    id,
    method,
    params: {}
  })
}

function controlNotification(
  controller: ControllerLease,
  channelId: string,
  channelEpoch: string,
  sequence: number,
  method: string,
  params: Record<string, unknown>
): Uint8Array {
  return controlFrame(controller, channelId, channelEpoch, sequence, {
    jsonrpc: '2.0',
    method,
    params
  })
}

function controlFrame(
  controller: ControllerLease,
  channelId: string,
  channelEpoch: string,
  sequence: number,
  value: Record<string, unknown>
): Uint8Array {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  return encodeAgentFrame({
    header: {
      protocolMajor: AGENT_PROTOCOL_VERSION.major,
      protocolMinor: AGENT_PROTOCOL_VERSION.minor,
      connectionId: controller.connectionId,
      generation: controller.generation,
      channelId,
      channelEpoch,
      direction: 'main-to-agent',
      sequence: sequence.toString(),
      kind: 'control',
      payloadLength: payload.byteLength
    },
    payload
  })
}

function jsonPayload(frame: AgentFrame): unknown {
  return JSON.parse(Buffer.from(frame.payload).toString('utf8'))
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for protocol state')
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 1))
  }
}

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'goodbuddy-protocol-'))
  temporaryPaths.push(path)
  if (process.platform !== 'win32') {
    chmodSync(path, 0o700)
  }
  return path
}
