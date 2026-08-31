import type {
  AgentRuntimeStatus,
  RuntimeNativeSnapshot,
  RuntimeNativeTool
} from '../../shared/contracts'
import {
  runtimeNativeInventoryLimits,
  runtimeNativeSkillSchema,
  runtimeNativeToolSchema
} from '../../shared/runtime-customization-contracts'
import { RequestError } from '@agentclientprotocol/sdk'
import type {
  AgentExecutionRequest,
  AgentRuntime,
  RuntimeAuthorizer,
  RuntimeEvent
} from './runtime'
import type { ModelToolProviderLike } from './model-tool-provider'
import type { RuntimeSkillPackage } from '../capabilities/capability-service'
import type { ControlledHarnessExtensionPackage } from './deepseek-harness-extension-loader'
import {
  assertObjectJsonSchema,
  validateJsonSchemaValue
} from '@deepseek-ai/dsh-tools'
import {
  GOODBUDDY_CONTROL_PROTOCOL_VERSION,
  GOODBUDDY_CREDENTIAL,
  GOODBUDDY_EVENT,
  GOODBUDDY_HANDSHAKE,
  GOODBUDDY_NATIVE_SNAPSHOT,
  GOODBUDDY_PREPARE,
  GOODBUDDY_RELEASE,
  GOODBUDDY_SHUTDOWN,
  GOODBUDDY_TOOLS_CALL,
  GOODBUDDY_TOOLS_LIST
} from './deepseek-harness-protocol'
import { deepSeekHarnessStartupBudget } from './deepseek-harness-control-protocol'
import { promptWithUntrustedConversationHistory } from './runtime-conversation-history'

const ACP_PACKAGE_NAME = '@agentclientprotocol/sdk'
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 10_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024
const DEFAULT_MAX_EVENT_CHARACTERS = 64 * 1024
const DEFAULT_MAX_REQUEST_OUTPUT_CHARACTERS = 4 * 1024 * 1024
const MAX_QUEUED_UPDATES = 1_000
const MAX_APPROVAL_DETAIL_CHARACTERS = 4_000
const MAX_MCP_PROXY_TOOLS = 100
const MAX_MCP_TOOL_DESCRIPTION_CHARACTERS = 1_000
const MAX_NATIVE_TOOLS = runtimeNativeInventoryLimits.tools
const MAX_MCP_TOOL_SCHEMA_BYTES = 32 * 1024
const MAIN_WEB_TOOL_NAMES = new Set(['web_search', 'web_fetch'])
const DSH_BUILTIN_TOOL_KINDS: Readonly<
  Partial<Record<string, RuntimeNativeTool['kind']>>
> = {
  bash: 'shell',
  edit: 'write',
  pwsh: 'shell',
  read: 'read',
  read_image: 'read',
  write: 'write'
}
const DSH_SCHEMA_SCALAR_KEYS = new Set([
  'type',
  'required',
  'additionalProperties',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples'
])

type AcpPermissionRequest = {
  sessionId: string
  toolCall: {
    toolCallId: string
    title?: string | null
    name?: string | null
    kind?: string | null
    rawInput?: unknown
  }
  options: Array<{
    optionId: string
    name: string
    kind:
      | 'allow_once'
      | 'allow_always'
      | 'reject_once'
      | 'reject_always'
  }>
}

type AcpSessionNotification = {
  sessionId: string
  update: {
    sessionUpdate: string
    content?: { type: string; text?: string }
    toolCallId?: string
    title?: string | null
    name?: string | null
    status?: string | null
    rawInput?: unknown
    rawOutput?: unknown
    goodBuddyEvent?: Record<string, unknown>
  }
}

type AcpAgent = {
  initialize(params: unknown): Promise<unknown>
  newSession(params: unknown): Promise<{ sessionId: string }>
  prompt(params: unknown): Promise<{ stopReason?: string }>
  cancel(params: { sessionId: string }): Promise<void>
  extMethod(
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>>
  extNotification(
    method: string,
    params: Record<string, unknown>
  ): Promise<void>
}

type AcpConnection = {
  readonly signal: AbortSignal
  readonly closed: Promise<void>
}

export type DeepSeekHarnessAcpSdk = {
  PROTOCOL_VERSION: number
  ClientSideConnection: new (
    toClient: (agent: AcpAgent) => {
      requestPermission(
        params: AcpPermissionRequest
      ): Promise<unknown>
      sessionUpdate(params: AcpSessionNotification): Promise<void>
      extMethod(
        method: string,
        params: Record<string, unknown>
      ): Promise<Record<string, unknown>>
      extNotification(
        method: string,
        params: Record<string, unknown>
      ): Promise<void>
    },
    stream: unknown
  ) => AcpConnection & AcpAgent
  ndJsonStream(
    output: WritableStream<Uint8Array>,
    input: ReadableStream<Uint8Array>
  ): unknown
}

/**
 * Process-neutral child contract. The main process may adapt either a Node
 * ChildProcess or an Electron UtilityProcess to these WHATWG byte streams.
 */
export type DeepSeekHarnessChild = {
  readonly stdin: WritableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr?: ReadableStream<Uint8Array>
  readonly exited: Promise<{
    exitCode: number | null
    signal?: string | null
  }>
  terminate(): void | Promise<void>
}

export type DeepSeekHarnessLaunchOptions = {
  cwd: string
  signal: AbortSignal
  baseUrl: string
  model: string
  supportsImageInput: boolean
  credentialRefs: readonly string[]
  skillPackages: readonly RuntimeSkillPackage[]
  extensionPackages: readonly ControlledHarnessExtensionPackage[]
}

export type DeepSeekHarnessRuntimeOptions = {
  defaultWorkspace: string
  baseUrl: string
  model: string
  supportsImageInput?: boolean
  launch: (
    options: DeepSeekHarnessLaunchOptions
  ) => Promise<DeepSeekHarnessChild>
  /**
   * Explicit hard timeout for each initialization operation, including the
   * complete launcher call. When omitted, launcher startup is expanded from
   * the enabled extension count while later ACP operations retain 10 seconds.
   */
  initializationTimeoutMs?: number
  promptTimeoutMs?: number
  shutdownTimeoutMs?: number
  maxStderrBytes?: number
  maxEventCharacters?: number
  maxRequestOutputCharacters?: number
  credentialRefs?: Readonly<Record<string, string>>
  skillPackages?: RuntimeSkillPackage[]
  extensionPackages?: ControlledHarnessExtensionPackage[]
  toolProvider?: ModelToolProviderLike
  loadAcpSdk?: () => Promise<DeepSeekHarnessAcpSdk>
}

type ActiveRun = {
  request: AgentExecutionRequest
  toolController: AbortController
  authorize?: RuntimeAuthorizer
  updates: AcpSessionNotification['update'][]
  toolNames: Map<string, string>
  wake?: () => void
  closed: boolean
  outputCharacters: number
}

type HarnessState = {
  child: DeepSeekHarnessChild
  connection: AcpConnection
  agent: AcpAgent
  capabilities: GoodBuddyHarnessCapabilities
}

type GoodBuddyHarnessCapabilities = {
  controlProtocolVersion: number
  harnessVersion: string
  acpProtocolVersion: number
  supports: {
    cancellation: boolean
    sessionRelease: boolean
    reasoningEvents: boolean
    toolEvents: boolean
    usageEvents: boolean
    credentialResolution: boolean
  }
  execution: {
    mode: 'host'
  }
}

function safeStringify(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }
  try {
    const text =
      typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    return text.slice(0, MAX_APPROVAL_DETAIL_CHARACTERS)
  } catch {
    return '[无法序列化]'
  }
}

export function harnessPromptError(error: unknown): unknown {
  if (!(error instanceof RequestError) || error.code !== -32603) {
    return error
  }
  const rawDetails =
    error.data &&
    typeof error.data === 'object' &&
    !Array.isArray(error.data) &&
    typeof (error.data as Record<string, unknown>).details ===
      'string'
      ? (error.data as Record<string, unknown>).details
      : undefined
  const details =
    typeof rawDetails === 'string' ? rawDetails : undefined
  return details
    ? new Error(details.slice(0, MAX_APPROVAL_DETAIL_CHARACTERS))
    : error
}

function isMainWebTool(
  tool: Awaited<
    ReturnType<ModelToolProviderLike['listTools']>
  >[number]
): boolean {
  return (
    tool.source === 'builtin' &&
    MAIN_WEB_TOOL_NAMES.has(tool.name)
  )
}

function dshCompatibleWebInputSchema(
  schema: Record<string, unknown>
): Record<string, unknown> {
  const compatible: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (DSH_SCHEMA_SCALAR_KEYS.has(key)) {
      compatible[key] = value
      continue
    }
    if (
      key === 'properties' &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      compatible.properties = Object.fromEntries(
        Object.entries(value).map(([name, propertySchema]) => [
          name,
          propertySchema &&
          typeof propertySchema === 'object' &&
          !Array.isArray(propertySchema)
            ? dshCompatibleWebInputSchema(
                propertySchema as Record<string, unknown>
              )
            : propertySchema
        ])
      )
      continue
    }
    if (
      key === 'items' &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      compatible.items = dshCompatibleWebInputSchema(
        value as Record<string, unknown>
      )
      continue
    }
    if (key === 'oneOf' && Array.isArray(value)) {
      compatible.oneOf = value.map((candidate) =>
        candidate &&
        typeof candidate === 'object' &&
        !Array.isArray(candidate)
          ? dshCompatibleWebInputSchema(
              candidate as Record<string, unknown>
            )
          : candidate
      )
    }
  }
  return compatible
}

function proxyToolInputSchema(
  tool: Awaited<
    ReturnType<ModelToolProviderLike['listTools']>
  >[number]
): Record<string, unknown> {
  return isMainWebTool(tool)
    ? dshCompatibleWebInputSchema(tool.inputSchema)
    : tool.inputSchema
}

function boundedProxyToolCatalog(
  tools: Awaited<
    ReturnType<ModelToolProviderLike['listTools']>
  >,
  workMode: 'ask' | 'execute'
): Array<{
  name: string
  description: string
  inputSchema: Record<string, unknown>
}> {
  const catalog = tools.filter(
    (tool) =>
      isMainWebTool(tool) ||
      (workMode === 'execute' && tool.source === 'mcp')
  )
  if (catalog.length > MAX_MCP_PROXY_TOOLS) {
    throw new Error(
      'DeepSeek Harness MCP 工具数量超过安全限制'
    )
  }
  const names = new Set<string>()
  return catalog.map((tool) => {
    if (
      !/^[a-zA-Z0-9_-]{1,64}$/u.test(tool.name) ||
      names.has(tool.name)
    ) {
      throw new Error('DeepSeek Harness MCP 工具名称无效或冲突')
    }
    names.add(tool.name)
    const description = tool.description.slice(
      0,
      MAX_MCP_TOOL_DESCRIPTION_CHARACTERS
    )
    const inputSchema = proxyToolInputSchema(tool)
    let serialized: string
    try {
      serialized = JSON.stringify(inputSchema)
    } catch (error) {
      throw new Error('DeepSeek Harness MCP 工具结构无效', {
        cause: error
      })
    }
    if (
      !serialized ||
      Buffer.byteLength(serialized, 'utf8') >
        MAX_MCP_TOOL_SCHEMA_BYTES
    ) {
      throw new Error(
        'DeepSeek Harness MCP 工具结构超过安全限制'
      )
    }
    return {
      name: tool.name,
      description,
      inputSchema
    }
  })
}

function timeoutError(label: string): Error {
  return new Error(`DeepSeek Harness ${label}超时`)
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError(label)), timeoutMs)
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

async function defaultLoadAcpSdk(): Promise<DeepSeekHarnessAcpSdk> {
  // Keep the process launcher injectable while still using the official ACP
  // implementation by default. The non-literal import also lets this isolated
  // runtime land before the dependency wiring change.
  return (await import(
    ACP_PACKAGE_NAME
  )) as unknown as DeepSeekHarnessAcpSdk
}

export class DeepSeekHarnessRuntime implements AgentRuntime {
  readonly runtimeId = 'deepseek-harness'
  readonly requiresToolApproval = false
  readonly supportsToolExecution = true
  readonly supportsScopedDataTools = false
  private state?: HarnessState
  private initialization?: Promise<HarnessState>
  private launchController?: AbortController
  private disposed = false
  private fatalError?: Error
  private stderrBytes = 0
  private readonly sessions = new Map<string, string>()
  private readonly sessionInitializations = new Map<
    string,
    Promise<string>
  >()
  private readonly activeRuns = new Map<string, ActiveRun>()
  private readonly conversationTails = new Map<string, Promise<void>>()

  constructor(private readonly options: DeepSeekHarnessRuntimeOptions) {}

  private get initializationTimeoutMs(): number {
    return (
      this.options.initializationTimeoutMs ??
      DEFAULT_INITIALIZATION_TIMEOUT_MS
    )
  }

  private get launchTimeoutMs(): number {
    return (
      this.options.initializationTimeoutMs ??
      deepSeekHarnessStartupBudget(
        this.options.extensionPackages?.length ?? 0
      ).mainTimeoutMs
    )
  }

  private get promptTimeoutMs(): number | undefined {
    return this.options.promptTimeoutMs
  }

  private get shutdownTimeoutMs(): number {
    return (
      this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
    )
  }

  private get maxStderrBytes(): number {
    return this.options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES
  }

  private get maxEventCharacters(): number {
    return (
      this.options.maxEventCharacters ??
      DEFAULT_MAX_EVENT_CHARACTERS
    )
  }

  private get maxRequestOutputCharacters(): number {
    return (
      this.options.maxRequestOutputCharacters ??
      DEFAULT_MAX_REQUEST_OUTPUT_CHARACTERS
    )
  }

  private async terminate(
    child: DeepSeekHarnessChild
  ): Promise<void> {
    try {
      await child.terminate()
    } catch {
      // Termination is best-effort; the bounded exit wait still prevents hangs.
    }
  }

  private fail(error: Error): void {
    if (this.fatalError) {
      return
    }
    this.fatalError = error
    for (const run of this.activeRuns.values()) {
      run.closed = true
      run.wake?.()
      run.wake = undefined
    }
  }

  private async consumeStderr(
    child: DeepSeekHarnessChild
  ): Promise<void> {
    if (!child.stderr) {
      return
    }
    const reader = child.stderr.getReader()
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) {
          return
        }
        this.stderrBytes += result.value.byteLength
        if (this.stderrBytes > this.maxStderrBytes) {
          this.fail(
            new Error(
              `DeepSeek Harness stderr 超过 ${this.maxStderrBytes} 字节安全限制`
            )
          )
          await this.terminate(child)
          return
        }
      }
    } catch {
      this.fail(new Error('DeepSeek Harness stderr 管道读取失败'))
    } finally {
      reader.releaseLock()
    }
  }

  private handleExit(result: {
    exitCode: number | null
    signal?: string | null
  }): void {
    if (this.disposed) {
      return
    }
    const suffix = result.signal
      ? `signal ${result.signal}`
      : `code ${result.exitCode ?? 'unknown'}`
    this.fail(new Error(`DeepSeek Harness 进程意外退出（${suffix}）`))
  }

  private onSessionUpdate(
    notification: AcpSessionNotification
  ): void {
    const run = this.activeRuns.get(notification.sessionId)
    if (!run || run.closed) {
      return
    }
    if (run.updates.length >= MAX_QUEUED_UPDATES) {
      this.fail(
        new Error('DeepSeek Harness ACP 更新积压超过安全限制')
      )
      return
    }
    run.updates.push(notification.update)
    run.wake?.()
    run.wake = undefined
  }

  private onBridgeEvent(params: Record<string, unknown>): void {
    const sessionId = params.sessionId
    const requestId = params.requestId
    if (
      typeof sessionId !== 'string' ||
      typeof requestId !== 'string'
    ) {
      this.fail(new Error('DeepSeek Harness 扩展事件关联无效'))
      return
    }
    const run = this.activeRuns.get(sessionId)
    if (
      !run ||
      run.closed ||
      run.request.requestId !== requestId
    ) {
      return
    }
    const eventLength = JSON.stringify(params).length
    if (eventLength > this.maxEventCharacters) {
      this.fail(
        new Error('DeepSeek Harness 扩展事件超过安全限制')
      )
      return
    }
    run.outputCharacters += eventLength
    if (
      run.outputCharacters > this.maxRequestOutputCharacters
    ) {
      this.fail(
        new Error('DeepSeek Harness 请求累计输出超过安全限制')
      )
      return
    }
    const event = this.bridgeEventToUpdate(params) ?? {
      sessionUpdate: 'goodbuddy_event',
      goodBuddyEvent: params
    }
    this.onSessionUpdate({ sessionId, update: event })
  }

  private bridgeEventToUpdate(
    params: Record<string, unknown>
  ): AcpSessionNotification['update'] | undefined {
    if (params.type === 'text' || params.type === 'reasoning') {
      if (typeof params.delta !== 'string') {
        return undefined
      }
      return {
        sessionUpdate:
          params.type === 'text'
            ? 'agent_message_chunk'
            : 'agent_thought_chunk',
        content: { type: 'text', text: params.delta }
      }
    }
    if (params.type === 'tool') {
      if (
        typeof params.callId !== 'string' ||
        typeof params.name !== 'string'
      ) {
        return undefined
      }
      const status =
        params.state === 'running'
          ? 'in_progress'
          : params.state === 'completed'
            ? 'completed'
            : params.state === 'failed'
              ? 'failed'
              : 'pending'
      return {
        sessionUpdate:
          status === 'pending' ? 'tool_call' : 'tool_call_update',
        toolCallId: params.callId,
        name: params.name,
        status,
        rawInput: params.input,
        rawOutput: params.output
      }
    }
    return undefined
  }

  private toUsageEvent(
    requestId: string,
    params: Record<string, unknown>
  ): RuntimeEvent | undefined {
    if (
      params.type !== 'model-usage' ||
      typeof params.callId !== 'string' ||
      typeof params.provider !== 'string' ||
      typeof params.model !== 'string'
    ) {
      return undefined
    }
    const counts = [
      params.inputTokens,
      params.outputTokens,
      params.cacheReadTokens,
      params.cacheWriteTokens
    ]
    if (
      counts.some(
        (value) =>
          typeof value !== 'number' ||
          !Number.isSafeInteger(value) ||
          value < 0
      )
    ) {
      return undefined
    }
    return {
      requestId,
      type: 'model-usage',
      callId: params.callId,
      runtime: 'deepseek-harness',
      provider: params.provider,
      model: params.model,
      inputTokens: params.inputTokens as number,
      outputTokens: params.outputTokens as number,
      cacheReadTokens: params.cacheReadTokens as number,
      cacheWriteTokens: params.cacheWriteTokens as number
    }
  }

  private parseCapabilities(
    value: Record<string, unknown>,
    protocolVersion: number
  ): GoodBuddyHarnessCapabilities {
    const capabilities =
      value as unknown as GoodBuddyHarnessCapabilities
    const supports = capabilities.supports
    if (
      capabilities.controlProtocolVersion !==
        GOODBUDDY_CONTROL_PROTOCOL_VERSION ||
      capabilities.acpProtocolVersion !== protocolVersion ||
      typeof capabilities.harnessVersion !== 'string' ||
      !supports?.cancellation ||
      !supports.sessionRelease ||
      !supports.credentialResolution ||
      capabilities.execution?.mode !== 'host'
    ) {
      throw new Error(
        'DeepSeek Harness 内部控制面必需能力握手失败'
      )
    }
    return capabilities
  }

  private async handlePermission(
    permission: AcpPermissionRequest
  ): Promise<{
    outcome:
      | { outcome: 'selected'; optionId: string }
      | { outcome: 'cancelled' }
  }> {
    const run = this.activeRuns.get(permission.sessionId)
    const reject = permission.options.find(
      (option) =>
        option.kind === 'reject_once' ||
        option.kind === 'reject_always'
    )
    const allowOnce = permission.options.find(
      (option) => option.kind === 'allow_once'
    )
    if (
      !run ||
      run.closed ||
      run.request.workMode !== 'execute' ||
      !run.authorize
    ) {
      return reject
        ? {
            outcome: {
              outcome: 'selected',
              optionId: reject.optionId
            }
          }
        : { outcome: { outcome: 'cancelled' } }
    }

    const argumentSummary = safeStringify(
      permission.toolCall.rawInput
    )
    const decision: Awaited<ReturnType<RuntimeAuthorizer>> =
      await run
        .authorize({
          scopeKey: `deepseek-harness:${permission.toolCall.name ?? permission.toolCall.kind ?? 'tool'}`,
          title:
            (permission.toolCall.title ??
              permission.toolCall.name ??
              'DeepSeek Harness 工具请求').slice(0, 200),
          description: 'DeepSeek Harness 请求一次性执行此工具',
          ...(permission.toolCall.name
            ? { toolName: permission.toolCall.name.slice(0, 200) }
            : {}),
          ...(argumentSummary ? { argumentSummary } : {}),
          allowPermanent: false
        })
        .catch(() => 'deny')
    if (decision !== 'deny' && allowOnce) {
      return {
        outcome: {
          outcome: 'selected',
          optionId: allowOnce.optionId
        }
      }
    }
    return reject
      ? {
          outcome: {
            outcome: 'selected',
            optionId: reject.optionId
          }
        }
      : { outcome: { outcome: 'cancelled' } }
  }

  private async initialize(): Promise<HarnessState> {
    if (this.disposed) {
      throw new Error('DeepSeek Harness Runtime 已关闭')
    }
    const launchController = new AbortController()
    this.launchController = launchController
    let child: DeepSeekHarnessChild | undefined
    try {
      child = await withTimeout(
        this.options.launch({
          cwd: this.options.defaultWorkspace,
          signal: launchController.signal,
          baseUrl: this.options.baseUrl,
          model: this.options.model,
          supportsImageInput:
            this.options.supportsImageInput === true,
          credentialRefs: Object.keys(
            this.options.credentialRefs ?? {}
          ),
          skillPackages: this.options.skillPackages ?? [],
          extensionPackages: this.options.extensionPackages ?? []
        }),
        this.launchTimeoutMs,
        '启动'
      )
      if (this.disposed) {
        throw new Error('DeepSeek Harness Runtime 已关闭')
      }
      const sdk = await (this.options.loadAcpSdk ?? defaultLoadAcpSdk)()
      let agent: AcpAgent | undefined
      const connection = new sdk.ClientSideConnection(
        (connectedAgent) => {
          agent = connectedAgent
          return {
            requestPermission: (params) =>
              this.handlePermission(params),
            sessionUpdate: async (params) => {
              this.onSessionUpdate(params)
            },
            extMethod: async (method, params) => {
              if (method === GOODBUDDY_CREDENTIAL) {
                const ref = params.ref
                if (typeof ref !== 'string') {
                  return {}
                }
                const value = this.options.credentialRefs?.[ref]
                return value ? { value } : {}
              }
              if (method === GOODBUDDY_TOOLS_LIST) {
                if (typeof params.sessionId !== 'string') {
                  throw new Error(
                    'DeepSeek Harness MCP 工具上下文不可用'
                  )
                }
                if (!this.options.toolProvider) {
                  return { tools: [] }
                }
                const run = this.activeRuns.get(params.sessionId)
                const context = {
                  conversationId:
                    run?.request.conversationId ??
                    'deepseek-harness-tool-catalog',
                  workMode:
                    run?.request.workMode === 'ask'
                      ? ('ask' as const)
                      : ('execute' as const),
                  knowledgeCapabilityToken:
                    run?.request.knowledgeCapabilityToken
                }
                const tools = await this.options.toolProvider.listTools(
                  context,
                  connection.signal
                )
                return {
                  tools: boundedProxyToolCatalog(
                    tools,
                    context.workMode
                  )
                }
              }
              if (method === GOODBUDDY_TOOLS_CALL) {
                const sessionId = params.sessionId
                const name = params.name
                const argumentsValue = params.arguments
                const run =
                  typeof sessionId === 'string'
                    ? this.activeRuns.get(sessionId)
                    : undefined
                if (
                  !run ||
                  run.closed ||
                  !this.options.toolProvider ||
                  typeof name !== 'string' ||
                  !argumentsValue ||
                  typeof argumentsValue !== 'object' ||
                  Array.isArray(argumentsValue)
                ) {
                  throw new Error(
                    'DeepSeek Harness MCP 工具调用无效'
                  )
                }
                const context = {
                  conversationId: run.request.conversationId,
                  workMode:
                    run.request.workMode === 'execute'
                      ? ('execute' as const)
                      : ('ask' as const),
                  knowledgeCapabilityToken:
                    run.request.knowledgeCapabilityToken
                }
                const tools = await this.options.toolProvider.listTools(
                  context,
                  run.toolController.signal
                )
                const tool = tools.find(
                  (candidate) =>
                    candidate.name === name &&
                    (candidate.source === 'mcp' ||
                      isMainWebTool(candidate))
                )
                if (!tool) {
                  throw new Error(
                    'DeepSeek Harness 请求了未知 Main 代理工具'
                  )
                }
                const isWebTool = isMainWebTool(tool)
                if (
                  !isWebTool &&
                  (context.workMode !== 'execute' || !run.authorize)
                ) {
                  throw new Error(
                    'DeepSeek Harness MCP 工具需要 Execute 模式授权'
                  )
                }
                const argumentSummary =
                  safeStringify(argumentsValue) ?? '{}'
                const inputSchema = proxyToolInputSchema(tool)
                try {
                  assertObjectJsonSchema(inputSchema)
                } catch (error) {
                  throw new Error(
                    'DeepSeek Harness MCP 工具参数结构不受支持',
                    { cause: error }
                  )
                }
                const violations = validateJsonSchemaValue(
                  inputSchema,
                  argumentsValue
                )
                if (violations.length > 0) {
                  throw new Error(
                    `DeepSeek Harness MCP 工具参数无效：${violations
                      .slice(0, 5)
                      .join('; ')
                      .slice(0, 1_000)}`
                  )
                }
                if (!isWebTool) {
                  const approval =
                    this.options.toolProvider.getApproval(
                      tool,
                      argumentsValue as Record<string, unknown>,
                      argumentSummary,
                      context
                    )
                  const decision = await run
                    .authorize!(approval)
                    .catch(() => 'deny')
                  if (decision === 'deny') {
                    throw new Error(
                      'DeepSeek Harness MCP 工具调用未获执行授权'
                    )
                  }
                }
                const result = await this.options.toolProvider.callTool(
                  name,
                  argumentsValue as Record<string, unknown>,
                  run.toolController.signal,
                  context
                )
                return {
                  content: result.parts.map((part) =>
                    part.type === 'text'
                      ? { type: 'text', text: part.text }
                      : {
                          type: 'text',
                          text: `[${part.mimeType} image result omitted]`
                        }
                  )
                }
              }
              throw new Error(
                `不支持的 DeepSeek Harness 扩展请求：${method}`
              )
            },
            extNotification: async (method, params) => {
              if (method === GOODBUDDY_EVENT) {
                this.onBridgeEvent(params)
              }
            }
          }
        },
        sdk.ndJsonStream(child.stdin, child.stdout)
      )
      if (!agent) {
        throw new Error('DeepSeek Harness ACP 客户端初始化失败')
      }
      const stateWithoutCapabilities = {
        child,
        connection,
        agent
      }
      void this.consumeStderr(child)
      void child.exited.then(
        (result) => this.handleExit(result),
        () =>
          this.fail(
            new Error('DeepSeek Harness 无法获取进程退出状态')
          )
      )
      void connection.closed.then(
        () => {
          if (!this.disposed) {
            this.fail(new Error('DeepSeek Harness ACP 连接已关闭'))
          }
        },
        () =>
          this.fail(new Error('DeepSeek Harness ACP 连接异常关闭'))
      )
      const initialization = await withTimeout(
        stateWithoutCapabilities.agent.initialize({
          protocolVersion: sdk.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: {
            name: 'GoodBuddy',
            version: '1'
          }
        }),
        this.initializationTimeoutMs,
        'ACP 初始化'
      )
      const advertisedImageInput =
        Boolean(
          initialization &&
            typeof initialization === 'object' &&
            (
              initialization as {
                agentCapabilities?: {
                  promptCapabilities?: { image?: unknown }
                }
              }
            ).agentCapabilities?.promptCapabilities?.image === true
        )
      if (
        advertisedImageInput !==
        (this.options.supportsImageInput === true)
      ) {
        throw new Error(
          'DeepSeek Harness Host 图片能力与所选模型连接不一致'
        )
      }
      const capabilities = this.parseCapabilities(
        await withTimeout(
          stateWithoutCapabilities.agent.extMethod(
            GOODBUDDY_HANDSHAKE,
            {
              controlProtocolVersion:
                GOODBUDDY_CONTROL_PROTOCOL_VERSION
            }
          ),
          this.initializationTimeoutMs,
          '内部控制面握手'
        ),
        sdk.PROTOCOL_VERSION
      )
      const state = {
        ...stateWithoutCapabilities,
        capabilities
      }
      if (this.disposed) {
        throw new Error('DeepSeek Harness Runtime 已关闭')
      }
      this.state = state
      return state
    } catch (error) {
      launchController.abort(error)
      if (child) {
        await this.terminate(child)
      }
      throw error
    } finally {
      if (this.launchController === launchController) {
        this.launchController = undefined
      }
    }
  }

  private async getState(): Promise<HarnessState> {
    if (this.fatalError) {
      throw this.fatalError
    }
    if (this.state) {
      return this.state
    }
    this.initialization ??= this.initialize()
    try {
      return await this.initialization
    } catch (error) {
      this.initialization = undefined
      throw error
    }
  }

  async getStatus(): Promise<AgentRuntimeStatus> {
    try {
      await this.getState()
      return {
        id: 'deepseek-harness',
        label: 'DeepSeek Harness',
        available: true,
        supportsToolExecution: true,
        detail: `DeepSeek Harness ${this.state?.capabilities.harnessVersion ?? ''} · 当前用户权限`
      }
    } catch (error) {
      return {
        id: 'deepseek-harness',
        label: 'DeepSeek Harness',
        available: false,
        supportsToolExecution: true,
        detail:
          error instanceof Error
            ? error.message
            : 'DeepSeek Harness 不可用'
      }
    }
  }

  async getNativeSnapshot(): Promise<RuntimeNativeSnapshot> {
    const state = await this.getState()
    const response = await withTimeout(
      state.agent.extMethod(GOODBUDDY_NATIVE_SNAPSHOT, {}),
      this.initializationTimeoutMs,
      '原生能力清单'
    )
    const assignedSkillIds = new Set(
      (this.options.skillPackages ?? []).map((skill) => skill.id)
    )
    const rawSkills = Array.isArray(response.skills)
      ? response.skills
      : []
    const skills = rawSkills
      .filter(
        (
          candidate
        ): candidate is Record<string, unknown> => {
          if (
            !candidate ||
            typeof candidate !== 'object' ||
            Array.isArray(candidate)
          ) {
            return false
          }
          const skill = candidate as Record<string, unknown>
          return (
            typeof skill.id === 'string' &&
            typeof skill.name === 'string' &&
            !assignedSkillIds.has(skill.id.trim())
          )
        }
      )
      .flatMap((skill) => {
        const source =
          typeof skill.source === 'string'
            ? skill.source
            : ''
        const mappedSource =
          source === 'project-dsh' ||
          source === 'project-agents'
            ? ('workspace' as const)
            : source === 'user-dsh' ||
                source === 'user-agents'
              ? ('global' as const)
              : source === 'runtime'
                ? ('runtime' as const)
                : source === 'custom'
                  ? ('plugin' as const)
                  : ('unknown' as const)
        const description =
          typeof skill.description === 'string'
            ? skill.description.trim()
            : ''
        const parsed = runtimeNativeSkillSchema.safeParse({
          id: skill.id,
          name: skill.name,
          ...(description
            ? {
                description
              }
            : {}),
          source: mappedSource
        })
        return parsed.success ? [parsed.data] : []
      })
      .slice(0, runtimeNativeInventoryLimits.skills)
    const rawTools = Array.isArray(response.tools)
      ? response.tools
      : []
    const toolsSupported =
      response.toolsSupported === true &&
      Array.isArray(response.tools)
    const tools = rawTools
      .flatMap((candidate) => {
        if (
          !candidate ||
          typeof candidate !== 'object' ||
          Array.isArray(candidate)
        ) {
          return []
        }
        const tool = candidate as Record<string, unknown>
        if (
          typeof tool.id !== 'string' ||
          typeof tool.name !== 'string'
        ) {
          return []
        }
        const id = tool.id.trim()
        const builtinKind = DSH_BUILTIN_TOOL_KINDS[id]
        const description =
          typeof tool.description === 'string'
            ? tool.description.trim()
            : ''
        const parsed = runtimeNativeToolSchema.safeParse({
          id,
          name: tool.name,
          ...(description ? { description } : {}),
          kind: builtinKind ?? 'other',
          source:
            id === 'skill'
              ? 'skill'
              : builtinKind
                ? 'runtime'
                : 'plugin',
          ask:
            id === 'read'
              ? 'allowed'
              : id === 'skill'
                ? 'conditional'
                : 'blocked',
          execute: 'allowed'
        })
        return parsed.success ? [parsed.data] : []
      })
      .slice(0, MAX_NATIVE_TOOLS)
    return {
      provider: 'deepseek-harness',
      available: true,
      inventoryStatus: toolsSupported ? 'available' : 'partial',
      detail:
        toolsSupported
          ? '显示 DeepSeek Harness Host 与插件原生能力；GoodBuddy 分配的 Skill 和 MCP 不在此清单中。'
          : 'DeepSeek Harness 已连接，但工具清单暂不可用；GoodBuddy 分配的 Skill 和 MCP 不在原生清单中。',
      agents: [],
      tools,
      toolsSupported,
      commands: [],
      lsp: [],
      formatters: [],
      mcpServers: [],
      skills,
      rules: [],
      prompts: [],
      resources: [],
      resourcesSupported: false,
      context: {
        strategy: 'unsupported',
        manualCompact: false,
        detail: 'DeepSeek Harness 暂不支持原生上下文压缩。'
      }
    }
  }

  private async acquireConversation(
    conversationId: string,
    signal: AbortSignal
  ): Promise<() => void> {
    signal.throwIfAborted()
    const previous =
      this.conversationTails.get(conversationId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(
      () => gate,
      () => gate
    )
    this.conversationTails.set(conversationId, tail)
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      previous.finally(() =>
        signal.removeEventListener('abort', onAbort)
      )
    })
    try {
      await Promise.race([previous, aborted])
      signal.throwIfAborted()
      return () => {
        release()
        if (this.conversationTails.get(conversationId) === tail) {
          this.conversationTails.delete(conversationId)
        }
      }
    } catch (error) {
      release()
      if (this.conversationTails.get(conversationId) === tail) {
        this.conversationTails.delete(conversationId)
      }
      throw error
    }
  }

  private async getSession(
    state: HarnessState,
    conversationId: string
  ): Promise<string> {
    const current = this.sessions.get(conversationId)
    if (current) {
      return current
    }
    const pending = this.sessionInitializations.get(conversationId)
    if (pending) {
      return pending
    }
    const creation = state.agent
      .newSession({
        cwd: this.options.defaultWorkspace,
        mcpServers: []
      })
      .then((response) => {
        if (!response.sessionId) {
          throw new Error('DeepSeek Harness 未返回 ACP 会话 ID')
        }
        this.sessions.set(conversationId, response.sessionId)
        return response.sessionId
      })
    this.sessionInitializations.set(conversationId, creation)
    try {
      return await creation
    } finally {
      this.sessionInitializations.delete(conversationId)
    }
  }

  private async waitForUpdate(run: ActiveRun): Promise<void> {
    if (run.updates.length > 0 || run.closed || this.fatalError) {
      return
    }
    await new Promise<void>((resolve) => {
      run.wake = resolve
    })
  }

  private toRuntimeEvent(
    requestId: string,
    update: AcpSessionNotification['update'],
    toolNames: Map<string, string>
  ): RuntimeEvent | undefined {
    if (update.goodBuddyEvent) {
      return this.toUsageEvent(
        requestId,
        update.goodBuddyEvent
      )
    }
    if (
      (update.sessionUpdate === 'agent_message_chunk' ||
        update.sessionUpdate === 'agent_thought_chunk') &&
      update.content?.type === 'text' &&
      update.content.text
    ) {
      return {
        requestId,
        type:
          update.sessionUpdate === 'agent_thought_chunk'
            ? 'reasoning'
            : 'text',
        delta: update.content.text
      }
    }
    if (
      (update.sessionUpdate === 'tool_call' ||
        update.sessionUpdate === 'tool_call_update') &&
      update.toolCallId
    ) {
      const state =
        update.status === 'in_progress'
          ? 'running'
          : update.status === 'completed'
            ? 'completed'
            : update.status === 'failed'
              ? 'failed'
              : 'pending'
      const reportedName = (
        update.name ??
        update.title ??
        'DeepSeek Harness 工具'
      ).slice(0, 200)
      const callId = update.toolCallId.slice(0, 256)
      const name =
        reportedName === 'tool'
          ? toolNames.get(callId) ?? reportedName
          : reportedName
      if (state === 'pending' || state === 'running') {
        toolNames.set(callId, name)
      } else {
        toolNames.delete(callId)
      }
      const input = safeStringify(update.rawInput)
      const output = safeStringify(update.rawOutput)
      return {
        requestId,
        type: 'tool',
        callId,
        name,
        state,
        summary: `DeepSeek Harness 工具：${name}`,
        ...(input ? { input } : {}),
        ...(output ? { output } : {})
      }
    }
    return undefined
  }

  async *run(
    request: AgentExecutionRequest,
    signal: AbortSignal,
    authorize?: RuntimeAuthorizer
  ): AsyncGenerator<RuntimeEvent, void, void> {
    signal.throwIfAborted()
    if (
      request.images?.length &&
      this.options.supportsImageInput !== true
    ) {
      throw new Error('当前 DeepSeek Harness 模型连接未启用图像输入')
    }
    const release = await this.acquireConversation(
      request.conversationId,
      signal
    )
    let state: HarnessState | undefined
    let sessionId: string | undefined
    let run: ActiveRun | undefined
    const toolController = new AbortController()
    const abortTools = (): void => {
      toolController.abort(signal.reason)
    }
    signal.addEventListener('abort', abortTools, { once: true })
    try {
      state = await this.getState()
      signal.throwIfAborted()
      sessionId = await this.getSession(
        state,
        request.conversationId
      )
      run = {
        request,
        toolController,
        authorize,
        updates: [],
        toolNames: new Map(),
        closed: false,
        outputCharacters: 0
      }
      this.activeRuns.set(sessionId, run)
      yield {
        requestId: request.requestId,
        type: 'status',
        message: 'DeepSeek Harness 正在处理请求'
      }

      let completed = false
      let response:
        | { stopReason?: string }
        | undefined
      let promptError: unknown
      const cancel = (): void => {
        run!.closed = true
        run!.wake?.()
        run!.wake = undefined
        void state!.agent
          .cancel({
            sessionId: sessionId!
          })
          .catch(() => undefined)
      }
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) {
        cancel()
      }
      try {
        await withTimeout(
          state.agent.extMethod(GOODBUDDY_PREPARE, {
            sessionId,
            requestId: request.requestId,
            mode:
              request.workMode === 'execute' ? 'execute' : 'ask'
          }),
          this.initializationTimeoutMs,
          '请求准备'
        )
        signal.throwIfAborted()
      } catch (error) {
        signal.removeEventListener('abort', cancel)
        throw error
      }
      const promptOperation = state.agent.prompt({
        sessionId,
        prompt: [
          {
            type: 'text',
            text: promptWithUntrustedConversationHistory(request, true)
          },
          ...(request.images ?? []).map((image) => ({
            type: 'image' as const,
            data: image.data,
            mimeType: image.mediaType
          }))
        ]
      })
      const prompt = (
        this.promptTimeoutMs === undefined
          ? promptOperation
          : withTimeout(
              promptOperation,
              this.promptTimeoutMs,
              '请求'
            )
      )
        .then((value) => {
          response = value
        })
        .catch((error: unknown) => {
          promptError = harnessPromptError(error)
        })
        .finally(() => {
          completed = true
          run!.wake?.()
          run!.wake = undefined
        })
      try {
        while (!completed || run.updates.length > 0) {
          signal.throwIfAborted()
          if (this.fatalError) {
            throw this.fatalError
          }
          if (run.closed && !completed) {
            throw new Error(
              'DeepSeek Harness 请求在完成前已关闭'
            )
          }
          if (run.updates.length === 0) {
            await this.waitForUpdate(run)
            continue
          }
          const update = run.updates.shift()!
          const event = this.toRuntimeEvent(
            request.requestId,
            update,
            run.toolNames
          )
          if (event) {
            yield event
          }
        }
        await prompt
        if (promptError) {
          cancel()
          throw promptError
        }
        if (response?.stopReason === 'cancelled') {
          throw signal.aborted
            ? signal.reason
            : new Error('DeepSeek Harness 请求已取消')
        }
        yield {
          requestId: request.requestId,
          type: 'done',
          sessionId
        }
      } finally {
        if (!completed) {
          cancel()
        }
        signal.removeEventListener('abort', cancel)
        if (completed) {
          await prompt
        } else {
          await withTimeout(
            prompt,
            this.shutdownTimeoutMs,
            '取消请求'
          ).catch(async () => {
            await this.terminate(state!.child)
          })
        }
      }
    } finally {
      signal.removeEventListener('abort', abortTools)
      toolController.abort(
        new Error('DeepSeek Harness 请求工具上下文已关闭')
      )
      if (run) {
        run.closed = true
        run.toolController.abort(
          new Error('DeepSeek Harness 请求工具上下文已关闭')
        )
      }
      if (sessionId && this.activeRuns.get(sessionId) === run) {
        this.activeRuns.delete(sessionId)
      }
      release()
    }
  }

  async releaseConversation(conversationId: string): Promise<void> {
    const sessionId = this.sessions.get(conversationId)
    this.sessions.delete(conversationId)
    if (!sessionId || !this.state) {
      await this.options.toolProvider
        ?.releaseConversation(conversationId)
        .catch(() => undefined)
      return
    }
    await this.state.agent
      .extMethod(GOODBUDDY_RELEASE, { sessionId })
      .catch(async () => {
        await this.state?.agent
          .cancel({ sessionId })
          .catch(() => undefined)
      })
    await this.options.toolProvider
      ?.releaseConversation(conversationId)
      .catch(() => undefined)
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.launchController?.abort(
      new Error('DeepSeek Harness Runtime 已关闭')
    )
    this.launchController = undefined
    const state = this.state
    this.state = undefined
    this.initialization = undefined
    for (const [sessionId, run] of this.activeRuns) {
      run.closed = true
      run.toolController.abort(
        new Error('DeepSeek Harness Runtime 已关闭')
      )
      run.wake?.()
      run.wake = undefined
      if (state) {
        void state.agent
          .cancel({
            sessionId
          })
          .catch(() => undefined)
      }
    }
    this.activeRuns.clear()
    this.sessions.clear()
    this.sessionInitializations.clear()
    this.conversationTails.clear()
    if (!state) {
      await this.options.toolProvider?.dispose().catch(() => undefined)
      return
    }
    await withTimeout(
      state.agent.extMethod(GOODBUDDY_SHUTDOWN, {}),
      this.shutdownTimeoutMs,
      '内部控制面关闭'
    ).catch(() => undefined)
    await this.options.toolProvider?.dispose().catch(() => undefined)
    await this.terminate(state.child)
    await withTimeout(
      Promise.allSettled([
        state.child.exited,
        state.connection.closed
      ]).then(() => undefined),
      this.shutdownTimeoutMs,
      '关闭'
    ).catch(() => undefined)
  }
}
