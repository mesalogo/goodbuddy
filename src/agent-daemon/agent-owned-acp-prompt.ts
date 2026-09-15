import { createHash } from 'node:crypto'
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type McpServer,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification
} from '@agentclientprotocol/sdk'
import { canonicalJson } from '../shared/agent-protocol/canonical'
import { remoteQuestionSchema, type RemoteQuestionResponse } from '../shared/remote-question-contracts'
import type {
  RemoteOwnedPromptStartRequest,
  RemoteOwnedPromptStartResult
} from '../shared/remote-agent-contracts'
import type { RuntimeAcpProcessOwner } from './runtime-acp-backend'
import { AgentAcpConnection } from './agent-acp-connection'
import {
  SemanticPromptStore,
  SemanticPromptStoreError
} from './semantic-prompt-store'

export type AgentOwnedAcpPromptOptions = {
  bindingId: string
  controllerId: string
  workspaceDirectory: string
  mcpServers?: () => McpServer[]
  expectedModel?: string
  process: RuntimeAcpProcessOwner
  transport?: AgentAcpConnection
  prepareSession?: (sessionId: string, operationId: string, workMode: 'ask' | 'execute') => Promise<void>
  transcript: SemanticPromptStore
  completePrompt: (
    operationId: string,
    status: 'completed' | 'failed' | 'cancelled' | 'outcome-unknown',
    response?: PromptResponse
  ) => void | Promise<void>
  resolveTerminalState?: (
    proposed: 'completed' | 'failed' | 'cancelled'
  ) => 'completed' | 'failed' | 'cancelled' | 'outcome-unknown'
  createConnection?: (
    client: () => Client,
    stream: ReturnType<typeof ndJsonStream>
  ) => ClientSideConnection
}

/**
 * Owns a native Session and its original prompt Promise. Desktop connection
 * signals are not part of this lifetime; the native transport may be shared.
 */
export class AgentOwnedAcpPrompt {
  readonly #options: AgentOwnedAcpPromptOptions
  readonly #connection: ClientSideConnection
  readonly #transport: AgentAcpConnection
  #unregisterSession?: () => void
  readonly #processExit: Promise<never>
  #sessionId?: string
  #promptPromise?: Promise<void>
  #promptSettled?: Promise<void>
  #closed = false
  #initialized = false
  #hasMcpServers = false
  readonly #questions = new Map<string, {
    endpoint: string; operationId: string; questionCount: number; notification: SessionNotification
  }>()
  #acceptQuestions = false
  #active?: {
    operationId: string
    workMode: 'ask' | 'execute'
  }

  constructor(options: AgentOwnedAcpPromptOptions) {
    this.#options = options
    this.#transport = options.transport ?? new AgentAcpConnection(
      options.process, () => this.#client(), options.createConnection
    )
    this.#connection = this.#transport.connection
    this.#processExit = this.#transport.exited
  }

  get sessionId(): string | undefined { return this.#sessionId }

  async start(
    request: RemoteOwnedPromptStartRequest,
    workMode: 'ask' | 'execute'
  ): Promise<RemoteOwnedPromptStartResult> {
    if (
      request.bindingId !== this.#options.bindingId
    ) {
      throw new SemanticPromptStoreError(
        'Owned ACP prompt identity does not match its preparation',
        'conflict'
      )
    }
    const startDigest = digest(canonicalJson(request))
    const existing = this.#options.transcript.findStarted({
      bindingId: request.bindingId,
      operationId: request.operationId,
      controllerId: this.#options.controllerId,
      startDigest
    })
    if (existing !== undefined) {
      return existing
    }
    if (this.#active !== undefined) {
      throw new SemanticPromptStoreError(
        'Another ACP prompt is still active',
        'conflict'
      )
    }

    const mcpServers = this.#options.mcpServers?.() ?? []
    if (!this.#initialized) {
      const initialization = await this.#whileProcessAlive(
        this.#transport.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            terminal: false,
            fs: {
              readTextFile: false,
              writeTextFile: false
            }
          },
          clientInfo: {
            name: 'GoodBuddy Agent',
            version: '1'
          }
        })
      )
      if (initialization.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error('ACP Runtime protocol version is incompatible')
      }
      if (request.acpSessionId !== undefined && this.#sessionId === undefined) {
        if (initialization.agentCapabilities?.loadSession === true) {
          await this.#whileProcessAlive(
            this.#connection.loadSession({
              sessionId: request.acpSessionId,
              cwd: this.#options.workspaceDirectory,
              mcpServers
            })
          )
        } else if (
          initialization.agentCapabilities?.sessionCapabilities?.resume != null
        ) {
          await this.#whileProcessAlive(
            this.#connection.resumeSession({
              sessionId: request.acpSessionId,
              cwd: this.#options.workspaceDirectory,
              mcpServers
            })
          )
        } else {
          throw new Error('ACP Runtime cannot resume the requested session')
        }
        this.#sessionId = request.acpSessionId
      } else if (this.#sessionId === undefined) {
        const created = await this.#whileProcessAlive(
          this.#connection.newSession({
            cwd: this.#options.workspaceDirectory,
            mcpServers
          })
        )
        this.#sessionId = created.sessionId
      }
      if (this.#options.expectedModel !== undefined) {
        const configured = await this.#whileProcessAlive(
          this.#connection.setSessionConfigOption({
            sessionId: this.#sessionId!,
            configId: 'model',
            value: this.#options.expectedModel
          })
        )
        const selectedModel = configured.configOptions.find(
          (option) => option.id === 'model' && option.type === 'select'
        )
        if (
          selectedModel === undefined ||
          selectedModel.currentValue !== this.#options.expectedModel
        ) {
          throw new Error('ACP Runtime did not select the prepared model')
        }
      }
      this.#unregisterSession = this.#transport.register(this.#sessionId!, this.#client())
      this.#initialized = true
    } else if (
      request.acpSessionId !== undefined &&
      request.acpSessionId !== this.#sessionId
    ) {
      throw new Error('ACP session identity cannot change within a binding')
    } else if (mcpServers.length > 0 || this.#hasMcpServers) {
      await this.#whileProcessAlive(this.#connection.resumeSession({
        sessionId: this.#sessionId!, cwd: this.#options.workspaceDirectory,
        mcpServers
      }))
    }
    this.#hasMcpServers = mcpServers.length > 0
    await this.#options.prepareSession?.(this.#sessionId!, request.operationId, workMode)
    this.#active = {
      operationId: request.operationId,
      workMode
    }
    this.#acceptQuestions = true
    const begun = this.#options.transcript.begin({
      bindingId: this.#options.bindingId,
      operationId: request.operationId,
      startDigest,
      sessionId: this.#sessionId!
    })
    // Keep this exact Promise alive on Agent. The caller receives only the
    // durable operation identity and may disconnect immediately.
    const promptOperation = this.#whileProcessAlive(
      this.#connection.prompt({
          sessionId: this.#sessionId!,
          prompt: request.prompt
        })
    )
    this.#promptSettled = promptOperation.then(() => undefined, () => undefined)
    this.#promptPromise = promptOperation.then(
        async (response) => {
          const proposed =
            response.stopReason === 'cancelled'
              ? 'cancelled'
              : 'completed'
          let state =
            this.#options.resolveTerminalState?.(proposed) ?? proposed
          let completionError: unknown
          try {
            await this.#options.completePrompt(
              request.operationId,
              state,
              response
            )
          } catch (error) {
            state = 'outcome-unknown'
            completionError = error
          }
          this.#appendTerminal(state, {
            status: state,
            response,
            ...(completionError === undefined
              ? {}
              : { completionError: boundedError(completionError) })
          })
        },
        async (error: unknown) => {
          let state =
            this.#options.resolveTerminalState?.('failed') ?? 'failed'
          let completionError: unknown
          try {
            await this.#options.completePrompt(
              request.operationId,
              state
            )
          } catch (completionFailure) {
            state = 'outcome-unknown'
            completionError = completionFailure
          }
          this.#appendTerminal(state, {
            status: state,
            error: boundedError(error),
            ...(completionError === undefined
              ? {}
              : { completionError: boundedError(completionError) })
          })
        }
      )
      .finally(() => {
        this.#questions.clear()
        this.#acceptQuestions = false
        this.#active = undefined
      })
    void this.#promptPromise.catch(() => undefined)
    return begun.result
  }

  async cancel(): Promise<void> {
    this.#acceptQuestions = false
    this.#questions.clear()
    if (this.#sessionId !== undefined && !this.#closed) {
      await this.#connection.cancel({ sessionId: this.#sessionId })
    }
  }

  close(): void {
    this.#clear()
  }

  async releaseSession(): Promise<void> {
    await this.cancel()
    if (this.#sessionId && !this.#closed) {
      await this.#connection.closeSession({ sessionId: this.#sessionId })
    }
    // Wait for the original native Prompt, not its completion callback, which
    // may be queued behind the caller's backend control operation.
    await this.#promptSettled
    this.close()
  }

  async respondToQuestion(request: RemoteQuestionResponse): Promise<void> {
    const pending = this.#questions.get(request.questionId)
    if (this.#closed || !pending || this.#active?.operationId !== request.operationId ||
      pending.operationId !== request.operationId || request.bindingId !== this.#options.bindingId) {
      throw new Error('Remote question is no longer pending for this prompt')
    }
    if (request.answers.length !== 0 && request.answers.length !== pending.questionCount) {
      throw new Error('Question answer count does not match')
    }
    const response = await fetch(pending.endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, sessionId: this.#sessionId }),
      signal: AbortSignal.timeout(30_000), redirect: 'error'
    })
    if (!response.ok) throw new Error(`OpenCode question response failed (${response.status})`)
    this.#questions.delete(request.questionId)
  }

  pendingQuestions(operationId: string): SessionNotification[] {
    if (!this.#acceptQuestions || this.#active?.operationId !== operationId) return []
    return [...this.#questions.values()].map(question => question.notification)
  }

  #client(): Client {
    return {
      requestPermission: async (request) =>
        this.#handlePermission(request),
      sessionUpdate: async (notification) => {
        this.#handleSessionUpdate(notification)
      },
      extMethod: async () => ({}),
      extNotification: async () => undefined
    }
  }

  #handleSessionUpdate(notification: SessionNotification): void {
    if (this.#closed || !this.#active) return
    if (
      notification.sessionId !== this.#sessionId &&
      this.#sessionId !== undefined
    ) {
      throw new Error('ACP session notification identity changed')
    }
    const resolved = notification.update._meta?.goodbuddyQuestionResolved
    if (typeof resolved === 'string') {
      this.#questions.delete(resolved)
      return
    }
    const extension = notification.update._meta?.goodbuddyQuestion
    if (extension !== undefined) {
      if (!this.#acceptQuestions) return
      if (!extension || typeof extension !== 'object') throw new Error('Invalid remote question')
      const value = extension as { question?: unknown; endpoint?: unknown; childCallId?: unknown }
      const question = remoteQuestionSchema.parse(value.question)
      if (typeof value.endpoint !== 'string' ||
        !/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}$/u.test(value.endpoint)) {
        throw new Error('Invalid remote question endpoint')
      }
      if (this.#questions.has(question.id)) return
      // The process-local reply capability never enters the durable transcript.
      notification = { ...notification, update: {
        ...notification.update, _meta: { goodbuddyQuestion: {
          question, ...(typeof value.childCallId === 'string' ? { childCallId: value.childCallId } : {})
        } }
      } }
      this.#questions.set(question.id, { endpoint: value.endpoint, operationId: this.#active.operationId,
        questionCount: question.questions.length, notification })
    }
    this.#options.transcript.append({
      bindingId: this.#options.bindingId,
      operationId: this.#requireActive().operationId,
      kind: 'session-update',
      payload: notification
    })
  }

  #handlePermission(
    request: RequestPermissionRequest
  ): RequestPermissionResponse {
    const active = this.#requireActive()
    const selected =
      active.workMode === 'execute'
        ? request.options.find((option) => option.kind === 'allow_once') ??
          request.options.find((option) => option.kind === 'allow_always')
        : request.toolCall.kind === 'read' || request.toolCall.kind === 'search'
          ? request.options.find((option) => option.kind === 'allow_once')
          : request.options.find((option) => option.kind === 'reject_once') ??
            request.options.find((option) => option.kind === 'reject_always')
    const response: RequestPermissionResponse =
      selected === undefined
        ? { outcome: { outcome: 'cancelled' } }
        : {
            outcome: {
              outcome: 'selected',
              optionId: selected.optionId
            }
          }
    this.#options.transcript.append({
      bindingId: this.#options.bindingId,
      operationId: active.operationId,
      kind: 'permission-decision',
      payload: {
        sessionId: request.sessionId,
        toolCallId: request.toolCall.toolCallId,
        outcome: response.outcome
      }
    })
    return response
  }

  #appendTerminal(
    state: 'completed' | 'failed' | 'cancelled' | 'outcome-unknown',
    payload: unknown
  ): void {
    this.#options.transcript.append({
      bindingId: this.#options.bindingId,
      operationId: this.#requireActive().operationId,
      kind: 'prompt-terminal',
      payload,
      terminalState: state
    })
  }

  #clear(): void {
    if (this.#closed) {
      return
    }
    this.#closed = true
    this.#acceptQuestions = false
    this.#questions.clear()
    this.#unregisterSession?.()
    if (!this.#options.transport) this.#transport.dispose()
  }

  async #whileProcessAlive<T>(operation: Promise<T>): Promise<T> {
    return await Promise.race([operation, this.#processExit])
  }

  #requireActive(): { operationId: string; workMode: 'ask' | 'execute' } {
    if (this.#active === undefined) {
      throw new Error('ACP notification has no active prompt')
    }
    return this.#active
  }
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function boundedError(error: unknown): { name: string; message: string } {
  const name =
    error instanceof Error ? error.name.slice(0, 256) : 'Error'
  const message =
    error instanceof Error
      ? error.message.slice(0, 8 * 1024)
      : 'ACP prompt failed'
  return { name, message }
}
