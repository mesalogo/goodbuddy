import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  type Stats,
  unlinkSync
} from 'node:fs'
import {
  createConnection,
  createServer,
  type Server,
  type Socket
} from 'node:net'
import { dirname, join } from 'node:path'
import { TextDecoder } from 'node:util'
import { z } from 'zod'
import {
  REMOTE_MODEL_GATEWAY_LIMITS,
  remoteModelGatewayRequestSchema,
  remoteModelGatewayResponseSchema,
  type RemoteModelGatewayRequest,
  type RemoteModelGatewayResponse
} from '../shared/remote-model-gateway-contracts'
import {
  assertAbsoluteManagedPath,
  ensurePrivateDirectory
} from './managed-paths'
import { AgentUnsupportedError } from './errors'
import {
  boundedInteger,
  closeServer,
  isNodeError,
  raceWithAbort,
  settleWithin
} from './async-utils'

export const MODEL_BRIDGE_BROKER_SOCKET_NAME =
  'model-bridge.sock'

const BROKER_PROTOCOL_VERSION = 1
const DEFAULT_MAXIMUM_CONNECTIONS = 8
const DEFAULT_REQUEST_TIMEOUT_MS = 150_000
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 2_000
const MAXIMUM_UNIX_SOCKET_PATH_BYTES = 107
const MAXIMUM_FRAME_BYTES =
  Math.ceil(
    REMOTE_MODEL_GATEWAY_LIMITS.maximumResponseBodyBytes / 3
  ) *
    4 +
  64 * 1_024

const requestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)

const brokerRequestPacketSchema = z
  .object({
    version: z.literal(BROKER_PROTOCOL_VERSION),
    type: z.literal('model-request'),
    requestId: requestIdSchema,
    request: remoteModelGatewayRequestSchema
  })
  .strict()

const brokerSuccessPacketSchema = z
  .object({
    version: z.literal(BROKER_PROTOCOL_VERSION),
    type: z.literal('model-response'),
    requestId: requestIdSchema,
    ok: z.literal(true),
    response: remoteModelGatewayResponseSchema
  })
  .strict()

const brokerFailureCodeSchema = z.enum([
  'request-invalid',
  'request-timeout',
  'request-cancelled',
  'dispatch-failed'
])

const brokerFailurePacketSchema = z
  .object({
    version: z.literal(BROKER_PROTOCOL_VERSION),
    type: z.literal('model-response'),
    requestId: requestIdSchema,
    ok: z.literal(false),
    error: z
      .object({
        code: brokerFailureCodeSchema
      })
      .strict()
  })
  .strict()

const brokerResponsePacketSchema = z.discriminatedUnion('ok', [
  brokerSuccessPacketSchema,
  brokerFailurePacketSchema
])

const brokerDeliveryPacketSchema = z
  .object({
    version: z.literal(BROKER_PROTOCOL_VERSION),
    type: z.literal('response-delivered'),
    requestId: requestIdSchema
  })
  .strict()

const brokerDeliveryAcceptedPacketSchema = z
  .object({
    version: z.literal(BROKER_PROTOCOL_VERSION),
    type: z.literal('delivery-accepted'),
    requestId: requestIdSchema
  })
  .strict()

export type ModelBridgeDispatchContext = {
  requestId: string
  signal: AbortSignal
}

export type ModelBridgeExchangeResult = {
  response: RemoteModelGatewayResponse
  acknowledgeDelivery(): Promise<void>
  failDelivery(reason?: unknown): void | Promise<void>
}

export type ModelBridgeBrokerDispatch = (
  request: RemoteModelGatewayRequest,
  context: ModelBridgeDispatchContext
) => Promise<ModelBridgeExchangeResult | RemoteModelGatewayResponse>

export type ModelBridgeExchange = (
  request: RemoteModelGatewayRequest,
  context: ModelBridgeDispatchContext
) => Promise<ModelBridgeExchangeResult | RemoteModelGatewayResponse>

export class ModelBridgeBrokerError extends Error {
  readonly code:
    | 'request-invalid'
    | 'request-timeout'
    | 'request-cancelled'
    | 'dispatch-failed'
    | 'transport-failed'

  constructor(code: ModelBridgeBrokerError['code']) {
    super(modelBridgeBrokerErrorMessage(code))
    this.name = 'ModelBridgeBrokerError'
    this.code = code
  }
}

export class ModelBridgeBrokerServer {
  readonly socketPath: string
  readonly #dispatch: ModelBridgeBrokerDispatch
  readonly #maximumConnections: number
  readonly #requestTimeoutMs: number
  readonly #connections = new Set<Socket>()
  #server?: Server
  #socketIdentity?: FileIdentity
  #closing = false
  #closePromise?: Promise<void>

  constructor(options: {
    scratchDirectory: string
    dispatch: ModelBridgeBrokerDispatch
    maximumConnections?: number
    requestTimeoutMs?: number
  }) {
    const scratchDirectory = assertAbsoluteManagedPath(
      options.scratchDirectory
    )
    this.socketPath = assertAbsoluteManagedPath(
      join(scratchDirectory, MODEL_BRIDGE_BROKER_SOCKET_NAME)
    )
    if (
      process.platform !== 'win32' &&
      Buffer.byteLength(this.socketPath, 'utf8') >
        MAXIMUM_UNIX_SOCKET_PATH_BYTES
    ) {
      throw new Error('Model bridge endpoint path is too long')
    }
    this.#dispatch = options.dispatch
    this.#maximumConnections = boundedInteger(
      options.maximumConnections ?? DEFAULT_MAXIMUM_CONNECTIONS,
      1,
      64,
      'Model bridge connection limit'
    )
    this.#requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      1,
      300_000,
      'Model bridge request timeout'
    )
  }

  async listen(): Promise<void> {
    if (process.platform === 'win32') {
      throw new AgentUnsupportedError(
        'Unix model bridge brokers are unavailable on Windows',
        'platform-incompatible'
      )
    }
    if (this.#server !== undefined || this.#closing) {
      throw new Error('Model bridge broker is already active')
    }
    ensurePrivateDirectory(dirname(this.socketPath), {
      create: false
    })
    removeOwnedStaleSocket(this.socketPath)

    const server = createServer(
      { pauseOnConnect: true },
      (socket) => {
        if (
          this.#closing ||
          this.#connections.size >= this.#maximumConnections
        ) {
          socket.destroy()
          return
        }
        this.#connections.add(socket)
        socket.once('close', () => {
          this.#connections.delete(socket)
        })
        void this.#serveOne(socket)
      }
    )
    this.#server = server
    try {
      await listenOnUnixSocket(server, this.socketPath)
      const initialStat = lstatSync(this.socketPath)
      this.#socketIdentity = fileIdentity(initialStat)
      assertOwnedSocket(initialStat, 'Model bridge endpoint')
      chmodSync(this.socketPath, 0o600)
      const securedStat = lstatSync(this.socketPath)
      assertSameFile(securedStat, this.#socketIdentity)
      assertOwnedSocket(securedStat, 'Model bridge endpoint')
      if ((securedStat.mode & 0o777) !== 0o600) {
        throw new Error('Model bridge endpoint mode verification failed')
      }
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
    this.#closing = true
    try {
      for (const connection of this.#connections) {
        connection.destroy()
      }
      await settleWithin(
        server === undefined
          ? Promise.resolve()
          : closeServer(server),
        CLOSE_TIMEOUT_MS
      )
    } finally {
      this.#connections.clear()
      removeSocketIfIdentityMatches(
        this.socketPath,
        this.#socketIdentity
      )
      this.#socketIdentity = undefined
      this.#closing = false
    }
  }

  async #serveOne(socket: Socket): Promise<void> {
    const cancellation = new AbortController()
    const onClose = (): void => {
      cancellation.abort(
        new ModelBridgeBrokerError('request-cancelled')
      )
    }
    socket.once('close', onClose)
    const timeout = setTimeout(() => {
      cancellation.abort(
        new ModelBridgeBrokerError('request-timeout')
      )
    }, this.#requestTimeoutMs)
    timeout.unref?.()

    let requestId = `invalid-${randomUUID()}`
    let dispatched: ModelBridgeExchangeResult | undefined
    let delivered = false
    try {
      const packet = brokerRequestPacketSchema.parse(
        await readPacket(socket, cancellation.signal)
      )
      requestId = packet.requestId
      dispatched = normalizeExchangeResult(await raceWithAbort(
        this.#dispatch(packet.request, {
          requestId,
          signal: cancellation.signal
        }),
        cancellation.signal
      ))
      const response = remoteModelGatewayResponseSchema.parse(
        dispatched.response
      )
      cancellation.signal.throwIfAborted()
      await writePacket(socket, {
        version: BROKER_PROTOCOL_VERSION,
        type: 'model-response',
        requestId,
        ok: true,
        response
      })
      const delivery = brokerDeliveryPacketSchema.parse(
        await readPacket(socket, cancellation.signal)
      )
      if (delivery.requestId !== requestId) {
        throw new ModelBridgeBrokerError('transport-failed')
      }
      await raceWithAbort(
        Promise.resolve(dispatched.acknowledgeDelivery()),
        cancellation.signal
      )
      delivered = true
      await writePacket(socket, {
        version: BROKER_PROTOCOL_VERSION,
        type: 'delivery-accepted',
        requestId
      })
    } catch (error) {
      if (dispatched !== undefined && !delivered) {
        await Promise.resolve(
          dispatched.failDelivery(error)
        ).catch(() => undefined)
      } else if (!socket.destroyed) {
        await writeFailure(
          socket,
          requestId,
          failureCode(error, cancellation.signal)
        ).catch(() => undefined)
      }
    } finally {
      clearTimeout(timeout)
      socket.off('close', onClose)
      if (!socket.destroyed) {
        socket.end()
      }
    }
  }
}

export function createUnixModelBridgeExchange(options: {
  socketPath: string
  connectTimeoutMs?: number
  requestTimeoutMs?: number
}): ModelBridgeExchange {
  const socketPath = assertAbsoluteManagedPath(options.socketPath)
  const connectTimeoutMs = boundedInteger(
    options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    1,
    60_000,
    'Model bridge connect timeout'
  )
  const requestTimeoutMs = boundedInteger(
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    1,
    300_000,
    'Model bridge request timeout'
  )

  return async (request, context) => {
    const parsedRequest = remoteModelGatewayRequestSchema.parse(request)
    const requestId = requestIdSchema.parse(context.requestId)
    context.signal.throwIfAborted()
    const socket = createConnection(socketPath)
    const timeoutController = new AbortController()
    const timeout = setTimeout(() => {
      timeoutController.abort(
        new ModelBridgeBrokerError('request-timeout')
      )
      socket.destroy()
    }, requestTimeoutMs)
    timeout.unref?.()
    const onAbort = (): void => {
      socket.destroy()
    }
    context.signal.addEventListener('abort', onAbort, { once: true })
    let responseHandedOff = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      context.signal.removeEventListener('abort', onAbort)
      socket.destroy()
    }
    try {
      await waitForConnection(
        socket,
        Math.min(connectTimeoutMs, requestTimeoutMs),
        context.signal
      )
      await writePacket(socket, {
        version: BROKER_PROTOCOL_VERSION,
        type: 'model-request',
        requestId,
        request: parsedRequest
      })
      const packet = brokerResponsePacketSchema.parse(
        await readPacket(
          socket,
          AbortSignal.any([
            context.signal,
            timeoutController.signal
          ])
        )
      )
      if (packet.requestId !== requestId) {
        throw new ModelBridgeBrokerError('transport-failed')
      }
      if (!packet.ok) {
        throw new ModelBridgeBrokerError(packet.error.code)
      }
      responseHandedOff = true
      let deliveryFinalized = false
      return {
        response: packet.response,
        acknowledgeDelivery: async () => {
          if (deliveryFinalized) {
            throw new ModelBridgeBrokerError('transport-failed')
          }
          deliveryFinalized = true
          await writePacket(socket, {
            version: BROKER_PROTOCOL_VERSION,
            type: 'response-delivered',
            requestId
          })
          const accepted = brokerDeliveryAcceptedPacketSchema.parse(
            await readPacket(
              socket,
              AbortSignal.any([
                context.signal,
                timeoutController.signal
              ])
            )
          )
          if (accepted.requestId !== requestId) {
            throw new ModelBridgeBrokerError('transport-failed')
          }
          cleanup()
        },
        failDelivery: () => {
          deliveryFinalized = true
          cleanup()
        }
      }
    } catch (error) {
      if (context.signal.aborted) {
        throw new ModelBridgeBrokerError('request-cancelled')
      }
      if (timeoutController.signal.aborted) {
        throw new ModelBridgeBrokerError('request-timeout')
      }
      if (error instanceof ModelBridgeBrokerError) {
        throw error
      }
      throw new ModelBridgeBrokerError('transport-failed')
    } finally {
      if (!responseHandedOff) {
        cleanup()
      }
    }
  }
}

type BrokerFailureCode = z.infer<
  typeof brokerFailureCodeSchema
>

type FileIdentity = {
  dev: bigint
  ino: bigint
}

function failureCode(
  error: unknown,
  signal: AbortSignal
): BrokerFailureCode {
  const reason = signal.reason
  if (
    signal.aborted &&
    reason instanceof ModelBridgeBrokerError &&
    reason.code === 'request-timeout'
  ) {
    return 'request-timeout'
  }
  if (signal.aborted) {
    return 'request-cancelled'
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return 'request-invalid'
  }
  return 'dispatch-failed'
}

async function writeFailure(
  socket: Socket,
  requestId: string,
  code: BrokerFailureCode
): Promise<void> {
  await writePacket(socket, {
    version: BROKER_PROTOCOL_VERSION,
    type: 'model-response',
    requestId,
    ok: false,
    error: { code }
  })
}

async function readPacket(
  socket: Socket,
  signal: AbortSignal
): Promise<unknown> {
  const lengthBytes = await readExactly(socket, 4, signal)
  const length = lengthBytes.readUInt32BE(0)
  if (length < 2 || length > MAXIMUM_FRAME_BYTES) {
    throw new ModelBridgeBrokerError('request-invalid')
  }
  const contents = await readExactly(socket, length, signal)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(
    contents
  )
  return JSON.parse(text) as unknown
}

async function writePacket(
  socket: Socket,
  value: unknown
): Promise<void> {
  const contents = Buffer.from(JSON.stringify(value), 'utf8')
  if (
    contents.byteLength < 2 ||
    contents.byteLength > MAXIMUM_FRAME_BYTES
  ) {
    throw new ModelBridgeBrokerError('request-invalid')
  }
  const packet = Buffer.allocUnsafe(contents.byteLength + 4)
  packet.writeUInt32BE(contents.byteLength, 0)
  contents.copy(packet, 4)
  await new Promise<void>((resolve, reject) => {
    socket.write(packet, (error) => {
      if (error === undefined || error === null) {
        resolve()
      } else {
        reject(error)
      }
    })
  })
}

async function readExactly(
  socket: Socket,
  byteLength: number,
  signal: AbortSignal
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let remaining = byteLength
  while (remaining > 0) {
    signal.throwIfAborted()
    const chunk = socket.read(remaining) as Buffer | null
    if (chunk !== null) {
      chunks.push(chunk)
      remaining -= chunk.byteLength
      continue
    }
    await new Promise<void>((resolve, reject) => {
      const onReadable = (): void => {
        cleanup()
        resolve()
      }
      const onClose = (): void => {
        cleanup()
        reject(new ModelBridgeBrokerError('transport-failed'))
      }
      const onError = (): void => {
        cleanup()
        reject(new ModelBridgeBrokerError('transport-failed'))
      }
      const onAbort = (): void => {
        cleanup()
        reject(signal.reason)
      }
      const cleanup = (): void => {
        socket.off('readable', onReadable)
        socket.off('close', onClose)
        socket.off('end', onClose)
        socket.off('error', onError)
        signal.removeEventListener('abort', onAbort)
      }
      socket.once('readable', onReadable)
      socket.once('close', onClose)
      socket.once('end', onClose)
      socket.once('error', onError)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
  return Buffer.concat(chunks, byteLength)
}

async function waitForConnection(
  socket: Socket,
  timeoutMs: number,
  signal: AbortSignal
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  await new Promise<void>((resolve, reject) => {
    const onConnect = (): void => {
      cleanup()
      resolve()
    }
    const onError = (): void => {
      cleanup()
      reject(new ModelBridgeBrokerError('transport-failed'))
    }
    const onAbort = (): void => {
      cleanup()
      reject(new ModelBridgeBrokerError('request-cancelled'))
    }
    const cleanup = (): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout)
      }
      socket.off('connect', onConnect)
      socket.off('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    timeout = setTimeout(() => {
      cleanup()
      reject(new ModelBridgeBrokerError('request-timeout'))
    }, timeoutMs)
    timeout.unref?.()
    socket.once('connect', onConnect)
    socket.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function listenOnUnixSocket(
  server: Server,
  socketPath: string
): Promise<void> {
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
    server.listen(socketPath)
  })
}

function removeOwnedStaleSocket(path: string): void {
  let stat: Stats
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return
    }
    throw error
  }
  assertOwnedSocket(stat, 'Existing model bridge endpoint')
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error(
      'Refusing to replace an insecure model bridge endpoint'
    )
  }
  unlinkSync(path)
}

function removeSocketIfIdentityMatches(
  path: string,
  identity: FileIdentity | undefined
): void {
  if (identity === undefined) {
    return
  }
  let stat: Stats
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return
    }
    throw error
  }
  if (
    stat.isSocket() &&
    isOwnedByCurrentUser(stat) &&
    sameFile(stat, identity)
  ) {
    unlinkSync(path)
  }
}

function assertOwnedSocket(stat: Stats, label: string): void {
  if (
    stat.isSymbolicLink() ||
    !stat.isSocket() ||
    !isOwnedByCurrentUser(stat)
  ) {
    throw new Error(`${label} is not an owned Unix socket`)
  }
}

function assertSameFile(
  stat: Stats,
  identity: FileIdentity
): void {
  if (!sameFile(stat, identity)) {
    throw new Error('Model bridge endpoint changed during setup')
  }
}

function sameFile(stat: Stats, identity: FileIdentity): boolean {
  return (
    BigInt(stat.dev) === identity.dev &&
    BigInt(stat.ino) === identity.ino
  )
}

function fileIdentity(stat: Stats): FileIdentity {
  return {
    dev: BigInt(stat.dev),
    ino: BigInt(stat.ino)
  }
}

function isOwnedByCurrentUser(stat: Stats): boolean {
  const uid = process.getuid?.()
  return uid === undefined || stat.uid === uid
}


function modelBridgeBrokerErrorMessage(
  code: ModelBridgeBrokerError['code']
): string {
  switch (code) {
    case 'request-invalid':
      return 'Model bridge request was rejected'
    case 'request-timeout':
      return 'Model bridge request timed out'
    case 'request-cancelled':
      return 'Model bridge request was cancelled'
    case 'dispatch-failed':
      return 'Model bridge dispatch failed'
    case 'transport-failed':
      return 'Model bridge transport failed'
  }
}

function normalizeExchangeResult(
  value: ModelBridgeExchangeResult | RemoteModelGatewayResponse
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
