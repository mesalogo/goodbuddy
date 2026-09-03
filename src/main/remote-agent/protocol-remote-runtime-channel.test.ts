import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROTOCOL_LIMITS,
  ChannelProtocolError,
  type DaemonCapabilities
} from '../../shared/agent-protocol'
import {
  createModelBridgeRequestMessage,
  encodeModelBridgeMessage
} from '../../shared/model-bridge-contracts'
import type { RemoteAgentConnection } from './remote-agent-connection-manager'
import {
  AgentProtocolClientError,
  AgentRpcError
} from './agent-protocol-client'
import { AgentAttachTransportError } from './agent-attach-transport'
import {
  ProtocolRemoteRuntimeChannelError,
  createProtocolRemoteRuntimeChannel,
  type RuntimeProtocolBinaryChannel,
  type RuntimeProtocolBinaryFrame,
  type RuntimeProtocolClient,
  type RuntimeProtocolConnection,
  type RuntimeProtocolMethod,
  type RuntimeProtocolParams,
  type RuntimeProtocolRequestOptions,
  type RuntimeProtocolResult
} from './protocol-remote-runtime-channel'

const runtimeBundleDigest = digest('a')
const acpCapabilitiesDigest = digest('b')

type RecordedRequest = {
  method: RuntimeProtocolMethod
  params: unknown
  options?: RuntimeProtocolRequestOptions
}

class FakeBinaryChannel implements RuntimeProtocolBinaryChannel {
  readonly channelId: string
  readonly channelEpoch: string
  readonly sent: Uint8Array[] = []
  consumed = 0
  closed = false
  sendGate?: Promise<void>
  onConsume?: () => void
  #frames: RuntimeProtocolBinaryFrame[] = []
  #receivers: Array<{
    resolve: (frame: RuntimeProtocolBinaryFrame) => void
    reject: (error: unknown) => void
    signal?: AbortSignal
    abort?: () => void
  }> = []
  #closeListeners = new Set<(error?: unknown) => void>()

  constructor(channelId: string, channelEpoch: string) {
    this.channelId = channelId
    this.channelEpoch = channelEpoch
  }

  async send(payload: Uint8Array, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    await this.sendGate
    signal?.throwIfAborted()
    this.sent.push(new Uint8Array(payload))
  }

  receive(signal?: AbortSignal): Promise<RuntimeProtocolBinaryFrame> {
    signal?.throwIfAborted()
    const frame = this.#frames.shift()
    if (frame !== undefined) {
      return Promise.resolve(frame)
    }
    return new Promise((resolve, reject) => {
      const receiver = { resolve, reject, signal }
      if (signal !== undefined) {
        const abort = (): void => {
          const index = this.#receivers.indexOf(receiver)
          if (index >= 0) {
            this.#receivers.splice(index, 1)
          }
          reject(signal.reason)
        }
        Object.assign(receiver, { abort })
        signal.addEventListener('abort', abort, { once: true })
      }
      this.#receivers.push(receiver)
    })
  }

  push(payload: Uint8Array, sequence = '1'): void {
    let consumed = false
    const frame: RuntimeProtocolBinaryFrame = {
      payload: new Uint8Array(payload),
      sequence,
      consume: async () => {
        if (!consumed) {
          consumed = true
          this.consumed += 1
          this.onConsume?.()
        }
      }
    }
    const receiver = this.#receivers.shift()
    if (receiver === undefined) {
      this.#frames.push(frame)
      return
    }
    if (receiver.abort !== undefined) {
      receiver.signal?.removeEventListener('abort', receiver.abort)
    }
    receiver.resolve(frame)
  }

  close(error?: unknown): void {
    if (this.closed) {
      return
    }
    this.closed = true
    for (const receiver of this.#receivers.splice(0)) {
      if (receiver.abort !== undefined) {
        receiver.signal?.removeEventListener('abort', receiver.abort)
      }
      receiver.reject(new Error('binary closed'))
    }
    for (const listener of this.#closeListeners) {
      listener(error)
    }
  }

  async closeWithNotification(): Promise<void> {
    this.close()
  }

  onClose(listener: (error?: unknown) => void): () => void {
    this.#closeListeners.add(listener)
    return () => this.#closeListeners.delete(listener)
  }
}

class FakeRuntimeClient implements RuntimeProtocolClient {
  generation: number
  readonly requests: RecordedRequest[] = []
  readonly events: string[] = []
  readonly registrations: Array<{
    channelId: string
    channelEpoch: string
    kind: 'acp'
    nextInboundSequence?: string
    nextOutboundSequence?: string
  }> = []
  binary = new FakeBinaryChannel('binding-1', '9')
  readonly blobBinaries: FakeBinaryChannel[] = []
  responder: (
    method: RuntimeProtocolMethod,
    params: unknown
  ) => unknown | Promise<unknown> = defaultResponse
  #closeListeners = new Set<(error?: unknown) => void>()

  constructor(generation = 7) {
    this.generation = generation
  }

  async request<M extends RuntimeProtocolMethod>(
    method: M,
    params: RuntimeProtocolParams<M>,
    options?: RuntimeProtocolRequestOptions
  ): Promise<RuntimeProtocolResult<M>> {
    options?.signal?.throwIfAborted()
    this.events.push(`request:${method}`)
    this.requests.push({ method, params, options })
    return (await this.responder(method, params)) as RuntimeProtocolResult<M>
  }

  registerBinaryChannel(input: {
    channelId: string
    channelEpoch: string
    kind: 'acp'
    nextInboundSequence?: string
    nextOutboundSequence?: string
  }): RuntimeProtocolBinaryChannel {
    this.events.push('register')
    this.registrations.push(input)
    expect(input.kind).toBe('acp')
    this.binary = new FakeBinaryChannel(
      input.channelId,
      input.channelEpoch
    )
    return this.binary
  }

  allocateBinaryChannel(input: {
    kind: 'blob'
  }): RuntimeProtocolBinaryChannel {
    expect(input.kind).toBe('blob')
    const binary = new FakeBinaryChannel(
      `model-${this.blobBinaries.length + 1}`,
      String(100 + this.blobBinaries.length)
    )
    this.blobBinaries.push(binary)
    return binary
  }

  onClose(listener: (error?: unknown) => void): () => void {
    this.#closeListeners.add(listener)
    return () => this.#closeListeners.delete(listener)
  }

  transportClose(error?: unknown): void {
    this.binary.close(error)
    for (const listener of this.#closeListeners) {
      listener(error)
    }
  }
}

type ConnectionFixture = {
  connection: RuntimeProtocolConnection
  client: FakeRuntimeClient
  setReconnectClient(client: FakeRuntimeClient): void
  setState(state: RemoteAgentConnection['state']): void
  setCapabilityGeneration(generation: number): void
  setCapabilities(capabilities: DaemonCapabilities): void
  connectionClose(): void
  release: ReturnType<typeof vi.fn>
}

function connectionFixture(): ConnectionFixture {
  const client = new FakeRuntimeClient()
  let currentClient = client
  let reconnectClient: FakeRuntimeClient | undefined
  let state: RemoteAgentConnection['state'] = 'ready'
  let capabilities = validCapabilities()
  const release = vi.fn()
  const closeListeners = new Set<() => void>()
  const connection = {
    identity: {
      cacheKey: 'host-1:agent-1',
      hostId: 'host-1',
      hostRevision: 1,
      hostKeyGeneration: 1,
      remoteUsername: 'user',
      installationId: 'agent-1',
      binaryDigest: digest('c'),
      protocolMajor: 1,
      protocolMinor: 0
    },
    status: {
      state: 'ready',
      installationId: 'agent-1',
      binaryDigest: digest('c'),
      daemonBootId: 'boot-1',
      agentVersion: '1.0.0',
      protocol: { major: 1, minor: 0 },
      platform: 'linux',
      architecture: 'x64',
      supervisor: 'detached-on-demand',
      remoteUserIdentity: 'user-1',
      draining: false
    },
    get capabilities() {
      return capabilities
    },
    get state() {
      return state
    },
    get client() {
      return currentClient
    },
    reconnect: vi.fn(async (signal?: AbortSignal) => {
      signal?.throwIfAborted()
      if (reconnectClient === undefined) {
        throw new Error('no reconnect client')
      }
      currentClient = reconnectClient
      state = 'ready'
      for (const listener of clientChangeListeners) {
        listener()
      }
    }),
    onClientChange(listener: () => void) {
      clientChangeListeners.add(listener)
      return () => clientChangeListeners.delete(listener)
    },
    updateAcpBinding: vi.fn(async () => undefined),
    flushAcpBindings: vi.fn(async () => undefined),
    onClose(listener: () => void) {
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
    release
  } satisfies RuntimeProtocolConnection
  const clientChangeListeners = new Set<() => void>()
  return {
    connection,
    client,
    setReconnectClient(next) {
      reconnectClient = next
    },
    setState(next) {
      state = next
    },
    setCapabilityGeneration(generation) {
      capabilities = { ...capabilities, generation }
    },
    setCapabilities(next) {
      capabilities = next
    },
    connectionClose() {
      state = 'offline'
      for (const listener of closeListeners) {
        listener()
      }
    },
    release
  }
}

function validCapabilities(): DaemonCapabilities {
  return {
    generation: 11,
    capabilities: [
      { name: 'runtime/acp', version: 5, critical: true }
    ],
    runtimes: [
      {
        runtimeId: 'opencode',
        version: '1.0.0',
        bundleDigest: runtimeBundleDigest,
        acpCapabilitiesDigest,
        sessionLoad: true,
        sessionResume: true
      }
    ]
  }
}

function modelBridgeCapabilities(): DaemonCapabilities {
  const capabilities = validCapabilities()
  return {
    ...capabilities,
    capabilities: [
      ...capabilities.capabilities,
      {
        name: 'runtime/model-bridge',
        version: 1,
        critical: true
      }
    ]
  }
}

function openIdentity() {
  return {
    bindingId: 'binding-1',
    runtimeId: 'opencode',
    runtimeBundleDigest,
    workspaceIdentity: 'workspace-1'
  }
}

function defaultResponse(
  method: RuntimeProtocolMethod,
  params: unknown
): unknown {
  if (method === 'runtime/openAcpChannel') {
    return {
      bindingId: 'binding-1',
      channelId: 'binding-1',
      channelEpoch: '9',
      acpCapabilitiesDigest
    }
  }
  if (method === 'runtime/closeAcpChannel') {
    return {
      bindingId: 'binding-1',
      channelEpoch: '9',
      closed: true
    }
  }
  if (method === 'runtime/getAcpCursors') {
    return {
      lastOutboundJournaledSequence: '2',
      lastOutboundDeliveredSequence: '1',
      lastInboundJournaledSequence: '4',
      lastMainAckSequence: '3'
    }
  }
  if (method === 'runtime/escalateCancellation') {
    return {
      bindingId: 'binding-1',
      stopped: true
    }
  }
  if (method === 'runtime/completePrompt') {
    return {
      ...(params as Record<string, unknown>),
      status: 'completed',
      processTree: 'running'
    }
  }
  if (method === 'runtime/reconcilePrompt') {
    return {
      status: 'terminal',
      terminalState: 'completed',
      processTree: 'empty'
    }
  }
  if ((method as string) === 'runtime/startPrompt') {
    const identity = params as {
      bindingId: string
      operationId: string
      requestId: string
    }
    return {
      bindingId: identity.bindingId,
      operationId: identity.operationId,
      requestId: identity.requestId,
      sessionId: 'session-owned-1',
      state: 'running',
      latestSemanticSequence: '0'
    }
  }
  if ((method as string) === 'runtime/attachPrompt') {
    return {
      ...(params as Record<string, unknown>),
      sessionId: 'session-owned-1',
      state: 'running',
      latestSemanticSequence: '1'
    }
  }
  if ((method as string) === 'runtime/pagePromptTranscript') {
    return {
      bindingId: 'binding-1',
      operationId: 'operation-1',
      events: [],
      latestSequence: '1',
      acknowledgedSequence: '0',
      state: 'running',
      sessionId: 'session-owned-1',
      hasMore: false
    }
  }
  if ((method as string) === 'runtime/ackPromptTranscript') {
    return params
  }
  return params
}

function promptRecoveryResponse(
  method: RuntimeProtocolMethod,
  params: unknown,
  deadlineAt: string
): unknown {
  if (method === 'runtime/resumeAcpChannel') {
    return {
      bindingId: 'binding-1',
      channelId: 'binding-1',
      channelEpoch: '9',
      deadlineAt,
      cursors: {
        lastOutboundJournaledSequence: '0',
        lastOutboundDeliveredSequence: '0',
        lastInboundJournaledSequence: '0',
        lastMainAckSequence: '0'
      }
    }
  }
  if (method === 'runtime/replayAcpChannel') {
    return {
      bindingId: 'binding-1',
      channelId: 'binding-1',
      channelEpoch: '9',
      replayedThroughSequence: '0',
      live: true
    }
  }
  return defaultResponse(method, params)
}

async function openChannel(fixture = connectionFixture()) {
  const channel = await createProtocolRemoteRuntimeChannel({
    connection: fixture.connection,
    openIdentity: openIdentity(),
    releaseConnectionOnClose: true,
    controlTimeoutMs: 1_000
  })
  return { ...fixture, channel }
}

describe('ProtocolRemoteRuntimeChannel', () => {
  it('maps the complete Agent-owned prompt RPC set', async () => {
    const fixture = await openChannel()
    const identity = {
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1'
    }

    await expect(
      fixture.channel.startOwnedPrompt({
        ...identity,
        prompt: [{ type: 'text', text: 'hello' }]
      })
    ).resolves.toMatchObject({
      sessionId: 'session-owned-1',
      state: 'running'
    })
    await expect(
      fixture.channel.attachOwnedPrompt(identity)
    ).resolves.toMatchObject({
      latestSemanticSequence: '1'
    })
    await expect(
      fixture.channel.pageOwnedPromptTranscript({
        bindingId: identity.bindingId,
        operationId: identity.operationId,
        afterSequence: '0',
        limit: 10
      })
    ).resolves.toMatchObject({
      latestSequence: '1',
      state: 'running'
    })
    await expect(
      fixture.channel.ackOwnedPromptTranscript({
        bindingId: identity.bindingId,
        operationId: identity.operationId,
        acknowledgedSequence: '1'
      })
    ).resolves.toMatchObject({
      acknowledgedSequence: '1'
    })
    expect(
      fixture.client.requests.map((request) => request.method as string)
    ).toEqual(expect.arrayContaining([
      'runtime/startPrompt',
      'runtime/attachPrompt',
      'runtime/pagePromptTranscript',
      'runtime/ackPromptTranscript'
    ]))
    await fixture.channel.close()
  })

  it('attaches the exact operation when a prompt start response is lost', async () => {
    const fixture = await openChannel()
    const deadlineAt = new Date(Date.now() + 10_000).toISOString()
    fixture.channel.setRecoveryBoundary(
      deadlineAt,
      new AbortController().signal
    )
    const resumed = new FakeRuntimeClient(8)
    resumed.responder = (method, params) =>
      promptRecoveryResponse(method, params, deadlineAt)
    fixture.setReconnectClient(resumed)
    let starts = 0
    fixture.client.responder = async (method, params) => {
      if (method === 'runtime/startPrompt' && starts++ === 0) {
        throw new Error('start response lost')
      }
      return defaultResponse(method, params)
    }

    await expect(
      fixture.channel.startOwnedPrompt({
        bindingId: 'binding-1',
        operationId: 'operation-1',
        requestId: 'operation-1',
        prompt: [{ type: 'text', text: 'hello' }]
      })
    ).resolves.toMatchObject({
      operationId: 'operation-1',
      sessionId: 'session-owned-1'
    })
    expect(
      resumed.requests.map((request) => request.method)
    ).toContain('runtime/attachPrompt')
    expect(
      resumed.requests.find(
        (request) => request.method === 'runtime/attachPrompt'
      )?.params
    ).toEqual({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1'
    })
    await fixture.channel.close()
  })

  it('reissues one identical start after attach proves the first was not accepted', async () => {
    const fixture = await openChannel()
    const deadlineAt = new Date(Date.now() + 10_000).toISOString()
    fixture.channel.setRecoveryBoundary(
      deadlineAt,
      new AbortController().signal
    )
    const resumed = new FakeRuntimeClient(8)
    fixture.setReconnectClient(resumed)
    let starts = 0
    fixture.client.responder = async (method, params) => {
      if (method === 'runtime/startPrompt' && starts++ === 0) {
        throw new Error('start request not delivered')
      }
      return promptRecoveryResponse(method, params, deadlineAt)
    }
    resumed.responder = async (method, params) => {
      if (method === 'runtime/attachPrompt') {
        throw new AgentRpcError(-32009, 'missing prompt', {
          code: 'not-found'
        })
      }
      return promptRecoveryResponse(method, params, deadlineAt)
    }
    const start = {
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1',
      prompt: [{ type: 'text' as const, text: 'hello' }]
    }

    await expect(
      fixture.channel.startOwnedPrompt(start)
    ).resolves.toMatchObject({
      operationId: 'operation-1',
      sessionId: 'session-owned-1'
    })
    const promptStarts = [
      ...fixture.client.requests,
      ...resumed.requests
    ].filter((request) => request.method === 'runtime/startPrompt')
    expect(promptStarts).toHaveLength(2)
    expect(promptStarts[0]?.params).toEqual(start)
    expect(promptStarts[1]?.params).toEqual(start)
    await fixture.channel.close()
  })

  it('preserves autonomous RPC rejection identity for recovery decisions', async () => {
    const fixture = await openChannel()
    fixture.client.responder = async (method, params) => {
      if (method === 'runtime/attachPrompt') {
        throw new AgentRpcError(-32009, 'missing prompt', {
          code: 'not-found'
        })
      }
      return defaultResponse(method, params)
    }

    await expect(
      fixture.channel.attachOwnedPrompt({
        bindingId: 'binding-1',
        operationId: 'operation-1',
        requestId: 'operation-1'
      })
    ).rejects.toMatchObject({
      reason: 'remote',
      remoteMethod: 'runtime/attachPrompt',
      remoteServiceCode: 'not-found',
      remoteRequestOutcome: 'rejected'
    })
    await fixture.channel.close()
  })

  it('opens before registering binary and streams bytes in both directions', async () => {
    const fixture = await openChannel()
    expect(fixture.client.events.slice(0, 2)).toEqual([
      'request:runtime/openAcpChannel',
      'register'
    ])

    fixture.client.binary.push(Buffer.from('runtime output'))
    const reader = fixture.channel.input.getReader()
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: new Uint8Array(Buffer.from('runtime output'))
    })
    await vi.waitFor(() =>
      expect(fixture.client.binary.consumed).toBe(1)
    )

    const writer = fixture.channel.output.getWriter()
    await writer.write(Buffer.from('runtime input'))
    expect(fixture.client.binary.sent).toEqual([
      new Uint8Array(Buffer.from('runtime input'))
    ])
    await fixture.channel.close()
  })

  it('reports the rejected Runtime method and bounded RPC category', async () => {
    const fixture = await openChannel()
    fixture.client.responder = (method, params) => {
      if (method === 'runtime/preparePrompt') {
        throw new AgentRpcError(
          -32000,
          'private remote detail',
          {
            code: 'process',
            privateValue: 'must-not-escape'
          }
        )
      }
      return defaultResponse(method, params)
    }
    const error = await fixture.channel
      .preparePrompt({
        bindingId: 'binding-1',
        operationId: 'operation-1',
        requestId: 'operation-1',
        workMode: 'execute',
        controllerId: 'controller-1',
        controllerGeneration: 1,
        connectionGeneration: fixture.channel.generation,
        channelEpoch: fixture.channel.channelEpoch,
        hostId: 'host-1',
        hostRevision: 1,
        hostKeyGeneration: 1,
        workspaceIdentity: 'workspace-1',
        agentInstallationId: 'agent-1',
        runtimeId: 'opencode',
        runtimeBundleDigest,
        runtimeAdapterDigest: digest('d'),
        modelProfile: {
          profileId: 'profile-1',
          modelProfileDigest: digest('e'),
          provider: 'openai',
          baseUrl: 'https://provider.example/v1',
          model: 'test-model',
          protocol: 'openai-responses',
          authentication: 'none',
          capabilities: { imageInput: false },
          limits: {
            maximumOutputTokens: 4_096,
            requestTimeoutMilliseconds: 60_000
          }
        },
        promptSequence: 0,
        deadlineAt: new Date(Date.now() + 10_000).toISOString(),
        budget: {
          maximumInputBytes: 1_024,
          maximumOutputBytes: 1_024
        }
      })
      .then(
        () => undefined,
        (reason: unknown) => reason
      )

    expect(error).toBeInstanceOf(ProtocolRemoteRuntimeChannelError)
    expect(error).toMatchObject({
      reason: 'remote',
      remoteMethod: 'runtime/preparePrompt',
      remoteRpcCode: -32000,
      remoteServiceCode: 'process',
      remoteRequestOutcome: 'rejected'
    })
    expect((error as Error).message).toContain(
      'runtime/preparePrompt'
    )
    expect((error as Error).message).toContain('process')
    expect((error as Error).message).not.toContain('private')
    expect((error as Error).message).not.toContain('must-not-escape')
    await fixture.channel.close()
  })

  it('flushes the highest consumed cursor at prompt and close boundaries', async () => {
    const fixture = await openChannel()
    const reader = fixture.channel.input.getReader()
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      fixture.client.binary.push(
        Buffer.from(`frame-${sequence}`),
        String(sequence)
      )
      await reader.read()
    }
    await vi.waitFor(() =>
      expect(fixture.client.binary.consumed).toBe(20)
    )

    expect(
      vi.mocked(fixture.connection.updateAcpBinding!).mock.calls.length
    ).toBeLessThanOrEqual(21)
    const flushesBeforeCompletion = vi.mocked(
      fixture.connection.flushAcpBindings!
    ).mock.calls.length
    await fixture.channel.completePromptOperation({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1'
    })
    expect(
      fixture.connection.flushAcpBindings
    ).toHaveBeenCalledTimes(flushesBeforeCompletion + 1)
    expect(
      fixture.connection.updateAcpBinding
    ).toHaveBeenCalledTimes(21)
    expect(
      vi.mocked(fixture.connection.updateAcpBinding!).mock.calls.at(-1)?.[1]
    ).toMatchObject({
      cursors: {
        lastInboundJournaledSequence: '20',
        lastMainAckSequence: '20'
      }
    })

    await fixture.channel.close()
    expect(
      fixture.connection.flushAcpBindings
    ).toHaveBeenCalledTimes(flushesBeforeCompletion + 3)
  })

  it('durably flushes an emitted cursor before sending its Agent ACK', async () => {
    const fixture = await openChannel()
    const events: string[] = []
    let releaseFlush!: () => void
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve
    })
    vi.mocked(
      fixture.connection.updateAcpBinding
    ).mockImplementation(async (_bindingId, binding) => {
      if (binding?.cursors.lastMainAckSequence === '1') {
        events.push('persist')
      }
    })
    vi.mocked(
      fixture.connection.flushAcpBindings
    ).mockImplementation(async () => {
      events.push('flush-start')
      await flushGate
      events.push('flush-end')
    })
    fixture.client.binary.onConsume = () => events.push('ack')

    const reader = fixture.channel.input.getReader()
    fixture.client.binary.push(Buffer.from('durable-first'), '1')
    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: new Uint8Array(Buffer.from('durable-first'))
    })
    await vi.waitFor(() =>
      expect(events).toContain('flush-start')
    )
    expect(fixture.client.binary.consumed).toBe(0)
    expect(events).toEqual(['persist', 'flush-start'])

    releaseFlush()
    await vi.waitFor(() =>
      expect(fixture.client.binary.consumed).toBe(1)
    )
    expect(events).toEqual([
      'persist',
      'flush-start',
      'flush-end',
      'ack'
    ])
    await fixture.channel.close()
  })

  it('does not regress a consumed cursor when the Agent ACK view lags', async () => {
    const fixture = await openChannel()
    const reader = fixture.channel.input.getReader()
    fixture.client.binary.push(Buffer.from('runtime output'), '1')
    await reader.read()
    await vi.waitFor(() => {
      expect(
        fixture.connection.updateAcpBinding
      ).toHaveBeenCalledTimes(2)
    })
    fixture.client.responder = (method, params) => {
      if (method === 'runtime/getAcpCursors') {
        return {
          lastOutboundJournaledSequence: '0',
          lastOutboundDeliveredSequence: '0',
          lastInboundJournaledSequence: '1',
          lastMainAckSequence: '0'
        }
      }
      return defaultResponse(method, params)
    }
    const updatesBeforeRefresh = vi.mocked(
      fixture.connection.updateAcpBinding!
    ).mock.calls.length

    await expect(
      fixture.channel.getBindingCursors('binding-1')
    ).resolves.toEqual({
      lastOutboundJournaledSequence: '0',
      lastOutboundDeliveredSequence: '0',
      lastInboundJournaledSequence: '1',
      lastMainAckSequence: '1'
    })
    expect(
      vi.mocked(fixture.connection.updateAcpBinding!).mock.calls.at(-1)?.[1]
    ).toMatchObject({
      cursors: {
        lastInboundJournaledSequence: '1',
        lastMainAckSequence: '1'
      }
    })
    expect(
      vi.mocked(fixture.connection.updateAcpBinding!)
    ).toHaveBeenCalledTimes(updatesBeforeRefresh)

    await fixture.channel.close()
  })

  it('does not consume or deliver inbound frames while paused', async () => {
    const fixture = await openChannel()
    await fixture.channel.setInboundPaused(true)
    const reader = fixture.channel.input.getReader()
    const reading = reader.read()
    fixture.client.binary.push(Buffer.from('held'))
    await Promise.resolve()
    expect(fixture.client.binary.consumed).toBe(0)

    await fixture.channel.setInboundPaused(false)
    await expect(reading).resolves.toMatchObject({
      done: false,
      value: new Uint8Array(Buffer.from('held'))
    })
    await vi.waitFor(() =>
      expect(fixture.client.binary.consumed).toBe(1)
    )
    await fixture.channel.close()
  })

  it('merges a cursor refresh with concurrently consumed output at commit', async () => {
    const fixture = await openChannel()
    const reader = fixture.channel.input.getReader()
    fixture.client.binary.push(Buffer.from('first'), '1')
    await reader.read()

    let markRefreshStarted!: () => void
    let releaseRefresh!: () => void
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    fixture.client.responder = async (method, params) => {
      if (method === 'runtime/getAcpCursors') {
        markRefreshStarted()
        await refreshGate
        return {
          lastOutboundJournaledSequence: '0',
          lastOutboundDeliveredSequence: '0',
          lastInboundJournaledSequence: '2',
          lastMainAckSequence: '0'
        }
      }
      return defaultResponse(method, params)
    }

    const refreshing =
      fixture.channel.getBindingCursors('binding-1')
    await refreshStarted
    fixture.client.binary.push(Buffer.from('second'), '2')
    await reader.read()
    releaseRefresh()

    await expect(refreshing).resolves.toEqual({
      lastOutboundJournaledSequence: '0',
      lastOutboundDeliveredSequence: '0',
      lastInboundJournaledSequence: '2',
      lastMainAckSequence: '2'
    })
    const persistedAcks = vi.mocked(
      fixture.connection.updateAcpBinding!
    ).mock.calls
      .map((call) => call[1]?.cursors.lastMainAckSequence)
      .filter((sequence): sequence is string => sequence !== undefined)
      .map(BigInt)
    expect(persistedAcks).toEqual(
      [...persistedAcks].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0
      )
    )

    await fixture.channel.close()
  })

  it('chunks output at the ACP frame limit and awaits send backpressure', async () => {
    const fixture = await openChannel()
    let releaseSend = (): void => undefined
    fixture.client.binary.sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve
    })
    const writer = fixture.channel.output.getWriter()
    const bytes = Buffer.alloc(
      AGENT_PROTOCOL_LIMITS.maximumAcpFrameBytes * 2 + 3,
      7
    )
    let settled = false
    const writing = writer.write(bytes).finally(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseSend()
    await writing
    expect(
      fixture.client.binary.sent.map((frame) => frame.byteLength)
    ).toEqual([
      AGENT_PROTOCOL_LIMITS.maximumAcpFrameBytes,
      AGENT_PROTOCOL_LIMITS.maximumAcpFrameBytes,
      3
    ])
    await fixture.channel.close()
  })

  it('rejects stale-generation controls without replaying the request', async () => {
    const fixture = await openChannel()
    fixture.setCapabilityGeneration(12)
    const before = fixture.client.requests.length
    await expect(
      fixture.channel.getBindingCursors('binding-1')
    ).rejects.toMatchObject({
      name: 'StaleRemoteRuntimeGenerationError'
    })
    expect(fixture.client.requests).toHaveLength(before)
    await fixture.channel.close()
  })

  it.each([
    {
      label: 'non-critical capability',
      mutate: (capabilities: DaemonCapabilities): DaemonCapabilities => ({
        ...capabilities,
        capabilities: [
          { name: 'runtime/acp', version: 3, critical: false }
        ]
      })
    },
    {
      label: 'non-exact capability version',
      mutate: (capabilities: DaemonCapabilities): DaemonCapabilities => ({
        ...capabilities,
        capabilities: [
          { name: 'runtime/acp', version: 1, critical: true }
        ]
      })
    },
    {
      label: 'runtime digest mismatch',
      mutate: (capabilities: DaemonCapabilities): DaemonCapabilities => ({
        ...capabilities,
        runtimes: [
          {
            ...capabilities.runtimes[0]!,
            bundleDigest: digest('d')
          }
        ]
      })
    }
  ])('fails before open for $label', async ({ mutate }) => {
    const fixture = connectionFixture()
    fixture.setCapabilities(mutate(validCapabilities()))
    await expect(
      createProtocolRemoteRuntimeChannel({
        connection: fixture.connection,
        openIdentity: openIdentity()
      })
    ).rejects.toBeInstanceOf(ProtocolRemoteRuntimeChannelError)
    expect(fixture.client.requests).toHaveLength(0)
  })

  it('closes once and releases its optional connection lease once', async () => {
    const fixture = await openChannel()
    const first = fixture.channel.close()
    const second = fixture.channel.close()
    expect(first).toBe(second)
    await Promise.all([first, second, fixture.channel.closed])
    expect(
      fixture.client.requests.filter(
        (request) => request.method === 'runtime/closeAcpChannel'
      )
    ).toHaveLength(1)
    expect(fixture.client.binary.closed).toBe(true)
    expect(fixture.release).toHaveBeenCalledTimes(1)
  })

  it('retains persisted recovery identity when remote close is not confirmed', async () => {
    const fixture = await openChannel()
    fixture.client.responder = (method, params) => {
      if (method === 'runtime/closeAcpChannel') {
        throw new Error('transport unavailable')
      }
      return defaultResponse(method, params)
    }

    await fixture.channel.close()

    expect(fixture.connection.updateAcpBinding).not.toHaveBeenCalledWith(
      'binding-1',
      undefined
    )
  })

  it('requires model bridge v1 and allocates a fresh blob channel for each prompt', async () => {
    const missing = connectionFixture()
    await expect(
      createProtocolRemoteRuntimeChannel({
        connection: missing.connection,
        openIdentity: openIdentity(),
        modelBridge: {
          dispatch: async () => ({
            status: 200,
            headers: {},
            bodyBase64: ''
          }),
          onDelivered: async () => undefined,
          finalizePrompt: async () => undefined,
          poison: async () => undefined
        }
      })
    ).rejects.toMatchObject({ reason: 'capability-mismatch' })
    expect(missing.client.requests).toHaveLength(0)

    const fixture = connectionFixture()
    fixture.setCapabilities(modelBridgeCapabilities())
    const channel = await createProtocolRemoteRuntimeChannel({
      connection: fixture.connection,
      openIdentity: openIdentity(),
      releaseConnectionOnClose: true,
      modelBridge: {
        dispatch: async () => ({
          status: 200,
          headers: {},
          bodyBase64: ''
        }),
        onDelivered: async () => undefined,
        finalizePrompt: async () => undefined,
        poison: async () => undefined
      }
    })
    const policy = {
      protocol: 'openai-responses' as const,
      model: 'gpt-test',
      modelProfileDigest: digest('e'),
      supportsImageInput: false
    }
    const first = await channel.openModelBridge({
      bindingId: 'binding-1',
      promptOperationId: 'prompt-1',
      requestId: 'prompt-1',
      policy
    })
    await expect(first.close()).resolves.toEqual({
      clean: true,
      poisoned: false
    })
    const second = await channel.openModelBridge({
      bindingId: 'binding-1',
      promptOperationId: 'prompt-2',
      requestId: 'prompt-2',
      policy
    })
    expect(second.channelId).not.toBe(first.channelId)
    expect(second.channelEpoch).not.toBe(first.channelEpoch)
    expect(fixture.client.blobBinaries).toHaveLength(2)
    await second.close()
    await channel.close()
  })

  it('waits for owned model bridges before releasing the ACP connection', async () => {
    const fixture = connectionFixture()
    fixture.setCapabilities(modelBridgeCapabilities())
    const channel = await createProtocolRemoteRuntimeChannel({
      connection: fixture.connection,
      openIdentity: openIdentity(),
      releaseConnectionOnClose: true,
      modelBridge: {
        dispatch: async () => ({
          status: 200,
          headers: {},
          bodyBase64: ''
        }),
        onDelivered: async () => undefined,
        finalizePrompt: async () => undefined,
        poison: async () => undefined
      }
    })
    const bridge = await channel.openModelBridge({
      bindingId: 'binding-1',
      promptOperationId: 'prompt-1',
      requestId: 'prompt-1',
      policy: {
        protocol: 'openai-responses',
        model: 'gpt-test',
        modelProfileDigest: digest('d'),
        supportsImageInput: false
      }
    })
    let releaseBridge!: () => void
    const bridgeGate = new Promise<void>((resolve) => {
      releaseBridge = resolve
    })
    let closeStarted!: () => void
    const closeWasStarted = new Promise<void>((resolve) => {
      closeStarted = resolve
    })
    vi.spyOn(bridge, 'close').mockImplementation(async () => {
      closeStarted()
      await bridgeGate
      return { clean: false, poisoned: true }
    })

    const closing = channel.close()
    await closeWasStarted
    expect(fixture.release).not.toHaveBeenCalled()
    releaseBridge()
    await closing
    expect(fixture.release).toHaveBeenCalledOnce()
  })

  it('redacts cancellation reasons before issuing the control request', async () => {
    const fixture = await openChannel()
    const secret = new Error('token=do-not-serialize')
    secret.stack = 'private stack'
    await fixture.channel.escalateCancellation({
      bindingId: 'binding-1',
      sessionId: 'session-1',
      operationId: 'operation-1',
      requestId: 'operation-1',
      reason: secret
    })
    const request = fixture.client.requests.find(
      (entry) => entry.method === 'runtime/escalateCancellation'
    )
    expect(request?.params).toEqual({
      bindingId: 'binding-1',
      sessionId: 'session-1',
      operationId: 'operation-1',
      requestId: 'operation-1',
      reason: 'error'
    })
    expect(JSON.stringify(request?.params)).not.toContain('do-not-serialize')
    expect(JSON.stringify(request?.params)).not.toContain('private stack')
    await fixture.channel.close()
  })

  it('completes a stable prompt operation without replaying it', async () => {
    const fixture = await openChannel()
    await expect(
      fixture.channel.completePromptOperation({
        bindingId: 'binding-1',
        operationId: 'operation-1',
        requestId: 'operation-1'
      })
    ).resolves.toEqual({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1',
      status: 'completed',
      processTree: 'running'
    })
    expect(
      fixture.client.requests.filter(
        (request) => request.method === 'runtime/completePrompt'
      )
    ).toHaveLength(1)
    await fixture.channel.close()
  })

  it('strictly rejects invalid cursor and reconciliation responses', async () => {
    const fixture = await openChannel()
    fixture.client.responder = (method, params) => {
      if (method === 'runtime/getAcpCursors') {
        return {
          lastOutboundJournaledSequence: '1',
          lastOutboundDeliveredSequence: '2',
          lastInboundJournaledSequence: '0',
          lastMainAckSequence: '0'
        }
      }
      return defaultResponse(method, params)
    }
    await expect(
      fixture.channel.getBindingCursors('binding-1')
    ).rejects.toMatchObject({ reason: 'protocol' })

    fixture.client.responder = (method, params) => {
      if (method === 'runtime/reconcilePrompt') {
        return {
          status: 'terminal',
          terminalState: 'failed',
          processTree: 'running'
        }
      }
      return defaultResponse(method, params)
    }
    await expect(
      fixture.channel.reconcilePromptOperation({
        bindingId: 'binding-1',
        operationId: 'operation-1',
        requestId: 'operation-1'
      })
    ).rejects.toMatchObject({ reason: 'protocol' })
    await fixture.channel.close()
  })

  it('keeps streams alive, seeds exact sequences, and ACKs replay duplicates without re-emitting them', async () => {
    const fixture = await openChannel()
    const recoveryAbort = new AbortController()
    const deadlineAt = new Date(Date.now() + 10_000).toISOString()
    fixture.channel.setRecoveryBoundary(
      deadlineAt,
      recoveryAbort.signal
    )
    const reader = fixture.channel.input.getReader()
    const writer = fixture.channel.output.getWriter()

    fixture.client.binary.push(Buffer.from('already-emitted'), '1')
    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: new Uint8Array(Buffer.from('already-emitted'))
    })
    await writer.write(Buffer.from('initial-input-1'))
    await writer.write(Buffer.from('initial-input-2'))

    const resumed = new FakeRuntimeClient(8)
    resumed.responder = (method, params) => {
      if (method === 'runtime/resumeAcpChannel') {
        return {
          bindingId: 'binding-1',
          channelId: 'binding-1',
          channelEpoch: '9',
          deadlineAt,
          cursors: {
            lastOutboundJournaledSequence: '2',
            lastOutboundDeliveredSequence: '2',
            lastInboundJournaledSequence: '2',
            lastMainAckSequence: '0'
          }
        }
      }
      if (method === 'runtime/replayAcpChannel') {
        resumed.binary.push(Buffer.from('already-emitted'), '1')
        resumed.binary.push(Buffer.from('replayed-once'), '2')
        return {
          bindingId: 'binding-1',
          channelId: 'binding-1',
          channelEpoch: '9',
          replayedThroughSequence: '2',
          live: true
        }
      }
      return defaultResponse(method, params)
    }
    fixture.setReconnectClient(resumed)

    const replayed = reader.read()
    fixture.client.transportClose()
    await expect(replayed).resolves.toMatchObject({
      done: false,
      value: new Uint8Array(Buffer.from('replayed-once'))
    })
    expect(
      resumed.requests.map((request) => ({
        method: request.method,
        params: request.params
      }))
    ).toEqual([
      {
        method: 'runtime/resumeAcpChannel',
        params: {
          bindingId: 'binding-1',
          channelId: 'binding-1',
          channelEpoch: '9'
        }
      },
      {
        method: 'runtime/replayAcpChannel',
        params: {
          bindingId: 'binding-1',
          channelId: 'binding-1',
          channelEpoch: '9',
          acknowledgedSequence: '0'
        }
      }
    ])
    expect(resumed.registrations[0]).toEqual({
      channelId: 'binding-1',
      channelEpoch: '9',
      kind: 'acp',
      nextInboundSequence: '1',
      nextOutboundSequence: '3'
    })
    expect(
      vi.mocked(fixture.connection.flushAcpBindings!).mock.calls.length
    ).toBeGreaterThanOrEqual(3)
    expect(
      vi.mocked(fixture.connection.updateAcpBinding!).mock.calls
    ).toContainEqual([
      'binding-1',
      expect.objectContaining({
        cursors: expect.objectContaining({
          lastInboundJournaledSequence: '2',
          lastMainAckSequence: '1'
        })
      })
    ])

    await writer.write(Buffer.from('live-input'))
    expect(fixture.client.binary.sent).toEqual([
      new Uint8Array(Buffer.from('initial-input-1')),
      new Uint8Array(Buffer.from('initial-input-2'))
    ])
    expect(resumed.binary.sent).toEqual([
      new Uint8Array(Buffer.from('live-input'))
    ])
    await fixture.channel.close()
  })

  it.each(['cancel', 'deadline'] as const)(
    'terminates recovery at the signed prompt %s boundary',
    async (boundary) => {
      const fixture = await openChannel()
      const controller = new AbortController()
      const deadlineAt = new Date(
        Date.now() + (boundary === 'deadline' ? 5 : 10_000)
      ).toISOString()
      fixture.channel.setRecoveryBoundary(
        deadlineAt,
        controller.signal
      )
      const reconnectGate = new Promise<void>(() => {})
      vi.mocked(fixture.connection.reconnect!).mockImplementationOnce(
        async (signal?: AbortSignal) => {
          await Promise.race([
            reconnectGate,
            new Promise<never>((_resolve, reject) => {
              signal?.addEventListener(
                'abort',
                () => reject(signal.reason),
                { once: true }
              )
            })
          ])
        }
      )
      fixture.client.transportClose()
      if (boundary === 'cancel') {
        controller.abort(new Error('caller cancelled'))
      }
      await fixture.channel.closed
      expect(fixture.channel.isCurrentGeneration()).toBe(false)
      expect(
        fixture.client.requests.filter(
          (request) =>
            request.method === 'runtime/preparePrompt'
        )
      ).toHaveLength(0)
    }
  )

  it.each(['daemon boot', 'capability generation'] as const)(
    'denies ACP recovery after changed %s',
    async (identity) => {
      const fixture = await openChannel()
      fixture.channel.setRecoveryBoundary(
        new Date(Date.now() + 10_000).toISOString(),
        new AbortController().signal
      )
      fixture.setReconnectClient(new FakeRuntimeClient(8))
      if (identity === 'daemon boot') {
        fixture.connection.status.daemonBootId = 'boot-2'
      } else {
        fixture.setCapabilityGeneration(12)
      }
      fixture.client.transportClose()
      await fixture.channel.closed
      expect(fixture.connection.reconnect).toHaveBeenCalledOnce()
      expect(
        (fixture.connection.client as FakeRuntimeClient).requests
      ).toHaveLength(0)
    }
  )

  it('fails outcome-unknown rather than replaying ACP input when outbound delivery cannot be proven', async () => {
    const fixture = await openChannel()
    const deadlineAt = new Date(Date.now() + 10_000).toISOString()
    fixture.channel.setRecoveryBoundary(
      deadlineAt,
      new AbortController().signal
    )
    const writer = fixture.channel.output.getWriter()
    await writer.write(Buffer.from('do-not-replay'))
    const resumed = new FakeRuntimeClient(8)
    resumed.responder = (method, params) => {
      if (method === 'runtime/resumeAcpChannel') {
        return {
          bindingId: 'binding-1',
          channelId: 'binding-1',
          channelEpoch: '9',
          deadlineAt,
          cursors: {
            lastOutboundJournaledSequence: '0',
            lastOutboundDeliveredSequence: '0',
            lastInboundJournaledSequence: '0',
            lastMainAckSequence: '0'
          }
        }
      }
      return defaultResponse(method, params)
    }
    fixture.setReconnectClient(resumed)

    fixture.client.transportClose()
    await fixture.channel.closed
    expect(
      resumed.requests.filter(
        (request) => request.method === 'runtime/replayAcpChannel'
      )
    ).toHaveLength(0)
    expect(resumed.binary.sent).toHaveLength(0)
  })

  it('recovers with an idle model bridge without replaying a Provider call', async () => {
    const fixture = connectionFixture()
    fixture.setCapabilities(modelBridgeCapabilities())
    const dispatch = vi.fn()
    const channel = await createProtocolRemoteRuntimeChannel({
      connection: fixture.connection,
      openIdentity: openIdentity(),
      modelBridge: {
        dispatch,
        onDelivered: async () => undefined,
        finalizePrompt: async () => undefined,
        poison: async () => undefined
      }
    })
    channel.setRecoveryBoundary(
      new Date(Date.now() + 10_000).toISOString(),
      new AbortController().signal
    )
    await channel.openModelBridge({
      bindingId: 'binding-1',
      promptOperationId: 'prompt-1',
      requestId: 'prompt-1',
      policy: {
        protocol: 'openai-responses',
        model: 'gpt-test',
        modelProfileDigest: digest('d'),
        supportsImageInput: false
      }
    })
    const deadlineAt = new Date(Date.now() + 10_000).toISOString()
    channel.setRecoveryBoundary(
      deadlineAt,
      new AbortController().signal
    )
    const resumed = new FakeRuntimeClient(8)
    resumed.responder = (method, params) => {
      if (method === 'runtime/resumeAcpChannel') {
        return {
          bindingId: 'binding-1',
          channelId: 'binding-1',
          channelEpoch: '9',
          deadlineAt,
          cursors: {
            lastOutboundJournaledSequence: '0',
            lastOutboundDeliveredSequence: '0',
            lastInboundJournaledSequence: '0',
            lastMainAckSequence: '0'
          }
        }
      }
      if (method === 'runtime/replayAcpChannel') {
        return {
          bindingId: 'binding-1',
          channelId: 'binding-1',
          channelEpoch: '9',
          replayedThroughSequence: '0',
          live: true
        }
      }
      return defaultResponse(method, params)
    }
    fixture.setReconnectClient(resumed)
    fixture.client.transportClose()
    await vi.waitFor(() =>
      expect(fixture.connection.reconnect).toHaveBeenCalledOnce()
    )
    const writer = channel.output.getWriter()
    await writer.write(Buffer.from('after-idle-bridge-recovery'))
    expect(resumed.binary.sent).toEqual([
      new Uint8Array(Buffer.from('after-idle-bridge-recovery'))
    ])
    expect(dispatch).not.toHaveBeenCalled()
    await channel.close()
  })

  it('does not recover or replay an in-flight Provider dispatch', async () => {
    const fixture = connectionFixture()
    fixture.setCapabilities(modelBridgeCapabilities())
    const dispatch = vi.fn(
      async (
        _request: unknown,
        signal: AbortSignal
      ): Promise<never> =>
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(signal.reason),
            { once: true }
          )
        })
    )
    const poison = vi.fn(async () => undefined)
    const channel = await createProtocolRemoteRuntimeChannel({
      connection: fixture.connection,
      openIdentity: openIdentity(),
      modelBridge: {
        dispatch,
        onDelivered: async () => undefined,
        finalizePrompt: async () => undefined,
        poison
      }
    })
    channel.setRecoveryBoundary(
      new Date(Date.now() + 10_000).toISOString(),
      new AbortController().signal
    )
    const bridge = await channel.openModelBridge({
      bindingId: 'binding-1',
      promptOperationId: 'prompt-1',
      requestId: 'prompt-1',
      policy: {
        protocol: 'openai-responses',
        model: 'gpt-test',
        modelProfileDigest: digest('d'),
        supportsImageInput: false
      }
    })
    const request = await createModelBridgeRequestMessage({
      identity: {
        bindingId: 'binding-1',
        promptOperationId: 'prompt-1',
        requestId: 'provider-request-1',
        roundIndex: 0,
        modelProfileDigest: digest('d'),
        messageId: 'message-1'
      },
      policy: bridge.policy,
      request: {
        method: 'POST',
        path: '/v1/responses',
        headers: { 'content-type': 'application/json' },
        bodyBase64: Buffer.from(
          JSON.stringify({ model: 'gpt-test' })
        ).toString('base64')
      }
    })
    fixture.client.blobBinaries[0]!.push(
      await encodeModelBridgeMessage(request),
      '1'
    )
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())

    fixture.client.transportClose()
    await channel.closed
    expect(fixture.connection.reconnect).not.toHaveBeenCalled()
    expect(dispatch).toHaveBeenCalledOnce()
    expect(poison).toHaveBeenCalledOnce()
  })

  it('preserves bounded transport categories before provider dispatch', async () => {
    const fixture = connectionFixture()
    fixture.setCapabilities(modelBridgeCapabilities())
    const channel = await createProtocolRemoteRuntimeChannel({
      connection: fixture.connection,
      openIdentity: openIdentity(),
      modelBridge: {
        dispatch: vi.fn(),
        onDelivered: async () => undefined,
        finalizePrompt: async () => undefined,
        poison: async () => undefined
      }
    })
    await channel.openModelBridge({
      bindingId: 'binding-1',
      promptOperationId: 'prompt-1',
      requestId: 'prompt-1',
      policy: {
        protocol: 'openai-responses',
        model: 'gpt-test',
        modelProfileDigest: digest('d'),
        supportsImageInput: false
      }
    })
    const reading = channel.input.getReader().read()
    fixture.client.transportClose(
      new AgentProtocolClientError(
        'reader failed',
        'protocol',
        new ChannelProtocolError(
          'sequence failed',
          'sequence-mismatch'
        )
      )
    )
    await expect(reading).rejects.toThrow(
      'client-protocol/channel-sequence-mismatch'
    )
  })

  it('preserves a bounded Agent-side failure category', async () => {
    const fixture = connectionFixture()
    fixture.setCapabilities(modelBridgeCapabilities())
    const channel = await createProtocolRemoteRuntimeChannel({
      connection: fixture.connection,
      openIdentity: openIdentity(),
      modelBridge: {
        dispatch: vi.fn(),
        onDelivered: async () => undefined,
        finalizePrompt: async () => undefined,
        poison: async () => undefined
      }
    })
    await channel.openModelBridge({
      bindingId: 'binding-1',
      promptOperationId: 'prompt-1',
      requestId: 'prompt-1',
      policy: {
        protocol: 'openai-responses',
        model: 'gpt-test',
        modelProfileDigest: digest('d'),
        supportsImageInput: false
      }
    })
    const reading = channel.input.getReader().read()
    fixture.client.transportClose(
      new AgentProtocolClientError(
        'transport closed',
        'closed',
        new AgentAttachTransportError(
          'attach closed',
          'closed',
          undefined,
          'dispatch/process'
        )
      )
    )
    await expect(reading).rejects.toThrow(
      'client-closed/attach-closed/agent-dispatch/process'
    )
  })

  it('settles closed and releases resources when the transport closes', async () => {
    const fixture = await openChannel()
    fixture.client.transportClose()
    await fixture.channel.closed
    expect(fixture.client.binary.closed).toBe(true)
    expect(fixture.channel.isCurrentGeneration()).toBe(false)
    expect(fixture.release).toHaveBeenCalledTimes(1)
    expect(
      fixture.client.requests.filter(
        (request) => request.method === 'runtime/closeAcpChannel'
      )
    ).toHaveLength(0)
  })

  it.each(['binary', 'connection'] as const)(
    'settles closed when the %s closes',
    async (source) => {
      const fixture = await openChannel()
      if (source === 'binary') {
        fixture.client.binary.close()
      } else {
        fixture.connectionClose()
      }
      await fixture.channel.closed
      expect(fixture.channel.isCurrentGeneration()).toBe(false)
      expect(fixture.release).toHaveBeenCalledTimes(1)
    }
  )
})

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`
}
