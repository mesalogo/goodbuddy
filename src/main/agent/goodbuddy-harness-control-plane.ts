import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type AgentSideConnection as AcpAgentConnection,
  type Stream
} from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import {
  CredentialProvider,
  type CredentialInfo,
  type CredentialRef,
  type ResolvedCredential
} from '@deepseek-ai/dsh-credentials'
import {
  createUserMessage,
  errorChain,
  type TokenUsage
} from '@deepseek-ai/dsh-llm'
import {
  SessionId,
  type SessionEvent
} from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'

export const GOODBUDDY_CONTROL_PROTOCOL_VERSION = 1
export const GOODBUDDY_HANDSHAKE = 'goodbuddy/handshake'
export const GOODBUDDY_PREPARE = 'goodbuddy/session/prepare'
export const GOODBUDDY_RELEASE = 'goodbuddy/session/release'
export const GOODBUDDY_EVENT = 'goodbuddy/session/event'
export const GOODBUDDY_CREDENTIAL = 'goodbuddy/credential/resolve'
export const GOODBUDDY_TOOLS_LIST = 'goodbuddy/tools/list'
export const GOODBUDDY_TOOLS_CALL = 'goodbuddy/tools/call'
export const GOODBUDDY_SHUTDOWN = 'goodbuddy/shutdown'

const DEFAULT_MAX_EVENT_CHARACTERS = 64 * 1024
const DEFAULT_MAX_REQUEST_CHARACTERS = 4 * 1024 * 1024
export const GOODBUDDY_HARNESS_MAX_STEP_TOKENS = 16 * 1024
const DELTA_BATCH_CHARACTERS = 4 * 1024
const DELTA_BATCH_INTERVAL_MS = 100
const MAX_SUMMARY_CHARACTERS = 4_000
const MAX_MCP_PROXY_RESULT_BYTES = 256 * 1024
const ASK_BLOCKED_TOOL_NAMES = new Set([
  'bash',
  'pwsh',
  'write',
  'edit'
])
const GOODBUDDY_EXECUTION_GUIDANCE = [
  'GoodBuddy controlled execution rules:',
  '- In Execute mode, act through the available tools instead of writing a long implementation plan.',
  '- Inspect only what is needed, then create or update the requested workspace files promptly.',
  '- Work in small verifiable steps and use tool results as the source of truth.',
  '- Keep reasoning concise. Do not narrate code that can be written and checked with tools.',
  '- In Ask mode, remain read-only and do not attempt mutations.'
].join('\n')

export type GoodBuddyWorkMode = 'ask' | 'execute'

export type GoodBuddyHarnessCapabilities = {
  controlProtocolVersion: 1
  harnessVersion: string
  acpProtocolVersion: number
  supports: {
    cancellation: true
    sessionRelease: true
    reasoningEvents: boolean
    toolEvents: boolean
    usageEvents: boolean
    credentialResolution: true
  }
  execution: {
    mode: 'host'
  }
}

export type GoodBuddyHarnessControlConfig = {
  provider: string
  model: string
  workspace: string
  harnessVersion: string
  execution: GoodBuddyHarnessCapabilities['execution']
  credentialRefs: readonly string[]
  skills: readonly {
    name: string
    description: string
    content: string
    directory: string
  }[]
  stream?: Stream
  maxEventCharacters?: number
  maxRequestCharacters?: number
}

type Preparation = {
  requestId: string
  mode: GoodBuddyWorkMode
}

type OwnedSession = {
  handle: AgentHandle
  preparation?: Preparation
  proxyToolDisposers: Map<string, () => void>
  inflight?: {
    requestId: string
    messageId: string
    mode: GoodBuddyWorkMode
    turn?: number
    endReason?: string
    turnError?: unknown
    resolve: (reason: string) => void
    reject: (error: unknown) => void
    emittedCharacters: number
    eventTail: Promise<void>
    eventError?: unknown
    pendingDelta?: {
      type: 'text' | 'reasoning'
      delta: string
    }
    pendingDeltaTimer?: ReturnType<typeof setTimeout>
  }
}

type ProxyToolDefinition = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

function validateProxyToolResult(
  value: unknown
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new Error('GoodBuddy MCP tool result is invalid')
  }
  const serialized = JSON.stringify(value)
  if (
    Buffer.byteLength(serialized, 'utf8') >
    MAX_MCP_PROXY_RESULT_BYTES
  ) {
    throw new Error(
      'GoodBuddy MCP tool result exceeds safety limit'
    )
  }
  const content = (value as Record<string, unknown>).content
  if (
    !Array.isArray(content) ||
    content.length > 100 ||
    content.some(
      (part) =>
        !part ||
        typeof part !== 'object' ||
        Array.isArray(part) ||
        (part as Record<string, unknown>).type !== 'text' ||
        typeof (part as Record<string, unknown>).text !== 'string'
    )
  ) {
    throw new Error('GoodBuddy MCP tool result is invalid')
  }
  return value as Record<string, unknown>
}

function parseProxyToolCatalog(
  value: unknown
): ProxyToolDefinition[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error('GoodBuddy MCP tool catalog is invalid')
  }
  const names = new Set<string>()
  return value.map((candidate) => {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    ) {
      throw new Error('GoodBuddy MCP tool definition is invalid')
    }
    const tool = candidate as Record<string, unknown>
    if (
      typeof tool.name !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,64}$/u.test(tool.name) ||
      names.has(tool.name) ||
      typeof tool.description !== 'string' ||
      tool.description.length > 1_000 ||
      !tool.inputSchema ||
      typeof tool.inputSchema !== 'object' ||
      Array.isArray(tool.inputSchema)
    ) {
      throw new Error('GoodBuddy MCP tool definition is invalid')
    }
    names.add(tool.name)
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>
    }
  })
}

type CredentialResolver = (
  ref: string
) => Promise<string | undefined>

/**
 * Memory-only credential provider. It deliberately has no writable operation
 * and can resolve only references registered by the trusted host.
 */
export class GoodBuddyCredentialProvider extends CredentialProvider {
  private resolver?: CredentialResolver

  constructor(
    ctx: Context,
    private readonly allowedRefs: ReadonlySet<string>
  ) {
    super(ctx)
  }

  bind(resolver: CredentialResolver): void {
    if (this.resolver) {
      throw new Error('GoodBuddy credential resolver is already bound')
    }
    this.resolver = resolver
  }

  async resolve(
    ref: CredentialRef
  ): Promise<ResolvedCredential | undefined> {
    if (!this.allowedRefs.has(ref) || !this.resolver) {
      return undefined
    }
    const value = await this.resolver(ref)
    return value ? { value, source: 'goodbuddy-main' } : undefined
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    const available =
      this.allowedRefs.has(ref) && this.resolver !== undefined
    return {
      configured: available,
      source: available ? 'goodbuddy-main' : undefined,
      writable: false
    }
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    void ref
    void value
    throw new Error('GoodBuddy Harness credentials are read-only')
  }

  async unset(ref: CredentialRef): Promise<void> {
    void ref
    throw new Error('GoodBuddy Harness credentials are read-only')
  }
}

export function createBoundedAcpStream(
  stream: Stream,
  maxFrameBytes: number
): Stream {
  if (
    !Number.isSafeInteger(maxFrameBytes) ||
    maxFrameBytes < 1
  ) {
    throw new TypeError('maxFrameBytes must be a positive integer')
  }
  return {
    readable: stream.readable.pipeThrough(
      new TransformStream({
        transform(message, controller) {
          if (
            Buffer.byteLength(JSON.stringify(message), 'utf8') >
            maxFrameBytes
          ) {
            throw new Error(
              `ACP input frame exceeds ${maxFrameBytes} bytes`
            )
          }
          controller.enqueue(message)
        }
      })
    ),
    writable: new WritableStream({
      async write(message) {
        if (
          Buffer.byteLength(JSON.stringify(message), 'utf8') >
          maxFrameBytes
        ) {
          throw new Error(
            `ACP output frame exceeds ${maxFrameBytes} bytes`
          )
        }
        const writer = stream.writable.getWriter()
        try {
          await writer.write(message)
        } finally {
          writer.releaseLock()
        }
      },
      async close() {
        const writer = stream.writable.getWriter()
        try {
          await writer.close()
        } finally {
          writer.releaseLock()
        }
      },
      async abort(reason) {
        await stream.writable.abort(reason)
      }
    })
  }
}

function requiredString(
  params: Record<string, unknown>,
  key: string,
  maxLength = 512
): string {
  const value = params[key]
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw RequestError.invalidParams(
      undefined,
      `${key} must be a non-empty bounded string`
    )
  }
  return value
}

function boundedJson(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }
  try {
    return (
      typeof value === 'string'
        ? value
        : JSON.stringify(value)
    ).slice(0, MAX_SUMMARY_CHARACTERS)
  } catch {
    return '[unserializable]'
  }
}

function promptText(
  prompt: readonly { type: string; text?: string }[]
): string {
  if (
    prompt.some(
      (block) =>
        block.type !== 'text' &&
        block.type !== 'resource_link'
    )
  ) {
    throw RequestError.invalidParams(
      undefined,
      'only text and resource_link prompt content is supported'
    )
  }
  return prompt
    .map((block) => (block.type === 'text' ? block.text ?? '' : ''))
    .join('')
}

function turnReason(event: SessionEvent): string | undefined {
  if (event.type !== 'turn/end') {
    return undefined
  }
  switch (event.data.reason.kind) {
    case 'aborted':
    case 'interrupted':
      return 'cancelled'
    case 'max-tokens':
      return 'max_tokens'
    default:
      return 'end_turn'
  }
}

export class GoodBuddyHarnessControlPlane {
  private readonly sessions = new Map<string, OwnedSession>()
  private readonly allowedCredentialRefs: ReadonlySet<string>
  private readonly maxEventCharacters: number
  private readonly maxRequestCharacters: number
  private connection?: AcpAgentConnection
  private credentialProvider?: GoodBuddyCredentialProvider
  private handshaken = false
  private observing = false
  private closed = false
  private disposing?: Promise<void>

  constructor(
    private readonly ctx: Context,
    private readonly config: GoodBuddyHarnessControlConfig
  ) {
    this.allowedCredentialRefs = new Set(config.credentialRefs)
    this.maxEventCharacters =
      config.maxEventCharacters ?? DEFAULT_MAX_EVENT_CHARACTERS
    this.maxRequestCharacters =
      config.maxRequestCharacters ??
      DEFAULT_MAX_REQUEST_CHARACTERS
  }

  bindCredentialProvider(
    provider: GoodBuddyCredentialProvider
  ): void {
    if (this.connection) {
      throw new Error(
        'Credential provider must be bound before bridge start'
      )
    }
    this.credentialProvider = provider
  }

  start(): AcpAgentConnection {
    if (this.connection) {
      throw new Error(
        'GoodBuddy Harness control plane is already started'
      )
    }
    if (!this.config.stream) {
      throw new Error(
        'GoodBuddy Harness control plane requires its internal Host transport'
      )
    }
    const connection = new AgentSideConnection(
      () => this.createAgentApi(),
      this.config.stream
    )
    this.connection = connection
    this.credentialProvider?.bind(async (ref) => {
      if (!this.handshaken || !this.allowedCredentialRefs.has(ref)) {
        return undefined
      }
      const response = await connection.extMethod(
        GOODBUDDY_CREDENTIAL,
        { ref }
      )
      const value = response.value
      return typeof value === 'string' && value.length > 0
        ? value
        : undefined
    })
    void connection.closed.finally(() => this.dispose())
    return connection
  }

  private capabilities(): GoodBuddyHarnessCapabilities {
    return {
      controlProtocolVersion: GOODBUDDY_CONTROL_PROTOCOL_VERSION,
      harnessVersion: this.config.harnessVersion,
      acpProtocolVersion: PROTOCOL_VERSION,
      supports: {
        cancellation: true,
        sessionRelease: true,
        reasoningEvents: true,
        toolEvents: true,
        usageEvents: true,
        credentialResolution: true
      },
      execution: this.config.execution
    }
  }

  private requireSession(sessionId: string): OwnedSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `unknown session: ${sessionId}`
      )
    }
    return session
  }

  private async sendEvent(
    sessionId: string,
    event: Record<string, unknown>
  ): Promise<void> {
    const record = this.sessions.get(sessionId)
    const inflight = record?.inflight
    if (!inflight || !this.connection) {
      return
    }
    const params = {
      sessionId,
      requestId: inflight.requestId,
      ...event
    }
    const text = JSON.stringify(params)
    if (text.length > this.maxEventCharacters) {
      throw new Error(
        'GoodBuddy Harness control event exceeds safety limit'
      )
    }
    inflight.emittedCharacters += text.length
    if (
      inflight.emittedCharacters > this.maxRequestCharacters
    ) {
      record.handle.agent.cancel({ kind: 'user' })
      throw new Error(
        'GoodBuddy Harness control request output exceeds safety limit'
      )
    }
    await this.connection.extNotification(GOODBUDDY_EVENT, params)
  }

  private enqueueEvent(
    sessionId: string,
    event: Record<string, unknown>
  ): void {
    const record = this.sessions.get(sessionId)
    const inflight = record?.inflight
    if (!record || !inflight) {
      return
    }
    const previous = inflight.eventTail
    const queued = previous.then(() =>
      this.sendEvent(sessionId, event)
    )
    inflight.eventTail = queued.catch((error: unknown) => {
      inflight.eventError ??= error
      record.handle.agent.cancel({ kind: 'user' })
    })
  }

  private flushPendingDelta(sessionId: string): void {
    const inflight = this.sessions.get(sessionId)?.inflight
    const pending = inflight?.pendingDelta
    if (!inflight || !pending) {
      return
    }
    if (inflight.pendingDeltaTimer) {
      clearTimeout(inflight.pendingDeltaTimer)
      inflight.pendingDeltaTimer = undefined
    }
    inflight.pendingDelta = undefined
    this.enqueueEvent(sessionId, pending)
  }

  private maxDeltaBatchCharacters(
    sessionId: string,
    type: 'text' | 'reasoning'
  ): number {
    const inflight = this.sessions.get(sessionId)?.inflight
    if (!inflight) {
      return 0
    }
    const envelopeLength = JSON.stringify({
      sessionId,
      requestId: inflight.requestId,
      type,
      delta: ''
    }).length
    return Math.min(
      DELTA_BATCH_CHARACTERS,
      this.maxEventCharacters - envelopeLength
    )
  }

  private queueDelta(
    sessionId: string,
    type: 'text' | 'reasoning',
    delta: string
  ): void {
    const inflight = this.sessions.get(sessionId)?.inflight
    if (!inflight || !delta) {
      return
    }
    const batchLimit = this.maxDeltaBatchCharacters(
      sessionId,
      type
    )
    if (batchLimit < 1) {
      this.failEventStream(
        sessionId,
        new Error(
          'GoodBuddy Harness control event exceeds safety limit'
        )
      )
      return
    }
    let remaining = delta
    while (remaining) {
      if (
        inflight.pendingDelta &&
        inflight.pendingDelta.type !== type
      ) {
        this.flushPendingDelta(sessionId)
      }
      inflight.pendingDelta ??= { type, delta: '' }
      const available =
        batchLimit - inflight.pendingDelta.delta.length
      if (available <= 0) {
        this.flushPendingDelta(sessionId)
        continue
      }
      inflight.pendingDelta.delta += remaining.slice(0, available)
      remaining = remaining.slice(available)
      if (inflight.pendingDelta.delta.length >= batchLimit) {
        this.flushPendingDelta(sessionId)
      }
    }
    if (
      inflight.pendingDelta &&
      !inflight.pendingDeltaTimer
    ) {
      inflight.pendingDeltaTimer = setTimeout(() => {
        this.flushPendingDelta(sessionId)
      }, DELTA_BATCH_INTERVAL_MS)
    }
  }

  private queueEvent(
    sessionId: string,
    event: Record<string, unknown>
  ): void {
    this.flushPendingDelta(sessionId)
    this.enqueueEvent(sessionId, event)
  }

  private failEventStream(sessionId: string, error: unknown): void {
    const record = this.sessions.get(sessionId)
    const inflight = record?.inflight
    if (!record || !inflight) {
      return
    }
    inflight.eventError ??= error
    record.handle.agent.cancel({ kind: 'user' })
  }

  private observeSessions(): void {
    if (this.observing) {
      return
    }
    this.observing = true
    this.ctx.on('tools/execute', async (exec, next) => {
      const sessionId = exec.agent?.session.id
      const record = sessionId
        ? this.sessions.get(sessionId)
        : undefined
      if (
        record &&
        record.handle.agent === exec.agent &&
        record.inflight?.mode === 'ask' &&
        ASK_BLOCKED_TOOL_NAMES.has(exec.name)
      ) {
        throw new Error(
          `Ask 模式不允许执行修改或命令工具：${exec.name}`
        )
      }
      return next()
    })
    this.ctx.on(
      'session/event',
      (session, event: SessionEvent) => {
        const record = this.sessions.get(session.header.id)
        if (!record || record.handle.agent.session !== session) {
          return
        }
        const inflight = record.inflight
        if (!inflight) {
          return
        }
        if (event.type === 'assistant/chunk') {
          const chunk = event.data.chunk
          if (
            chunk.type === 'text-delta' ||
            chunk.type === 'reasoning-delta'
          ) {
            this.queueDelta(
              session.header.id,
              chunk.type === 'text-delta'
                ? 'text'
                : 'reasoning',
              chunk.text
            )
          } else if (chunk.type === 'usage') {
            this.queueUsage(session.header.id, chunk.usage)
          }
        } else if (event.type === 'tool/call') {
          this.queueEvent(session.header.id, {
            type: 'tool',
            callId: event.data.callId,
            name: event.data.name,
            state: 'pending',
            input: event.data.arguments.slice(
              0,
              MAX_SUMMARY_CHARACTERS
            )
          })
        } else if (event.type === 'tool/result') {
          const toolResult = event.data.message.content.find(
            (content) => content.type === 'tool-result'
          )
          this.queueEvent(session.header.id, {
            type: 'tool',
            callId: toolResult?.toolCallId ?? 'unknown-tool-call',
            name: 'tool',
            state: event.data.error ? 'failed' : 'completed',
            output: boundedJson(event.data.message.content)
          })
        }
        if (
          event.type === 'turn/end' &&
          inflight.turn === event.data.turn
        ) {
          inflight.endReason = turnReason(event)
        }
      }
    )
    this.ctx.on(
      'agent/inbox/claimed',
      ({ agent, message, turn }) => {
        const record = this.sessions.get(agent.session.id)
        if (
          record?.handle.agent === agent &&
          record.inflight?.messageId === message.id
        ) {
          record.inflight.turn = turn
        }
      }
    )
    this.ctx.on(
      'agent/error',
      ({ agent, error }) => {
        const record = this.sessions.get(agent.session.id)
        if (record?.handle.agent === agent) {
          if (record.inflight) {
            record.inflight.turnError = error
          }
        }
      }
    )
  }

  private queueUsage(sessionId: string, usage: TokenUsage): void {
    this.flushPendingDelta(sessionId)
    this.enqueueEvent(sessionId, {
      type: 'model-usage',
      callId: randomUUID(),
      provider: this.config.provider,
      model: this.config.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0
    })
  }

  private proxyToolDefinition(
    sessionId: string,
    tool: ProxyToolDefinition
  ): ToolDefinition {
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      output: {
        schema: {
          type: 'object',
          properties: {
            content: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true
              }
            }
          },
          required: ['content'],
          additionalProperties: false
        },
        render(_args, result) {
          const content = (
            result as {
              content: Array<{
                type?: unknown
                text?: unknown
              }>
            }
          ).content
          return content
            .filter(
              (
                part
              ): part is {
                type: 'text'
                text: string
              } =>
                part.type === 'text' &&
                typeof part.text === 'string'
            )
            .map((part) => ({
              type: 'text' as const,
              text: part.text
            }))
        }
      },
      execute: async (argumentsValue) => {
        const result = await this.connection!.extMethod(
          GOODBUDDY_TOOLS_CALL,
          {
            sessionId,
            name: tool.name,
            arguments: argumentsValue
          }
        )
        return validateProxyToolResult(result)
      }
    }
  }

  private async refreshProxyTools(
    sessionId: string,
    record: OwnedSession
  ): Promise<void> {
    const response = await this.connection!.extMethod(
      GOODBUDDY_TOOLS_LIST,
      { sessionId }
    )
    const tools = parseProxyToolCatalog(response.tools)
    const nextNames = new Set(tools.map((tool) => tool.name))
    for (const [name, dispose] of record.proxyToolDisposers) {
      if (!nextNames.has(name)) {
        dispose()
        record.proxyToolDisposers.delete(name)
      }
    }
    for (const tool of tools) {
      if (!record.proxyToolDisposers.has(tool.name)) {
        record.proxyToolDisposers.set(
          tool.name,
          record.handle.agent.ctx.tools.register(
            this.proxyToolDefinition(sessionId, tool)
          )
        )
      }
    }
  }

  private createAgentApi(): Agent {
    this.observeSessions()
    return {
      initialize: async () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: {
          name: 'goodbuddy-deepseek-harness',
          version: this.config.harnessVersion
        },
        agentCapabilities: {
          promptCapabilities: {
            image: false,
            audio: false,
            embeddedContext: false
          },
          sessionCapabilities: {
            close: {}
          }
        },
        authMethods: []
      }),
      authenticate: async () => undefined,
      newSession: async (params) => {
        if (this.closed) {
          throw RequestError.internalError(
            undefined,
            'bridge is shutting down'
          )
        }
        if (
          !isAbsolute(params.cwd) ||
          params.cwd !== this.config.workspace ||
          params.mcpServers.length > 0
        ) {
          throw RequestError.invalidParams(
            undefined,
            'the controlled workspace and no MCP servers are required'
          )
        }
        const sessionId = SessionId(randomUUID())
        const handle = await this.ctx.agents.create({
          sessionId,
          meta: { cwd: params.cwd },
          agentOptions: {
            provider: this.config.provider,
            model: this.config.model,
            maxTokens: GOODBUDDY_HARNESS_MAX_STEP_TOKENS
          },
          setup: async (agentCtx) => {
            agentCtx.systemPrompt.section({
              name: 'goodbuddy:controlled-execution',
              order: 50,
              text: GOODBUDDY_EXECUTION_GUIDANCE
            })
            const skillTool = agentCtx.plugin(ToolSkill)
            const skillRegistrations = agentCtx.inject(
              ['skills'],
              (skillCtx) => {
                for (const skill of this.config.skills) {
                  skillCtx.skills.register({
                    name: skill.name,
                    description: skill.description,
                    content: skill.content,
                    source: 'bundled',
                    resourceBase: {
                      kind: 'directory',
                      path: skill.directory
                    },
                    invocation: {
                      modelInvocable: true,
                      userInvocable: true
                    }
                  })
                }
              }
            )
            await Promise.all([skillTool, skillRegistrations])
          }
        })
        this.sessions.set(sessionId, {
          handle,
          proxyToolDisposers: new Map()
        })
        return {
          sessionId,
          modes: {
            currentModeId: 'ask',
            availableModes: [
              {
                id: 'ask',
                name: 'Ask',
                description: 'Read-only'
              }
            ]
          }
        }
      },
      prompt: async (params) => {
        const record = this.requireSession(params.sessionId)
        if (record.inflight) {
          throw RequestError.invalidParams(
            undefined,
            'a prompt is already in flight'
          )
        }
        const preparation = record.preparation
        record.preparation = undefined
        if (!preparation) {
          throw RequestError.invalidParams(
            undefined,
            'a single-use goodbuddy/session/prepare is required'
          )
        }
        if (preparation.mode === 'execute') {
          await this.refreshProxyTools(params.sessionId, record)
        } else {
          for (const dispose of record.proxyToolDisposers.values()) {
            dispose()
          }
          record.proxyToolDisposers.clear()
        }
        const text = promptText(params.prompt)
        if (!text.trim()) {
          throw RequestError.invalidParams(
            undefined,
            'empty prompt'
          )
        }
        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' }
        })
        const stopReason = await new Promise<string>(
          (resolve, reject) => {
            record.inflight = {
              requestId: preparation.requestId,
              messageId: message.id,
              mode: preparation.mode,
              resolve,
              reject,
              emittedCharacters: 0,
              eventTail: Promise.resolve()
            }
            try {
              record.handle.agent.followup(message)
            } catch (error) {
              record.inflight = undefined
              reject(error)
              return
            }
            void record.handle.agent.whenIdle().then(() => {
              const current = record.inflight
              if (current?.messageId !== message.id) {
                return
              }
              this.flushPendingDelta(params.sessionId)
              void current.eventTail.then(() => {
                if (record.inflight === current) {
                  record.inflight = undefined
                }
                if (current.eventError) {
                  current.reject(current.eventError)
                  return
                }
                if (current.turnError) {
                  const details = errorChain(
                    current.turnError
                  ).slice(0, MAX_SUMMARY_CHARACTERS)
                  current.reject(
                    RequestError.internalError(
                      { details },
                      `DeepSeek Harness turn failed: ${details}`
                    )
                  )
                  return
                }
                current.resolve(current.endReason ?? 'cancelled')
              })
            }, (error) => {
              if (record.inflight?.messageId === message.id) {
                record.inflight = undefined
              }
              reject(error)
            })
          }
        )
        return {
          stopReason:
            stopReason === 'cancelled'
              ? 'cancelled'
              : stopReason === 'max_tokens'
                ? 'max_tokens'
                : 'end_turn'
        }
      },
      cancel: async ({ sessionId }) => {
        const record = this.sessions.get(sessionId)
        record?.handle.agent.cancel({ kind: 'user' })
        if (record?.inflight) {
          const inflight = record.inflight
          if (inflight.pendingDeltaTimer) {
            clearTimeout(inflight.pendingDeltaTimer)
          }
          record.inflight = undefined
          inflight.resolve('cancelled')
        }
      },
      closeSession: async ({ sessionId }) => {
        await this.releaseSession(sessionId)
      },
      extMethod: (method, params) =>
        this.extensionMethod(method, params),
      extNotification: async () => {
        throw RequestError.methodNotFound('extension notification')
      }
    }
  }

  async extensionMethod(
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (method === GOODBUDDY_HANDSHAKE) {
      const version = params.controlProtocolVersion
      if (version !== GOODBUDDY_CONTROL_PROTOCOL_VERSION) {
        throw RequestError.invalidParams(
          undefined,
          'incompatible GoodBuddy Harness control protocol'
        )
      }
      this.handshaken = true
      return this.capabilities() as unknown as Record<
        string,
        unknown
      >
    }
    if (!this.handshaken) {
      throw RequestError.invalidParams(
        undefined,
        'GoodBuddy handshake is required'
      )
    }
    if (method === GOODBUDDY_PREPARE) {
      const sessionId = requiredString(params, 'sessionId')
      const requestId = requiredString(params, 'requestId')
      const mode = params.mode
      if (mode !== 'ask' && mode !== 'execute') {
        throw RequestError.invalidParams(
          undefined,
          'mode must be ask or execute'
        )
      }
      const record = this.requireSession(sessionId)
      if (record.inflight || record.preparation) {
        throw RequestError.invalidParams(
          undefined,
          'session is already prepared or running'
        )
      }
      record.preparation = { requestId, mode }
      return { prepared: true }
    }
    if (method === GOODBUDDY_RELEASE) {
      await this.releaseSession(
        requiredString(params, 'sessionId')
      )
      return { released: true }
    }
    if (method === GOODBUDDY_SHUTDOWN) {
      await this.dispose()
      return { shutdown: true }
    }
    throw RequestError.methodNotFound(method)
  }

  async releaseSession(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId)
    if (!record) {
      return
    }
    this.sessions.delete(sessionId)
    record.handle.agent.cancel({ kind: 'user' })
    if (record.inflight) {
      if (record.inflight.pendingDeltaTimer) {
        clearTimeout(record.inflight.pendingDeltaTimer)
      }
      record.inflight.resolve('cancelled')
      record.inflight = undefined
    }
    await record.handle.dispose()
  }

  async dispose(): Promise<void> {
    this.disposing ??= (async () => {
      this.closed = true
      const sessions = [...this.sessions.entries()]
      this.sessions.clear()
      for (const [, record] of sessions) {
        record.handle.agent.cancel({ kind: 'disposed' })
        if (record.inflight?.pendingDeltaTimer) {
          clearTimeout(record.inflight.pendingDeltaTimer)
        }
        record.inflight?.resolve('cancelled')
      }
      await Promise.allSettled(
        sessions.map(([, record]) => record.handle.dispose())
      )
    })()
    await this.disposing
  }
}
