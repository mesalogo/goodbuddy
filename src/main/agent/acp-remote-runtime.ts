import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type AgentCapabilities,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
  type Usage
} from '@agentclientprotocol/sdk'
import type {
  AgentRuntimeStatus
} from '../../shared/contracts'
import {
  maximumConversationToolActivities
} from '../../shared/assistant-contracts'
import {
  assertRemotePromptAcceptanceMatchesPreparation,
  REMOTE_SEMANTIC_TRANSCRIPT_LIMITS,
  remoteOwnedPromptStartResultSchema,
  remotePromptOperationAcceptanceSchema,
  remotePromptOperationPreparationSchema,
  remoteSemanticTranscriptEventSchema,
  remoteSemanticTranscriptPageResultSchema,
  runtimeSessionBindingSchema,
  UNBOUNDED_REMOTE_PROMPT_DEADLINE,
  type RemotePromptOperationAcceptance,
  type RemotePromptOperationPreparation,
  type RuntimeSessionBinding
} from '../../shared/remote-agent-contracts'
import { sha256DigestSchema } from '../../shared/agent-protocol'
import { canonicalJson } from '../../shared/agent-protocol/canonical'
import {
  agentPromptModelProfileSchema,
  MODEL_BRIDGE_PROTOCOL,
  modelBridgePolicySchema,
  type AgentPromptModelProfile,
  type ModelBridgePolicy
} from '../../shared/model-bridge-contracts'
import {
  REMOTE_RUNTIME_LAUNCH_LIMITS
} from '../../shared/remote-runtime-launch-contracts'
import type {
  AgentExecutionRequest,
  AgentRuntime,
  RemoteSemanticCheckpointEvent,
  RemoteSemanticRuntimeEvent,
  RuntimeAuthorizer,
  RuntimeEvent,
  RuntimeModelUsageEvent,
  RuntimePublicEvent,
  RemoteRecoveredSubagent
} from './runtime'
import {
  assertCurrentRemoteRuntimeGeneration,
  isDefinitiveRemoteRuntimeRequestRejection,
  type RemoteModelBridgeSession,
  type RemoteRuntimeChannel
} from './remote-runtime-channel'
import type { RuntimeSessionBindingStore } from './runtime-session-binding-store'
import {
  parseOpenCodeSubagentInput,
  toOpenCodeSubagentEvent
} from './opencode-subagent'
import { promptWithUntrustedConversationHistory } from './runtime-conversation-history'

type BindingIdentity = Pick<
  RuntimeSessionBinding,
  | 'controllerId'
  | 'controllerGeneration'
  | 'hostId'
  | 'hostRevision'
  | 'hostKeyGeneration'
  | 'workspaceIdentity'
  | 'agentInstallationId'
  | 'daemonBootIdAtOpen'
  | 'runtimeBundleDigest'
  | 'runtimeAdapterDigest'
>

export type AcpRemoteRuntimeOptions = {
  runtimeId: AgentRuntimeStatus['id']
  label: string
  workspacePath: string
  identity: BindingIdentity
  /**
   * Legacy single-channel construction. It can own one conversation and is
   * closed when that conversation is released.
   */
  channel?: RemoteRuntimeChannel
  /**
   * Creates one virtual ACP channel for one stable binding identity.
   * The binding ID passed here is the same ID persisted for recovery.
   */
  channelFactory?: (
    bindingId: string
  ) => Promise<RemoteRuntimeChannel>
  maxConcurrentChannels?: number
  bindingStore: RuntimeSessionBindingStore
  assertHostCurrent: (
    identity: Readonly<
      Pick<
        RuntimeSessionBinding,
        | 'controllerId'
        | 'hostId'
        | 'hostRevision'
        | 'hostKeyGeneration'
        | 'agentInstallationId'
      >
    >
  ) => void
  maxEventCharacters?: number
  maxRequestOutputBytes?: number
  cancellationGraceMs?: number
  operationTimeoutMs?: number
  /** Optional test/operator override. Production prompts are Runtime-controlled. */
  promptTimeoutMs?: number
  maxPendingUpdates?: number
  maxPendingUpdateBytes?: number
  usage?: {
    runtime: RuntimeModelUsageEvent['runtime']
    provider: string
    model: string
  }
  modelBridgePolicy?: ModelBridgePolicy
  /** Prompt-scoped production profile transferred only to the Agent. */
  modelProfile?: AgentPromptModelProfile
}

export class RemotePromptRecoveryUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RemotePromptRecoveryUnavailableError'
  }
}

type ActivePrompt = {
  requestId: string
  operationId: string
  sessionId: string
  bindingId: string
  workMode: 'ask' | 'execute'
  authorize?: RuntimeAuthorizer
  updates: QueuedSessionUpdate[]
  pendingUpdateBytes: number
  inboundPaused: boolean
  outputCharacters: number
  toolCalls: Map<
    string,
    {
      title?: string
      kind?: string
      status?: 'pending' | 'in_progress' | 'completed' | 'failed'
      rawInput?: unknown
      rawOutput?: unknown
      retainedInput?: string
      retainedOutput?: string
      retainedError?: string
      retainedSubagent?: RemoteRecoveredSubagent
    }
  >
  open: boolean
  completed: boolean
  interruption?: Error
  interrupt?: (reason: Error) => void
  wake?: () => void
  context: ChannelContext
}

type QueuedSessionUpdate = {
  update: SessionUpdate
  bytes: number
  consumed: () => void
}

type SessionRecord = {
  binding: RuntimeSessionBinding
  sessionId: string
  context: ChannelContext
  modelBridge?: RemoteModelBridgeSession
  sendHistoryWithNextPrompt: boolean
  ownedPromptAttached?: boolean
}

type AcpState = {
  agent: ClientSideConnection
  initialization: InitializeResponse
  capabilities: AgentCapabilities
  capabilitiesDigest: string
}

type ChannelContext = {
  channel: RemoteRuntimeChannel
  state?: AcpState
  initialization?: Promise<AcpState>
  fatalError?: Error
  channelHasClosed: boolean
  channelClose?: Promise<void>
  channelCloseWaiters: Set<() => void>
  permitHeld: boolean
}

const DEFAULT_MAX_EVENT_CHARACTERS = 100_000
const DEFAULT_MAX_REQUEST_OUTPUT_BYTES = 1_000_000
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000
const DEFAULT_CANCELLATION_GRACE_MS = 1_500
const DEFAULT_MAX_PENDING_UPDATES = 1_000
const DEFAULT_MAX_PENDING_UPDATE_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_CONCURRENT_CHANNELS = 8

function digest(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`
}

function safeStringify(value: unknown, maximum: number): string | undefined {
  if (value === undefined) {
    return undefined
  }
  try {
    const result = JSON.stringify(value)
    return result.length > maximum
      ? `${result.slice(0, maximum)}…`
      : result
  } catch {
    return undefined
  }
}

function boundedRetainedValue(
  value: unknown,
  maximum: number
): unknown {
  if (value === undefined) {
    return undefined
  }
  if (typeof value === 'string') {
    return value.length > maximum
      ? `${value.slice(0, maximum)}…`
      : value
  }
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) {
      return undefined
    }
    if (serialized.length > maximum) {
      return `${serialized.slice(0, maximum)}…`
    }
    return JSON.parse(serialized) as unknown
  } catch {
    return undefined
  }
}

function boundedRetainedToolInput(
  value: unknown,
  maximum: number
): unknown {
  return (
    parseOpenCodeSubagentInput(value) ??
    boundedRetainedValue(value, maximum)
  )
}

class RemoteOperationTimeoutError extends Error {
  constructor(readonly operation: string) {
    super(`远端 Runtime ${operation}超时`)
    this.name = 'RemoteOperationTimeoutError'
  }
}

class RemoteChannelClosedError extends Error {
  constructor(readonly operation: string) {
    super(`远端 Runtime 在${operation}期间连接已关闭`)
    this.name = 'RemoteChannelClosedError'
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

function utf8JsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function permissionRejection(
  permission: RequestPermissionRequest
): RequestPermissionResponse {
  const rejection = permission.options.find(
    (option) =>
      option.kind === 'reject_once' ||
      option.kind === 'reject_always'
  )
  return rejection
    ? {
        outcome: {
          outcome: 'selected',
          optionId: rejection.optionId
        }
      }
    : { outcome: { outcome: 'cancelled' } }
}

function usageEvent(
  requestId: string,
  usage: Usage,
  options: AcpRemoteRuntimeOptions['usage'],
  callId: string
): RuntimeModelUsageEvent | undefined {
  if (!options) {
    return undefined
  }
  return {
    requestId,
    type: 'model-usage',
    callId,
    runtime: options.runtime,
    provider: options.provider,
    model: options.model,
    inputTokens: Math.max(0, usage.inputTokens),
    outputTokens: Math.max(0, usage.outputTokens),
    cacheReadTokens: Math.max(0, usage.cachedReadTokens ?? 0),
    cacheWriteTokens: Math.max(0, usage.cachedWriteTokens ?? 0),
    reportedTotalTokens: Math.max(0, usage.totalTokens)
  }
}

/**
 * Generic ACP runtime over an authenticated remote virtual channel.
 *
 * The class deliberately does not claim confinement from ACP itself. Ask
 * permits only one-shot native reads, while the injected channel's read-only
 * sandbox remains the filesystem boundary. Execute follows the user's full
 * authorization for the selected SSH account.
 */
export class AcpRemoteRuntime implements AgentRuntime {
  readonly requiresToolApproval = false
  readonly supportsScopedDataTools = false
  readonly capability = 'chat' as const

  private disposed = false
  private draining = false
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionInitializations = new Map<
    string,
    Promise<SessionRecord>
  >()
  private readonly activePrompts = new Map<string, ActivePrompt>()
  private readonly sessionReservations = new Set<string>()
  private readonly drainWaiters = new Set<() => void>()
  private readonly contexts = new Map<string, ChannelContext>()
  private readonly allContexts = new Set<ChannelContext>()
  private readonly channelPermitWaiters = new Set<() => boolean>()
  private activeChannelPermits = 0
  private readonly directContext?: ChannelContext
  private directContextClaimed = false

  constructor(private readonly options: AcpRemoteRuntimeOptions) {
    if (Boolean(options.channel) === Boolean(options.channelFactory)) {
      throw new Error(
        'AcpRemoteRuntime requires exactly one channel or channelFactory'
      )
    }
    if (
      options.maxConcurrentChannels !== undefined &&
      (
        !Number.isSafeInteger(options.maxConcurrentChannels) ||
        options.maxConcurrentChannels < 1 ||
        options.maxConcurrentChannels > 64
      )
    ) {
      throw new RangeError(
        'maxConcurrentChannels must be an integer between 1 and 64'
      )
    }
    if (options.channel) {
      this.directContext = this.createContext(options.channel, false)
    }
  }

  private createContext(
    channel: RemoteRuntimeChannel,
    permitHeld: boolean
  ): ChannelContext {
    const context: ChannelContext = {
      channel,
      channelHasClosed: false,
      channelCloseWaiters: new Set(),
      permitHeld
    }
    this.allContexts.add(context)
    void channel.closed.then(
      () => this.markChannelClosed(context),
      () => this.markChannelClosed(context)
    )
    return context
  }

  private markChannelClosed(context: ChannelContext): void {
    if (context.channelHasClosed) {
      return
    }
    context.channelHasClosed = true
    for (const reject of context.channelCloseWaiters) {
      reject()
    }
    context.channelCloseWaiters.clear()
  }

  private closeContext(context: ChannelContext): Promise<void> {
    context.channelClose ??= Promise.resolve()
      .then(() => context.channel.close())
      .finally(() => {
        this.allContexts.delete(context)
        if (context.permitHeld) {
          context.permitHeld = false
          this.releaseChannelPermit()
        }
      })
    return context.channelClose
  }

  private get maximumConcurrentChannels(): number {
    return this.options.channelFactory
      ? this.options.maxConcurrentChannels ??
          DEFAULT_MAX_CONCURRENT_CHANNELS
      : 1
  }

  private async acquireChannelPermit(signal?: AbortSignal): Promise<void> {
    if (this.activeChannelPermits < this.maximumConcurrentChannels) {
      this.activeChannelPermits += 1
      return
    }
    let active = true
    let permitGranted = false
    let resolvePermit: (() => void) | undefined
    const granted = new Promise<void>((resolve) => {
      resolvePermit = resolve
    })
    const waiter = (): boolean => {
      if (!active) {
        return false
      }
      active = false
      permitGranted = true
      this.activeChannelPermits += 1
      resolvePermit?.()
      return true
    }
    this.channelPermitWaiters.add(waiter)
    try {
      await this.awaitLocalOperation(
        '等待可用远端通道',
        granted,
        signal
      )
    } catch (error) {
      if (permitGranted) {
        this.releaseChannelPermit()
      }
      throw error
    } finally {
      active = false
      this.channelPermitWaiters.delete(waiter)
    }
  }

  private releaseChannelPermit(): void {
    this.activeChannelPermits = Math.max(
      0,
      this.activeChannelPermits - 1
    )
    for (const waiter of this.channelPermitWaiters) {
      this.channelPermitWaiters.delete(waiter)
      if (waiter()) {
        break
      }
    }
  }

  private async createConversationContext(
    conversationId: string,
    bindingId: string,
    signal?: AbortSignal
  ): Promise<ChannelContext> {
    const current = this.contexts.get(conversationId)
    if (current) {
      return current
    }
    if (this.directContext) {
      if (this.directContextClaimed) {
        throw new Error(
          'Legacy direct ACP channel can serve only one conversation'
        )
      }
      this.directContextClaimed = true
      this.contexts.set(conversationId, this.directContext)
      return this.directContext
    }
    await this.acquireChannelPermit(signal)
    let context: ChannelContext | undefined
    let channelPromise: Promise<RemoteRuntimeChannel> | undefined
    try {
      channelPromise = this.options.channelFactory!(bindingId)
      const channel = await this.awaitLocalOperation(
        '创建远端通道',
        channelPromise,
        signal
      )
      context = this.createContext(channel, true)
      this.assertUsable(context)
      this.contexts.set(conversationId, context)
      return context
    } catch (error) {
      if (context) {
        await this.closeContext(context).catch(() => undefined)
      } else {
        this.releaseChannelPermit()
        if (channelPromise) {
          void channelPromise
            .then((channel) => channel.close())
            .catch(() => undefined)
        }
      }
      throw error
    }
  }

  private get operationTimeoutMs(): number {
    return this.options.operationTimeoutMs ??
      DEFAULT_OPERATION_TIMEOUT_MS
  }

  private get promptTimeoutMs(): number | undefined {
    return this.options.promptTimeoutMs
  }

  private async awaitOperation<T>(
    context: ChannelContext,
    operation: string,
    promise: Promise<T>,
    signal?: AbortSignal,
    failChannel = true
  ): Promise<T> {
    signal?.throwIfAborted()
    let timer: ReturnType<typeof setTimeout> | undefined
    let removeAbortListener: (() => void) | undefined
    let removeChannelCloseWaiter: (() => void) | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new RemoteOperationTimeoutError(operation)),
        this.operationTimeoutMs
      )
    })
    const closed = new Promise<never>((_resolve, reject) => {
      if (context.channelHasClosed) {
        reject(new RemoteChannelClosedError(operation))
        return
      }
      const onClose = (): void =>
        reject(new RemoteChannelClosedError(operation))
      context.channelCloseWaiters.add(onClose)
      removeChannelCloseWaiter = () =>
        context.channelCloseWaiters.delete(onClose)
    })
    const aborted = signal
      ? new Promise<never>((_resolve, reject) => {
          const onAbort = (): void => reject(abortReason(signal))
          signal.addEventListener('abort', onAbort, { once: true })
          removeAbortListener = () =>
            signal.removeEventListener('abort', onAbort)
        })
      : new Promise<never>(() => {})
    try {
      return await Promise.race([promise, timeout, closed, aborted])
    } catch (error) {
      if (failChannel) {
        this.failContext(
          context,
          error instanceof Error
            ? error
            : new Error(`远端 Runtime ${operation}已取消`)
        )
      }
      throw error
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
      removeAbortListener?.()
      removeChannelCloseWaiter?.()
    }
  }

  private async awaitLocalOperation<T>(
    operation: string,
    promise: Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    signal?.throwIfAborted()
    let timer: ReturnType<typeof setTimeout> | undefined
    let removeAbortListener: (() => void) | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new RemoteOperationTimeoutError(operation)),
        this.operationTimeoutMs
      )
    })
    const aborted = signal
      ? new Promise<never>((_resolve, reject) => {
          const onAbort = (): void => reject(abortReason(signal))
          signal.addEventListener('abort', onAbort, { once: true })
          removeAbortListener = () =>
            signal.removeEventListener('abort', onAbort)
        })
      : new Promise<never>(() => {})
    try {
      return await Promise.race([promise, timeout, aborted])
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
      removeAbortListener?.()
    }
  }

  get runtimeId(): AgentRuntimeStatus['id'] {
    return this.options.runtimeId
  }

  get supportsToolExecution(): boolean {
    if (this.options.channelFactory) {
      return true
    }
    const capabilities = this.options.channel!.capabilities
    return capabilities.promptOperationReconciliation
  }

  private assertUsable(
    context?: ChannelContext,
    allowDraining = false
  ): void {
    if (this.disposed) {
      throw new Error('远端 Runtime 已关闭')
    }
    if (this.draining && !allowDraining) {
      throw new Error('远端 Runtime 正在退役')
    }
    if (context?.fatalError) {
      throw context.fatalError
    }
    if (!context) {
      return
    }
    try {
      assertCurrentRemoteRuntimeGeneration(context.channel)
    } catch (error) {
      const stale =
        error instanceof Error
          ? error
          : new Error('远端 Runtime 连接代际已失效')
      this.failContext(context, stale)
      throw stale
    }
  }

  private async initialize(
    context: ChannelContext,
    signal?: AbortSignal
  ): Promise<AcpState> {
    this.assertUsable(context, true)
    const connection = new ClientSideConnection(
      () => ({
          requestPermission: (permission) =>
            this.handlePermission(context, permission),
          sessionUpdate: (notification) =>
            this.handleSessionUpdate(context, notification),
          extMethod: async () => ({}),
          extNotification: async () => {}
        }),
      ndJsonStream(
        context.channel.output,
        context.channel.input
      )
    )
    const initialization = await this.awaitOperation(
      context,
      '初始化',
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          terminal: false,
          fs: {
            readTextFile: false,
            writeTextFile: false
          },
          _meta: {
            'goodbuddy/channelGeneration':
              context.channel.generation
          }
        },
        clientInfo: {
          name: 'GoodBuddy',
          version: '1'
        }
      }),
      signal
    )
    if (initialization.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error('远端 ACP 协议版本不兼容')
    }
    const capabilities = initialization.agentCapabilities ?? {}
    const state = {
      agent: connection,
      initialization,
      capabilities,
      capabilitiesDigest: digest({
        protocolVersion: initialization.protocolVersion,
        capabilities
      })
    }
    if (
      state.capabilitiesDigest !==
      context.channel.advertisedAcpCapabilitiesDigest
    ) {
      throw new Error(
        '远端 ACP 实际能力摘要与已签名 Runtime 能力摘要不匹配'
      )
    }
    void connection.closed.then(() => {
      if (!this.disposed) {
        this.failContext(
          context,
          new Error('远端 ACP 连接已关闭，活动请求结果未知')
        )
      }
    })
    this.assertUsable(context, true)
    context.state = state
    return state
  }

  private async getState(
    context: ChannelContext,
    signal?: AbortSignal
  ): Promise<AcpState> {
    if (context.state) {
      return context.state
    }
    context.initialization ??= this.initialize(context, signal)
    try {
      return await this.awaitOperation(
        context,
        '等待初始化',
        context.initialization,
        signal
      )
    } catch (error) {
      context.initialization = undefined
      throw error
    }
  }

  async getStatus(): Promise<AgentRuntimeStatus> {
    if (this.options.channelFactory) {
      this.assertUsable()
      return {
        id: this.options.runtimeId,
        label: this.options.label,
        available: true,
        supportsToolExecution: true,
        detail: this.draining
          ? '远端 ACP Runtime 正在排空已有会话'
          : '远端 ACP Runtime 将在会话使用时连接'
      }
    }
    const context = this.directContext!
    const capabilities = context.channel.capabilities
    if (!capabilities.promptOperationReconciliation) {
      return {
        id: this.options.runtimeId,
        label: this.options.label,
        available: false,
        supportsToolExecution: false,
        detail: '远端 Runtime 不可用：缺少稳定操作核对能力'
      }
    }
    try {
      this.assertUsable(context)
      sha256DigestSchema.parse(
        context.channel.advertisedAcpCapabilitiesDigest
      )
    } catch (error) {
      return {
        id: this.options.runtimeId,
        label: this.options.label,
        available: false,
        supportsToolExecution: true,
        detail:
          error instanceof Error
            ? error.message
            : '远端 ACP Runtime 不可用'
      }
    }
    return {
      id: this.options.runtimeId,
      label: this.options.label,
      available: true,
      supportsToolExecution: true,
      detail: this.draining
        ? '远端 ACP Runtime 正在排空已有会话'
        : '远端 ACP Runtime 控制面已连接'
    }
  }

  private bindingIdentityMatches(
    binding: RuntimeSessionBinding
  ): boolean {
    const identity = this.options.identity
    return (
      binding.controllerId === identity.controllerId &&
      binding.hostId === identity.hostId &&
      binding.hostRevision === identity.hostRevision &&
      binding.hostKeyGeneration === identity.hostKeyGeneration &&
      binding.workspaceIdentity === identity.workspaceIdentity &&
      binding.agentInstallationId === identity.agentInstallationId &&
      binding.runtimeId === this.options.runtimeId &&
      binding.runtimeBundleDigest === identity.runtimeBundleDigest &&
      binding.runtimeAdapterDigest === identity.runtimeAdapterDigest &&
      binding.modelBridgeVersion ===
        (this.options.modelBridgePolicy === undefined
          ? undefined
          : MODEL_BRIDGE_PROTOCOL) &&
      isDeepStrictEqual(
        binding.modelBridgePolicy,
        this.options.modelBridgePolicy
      )
    )
  }

  private bindingMatches(
    binding: RuntimeSessionBinding,
    context: ChannelContext
  ): boolean {
    return (
      this.bindingIdentityMatches(binding) &&
      binding.acpCapabilitiesDigest ===
        context.channel.advertisedAcpCapabilitiesDigest
    )
  }

  private transportMatches(
    binding: RuntimeSessionBinding,
    context: ChannelContext
  ): boolean {
    return (
      binding.controllerGeneration ===
        context.channel.generation &&
      binding.daemonBootIdAtOpen ===
        this.options.identity.daemonBootIdAtOpen &&
      binding.channelEpoch === context.channel.channelEpoch
    )
  }

  private async rotateBindingTransport(
    binding: RuntimeSessionBinding,
    context: ChannelContext,
    signal?: AbortSignal
  ): Promise<RuntimeSessionBinding> {
    if (this.transportMatches(binding, context)) {
      return binding
    }
    return await this.awaitLocalOperation(
      '更新恢复会话传输身份',
      this.options.bindingStore.rotateTransport(
        binding.bindingId,
        {
          controllerGeneration: binding.controllerGeneration,
          daemonBootIdAtOpen: binding.daemonBootIdAtOpen,
          channelEpoch: binding.channelEpoch
        },
        {
          controllerGeneration: context.channel.generation,
          daemonBootIdAtOpen:
            this.options.identity.daemonBootIdAtOpen,
          channelEpoch: context.channel.channelEpoch
        }
      ),
      signal
    )
  }

  private async persist(
    context: ChannelContext,
    binding: RuntimeSessionBinding,
    patch: Partial<RuntimeSessionBinding> = {},
    signal?: AbortSignal
  ): Promise<RuntimeSessionBinding> {
    const cursors = await this.awaitOperation(
      context,
      '读取会话游标',
      context.channel.getBindingCursors(binding.bindingId),
      signal
    )
    const next = runtimeSessionBindingSchema.parse({
      ...binding,
      ...patch,
      ...cursors,
      channelEpoch: context.channel.channelEpoch
    })
    await this.awaitLocalOperation(
      '保存会话绑定',
      this.options.bindingStore.put(next),
      signal
    )
    return next
  }

  private async persistInterrupted(
    binding: RuntimeSessionBinding
  ): Promise<RuntimeSessionBinding> {
    const interrupted = runtimeSessionBindingSchema.parse({
      ...binding,
      state: binding.activePromptOperationId
        ? 'outcome-unknown'
        : 'interrupted'
    })
    await this.awaitLocalOperation(
      '保存中断会话绑定',
      this.options.bindingStore.put(interrupted)
    )
    return interrupted
  }

  private async persistClosedBinding(
    binding: RuntimeSessionBinding
  ): Promise<RuntimeSessionBinding> {
    const closed = runtimeSessionBindingSchema.parse({
      ...binding,
      state: 'closed',
      activePromptOperationId: undefined
    })
    await this.awaitLocalOperation(
      '保存已拒绝会话绑定',
      this.options.bindingStore.put(closed)
    )
    return closed
  }

  private async closeIdleBinding(
    binding: RuntimeSessionBinding,
    signal?: AbortSignal
  ): Promise<void> {
    if (
      binding.state !== 'ready' ||
      binding.activePromptOperationId !== undefined
    ) {
      throw new Error(
        '只能替换没有活动请求的远端 ACP 会话绑定'
      )
    }
    const closed = runtimeSessionBindingSchema.parse({
      ...binding,
      state: 'closed'
    })
    await this.awaitLocalOperation(
      '关闭不兼容会话绑定',
      this.options.bindingStore.put(closed),
      signal
    )
  }

  private unknownBinding(
    binding: RuntimeSessionBinding
  ): RuntimeSessionBinding {
    return runtimeSessionBindingSchema.parse({
      ...binding,
      state: binding.activePromptOperationId
        ? 'outcome-unknown'
        : 'interrupted'
    })
  }

  private async reconcilePromptOperation(
    context: ChannelContext,
    binding: RuntimeSessionBinding,
    signal?: AbortSignal
  ): Promise<{
    binding: RuntimeSessionBinding
    terminal: boolean
  }> {
    const operationId = binding.activePromptOperationId
    if (!operationId) {
      return { binding, terminal: true }
    }
    const result = await this.awaitOperation(
      context,
      '核对请求终态',
      context.channel.reconcilePromptOperation({
        bindingId: binding.bindingId,
        operationId,
        requestId: operationId
      }),
      signal,
      false
    ).catch(() => undefined)
    if (
      result?.status === 'terminal' &&
      (result.processTree === 'empty' ||
        result.terminalState === 'completed')
    ) {
      const terminal = await this.persist(
        context,
        binding,
        {
          state: 'ready',
          activePromptOperationId: undefined
        },
        signal
      )
      return { binding: terminal, terminal: true }
    }
    const unknown = this.unknownBinding(binding)
    await this.awaitLocalOperation(
      '保存结果未知会话绑定',
      this.options.bindingStore.put(unknown),
      signal
    )
    return { binding: unknown, terminal: false }
  }

  private async completePromptOperation(
    context: ChannelContext,
    binding: RuntimeSessionBinding,
    signal?: AbortSignal
  ): Promise<RuntimeSessionBinding> {
    const operationId = binding.activePromptOperationId
    if (!operationId) {
      throw new Error('远端 Runtime 请求缺少稳定操作身份')
    }
    try {
      await this.awaitOperation(
        context,
        '确认请求完成',
        context.channel.completePromptOperation({
          bindingId: binding.bindingId,
          operationId,
          requestId: operationId
        }),
        signal,
        false
      )
    } catch {
      const reconciled = await this.reconcilePromptOperation(
        context,
        binding,
        signal
      )
      if (reconciled.terminal) {
        return reconciled.binding
      }
      throw new Error(
        '远端 Runtime 完成确认响应不确定，且无法核对已接受的完成结果'
      )
    }
    return await this.persist(
      context,
      binding,
      {
        state: 'ready',
        activePromptOperationId: undefined
      },
      signal
    )
  }

  private promptPreparation(
    context: ChannelContext,
    binding: RuntimeSessionBinding,
    request: AgentExecutionRequest,
    modelBridge?: RemoteModelBridgeSession
  ): RemotePromptOperationPreparation {
    const workMode = request.workMode === 'execute' ? 'execute' : 'ask'
    const deadlineAt =
      this.promptTimeoutMs === undefined
        ? UNBOUNDED_REMOTE_PROMPT_DEADLINE
        : new Date(Date.now() + this.promptTimeoutMs).toISOString()
    const budget = {
      // The Agent applies this to the complete ACP stdin stream, not only
      // user content. The signed Runtime manifest supplies the effective
      // per-Runtime clamp.
      maximumInputBytes:
        REMOTE_RUNTIME_LAUNCH_LIMITS.maximumPromptInputBytes,
      maximumOutputBytes:
        this.options.maxRequestOutputBytes ??
        DEFAULT_MAX_REQUEST_OUTPUT_BYTES
    }
    const preparation = {
      bindingId: binding.bindingId,
      operationId: request.requestId,
      requestId: request.requestId,
      workMode,
      controllerId: binding.controllerId,
      controllerGeneration: binding.controllerGeneration,
      connectionGeneration: context.channel.generation,
      channelEpoch: binding.channelEpoch,
      hostId: binding.hostId,
      hostRevision: binding.hostRevision,
      hostKeyGeneration: binding.hostKeyGeneration,
      workspaceIdentity: binding.workspaceIdentity,
      agentInstallationId: binding.agentInstallationId,
      runtimeId: binding.runtimeId,
      runtimeBundleDigest: binding.runtimeBundleDigest,
      runtimeAdapterDigest: binding.runtimeAdapterDigest,
      ...(this.options.modelProfile === undefined
        ? {}
        : {
            modelProfile: agentPromptModelProfileSchema.parse(
              this.options.modelProfile
            )
          }),
      promptSequence: binding.promptSequence,
      ...(modelBridge === undefined
        ? {}
        : {
            modelBridge: {
              version: modelBridge.version,
              channelId: modelBridge.channelId,
              channelEpoch: modelBridge.channelEpoch,
              policy: modelBridge.policy
            }
          }),
      deadlineAt,
      budget
    }
    return this.options.modelProfile === undefined
      ? preparation as RemotePromptOperationPreparation
      : remotePromptOperationPreparationSchema.parse(preparation)
  }

  private async preparePrompt(
    context: ChannelContext,
    binding: RuntimeSessionBinding,
    request: AgentExecutionRequest,
    signal: AbortSignal
  ): Promise<{
    acceptance: RemotePromptOperationAcceptance
    modelBridge?: RemoteModelBridgeSession
  }> {
    this.assertHostCurrent(context, binding)
    const modelBridge =
      this.options.modelProfile === undefined
        ? await this.openModelBridge(
            context,
            binding,
            request
          )
        : undefined
    const preparation = this.promptPreparation(
      context,
      binding,
      request,
      modelBridge
    )
    let raw: RemotePromptOperationAcceptance
    try {
      raw = await this.awaitOperation(
        context,
        '启动远端请求',
        context.channel.preparePrompt(preparation),
        signal
      )
    } catch (error) {
      await modelBridge?.close('prompt-preparation-failed')
      throw error
    }
    const acceptance =
      remotePromptOperationAcceptanceSchema.parse(raw)
    try {
      assertRemotePromptAcceptanceMatchesPreparation(
        preparation,
        acceptance
      )
    } catch {
      await modelBridge?.close('prompt-acceptance-mismatch')
      throw new Error('远端请求启动响应与稳定操作身份不匹配')
    }
    if (
      Date.parse(acceptance.deadlineAt) <= Date.now() ||
      !context.channel.isCurrentGeneration()
    ) {
      await modelBridge?.close('prompt-acceptance-invalid')
      throw new Error('远端请求启动响应已过期或连接代际已失效')
    }
    context.channel.setRecoveryBoundary?.(
      acceptance.deadlineAt,
      signal
    )
    return { acceptance, modelBridge }
  }

  private async openModelBridge(
    context: ChannelContext,
    binding: RuntimeSessionBinding,
    request: AgentExecutionRequest
  ): Promise<RemoteModelBridgeSession | undefined> {
    const policy = this.options.modelBridgePolicy
    if (policy === undefined) {
      return undefined
    }
    const parsedPolicy = modelBridgePolicySchema.parse(policy)
    if (
      binding.modelBridgeVersion !== MODEL_BRIDGE_PROTOCOL ||
      !isDeepStrictEqual(binding.modelBridgePolicy, parsedPolicy) ||
      context.channel.capabilities.modelBridge !== true ||
      context.channel.openModelBridge === undefined
    ) {
      throw new Error(
        '远端 Runtime Model Bridge 策略与持久化会话或 Agent 能力不匹配'
      )
    }
    return await context.channel.openModelBridge({
      bindingId: binding.bindingId,
      promptOperationId: request.requestId,
      requestId: request.requestId,
      policy: parsedPolicy
    })
  }

  private async closeModelBridge(
    session: SessionRecord,
    binding: RuntimeSessionBinding,
    reason: string
  ): Promise<RuntimeSessionBinding> {
    const bridge = session.modelBridge
    session.modelBridge = undefined
    if (bridge === undefined) {
      return binding
    }
    const result = await bridge.close(reason).catch(() => ({
      clean: false,
      poisoned: true
    }))
    if (result.clean && !result.poisoned) {
      return binding
    }
    const unknown = runtimeSessionBindingSchema.parse({
      ...binding,
      state: 'outcome-unknown'
    })
    await this.awaitLocalOperation(
      '保存模型请求结果未知会话绑定',
      this.options.bindingStore.put(unknown)
    )
    return unknown
  }

  private assertHostCurrent(
    context: ChannelContext,
    binding: RuntimeSessionBinding
  ): void {
    try {
      this.options.assertHostCurrent({
        controllerId: binding.controllerId,
        hostId: binding.hostId,
        hostRevision: binding.hostRevision,
        hostKeyGeneration: binding.hostKeyGeneration,
        agentInstallationId: binding.agentInstallationId
      })
    } catch (error) {
      const stale =
        error instanceof Error
          ? error
          : new Error('远端 Runtime Host 绑定已失效')
      this.failContext(context, stale)
      throw stale
    }
  }

  private assertOwnedPromptChannel(context: ChannelContext): void {
    if (
      context.channel.capabilities.ownedPrompt !== true ||
      context.channel.startOwnedPrompt === undefined ||
      context.channel.attachOwnedPrompt === undefined ||
      context.channel.pageOwnedPromptTranscript === undefined ||
      context.channel.ackOwnedPromptTranscript === undefined
    ) {
      throw new Error(
        '远端 Runtime 缺少 Agent 托管请求与语义记录能力'
      )
    }
  }

  private newBinding(
    conversationId: string,
    bindingId: string,
    context: ChannelContext
  ): RuntimeSessionBinding {
    return runtimeSessionBindingSchema.parse({
      bindingId,
      ...this.options.identity,
      conversationId,
      runtimeId: this.options.runtimeId,
      acpSessionId: `opening-${randomUUID()}`,
      acpCapabilitiesDigest:
        context.channel.advertisedAcpCapabilitiesDigest,
      ...(this.options.modelBridgePolicy === undefined
        ? {}
        : {
            modelBridgeVersion: MODEL_BRIDGE_PROTOCOL,
            modelBridgePolicy: modelBridgePolicySchema.parse(
              this.options.modelBridgePolicy
            )
          }),
      state: 'opening',
      channelEpoch: context.channel.channelEpoch,
      lastOutboundJournaledSequence: '0',
      lastOutboundDeliveredSequence: '0',
      lastInboundJournaledSequence: '0',
      lastMainAckSequence: '0'
    })
  }

  private async openSession(
    conversationId: string,
    request: AgentExecutionRequest,
    signal: AbortSignal
  ): Promise<SessionRecord> {
    let binding = await this.awaitLocalOperation(
      '读取会话绑定',
      this.options.bindingStore.getByConversation(conversationId),
      signal
    )
    if (
      request.remoteRecoveryOnly === true &&
      !(
        binding?.state === 'prompt-running' &&
        binding.activePromptOperationId === request.requestId
      )
    ) {
      throw new RemotePromptRecoveryUnavailableError(
        '没有可安全附加的远端 Agent 请求，且恢复不会重放任务'
      )
    }
    if (
      request.remoteRecoveryOnly !== true &&
      this.options.modelProfile !== undefined &&
      binding?.state === 'prompt-running' &&
      binding.activePromptOperationId !== request.requestId
    ) {
      if (this.bindingIdentityMatches(binding)) {
        throw new Error(
          '当前对话仍有 Agent 托管请求，必须先恢复或取消原请求'
        )
      }
      await this.persistClosedBinding(binding)
      binding = undefined
    }
    if (
      binding &&
      binding.state !== 'closed' &&
      binding.state !== 'ready' &&
      !(
        this.options.modelProfile !== undefined &&
        binding.state === 'prompt-running' &&
        binding.activePromptOperationId === request.requestId
      )
    ) {
      await this.persistClosedBinding(binding)
      binding = undefined
    }
    let bindingId = binding?.bindingId ?? randomUUID()
    if (
      binding?.state === 'ready' &&
      !this.bindingIdentityMatches(binding)
    ) {
      await this.closeIdleBinding(binding, signal)
      binding = undefined
      bindingId = randomUUID()
    }
    let context: ChannelContext
    try {
      context = await this.createConversationContext(
        conversationId,
        bindingId,
        signal
      )
    } catch (error) {
      if (
        request.remoteRecoveryOnly === true &&
        isDefinitiveRemoteRuntimeRequestRejection(
          error,
          'runtime/openAcpChannel'
        )
      ) {
        throw new RemotePromptRecoveryUnavailableError(
          '远端 Agent 已明确拒绝恢复原通道，恢复不会重放任务',
          { cause: error }
        )
      }
      throw error
    }
    let pendingModelBridge: RemoteModelBridgeSession | undefined
    try {
      this.assertUsable(context)
      if (
        !context.channel.capabilities.promptOperationReconciliation
      ) {
        throw new Error(
          '远端 Runtime 缺少稳定操作核对能力'
        )
      }
      sha256DigestSchema.parse(
        context.channel.advertisedAcpCapabilitiesDigest
      )
      if (
        binding?.state === 'prompt-running' &&
        this.options.modelProfile !== undefined
      ) {
        this.assertOwnedPromptChannel(context)
        binding = await this.rotateBindingTransport(
          binding,
          context,
          signal
        )
        if (
          !this.bindingIdentityMatches(binding) ||
          binding.activePromptOperationId !== request.requestId
        ) {
          throw new Error(
            '远端 Agent 已有请求与当前恢复身份不匹配'
          )
        }
        let attached: ReturnType<
          typeof remoteOwnedPromptStartResultSchema.parse
        >
        try {
          attached = remoteOwnedPromptStartResultSchema.parse(
            await this.awaitOperation(
              context,
              '附加远端 Agent 请求',
              context.channel.attachOwnedPrompt!({
                bindingId: binding.bindingId,
                operationId: request.requestId,
                requestId: request.requestId
              }),
              signal,
              false
            )
          )
        } catch (error) {
          if (
            isDefinitiveRemoteRuntimeRequestRejection(
              error,
              'runtime/attachPrompt'
            )
          ) {
            throw new RemotePromptRecoveryUnavailableError(
              '远端 Agent 已明确拒绝附加原请求，恢复不会重放任务',
              { cause: error }
            )
          }
          throw error
        }
        if (
          attached.bindingId !== binding.bindingId ||
          attached.operationId !== request.requestId ||
          attached.requestId !== request.requestId
        ) {
          throw new Error('远端 Agent 请求附加身份不匹配')
        }
        binding = await this.awaitLocalOperation(
          '声明 Agent 会话身份',
          this.options.bindingStore.claimAcpSession(
            binding.bindingId,
            attached.sessionId
          ),
          signal
        )
        return {
          binding,
          sessionId: attached.sessionId,
          context,
          sendHistoryWithNextPrompt: false,
          ownedPromptAttached: true
        }
      }
      if (
        binding?.state === 'ready' &&
        !this.bindingMatches(binding, context)
      ) {
        await this.closeIdleBinding(binding, signal)
        binding = undefined
        bindingId = randomUUID()
        if (this.options.channelFactory) {
          this.contexts.delete(conversationId)
          await this.awaitLocalOperation(
            '关闭不兼容会话通道',
            this.closeContext(context),
            signal
          )
          context = await this.createConversationContext(
            conversationId,
            bindingId,
            signal
          )
          this.assertUsable(context)
          if (
            !context.channel.capabilities
              .promptOperationReconciliation
          ) {
            throw new Error(
              '远端 Runtime 缺少稳定操作核对能力'
            )
          }
          sha256DigestSchema.parse(
            context.channel.advertisedAcpCapabilitiesDigest
          )
        }
      }
      if (binding?.state === 'ready') {
        binding = await this.rotateBindingTransport(
          binding,
          context,
          signal
        )
        this.assertHostCurrent(context, binding)
        binding = await this.persist(
          context,
          binding,
          {
            state: 'prompt-running',
            activePromptOperationId: request.requestId,
            promptSequence: nextPromptSequence(
              binding.promptSequence
            )
          },
          signal
        )
        const prepared = await this.preparePrompt(
          context,
          binding,
          request,
          signal
        )
        pendingModelBridge = prepared.modelBridge
        if (this.options.modelProfile !== undefined) {
          this.assertOwnedPromptChannel(context)
          return {
            binding,
            sessionId: binding.acpSessionId,
            context,
            sendHistoryWithNextPrompt: false,
            ownedPromptAttached: false
          }
        }
        const state = await this.getState(context, signal)
        binding = await this.awaitLocalOperation(
          '声明恢复会话身份',
          this.options.bindingStore.claimAcpSession(
            binding.bindingId,
            binding.acpSessionId
          ),
          signal
        )
        if (state.capabilities.loadSession === true) {
          await this.awaitOperation(
            context,
            '加载会话',
            state.agent.loadSession({
              sessionId: binding.acpSessionId,
              cwd: this.options.workspacePath,
              mcpServers: []
            }),
            signal
          )
        } else if (state.capabilities.sessionCapabilities?.resume) {
          await this.awaitOperation(
            context,
            '恢复会话',
            state.agent.resumeSession({
              sessionId: binding.acpSessionId,
              cwd: this.options.workspacePath,
              mcpServers: []
            }),
            signal
          )
        } else {
          throw new Error('远端 ACP Runtime 不支持恢复已有会话')
        }
        const session = {
          binding,
          sessionId: binding.acpSessionId,
          context,
          modelBridge: prepared.modelBridge,
          sendHistoryWithNextPrompt: false
        }
        pendingModelBridge = undefined
        return session
      }

      binding = this.newBinding(
        conversationId,
        bindingId,
        context
      )
      await this.awaitLocalOperation(
        '保存新会话绑定',
        this.options.bindingStore.put(binding),
        signal
      )
      this.assertHostCurrent(context, binding)
      binding = await this.persist(
        context,
        binding,
        {
          state: 'prompt-running',
          activePromptOperationId: request.requestId
        },
        signal
      )
      const prepared = await this.preparePrompt(
        context,
        binding,
        request,
        signal
      )
      pendingModelBridge = prepared.modelBridge
      if (this.options.modelProfile !== undefined) {
        this.assertOwnedPromptChannel(context)
        return {
          binding,
          sessionId: binding.acpSessionId,
          context,
          sendHistoryWithNextPrompt: true,
          ownedPromptAttached: false
        }
      }
      const state = await this.getState(context, signal)
      const response = await this.awaitOperation(
        context,
        '创建会话',
        state.agent.newSession({
          cwd: this.options.workspacePath,
          mcpServers: []
        }),
        signal
      )
      if (!response.sessionId) {
        throw new Error('远端 ACP Runtime 未返回会话 ID')
      }
      binding = await this.awaitLocalOperation(
        '声明新会话身份',
        this.options.bindingStore.claimAcpSession(
          binding.bindingId,
          response.sessionId
        ),
        signal
      )
      binding = await this.persist(
        context,
        binding,
        {
          state: 'prompt-running',
          activePromptOperationId: request.requestId
        },
        signal
      )
      const session = {
        binding,
        sessionId: response.sessionId,
        context,
        modelBridge: prepared.modelBridge,
        sendHistoryWithNextPrompt: true
      }
      pendingModelBridge = undefined
      return session
    } catch (error) {
      await pendingModelBridge
        ?.close('session-initialization-failed')
        .catch(() => undefined)
      if (binding) {
        if (
          this.options.modelProfile !== undefined &&
          binding.state === 'prompt-running'
        ) {
          throw error
        }
        const persist =
          isDefinitiveRemoteRuntimeRequestRejection(
            error,
            'runtime/preparePrompt'
          )
            ? this.persistClosedBinding(binding)
            : this.persistInterrupted(binding)
        await persist.catch(() => undefined)
      }
      throw error
    }
  }

  private async getSession(
    conversationId: string,
    request: AgentExecutionRequest,
    signal: AbortSignal
  ): Promise<SessionRecord> {
    let current = this.sessions.get(conversationId)
    if (
      current?.binding.activePromptOperationId &&
      this.options.modelProfile === undefined
    ) {
      this.sessions.delete(conversationId)
      this.contexts.delete(conversationId)
      await this.awaitLocalOperation(
        '关闭结果未知会话通道',
        this.closeContext(current.context),
        signal
      ).catch(() => undefined)
      current = undefined
    }
    if (
      current?.binding.activePromptOperationId === request.requestId &&
      current.ownedPromptAttached
    ) {
      return current
    }
    if (current) {
      try {
        this.assertHostCurrent(
          current.context,
          current.binding
        )
        current.binding = await this.persist(
          current.context,
          current.binding,
          {
            state: 'prompt-running',
            activePromptOperationId: request.requestId,
            promptSequence: nextPromptSequence(
              current.binding.promptSequence
            )
          },
          signal
        )
        const prepared = await this.preparePrompt(
          current.context,
          current.binding,
          request,
          signal
        )
        current.modelBridge = prepared.modelBridge
        if (this.options.modelProfile !== undefined) {
          current.ownedPromptAttached = false
        }
        return current
      } catch (error) {
        const persist =
          isDefinitiveRemoteRuntimeRequestRejection(
            error,
            'runtime/preparePrompt'
          )
            ? this.persistClosedBinding(current.binding)
            : this.persistInterrupted(current.binding)
        current.binding = await persist.catch(() => current.binding)
        this.sessions.delete(conversationId)
        this.contexts.delete(conversationId)
        await this.closeContext(current.context).catch(() => undefined)
        throw error
      }
    }
    const pending = this.sessionInitializations.get(conversationId)
    if (pending) {
      return this.awaitLocalOperation(
        '等待会话初始化',
        pending,
        signal
      )
    }
    const opening = this.openSession(conversationId, request, signal)
      .then((session) => {
        this.sessions.set(conversationId, session)
        return session
      })
      .catch(async (error: unknown) => {
        const context = this.contexts.get(conversationId)
        if (context) {
          this.contexts.delete(conversationId)
          await this.closeContext(context).catch(() => undefined)
        }
        throw error
      })
    this.sessionInitializations.set(conversationId, opening)
    try {
      return await this.awaitLocalOperation(
        '等待会话初始化',
        opening,
        signal
      )
    } finally {
      this.sessionInitializations.delete(conversationId)
      this.notifyDrain()
    }
  }

  private async handleSessionUpdate(
    context: ChannelContext,
    notification: SessionNotification
  ): Promise<void> {
    try {
      this.assertUsable(context, true)
    } catch (error) {
      this.failContext(
        context,
        error instanceof Error
          ? error
          : new Error('远端 Runtime 代际失效')
      )
      return
    }
    const prompt = [...this.activePrompts.values()].find(
      (candidate) =>
        candidate.context === context &&
        candidate.sessionId === notification.sessionId
    )
    if (!prompt?.open) {
      return
    }
    if (prompt.interruption) {
      return
    }
    const bytes = utf8JsonBytes(notification.update)
    const maximumItems = Math.max(
      1,
      this.options.maxPendingUpdates ?? DEFAULT_MAX_PENDING_UPDATES
    )
    const maximumBytes = Math.max(
      1,
      this.options.maxPendingUpdateBytes ??
        DEFAULT_MAX_PENDING_UPDATE_BYTES
    )
    if (
      prompt.updates.length >= maximumItems ||
      prompt.pendingUpdateBytes + bytes > maximumBytes
    ) {
      const overflow = new Error(
        '远端 Runtime 待消费事件超过安全上限，输出已截断且请求状态未知'
      )
      prompt.interruption = overflow
      prompt.interrupt?.(overflow)
      prompt.wake?.()
      prompt.wake = undefined
      throw overflow
    }
    let consume: (() => void) | undefined
    const consumed = new Promise<void>((resolve) => {
      consume = resolve
    })
    prompt.updates.push({
      update: notification.update,
      bytes,
      consumed: consume!
    })
    prompt.pendingUpdateBytes += bytes
    prompt.wake?.()
    prompt.wake = undefined
    if (
      !prompt.inboundPaused &&
      (
        prompt.updates.length >= maximumItems ||
        prompt.pendingUpdateBytes >= maximumBytes
      )
    ) {
      prompt.inboundPaused = true
      await this.awaitOperation(
        context,
        '暂停入站事件',
        context.channel.setInboundPaused(true)
      )
    }
    await consumed
  }

  private consumeUpdate(prompt: ActivePrompt): SessionUpdate | undefined {
    const queued = prompt.updates.shift()
    if (!queued) {
      return undefined
    }
    prompt.pendingUpdateBytes = Math.max(
      0,
      prompt.pendingUpdateBytes - queued.bytes
    )
    queued.consumed()
    if (prompt.inboundPaused && !prompt.interruption) {
      prompt.inboundPaused = false
      void this.awaitOperation(
        prompt.context,
        '恢复入站事件',
        prompt.context.channel.setInboundPaused(false)
      ).catch(() => undefined)
    }
    return queued.update
  }

  private discardUpdates(prompt: ActivePrompt): void {
    for (const queued of prompt.updates.splice(0)) {
      queued.consumed()
    }
    prompt.pendingUpdateBytes = 0
    if (prompt.inboundPaused && !prompt.interruption) {
      prompt.inboundPaused = false
      void this.awaitOperation(
        prompt.context,
        '恢复入站事件',
        prompt.context.channel.setInboundPaused(false)
      ).catch(() => undefined)
    }
  }

  private async handlePermission(
    context: ChannelContext,
    permission: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    try {
      this.assertUsable(context, true)
    } catch {
      return permissionRejection(permission)
    }
    const prompt = [...this.activePrompts.values()].find(
      (candidate) =>
        candidate.context === context &&
        candidate.sessionId === permission.sessionId
    )
    if (
      !prompt?.open ||
      prompt.completed
    ) {
      return permissionRejection(permission)
    }
    const allowOnce = permission.options.find(
      (option) => option.kind === 'allow_once'
    )
    const allowAlways = permission.options.find(
      (option) => option.kind === 'allow_always'
    )
    if (prompt.workMode === 'ask') {
      return permission.toolCall.kind === 'read' && allowOnce
        ? {
            outcome: {
              outcome: 'selected',
              optionId: allowOnce.optionId
            }
          }
        : permissionRejection(permission)
    }
    if (!prompt.authorize) {
      const selected = allowAlways ?? allowOnce
      return selected
        ? {
            outcome: {
              outcome: 'selected',
              optionId: selected.optionId
            }
          }
        : permissionRejection(permission)
    }
    const input = safeStringify(
      permission.toolCall.rawInput,
      this.options.maxEventCharacters ??
        DEFAULT_MAX_EVENT_CHARACTERS
    )
    const decision = await prompt
      .authorize({
        scopeKey: `acp-remote:${permission.toolCall.kind ?? 'tool'}`,
        title: (
          permission.toolCall.title ??
          '远端 Runtime 工具请求'
        ).slice(0, 200),
        description: '远端 Runtime 请求在副作用发生前执行此工具',
        ...(permission.toolCall.kind
          ? { toolName: permission.toolCall.kind.slice(0, 200) }
          : {}),
        ...(input ? { argumentSummary: input } : {}),
        allowPermanent: Boolean(allowAlways)
      })
      .catch(() => 'deny' as const)
    if (
      !prompt.open ||
      prompt.completed ||
      this.activePrompts.get(prompt.bindingId) !== prompt ||
      !context.channel.isCurrentGeneration()
    ) {
      return permissionRejection(permission)
    }
    const selected =
      (decision === 'session' || decision === 'permanent') &&
      allowAlways
        ? allowAlways
        : decision !== 'deny'
          ? allowOnce
          : undefined
    return selected
      ? {
          outcome: {
            outcome: 'selected',
            optionId: selected.optionId
          }
        }
      : permissionRejection(permission)
  }

  private waitForUpdate(prompt: ActivePrompt): Promise<void> {
    if (
      prompt.updates.length > 0 ||
      !prompt.open ||
      prompt.interruption !== undefined ||
      prompt.context.fatalError
    ) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      prompt.wake = resolve
    })
  }

  private limitEvent(
    prompt: ActivePrompt,
    event: RuntimePublicEvent
  ): RuntimePublicEvent {
    const maximum =
      this.options.maxEventCharacters ??
      DEFAULT_MAX_EVENT_CHARACTERS
    let characters = 0
    if (event.type === 'text' || event.type === 'reasoning') {
      characters = event.delta.length
      if (characters > maximum) {
        event = { ...event, delta: `${event.delta.slice(0, maximum)}…` }
        characters = maximum + 1
      }
    } else if (event.type === 'tool') {
      const fieldMaximum = Math.max(1, Math.floor(maximum / 3))
      const bounded = (value: string | undefined): string | undefined =>
        value && value.length > fieldMaximum
          ? `${value.slice(0, fieldMaximum)}…`
          : value
      event = {
        ...event,
        input: bounded(event.input),
        output: bounded(event.output),
        error: bounded(event.error)
      }
      characters =
        (event.input?.length ?? 0) +
        (event.output?.length ?? 0) +
        (event.error?.length ?? 0)
    } else if (event.type === 'subagent') {
      const fieldMaximum = Math.max(1, Math.floor(maximum / 2))
      const bounded = (value: string | undefined): string | undefined =>
        value && value.length > fieldMaximum
          ? `${value.slice(0, fieldMaximum)}…`
          : value
      event = {
        ...event,
        output: bounded(event.output),
        error: bounded(event.error)
      }
      characters =
        (event.reason?.length ?? 0) +
        (event.output?.length ?? 0) +
        (event.error?.length ?? 0)
    } else if (event.type === 'status') {
      if (event.message.length > maximum) {
        event = {
          ...event,
          message: `${event.message.slice(0, maximum)}…`
        }
      }
      characters = event.message.length
    }
    prompt.outputCharacters += characters
    if (
      prompt.outputCharacters >
      (this.options.maxRequestOutputBytes ??
        DEFAULT_MAX_REQUEST_OUTPUT_BYTES)
    ) {
      throw new Error('远端 Runtime 请求输出超过安全上限')
    }
    return event
  }

  private mapUpdate(
    prompt: ActivePrompt,
    update: SessionUpdate
  ): RuntimePublicEvent | undefined {
    if (
      (update.sessionUpdate === 'agent_message_chunk' ||
        update.sessionUpdate === 'agent_thought_chunk') &&
      update.content.type === 'text' &&
      update.content.text
    ) {
      return {
        requestId: prompt.requestId,
        type:
          update.sessionUpdate === 'agent_message_chunk'
            ? 'text'
            : 'reasoning',
        delta: update.content.text
      }
    }
    if (
      update.sessionUpdate === 'tool_call' ||
      update.sessionUpdate === 'tool_call_update'
    ) {
      const callId = update.toolCallId.slice(0, 256)
      const previous = prompt.toolCalls.get(callId)
      if (
        !previous &&
        prompt.toolCalls.size >=
          maximumConversationToolActivities
      ) {
        throw new Error(
          '远端 Runtime 单次运行的工具调用超过 100 个'
        )
      }
      const retainedMaximum =
        this.options.maxEventCharacters ??
        DEFAULT_MAX_EVENT_CHARACTERS
      const toolCall = {
        title:
          update.title === null
            ? undefined
            : update.title?.slice(0, 200) ?? previous?.title,
        kind:
          update.kind === null
            ? undefined
            : update.kind?.slice(0, 200) ?? previous?.kind,
        status:
          update.status === null
            ? undefined
            : update.status ?? previous?.status,
        rawInput:
          update.rawInput === undefined
            ? previous?.rawInput
            : boundedRetainedToolInput(
                update.rawInput,
                retainedMaximum
              ),
        rawOutput:
          update.rawOutput === undefined
            ? previous?.rawOutput
            : boundedRetainedValue(
                update.rawOutput,
                retainedMaximum
              ),
        retainedInput:
          update.rawInput === undefined
            ? previous?.retainedInput
            : undefined,
        retainedOutput:
          update.rawOutput === undefined
            ? previous?.retainedOutput
            : undefined,
        retainedError:
          update.rawOutput === undefined
            ? previous?.retainedError
            : undefined,
        retainedSubagent: previous?.retainedSubagent
      }
      if (previous && isDeepStrictEqual(previous, toolCall)) {
        return undefined
      }
      prompt.toolCalls.set(callId, toolCall)
      const name = (
        toolCall.title ??
        toolCall.kind ??
        '远端 Runtime 工具'
      ).slice(0, 200)
      const subagent =
        this.options.runtimeId === 'opencode'
          ? toOpenCodeSubagentEvent({
              requestId: prompt.requestId,
              callId,
              state: toolCall.status ?? 'pending',
              input: toolCall.rawInput,
              output: toolCall.rawOutput
            })
          : undefined
      if (subagent) {
        return subagent
      }
      if (toolCall.retainedSubagent) {
        const retained = toolCall.retainedSubagent
        const state =
          toolCall.status === 'pending'
            ? ('queued' as const)
            : toolCall.status === 'in_progress'
              ? ('running' as const)
              : toolCall.status ?? retained.state
        const detail = safeStringify(
          toolCall.rawOutput,
          retainedMaximum
        )
        return {
          requestId: prompt.requestId,
          type: 'subagent',
          ...retained,
          state,
          ...(state === 'failed'
            ? {
                error:
                  detail ??
                  toolCall.retainedError ??
                  retained.error
              }
            : {
                output:
                  detail ??
                  toolCall.retainedOutput ??
                  retained.output
              })
        }
      }
      const input = safeStringify(
        toolCall.rawInput,
        retainedMaximum
      ) ?? toolCall.retainedInput
      const output = safeStringify(
        toolCall.rawOutput,
        retainedMaximum
      ) ?? toolCall.retainedOutput
      return {
        requestId: prompt.requestId,
        type: 'tool',
        callId,
        name,
        state:
          toolCall.status === 'in_progress'
            ? 'running'
            : toolCall.status ?? 'pending',
        summary: `远端 Runtime 工具：${name}`,
        ...(input ? { input } : {}),
        ...(output ? { output } : {}),
        ...(toolCall.retainedError
          ? { error: toolCall.retainedError }
          : {})
      }
    }
    if (update.sessionUpdate === 'plan') {
      return {
        requestId: prompt.requestId,
        type: 'status',
        message: update.entries
          .map((entry) => `[${entry.status}] ${entry.content}`)
          .join('\n')
      }
    }
    if (update.sessionUpdate === 'plan_update') {
      const plan = update.plan
      return {
        requestId: prompt.requestId,
        type: 'status',
        message:
          plan.type === 'items'
            ? plan.entries
                .map((entry) => `[${entry.status}] ${entry.content}`)
                .join('\n')
            : plan.type === 'markdown'
              ? plan.content
              : `计划已更新：${plan.uri}`
      }
    }
    if (update.sessionUpdate === 'plan_removed') {
      return {
        requestId: prompt.requestId,
        type: 'status',
        message: `计划已移除：${update.id}`
      }
    }
    if (update.sessionUpdate === 'usage_update') {
      return {
        requestId: prompt.requestId,
        type: 'context-metrics',
        contextTokens: Math.max(0, update.used),
        effectiveTriggerTokens: Math.max(0, update.size),
        contextWindowTokens: Math.max(0, update.size),
        compressionEnabled: false,
        source: 'provider',
        basis: 'conversation'
      }
    }
    return undefined
  }

  private withRemoteProvenance(
    event: RuntimePublicEvent,
    bindingId: string,
    operationId: string,
    semanticSequence: string,
    eventIndex: number
  ): RemoteSemanticRuntimeEvent {
    return {
      ...event,
      remoteProvenance: {
        source: 'remote-semantic-transcript',
        bindingId,
        operationId,
        semanticSequence,
        eventIndex
      }
    }
  }

  private remoteCheckpoint(
    requestId: string,
    bindingId: string,
    operationId: string,
    semanticSequence: string,
    eventIndex = 0
  ): RemoteSemanticCheckpointEvent {
    return {
      requestId,
      type: 'remote-semantic-checkpoint',
      remoteProvenance: {
        source: 'remote-semantic-transcript',
        bindingId,
        operationId,
        semanticSequence,
        eventIndex
      }
    }
  }

  private async *runOwnedPrompt(
    request: AgentExecutionRequest,
    session: SessionRecord,
    signal: AbortSignal,
    authorize?: RuntimeAuthorizer
  ): AsyncGenerator<RuntimeEvent, void, void> {
    const context = session.context
    this.assertOwnedPromptChannel(context)
    let binding = session.binding
    const operationId = request.requestId
    const prompt: ActivePrompt = {
      requestId: request.requestId,
      operationId,
      sessionId: session.sessionId,
      bindingId: binding.bindingId,
      workMode:
        request.workMode === 'execute' ? 'execute' : 'ask',
      authorize:
        request.workMode === 'execute' ? authorize : undefined,
      updates: [],
      pendingUpdateBytes: 0,
      inboundPaused: false,
      outputCharacters: 0,
      toolCalls: new Map(),
      open: true,
      completed: false,
      context
    }
    for (const tool of request.remoteRecoveredTools ?? []) {
      prompt.toolCalls.set(tool.callId.slice(0, 256), {
        title: tool.name.slice(0, 200),
        status:
          tool.state === 'running'
            ? 'in_progress'
            : tool.state === 'recoverable'
              ? 'completed'
              : tool.state === 'cancelled' ||
                  tool.state === 'interrupted'
                ? 'failed'
                : tool.state,
        retainedInput: tool.input,
        retainedOutput: tool.output,
        retainedError: tool.error
      })
    }
    for (const subagent of request.remoteRecoveredSubagents ?? []) {
      if (!subagent.runtimeCallId) {
        continue
      }
      prompt.toolCalls.set(subagent.runtimeCallId.slice(0, 256), {
        title: subagent.expertName.slice(0, 200),
        status:
          subagent.state === 'queued'
            ? 'pending'
            : subagent.state === 'running'
              ? 'in_progress'
              : subagent.state === 'cancelled'
                ? 'failed'
                : subagent.state,
        retainedOutput: subagent.output,
        retainedError: subagent.error,
        retainedSubagent: subagent
      })
    }
    this.activePrompts.set(binding.bindingId, prompt)
    const recoveringOwnedPrompt = session.ownedPromptAttached === true
    let reachedTerminal = false
    let cancellationEscalation: Promise<void> | undefined
    const escalate = (reason: unknown): Promise<void> => {
      if (!context.channel.capabilities.cancellationEscalation) {
        return Promise.resolve()
      }
      cancellationEscalation ??= this.awaitOperation(
          context,
          '升级 Agent 请求取消',
          context.channel.escalateCancellation({
            bindingId: binding.bindingId,
            sessionId: session.sessionId,
            operationId,
            requestId: operationId,
            reason
          }),
          undefined,
          false
        )
        .then(() => undefined)
        .catch(() => undefined)
      return cancellationEscalation
    }
    const cancel = (): void => {
      void escalate(abortReason(signal))
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      this.assertHostCurrent(context, binding)
      if (!session.ownedPromptAttached) {
        const promptText = promptWithUntrustedConversationHistory(
          request,
          session.sendHistoryWithNextPrompt
        )
        const started = remoteOwnedPromptStartResultSchema.parse(
          await this.awaitOperation(
            context,
            '启动 Agent 托管请求',
            context.channel.startOwnedPrompt!({
              bindingId: binding.bindingId,
              operationId,
              requestId: operationId,
              ...(binding.acpSessionId.startsWith('opening-')
                ? {}
                : { acpSessionId: binding.acpSessionId }),
              prompt: [
                { type: 'text', text: promptText },
                ...(request.images ?? []).map((image) => ({
                  type: 'image' as const,
                  data: image.data,
                  mimeType: image.mediaType
                }))
              ]
            }),
            signal,
            false
          )
        )
        if (
          started.bindingId !== binding.bindingId ||
          started.operationId !== operationId ||
          started.requestId !== operationId
        ) {
          throw new Error('远端 Agent 请求启动身份不匹配')
        }
        binding = await this.awaitLocalOperation(
          '声明 Agent 会话身份',
          this.options.bindingStore.claimAcpSession(
            binding.bindingId,
            started.sessionId
          ),
          signal
        )
        session.binding = binding
        session.sessionId = started.sessionId
        session.sendHistoryWithNextPrompt = false
        session.ownedPromptAttached = true
        prompt.sessionId = started.sessionId
      }

      if (!recoveringOwnedPrompt) {
        yield {
          requestId: request.requestId,
          type: 'status',
          message: '远端 Agent 正在处理请求'
        }
      }

      let afterSequence = request.remoteSemanticAfterSequence ?? '0'
      let transcriptPollDelayMs = 100
      const acknowledgeThrough = async (
        acknowledgedSequence: string
      ): Promise<void> => {
        const acknowledged =
          await context.channel.ackOwnedPromptTranscript!({
            bindingId: binding.bindingId,
            operationId,
            acknowledgedSequence
          })
        if (
          acknowledged.bindingId !== binding.bindingId ||
          acknowledged.operationId !== operationId ||
          BigInt(acknowledged.acknowledgedSequence) <
            BigInt(acknowledgedSequence)
        ) {
          throw new Error('远端 Agent 语义记录确认身份不匹配')
        }
      }
      for (;;) {
        const page = remoteSemanticTranscriptPageResultSchema.parse(
          await this.awaitOperation(
            context,
            '读取 Agent 语义记录',
            context.channel.pageOwnedPromptTranscript!({
              bindingId: binding.bindingId,
              operationId,
              afterSequence,
              limit:
                REMOTE_SEMANTIC_TRANSCRIPT_LIMITS.maximumEventsPerPage
            }),
            signal,
            false
          )
        )
        if (
          page.bindingId !== binding.bindingId ||
          page.operationId !== operationId
        ) {
          throw new Error('远端 Agent 语义记录身份不匹配')
        }
        if (page.events.length > 0) {
          transcriptPollDelayMs = 100
        }
        let pageAcknowledgedThrough: string | undefined
        for (const rawEvent of page.events) {
          const transcriptEvent =
            remoteSemanticTranscriptEventSchema.parse(rawEvent)
          if (
            BigInt(transcriptEvent.sequence) <=
            BigInt(afterSequence)
          ) {
            continue
          }
          const publicEvents: RuntimePublicEvent[] = []
          if (transcriptEvent.kind === 'session-update') {
            const notification =
              transcriptSessionNotification(
                transcriptEvent.payload,
                session.sessionId
              )
            const mapped = this.mapUpdate(prompt, notification.update)
            if (mapped !== undefined) {
              publicEvents.push(this.limitEvent(prompt, mapped))
            }
          } else if (transcriptEvent.kind === 'prompt-terminal') {
            const terminal = transcriptTerminal(
              transcriptEvent.payload,
              page.state
            )
            if (terminal.usage !== undefined) {
              const mappedUsage = usageEvent(
                request.requestId,
                terminal.usage,
                this.options.usage,
                operationId
              )
              if (mappedUsage !== undefined) {
                publicEvents.push(mappedUsage)
              }
            }
            if (terminal.state === 'completed') {
              publicEvents.push({
                requestId: request.requestId,
                type: 'done',
                sessionId: session.sessionId
              })
            } else {
              publicEvents.push({
                requestId: request.requestId,
                type: 'error',
                status:
                  terminal.state === 'cancelled'
                    ? 'cancelled'
                    : 'failed',
                message:
                  terminal.message ??
                  (terminal.state === 'cancelled'
                    ? '远端 Runtime 请求已取消'
                    : terminal.state === 'outcome-unknown'
                      ? '远端 Runtime 请求终态未知，且不会自动重放'
                      : '远端 Runtime 请求失败')
              })
            }
          }
          for (
            let eventIndex = 0;
            eventIndex < publicEvents.length;
            eventIndex += 1
          ) {
            yield this.withRemoteProvenance(
              publicEvents[eventIndex]!,
              binding.bindingId,
              operationId,
              transcriptEvent.sequence,
              eventIndex
            )
          }
          yield this.remoteCheckpoint(
            request.requestId,
            binding.bindingId,
            operationId,
            transcriptEvent.sequence,
            publicEvents.length
          )

          afterSequence = transcriptEvent.sequence
          pageAcknowledgedThrough = transcriptEvent.sequence

          if (transcriptEvent.kind === 'prompt-terminal') {
            await acknowledgeThrough(transcriptEvent.sequence)
            const terminal = transcriptTerminal(
              transcriptEvent.payload,
              page.state
            )
            reachedTerminal = true
            prompt.completed = true
            binding =
              terminal.state === 'outcome-unknown'
                ? runtimeSessionBindingSchema.parse({
                    ...binding,
                    state: 'outcome-unknown'
                  })
                : runtimeSessionBindingSchema.parse({
                    ...binding,
                    state: 'ready',
                    activePromptOperationId: undefined
                  })
            await this.awaitLocalOperation(
              '保存 Agent 请求终态',
              this.options.bindingStore.put(binding)
            )
            session.binding = binding
            if (terminal.state === 'cancelled') {
              throw signal.aborted
                ? abortReason(signal)
                : new Error('远端 Runtime 请求已取消')
            }
            if (terminal.state === 'failed') {
              throw new Error(
                terminal.message === undefined
                  ? '远端 Runtime 请求失败'
                  : `远端 Runtime 请求失败：${terminal.message}`
              )
            }
            if (terminal.state === 'outcome-unknown') {
              throw new Error(
                '远端 Runtime 请求终态未知，且不会自动重放'
              )
            }
            return
          }
        }
        if (pageAcknowledgedThrough !== undefined) {
          await acknowledgeThrough(pageAcknowledgedThrough)
        }
        if (page.hasMore) {
          transcriptPollDelayMs = 100
          continue
        }
        if (
          page.state === 'completed' ||
          page.state === 'failed' ||
          page.state === 'cancelled' ||
          page.state === 'outcome-unknown'
        ) {
          throw new Error('远端 Agent 请求缺少终态语义记录')
        }
        await delayOwnedTranscriptPoll(
          signal,
          transcriptPollDelayMs
        )
        transcriptPollDelayMs = Math.min(
          1_000,
          transcriptPollDelayMs * 2
        )
      }
    } finally {
      if (!reachedTerminal) {
        await escalate(
          signal.aborted
            ? abortReason(signal)
            : new Error('远端 Runtime 事件消费提前结束')
        )
      }
      signal.removeEventListener('abort', cancel)
      prompt.open = false
      this.activePrompts.delete(binding.bindingId)
    }
  }

  async *run(
    request: AgentExecutionRequest,
    signal: AbortSignal,
    authorize?: RuntimeAuthorizer
  ): AsyncGenerator<RuntimeEvent, void, void> {
    signal.throwIfAborted()
    this.assertUsable()
    if (!this.supportsToolExecution) {
      throw new Error(
        '远端 Runtime 缺少逐请求隔离证明或稳定操作核对能力'
      )
    }
    if (this.sessionReservations.has(request.conversationId)) {
      throw new Error('远端 ACP 会话已有活动请求')
    }
    this.sessionReservations.add(request.conversationId)
    let session: SessionRecord
    try {
      session = await this.getSession(
        request.conversationId,
        request,
        signal
      )
    } catch (error) {
      this.sessionReservations.delete(request.conversationId)
      throw error
    }
    const context = session.context
    if (this.options.modelProfile !== undefined) {
      try {
        yield* this.runOwnedPrompt(
          request,
          session,
          signal,
          authorize
        )
      } finally {
        this.sessionReservations.delete(request.conversationId)
        this.notifyDrain()
      }
      return
    }
    const state = context.state!
    const operationId = request.requestId
    let binding = session.binding
    const prompt: ActivePrompt = {
      requestId: request.requestId,
      operationId,
      sessionId: session.sessionId,
      bindingId: binding.bindingId,
      workMode:
        request.workMode === 'execute' ? 'execute' : 'ask',
      authorize:
        request.workMode === 'execute' ? authorize : undefined,
      updates: [],
      pendingUpdateBytes: 0,
      inboundPaused: false,
      outputCharacters: 0,
      toolCalls: new Map(),
      open: true,
      completed: false,
      context
    }
    this.activePrompts.set(binding.bindingId, prompt)
    let completed = false
    let response:
      | Awaited<ReturnType<ClientSideConnection['prompt']>>
      | undefined
    let promptError: unknown
    let promptStarted = false
    let cancellationStarted = false
    let promptTimeout: ReturnType<typeof setTimeout> | undefined
    let promptPromise: Promise<void> = Promise.resolve()
    const interrupt = (reason: Error): void => {
      prompt.interruption ??= reason
      void session.modelBridge?.close(
        reason instanceof RemoteOperationTimeoutError
          ? 'prompt-timeout'
          : 'prompt-cancelled'
      )
      if (!cancellationStarted && promptStarted) {
        cancellationStarted = true
        void state.agent
          .cancel({ sessionId: session.sessionId })
          .catch(() => undefined)
      }
      prompt.wake?.()
      prompt.wake = undefined
    }
    prompt.interrupt = interrupt
    const cancel = (): void => {
      const reason = abortReason(signal)
      interrupt(
        reason instanceof Error
          ? reason
          : new Error('远端 Runtime 请求已取消')
      )
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      signal.throwIfAborted()
      this.assertHostCurrent(context, binding)
      promptStarted = true
      const promptText = promptWithUntrustedConversationHistory(
        request,
        session.sendHistoryWithNextPrompt
      )
      promptPromise = state.agent
        .prompt({
          sessionId: session.sessionId,
          prompt: [
            { type: 'text', text: promptText },
            ...(request.images ?? []).map((image) => ({
              type: 'image' as const,
              data: image.data,
              mimeType: image.mediaType
            }))
          ]
        })
        .then((value) => {
          response = value
        })
        .catch((error: unknown) => {
          promptError = error
        })
        .finally(() => {
          completed = true
          prompt.completed = true
          prompt.wake?.()
          prompt.wake = undefined
        })
      session.sendHistoryWithNextPrompt = false
      if (this.promptTimeoutMs !== undefined) {
        promptTimeout = setTimeout(
          () => interrupt(new RemoteOperationTimeoutError('执行请求')),
          this.promptTimeoutMs
        )
      }
      yield {
        requestId: request.requestId,
        type: 'status',
        message: '远端 ACP Runtime 正在处理请求'
      }
      while (!completed || prompt.updates.length > 0) {
        if (prompt.interruption) {
          throw prompt.interruption
        }
        if (context.fatalError) {
          throw context.fatalError
        }
        if (prompt.updates.length === 0) {
          await this.waitForUpdate(prompt)
          continue
        }
        const update = this.consumeUpdate(prompt)
        if (!update) {
          continue
        }
        const event = this.mapUpdate(prompt, update)
        if (event) {
          yield this.limitEvent(prompt, event)
        }
      }
      await this.awaitOperation(
        context,
        '等待请求终态',
        promptPromise,
        signal
      )
      this.assertUsable(context, true)
      if (promptError) {
        throw promptError
      }
      if (response?.stopReason === 'cancelled') {
        throw signal.aborted
          ? signal.reason
          : new Error('远端 Runtime 请求已取消')
      }
      if (response?.usage) {
        const event = usageEvent(
          request.requestId,
          response.usage,
          this.options.usage,
          operationId
        )
        if (event) {
          yield event
        }
      }
      binding = await this.closeModelBridge(
        session,
        binding,
        'prompt-completed'
      )
      session.binding = binding
      if (binding.state === 'outcome-unknown') {
        throw new Error(
          '远端模型响应交付未确认，活动请求结果未知且不会自动重放'
        )
      }
      binding = await this.completePromptOperation(
        context,
        binding,
        signal
      )
      session.binding = binding
      yield {
        requestId: request.requestId,
        type: 'done',
        sessionId: session.sessionId
      }
    } catch (caught) {
      let error = caught
      binding = await this.closeModelBridge(
        session,
        binding,
        'prompt-failed'
      )
      session.binding = binding
      if (promptStarted && !completed) {
        interrupt(
          caught instanceof Error
            ? caught
            : new Error('远端 Runtime 请求已中断')
        )
        await Promise.race([
          promptPromise,
          new Promise<void>((resolve) =>
            setTimeout(
              resolve,
              this.options.cancellationGraceMs ??
                DEFAULT_CANCELLATION_GRACE_MS
            )
          )
        ])
        if (!completed) {
          if (
            context.channel.capabilities.cancellationEscalation
          ) {
            await this.awaitOperation(
              context,
              '升级取消',
              context.channel.escalateCancellation({
                bindingId: binding.bindingId,
                sessionId: session.sessionId,
                operationId,
                requestId: request.requestId,
                reason: caught
              }),
              undefined,
              false
            ).catch(() => undefined)
          }
          const detail =
            caught instanceof RemoteOperationTimeoutError
              ? `${caught.message}；`
              : ''
          const unknown = new Error(
            `${detail}远端 Runtime 取消升级后仍无终态，活动请求结果未知`
          )
          this.failContext(context, unknown)
          error = unknown
        }
      }
      if (binding.state !== 'outcome-unknown') {
        const reconciled = await this.reconcilePromptOperation(
          context,
          binding
        ).catch(() => ({
          binding: this.unknownBinding(binding),
          terminal: false
        }))
        binding = reconciled.binding
      }
      session.binding = binding
      throw error
    } finally {
      context.channel.clearRecoveryBoundary?.()
      if (session.modelBridge !== undefined) {
        binding = await this.closeModelBridge(
          session,
          binding,
          'prompt-finalized'
        )
        session.binding = binding
      }
      if (promptStarted && !completed && !prompt.interruption) {
        const abandoned = new Error(
          '远端 Runtime 事件消费提前结束，请求已中断'
        )
        interrupt(abandoned)
        await Promise.race([
          promptPromise,
          new Promise<void>((resolve) =>
            setTimeout(
              resolve,
              this.options.cancellationGraceMs ??
                DEFAULT_CANCELLATION_GRACE_MS
            )
          )
        ])
        if (
          !completed &&
          context.channel.capabilities.cancellationEscalation
        ) {
          await this.awaitOperation(
            context,
            '升级提前结束的请求',
            context.channel.escalateCancellation({
              bindingId: binding.bindingId,
              sessionId: session.sessionId,
              operationId,
              requestId: request.requestId,
              reason: abandoned
            }),
            undefined,
            false
          ).catch(() => undefined)
        }
        if (!completed) {
          this.failContext(
            context,
            new Error(
              '远端 Runtime 事件消费结束后仍无终态，活动请求结果未知'
            )
          )
        }
        if (binding.state !== 'outcome-unknown') {
          binding = (
            await this.reconcilePromptOperation(
              context,
              binding
            ).catch(() => ({
              binding: this.unknownBinding(binding),
              terminal: false
            }))
          ).binding
        }
        session.binding = binding
      }
      prompt.open = false
      prompt.interrupt = undefined
      prompt.wake?.()
      prompt.wake = undefined
      signal.removeEventListener('abort', cancel)
      if (promptTimeout) {
        clearTimeout(promptTimeout)
      }
      this.discardUpdates(prompt)
      this.activePrompts.delete(binding.bindingId)
      this.sessionReservations.delete(request.conversationId)
      this.notifyDrain()
    }
  }

  async releaseConversation(
    conversationId: string,
    signal?: AbortSignal
  ): Promise<void> {
    const pending = this.sessionInitializations.get(conversationId)
    if (pending) {
      await this.awaitLocalOperation(
        '等待待释放会话初始化',
        pending,
        signal
      ).catch(() => undefined)
    }
    const session = this.sessions.get(conversationId)
    const context =
      session?.context ?? this.contexts.get(conversationId)
    if (!context) {
      return
    }
    const state = context.state
    try {
      if (!session) {
        return
      }
      if (session.binding.activePromptOperationId) {
        const reconciled = await this.reconcilePromptOperation(
          context,
          session.binding,
          signal
        )
        session.binding = reconciled.binding
        if (!reconciled.terminal) {
          throw new Error(
            '远端 ACP 活动操作结果未知，无法释放会话身份'
          )
        }
      }
      if (state) {
        if (state.capabilities.sessionCapabilities?.close) {
          await this.awaitOperation(
            context,
            '关闭会话',
            state.agent.closeSession({
              sessionId: session.sessionId
            }),
            signal
          )
        } else {
          await this.awaitOperation(
            context,
            '取消会话',
            state.agent.cancel({ sessionId: session.sessionId }),
            signal
          )
        }
      }
      session.binding = await this.persist(
        context,
        session.binding,
        {
          state: 'closed',
          activePromptOperationId: undefined
        },
        signal
      )
    } catch (error) {
      if (session) {
        session.binding = await this.persistInterrupted(
          session.binding
        ).catch(() => ({
          ...this.unknownBinding(session.binding)
        }))
      }
      throw error
    } finally {
      this.sessions.delete(conversationId)
      this.contexts.delete(conversationId)
      await this.awaitLocalOperation(
        '关闭会话通道',
        this.closeContext(context)
      ).catch(() => undefined)
      this.notifyDrain()
    }
  }

  beginDrain(): Promise<void> {
    this.draining = true
    this.notifyDrain()
    return Promise.resolve()
  }

  waitForDrain(): Promise<void> {
    if (
      this.sessions.size === 0 &&
      this.activePrompts.size === 0 &&
      this.sessionReservations.size === 0 &&
      this.sessionInitializations.size === 0
    ) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.drainWaiters.add(resolve)
    })
  }

  private notifyDrain(): void {
    if (
      this.sessions.size > 0 ||
      this.activePrompts.size > 0 ||
      this.sessionReservations.size > 0 ||
      this.sessionInitializations.size > 0
    ) {
      return
    }
    for (const resolve of this.drainWaiters) {
      resolve()
    }
    this.drainWaiters.clear()
  }

  private failContext(context: ChannelContext, error: Error): void {
    context.fatalError ??= error
    for (const prompt of this.activePrompts.values()) {
      if (prompt.context === context) {
        prompt.wake?.()
        prompt.wake = undefined
      }
    }
    void this.closeContext(context).catch(() => undefined)
  }

  async forceShutdown(): Promise<void> {
    for (const prompt of this.activePrompts.values()) {
      prompt.interrupt?.(
        new Error('GoodBuddy 正在强制关闭远端 Runtime')
      )
    }
    await Promise.all(
      [...this.sessions.values()].map(async (session) => {
        const context = session.context
        const state = context.state
        const operationId =
          session.binding.activePromptOperationId
        if (state) {
          await this.awaitOperation(
            context,
            '强制取消会话',
            state.agent.cancel({ sessionId: session.sessionId }),
            undefined,
            false
          ).catch(() => undefined)
        }
        if (operationId) {
          await this.awaitOperation(
            context,
            '按稳定操作身份升级强制取消',
            context.channel.escalateCancellation({
              bindingId: session.binding.bindingId,
              sessionId: session.sessionId,
              operationId,
              requestId: operationId,
              reason: new Error('GoodBuddy 正在强制关闭 Runtime')
            }),
            undefined,
            false
          ).catch(() => undefined)
          session.binding = (
            await this.reconcilePromptOperation(
              context,
              session.binding
            ).catch(() => ({
              binding: this.unknownBinding(session.binding),
              terminal: false
            }))
          ).binding
          return
        }
        session.binding = await this.persistInterrupted(
          session.binding
        ).catch(() => this.unknownBinding(session.binding))
      })
    )
    await this.dispose()
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return
    }
    this.disposed = true
    for (const prompt of this.activePrompts.values()) {
      prompt.interrupt?.(
        new Error('远端 Runtime 已关闭，活动请求结果需要核对')
      )
      prompt.open = false
      prompt.wake?.()
      this.discardUpdates(prompt)
    }
    this.activePrompts.clear()
    this.sessionReservations.clear()
    this.sessions.clear()
    this.sessionInitializations.clear()
    this.contexts.clear()
    await Promise.allSettled(
      [...this.allContexts].map((context) =>
        this.awaitLocalOperation(
          '关闭通道',
          this.closeContext(context)
        )
      )
    )
    this.notifyDrain()
  }
}

function nextPromptSequence(current: number): number {
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    current >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error('远端 Runtime 请求序列已耗尽')
  }
  return current + 1
}

function transcriptSessionNotification(
  payload: unknown,
  expectedSessionId: string
): SessionNotification {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    !('sessionId' in payload) ||
    payload.sessionId !== expectedSessionId ||
    !('update' in payload) ||
    payload.update === null ||
    typeof payload.update !== 'object'
  ) {
    throw new Error('远端 Agent 会话更新无效')
  }
  return payload as SessionNotification
}

function transcriptTerminal(
  payload: unknown,
  pageState:
    | 'starting'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'outcome-unknown'
): {
  state: 'completed' | 'failed' | 'cancelled' | 'outcome-unknown'
  usage?: Usage
  message?: string
} {
  if (
    ![
      'completed',
      'failed',
      'cancelled',
      'outcome-unknown'
    ].includes(pageState) ||
    payload === null ||
    typeof payload !== 'object' ||
    !('status' in payload) ||
    payload.status !== pageState
  ) {
    throw new Error('远端 Agent 请求终态无效')
  }
  let usage: Usage | undefined
  if (
    'response' in payload &&
    payload.response !== null &&
    typeof payload.response === 'object' &&
    'usage' in payload.response &&
    payload.response.usage !== undefined
  ) {
    const candidate = payload.response.usage
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      !('inputTokens' in candidate) ||
      typeof candidate.inputTokens !== 'number' ||
      !('outputTokens' in candidate) ||
      typeof candidate.outputTokens !== 'number' ||
      !('totalTokens' in candidate) ||
      typeof candidate.totalTokens !== 'number'
    ) {
      throw new Error('远端 Agent 模型用量无效')
    }
    usage = candidate as Usage
  }
  const message =
    'error' in payload &&
    payload.error !== null &&
    typeof payload.error === 'object' &&
    'message' in payload.error &&
    typeof payload.error.message === 'string'
      ? payload.error.message.slice(0, 8 * 1024)
      : undefined
  const state = pageState as
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'outcome-unknown'
  return {
    state,
    ...(usage === undefined ? {} : { usage }),
    ...(message === undefined ? {} : { message })
  }
}

async function delayOwnedTranscriptPoll(
  signal: AbortSignal,
  delayMs: number
): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, delayMs)
    const abort = (): void => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (!signal.aborted) {
      return
    }
    abort()
  })
}
