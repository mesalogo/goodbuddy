import { randomUUID } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import type { Socket } from 'node:net'
import { isAbsolute, resolve } from 'node:path'
import type {
  ModelBridgeModelProtocol
} from '../shared/model-bridge-contracts'
import {
  REMOTE_MODEL_GATEWAY_LIMITS,
  remoteModelApiPathSchema,
  remoteModelGatewayRequestSchema,
  remoteModelGatewayResponseSchema,
  type RemoteModelGatewayRequest
} from '../shared/remote-model-gateway-contracts'
import {
  createUnixModelBridgeExchange,
  ModelBridgeBrokerError,
  type ModelBridgeExchange,
  type ModelBridgeExchangeResult
} from './model-bridge-broker'
import {
  boundedInteger,
  closeServer,
  raceWithAbort,
  settleWithin
} from './async-utils'

export type ModelBridgeProtocol = ModelBridgeModelProtocol

// The Anthropic and OpenAI SDK adapters refuse to issue a request without an
// apiKey option. This fixed value is only a local compatibility marker. The
// loopback proxy verifies and removes its header before creating the wire
// request, so it is neither a credential nor visible outside the sandbox.
export const MODEL_BRIDGE_SDK_AUTH_SENTINEL =
  'goodbuddy-local-model-bridge-v1'

export type OpenCodeModelBridgeProviderConfig = {
  model: string
  provider: Record<
    string,
    {
      name: string
      npm:
        | '@ai-sdk/anthropic'
        | '@ai-sdk/openai-compatible'
        | '@ai-sdk/openai'
      options: {
        baseURL: string
        apiKey?: typeof MODEL_BRIDGE_SDK_AUTH_SENTINEL
      }
      models: Record<
        string,
        {
          name: string
          attachment: boolean
          modalities: {
            input: Array<'text' | 'image'>
            output: ['text']
          }
          provider: {
            npm:
              | '@ai-sdk/anthropic'
              | '@ai-sdk/openai-compatible'
              | '@ai-sdk/openai'
          }
        }
      >
    }
  >
}

export type ModelBridgeHelperChild = {
  once(event: 'error', listener: (error: Error) => void): unknown
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown
}

export type ModelBridgeHelperSpawn = (
  executable: string,
  args: readonly string[],
  options: {
    shell: false
    stdio: 'inherit'
    env: Readonly<NodeJS.ProcessEnv>
  }
) => ModelBridgeHelperChild

const LOOPBACK_HOST = '127.0.0.1'
const DEFAULT_MAXIMUM_CONNECTIONS = 8
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000
const RESPONSE_CLOSE_TIMEOUT_MS = 2_000
const MAXIMUM_HTTP_HEADER_BYTES = 16 * 1024
const MAXIMUM_HTTP_HEADER_COUNT = 32
const CREDENTIAL_INBOUND_HEADER_NAMES = new Set([
  'api-key',
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-goog-api-key'
])
const FORWARDED_HEADER_NAMES = [
  'accept',
  'content-type'
] as const

export class ModelBridgeLoopbackProxy {
  readonly #exchange: ModelBridgeExchange
  readonly #maximumConnections: number
  readonly #requestTimeoutMs: number
  readonly #sockets = new Set<Socket>()
  readonly #dispatchWaiters: DispatchWaiter[] = []
  #server?: Server
  #origin?: string
  #dispatchBusy = false
  #closing = false
  #closePromise?: Promise<void>

  constructor(options: {
    exchange: ModelBridgeExchange
    maximumConnections?: number
    requestTimeoutMs?: number
  }) {
    this.#exchange = options.exchange
    this.#maximumConnections = boundedInteger(
      options.maximumConnections ?? DEFAULT_MAXIMUM_CONNECTIONS,
      1,
      64,
      'Model bridge loopback connection limit'
    )
    this.#requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      1,
      300_000,
      'Model bridge loopback request timeout'
    )
  }

  get origin(): string {
    if (this.#origin === undefined) {
      throw new Error('Model bridge loopback proxy is not listening')
    }
    return this.#origin
  }

  async listen(): Promise<string> {
    if (this.#server !== undefined || this.#closing) {
      throw new Error('Model bridge loopback proxy is already active')
    }
    const server = createServer(
      {
        maxHeaderSize: MAXIMUM_HTTP_HEADER_BYTES,
        requireHostHeader: true
      },
      (request, response) => {
        void this.#handleRequest(request, response)
      }
    )
    server.maxConnections = this.#maximumConnections
    server.maxHeadersCount = MAXIMUM_HTTP_HEADER_COUNT
    server.maxRequestsPerSocket = 1
    server.requestTimeout = this.#requestTimeoutMs
    server.headersTimeout = Math.min(
      this.#requestTimeoutMs,
      30_000
    )
    server.keepAliveTimeout = 1_000
    server.on('connection', (socket) => {
      if (
        this.#closing ||
        this.#sockets.size >= this.#maximumConnections
      ) {
        socket.destroy()
        return
      }
      this.#sockets.add(socket)
      socket.once('close', () => this.#sockets.delete(socket))
    })
    this.#server = server
    try {
      await listenOnLoopback(server)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error(
          'Model bridge loopback address is unavailable'
        )
      }
      this.#origin = `http://${LOOPBACK_HOST}:${address.port}`
      return this.#origin
    } catch (error) {
      await this.close()
      throw error
    }
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      await this.#closePromise
      return
    }
    const closePromise = this.#close()
    this.#closePromise = closePromise
    try {
      await closePromise
    } finally {
      if (this.#closePromise === closePromise) {
        this.#closePromise = undefined
      }
    }
  }

  async #close(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    this.#origin = undefined
    this.#closing = true
    try {
      for (const socket of this.#sockets) {
        socket.destroy()
      }
      await settleWithin(
        server === undefined
          ? Promise.resolve()
          : closeServer(server),
        RESPONSE_CLOSE_TIMEOUT_MS
      )
    } finally {
      this.#sockets.clear()
      this.#closing = false
    }
  }

  async #handleRequest(
    incoming: IncomingMessage,
    outgoing: ServerResponse
  ): Promise<void> {
    outgoing.setHeader('connection', 'close')
    outgoing.setHeader('cache-control', 'no-store')
    outgoing.setHeader('x-content-type-options', 'nosniff')
    if (this.#closing) {
      incoming.resume()
      sendError(outgoing, 503, 'bridge-closing')
      return
    }
    const cancellation = new AbortController()
    let dispatched: ModelBridgeExchangeResult | undefined
    let responseFlushed = false
    let deliveryAcknowledged = false
    let dispatchHeld = false
    const onAborted = (): void => {
      cancellation.abort(
        new ModelBridgeBrokerError('request-cancelled')
      )
    }
    const onResponseClose = (): void => {
      if (!responseFlushed && !outgoing.writableFinished) {
        onAborted()
        void dispatched?.failDelivery(
          new ModelBridgeBrokerError('transport-failed')
        )
      }
    }
    incoming.once('aborted', onAborted)
    outgoing.once('close', onResponseClose)
    const timeout = setTimeout(() => {
      cancellation.abort(
        new ModelBridgeBrokerError('request-timeout')
      )
    }, this.#requestTimeoutMs)
    timeout.unref?.()

    try {
      const request = await parseHttpRequest(incoming)
      await this.#acquireDispatch(cancellation.signal)
      dispatchHeld = true
      dispatched = normalizeExchangeResult(
        await raceWithAbort(this.#exchange(request, {
          requestId: `model-${randomUUID()}`,
          signal: cancellation.signal
        }), cancellation.signal)
      )
      const parsedResponse =
        remoteModelGatewayResponseSchema.parse(dispatched.response)
      if (!outgoing.headersSent && !outgoing.destroyed) {
        outgoing.statusCode = parsedResponse.status
        for (const [name, value] of Object.entries(
          parsedResponse.headers
        )) {
          outgoing.setHeader(name, value)
        }
        const body = Buffer.from(
          parsedResponse.bodyBase64,
          'base64'
        )
        outgoing.setHeader('content-length', body.byteLength)
        await endResponseFlushed(outgoing, body, () => {
          responseFlushed = true
        })
        cancellation.signal.throwIfAborted()
        await dispatched.acknowledgeDelivery()
        deliveryAcknowledged = true
      }
    } catch (error) {
      if (dispatched !== undefined && !deliveryAcknowledged) {
        await Promise.resolve(
          dispatched.failDelivery(error)
        ).catch(() => undefined)
      }
      if (!outgoing.headersSent && !outgoing.destroyed) {
        const failure = httpFailure(error, cancellation.signal)
        sendError(outgoing, failure.status, failure.code)
      }
    } finally {
      clearTimeout(timeout)
      incoming.off('aborted', onAborted)
      outgoing.off('close', onResponseClose)
      if (dispatchHeld) {
        this.#releaseDispatch()
      }
    }
  }

  async #acquireDispatch(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (!this.#dispatchBusy) {
      this.#dispatchBusy = true
      return
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: DispatchWaiter = { resolve, reject, signal }
      waiter.abort = (): void => {
        const index = this.#dispatchWaiters.indexOf(waiter)
        if (index >= 0) {
          this.#dispatchWaiters.splice(index, 1)
        }
        reject(signal.reason)
      }
      signal.addEventListener('abort', waiter.abort, { once: true })
      this.#dispatchWaiters.push(waiter)
    })
  }

  #releaseDispatch(): void {
    while (this.#dispatchWaiters.length > 0) {
      const waiter = this.#dispatchWaiters.shift()!
      if (waiter.abort !== undefined) {
        waiter.signal.removeEventListener('abort', waiter.abort)
      }
      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason)
        continue
      }
      waiter.resolve()
      return
    }
    this.#dispatchBusy = false
  }
}

export async function runOpenCodeModelBridgeHelper(options: {
  socketPath: string
  protocol: ModelBridgeProtocol
  model: string
  supportsImageInput: boolean
  opencodeEntrypoint: string
  environment?: Readonly<NodeJS.ProcessEnv>
  spawn?: ModelBridgeHelperSpawn
}): Promise<number> {
  const socketPath = normalizedAbsolutePath(
    options.socketPath,
    'Model bridge socket'
  )
  const opencodeEntrypoint = normalizedAbsolutePath(
    options.opencodeEntrypoint,
    'OpenCode entrypoint'
  )
  const exchange = createUnixModelBridgeExchange({ socketPath })
  const proxy = new ModelBridgeLoopbackProxy({ exchange })
  const origin = await proxy.listen()
  try {
    const config = createOpenCodeModelBridgeProviderConfig({
      protocol: options.protocol,
      model: options.model,
      loopbackOrigin: origin,
      supportsImageInput: options.supportsImageInput
    })
    const environment = credentialFreeHelperEnvironment(
      options.environment ?? process.env,
      JSON.stringify(config)
    )
    const child = (options.spawn ?? defaultHelperSpawn)(
      opencodeEntrypoint,
      ['acp'],
      {
        shell: false,
        stdio: 'inherit',
        env: environment
      }
    )
    return await new Promise<number>((resolveExit, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (signal !== null) {
          resolveExit(128)
          return
        }
        resolveExit(code ?? 1)
      })
    })
  } finally {
    await proxy.close()
  }
}

function endResponseFlushed(
  response: ServerResponse,
  body: Uint8Array,
  onFlushed: () => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onFinish = (): void => {
      cleanup()
      onFlushed()
      resolve()
    }
    const onClose = (): void => {
      if (response.writableFinished) {
        onFinish()
        return
      }
      cleanup()
      reject(new ModelBridgeBrokerError('transport-failed'))
    }
    const onError = (): void => {
      cleanup()
      reject(new ModelBridgeBrokerError('transport-failed'))
    }
    const cleanup = (): void => {
      response.off('finish', onFinish)
      response.off('close', onClose)
      response.off('error', onError)
    }
    response.once('finish', onFinish)
    response.once('close', onClose)
    response.once('error', onError)
    response.end(body)
  })
}

type DispatchWaiter = {
  resolve: () => void
  reject: (error: unknown) => void
  signal: AbortSignal
  abort?: () => void
}

export function createOpenCodeModelBridgeProviderConfig(input: {
  protocol: ModelBridgeProtocol
  model: string
  loopbackOrigin: string
  name?: string
  supportsImageInput?: boolean
}): OpenCodeModelBridgeProviderConfig {
  const model = boundedMetadataText(input.model, 'Model name')
  const name = boundedMetadataText(
    input.name ?? 'GoodBuddy Model Bridge',
    'Provider name'
  )
  const origin = parseLoopbackOrigin(input.loopbackOrigin)
  const descriptor = providerDescriptor(input.protocol)
  const npm = descriptor.npm
  const providerId = descriptor.id
  const baseURL = `${origin}/v1`
  return {
    model: `${providerId}/${model}`,
    provider: {
      [providerId]: {
        name,
        npm,
        options: {
          baseURL,
          ...(descriptor.requiresSdkAuthSentinel
            ? { apiKey: MODEL_BRIDGE_SDK_AUTH_SENTINEL }
            : {})
        },
        models: {
          [model]: {
            name,
            attachment: input.supportsImageInput === true,
            modalities: {
              input:
                input.supportsImageInput === true
                  ? ['text', 'image']
                  : ['text'],
              output: ['text']
            },
            provider: { npm }
          }
        }
      }
    }
  }
}

async function parseHttpRequest(
  incoming: IncomingMessage
): Promise<RemoteModelGatewayRequest> {
  if (incoming.method !== 'POST') {
    throw new HttpRequestError(405, 'method-not-allowed')
  }
  const path = remoteModelApiPathSchema.safeParse(incoming.url)
  if (!path.success) {
    throw new HttpRequestError(404, 'path-not-allowed')
  }
  validateInboundHeaders(
    incoming.headers,
    incoming.rawHeaders,
    path.data
  )
  const declaredLength = parseContentLength(
    incoming.headers['content-length']
  )
  if (declaredLength === undefined) {
    throw new HttpRequestError(411, 'content-length-required')
  }
  if (
    declaredLength !== undefined &&
    declaredLength >
      REMOTE_MODEL_GATEWAY_LIMITS.maximumRequestBodyBytes
  ) {
    incoming.resume()
    throw new HttpRequestError(413, 'request-too-large')
  }
  const body = await readBoundedBody(incoming)
  if (
    declaredLength !== undefined &&
    body.byteLength !== declaredLength
  ) {
    throw new HttpRequestError(400, 'request-invalid')
  }
  const headers: Record<string, string> = {}
  for (const name of FORWARDED_HEADER_NAMES) {
    const value = incoming.headers[name]
    if (typeof value === 'string') {
      headers[name] = value
    }
  }
  const parsed = remoteModelGatewayRequestSchema.safeParse({
    method: 'POST',
    path: path.data,
    headers,
    bodyBase64: body.toString('base64')
  })
  if (!parsed.success) {
    throw new HttpRequestError(400, 'request-invalid')
  }
  return parsed.data
}

function validateInboundHeaders(
  headers: IncomingHttpHeaders,
  rawHeaders: readonly string[],
  path: RemoteModelGatewayRequest['path']
): void {
  const entries = Object.entries(headers)
  if (entries.length > MAXIMUM_HTTP_HEADER_COUNT) {
    throw new HttpRequestError(431, 'headers-rejected')
  }
  const securityCriticalNames = new Set([
    'accept',
    'connection',
    'content-length',
    'content-type',
    'host',
    'transfer-encoding',
    ...CREDENTIAL_INBOUND_HEADER_NAMES
  ])
  const seen = new Set<string>()
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]?.toLowerCase()
    if (
      name !== undefined &&
      securityCriticalNames.has(name) &&
      seen.has(name)
    ) {
      throw new HttpRequestError(400, 'headers-rejected')
    }
    if (name !== undefined) {
      seen.add(name)
    }
  }
  for (const [name, value] of entries) {
    if (
      !/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(name) ||
      Array.isArray(value) ||
      (CREDENTIAL_INBOUND_HEADER_NAMES.has(name) &&
        !isExpectedSdkAuthenticationHeader(path, name, value))
    ) {
      throw new HttpRequestError(400, 'headers-rejected')
    }
    if (
      value !== undefined &&
      (value.length >
        REMOTE_MODEL_GATEWAY_LIMITS.maximumHeaderValueBytes ||
        /[\r\n]/u.test(value))
    ) {
      throw new HttpRequestError(431, 'headers-rejected')
    }
    if (name === 'transfer-encoding' && value !== undefined) {
      throw new HttpRequestError(400, 'headers-rejected')
    }
  }
}

function isExpectedSdkAuthenticationHeader(
  path: RemoteModelGatewayRequest['path'],
  name: string,
  value: string | undefined
): boolean {
  if (path === '/v1/messages') {
    return (
      name === 'x-api-key' &&
      value === MODEL_BRIDGE_SDK_AUTH_SENTINEL
    )
  }
  if (path === '/responses' || path === '/v1/responses') {
    return (
      name === 'authorization' &&
      value === `Bearer ${MODEL_BRIDGE_SDK_AUTH_SENTINEL}`
    )
  }
  return false
}

function parseContentLength(
  value: string | undefined
): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new HttpRequestError(400, 'request-invalid')
  }
  const length = Number(value)
  if (!Number.isSafeInteger(length)) {
    throw new HttpRequestError(413, 'request-too-large')
  }
  return length
}

async function readBoundedBody(
  incoming: IncomingMessage
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const untrustedChunk of incoming) {
    const chunk = Buffer.isBuffer(untrustedChunk)
      ? untrustedChunk
      : Buffer.from(untrustedChunk as Uint8Array)
    total += chunk.byteLength
    if (
      total >
      REMOTE_MODEL_GATEWAY_LIMITS.maximumRequestBodyBytes
    ) {
      throw new HttpRequestError(413, 'request-too-large')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total)
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string
): void {
  const body = Buffer.from(JSON.stringify({ error: { code } }), 'utf8')
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.setHeader('content-length', body.byteLength)
  response.end(body)
}

function httpFailure(
  error: unknown,
  signal: AbortSignal
): { status: number; code: string } {
  if (error instanceof HttpRequestError) {
    return { status: error.status, code: error.code }
  }
  const reason = signal.reason
  if (
    (signal.aborted &&
      reason instanceof ModelBridgeBrokerError &&
      reason.code === 'request-timeout') ||
    (error instanceof ModelBridgeBrokerError &&
      error.code === 'request-timeout')
  ) {
    return { status: 504, code: 'bridge-timeout' }
  }
  if (
    signal.aborted ||
    (error instanceof ModelBridgeBrokerError &&
      error.code === 'request-cancelled')
  ) {
    return { status: 499, code: 'request-cancelled' }
  }
  return { status: 502, code: 'bridge-failed' }
}

function providerDescriptor(protocol: ModelBridgeProtocol): {
  id: string
  npm:
    | '@ai-sdk/anthropic'
    | '@ai-sdk/openai-compatible'
    | '@ai-sdk/openai'
  requiresSdkAuthSentinel: boolean
} {
  switch (protocol) {
    case 'anthropic-messages':
      return {
        id: 'goodbuddy-anthropic',
        npm: '@ai-sdk/anthropic',
        requiresSdkAuthSentinel: true
      }
    case 'openai-chat-completions':
      return {
        id: 'goodbuddy-openai-chat',
        npm: '@ai-sdk/openai-compatible',
        requiresSdkAuthSentinel: false
      }
    case 'openai-responses':
      return {
        id: 'goodbuddy-openai-responses',
        npm: '@ai-sdk/openai',
        requiresSdkAuthSentinel: true
      }
  }
}

function normalizeExchangeResult(
  value: Awaited<ReturnType<ModelBridgeExchange>>
): ModelBridgeExchangeResult {
  if (
    value !== null &&
    typeof value === 'object' &&
    'response' in value &&
    typeof value.acknowledgeDelivery === 'function' &&
    typeof value.failDelivery === 'function'
  ) {
    return value
  }
  return {
    response: remoteModelGatewayResponseSchema.parse(value),
    acknowledgeDelivery: async () => undefined,
    failDelivery: () => undefined
  }
}

function defaultHelperSpawn(
  executable: string,
  args: readonly string[],
  options: {
    shell: false
    stdio: 'inherit'
    env: Readonly<NodeJS.ProcessEnv>
  }
): ModelBridgeHelperChild {
  return nodeSpawn(executable, [...args], {
    shell: options.shell,
    stdio: options.stdio,
    env: options.env
  })
}

function credentialFreeHelperEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
  config: string
): Readonly<NodeJS.ProcessEnv> {
  const allowed = [
    'HOME',
    'LANG',
    'LC_ALL',
    'PATH',
    'TMPDIR',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME'
  ] as const
  const environment: NodeJS.ProcessEnv = {
    OPENCODE_CONFIG_CONTENT: config
  }
  for (const name of allowed) {
    const value = source[name]
    if (
      value === undefined ||
      value.includes('\0') ||
      /(?:key|secret|token|authorization)/iu.test(name)
    ) {
      throw new Error(`Fixed helper environment is missing ${name}`)
    }
    environment[name] = value
  }
  return environment
}

function normalizedAbsolutePath(value: string, label: string): string {
  if (
    value.includes('\0') ||
    !isAbsolute(value) ||
    resolve(value) !== value
  ) {
    throw new Error(`${label} must be a normalized absolute path`)
  }
  return value
}

function parseLoopbackOrigin(input: string): string {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error('Model bridge origin is invalid')
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== LOOPBACK_HOST ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.port === ''
  ) {
    throw new Error('Model bridge origin must be loopback HTTP')
  }
  return url.origin
}

function boundedMetadataText(
  value: string,
  label: string
): string {
  if (
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > 512 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function listenOnLoopback(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onListening = (): void => {
      cleanup()
      resolve()
    }
    const cleanup = (): void => {
      server.off('error', onError)
      server.off('listening', onListening)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({
      host: LOOPBACK_HOST,
      port: 0,
      exclusive: true
    })
  })
}


class HttpRequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super('Model bridge HTTP request was rejected')
    this.name = 'HttpRequestError'
    this.status = status
    this.code = code
  }
}
