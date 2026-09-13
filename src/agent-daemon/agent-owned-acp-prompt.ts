import { createHash } from 'node:crypto'
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
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
import {
  SemanticPromptStore,
  SemanticPromptStoreError
} from './semantic-prompt-store'

export type AgentOwnedAcpPromptOptions = {
  bindingId: string
  controllerId: string
  workspaceDirectory: string
  workMode: 'ask' | 'execute'
  expectedModel?: string
  process: RuntimeAcpProcessOwner
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
 * Owns the ACP ClientSideConnection and the original prompt Promise. No
 * transport-connection signal is part of this lifetime.
 */
export class AgentOwnedAcpPrompt {
  readonly #options: AgentOwnedAcpPromptOptions
  readonly #connection: ClientSideConnection
  readonly #input: ReadableStream<Uint8Array>
  readonly #unsubscribeOutput: () => void
  readonly #unsubscribeExit: () => void
  readonly #processExit: Promise<never>
  #sessionId?: string
  #promptPromise?: Promise<void>
  #closed = false
  #initialized = false
  readonly #questions = new Map<string, {
    endpoint: string; operationId: string; questionCount: number; notification: SessionNotification
  }>()
  #acceptQuestions = false
  #active?: {
    operationId: string
  }

  constructor(options: AgentOwnedAcpPromptOptions) {
    this.#options = options
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let rejectProcessExit!: (error: Error) => void
    this.#processExit = new Promise<never>((_resolve, reject) => {
      rejectProcessExit = reject
    })
    void this.#processExit.catch(() => undefined)
    this.#input = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      }
    })
    const output = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        await options.process.writeStdin(chunk)
      }
    })
    const unsubscribe = options.process.subscribeOutput((event) => {
      if (
        event.stream === 'stdout' &&
        event.data.byteLength > 0 &&
        !this.#closed
      ) {
        controller?.enqueue(event.data.slice())
      }
    })
    this.#unsubscribeOutput = unsubscribe ?? (() => undefined)
    const unsubscribeExit = options.process.subscribeExit?.(() => {
      if (this.#closed) {
        return
      }
      const error = new Error('ACP Runtime process exited')
      this.#acceptQuestions = false
      this.#questions.clear()
      controller?.error(error)
      controller = undefined
      rejectProcessExit(error)
    })
    this.#unsubscribeExit = unsubscribeExit ?? (() => undefined)
    const stream = ndJsonStream(output, this.#input)
    this.#connection =
      options.createConnection?.(() => this.#client(), stream) ??
      new ClientSideConnection(() => this.#client(), stream)
  }

  async start(
    request: RemoteOwnedPromptStartRequest
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

    if (!this.#initialized) {
      const initialization = await this.#whileProcessAlive(
        this.#connection.initialize({
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
              mcpServers: []
            })
          )
        } else if (
          initialization.agentCapabilities?.sessionCapabilities?.resume === true
        ) {
          await this.#whileProcessAlive(
            this.#connection.resumeSession({
              sessionId: request.acpSessionId,
              cwd: this.#options.workspaceDirectory,
              mcpServers: []
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
            mcpServers: []
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
      this.#initialized = true
    } else if (
      request.acpSessionId !== undefined &&
      request.acpSessionId !== this.#sessionId
    ) {
      throw new Error('ACP session identity cannot change within a binding')
    }
    this.#active = {
      operationId: request.operationId
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
    this.#promptPromise = this.#whileProcessAlive(
      this.#connection.prompt({
          sessionId: this.#sessionId,
          prompt: request.prompt
        })
    )
      .then(
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
    const selected =
      this.#options.workMode === 'execute'
        ? request.options.find((option) => option.kind === 'allow_always') ??
          request.options.find((option) => option.kind === 'allow_once')
        : request.toolCall.kind === 'read'
          ? request.options.find((option) => option.kind === 'allow_once')
          : request.options.find((option) => option.kind === 'reject_always') ??
            request.options.find((option) => option.kind === 'reject_once')
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
      operationId: this.#requireActive().operationId,
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
    this.#unsubscribeOutput()
    this.#unsubscribeExit()
  }

  async #whileProcessAlive<T>(operation: Promise<T>): Promise<T> {
    return await Promise.race([operation, this.#processExit])
  }

  #requireActive(): NonNullable<AgentOwnedAcpPrompt['#active']> {
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
