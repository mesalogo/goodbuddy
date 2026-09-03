import { z } from 'zod'
import { createHash } from 'node:crypto'
import {
  AGENT_PROTOCOL_LIMITS,
  AGENT_PROTOCOL_VERSION,
  acpCompletePromptRequestSchema as promptCompletionSchema,
  acpCompletePromptResultSchema,
  acpEscalateCancellationRequestSchema as cancellationEscalationSchema,
  acpGetCursorsRequestSchema as getCursorsRequestSchema,
  acpReplayChannelRequestSchema,
  acpReplayChannelResultSchema,
  acpResumeChannelRequestSchema,
  acpResumeChannelResultSchema,
  acpCloseChannelRequestSchema,
  acpCloseChannelResultSchema,
  acpOpenChannelRequestSchema,
  acpOpenChannelResultSchema,
  acpReconcilePromptRequestSchema as promptReconciliationSchema,
  agentIdentifierSchema,
  positiveAgentSequenceSchema,
  sha256DigestSchema,
  type AgentFrame
} from '../shared/agent-protocol'
import { canonicalJson } from '../shared/agent-protocol/canonical'
import type {
  AgentDiagnosticLog,
  AgentDiagnosticRecord
} from './diagnostic-log'
import {
  acpJournalCursorSchema,
  remoteOwnedPromptAttachRequestSchema,
  remoteOwnedPromptStartRequestSchema,
  remoteSemanticTranscriptAckRequestSchema,
  remoteSemanticTranscriptPageRequestSchema,
  remotePromptOperationAcceptanceSchema,
  remotePromptOperationPreparationSchema,
  UNBOUNDED_REMOTE_PROMPT_DEADLINE,
  type AcpJournalCursor,
  type RemotePromptOperationAcceptance,
  type RemotePromptOperationPreparation
} from '../shared/remote-agent-contracts'
import type { RemoteRuntimeBundleManifest } from '../shared/remote-runtime-launch-contracts'
import {
  modelBridgePolicySchema,
  type AgentPromptModelProfile,
  type ModelBridgePolicy
} from '../shared/model-bridge-contracts'
import {
  ModelBridgeBlobClient,
  ModelBridgeClientError
} from './model-bridge-client'
import {
  ModelBridgeBrokerServer,
  type ModelBridgeBrokerDispatch
} from './model-bridge-broker'
import type {
  ProtocolMethodContext,
  ProtocolMethodHandler
} from './protocol-server'
import { AgentOwnedAcpPrompt } from './agent-owned-acp-prompt'
import type { SemanticPromptStore } from './semantic-prompt-store'
import {
  AgentModelGatewayError,
  type AgentModelGateway
} from './agent-model-gateway'
import { openCodeModelBridgeModelId } from './model-bridge-helper'
import { EventJournalCapacityError } from './event-journal'

const ZERO_CURSOR = '0'
const DEFAULT_MAXIMUM_BINDINGS = 128
const DEFAULT_MAXIMUM_CONTROLLER_BINDINGS = 32
const DEFAULT_MAXIMUM_LIFETIME_BINDINGS = 4_096
const DEFAULT_MAXIMUM_PENDING_CONTROL = 256
const DEFAULT_MAXIMUM_PENDING_INPUT_PER_BINDING = 128
const DEFAULT_MAXIMUM_PENDING_INPUT_GLOBAL = 1_024
const DEFAULT_MAXIMUM_PENDING_OUTPUT_PER_BINDING = 128
const DEFAULT_MAXIMUM_PENDING_OUTPUT_GLOBAL = 1_024
const DEFAULT_MAXIMUM_PENDING_OUTPUT_BYTES_PER_BINDING =
  AGENT_PROTOCOL_LIMITS.runEventJournalBytes
const DEFAULT_MAXIMUM_PENDING_OUTPUT_BYTES_GLOBAL =
  AGENT_PROTOCOL_LIMITS.maximumBufferedProtocolBytes
const DEFAULT_MAXIMUM_OPERATIONS_PER_BINDING = 1_000
const DEFAULT_DISPOSE_TIMEOUT_MS = 10_000
const OWNED_PROMPT_CANCEL_GRACE_MS = 1_000
const OWNED_PROMPT_START_TIMEOUT_MS = 2 * 60_000
const ACP_JOURNAL_RETRY_MILLISECONDS = 25

export type RuntimeAcpBackendErrorCode =
  | 'capacity'
  | 'closed'
  | 'conflict'
  | 'deadline'
  | 'identity'
  | 'not-found'
  | 'output-quota'
  | 'process'
  | 'stale-controller'
  | 'untrusted-runtime'
  | 'workspace'

export class RuntimeAcpBackendError extends Error {
  constructor(
    message: string,
    readonly code: RuntimeAcpBackendErrorCode
  ) {
    super(message)
    this.name = 'RuntimeAcpBackendError'
  }
}

export type RuntimeAcpJournal = {
  appendAcpFrame(input: {
    controllerId: string
    bindingId: string
    channelEpoch: string
    direction: 'main-to-runtime' | 'runtime-to-main'
    sequence: string
    payload: Uint8Array
  }): { created: boolean }
  getAcpCursor(
    bindingId: string,
    channelEpoch: string,
    direction: 'main-to-runtime' | 'runtime-to-main'
  ): AcpJournalCursor | undefined
  acknowledgeAcpFromMain?(input: {
    bindingId: string
    channelEpoch: string
    sequence: string
  }): void
  retireAcpBinding?(input: {
    controllerId: string
    bindingId: string
    channelEpoch: string
  }): void
  replayAcpFrames?(input: {
    bindingId: string
    channelEpoch: string
    direction: 'runtime-to-main'
    afterSequence: string
    limit?: number
  }): Array<{ sequence: string; payload: Uint8Array; createdAt: number }>
}

export type RuntimeAcpResolvedBundle = {
  entry: {
    runtimeId: string
    bundleDigest: string
    acpCapabilitiesDigest: string
    manifestDigest?: string
  }
  bundleDirectory: string
}

export type RuntimeAcpVerifiedBundle = {
  bundleDirectory: string
  executablePath: string
  manifest: RemoteRuntimeBundleManifest
  manifestDigest: string
}

export type RuntimeAcpWorkspace = {
  workspaceIdentity: string
  workspaceDirectory: string
  scratchDirectory: string
  bridgeDirectory?: string
}

export type RuntimeAcpProcessIdentity = {
  launchId: string
  processId: string
  supervisorIdentityDigest: string
}

export type RuntimeAcpProcessOutput = {
  stream: 'stdout' | 'stderr'
  data: Uint8Array
}

export type RuntimeAcpProcessReconciliation = {
  identity: RuntimeAcpProcessIdentity
  state:
    | 'starting'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | 'outcome-unknown'
  processTree: 'running' | 'empty' | 'unknown'
}

export type RuntimeAcpProcessStopReason =
  | 'binding-closed'
  | 'controller-disconnected'
  | 'deadline-exceeded'
  | 'identity-conflict'
  | 'output-quota'
  | 'user-cancelled'

export type RuntimeAcpProcessOwner = {
  identity: RuntimeAcpProcessIdentity
  beginPrompt(input: {
    deadlineAt: string
    maximumInputBytes: number
  }): void | Promise<void>
  completePrompt(): void | Promise<void>
  writeStdin(payload: Uint8Array): void | Promise<void>
  stop(input: {
    reason: RuntimeAcpProcessStopReason
    deadlineAt: string
  }): void | Promise<void>
  reconcile(): RuntimeAcpProcessReconciliation | Promise<RuntimeAcpProcessReconciliation>
  subscribeOutput(
    listener: (output: RuntimeAcpProcessOutput) => void | Promise<void>
  ): void | (() => void)
  subscribeExit?(
    listener: () => void | Promise<void>
  ): void | (() => void)
}

export type RuntimeAcpProcessLaunch = {
  manifest: RemoteRuntimeBundleManifest
  bundle: RuntimeAcpVerifiedBundle
  workspace: RuntimeAcpWorkspace
  scratch: string
  workMode: 'ask' | 'execute'
  deadlineAt: string
  budget: RemotePromptOperationPreparation['budget']
  modelBridge?: {
    socketPath: string
    policy: ModelBridgePolicy
  }
}

export type RuntimeAcpBackendLimits = {
  maximumBindings: number
  maximumControllerBindings: number
  maximumLifetimeBindings: number
  maximumPendingControl: number
  maximumPendingInputPerBinding: number
  maximumPendingInputGlobal: number
  maximumPendingOutputPerBinding: number
  maximumPendingOutputGlobal: number
  maximumPendingOutputBytesPerBinding: number
  maximumPendingOutputBytesGlobal: number
  maximumOperationsPerBinding: number
}

export type RuntimeAcpBackendOptions = {
  journal: RuntimeAcpJournal
  resolveRuntimeBundle(
    runtimeId: string,
    runtimeBundleDigest: string
  ): RuntimeAcpResolvedBundle | Promise<RuntimeAcpResolvedBundle>
  loadRegisteredRuntimeBundle(
    resolved: RuntimeAcpResolvedBundle,
    preparation: RemotePromptOperationPreparation
  ): RuntimeAcpVerifiedBundle | Promise<RuntimeAcpVerifiedBundle>
  resolveWorkspace(
    preparation: RemotePromptOperationPreparation,
    context: ProtocolMethodContext
  ): RuntimeAcpWorkspace | Promise<RuntimeAcpWorkspace>
  launchProcess(
    launch: RuntimeAcpProcessLaunch
  ): RuntimeAcpProcessOwner | Promise<RuntimeAcpProcessOwner>
  outputSink(
    frame: AgentFrame,
    context: {
      bindingId: string
      controllerId: string
      controllerGeneration: number
    }
  ): void | Promise<void>
  blobSink?: (
    frame: AgentFrame,
    context: {
      bindingId: string
      controllerId: string
      controllerGeneration: number
    }
  ) => void | Promise<void>
  createModelBridgeBroker?: (options: {
    bridgeDirectory: string
    dispatch: ModelBridgeBrokerDispatch
  }) => ModelBridgeBrokerServer
  semanticPrompts?: SemanticPromptStore
  modelGateway?: AgentModelGateway
  diagnostics?: Pick<AgentDiagnosticLog, 'tryRecord'>
  now?: () => number
  limits?: Partial<RuntimeAcpBackendLimits>
}

type PreparedOperation = {
  preparationDigest: string
  acceptance: RemotePromptOperationAcceptance
  budget: RemotePromptOperationPreparation['budget']
  completion?: z.infer<typeof acpCompletePromptResultSchema>
  terminalState?: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  modelProfile?: AgentPromptModelProfile
  promptSequence: number
  ownedPromptStarted?: boolean
}

type BindingState = {
  request: z.infer<typeof acpOpenChannelRequestSchema>
  openResult: z.infer<typeof acpOpenChannelResultSchema>
  controllerId: string
  controllerGeneration: number
  connectionId: string
  transportState: 'live' | 'detached' | 'replaying'
  resolvedBundle: RuntimeAcpResolvedBundle
  state: 'open' | 'running' | 'stopping' | 'closed' | 'outcome-unknown'
  workMode?: 'ask' | 'execute'
  process?: RuntimeAcpProcessOwner
  unsubscribeOutput?: () => void
  unsubscribeExit?: () => void
  stopRequested: boolean
  operations: Map<string, PreparedOperation>
  activeOperationId?: string
  terminalState?: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  inputBytes: number
  nextOutputSequence: bigint
  pendingInput: number
  pendingOutput: number
  pendingOutputBytes: number
  inputTail: Promise<void>
  outputTail: Promise<void>
  deadlineTimer?: NodeJS.Timeout
  ownedPromptStartTimer?: NodeJS.Timeout
  modelBridgePolicy?: ModelBridgePolicy
  modelBridgeClient?: ModelBridgeBlobClient
  modelBridgeBroker?: ModelBridgeBrokerServer
  ownedAcp?: AgentOwnedAcpPrompt
  workspaceDirectory?: string
  nextModelRound: number
  poisoned: boolean
}

export class RuntimeAcpBackend {
  readonly methods: Readonly<Record<string, ProtocolMethodHandler>>
  readonly #options: RuntimeAcpBackendOptions
  readonly #limits: RuntimeAcpBackendLimits
  readonly #bindings = new Map<string, BindingState>()
  readonly #processIdentityBindings = new Map<string, string>()
  readonly #boundConnectionSignals = new WeakSet<AbortSignal>()
  #nextChannelEpoch: bigint
  #lifetimeBindings = 0
  #pendingControl = 0
  #pendingInputGlobal = 0
  #pendingOutputGlobal = 0
  #pendingOutputBytesGlobal = 0
  #controlTail: Promise<void> = Promise.resolve()
  #disposed = false
  #disposePromise?: Promise<void>

  constructor(options: RuntimeAcpBackendOptions) {
    this.#options = options
    this.#limits = {
      maximumBindings: boundedLimit(
        options.limits?.maximumBindings,
        DEFAULT_MAXIMUM_BINDINGS
      ),
      maximumControllerBindings: boundedLimit(
        options.limits?.maximumControllerBindings,
        DEFAULT_MAXIMUM_CONTROLLER_BINDINGS
      ),
      maximumLifetimeBindings: boundedLimit(
        options.limits?.maximumLifetimeBindings,
        DEFAULT_MAXIMUM_LIFETIME_BINDINGS
      ),
      maximumPendingControl: boundedLimit(
        options.limits?.maximumPendingControl,
        DEFAULT_MAXIMUM_PENDING_CONTROL
      ),
      maximumPendingInputPerBinding: boundedLimit(
        options.limits?.maximumPendingInputPerBinding,
        DEFAULT_MAXIMUM_PENDING_INPUT_PER_BINDING
      ),
      maximumPendingInputGlobal: boundedLimit(
        options.limits?.maximumPendingInputGlobal,
        DEFAULT_MAXIMUM_PENDING_INPUT_GLOBAL
      ),
      maximumPendingOutputPerBinding: boundedLimit(
        options.limits?.maximumPendingOutputPerBinding,
        DEFAULT_MAXIMUM_PENDING_OUTPUT_PER_BINDING
      ),
      maximumPendingOutputGlobal: boundedLimit(
        options.limits?.maximumPendingOutputGlobal,
        DEFAULT_MAXIMUM_PENDING_OUTPUT_GLOBAL
      ),
      maximumPendingOutputBytesPerBinding: boundedLimit(
        options.limits?.maximumPendingOutputBytesPerBinding,
        DEFAULT_MAXIMUM_PENDING_OUTPUT_BYTES_PER_BINDING
      ),
      maximumPendingOutputBytesGlobal: boundedLimit(
        options.limits?.maximumPendingOutputBytesGlobal,
        DEFAULT_MAXIMUM_PENDING_OUTPUT_BYTES_GLOBAL
      ),
      maximumOperationsPerBinding: boundedLimit(
        options.limits?.maximumOperationsPerBinding,
        DEFAULT_MAXIMUM_OPERATIONS_PER_BINDING
      )
    }
    const initialEpoch = Math.max(1, Math.trunc(options.now?.() ?? Date.now()))
    this.#nextChannelEpoch = BigInt(
      Math.min(initialEpoch, Number.MAX_SAFE_INTEGER - 1)
    )
    this.methods = {
      'runtime/openAcpChannel': (params, context) =>
        this.#enqueuePublicControl(() => this.#open(params, context)),
      'runtime/closeAcpChannel': (params, context) =>
        this.#enqueuePublicControl(() => this.#close(params, context)),
      'runtime/resumeAcpChannel': (params, context) =>
        this.#enqueuePublicControl(() => this.#resume(params, context)),
      'runtime/replayAcpChannel': (params, context) =>
        this.#enqueuePublicControl(() => this.#replay(params, context)),
      'runtime/preparePrompt': (params, context) =>
        this.#enqueuePublicControl(() => this.#prepare(params, context)),
      'runtime/startPrompt': (params, context) =>
        this.#enqueuePublicControl(() => this.#startOwnedPrompt(params, context)),
      'runtime/attachPrompt': (params, context) =>
        this.#enqueuePublicControl(() => this.#attachOwnedPrompt(params, context)),
      'runtime/pagePromptTranscript': (params, context) =>
        this.#enqueuePublicControl(() => this.#pageOwnedPrompt(params, context)),
      'runtime/ackPromptTranscript': (params, context) =>
        this.#enqueuePublicControl(() => this.#ackOwnedPrompt(params, context)),
      'runtime/completePrompt': (params, context) =>
        this.#enqueuePublicControl(() => this.#complete(params, context)),
      'runtime/getAcpCursors': (params, context) =>
        this.#enqueuePublicControl(() => this.#getCursors(params, context)),
      'runtime/escalateCancellation': (params, context) =>
        this.#enqueuePublicControl(() => this.#escalate(params, context)),
      'runtime/reconcilePrompt': (params, context) =>
        this.#enqueuePublicControl(() => this.#reconcile(params, context))
    }
  }

  readonly onAcpFrame = async (
    frame: AgentFrame,
    context: ProtocolMethodContext
  ): Promise<void> => {
    this.#assertNotDisposed()
    if (
      frame.header.kind !== 'acp' ||
      frame.header.direction !== 'main-to-agent'
    ) {
      throw new RuntimeAcpBackendError(
        'Invalid ACP frame direction or kind',
        'identity'
      )
    }
    const binding = this.#bindingForContext(frame.header.channelId, context)
    if (
      context.channelId !== binding.request.bindingId ||
      frame.header.channelEpoch !== binding.openResult.channelEpoch ||
      frame.header.connectionId !== binding.connectionId ||
      frame.header.generation !== binding.controllerGeneration
    ) {
      throw new RuntimeAcpBackendError(
        'ACP frame identity does not match its binding',
        'identity'
      )
    }
    if (
      binding.process === undefined ||
      binding.state !== 'running' ||
      binding.transportState !== 'live'
    ) {
      throw new RuntimeAcpBackendError(
        'ACP Runtime process is not running',
        'closed'
      )
    }
    this.#assertBeforeDeadline(binding)
    const cursor = this.#cursor(binding, 'main-to-runtime')
    if (
      cursor !== undefined &&
      BigInt(cursor.deliveredSequence) >= BigInt(frame.header.sequence)
    ) {
      return
    }
    if (
      cursor === undefined ||
      BigInt(cursor.journaledSequence) < BigInt(frame.header.sequence)
    ) {
      throw new RuntimeAcpBackendError(
        'ACP input was not durably journaled before delivery',
        'identity'
      )
    }
    if (
      binding.inputBytes + frame.payload.byteLength >
      this.#activeBudget(binding).maximumInputBytes
    ) {
      throw new RuntimeAcpBackendError(
        'ACP input quota reached',
        'capacity'
      )
    }
    await this.#enqueueInput(binding, async () => {
      try {
        await binding.process!.writeStdin(frame.payload)
      } catch {
        throw new RuntimeAcpBackendError(
          'Runtime input delivery failed',
          'process'
        )
      }
      binding.inputBytes += frame.payload.byteLength
    })
  }

  readonly onBlobFrame = async (
    frame: AgentFrame,
    context: ProtocolMethodContext
  ): Promise<void> => {
    this.#assertNotDisposed()
    if (
      frame.header.kind !== 'blob' ||
      frame.header.direction !== 'main-to-agent'
    ) {
      throw new RuntimeAcpBackendError(
        'Invalid model bridge frame direction or kind',
        'identity'
      )
    }
    const matches = [...this.#bindings.values()].filter(
      (binding) =>
        binding.controllerId === context.controller.controllerId &&
        binding.controllerGeneration === context.controller.generation &&
        binding.connectionId === context.controller.connectionId &&
        binding.modelBridgeClient?.binding.channelId ===
          frame.header.channelId
    )
    if (matches.length !== 1) {
      throw new RuntimeAcpBackendError(
        'Blob channel has no exact active model bridge authority',
        'identity'
      )
    }
    const binding = matches[0]!
    if (
      binding.poisoned ||
      binding.activeOperationId === undefined ||
      context.channelId !== frame.header.channelId
    ) {
      throw new RuntimeAcpBackendError(
        'Blob frame is not authorized for an active prompt',
        'identity'
      )
    }
    try {
      await binding.modelBridgeClient!.onBlobFrame(frame)
    } catch (error) {
      if (
        error instanceof ModelBridgeClientError &&
        (error.poisoned || error.outcomeUnknown)
      ) {
        await this.#poisonBinding(binding)
      }
      throw error
    }
  }

  readonly authorizeBlobFrame = (
    frame: AgentFrame,
    controller: {
      controllerId: string
      connectionId: string
      generation: number
    }
  ): boolean =>
    frame.header.kind === 'blob' &&
    frame.header.direction === 'agent-to-main' &&
    [...this.#bindings.values()].some(
      (binding) =>
        !binding.poisoned &&
        binding.activeOperationId !== undefined &&
        binding.controllerId === controller.controllerId &&
        binding.controllerGeneration === controller.generation &&
        binding.connectionId === controller.connectionId &&
        binding.modelBridgeClient?.binding.channelId ===
          frame.header.channelId &&
        binding.modelBridgeClient.binding.channelEpoch ===
          frame.header.channelEpoch &&
        frame.header.connectionId === binding.connectionId &&
        frame.header.generation === binding.controllerGeneration
    )

  dispose(timeoutMs = DEFAULT_DISPOSE_TIMEOUT_MS): Promise<void> {
    if (this.#disposePromise !== undefined) {
      return this.#disposePromise
    }
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 60_000
    ) {
      return Promise.reject(
        new RangeError('Invalid Runtime backend disposal timeout')
      )
    }
    this.#disposed = true
    const cleanup = this.#controlTail
      .catch(() => undefined)
      .then(async () => {
        const results = await Promise.allSettled(
          [...this.#bindings.values()]
            .filter((binding) => binding.state !== 'closed')
            .map(async (binding) =>
              await this.#stopAndReconcile(
                binding,
                'binding-closed'
              )
            )
        )
        const failures = results
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === 'rejected'
          )
          .map((result) => result.reason)
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            'Runtime process shutdown did not reconcile every process tree'
          )
        }
      })
    this.#controlTail = cleanup
    this.#disposePromise = rejectAfter(
      cleanup,
      timeoutMs,
      'Runtime backend shutdown timed out'
    )
    return this.#disposePromise
  }

  async #open(
    params: unknown,
    context: ProtocolMethodContext
  ): Promise<z.infer<typeof acpOpenChannelResultSchema>> {
    const request = acpOpenChannelRequestSchema.parse(params)
    this.#assertControllerLive(context)
    const existing = this.#bindings.get(request.bindingId)
    if (existing !== undefined) {
      if (existing.poisoned) {
        throw new RuntimeAcpBackendError(
          'ACP binding was poisoned by uncertain model delivery',
          'process'
        )
      }
      if (canonicalJson(existing.request) !== canonicalJson(request)) {
        throw new RuntimeAcpBackendError(
          'ACP binding identity conflicts with an existing binding',
          'conflict'
        )
      }
      if (existing.controllerId !== context.controller.controllerId) {
        throw new RuntimeAcpBackendError(
          'ACP binding belongs to another controller',
          'stale-controller'
        )
      }
      if (existing.state !== 'closed' || existing.process !== undefined) {
        const ownedByCurrentConnection =
          existing.controllerGeneration ===
            context.controller.generation &&
          existing.connectionId ===
            context.controller.connectionId
        if (ownedByCurrentConnection) {
          return acpOpenChannelResultSchema.parse(existing.openResult)
        }
        const canReplaceDetachedIdleBinding =
          context.controllerTakeoverProven === true &&
          context.controller.generation >
            existing.controllerGeneration &&
          existing.transportState === 'detached' &&
          existing.activeOperationId === undefined &&
          (existing.state === 'open' ||
            existing.state === 'running')
        const canReattachDetachedOwnedPrompt =
          context.controllerTakeoverProven === true &&
          context.controller.generation >
            existing.controllerGeneration &&
          existing.transportState === 'detached' &&
          existing.activeOperationId !== undefined &&
          this.#options.semanticPrompts !== undefined &&
          existing.operations.get(existing.activeOperationId)
            ?.modelProfile !== undefined &&
          existing.state === 'running'
        if (canReattachDetachedOwnedPrompt) {
          existing.controllerGeneration = context.controller.generation
          existing.connectionId = context.controller.connectionId
          existing.transportState = 'live'
          this.#bindConnectionLifetime(existing, context.signal)
          return acpOpenChannelResultSchema.parse(existing.openResult)
        }
        if (!canReplaceDetachedIdleBinding) {
          this.#assertBindingOwner(existing, context)
        }
        await Promise.all([
          existing.inputTail,
          existing.outputTail
        ])
        await this.#stopAndReconcile(existing, 'binding-closed')
      }
      this.#assertOpenCapacity(context.controller.controllerId)
      const channelEpoch = this.#allocateChannelEpoch()
      existing.openResult = acpOpenChannelResultSchema.parse({
        bindingId: request.bindingId,
        channelId: request.bindingId,
        channelEpoch,
        acpCapabilitiesDigest:
          existing.resolvedBundle.entry.acpCapabilitiesDigest
      })
      existing.controllerGeneration = context.controller.generation
      existing.connectionId = context.controller.connectionId
      existing.transportState = 'live'
      existing.state = 'open'
      existing.stopRequested = false
      existing.terminalState = undefined
      existing.inputBytes = 0
      existing.nextOutputSequence = 1n
      existing.pendingInput = 0
      existing.pendingOutput = 0
      existing.pendingOutputBytes = 0
      existing.inputTail = Promise.resolve()
      existing.outputTail = Promise.resolve()
      existing.nextModelRound = 0
      this.#bindConnectionLifetime(existing, context.signal)
      return existing.openResult
    }
    this.#assertOpenCapacity(context.controller.controllerId)
    let resolved: RuntimeAcpResolvedBundle
    try {
      resolved = await this.#options.resolveRuntimeBundle(
        request.runtimeId,
        request.runtimeBundleDigest
      )
    } catch {
      throw new RuntimeAcpBackendError(
        'Runtime bundle is not trusted',
        'untrusted-runtime'
      )
    }
    if (
      resolved.entry.runtimeId !== request.runtimeId ||
      resolved.entry.bundleDigest !== request.runtimeBundleDigest
    ) {
      throw new RuntimeAcpBackendError(
        'Resolved Runtime bundle identity does not match',
        'untrusted-runtime'
      )
    }
    const channelEpoch = this.#allocateChannelEpoch()
    const openResult = acpOpenChannelResultSchema.parse({
      bindingId: request.bindingId,
      channelId: request.bindingId,
      channelEpoch,
      acpCapabilitiesDigest: resolved.entry.acpCapabilitiesDigest
    })
    const binding: BindingState = {
      request,
      openResult,
      controllerId: context.controller.controllerId,
      controllerGeneration: context.controller.generation,
      connectionId: context.controller.connectionId,
      transportState: 'live',
      resolvedBundle: resolved,
      state: 'open',
      stopRequested: false,
      operations: new Map(),
      inputBytes: 0,
      nextOutputSequence: 1n,
      pendingInput: 0,
      pendingOutput: 0,
      pendingOutputBytes: 0,
      inputTail: Promise.resolve(),
      outputTail: Promise.resolve(),
      nextModelRound: 0,
      poisoned: false
    }
    this.#bindings.set(request.bindingId, binding)
    this.#lifetimeBindings += 1
    this.#bindConnectionLifetime(binding, context.signal)
    return openResult
  }

  async #close(
    params: unknown,
    context: ProtocolMethodContext
  ): Promise<z.infer<typeof acpCloseChannelResultSchema>> {
    const request = acpCloseChannelRequestSchema.parse(params)
    const binding = this.#bindingForContext(request.bindingId, context)
    if (
      request.channelId !== binding.openResult.channelId ||
      request.channelEpoch !== binding.openResult.channelEpoch
    ) {
      throw new RuntimeAcpBackendError(
        'ACP close identity does not match its binding',
        'identity'
      )
    }
    if (binding.state !== 'closed') {
      await this.#stopAndReconcile(
        binding,
        request.reason === 'cancelled'
          ? 'user-cancelled'
          : 'binding-closed'
      )
    }
    return acpCloseChannelResultSchema.parse({
      bindingId: request.bindingId,
      channelEpoch: request.channelEpoch,
      closed: true
    })
  }

  async #resume(
    params: unknown,
    context: ProtocolMethodContext
  ): Promise<z.infer<typeof acpResumeChannelResultSchema>> {
    const request = acpResumeChannelRequestSchema.parse(params)
    this.#assertControllerLive(context)
    const binding = this.#bindings.get(request.bindingId)
    if (binding === undefined) {
      throw new RuntimeAcpBackendError(
        'ACP binding does not exist',
        'not-found'
      )
    }
    if (
      binding.controllerId !== context.controller.controllerId ||
      context.controller.generation <= binding.controllerGeneration ||
      request.channelId !== binding.openResult.channelId ||
      request.channelEpoch !== binding.openResult.channelEpoch
    ) {
      throw new RuntimeAcpBackendError(
        'ACP resume identity does not exactly match its binding',
        'identity'
      )
    }
    if (
      binding.transportState !== 'detached' ||
      binding.process === undefined ||
      binding.state !== 'running' ||
      binding.poisoned
    ) {
      throw new RuntimeAcpBackendError(
        'ACP binding is not detached and resumable',
        'conflict'
      )
    }
    this.#assertBeforeDeadline(binding)
    await binding.outputTail.catch(() => undefined)
    let reconciliation: RuntimeAcpProcessReconciliation
    try {
      reconciliation = await binding.process.reconcile()
    } catch {
      throw new RuntimeAcpBackendError(
        'Runtime process reconciliation failed',
        'process'
      )
    }
    if (
      !sameProcessIdentity(binding.process.identity, reconciliation.identity) ||
      reconciliation.processTree !== 'running' ||
      reconciliation.state !== 'running'
    ) {
      throw new RuntimeAcpBackendError(
        'Detached Runtime process identity or state cannot be proven',
        'identity'
      )
    }
    binding.controllerGeneration = context.controller.generation
    binding.connectionId = context.controller.connectionId
    binding.transportState = 'replaying'
    this.#bindConnectionLifetime(binding, context.signal)
    const acceptance = this.#activeAcceptance(binding)!
    return acpResumeChannelResultSchema.parse({
      bindingId: binding.request.bindingId,
      channelId: binding.openResult.channelId,
      channelEpoch: binding.openResult.channelEpoch,
      deadlineAt: acceptance.deadlineAt,
      cursors: this.#bindingCursors(binding)
    })
  }

  async #replay(
    params: unknown,
    context: ProtocolMethodContext
  ): Promise<z.infer<typeof acpReplayChannelResultSchema>> {
    const request = acpReplayChannelRequestSchema.parse(params)
    const binding = this.#bindingForContext(request.bindingId, context)
    if (
      request.channelId !== binding.openResult.channelId ||
      request.channelEpoch !== binding.openResult.channelEpoch ||
      binding.transportState !== 'replaying'
    ) {
      throw new RuntimeAcpBackendError(
        'ACP replay identity or phase does not match its binding',
        'identity'
      )
    }
    this.#assertBeforeDeadline(binding)
    const initialCursor = this.#cursor(binding, 'runtime-to-main')
    if (
      BigInt(request.acknowledgedSequence) >
      BigInt(initialCursor?.journaledSequence ?? ZERO_CURSOR)
    ) {
      throw new RuntimeAcpBackendError(
        'ACP replay ACK exceeds durable output',
        'identity'
      )
    }
    this.#options.journal.acknowledgeAcpFromMain?.({
      bindingId: binding.request.bindingId,
      channelEpoch: binding.openResult.channelEpoch,
      sequence: request.acknowledgedSequence
    })
    if (this.#options.journal.replayAcpFrames === undefined) {
      throw new RuntimeAcpBackendError(
        'Durable ACP replay is unavailable',
        'process'
      )
    }
    let replayedThrough = request.acknowledgedSequence
    for (;;) {
      const frames = this.#options.journal.replayAcpFrames({
        bindingId: binding.request.bindingId,
        channelEpoch: binding.openResult.channelEpoch,
        direction: 'runtime-to-main',
        afterSequence: replayedThrough,
        limit: AGENT_PROTOCOL_LIMITS.runPendingEvents
      })
      for (const replay of frames) {
        await this.#deliverOutput(binding, replay.sequence, replay.payload)
        replayedThrough = replay.sequence
      }
      const cursor = this.#cursor(binding, 'runtime-to-main')
      if (
        frames.length === 0 ||
        BigInt(replayedThrough) >=
          BigInt(cursor?.journaledSequence ?? ZERO_CURSOR)
      ) {
        break
      }
    }
    binding.transportState = 'live'
    return acpReplayChannelResultSchema.parse({
      bindingId: binding.request.bindingId,
      channelId: binding.openResult.channelId,
      channelEpoch: binding.openResult.channelEpoch,
      replayedThroughSequence: replayedThrough,
      live: true
    })
  }

  async #prepare(
    params: unknown,
    context: ProtocolMethodContext
  ): Promise<RemotePromptOperationAcceptance> {
    const preparation = remotePromptOperationPreparationSchema.parse(params)
    const binding = this.#bindingForContext(preparation.bindingId, context)
    this.#assertPreparationIdentity(binding, preparation, context)
    this.#assertBeforeDeadline(binding, preparation.deadlineAt)
    const preparationDigest = digestSecretBearingPreparation(preparation)
    const existing = binding.operations.get(preparation.operationId)
    if (existing !== undefined) {
      if (existing.preparationDigest !== preparationDigest) {
        throw new RuntimeAcpBackendError(
          'Prompt operation identity is already bound to different content',
          'conflict'
        )
      }
      return remotePromptOperationAcceptanceSchema.parse(
        existing.acceptance
      )
    }
    if (binding.activeOperationId !== undefined) {
      throw new RuntimeAcpBackendError(
        'Another prompt operation is still active',
        'conflict'
      )
    }
    if (
      binding.operations.size >=
      this.#limits.maximumOperationsPerBinding
    ) {
      throw new RuntimeAcpBackendError(
        'ACP binding operation lifetime is exhausted',
        'capacity'
      )
    }
    if (
      binding.workMode !== undefined &&
      binding.workMode !== preparation.workMode
    ) {
      throw new RuntimeAcpBackendError(
        'Runtime process work mode cannot change',
        'conflict'
      )
    }

    let verified: RuntimeAcpVerifiedBundle
    try {
      verified = await this.#options.loadRegisteredRuntimeBundle(
        binding.resolvedBundle,
        preparation
      )
    } catch {
      throw new RuntimeAcpBackendError(
        'Runtime verification failed',
        'untrusted-runtime'
      )
    }
    let workspace: RuntimeAcpWorkspace
    try {
      workspace = await this.#options.resolveWorkspace(
        preparation,
        context
      )
    } catch {
      throw new RuntimeAcpBackendError(
        'Workspace verification failed',
        'workspace'
      )
    }
    this.#assertVerifiedIdentity(binding, preparation, verified)
    if (workspace.workspaceIdentity !== preparation.workspaceIdentity) {
      throw new RuntimeAcpBackendError(
        'Workspace identity does not match its binding',
        'workspace'
      )
    }
    if (binding.poisoned) {
      throw new RuntimeAcpBackendError(
        'ACP binding was poisoned by uncertain model delivery',
        'process'
      )
    }
    const agentGatewayPolicy =
      this.#options.modelGateway !== undefined &&
      preparation.modelProfile !== undefined
        ? modelBridgePolicySchema.parse({
            protocol: preparation.modelProfile.protocol,
            model: preparation.modelProfile.model,
            modelProfileDigest:
              preparation.modelProfile.modelProfileDigest,
            supportsImageInput:
              preparation.modelProfile.capabilities.imageInput
          })
        : undefined
    if (
      agentGatewayPolicy !== undefined &&
      preparation.modelBridge !== undefined &&
      canonicalJson(agentGatewayPolicy) !==
        canonicalJson(preparation.modelBridge.policy)
    ) {
      throw new RuntimeAcpBackendError(
        'Prompt model profile does not match its persisted policy',
        'identity'
      )
    }
    const requestedModelBridgePolicy =
      agentGatewayPolicy ?? preparation.modelBridge?.policy
    if (
      requestedModelBridgePolicy !== undefined &&
      binding.modelBridgePolicy !== undefined &&
      canonicalJson(binding.modelBridgePolicy) !==
        canonicalJson(requestedModelBridgePolicy)
    ) {
      throw new RuntimeAcpBackendError(
        'Model bridge policy cannot change within a Runtime binding',
        'conflict'
      )
    }
    if (
      preparation.modelBridge !== undefined &&
      agentGatewayPolicy === undefined
    ) {
      for (const candidate of this.#bindings.values()) {
        if (
          candidate !== binding &&
          candidate.modelBridgeClient?.binding.channelId ===
            preparation.modelBridge.channelId
        ) {
          throw new RuntimeAcpBackendError(
            'Model bridge channel is already bound',
            'conflict'
          )
        }
      }
    }
    if (requestedModelBridgePolicy !== undefined) {
      await this.#startModelBridge(binding, preparation, workspace)
    }
    const acceptedAt = new Date(this.#now()).toISOString()
    const acceptance = remotePromptOperationAcceptanceSchema.parse({
      bindingId: preparation.bindingId,
      operationId: preparation.operationId,
      requestId: preparation.requestId,
      workMode: preparation.workMode,
      deadlineAt: preparation.deadlineAt,
      acceptedAt
    })

    if (binding.process === undefined) {
      let process: RuntimeAcpProcessOwner
      this.#options.diagnostics?.tryRecord('runtime.starting', {
        runtimeId: verified.manifest.runtimeId,
        workMode: preparation.workMode
      })
      try {
        process = await this.#options.launchProcess({
          manifest: verified.manifest,
          bundle: verified,
          workspace,
          scratch: workspace.scratchDirectory,
          workMode: preparation.workMode,
          deadlineAt: preparation.deadlineAt,
          budget: preparation.budget,
          ...(binding.modelBridgePolicy === undefined ||
          binding.modelBridgeBroker === undefined
            ? {}
            : {
                modelBridge: {
                  socketPath: binding.modelBridgeBroker.socketPath,
                  policy: binding.modelBridgePolicy
                }
              })
        })
        assertProcessIdentity(process.identity)
      } catch (error) {
        this.#options.diagnostics?.tryRecord('runtime.start.failed', {
          runtimeId: verified.manifest.runtimeId,
          workMode: preparation.workMode,
          error
        })
        await this.#closeModelBridge(binding, false).catch(
          () => undefined
        )
        throw new RuntimeAcpBackendError(
          'Runtime process launch failed',
          'process'
        )
      }
      const processKey = processIdentityKey(process.identity)
      const identityOwner = this.#processIdentityBindings.get(processKey)
      if (
        identityOwner !== undefined &&
        identityOwner !== binding.request.bindingId
      ) {
        await Promise.resolve(
          process.stop({
            reason: 'identity-conflict',
            deadlineAt: new Date(this.#now() + 10_000).toISOString()
          })
        ).catch(() => undefined)
        await Promise.resolve(process.reconcile()).catch(() => undefined)
        throw new RuntimeAcpBackendError(
          'Supervised process identity is already bound',
          'identity'
        )
      }
      this.#processIdentityBindings.set(
        processKey,
        binding.request.bindingId
      )
      binding.process = process
      binding.workspaceDirectory = workspace.workspaceDirectory
      binding.workMode = preparation.workMode
      binding.state = 'running'
      binding.operations.set(preparation.operationId, {
        preparationDigest,
        acceptance,
        budget: preparation.budget,
        modelProfile: preparation.modelProfile,
        promptSequence: preparation.promptSequence
      })
      try {
        if (
          preparation.modelProfile === undefined ||
          this.#options.modelGateway === undefined ||
          this.#options.semanticPrompts === undefined
        ) {
          const unsubscribe = process.subscribeOutput((output) =>
            this.#acceptProcessOutput(binding, output)
          )
          if (unsubscribe !== undefined) {
            binding.unsubscribeOutput = unsubscribe
          }
        }
        const unsubscribeExit = process.subscribeExit?.(() => {
          void this.#enqueueControl(async () => {
            await this.#handleProcessExit(binding)
          }).catch(() => undefined)
        })
        if (unsubscribeExit !== undefined) {
          binding.unsubscribeExit = unsubscribeExit
        }
      } catch {
        binding.operations.delete(preparation.operationId)
        await this.#stopAndReconcile(binding, 'identity-conflict').catch(
          () => undefined
        )
        throw new RuntimeAcpBackendError(
          'Runtime output subscription failed',
          'process'
        )
      }
      this.#options.diagnostics?.tryRecord('runtime.started', {
        runtimeId: verified.manifest.runtimeId,
        workMode: preparation.workMode
      })
    } else {
      try {
        await binding.process.beginPrompt({
          deadlineAt: preparation.deadlineAt,
          maximumInputBytes: preparation.budget.maximumInputBytes
        })
      } catch {
        await this.#closeModelBridge(binding, false).catch(
          () => undefined
        )
        throw new RuntimeAcpBackendError(
          'Runtime prompt budget could not be renewed',
          'process'
        )
      }
    }
    binding.inputBytes = 0
    if (!binding.operations.has(preparation.operationId)) {
      binding.operations.set(preparation.operationId, {
        preparationDigest,
        acceptance,
        budget: preparation.budget,
        modelProfile: preparation.modelProfile,
        promptSequence: preparation.promptSequence
      })
    }
    this.#options.semanticPrompts?.prepare({
      bindingId: preparation.bindingId,
      operationId: preparation.operationId,
      requestId: preparation.requestId,
      controllerId: binding.controllerId,
      preparationDigest,
      promptSequence: preparation.promptSequence
    })
    binding.activeOperationId = preparation.operationId
    binding.nextModelRound = 0
    if (
      preparation.modelProfile !== undefined &&
      this.#options.modelGateway !== undefined &&
      this.#options.semanticPrompts !== undefined
    ) {
      this.#scheduleOwnedPromptStart(
        binding,
        preparation.operationId
      )
    }
    this.#scheduleDeadline(binding, preparation.deadlineAt)
    return acceptance
  }

  async #complete(
    params: unknown,
    context: ProtocolMethodContext
  ): Promise<z.infer<typeof acpCompletePromptResultSchema>> {
    const operation = promptCompletionSchema.parse(params)
    const binding = this.#bindingForContext(operation.bindingId, context)
    if (
      operation.operationId !== operation.requestId ||
      !binding.operations.has(operation.operationId)
    ) {
      throw new RuntimeAcpBackendError(
        'Prompt completion identity does not match a prepared operation',
        'identity'
      )
    }
    const prepared = binding.operations.get(operation.operationId)!
    if (prepared.completion !== undefined) {
      return acpCompletePromptResultSchema.parse(prepared.completion)
    }
    if (
      binding.activeOperationId !== operation.operationId ||
      binding.process === undefined ||
      binding.state !== 'running'
    ) {
      throw new RuntimeAcpBackendError(
        'Prompt completion conflicts with the active operation',
        'conflict'
      )
    }
    if (binding.ownedAcp !== undefined) {
      throw new RuntimeAcpBackendError(
        'Agent-owned prompt completion is independent of Desktop ACK',
        'conflict'
      )
    }
    await this.#closeModelBridge(binding, true)
    if (binding.poisoned) {
      throw new RuntimeAcpBackendError(
        'Model response delivery was not proven before prompt completion',
        'process'
      )
    }
    try {
      await binding.process.completePrompt()
    } catch {
      throw new RuntimeAcpBackendError(
        'Runtime prompt completion failed',
        'process'
      )
    }
    const completion = acpCompletePromptResultSchema.parse({
      bindingId: operation.bindingId,
      operationId: operation.operationId,
      requestId: operation.requestId,
      status: 'completed',
      processTree: 'running'
    })
    prepared.completion = completion
    binding.activeOperationId = undefined
    binding.inputBytes = 0
    if (binding.deadlineTimer !== undefined) {
      clearTimeout(binding.deadlineTimer)
      binding.deadlineTimer = undefined
    }
    if (binding.ownedPromptStartTimer !== undefined) {
      clearTimeout(binding.ownedPromptStartTimer)
      binding.ownedPromptStartTimer = undefined
    }
    return completion
  }

  async #startOwnedPrompt(
    params: unknown,
    context: ProtocolMethodContext
  ) {
    const request = remoteOwnedPromptStartRequestSchema.parse(params)
    const binding = this.#bindingForContext(request.bindingId, context)
    const prepared = binding.operations.get(request.operationId)
    const existing = this.#options.semanticPrompts?.findStarted({
      bindingId: request.bindingId,
      operationId: request.operationId,
      controllerId: context.controller.controllerId,
      startDigest: `sha256:${createHash('sha256')
        .update(canonicalJson(request))
        .digest('hex')}`
    })
    if (existing !== undefined) {
      if (prepared !== undefined) {
        prepared.ownedPromptStarted = true
      }
      if (binding.ownedPromptStartTimer !== undefined) {
        clearTimeout(binding.ownedPromptStartTimer)
        binding.ownedPromptStartTimer = undefined
      }
      return existing
    }
    if (
      this.#options.semanticPrompts === undefined ||
      prepared === undefined ||
      binding.activeOperationId !== request.operationId ||
      binding.process === undefined ||
      binding.workspaceDirectory === undefined ||
      binding.state !== 'running'
    ) {
      throw new RuntimeAcpBackendError(
        'Agent-owned prompt was not prepared',
        'conflict'
      )
    }
    if (binding.ownedAcp === undefined) {
      binding.ownedAcp = new AgentOwnedAcpPrompt({
        bindingId: binding.request.bindingId,
        controllerId: binding.controllerId,
        workspaceDirectory: binding.workspaceDirectory,
        workMode: binding.workMode!,
        ...(binding.modelBridgePolicy === undefined
          ? {}
          : {
              expectedModel: openCodeModelBridgeModelId(
                binding.modelBridgePolicy.protocol,
                binding.modelBridgePolicy.model
              )
            }),
        process: binding.process,
        transcript: this.#options.semanticPrompts,
        completePrompt: async (operationId, status) => {
          await this.#enqueueControl(async () => {
            await this.#terminalizeOwnedPrompt(
              binding,
              operationId,
              status
            )
          })
        },
        resolveTerminalState: (status) =>
          binding.poisoned ? 'outcome-unknown' : status
      })
    }
    const result = await binding.ownedAcp.start(request)
    prepared.ownedPromptStarted = true
    if (binding.ownedPromptStartTimer !== undefined) {
      clearTimeout(binding.ownedPromptStartTimer)
      binding.ownedPromptStartTimer = undefined
    }
    return result
  }

  #attachOwnedPrompt(
    params: unknown,
    context: ProtocolMethodContext
  ) {
    const request = remoteOwnedPromptAttachRequestSchema.parse(params)
    this.#assertControllerLive(context)
    if (request.operationId !== request.requestId) {
      throw new RuntimeAcpBackendError(
        'Prompt attach identity does not match',
        'identity'
      )
    }
    if (this.#options.semanticPrompts === undefined) {
      throw new RuntimeAcpBackendError(
        'Semantic prompt recovery is unavailable',
        'process'
      )
    }
    const binding = this.#bindings.get(request.bindingId)
    if (
      binding === undefined ||
      binding.controllerId !== context.controller.controllerId
    ) {
      throw new RuntimeAcpBackendError(
        'Prompt attach binding does not exist for this controller',
        'not-found'
      )
    }
    if (
      binding.controllerGeneration !== context.controller.generation ||
      binding.connectionId !== context.controller.connectionId
    ) {
      if (
        context.controllerTakeoverProven !== true ||
        binding.transportState !== 'detached' ||
        context.controller.generation <= binding.controllerGeneration
      ) {
        throw new RuntimeAcpBackendError(
          'Prompt attach cannot take over this binding generation',
          'stale-controller'
        )
      }
      binding.controllerGeneration = context.controller.generation
      binding.connectionId = context.controller.connectionId
    }
    return this.#options.semanticPrompts.attach(
      request.bindingId,
      request.operationId,
      context.controller.controllerId
    )
  }

  #pageOwnedPrompt(
    params: unknown,
    context: ProtocolMethodContext
  ) {
    const request = remoteSemanticTranscriptPageRequestSchema.parse(params)
    this.#assertControllerLive(context)
    if (this.#options.semanticPrompts === undefined) {
      throw new RuntimeAcpBackendError(
        'Semantic prompt recovery is unavailable',
        'process'
      )
    }
    return this.#options.semanticPrompts.page({
      ...request,
      controllerId: context.controller.controllerId
    })
  }

  #ackOwnedPrompt(
    params: unknown,
    context: ProtocolMethodContext
  ) {
    const request = remoteSemanticTranscriptAckRequestSchema.parse(params)
    this.#assertControllerLive(context)
    if (this.#options.semanticPrompts === undefined) {
      throw new RuntimeAcpBackendError(
        'Semantic prompt recovery is unavailable',
        'process'
      )
    }
    return this.#options.semanticPrompts.acknowledge({
      ...request,
      controllerId: context.controller.controllerId
    })
  }

  async #terminalizeOwnedPrompt(
    binding: BindingState,
    operationId: string,
    status: 'completed' | 'failed' | 'cancelled' | 'outcome-unknown'
  ): Promise<void> {
    const prepared = binding.operations.get(operationId)
    if (
      prepared === undefined ||
      binding.activeOperationId !== operationId ||
      binding.process === undefined
    ) {
      return
    }
    await this.#closeModelBridge(binding, true)
    try {
      await binding.process.completePrompt()
    } catch {
      binding.state = 'outcome-unknown'
      prepared.modelProfile = undefined
      throw new RuntimeAcpBackendError(
        'Runtime prompt completion failed',
        'process'
      )
    }
    if (binding.poisoned || status === 'outcome-unknown') {
      binding.state = 'outcome-unknown'
      prepared.modelProfile = undefined
      await this.#stopAndReconcile(
        binding,
        'identity-conflict'
      ).catch(() => undefined)
      return
    }
    prepared.terminalState =
      status === 'cancelled'
        ? 'cancelled'
        : status === 'failed'
          ? 'failed'
          : 'completed'
    if (status === 'completed') {
      prepared.completion = acpCompletePromptResultSchema.parse({
        bindingId: binding.request.bindingId,
        operationId,
        requestId: prepared.acceptance.requestId,
        status: 'completed',
        processTree: 'running'
      })
    }
    prepared.modelProfile = undefined
    binding.activeOperationId = undefined
    binding.inputBytes = 0
    if (binding.deadlineTimer !== undefined) {
      clearTimeout(binding.deadlineTimer)
      binding.deadlineTimer = undefined
    }
    if (binding.ownedPromptStartTimer !== undefined) {
      clearTimeout(binding.ownedPromptStartTimer)
      binding.ownedPromptStartTimer = undefined
    }
  }

  async #startModelBridge(
    binding: BindingState,
    preparation: RemotePromptOperationPreparation,
    workspace: RuntimeAcpWorkspace
  ): Promise<void> {
    const bridge = preparation.modelBridge
    const useAgentGateway =
      this.#options.modelGateway !== undefined &&
      preparation.modelProfile !== undefined
    const policy = useAgentGateway
      ? modelBridgePolicySchema.parse({
          protocol: preparation.modelProfile!.protocol,
          model: preparation.modelProfile!.model,
          modelProfileDigest:
            preparation.modelProfile!.modelProfileDigest,
          supportsImageInput:
            preparation.modelProfile!.capabilities.imageInput
        })
      : bridge?.policy
    if (
      workspace.bridgeDirectory === undefined ||
      policy === undefined ||
      (
        !useAgentGateway &&
        (
          bridge === undefined ||
          bridge.channelId === binding.request.bindingId
        )
      )
    ) {
      throw new RuntimeAcpBackendError(
        'Managed model bridge composition is unavailable or invalid',
        'identity'
      )
    }
    if (
      binding.modelBridgeClient !== undefined ||
      binding.modelBridgeBroker !== undefined
    ) {
      throw new RuntimeAcpBackendError(
        'Another model bridge is still active',
        'conflict'
      )
    }
    const client = useAgentGateway ? undefined : new ModelBridgeBlobClient({
      binding: {
        bindingId: binding.request.bindingId,
        promptOperationId: preparation.operationId,
        controllerId: binding.controllerId,
        controllerGeneration: binding.controllerGeneration,
        connectionId: binding.connectionId,
        acpChannelEpoch: binding.openResult.channelEpoch,
        channelId: bridge!.channelId,
        channelEpoch: bridge!.channelEpoch,
        runtimeId: binding.request.runtimeId,
        workspaceIdentity: binding.request.workspaceIdentity,
        policy,
        deadlineAt: preparation.deadlineAt
      },
      sendBlobFrame: async (frame) =>
        await this.#options.blobSink!(frame, {
          bindingId: binding.request.bindingId,
          controllerId: binding.controllerId,
          controllerGeneration: binding.controllerGeneration
        }),
      onPoison: () => {
        binding.poisoned = true
        binding.state = 'outcome-unknown'
        void this.#enqueueControl(async () => {
          await this.#stopAndReconcile(
            binding,
            'identity-conflict'
          )
        }).catch(() => undefined)
      },
      now: this.#options.now
    })
    const dispatch: ModelBridgeBrokerDispatch = useAgentGateway
      ? async (request, context) => {
          const operation = binding.operations.get(
            preparation.operationId
          )
          const profile =
            operation?.modelProfile ?? preparation.modelProfile
          if (
            profile === undefined ||
            binding.activeOperationId !== preparation.operationId
          ) {
            throw new RuntimeAcpBackendError(
              'Prompt model credential is no longer active',
              'closed'
            )
          }
          const roundIndex = binding.nextModelRound
          let exchanged
          try {
            exchanged = await this.#options.modelGateway!.dispatch(
              {
                bindingId: binding.request.bindingId,
                operationId: preparation.operationId,
                promptSequence: preparation.promptSequence,
                roundIndex,
                profileDigest: policy.modelProfileDigest,
                profile
              },
              request,
              context.signal
            )
          } catch (error) {
            if (
              error instanceof AgentModelGatewayError &&
              ['cancelled', 'outcome-unknown', 'response-too-large', 'timeout']
                .includes(error.code)
            ) {
              binding.poisoned = true
              binding.state = 'outcome-unknown'
              void this.#enqueueControl(async () => {
                await this.#stopAndReconcile(
                  binding,
                  'identity-conflict'
                )
              }).catch(() => undefined)
            }
            throw error
          }
          return {
            response: exchanged.response,
            acknowledgeDelivery: async () => {
              try {
                await exchanged.acknowledgeDelivery()
                binding.nextModelRound += 1
              } catch (error) {
                binding.poisoned = true
                binding.state = 'outcome-unknown'
                throw error
              }
            },
            failDelivery: () => {
              binding.poisoned = true
              binding.state = 'outcome-unknown'
              exchanged.failDelivery()
            }
          }
        }
      : async (request, context) =>
          await client!.exchange(request, context)
    const broker =
      this.#options.createModelBridgeBroker?.({
        bridgeDirectory: workspace.bridgeDirectory,
        dispatch
      }) ??
      new ModelBridgeBrokerServer({
        scratchDirectory: workspace.bridgeDirectory,
        dispatch
      })
    binding.modelBridgeClient = client
    binding.modelBridgeBroker = broker
    binding.modelBridgePolicy = policy
    try {
      await broker.listen()
    } catch {
      binding.modelBridgeClient = undefined
      binding.modelBridgeBroker = undefined
      await client?.close({ poisonIfActive: false })
      throw new RuntimeAcpBackendError(
        'Managed model bridge broker could not start',
        'process'
      )
    }
  }

  async #closeModelBridge(
    binding: BindingState,
    poisonIfActive: boolean,
    preserveRuntime = false
  ): Promise<void> {
    const broker = binding.modelBridgeBroker
    const client = binding.modelBridgeClient
    binding.modelBridgeBroker = undefined
    binding.modelBridgeClient = undefined
    let brokerError: unknown
    try {
      await broker?.close()
    } catch (error) {
      brokerError = error
    }
    if (preserveRuntime && client?.active === true) {
      binding.poisoned = true
    }
    await client?.close({
      poisonIfActive: preserveRuntime ? false : poisonIfActive
    })
    if (brokerError !== undefined) {
      throw brokerError
    }
  }

  async #poisonBinding(binding: BindingState): Promise<void> {
    binding.poisoned = true
    binding.state = 'outcome-unknown'
    await this.#closeModelBridge(binding, true).catch(
      () => undefined
    )
    await this.#stopAndReconcile(
      binding,
      'identity-conflict'
    ).catch(() => undefined)
  }

  #getCursors(
    params: unknown,
    context: ProtocolMethodContext
  ): {
    lastOutboundJournaledSequence: string
    lastOutboundDeliveredSequence: string
    lastInboundJournaledSequence: string
    lastMainAckSequence: string
  } {
    const request = getCursorsRequestSchema.parse(params)
    const binding = this.#bindingForContext(request.bindingId, context)
    return this.#bindingCursors(binding)
  }

  #bindingCursors(binding: BindingState): {
    lastOutboundJournaledSequence: string
    lastOutboundDeliveredSequence: string
    lastInboundJournaledSequence: string
    lastMainAckSequence: string
  } {
    const outbound = this.#cursor(binding, 'main-to-runtime')
    const inbound = this.#cursor(binding, 'runtime-to-main')
    return {
      lastOutboundJournaledSequence:
        outbound?.journaledSequence ?? ZERO_CURSOR,
      lastOutboundDeliveredSequence:
        outbound?.deliveredSequence ?? ZERO_CURSOR,
      lastInboundJournaledSequence:
        inbound?.journaledSequence ?? ZERO_CURSOR,
      lastMainAckSequence: inbound?.mainAckSequence ?? ZERO_CURSOR
    }
  }

  async #escalate(
    params: unknown,
    context: ProtocolMethodContext
  ): Promise<{ bindingId: string; stopped: true }> {
    const escalation = cancellationEscalationSchema.parse(params)
    const binding = this.#bindingForContext(escalation.bindingId, context)
    if (
      binding.activeOperationId !== undefined &&
      (binding.activeOperationId !== escalation.operationId ||
        escalation.operationId !== escalation.requestId)
    ) {
      throw new RuntimeAcpBackendError(
        'Cancellation operation identity does not match',
        'identity'
      )
    }
    if (
      binding.activeOperationId !== undefined &&
      this.#options.semanticPrompts !== undefined
    ) {
      if (binding.ownedAcp !== undefined) {
        await rejectAfter(
          binding.ownedAcp.cancel(),
          OWNED_PROMPT_CANCEL_GRACE_MS,
          'Runtime prompt cancellation timed out'
        ).catch(() => undefined)
      }
      try {
        this.#options.semanticPrompts.append({
          bindingId: binding.request.bindingId,
          operationId: binding.activeOperationId,
          kind: 'prompt-terminal',
          payload: {
            status: 'cancelled',
            reason: escalation.reason
          },
          terminalState: 'cancelled'
        })
      } catch {
        // A concurrently completed prompt already committed terminal evidence.
      }
    }
    await this.#stopAndReconcile(binding, 'user-cancelled')
    return { bindingId: escalation.bindingId, stopped: true }
  }

  async #reconcile(
    params: unknown,
    context: ProtocolMethodContext
  ): Promise<
    | {
        status: 'terminal'
        terminalState:
          | 'completed'
          | 'failed'
          | 'cancelled'
          | 'interrupted'
        processTree: 'running' | 'empty'
      }
    | {
        status: 'running' | 'outcome-unknown'
        processTree: 'running' | 'unknown'
      }
  > {
    const operation = promptReconciliationSchema.parse(params)
    const binding = this.#bindingForContext(operation.bindingId, context)
    if (operation.operationId !== operation.requestId) {
      throw new RuntimeAcpBackendError(
        'Reconciliation operation identity does not match',
        'identity'
      )
    }
    const prepared = binding.operations.get(operation.operationId)
    if (prepared === undefined) {
      throw new RuntimeAcpBackendError(
        'Reconciliation operation was not prepared',
        'identity'
      )
    }
    if (prepared.completion !== undefined) {
      return {
        status: 'terminal',
        terminalState: 'completed',
        processTree: prepared.completion.processTree
      }
    }
    if (prepared.terminalState !== undefined) {
      return {
        status: 'terminal',
        terminalState: prepared.terminalState,
        processTree:
          prepared.terminalState === 'completed' ? 'running' : 'empty'
      }
    }
    if (binding.activeOperationId !== operation.operationId) {
      return { status: 'outcome-unknown', processTree: 'unknown' }
    }
    if (binding.process === undefined) {
      if (binding.state === 'closed') {
        return {
          status: 'terminal',
          terminalState: binding.terminalState ?? 'interrupted',
          processTree: 'empty'
        }
      }
      return { status: 'outcome-unknown', processTree: 'unknown' }
    }
    let reconciliation: RuntimeAcpProcessReconciliation
    try {
      reconciliation = await binding.process.reconcile()
    } catch {
      binding.state = 'outcome-unknown'
      return { status: 'outcome-unknown', processTree: 'unknown' }
    }
    if (!sameProcessIdentity(binding.process.identity, reconciliation.identity)) {
      binding.state = 'outcome-unknown'
      await Promise.resolve(
        binding.process.stop({
          reason: 'identity-conflict',
          deadlineAt: new Date(this.#now() + 10_000).toISOString()
        })
      ).catch(() => undefined)
      throw new RuntimeAcpBackendError(
        'Supervised process identity conflicts with its binding',
        'identity'
      )
    }
    if (reconciliation.processTree !== 'empty') {
      binding.state =
        reconciliation.processTree === 'running'
          ? 'running'
          : 'outcome-unknown'
      return reconciliation.processTree === 'running'
        ? { status: 'running', processTree: 'running' }
        : { status: 'outcome-unknown', processTree: 'unknown' }
    }
    const completedState = terminalState(reconciliation.state)
    await this.#closeModelBridge(binding, true)
    this.#finishProcess(binding)
    binding.state = 'open'
    binding.terminalState = completedState
    return {
      status: 'terminal',
      terminalState: completedState,
      processTree: 'empty'
    }
  }

  async #acceptProcessOutput(
    binding: BindingState,
    output: RuntimeAcpProcessOutput
  ): Promise<void> {
    if (output.stream === 'stderr' || output.data.byteLength === 0) {
      return
    }
    if (binding.state !== 'running') {
      throw new RuntimeAcpBackendError(
        'Runtime output arrived after the binding stopped',
        'closed'
      )
    }
    this.#assertBeforeDeadline(binding)
    for (
      let offset = 0;
      offset < output.data.byteLength;
      offset += AGENT_PROTOCOL_LIMITS.maximumAcpFrameBytes
    ) {
      const payload = output.data.slice(
        offset,
        offset + AGENT_PROTOCOL_LIMITS.maximumAcpFrameBytes
      )
      try {
        await this.#enqueueOutput(binding, payload, async () => {
          const sequence = binding.nextOutputSequence.toString()
          while (true) {
            try {
              this.#options.journal.appendAcpFrame({
                controllerId: binding.controllerId,
                bindingId: binding.request.bindingId,
                channelEpoch: binding.openResult.channelEpoch,
                direction: 'runtime-to-main',
                sequence,
                payload
              })
              break
            } catch (error) {
              if (!(error instanceof EventJournalCapacityError)) {
                throw error
              }
              if (binding.state !== 'running') {
                throw new RuntimeAcpBackendError(
                  'Runtime output arrived after the binding stopped',
                  'closed'
                )
              }
              this.#assertBeforeDeadline(binding)
              await delay(ACP_JOURNAL_RETRY_MILLISECONDS)
            }
          }
          binding.nextOutputSequence += 1n
          if (binding.transportState === 'live') {
            try {
              await this.#deliverOutput(binding, sequence, payload)
            } catch {
              await this.#detachBinding(binding)
            }
          }
        })
      } catch (error) {
        await this.#stopAndReconcile(binding, 'output-quota').catch(
          () => undefined
        )
        if (
          error instanceof RuntimeAcpBackendError &&
          error.code === 'output-quota'
        ) {
          throw error
        }
        throw new RuntimeAcpBackendError(
          'Runtime durable output journal quota reached',
          'output-quota'
        )
      }
    }
  }

  async #deliverOutput(
    binding: BindingState,
    sequence: string,
    payload: Uint8Array
  ): Promise<void> {
    const frame: AgentFrame = {
      header: {
        protocolMajor: AGENT_PROTOCOL_VERSION.major,
        protocolMinor: AGENT_PROTOCOL_VERSION.minor,
        connectionId: binding.connectionId,
        generation: binding.controllerGeneration,
        channelId: binding.request.bindingId,
        channelEpoch: binding.openResult.channelEpoch,
        direction: 'agent-to-main',
        sequence,
        kind: 'acp',
        payloadLength: payload.byteLength
      },
      payload
    }
    await this.#options.outputSink(frame, {
      bindingId: binding.request.bindingId,
      controllerId: binding.controllerId,
      controllerGeneration: binding.controllerGeneration
    })
  }

  async #detachBinding(binding: BindingState): Promise<void> {
    if (binding.transportState === 'detached') {
      return
    }
    binding.transportState = 'detached'
    if (binding.modelBridgeClient !== undefined) {
      await this.#closeModelBridge(binding, false, true).catch(
        () => undefined
      )
    }
  }

  async #stopAndReconcile(
    binding: BindingState,
    reason: RuntimeAcpProcessStopReason
  ): Promise<void> {
    if (binding.state === 'closed') {
      return
    }
    this.#appendAbnormalOwnedPromptTerminal(
      binding,
      reason === 'user-cancelled'
        ? {
            status: 'cancelled',
            name: 'PromptCancelled',
            message: 'Prompt execution was cancelled'
          }
        : {
            status: this.#abnormalOwnedPromptState(binding),
            name:
              reason === 'deadline-exceeded'
                ? 'PromptDeadlineExceeded'
                : 'RuntimeStopped',
            message:
              reason === 'deadline-exceeded'
                ? 'Prompt execution exceeded its Runtime deadline'
                : 'Runtime stopped before the prompt reached a terminal state'
          }
    )
    await this.#closeModelBridge(binding, true)
    if (binding.process === undefined) {
      this.#finishBinding(binding, 'interrupted')
      return
    }
    binding.state = 'stopping'
    if (!binding.stopRequested) {
      binding.stopRequested = true
      try {
        await binding.process.stop({
          reason,
          deadlineAt: new Date(this.#now() + 10_000).toISOString()
        })
      } catch {
        binding.state = 'outcome-unknown'
        throw new RuntimeAcpBackendError(
          'Runtime process stop failed',
          'process'
        )
      }
    }
    let reconciliation: RuntimeAcpProcessReconciliation
    try {
      reconciliation = await binding.process.reconcile()
    } catch {
      binding.state = 'outcome-unknown'
      throw new RuntimeAcpBackendError(
        'Runtime process reconciliation failed',
        'process'
      )
    }
    if (!sameProcessIdentity(binding.process.identity, reconciliation.identity)) {
      binding.state = 'outcome-unknown'
      throw new RuntimeAcpBackendError(
        'Supervised process identity conflicts with its binding',
        'identity'
      )
    }
    if (reconciliation.processTree !== 'empty') {
      binding.state = 'outcome-unknown'
      throw new RuntimeAcpBackendError(
        'Runtime process tree is not empty',
        'process'
      )
    }
    this.#finishBinding(binding, terminalState(reconciliation.state))
  }

  async #handleProcessExit(binding: BindingState): Promise<void> {
    if (binding.process === undefined) {
      return
    }
    this.#appendAbnormalOwnedPromptTerminal(binding, {
      status: this.#abnormalOwnedPromptState(binding),
      name: 'RuntimeExited',
      message: 'Runtime exited before the prompt reached a terminal state'
    })
    await this.#closeModelBridge(binding, true).catch(
      () => undefined
    )
    let state: 'completed' | 'failed' | 'cancelled' | 'interrupted' =
      'interrupted'
    let diagnosticOutcome: AgentDiagnosticRecord['outcome'] =
      'interrupted'
    try {
      const reconciliation = await binding.process.reconcile()
      if (
        sameProcessIdentity(
          binding.process.identity,
          reconciliation.identity
        ) &&
        reconciliation.processTree === 'empty'
      ) {
        state = terminalState(reconciliation.state)
        diagnosticOutcome = state
      }
    } catch (error) {
      binding.state = 'outcome-unknown'
      diagnosticOutcome = 'outcome-unknown'
      this.#options.diagnostics?.tryRecord('runtime.exited', {
        runtimeId: binding.resolvedBundle.entry.runtimeId,
        ...(binding.workMode === undefined
          ? {}
          : { workMode: binding.workMode }),
        outcome: diagnosticOutcome,
        error
      })
      this.#finishBinding(binding, state)
      return
    }
    this.#options.diagnostics?.tryRecord('runtime.exited', {
      runtimeId: binding.resolvedBundle.entry.runtimeId,
      ...(binding.workMode === undefined
        ? {}
        : { workMode: binding.workMode }),
      outcome: diagnosticOutcome
    })
    this.#finishBinding(binding, state)
  }

  #abnormalOwnedPromptState(
    binding: BindingState
  ): 'failed' | 'outcome-unknown' {
    return binding.poisoned || binding.nextModelRound > 0
      ? 'outcome-unknown'
      : 'failed'
  }

  #appendAbnormalOwnedPromptTerminal(
    binding: BindingState,
    terminal: {
      status: 'failed' | 'cancelled' | 'outcome-unknown'
      name: string
      message: string
    }
  ): void {
    const operationId = binding.activeOperationId
    const prepared =
      operationId === undefined
        ? undefined
        : binding.operations.get(operationId)
    if (
      operationId === undefined ||
      prepared === undefined ||
      this.#options.semanticPrompts === undefined ||
      (
        prepared.modelProfile === undefined &&
        binding.ownedAcp === undefined
      )
    ) {
      return
    }
    try {
      this.#options.semanticPrompts.append({
        bindingId: binding.request.bindingId,
        operationId,
        kind: 'prompt-terminal',
        payload: {
          status: terminal.status,
          error: {
            name: terminal.name,
            message: terminal.message
          }
        },
        terminalState: terminal.status
      })
      if (terminal.status !== 'outcome-unknown') {
        prepared.terminalState = terminal.status
      }
    } catch {
      // A concurrent Agent-owned terminal transition already won.
    }
  }

  #finishBinding(
    binding: BindingState,
    state: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  ): void {
    this.#finishProcess(binding)
    this.#options.journal.retireAcpBinding?.({
      controllerId: binding.controllerId,
      bindingId: binding.request.bindingId,
      channelEpoch: binding.openResult.channelEpoch
    })
    binding.state = 'closed'
    binding.terminalState = state
  }

  #finishProcess(binding: BindingState): void {
    if (binding.process !== undefined) {
      this.#processIdentityBindings.delete(
        processIdentityKey(binding.process.identity)
      )
    }
    binding.unsubscribeOutput?.()
    binding.unsubscribeOutput = undefined
    binding.unsubscribeExit?.()
    binding.unsubscribeExit = undefined
    binding.process = undefined
    binding.ownedAcp?.close()
    binding.ownedAcp = undefined
    binding.workspaceDirectory = undefined
    for (const operation of binding.operations.values()) {
      operation.modelProfile = undefined
    }
    binding.stopRequested = false
    binding.activeOperationId = undefined
    if (binding.deadlineTimer !== undefined) {
      clearTimeout(binding.deadlineTimer)
      binding.deadlineTimer = undefined
    }
    if (binding.ownedPromptStartTimer !== undefined) {
      clearTimeout(binding.ownedPromptStartTimer)
      binding.ownedPromptStartTimer = undefined
    }
  }

  #scheduleDeadline(binding: BindingState, deadlineAt: string): void {
    if (binding.deadlineTimer !== undefined) {
      clearTimeout(binding.deadlineTimer)
      binding.deadlineTimer = undefined
    }
    if (deadlineAt === UNBOUNDED_REMOTE_PROMPT_DEADLINE) {
      return
    }
    const delay = Math.max(
      1,
      Math.min(Date.parse(deadlineAt) - this.#now(), 0x7fff_ffff)
    )
    binding.deadlineTimer = setTimeout(() => {
      void this.#enqueueControl(() =>
        this.#stopAndReconcile(binding, 'deadline-exceeded')
      ).catch(() => undefined)
    }, delay)
    binding.deadlineTimer.unref?.()
  }

  #scheduleOwnedPromptStart(
    binding: BindingState,
    operationId: string
  ): void {
    if (binding.ownedPromptStartTimer !== undefined) {
      clearTimeout(binding.ownedPromptStartTimer)
    }
    binding.ownedPromptStartTimer = setTimeout(() => {
      void this.#enqueueControl(async () => {
        const operation = binding.operations.get(operationId)
        if (
          binding.activeOperationId !== operationId ||
          operation?.ownedPromptStarted === true
        ) {
          return
        }
        binding.poisoned = true
        binding.state = 'outcome-unknown'
        try {
          this.#options.semanticPrompts?.append({
            bindingId: binding.request.bindingId,
            operationId,
            kind: 'prompt-terminal',
            payload: {
              status: 'outcome-unknown',
              error: {
                name: 'PromptStartTimeout',
                message:
                  'Desktop disconnected after preparation but before prompt start'
              }
            },
            terminalState: 'outcome-unknown'
          })
        } catch {
          // Another terminal transition won the race.
        }
        await this.#stopAndReconcile(
          binding,
          'identity-conflict'
        ).catch(() => undefined)
      }).catch(() => undefined)
    }, OWNED_PROMPT_START_TIMEOUT_MS)
    binding.ownedPromptStartTimer.unref?.()
  }

  #bindConnectionLifetime(
    binding: BindingState,
    signal: AbortSignal | undefined
  ): void {
    if (signal === undefined || this.#boundConnectionSignals.has(signal)) {
      return
    }
    this.#boundConnectionSignals.add(signal)
    const disconnect = (): void => {
      for (const candidate of this.#bindings.values()) {
        if (
          candidate.controllerId === binding.controllerId &&
          candidate.controllerGeneration === binding.controllerGeneration &&
          candidate.connectionId === binding.connectionId &&
          candidate.state !== 'closed'
        ) {
          void this.#enqueueControl(() =>
            this.#detachBinding(candidate)
          ).catch(() => undefined)
        }
      }
    }
    if (signal.aborted) {
      disconnect()
    } else {
      signal.addEventListener('abort', disconnect, { once: true })
    }
  }

  #assertPreparationIdentity(
    binding: BindingState,
    preparation: RemotePromptOperationPreparation,
    context: ProtocolMethodContext
  ): void {
    if (
      preparation.controllerId !== binding.controllerId ||
      preparation.controllerGeneration !== binding.controllerGeneration ||
      preparation.connectionGeneration !== binding.controllerGeneration ||
      preparation.channelEpoch !== binding.openResult.channelEpoch ||
      preparation.bindingId !== binding.request.bindingId ||
      preparation.runtimeId !== binding.request.runtimeId ||
      preparation.runtimeBundleDigest !==
        binding.request.runtimeBundleDigest ||
      preparation.workspaceIdentity !== binding.request.workspaceIdentity ||
      context.controller.connectionId !== binding.connectionId
    ) {
      throw new RuntimeAcpBackendError(
        'Prompt preparation identity does not match its ACP binding',
        'identity'
      )
    }
    if (preparation.operationId !== preparation.requestId) {
      throw new RuntimeAcpBackendError(
        'Prompt operation and request identities must match',
        'identity'
      )
    }
  }

  #assertVerifiedIdentity(
    binding: BindingState,
    preparation: RemotePromptOperationPreparation,
    verified: RuntimeAcpVerifiedBundle
  ): void {
    const manifest = verified.manifest
    if (
      manifest.provider !== 'opencode' ||
      manifest.runtimeId !== preparation.runtimeId ||
      manifest.bundleDigest !== preparation.runtimeBundleDigest ||
      manifest.adapterDigest !== preparation.runtimeAdapterDigest ||
      manifest.acpCapabilitiesDigest !==
        binding.openResult.acpCapabilitiesDigest ||
      (binding.resolvedBundle.entry.manifestDigest !== undefined &&
        binding.resolvedBundle.entry.manifestDigest !==
          verified.manifestDigest) ||
      verified.bundleDirectory !== binding.resolvedBundle.bundleDirectory
    ) {
      throw new RuntimeAcpBackendError(
        'Reverified Runtime identity does not match the prompt binding',
        'untrusted-runtime'
      )
    }
  }

  #bindingForContext(
    bindingId: string,
    context: ProtocolMethodContext
  ): BindingState {
    this.#assertControllerLive(context)
    const binding = this.#bindings.get(bindingId)
    if (binding === undefined) {
      throw new RuntimeAcpBackendError(
        'ACP binding does not exist',
        'not-found'
      )
    }
    this.#assertBindingOwner(binding, context)
    return binding
  }

  #assertBindingOwner(
    binding: BindingState,
    context: ProtocolMethodContext
  ): void {
    if (
      binding.controllerId !== context.controller.controllerId ||
      binding.controllerGeneration !== context.controller.generation ||
      binding.connectionId !== context.controller.connectionId
    ) {
      throw new RuntimeAcpBackendError(
        'ACP binding belongs to another controller generation',
        'stale-controller'
      )
    }
  }

  #assertControllerLive(context: ProtocolMethodContext): void {
    if (
      context.signal?.aborted === true ||
      context.controller.leaseExpiresAt <= this.#now()
    ) {
      throw new RuntimeAcpBackendError(
        'Controller connection is no longer current',
        'stale-controller'
      )
    }
  }

  #assertOpenCapacity(controllerId: string): void {
    const active = [...this.#bindings.values()].filter(
      (binding) => binding.state !== 'closed'
    )
    if (
      active.length >= this.#limits.maximumBindings ||
      active.filter((binding) => binding.controllerId === controllerId)
        .length >= this.#limits.maximumControllerBindings ||
      this.#lifetimeBindings >= this.#limits.maximumLifetimeBindings
    ) {
      throw new RuntimeAcpBackendError(
        'ACP binding capacity reached',
        'capacity'
      )
    }
  }

  #assertBeforeDeadline(
    binding: BindingState,
      deadlineAt = this.#activeAcceptance(binding)?.deadlineAt
  ): void {
    if (
      deadlineAt === undefined ||
      !Number.isFinite(Date.parse(deadlineAt)) ||
      Date.parse(deadlineAt) <= this.#now()
    ) {
      throw new RuntimeAcpBackendError(
        'Prompt operation deadline has expired',
        'deadline'
      )
    }
  }

  #activeAcceptance(
    binding: BindingState
  ): RemotePromptOperationAcceptance | undefined {
    if (binding.activeOperationId === undefined) {
      return undefined
    }
    return binding.operations.get(binding.activeOperationId)?.acceptance
  }

  #activeBudget(
    binding: BindingState
  ): RemotePromptOperationPreparation['budget'] {
    const acceptance = this.#activeAcceptance(binding)
    if (acceptance === undefined) {
      throw new RuntimeAcpBackendError(
        'Prompt operation is not prepared',
        'identity'
      )
    }
    const operation = binding.operations.get(binding.activeOperationId!)
    if (operation === undefined) {
      throw new RuntimeAcpBackendError(
        'Prompt operation is not active',
        'identity'
      )
    }
    return operation.budget
  }

  #cursor(
    binding: BindingState,
    direction: 'main-to-runtime' | 'runtime-to-main'
  ): AcpJournalCursor | undefined {
    const cursor = this.#options.journal.getAcpCursor(
      binding.request.bindingId,
      binding.openResult.channelEpoch,
      direction
    )
    return cursor === undefined
      ? undefined
      : acpJournalCursorSchema.parse(cursor)
  }

  async #enqueueControl<T>(action: () => Promise<T> | T): Promise<T> {
    if (this.#pendingControl >= this.#limits.maximumPendingControl) {
      throw new RuntimeAcpBackendError(
        'ACP global control queue is full',
        'capacity'
      )
    }
    this.#pendingControl += 1
    const previous = this.#controlTail
    let release!: () => void
    this.#controlTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await action()
    } finally {
      this.#pendingControl -= 1
      release()
    }
  }

  #enqueuePublicControl<T>(
    action: () => Promise<T> | T
  ): Promise<T> {
    this.#assertNotDisposed()
    return this.#enqueueControl(action)
  }

  #assertNotDisposed(): void {
    if (this.#disposed) {
      throw new RuntimeAcpBackendError(
        'Runtime backend is closed',
        'closed'
      )
    }
  }

  async #enqueueInput(
    binding: BindingState,
    action: () => Promise<void>
  ): Promise<void> {
    if (
      binding.pendingInput >=
        this.#limits.maximumPendingInputPerBinding ||
      this.#pendingInputGlobal >=
        this.#limits.maximumPendingInputGlobal
    ) {
      throw new RuntimeAcpBackendError(
        'ACP input queue is full',
        'capacity'
      )
    }
    binding.pendingInput += 1
    this.#pendingInputGlobal += 1
    const previous = binding.inputTail
    let release!: () => void
    binding.inputTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      await action()
    } finally {
      binding.pendingInput -= 1
      this.#pendingInputGlobal -= 1
      release()
    }
  }

  async #enqueueOutput(
    binding: BindingState,
    payload: Uint8Array,
    action: () => Promise<void>
  ): Promise<void> {
    if (
      binding.pendingOutput >=
        this.#limits.maximumPendingOutputPerBinding ||
      this.#pendingOutputGlobal >=
        this.#limits.maximumPendingOutputGlobal ||
      binding.pendingOutputBytes + payload.byteLength >
        this.#limits.maximumPendingOutputBytesPerBinding ||
      this.#pendingOutputBytesGlobal + payload.byteLength >
        this.#limits.maximumPendingOutputBytesGlobal
    ) {
      throw new RuntimeAcpBackendError(
        'ACP output queue is full',
        'capacity'
      )
    }
    binding.pendingOutput += 1
    binding.pendingOutputBytes += payload.byteLength
    this.#pendingOutputGlobal += 1
    this.#pendingOutputBytesGlobal += payload.byteLength
    const previous = binding.outputTail
    let release!: () => void
    binding.outputTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      await action()
    } finally {
      binding.pendingOutput -= 1
      binding.pendingOutputBytes -= payload.byteLength
      this.#pendingOutputGlobal -= 1
      this.#pendingOutputBytesGlobal -= payload.byteLength
      release()
    }
  }

  #allocateChannelEpoch(): string {
    if (this.#nextChannelEpoch > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RuntimeAcpBackendError(
        'ACP channel epoch lifetime is exhausted',
        'capacity'
      )
    }
    const epoch = positiveAgentSequenceSchema.parse(
      this.#nextChannelEpoch.toString()
    )
    this.#nextChannelEpoch += 1n
    return epoch
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now()
  }
}

function assertProcessIdentity(identity: RuntimeAcpProcessIdentity): void {
  agentIdentifierSchema.parse(identity.launchId)
  agentIdentifierSchema.parse(identity.processId)
  sha256DigestSchema.parse(identity.supervisorIdentityDigest)
}

function sameProcessIdentity(
  left: RuntimeAcpProcessIdentity,
  right: RuntimeAcpProcessIdentity
): boolean {
  try {
    assertProcessIdentity(right)
  } catch {
    return false
  }
  return (
    left.launchId === right.launchId &&
    left.processId === right.processId &&
    left.supervisorIdentityDigest === right.supervisorIdentityDigest
  )
}

function processIdentityKey(identity: RuntimeAcpProcessIdentity): string {
  return [
    identity.launchId,
    identity.processId,
    identity.supervisorIdentityDigest
  ].join('\0')
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
}

function digestSecretBearingPreparation(
  preparation: RemotePromptOperationPreparation
): string {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(preparation))
    .digest('hex')}`
}

function terminalState(
  state: RuntimeAcpProcessReconciliation['state']
): 'completed' | 'failed' | 'cancelled' | 'interrupted' {
  switch (state) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'interrupted'
  }
}

function rejectAfter<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
    timeout.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error)
      }
    )
  })
}

function boundedLimit(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < 1 ||
    candidate > Number.MAX_SAFE_INTEGER
  ) {
    throw new RangeError('Invalid Runtime ACP backend limit')
  }
  return candidate
}
