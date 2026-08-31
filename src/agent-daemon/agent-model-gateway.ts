import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentPromptModelProfile } from '../shared/model-bridge-contracts'
import {
  REMOTE_MODEL_GATEWAY_LIMITS,
  remoteModelGatewayRequestSchema,
  remoteModelGatewayResponseSchema,
  type RemoteModelGatewayRequest,
  type RemoteModelGatewayResponse
} from '../shared/remote-model-gateway-contracts'
import {
  assertTextModelRequestPolicy,
  ModelRequestPolicyError
} from '../shared/model-request-policy'
import {
  BoundedResponseTruncatedError,
  BoundedResponseTooLargeError,
  readBoundedResponseBytes
} from '../shared/node/bounded-response'
import { openPrivateSqliteDatabase } from '../shared/node/private-sqlite-database'

const RESPONSE_HEADERS = [
  'content-type',
  'openai-request-id',
  'request-id',
  'x-request-id'
] as const

type CallRow = {
  call_id: string
  binding_id: string
  operation_id: string
  prompt_sequence: number
  round_index: number
  profile_digest: string
  request_digest: string
  status: 'dispatched' | 'completed' | 'outcome-unknown'
  response_delivered: number
}

export class AgentModelGatewayError extends Error {
  constructor(
    readonly code:
      | 'already-dispatched'
      | 'cancelled'
      | 'conflict'
      | 'outcome-unknown'
      | 'policy'
      | 'response-too-large'
      | 'timeout',
    message: string
  ) {
    super(message)
    this.name = 'AgentModelGatewayError'
  }
}

export class AgentModelCallLedger {
  readonly #database: DatabaseSync
  readonly #maximumRetainedTerminalCalls: number
  #closed = false

  constructor(
    path: string,
    options: { maximumRetainedTerminalCalls?: number } = {}
  ) {
    this.#maximumRetainedTerminalCalls =
      options.maximumRetainedTerminalCalls ?? 10_000
    if (
      !Number.isSafeInteger(this.#maximumRetainedTerminalCalls) ||
      this.#maximumRetainedTerminalCalls < 1
    ) {
      throw new AgentModelGatewayError(
        'conflict',
        'Model call ledger retention limit is invalid'
      )
    }
    this.#database = openPrivateSqliteDatabase(path)
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS agent_model_calls (
        call_id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        prompt_sequence INTEGER NOT NULL CHECK (prompt_sequence >= 0),
        round_index INTEGER NOT NULL CHECK (round_index >= 0),
        profile_digest TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('dispatched', 'completed', 'outcome-unknown')
        ),
        response_delivered INTEGER NOT NULL DEFAULT 0 CHECK (
          response_delivered IN (0, 1)
        ),
        terminal_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (binding_id, operation_id, round_index)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS agent_model_calls_dispatched
        ON agent_model_calls(status) WHERE status = 'dispatched';
      CREATE INDEX IF NOT EXISTS agent_model_calls_terminal_retention
        ON agent_model_calls(updated_at DESC)
        WHERE status <> 'dispatched';
    `)
    // A provider dispatch that survived an Agent restart cannot be retried.
    this.#database.exec(`
      UPDATE agent_model_calls
      SET status = 'outcome-unknown', terminal_code = 'agent-restarted',
          updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
      WHERE status = 'dispatched'
    `)
    this.#pruneTerminalCalls()
  }

  #pruneTerminalCalls(protectedCallId?: string): void {
    if (protectedCallId === undefined) {
      this.#database.prepare(`
        DELETE FROM agent_model_calls
        WHERE call_id IN (
          SELECT call_id
          FROM agent_model_calls
          WHERE status <> 'dispatched'
          ORDER BY updated_at DESC, created_at DESC, call_id DESC
          LIMIT -1 OFFSET ?
        );
      `).run(this.#maximumRetainedTerminalCalls)
      return
    }
    this.#database.prepare(`
      DELETE FROM agent_model_calls
      WHERE call_id IN (
        SELECT call_id
        FROM agent_model_calls
        WHERE status <> 'dispatched' AND call_id <> ?
        ORDER BY updated_at DESC, created_at DESC, call_id DESC
        LIMIT -1 OFFSET ?
      );
    `).run(
      protectedCallId,
      this.#maximumRetainedTerminalCalls - 1
    )
  }

  claim(input: {
    callId: string
    bindingId: string
    operationId: string
    promptSequence: number
    roundIndex: number
    profileDigest: string
    requestDigest: string
  }): void {
    this.#assertOpen()
    const existing = this.get(input.callId)
    if (existing !== undefined) {
      if (
        existing.binding_id !== input.bindingId ||
        existing.operation_id !== input.operationId ||
        existing.prompt_sequence !== input.promptSequence ||
        existing.round_index !== input.roundIndex ||
        existing.profile_digest !== input.profileDigest ||
        existing.request_digest !== input.requestDigest
      ) {
        throw new AgentModelGatewayError(
          'conflict',
          'Stable model call identity conflicts with prior evidence'
        )
      }
      throw new AgentModelGatewayError(
        existing.status === 'outcome-unknown'
          ? 'outcome-unknown'
          : 'already-dispatched',
        'Stable model call was already dispatched'
      )
    }
    const previous = this.#database.prepare(`
      SELECT status, response_delivered
      FROM agent_model_calls
      WHERE binding_id = ? AND operation_id = ?
      ORDER BY round_index DESC LIMIT 1
    `).get(input.bindingId, input.operationId) as
      | { status: string; response_delivered: number }
      | undefined
    if (
      input.roundIndex !== (previous === undefined ? 0 : this.#highestRound(
        input.bindingId,
        input.operationId
      ) + 1) ||
      (previous !== undefined &&
        (previous.status !== 'completed' ||
          previous.response_delivered !== 1))
    ) {
      throw new AgentModelGatewayError(
        'conflict',
        'Model call rounds must be contiguous and delivery-acknowledged'
      )
    }
    const now = Date.now()
    this.#database.prepare(`
      INSERT INTO agent_model_calls (
        call_id, binding_id, operation_id, prompt_sequence, round_index,
        profile_digest, request_digest, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'dispatched', ?, ?)
    `).run(
      input.callId,
      input.bindingId,
      input.operationId,
      input.promptSequence,
      input.roundIndex,
      input.profileDigest,
      input.requestDigest,
      now,
      now
    )
  }

  complete(callId: string): void {
    this.#transition(callId, 'completed', null)
  }

  outcomeUnknown(callId: string, code: string): void {
    this.#transition(callId, 'outcome-unknown', code)
  }

  delivered(callId: string): void {
    this.#assertOpen()
    const result = this.#database.prepare(`
      UPDATE agent_model_calls
      SET response_delivered = 1, updated_at = ?
      WHERE call_id = ? AND status = 'completed'
        AND response_delivered = 0
    `).run(Date.now(), callId)
    if (
      Number(result.changes) !== 1 &&
      this.get(callId)?.response_delivered !== 1
    ) {
      throw new AgentModelGatewayError(
        'conflict',
        'Only a completed model response can be acknowledged'
      )
    }
  }

  get(callId: string): CallRow | undefined {
    this.#assertOpen()
    return this.#database.prepare(`
      SELECT call_id, binding_id, operation_id, prompt_sequence, round_index,
             profile_digest, request_digest, status, response_delivered
      FROM agent_model_calls WHERE call_id = ?
    `).get(callId) as CallRow | undefined
  }

  close(): void {
    if (!this.#closed) {
      this.#database.close()
      this.#closed = true
    }
  }

  #transition(
    callId: string,
    status: 'completed' | 'outcome-unknown',
    code: string | null
  ): void {
    this.#assertOpen()
    const result = this.#database.prepare(`
      UPDATE agent_model_calls
      SET status = ?, terminal_code = ?, updated_at = ?
      WHERE call_id = ? AND status = 'dispatched'
    `).run(status, code, Date.now(), callId)
    const changed = Number(result.changes) === 1
    if (!changed && this.get(callId)?.status !== status) {
      throw new AgentModelGatewayError(
        'conflict',
        'Model call terminal state conflicts with prior evidence'
      )
    }
    if (changed) {
      this.#pruneTerminalCalls(callId)
    }
  }

  #highestRound(bindingId: string, operationId: string): number {
    const row = this.#database.prepare(`
      SELECT MAX(round_index) AS value FROM agent_model_calls
      WHERE binding_id = ? AND operation_id = ?
    `).get(bindingId, operationId) as { value: number }
    return row.value
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new AgentModelGatewayError(
        'conflict',
        'Model call ledger is closed'
      )
    }
  }
}

export type AgentModelGatewayContext = {
  bindingId: string
  operationId: string
  promptSequence: number
  roundIndex: number
  profileDigest: string
  profile: AgentPromptModelProfile
}

export class AgentModelGateway {
  readonly #ledger: AgentModelCallLedger
  readonly #fetch: typeof fetch
  readonly #promptOutputTokens = new Map<string, number>()

  constructor(options: {
    ledger: AgentModelCallLedger
    fetcher?: typeof fetch
  }) {
    this.#ledger = options.ledger
    this.#fetch = options.fetcher ?? fetch
  }

  async dispatch(
    context: AgentModelGatewayContext,
    requestInput: RemoteModelGatewayRequest,
    signal: AbortSignal
  ): Promise<{
    response: RemoteModelGatewayResponse
    acknowledgeDelivery(): Promise<void>
    failDelivery(): void
  }> {
    signal.throwIfAborted()
    const request = remoteModelGatewayRequestSchema.parse(requestInput)
    const promptKey = `${context.bindingId}\0${context.operationId}`
    const usedOutputTokens = this.#promptOutputTokens.get(promptKey) ?? 0
    const remainingOutputTokens =
      context.profile.limits.maximumTotalOutputTokens - usedOutputTokens
    if (remainingOutputTokens < 1) {
      throw new AgentModelGatewayError(
        'policy',
        'Prompt total output token limit is exhausted'
      )
    }
    const reservedOutputTokens = Math.min(
      context.profile.limits.maximumOutputTokens,
      remainingOutputTokens
    )
    const prepared = prepareProviderRequest(
      context.profile,
      request,
      reservedOutputTokens
    )
    const requestDigest = sha256(prepared.canonicalRequest)
    const callId = createAgentModelCallId(context)
    this.#ledger.claim({
      callId,
      bindingId: context.bindingId,
      operationId: context.operationId,
      promptSequence: context.promptSequence,
      roundIndex: context.roundIndex,
      profileDigest: context.profileDigest,
      requestDigest
    })
    const timeout = new AbortController()
    const timer = setTimeout(
      () => timeout.abort(new Error('provider timeout')),
      context.profile.limits.requestTimeoutMilliseconds
    )
    timer.unref?.()
    let response: Response
    try {
      response = await this.#fetch(prepared.url, {
        method: 'POST',
        redirect: 'error',
        headers: prepared.headers,
        body: prepared.body,
        signal: AbortSignal.any([signal, timeout.signal])
      })
    } catch {
      clearTimeout(timer)
      const code = timeout.signal.aborted
        ? 'timeout'
        : signal.aborted
          ? 'cancelled'
          : 'outcome-unknown'
      this.#ledger.outcomeUnknown(callId, code)
      throw new AgentModelGatewayError(
        code,
        'Provider dispatch outcome is unknown'
      )
    }
    let bytes: Uint8Array
    try {
      bytes = await readBoundedResponseBytes(response, {
        maxBytes: REMOTE_MODEL_GATEWAY_LIMITS.maximumResponseBodyBytes,
        tooLargeMessage:
          'Provider response exceeds the configured byte limit',
        truncatedMessage: 'Provider response body was truncated'
      })
    } catch (error) {
      clearTimeout(timer)
      const code =
        error instanceof BoundedResponseTooLargeError
          ? 'response-too-large'
          : 'outcome-unknown'
      this.#ledger.outcomeUnknown(callId, code)
      throw error instanceof AgentModelGatewayError
        ? error
        : new AgentModelGatewayError(
            code,
            error instanceof BoundedResponseTruncatedError
              ? error.message
              : code === 'response-too-large'
                ? (error as Error).message
                : 'Provider response could not be read completely'
          )
    }
    clearTimeout(timer)
    if (signal.aborted || timeout.signal.aborted) {
      const code = timeout.signal.aborted ? 'timeout' : 'cancelled'
      this.#ledger.outcomeUnknown(callId, code)
      throw new AgentModelGatewayError(
        code,
        'Provider response arrived after cancellation'
      )
    }
    const headers: Record<string, string> = {}
    for (const name of RESPONSE_HEADERS) {
      const value = response.headers.get(name)
      if (
        value !== null &&
        Buffer.byteLength(value, 'utf8') <=
          REMOTE_MODEL_GATEWAY_LIMITS.maximumHeaderValueBytes &&
        !/[\r\n]/u.test(value)
      ) {
        headers[name] = value
      }
    }
    const bridgeResponse = remoteModelGatewayResponseSchema.parse({
      status: response.status,
      headers,
      bodyBase64: Buffer.from(bytes).toString('base64')
    })
    this.#promptOutputTokens.set(
      promptKey,
      usedOutputTokens +
        Math.min(
          reservedOutputTokens,
          responseOutputTokens(bytes) ?? reservedOutputTokens
        )
    )
    this.#ledger.complete(callId)
    let finalized = false
    return {
      response: bridgeResponse,
      acknowledgeDelivery: async () => {
        if (finalized) {
          throw new AgentModelGatewayError(
            'conflict',
            'Provider response delivery was already finalized'
          )
        }
        finalized = true
        this.#ledger.delivered(callId)
      },
      failDelivery: () => {
        finalized = true
        // The completed response cannot be reconstructed from the metadata-only
        // ledger, so an unacknowledged handoff is intentionally non-retryable.
      }
    }
  }

  finalizePrompt(bindingId: string, operationId: string): void {
    this.#promptOutputTokens.delete(`${bindingId}\0${operationId}`)
  }
}

export function createAgentModelCallId(
  context: Pick<
    AgentModelGatewayContext,
    'bindingId' | 'operationId' | 'roundIndex'
  >
): string {
  return `model-call-${createHash('sha256')
    .update(
      JSON.stringify({
        bindingId: context.bindingId,
        operationId: context.operationId,
        roundIndex: context.roundIndex
      })
    )
    .digest('hex')}`
}

function prepareProviderRequest(
  profile: AgentPromptModelProfile,
  request: RemoteModelGatewayRequest,
  maximumOutputTokens: number
): {
  url: URL
  headers: Record<string, string>
  body: Uint8Array
  canonicalRequest: string
} {
  if (!pathMatches(profile.protocol, request.path)) {
    throw new AgentModelGatewayError(
      'policy',
      'Provider path does not match the prompt profile'
    )
  }
  const inputBody = Buffer.from(request.bodyBase64, 'base64')
  let json: unknown
  try {
    json = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(inputBody)
    )
  } catch {
    throw new AgentModelGatewayError(
      'policy',
      'Provider request body is not UTF-8 JSON'
    )
  }
  try {
    assertTextModelRequestPolicy(
      {
        protocol: profile.protocol,
        model: profile.model,
        supportsImageInput: profile.capabilities.imageInput
      },
      json
    )
  } catch (error) {
    if (!(error instanceof ModelRequestPolicyError)) {
      throw error
    }
    throw new AgentModelGatewayError(
      'policy',
      'Provider request does not match the prompt profile'
    )
  }
  const normalized = { ...(json as Record<string, unknown>) }
  const outputField =
    profile.protocol === 'openai-responses'
      ? 'max_output_tokens'
      : 'max_tokens'
  const requestedOutput = normalized[outputField]
  if (
    requestedOutput !== undefined &&
    (
      !Number.isSafeInteger(requestedOutput) ||
      (requestedOutput as number) < 1
    )
  ) {
    throw new AgentModelGatewayError(
      'policy',
      'Provider request has an invalid output token limit'
    )
  }
  normalized[outputField] =
    requestedOutput === undefined
      ? maximumOutputTokens
      : Math.min(requestedOutput as number, maximumOutputTokens)
  const body = Buffer.from(JSON.stringify(normalized), 'utf8')
  const url = providerUrl(profile)
  const headers = { ...request.headers }
  if (profile.protocol === 'anthropic-messages') {
    headers['anthropic-version'] = '2023-06-01'
    if (profile.authentication === 'api-key') {
      headers['x-api-key'] = profile.apiKey!
    }
  } else if (profile.authentication === 'api-key') {
    headers.authorization = `Bearer ${profile.apiKey!}`
  }
  return {
    url,
    headers,
    body,
    canonicalRequest: JSON.stringify({
      profileId: profile.profileId,
      provider: profile.provider,
      protocol: profile.protocol,
      model: profile.model,
      url: url.toString(),
      request: {
        path: request.path,
        headers: Object.fromEntries(
          Object.entries(request.headers).sort(([left], [right]) =>
            left.localeCompare(right)
          )
        ),
        bodyBase64: body.toString('base64')
      }
    })
  }
}

function responseOutputTokens(body: Uint8Array): number | undefined {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const usage = (value as { usage?: unknown }).usage
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
    return undefined
  }
  const record = usage as Record<string, unknown>
  const tokens = record.output_tokens ?? record.completion_tokens
  return typeof tokens === 'number' &&
    Number.isSafeInteger(tokens) &&
    tokens >= 0
    ? tokens
    : undefined
}

function providerUrl(profile: AgentPromptModelProfile): URL {
  const url = new URL(profile.baseUrl)
  const path = url.pathname.replace(/\/+$/u, '')
  if (profile.protocol === 'anthropic-messages') {
    url.pathname = `${path.endsWith('/v1') ? path : `${path}/v1`}/messages`
  } else if (profile.protocol === 'openai-chat-completions') {
    url.pathname = `${path}/chat/completions`
  } else {
    url.pathname = `${path}/responses`
  }
  url.hash = ''
  return url
}

function pathMatches(
  protocol: AgentPromptModelProfile['protocol'],
  path: string
): boolean {
  if (protocol === 'anthropic-messages') {
    return path === '/v1/messages'
  }
  if (protocol === 'openai-chat-completions') {
    return path === '/chat/completions' || path === '/v1/chat/completions'
  }
  return path === '/responses' || path === '/v1/responses'
}


function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
