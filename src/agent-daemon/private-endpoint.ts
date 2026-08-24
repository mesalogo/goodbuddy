import {
  chmodSync,
  lstatSync
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import {
  createConnection,
  createServer,
  type Server,
  type Socket
} from 'node:net'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
  agentIdentifierSchema,
  attachPrefaceSchema,
  attachWelcomeSchema,
  protocolVersionSchema,
  sha256DigestSchema,
  type AttachPreface,
  type AttachWelcome
} from '../shared/agent-protocol'
import { ControllerRegistry, type ControllerLease } from './controller-registry'
import {
  InstallationChallengeVerifier
} from './installation-challenge'
import {
  assertAbsoluteManagedPath,
  ensurePrivateDirectory
} from './managed-paths'
import { AgentUnsupportedError } from './errors'
import { closeServer, settleWithin } from './async-utils'

const MAXIMUM_HANDSHAKE_BYTES = 4096
const DEFAULT_MAXIMUM_CONNECTIONS = 64
const ENDPOINT_CLOSE_TIMEOUT_MS = 2_000

const challengePacketSchema = z
  .object({
    type: z.literal('challenge'),
    version: z.literal(1),
    serverNonce: agentIdentifierSchema,
    expiresAt: z.number().int().safe().nonnegative()
  })
  .strict()

const challengeResponsePacketSchema = z
  .object({
    type: z.literal('response'),
    version: z.literal(1),
    controllerId: agentIdentifierSchema,
    clientNonce: agentIdentifierSchema,
    protocol: protocolVersionSchema,
    response: agentIdentifierSchema
  })
  .strict()

export type PeerIdentity = {
  uid: number
  pid?: number
}

export interface UnixPeerIdentityProvider {
  getPeerIdentity(socket: Socket): Promise<PeerIdentity>
}

export type AuthenticatedAttach = {
  socket: Socket
  controller: ControllerLease
  peer: PeerIdentity
}

export class PrivateEndpoint {
  readonly #socketPath: string
  readonly #peerIdentity: UnixPeerIdentityProvider
  readonly #challenge: InstallationChallengeVerifier
  readonly #controllers: ControllerRegistry
  readonly #onAttach: (attach: AuthenticatedAttach) => void | Promise<void>
  readonly #installationId: string
  readonly #binaryDigest: string
  readonly #daemonBootId: string
  readonly #protocol: AttachPreface['protocol']
  readonly #maximumConnections: number
  readonly #sockets = new Set<Socket>()
  #server?: Server
  #closing = false
  #closePromise?: Promise<void>

  constructor(options: {
    socketPath: string
    peerIdentity: UnixPeerIdentityProvider
    challenge: InstallationChallengeVerifier
    controllers: ControllerRegistry
    onAttach: (attach: AuthenticatedAttach) => void | Promise<void>
    installationId: string
    binaryDigest: string
    daemonBootId: string
    protocol: AttachPreface['protocol']
    maximumConnections?: number
  }) {
    this.#socketPath = assertAbsoluteManagedPath(options.socketPath)
    this.#peerIdentity = options.peerIdentity
    this.#challenge = options.challenge
    this.#controllers = options.controllers
    this.#onAttach = options.onAttach
    this.#installationId = agentIdentifierSchema.parse(options.installationId)
    this.#binaryDigest = sha256DigestSchema.parse(options.binaryDigest)
    this.#daemonBootId = agentIdentifierSchema.parse(options.daemonBootId)
    this.#protocol = protocolVersionSchema.parse(options.protocol)
    this.#maximumConnections =
      options.maximumConnections ?? DEFAULT_MAXIMUM_CONNECTIONS
    if (
      !Number.isSafeInteger(this.#maximumConnections) ||
      this.#maximumConnections < 1 ||
      this.#maximumConnections > 1024
    ) {
      throw new RangeError('Invalid private endpoint connection limit')
    }
  }

  async listen(): Promise<void> {
    if (process.platform === 'win32') {
      throw new AgentUnsupportedError(
        'Unix private endpoints are unavailable on Windows',
        'platform-incompatible'
      )
    }
    ensurePrivateDirectory(dirname(this.#socketPath), { create: false })
    if (this.#server !== undefined || this.#closing) {
      throw new Error('Private endpoint is already active')
    }
    this.#server = createServer((socket) => {
      if (
        this.#closing ||
        this.#sockets.size >= this.#maximumConnections
      ) {
        socket.destroy()
        return
      }
      this.#sockets.add(socket)
      socket.once('close', () => {
        this.#sockets.delete(socket)
      })
      void this.#authenticate(socket).catch(() => socket.destroy())
    })
    await new Promise<void>((resolve, reject) => {
      const server = this.#server
      if (server === undefined) {
        reject(new Error('Endpoint server was not created'))
        return
      }
      server.once('error', reject)
      server.listen(this.#socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    chmodSync(this.#socketPath, 0o600)
    const stat = lstatSync(this.#socketPath, { bigint: true })
    if (!stat.isSocket() || (stat.mode & 0o177n) !== 0n) {
      await this.close()
      throw new Error('Private endpoint mode verification failed')
    }
    const uid = process.getuid?.()
    if (uid !== undefined && stat.uid !== BigInt(uid)) {
      await this.close()
      throw new Error('Private endpoint owner verification failed')
    }
  }

  async close(): Promise<void> {
    const activeClose = this.#closePromise
    if (activeClose !== undefined) {
      await activeClose
      return
    }
    const closePromise = this.#closeEndpoint()
    this.#closePromise = closePromise
    try {
      await closePromise
    } finally {
      if (this.#closePromise === closePromise) {
        this.#closePromise = undefined
      }
    }
  }

  async #closeEndpoint(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    this.#closing = true
    try {
      const socketClosures = [...this.#sockets].map(waitForSocketClose)
      for (const socket of this.#sockets) {
        socket.destroy()
      }
      let serverCloseError: unknown
      const serverClosure =
        server === undefined
          ? Promise.resolve()
          : closeServer(server).catch((error: unknown) => {
              serverCloseError = error
            })
      await settleWithin(
        Promise.allSettled([...socketClosures, serverClosure]),
        ENDPOINT_CLOSE_TIMEOUT_MS
      )
      if (serverCloseError !== undefined) {
        throw serverCloseError
      }
    } finally {
      this.#sockets.clear()
      this.#closing = false
    }
  }

  async #authenticate(socket: Socket): Promise<void> {
    socket.pause()
    socket.setTimeout(30_000, () => socket.destroy())
    const peer = await this.#peerIdentity.getPeerIdentity(socket)
    this.#assertOpen(socket)
    const expectedUid = process.getuid?.()
    if (expectedUid === undefined || peer.uid !== expectedUid) {
      throw new Error('Attach peer is not the current user')
    }
    const challenge = this.#challenge.issue()
    this.#assertOpen(socket)
    await writePacket(socket, {
      type: 'challenge',
      version: 1,
      ...challenge
    })
    const response = challengeResponsePacketSchema.parse(
      await readPacket(socket)
    )
    this.#assertOpen(socket)
    const controllerId = response.controllerId
    if (
      !this.#challenge.verify({
        serverNonce: challenge.serverNonce,
        clientNonce: response.clientNonce,
        controllerId,
        response: response.response
      })
    ) {
      throw new Error('Installation challenge failed')
    }
    if (
      response.protocol.major !== this.#protocol.major ||
      response.protocol.minor < this.#protocol.minor
    ) {
      throw new Error('Attach protocol version is incompatible')
    }
    this.#assertOpen(socket)
    const controller = this.#controllers.attach(controllerId)
    this.#assertOpen(socket)
    await writePacket(socket, attachWelcomeSchema.parse({
      type: 'goodbuddy-agent-welcome',
      protocol: this.#protocol,
      connectionId: controller.connectionId,
      generation: controller.generation,
      installationId: this.#installationId,
      binaryDigest: this.#binaryDigest,
      daemonBootId: this.#daemonBootId,
      serverNonce: challenge.serverNonce
    }))
    this.#assertOpen(socket)
    socket.setTimeout(0)
    await this.#onAttach({ socket, controller, peer })
    this.#assertOpen(socket)
    socket.resume()
  }

  #assertOpen(socket: Socket): void {
    if (
      this.#closing ||
      this.#server === undefined ||
      !this.#sockets.has(socket) ||
      socket.destroyed
    ) {
      throw new Error('Private endpoint is closing')
    }
  }
}

export async function attachRelay(options: {
  socketPath: string
  secret: Uint8Array
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
  ensureEndpoint?: (
    reason: 'absent' | 'stale'
  ) => void | Promise<void>
  onWelcome?: (welcome: AttachWelcome) => void
}): Promise<void> {
  const preface = await readRelayPreface(options.input)
  if (process.platform === 'win32') {
    throw new AgentUnsupportedError(
      'Unix attach is unavailable on Windows',
      'platform-incompatible'
    )
  }
  const socketPath = assertAbsoluteManagedPath(options.socketPath)
  let socket = createConnection(socketPath)
  let welcome: AttachWelcome
  try {
    try {
      await waitForConnection(socket)
    } catch (error) {
      socket.destroy()
      const reason = endpointAbsenceReason(error)
      if (reason === undefined || options.ensureEndpoint === undefined) {
        throw error
      }
      await options.ensureEndpoint(reason)
      socket = createConnection(socketPath)
      await waitForConnection(socket)
    }
    socket.pause()
    const challengeResult = challengePacketSchema.safeParse(
      await readPacket(socket)
    )
    if (!challengeResult.success) {
      throw new Error('Daemon returned an invalid challenge')
    }
    const challenge = challengeResult.data
    const verifier = new InstallationChallengeVerifier(options.secret)
    await writePacket(socket, {
      type: 'response',
      version: 1,
      controllerId: preface.controllerId,
      clientNonce: preface.clientNonce,
      protocol: preface.protocol,
      response: verifier.createResponse({
        serverNonce: challenge.serverNonce,
        clientNonce: preface.clientNonce,
        controllerId: preface.controllerId
      })
    })
    const welcomeResult = attachWelcomeSchema.safeParse(
      await readPacket(socket)
    )
    if (!welcomeResult.success) {
      throw new Error('Daemon rejected attach authentication')
    }
    welcome = welcomeResult.data
    if (
      welcome.protocol.major !== preface.protocol.major ||
      welcome.protocol.minor > preface.protocol.minor ||
      welcome.serverNonce !== challenge.serverNonce
    ) {
      throw new Error('Daemon returned an incompatible attach welcome')
    }
  } catch (error) {
    socket.destroy()
    throw error
  }
  try {
    await writeStreamPacket(options.output, welcome)
    options.onWelcome?.(welcome)
  } catch (error) {
    socket.destroy()
    throw error
  }
  socket.resume()
  options.input.pipe(socket)
  socket.pipe(options.output)
  await new Promise<void>((resolve, reject) => {
    socket.once('close', resolve)
    socket.once('error', reject)
    options.input.once('error', reject)
  })
}

export async function probeAuthenticatedEndpoint(options: {
  socketPath: string
  secret: Buffer
  installationId: string
  binaryDigest: string
  protocol: AttachPreface['protocol']
}): Promise<AttachWelcome> {
  if (process.platform === 'win32') {
    throw new AgentUnsupportedError(
      'Unix attach is unavailable on Windows',
      'platform-incompatible'
    )
  }
  const socket = createConnection(
    assertAbsoluteManagedPath(options.socketPath)
  )
  try {
    await waitForConnection(socket)
    socket.pause()
    const challenge = challengePacketSchema.parse(await readPacket(socket))
    const verifier = new InstallationChallengeVerifier(options.secret)
    const controllerId = 'lifecycle-health'
    const clientNonce = randomBytes(24).toString('base64url')
    await writePacket(socket, {
      type: 'response',
      version: 1,
      controllerId,
      clientNonce,
      protocol: options.protocol,
      response: verifier.createResponse({
        serverNonce: challenge.serverNonce,
        clientNonce,
        controllerId
      })
    })
    const welcome = attachWelcomeSchema.parse(await readPacket(socket))
    if (
      welcome.serverNonce !== challenge.serverNonce ||
      welcome.installationId !== options.installationId ||
      welcome.binaryDigest !== options.binaryDigest ||
      welcome.protocol.major !== options.protocol.major ||
      welcome.protocol.minor > options.protocol.minor
    ) {
      throw new Error(
        'Detached Agent endpoint identity does not match its installation'
      )
    }
    return welcome
  } finally {
    socket.destroy()
  }
}

function waitForConnection(socket: Socket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const connected = (): void => {
      socket.off('error', failed)
      resolve()
    }
    const failed = (error: Error): void => {
      socket.off('connect', connected)
      reject(error)
    }
    socket.once('connect', connected)
    socket.once('error', failed)
  })
}

function endpointAbsenceReason(
  error: unknown
): 'absent' | 'stale' | undefined {
  if (!isNodeError(error)) {
    return undefined
  }
  if (error.code === 'ENOENT') {
    return 'absent'
  }
  if (error.code === 'ECONNREFUSED') {
    return 'stale'
  }
  return undefined
}

async function readRelayPreface(
  input: NodeJS.ReadableStream
): Promise<Pick<
  AttachPreface,
  'protocol' | 'controllerId' | 'clientNonce'
>> {
  const parsed = attachPrefaceSchema.parse(await readStreamPacket(input))
  return {
    protocol: parsed.protocol,
    controllerId: parsed.controllerId,
    clientNonce: parsed.clientNonce
  }
}

async function readStreamPacket(
  input: NodeJS.ReadableStream
): Promise<Record<string, unknown>> {
  const stream = input as NodeJS.ReadableStream & {
    read(size?: number): Buffer | null
  }
  const lengthBytes = await readExactlyFromStream(stream, 4)
  const length = lengthBytes.readUInt32BE(0)
  if (length < 2 || length > MAXIMUM_HANDSHAKE_BYTES) {
    throw new Error('Attach relay preface is oversized')
  }
  const contents = await readExactlyFromStream(stream, length)
  const value: unknown = JSON.parse(contents.toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Attach relay preface must be an object')
  }
  return value as Record<string, unknown>
}

async function writeStreamPacket(
  output: NodeJS.WritableStream,
  value: Record<string, unknown>
): Promise<void> {
  const contents = Buffer.from(JSON.stringify(value), 'utf8')
  const packet = Buffer.allocUnsafe(contents.byteLength + 4)
  packet.writeUInt32BE(contents.byteLength, 0)
  contents.copy(packet, 4)
  await new Promise<void>((resolve, reject) => {
    output.write(packet, (error?: Error | null) => {
      if (error === null || error === undefined) {
        resolve()
      } else {
        reject(error)
      }
    })
  })
}

async function readPacket(socket: Socket): Promise<Record<string, unknown>> {
  const lengthBytes = await readExactly(socket, 4)
  const length = lengthBytes.readUInt32BE(0)
  if (length < 2 || length > MAXIMUM_HANDSHAKE_BYTES) {
    throw new Error('Attach handshake packet is oversized')
  }
  const contents = await readExactly(socket, length)
  const value: unknown = JSON.parse(contents.toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Attach handshake packet must be an object')
  }
  return value as Record<string, unknown>
}

async function writePacket(
  socket: Socket,
  value: Record<string, unknown>
): Promise<void> {
  const contents = Buffer.from(JSON.stringify(value), 'utf8')
  if (contents.byteLength > MAXIMUM_HANDSHAKE_BYTES) {
    throw new Error('Attach handshake packet is oversized')
  }
  const packet = Buffer.allocUnsafe(contents.byteLength + 4)
  packet.writeUInt32BE(contents.byteLength, 0)
  contents.copy(packet, 4)
  await new Promise<void>((resolve, reject) => {
    socket.write(packet, (error) => {
      if (error === null || error === undefined) {
        resolve()
      } else {
        reject(error)
      }
    })
  })
}

async function readExactly(socket: Socket, byteLength: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let remaining = byteLength
  while (remaining > 0) {
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
      const onEnd = (): void => {
        cleanup()
        reject(new Error('Attach socket closed during handshake'))
      }
      const onError = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const cleanup = (): void => {
        socket.off('readable', onReadable)
        socket.off('end', onEnd)
        socket.off('error', onError)
      }
      socket.once('readable', onReadable)
      socket.once('end', onEnd)
      socket.once('error', onError)
    })
  }
  return Buffer.concat(chunks, byteLength)
}

async function readExactlyFromStream(
  stream: NodeJS.ReadableStream & {
    read(size?: number): Buffer | null
  },
  byteLength: number
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let remaining = byteLength
  while (remaining > 0) {
    const chunk = stream.read(remaining)
    if (chunk !== null) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      chunks.push(bytes)
      remaining -= bytes.byteLength
      continue
    }
    await new Promise<void>((resolve, reject) => {
      const onReadable = (): void => {
        cleanup()
        resolve()
      }
      const onEnd = (): void => {
        cleanup()
        reject(new Error('Attach relay input closed during preface'))
      }
      const onError = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const cleanup = (): void => {
        stream.removeListener('readable', onReadable)
        stream.removeListener('end', onEnd)
        stream.removeListener('error', onError)
      }
      stream.once('readable', onReadable)
      stream.once('end', onEnd)
      stream.once('error', onError)
    })
  }
  return Buffer.concat(chunks, byteLength)
}

function waitForSocketClose(socket: Socket): Promise<void> {
  if (socket.closed) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    socket.once('close', resolve)
  })
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
