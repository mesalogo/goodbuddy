import { describe, expect, it, vi } from 'vitest'
import {
  type AcpJournalCursor,
  type RemotePromptOperationPreparation
} from '../shared/remote-agent-contracts'
import type { RemoteRuntimeBundleManifest } from '../shared/remote-runtime-launch-contracts'
import type { ControllerLease } from './controller-registry'
import type { ProtocolMethodContext } from './protocol-server'
import type {
  ModelBridgeBrokerDispatch,
  ModelBridgeBrokerServer
} from './model-bridge-broker'
import {
  RuntimeAcpBackend,
  type RuntimeAcpJournal,
  type RuntimeAcpProcessIdentity,
  type RuntimeAcpProcessOutput,
  type RuntimeAcpProcessOwner,
  type RuntimeAcpProcessReconciliation,
  type RuntimeAcpResolvedBundle,
  type RuntimeAcpVerifiedBundle
} from './runtime-acp-backend'

const digest = (character: string): string =>
  `sha256:${character.repeat(64)}`

class MemoryAcpJournal implements RuntimeAcpJournal {
  readonly frames: Array<{
    controllerId: string
    bindingId: string
    channelEpoch: string
    direction: 'main-to-runtime' | 'runtime-to-main'
    sequence: string
    payload: Uint8Array
  }> = []
  readonly delivered: string[] = []
  readonly retired: Array<{
    controllerId: string
    bindingId: string
    channelEpoch: string
  }> = []
  mainAckSequence = '0'
  failAppend = false

  appendAcpFrame(input: (typeof this.frames)[number]): { created: boolean } {
    if (this.failAppend) {
      throw new Error('journal capacity')
    }
    const existing = this.frames.find(
      (frame) =>
        frame.bindingId === input.bindingId &&
        frame.channelEpoch === input.channelEpoch &&
        frame.direction === input.direction &&
        frame.sequence === input.sequence
    )
    if (existing !== undefined) {
      if (
        Buffer.compare(
          Buffer.from(existing.payload),
          Buffer.from(input.payload)
        ) !== 0
      ) {
        throw new Error('sequence conflict')
      }
      return { created: false }
    }
    const latest = this.frames
      .filter(
        (frame) =>
          frame.bindingId === input.bindingId &&
          frame.channelEpoch === input.channelEpoch &&
          frame.direction === input.direction
      )
      .at(-1)
    if (BigInt(input.sequence) !== BigInt(latest?.sequence ?? '0') + 1n) {
      throw new Error('non-contiguous sequence')
    }
    this.frames.push({ ...input, payload: input.payload.slice() })
    return { created: true }
  }

  markAcpDelivered(input: {
    bindingId: string
    channelEpoch: string
    sequence: string
  }): void {
    this.delivered.push(input.sequence)
  }

  acknowledgeAcpFromMain(input: { sequence: string }): void {
    this.mainAckSequence = input.sequence
  }

  retireAcpBinding(input: {
    controllerId: string
    bindingId: string
    channelEpoch: string
  }): void {
    this.retired.push(input)
  }

  replayAcpFrames(input: {
    bindingId: string
    channelEpoch: string
    direction: 'runtime-to-main'
    afterSequence: string
    limit?: number
  }) {
    return this.frames
      .filter(
        (frame) =>
          frame.bindingId === input.bindingId &&
          frame.channelEpoch === input.channelEpoch &&
          frame.direction === input.direction &&
          BigInt(frame.sequence) > BigInt(input.afterSequence)
      )
      .slice(0, input.limit)
      .map((frame) => ({
        sequence: frame.sequence,
        payload: frame.payload.slice(),
        createdAt: 1
      }))
  }

  getAcpCursor(
    bindingId: string,
    channelEpoch: string,
    direction: 'main-to-runtime' | 'runtime-to-main'
  ): AcpJournalCursor | undefined {
    const frames = this.frames.filter(
      (frame) =>
        frame.bindingId === bindingId &&
        frame.channelEpoch === channelEpoch &&
        frame.direction === direction
    )
    if (frames.length === 0) {
      return undefined
    }
    const journaledSequence = frames.at(-1)!.sequence
    return {
      bindingId,
      channelEpoch,
      direction,
      journaledSequence,
      deliveredSequence:
        direction === 'main-to-runtime'
          ? this.delivered.at(-1) ?? '0'
          : '0',
      mainAckSequence:
        direction === 'runtime-to-main'
          ? this.mainAckSequence
          : '0'
    }
  }
}

class FakeProcess implements RuntimeAcpProcessOwner {
  readonly identity: RuntimeAcpProcessIdentity = {
    launchId: 'launch-1',
    processId: 'process-1',
    supervisorIdentityDigest: digest('9')
  }
  readonly writes: Uint8Array[] = []
  readonly stops: string[] = []
  readonly prompts: Array<{
    deadlineAt: string
    maximumInputBytes: number
  }> = []
  completions = 0
  reconciliation: RuntimeAcpProcessReconciliation = {
    identity: this.identity,
    state: 'running',
    processTree: 'running'
  }
  #listener?: (
    output: RuntimeAcpProcessOutput
  ) => void | Promise<void>

  beginPrompt(input: {
    deadlineAt: string
    maximumInputBytes: number
  }): void {
    this.prompts.push(input)
    this.reconciliation = {
      identity: this.identity,
      state: 'running',
      processTree: 'running'
    }
  }

  completePrompt(): void {
    this.completions += 1
  }

  writeStdin(payload: Uint8Array): void {
    this.writes.push(payload.slice())
  }

  stop(input: { reason: string }): void {
    this.stops.push(input.reason)
    this.reconciliation = {
      identity: this.identity,
      state: 'cancelled',
      processTree: 'empty'
    }
  }

  reconcile(): RuntimeAcpProcessReconciliation {
    return this.reconciliation
  }

  subscribeOutput(
    listener: (
      output: RuntimeAcpProcessOutput
    ) => void | Promise<void>
  ): () => void {
    this.#listener = listener
    return () => {
      this.#listener = undefined
    }
  }

  async emit(
    stream: 'stdout' | 'stderr',
    value: string
  ): Promise<void> {
    await this.#listener?.({
      stream,
      data: Buffer.from(value)
    })
  }
}

type Harness = ReturnType<typeof harness>

function harness(input: {
  workMode?: 'ask' | 'execute'
  now?: number
  maximumOutputBytes?: number
  bridgeCloseError?: boolean
} = {}) {
  const workMode = input.workMode ?? 'ask'
  let now = input.now ?? 1_000
  const journal = new MemoryAcpJournal()
  const process = new FakeProcess()
  const outputFrames: string[] = []
  const launches: Array<{
    workMode: 'ask' | 'execute'
    scratch: string
  }> = []
  const lifecycle: string[] = []
  const bridgeCloses = vi.fn(async () => {
    if (input.bridgeCloseError) {
      throw new Error('broker close failed')
    }
  })
  const blobSink = vi.fn(async () => undefined)
  let bridgeDispatch: ModelBridgeBrokerDispatch | undefined
  const launchModelBridges: unknown[] = []
  const resolved = resolvedBundle()
  const backend = new RuntimeAcpBackend({
    journal,
    resolveRuntimeBundle: vi.fn(async () => resolved),
    reverifyRuntimeBundle: vi.fn(async () => verifiedBundle()),
    resolveWorkspace: vi.fn(async (preparation) => ({
      workspaceIdentity: preparation.workspaceIdentity,
      workspaceDirectory: '/workspace',
      scratchDirectory: '/scratch',
      bridgeDirectory: '/bridge'
    })),
    launchProcess: vi.fn(async (launch) => {
      lifecycle.push('launch')
      launchModelBridges.push(launch.modelBridge)
      launches.push({
        workMode: launch.workMode,
        scratch: launch.scratch
      })
      return process
    }),
    now: () => now,
    outputSink: vi.fn(async (frame) => {
      outputFrames.push(Buffer.from(frame.payload).toString())
    }),
    blobSink,
    createModelBridgeBroker: ({ dispatch }) => {
      bridgeDispatch = dispatch
      return {
        socketPath: '/bridge/model-bridge.sock',
        listen: vi.fn(async () => {
          lifecycle.push('bridge-listen')
        }),
        close: bridgeCloses
      } as unknown as ModelBridgeBrokerServer
    }
  })
  const context = protocolContext()
  const openRequest = {
    bindingId: 'binding-1',
    runtimeId: 'opencode',
    runtimeBundleDigest: digest('1'),
    workspaceIdentity: 'workspace-identity-1'
  }

  return {
    backend,
    context,
    journal,
    process,
    launches,
    lifecycle,
    bridgeCloses,
    blobSink,
    get bridgeDispatch() {
      return bridgeDispatch
    },
    launchModelBridges,
    outputFrames,
    openRequest,
    preparation: (
      overrides: Partial<RemotePromptOperationPreparation> = {}
    ): RemotePromptOperationPreparation => ({
      bindingId: openRequest.bindingId,
      operationId: 'request-1',
      requestId: 'request-1',
      workMode,
      controllerId: context.controller.controllerId,
      controllerGeneration: context.controller.generation,
      connectionGeneration: context.controller.generation,
      channelEpoch: '1000',
      hostId: 'host-1',
      hostRevision: 1,
      hostKeyGeneration: 1,
      workspaceIdentity: openRequest.workspaceIdentity,
      agentInstallationId: 'installation-1',
      runtimeId: openRequest.runtimeId,
      runtimeBundleDigest: openRequest.runtimeBundleDigest,
      runtimeAdapterDigest: digest('2'),
      deadlineAt: new Date(now + 60_000).toISOString(),
      budget: {
        maximumInputBytes: 1_024,
        maximumOutputBytes: input.maximumOutputBytes ?? 1_024
      },
      ...overrides
    }),
    setNow(value: number): void {
      now = value
    }
  }
}

describe('RuntimeAcpBackend', () => {
  it('rejects Agent-first unknown blob channels before prompt authority exists', async () => {
    const fixture = harness()
    await expect(
      fixture.backend.onBlobFrame(
        {
          header: {
            protocolMajor: 1,
            protocolMinor: 0,
            connectionId: fixture.context.controller.connectionId,
            generation: fixture.context.controller.generation,
            channelId: 'unknown-model-channel',
            channelEpoch: '1',
            direction: 'main-to-agent',
            sequence: '1',
            kind: 'blob',
            payloadLength: 1
          },
          payload: Uint8Array.of(1)
        },
        {
          ...fixture.context,
          channelId: 'unknown-model-channel'
        }
      )
    ).rejects.toMatchObject({ code: 'identity' })
  })

  it('starts the exact prepared model bridge before launch and revokes it on completion', async () => {
    const fixture = harness()
    await invoke(
      fixture,
      'runtime/openAcpChannel',
      fixture.openRequest
    )
    const modelBridge = {
      version: 'goodbuddy-model-bridge-v1' as const,
      channelId: 'model-channel-1',
      channelEpoch: '20',
      policy: {
        protocol: 'openai-responses' as const,
        model: 'private-model',
        modelProfileDigest: digest('8'),
        supportsImageInput: false
      }
    }
    await invoke(
      fixture,
      'runtime/preparePrompt',
      fixture.preparation({ modelBridge })
    )
    expect(fixture.lifecycle).toEqual([
      'bridge-listen',
      'launch'
    ])
    expect(fixture.launchModelBridges).toEqual([
      {
        socketPath: '/bridge/model-bridge.sock',
        policy: modelBridge.policy
      }
    ])
    expect(fixture.bridgeDispatch).toEqual(expect.any(Function))

    await invoke(fixture, 'runtime/completePrompt', {
      bindingId: 'binding-1',
      operationId: 'request-1',
      requestId: 'request-1'
    })
    expect(fixture.bridgeCloses).toHaveBeenCalledOnce()
  })

  it('runs open, prepare, ACP delivery, durable output, cursors, and close', async () => {
    const fixture = harness()
    const opened = await invoke(
      fixture,
      'runtime/openAcpChannel',
      fixture.openRequest
    )
    expect(opened).toMatchObject({
      bindingId: 'binding-1',
      channelId: 'binding-1',
      channelEpoch: '1000'
    })

    const acceptance = await invoke(
      fixture,
      'runtime/preparePrompt',
      fixture.preparation()
    )
    expect(acceptance).toMatchObject({
      bindingId: 'binding-1',
      operationId: 'request-1',
      workMode: 'ask',
      requestId: 'request-1'
    })
    expect(fixture.launches).toEqual([
      { workMode: 'ask', scratch: '/scratch' }
    ])

    fixture.journal.appendAcpFrame({
      controllerId: fixture.context.controller.controllerId,
      bindingId: 'binding-1',
      channelEpoch: '1000',
      direction: 'main-to-runtime',
      sequence: '1',
      payload: Buffer.from('input')
    })
    await fixture.backend.onAcpFrame(
      acpFrame(fixture.context.controller, 'input'),
      { ...fixture.context, channelId: 'binding-1' }
    )
    expect(
      Buffer.from(fixture.process.writes[0]!).toString()
    ).toBe('input')
    expect(fixture.journal.delivered).toEqual([])
    fixture.journal.markAcpDelivered({
      bindingId: 'binding-1',
      channelEpoch: '1000',
      sequence: '1'
    })
    expect(fixture.journal.delivered).toEqual(['1'])

    await fixture.process.emit('stderr', 'private diagnostic')
    await fixture.process.emit('stdout', 'output')
    expect(fixture.outputFrames).toEqual(['output'])
    expect(
      fixture.journal.frames.filter(
        (frame) => frame.direction === 'runtime-to-main'
      )
    ).toHaveLength(1)

    const cursors = await invoke(
      fixture,
      'runtime/getAcpCursors',
      { bindingId: 'binding-1' }
    )
    expect(cursors).toEqual({
      lastOutboundJournaledSequence: '1',
      lastOutboundDeliveredSequence: '1',
      lastInboundJournaledSequence: '1',
      lastMainAckSequence: '0'
    })

    await expect(
      invoke(fixture, 'runtime/closeAcpChannel', {
        bindingId: 'binding-1',
        channelId: 'binding-1',
        channelEpoch: '1000',
        reason: 'released'
      })
    ).resolves.toEqual({
      bindingId: 'binding-1',
      channelEpoch: '1000',
      closed: true
    })
    expect(fixture.process.stops).toEqual(['binding-closed'])
    expect(fixture.journal.retired).toEqual([
      {
        controllerId: 'controller-1',
        bindingId: 'binding-1',
        channelEpoch: '1000'
      }
    ])
  })

  it.each(['ask', 'execute'] as const)(
    'accepts %s as the complete prompt authorization',
    async (workMode) => {
      const fixture = harness({ workMode })
      await open(fixture)
      await expect(
        invoke(
          fixture,
          'runtime/preparePrompt',
          fixture.preparation()
        )
      ).resolves.toMatchObject({ workMode })
    }
  )

  it('is idempotent for stable identities and rejects conflicting payloads', async () => {
    const fixture = harness()
    const firstOpen = await open(fixture)
    await expect(open(fixture)).resolves.toEqual(firstOpen)
    const first = await invoke(
      fixture,
      'runtime/preparePrompt',
      fixture.preparation()
    )
    await expect(
      invoke(
        fixture,
        'runtime/preparePrompt',
        fixture.preparation()
      )
    ).resolves.toEqual(first)
    expect(fixture.launches).toHaveLength(1)

    await expect(
      invoke(
        fixture,
        'runtime/preparePrompt',
        fixture.preparation({
          deadlineAt: new Date(62_000).toISOString()
        })
      )
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(
      invoke(fixture, 'runtime/openAcpChannel', {
        ...fixture.openRequest,
        workspaceIdentity: 'workspace-other'
      })
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('completes two prompts idempotently while keeping one process alive', async () => {
    const fixture = harness()
    await open(fixture)
    await invoke(
      fixture,
      'runtime/preparePrompt',
      fixture.preparation()
    )
    const completion = {
      bindingId: 'binding-1',
      operationId: 'request-1',
      requestId: 'request-1'
    }
    const first = await invoke(
      fixture,
      'runtime/completePrompt',
      completion
    )
    await expect(
      invoke(fixture, 'runtime/completePrompt', completion)
    ).resolves.toEqual(first)
    await expect(
      invoke(fixture, 'runtime/reconcilePrompt', completion)
    ).resolves.toEqual({
      status: 'terminal',
      terminalState: 'completed',
      processTree: 'running'
    })

    await invoke(
      fixture,
      'runtime/preparePrompt',
      fixture.preparation({
        operationId: 'request-2',
        requestId: 'request-2',
        budget: {
          maximumInputBytes: 2_048,
          maximumOutputBytes: 1_024
        }
      })
    )
    await invoke(fixture, 'runtime/completePrompt', {
      bindingId: 'binding-1',
      operationId: 'request-2',
      requestId: 'request-2'
    })

    expect(fixture.launches).toHaveLength(1)
    expect(fixture.process.prompts).toHaveLength(1)
    expect(fixture.process.prompts[0]!.maximumInputBytes).toBe(2_048)
    expect(fixture.process.completions).toBe(2)
    expect(fixture.process.stops).toEqual([])
  })

  it('rejects completion conflicts and unsafe stable reopen', async () => {
    const fixture = harness()
    await open(fixture)
    await invoke(
      fixture,
      'runtime/preparePrompt',
      fixture.preparation()
    )
    await expect(
      invoke(fixture, 'runtime/completePrompt', {
        bindingId: 'binding-1',
        operationId: 'request-other',
        requestId: 'request-other'
      })
    ).rejects.toMatchObject({ code: 'identity' })

    await expect(
      fixture.backend.methods['runtime/openAcpChannel']!(
        fixture.openRequest,
        protocolContext({
          generation: 2,
          connectionId: 'connection-2'
        })
      )
    ).rejects.toMatchObject({ code: 'stale-controller' })
  })

  it('reopens a definitively closed stable binding with a fresh epoch and generation', async () => {
    const fixture = harness()
    await open(fixture)
    await invoke(
      fixture,
      'runtime/preparePrompt',
      fixture.preparation()
    )
    await invoke(fixture, 'runtime/closeAcpChannel', {
      bindingId: 'binding-1',
      channelId: 'binding-1',
      channelEpoch: '1000',
      reason: 'released'
    })
    const reopened = await fixture.backend.methods[
      'runtime/openAcpChannel'
    ]!(
      fixture.openRequest,
      protocolContext({
        generation: 2,
        connectionId: 'connection-2'
      })
    )
    expect(reopened).toMatchObject({
      bindingId: 'binding-1',
      channelEpoch: '1001'
    })
  })

  it('rejects cross-controller access and expired preparations', async () => {
    const fixture = harness()
    await open(fixture)
    await expect(
      fixture.backend.methods['runtime/getAcpCursors']!(
        { bindingId: 'binding-1' },
        protocolContext({
          controllerId: 'controller-other',
          connectionId: 'connection-other'
        })
      )
    ).rejects.toMatchObject({ code: 'stale-controller' })
    await expect(
      invoke(
        fixture,
        'runtime/preparePrompt',
        fixture.preparation({
          deadlineAt: new Date(1_000).toISOString()
        })
      )
    ).rejects.toMatchObject({ code: 'deadline' })
  })

  it('stops the process when its output quota is exceeded', async () => {
    const fixture = harness({ maximumOutputBytes: 3 })
    await open(fixture)
    await invoke(
      fixture,
      'runtime/preparePrompt',
      fixture.preparation()
    )
    await expect(
      fixture.process.emit('stdout', 'four')
    ).rejects.toMatchObject({ code: 'output-quota' })
    expect(fixture.process.stops).toEqual(['output-quota'])
    expect(fixture.outputFrames).toEqual([])
  })

  it('stops with output quota when the detached durable journal is exhausted', async () => {
    const fixture = harness()
    await open(fixture)
    await invoke(
      fixture,
      'runtime/preparePrompt',
      fixture.preparation()
    )
    fixture.context.abort.abort()
    await new Promise<void>((resolve) => setImmediate(resolve))
    fixture.journal.failAppend = true
    await expect(
      fixture.process.emit('stdout', 'offline')
    ).rejects.toMatchObject({ code: 'output-quota' })
    expect(fixture.process.stops).toEqual(['output-quota'])
    expect(fixture.outputFrames).toEqual([])
  })

  it('escalates cancellation but detaches without stopping on disconnect', async () => {
    const fixture = harness()
    await open(fixture)
    await invoke(
      fixture,
      'runtime/preparePrompt',
      fixture.preparation()
    )
    await expect(
      invoke(fixture, 'runtime/escalateCancellation', {
        bindingId: 'binding-1',
        sessionId: 'session-1',
        operationId: 'request-1',
        requestId: 'request-1',
        reason: 'requested'
      })
    ).resolves.toEqual({ bindingId: 'binding-1', stopped: true })
    expect(fixture.process.stops).toEqual(['user-cancelled'])

    const disconnected = harness()
    await open(disconnected)
    await invoke(
      disconnected,
      'runtime/preparePrompt',
      disconnected.preparation()
    )
    disconnected.context.abort.abort()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(disconnected.process.stops).toEqual([])
    await disconnected.process.emit('stdout', 'offline')
    expect(disconnected.outputFrames).toEqual([])
    expect(
      disconnected.journal.frames.filter(
        (frame) => frame.direction === 'runtime-to-main'
      ).map((frame) => Buffer.from(frame.payload).toString())
    ).toEqual(['offline'])
  })

  it('closes an idle model bridge on detach without poisoning or stopping Runtime work', async () => {
    const fixture = harness()
    await open(fixture)
    await invoke(
      fixture,
      'runtime/preparePrompt',
      fixture.preparation({
        modelBridge: {
          version: 'goodbuddy-model-bridge-v1',
          channelId: 'model-channel-idle',
          channelEpoch: '20',
          policy: {
            protocol: 'openai-responses',
            model: 'private-model',
            modelProfileDigest: digest('8'),
            supportsImageInput: false
          }
        }
      })
    )

    fixture.context.abort.abort()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(fixture.bridgeCloses).toHaveBeenCalledOnce()
    expect(fixture.process.stops).toEqual([])
    await fixture.process.emit('stdout', 'idle-bridge-offline')
    expect(fixture.outputFrames).toEqual([])

    const resumedContext = protocolContext({
      generation: 2,
      connectionId: 'connection-2'
    })
    await expect(
      fixture.backend.methods['runtime/resumeAcpChannel']!(
        {
          bindingId: 'binding-1',
          channelId: 'binding-1',
          channelEpoch: '1000'
        },
        resumedContext
      )
    ).resolves.toMatchObject({
      bindingId: 'binding-1',
      cursors: { lastInboundJournaledSequence: '1' }
    })
  })

  it('poisons an in-flight Provider exchange on detach without stopping Runtime work', async () => {
    const fixture = harness({ bridgeCloseError: true })
    await open(fixture)
    await invoke(
      fixture,
      'runtime/preparePrompt',
      fixture.preparation({
        modelBridge: {
          version: 'goodbuddy-model-bridge-v1',
          channelId: 'model-channel-active',
          channelEpoch: '21',
          policy: {
            protocol: 'openai-responses',
            model: 'private-model',
            modelProfileDigest: digest('8'),
            supportsImageInput: false
          }
        }
      })
    )
    const providerExchange = fixture.bridgeDispatch!(
      {
        method: 'POST',
        path: '/v1/responses',
        headers: { 'content-type': 'application/json' },
        bodyBase64: Buffer.from(
          JSON.stringify({ model: 'private-model' })
        ).toString('base64')
      },
      {
        requestId: 'provider-request-1',
        signal: new AbortController().signal
      }
    )
    await vi.waitFor(() =>
      expect(fixture.blobSink).toHaveBeenCalledOnce()
    )

    fixture.context.abort.abort()
    await expect(providerExchange).rejects.toMatchObject({
      code: 'cancelled'
    })
    expect(fixture.process.stops).toEqual([])
    await fixture.process.emit('stdout', 'poisoned-bridge-offline')
    expect(
      fixture.journal.frames
        .filter((frame) => frame.direction === 'runtime-to-main')
        .map((frame) => Buffer.from(frame.payload).toString())
    ).toEqual(['poisoned-bridge-offline'])

    await expect(
      fixture.backend.methods['runtime/resumeAcpChannel']!(
        {
          bindingId: 'binding-1',
          channelId: 'binding-1',
          channelEpoch: '1000'
        },
        protocolContext({
          generation: 2,
          connectionId: 'connection-2'
        })
      )
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('resumes the exact detached binding and replays ACK-exclusive output before live output', async () => {
    const fixture = harness()
    await open(fixture)
    await invoke(
      fixture,
      'runtime/preparePrompt',
      fixture.preparation()
    )
    fixture.context.abort.abort()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await fixture.process.emit('stdout', 'offline-1')
    await fixture.process.emit('stdout', 'offline-2')
    expect(fixture.outputFrames).toEqual([])

    const resumedContext = protocolContext({
      generation: 2,
      connectionId: 'connection-2'
    })
    await expect(
      fixture.backend.methods['runtime/resumeAcpChannel']!(
        {
          bindingId: 'binding-1',
          channelId: 'binding-1',
          channelEpoch: '1000'
        },
        resumedContext
      )
    ).resolves.toMatchObject({
      bindingId: 'binding-1',
      channelId: 'binding-1',
      channelEpoch: '1000',
      cursors: {
        lastInboundJournaledSequence: '2',
        lastMainAckSequence: '0'
      }
    })
    await expect(
      fixture.backend.methods['runtime/replayAcpChannel']!(
        {
          bindingId: 'binding-1',
          channelId: 'binding-1',
          channelEpoch: '1000',
          acknowledgedSequence: '1'
        },
        resumedContext
      )
    ).resolves.toMatchObject({
      replayedThroughSequence: '2',
      live: true
    })
    await fixture.process.emit('stdout', 'live-3')
    expect(fixture.outputFrames).toEqual(['offline-2', 'live-3'])

    await expect(
      fixture.backend.methods['runtime/getAcpCursors']!(
        { bindingId: 'binding-1' },
        fixture.context
      )
    ).rejects.toMatchObject({ code: 'stale-controller' })
  })

  it('fails closed on supervised process identity conflict', async () => {
    const fixture = harness()
    await open(fixture)
    await invoke(
      fixture,
      'runtime/preparePrompt',
      fixture.preparation()
    )
    fixture.process.reconciliation = {
      identity: {
        ...fixture.process.identity,
        processId: 'different-process'
      },
      state: 'running',
      processTree: 'running'
    }
    await expect(
      invoke(fixture, 'runtime/reconcilePrompt', {
        bindingId: 'binding-1',
        operationId: 'request-1',
        requestId: 'request-1'
      })
    ).rejects.toMatchObject({ code: 'identity' })
    expect(fixture.process.stops).toEqual(['identity-conflict'])
  })

  it('boundedly stops and reconciles every owned process on disposal', async () => {
    const fixture = harness()
    await open(fixture)
    await invoke(
      fixture,
      'runtime/preparePrompt',
      fixture.preparation()
    )

    await expect(fixture.backend.dispose(100)).resolves.toBeUndefined()
    expect(fixture.process.stops).toEqual(['binding-closed'])
    await expect(
      invoke(
        fixture,
        'runtime/openAcpChannel',
        fixture.openRequest
      )
    ).rejects.toMatchObject({ code: 'closed' })
  })

  it('rejects a process identity reused by another binding', async () => {
    const fixture = harness()
    await open(fixture)
    await invoke(
      fixture,
      'runtime/preparePrompt',
      fixture.preparation()
    )
    const secondOpen = {
      ...fixture.openRequest,
      bindingId: 'binding-2',
      workspaceIdentity: 'workspace-identity-2'
    }
    await invoke(
      fixture,
      'runtime/openAcpChannel',
      secondOpen
    )
    await expect(
      invoke(
        fixture,
        'runtime/preparePrompt',
        fixture.preparation({
          bindingId: 'binding-2',
          operationId: 'request-2',
          requestId: 'request-2',
          channelEpoch: '1001',
          workspaceIdentity: 'workspace-identity-2'
        })
      )
    ).rejects.toMatchObject({ code: 'identity' })
    expect(fixture.process.stops).toEqual(['identity-conflict'])
  })
})

async function open(fixture: Harness): Promise<Record<string, unknown>> {
  return (await invoke(
    fixture,
    'runtime/openAcpChannel',
    fixture.openRequest
  )) as Record<string, unknown>
}

async function invoke(
  fixture: Harness,
  method: string,
  params: unknown
): Promise<unknown> {
  return await fixture.backend.methods[method]!(params, fixture.context)
}

function protocolContext(
  overrides: Partial<ControllerLease> = {}
): ProtocolMethodContext & { abort: AbortController } {
  const abort = new AbortController()
  return {
    controller: {
      controllerId: 'controller-1',
      connectionId: 'connection-1',
      generation: 1,
      leaseExpiresAt: 1_000_000,
      capabilityGeneration: 1,
      ownedObjects: {},
      ...overrides
    },
    channelId: 'control-channel',
    signal: abort.signal,
    abort
  }
}

function resolvedBundle(): RuntimeAcpResolvedBundle {
  return {
    entry: {
      runtimeId: 'opencode',
      bundleDigest: digest('1'),
      acpCapabilitiesDigest: digest('6')
    },
    bundleDirectory: '/runtime/opencode'
  }
}

function verifiedBundle(): RuntimeAcpVerifiedBundle {
  return {
    bundleDirectory: '/runtime/opencode',
    executablePath: '/runtime/opencode/bin/opencode',
    manifest: {
      runtimeId: 'opencode',
      provider: 'opencode',
      bundleDigest: digest('1'),
      adapterDigest: digest('2'),
      acpCapabilitiesDigest: digest('6'),
      limits: {
        maximumPromptRuntimeMilliseconds: 60_000,
        maximumPromptInputBytes: 16 * 1024 * 1024,
        maximumPromptOutputBytes: 10_000
      }
    } as RemoteRuntimeBundleManifest,
    manifestDigest: digest('5')
  }
}

function acpFrame(
  controller: ControllerLease,
  value: string
) {
  const payload = Buffer.from(value)
  return {
    header: {
      protocolMajor: 1,
      protocolMinor: 0,
      connectionId: controller.connectionId,
      generation: controller.generation,
      channelId: 'binding-1',
      channelEpoch: '1000',
      direction: 'main-to-agent' as const,
      sequence: '1',
      kind: 'acp' as const,
      payloadLength: payload.byteLength
    },
    payload
  }
}
