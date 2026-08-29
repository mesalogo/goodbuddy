import type { ClientChannel } from 'ssh2'
import {
  AGENT_PROTOCOL_LIMITS,
  AGENT_PROTOCOL_FAILURE_STDERR_PREFIX,
  agentProtocolFailureCategorySchema,
  attachPrefaceSchema,
  attachWelcomeSchema,
  type AgentFrame,
  type AttachPreface,
  type AttachWelcome
} from '../../shared/agent-protocol'
import {
  AGENT_FRAME_FIXED_HEADER_BYTES,
  AgentFrameError,
  MAXIMUM_ENCODED_AGENT_FRAME_BYTES,
  decodeAgentFrame,
  encodeAgentFrame,
  inspectAgentFramePrefix
} from '../../shared/agent-protocol/frame'
import type { SshConnectionLease } from '../ssh/ssh-connection-pool'
import type { VerifiedAgentInstallationId } from '../ssh/ssh-agent-command'

const HANDSHAKE_MAXIMUM_BYTES = 4 * 1024
const MAXIMUM_INCOMING_ITEMS = 256
const MAXIMUM_PENDING_READS = 256
const MAXIMUM_OUTGOING_ITEMS = 512
const MAXIMUM_BUFFERED_BYTES =
  AGENT_PROTOCOL_LIMITS.maximumBufferedProtocolBytes
const MAXIMUM_STDERR_BYTES = 64 * 1024
const DEFAULT_ATTACH_TIMEOUT_MS = 10_000

type OutgoingWrite = {
  bytes: Uint8Array
  resolve: () => void
  reject: (error: unknown) => void
}

type FrameWaiter = {
  resolve: (frame: AgentFrame) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  abort?: () => void
}

export type AgentAttachTransportOptions = {
  sshLease: Pick<SshConnectionLease, 'openAgentAttach'>
  installationId: VerifiedAgentInstallationId
  preface: AttachPreface
  signal?: AbortSignal
  timeoutMs?: number
}

export class AgentAttachTransportError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'timeout'
      | 'aborted'
      | 'closed'
      | 'stderr'
      | 'malformed'
      | 'overflow',
    readonly cause?: unknown,
    readonly diagnostic?: string
  ) {
    super(message)
    this.name = 'AgentAttachTransportError'
  }
}

/**
 * Owns one fixed SSH attach channel. The initial packet and every subsequent
 * frame are length bounded before allocation. Ordering and backpressure are
 * delegated to the SSH channel; this layer adds no scheduler or flow window.
 */
export class AgentAttachTransport {
  readonly welcome: AttachWelcome
  readonly #channel: ClientChannel
  #input = Buffer.alloc(0)
  #incoming: AgentFrame[] = []
  #incomingBytes = 0
  #waiters: FrameWaiter[] = []
  #writes: OutgoingWrite[] = []
  #outgoingBytes = 0
  #writing = false
  #activeWrite?: OutgoingWrite
  #closed = false
  #closeError?: AgentAttachTransportError
  #stderr = Buffer.alloc(0)
  #closeListeners = new Set<(error: AgentAttachTransportError) => void>()

  private constructor(channel: ClientChannel, welcome: AttachWelcome) {
    this.#channel = channel
    this.welcome = welcome
    this.#channel.on('data', this.#onData)
    this.#channel.stderr.on('data', this.#onStderr)
    this.#channel.once('error', this.#onError)
    this.#channel.once('close', this.#onClose)
  }

  static async connect(
    options: AgentAttachTransportOptions
  ): Promise<AgentAttachTransport> {
    const preface = attachPrefaceSchema.parse(options.preface)
    const timeoutMs = options.timeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new RangeError('Invalid Agent attach timeout')
    }
    options.signal?.throwIfAborted()
    const controller = new AbortController()
    const abort = (): void => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      controller.abort(
        new AgentAttachTransportError(
          'GoodBuddy Agent attach handshake timed out',
          'timeout'
        )
      )
    }, timeoutMs)
    try {
      const channel = await options.sshLease.openAgentAttach(
        options.installationId,
        controller.signal
      )
      const handshake = readWelcome(channel, preface, controller.signal)
      const { welcome, trailingBytes, stderr } = await handshake
      const transport = new AgentAttachTransport(channel, welcome)
      transport.#stderr = Buffer.from(stderr)
      if (trailingBytes.byteLength > 0) {
        transport.#acceptBytes(trailingBytes)
      }
      return transport
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason
        if (reason instanceof AgentAttachTransportError) {
          throw reason
        }
        throw new AgentAttachTransportError(
          'GoodBuddy Agent attach was aborted',
          'aborted',
          reason
        )
      }
      throw error
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
  }

  get closed(): boolean {
    return this.#closed
  }

  async send(frame: AgentFrame): Promise<void> {
    this.#assertOpen()
    let bytes: Uint8Array
    try {
      bytes = encodeAgentFrame(frame)
    } catch (error) {
      throw new AgentAttachTransportError(
        'Refused malformed outgoing Agent frame',
        'malformed',
        error
      )
    }
    await this.#enqueueWrite(bytes)
  }

  receive(signal?: AbortSignal): Promise<AgentFrame> {
    this.#assertOpen()
    signal?.throwIfAborted()
    const frame = this.#incoming.shift()
    if (frame !== undefined) {
      this.#incomingBytes -= encodedFrameLength(frame)
      this.#resumeInputIfPossible()
      return Promise.resolve(frame)
    }
    if (this.#waiters.length >= MAXIMUM_PENDING_READS) {
      return Promise.reject(
        new AgentAttachTransportError(
          'Too many pending Agent frame readers',
          'overflow'
        )
      )
    }
    return new Promise<AgentFrame>((resolve, reject) => {
      const waiter: FrameWaiter = { resolve, reject, signal }
      if (signal !== undefined) {
        waiter.abort = (): void => {
          const index = this.#waiters.indexOf(waiter)
          if (index >= 0) {
            this.#waiters.splice(index, 1)
          }
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        }
        signal.addEventListener('abort', waiter.abort, { once: true })
      }
      this.#waiters.push(waiter)
    })
  }

  onClose(
    listener: (error: AgentAttachTransportError) => void
  ): () => void {
    if (this.#closeError !== undefined) {
      queueMicrotask(() => listener(this.#closeError!))
      return () => undefined
    }
    this.#closeListeners.add(listener)
    return () => this.#closeListeners.delete(listener)
  }

  dispose(): void {
    this.#fail(
      new AgentAttachTransportError(
        'GoodBuddy Agent attach transport was disposed',
        'closed'
      )
    )
  }

  readonly #onData = (chunk: Buffer | string): void => {
    if (!this.#closed) {
      this.#acceptBytes(Buffer.from(chunk))
    }
  }

  readonly #onStderr = (chunk: Buffer | string): void => {
    if (this.#closed) {
      return
    }
    const bytes = Buffer.from(chunk)
    if (this.#stderr.byteLength + bytes.byteLength > MAXIMUM_STDERR_BYTES) {
      this.#fail(
        new AgentAttachTransportError(
          'GoodBuddy Agent attach stderr exceeded its limit',
          'stderr'
        )
      )
      return
    }
    this.#stderr = Buffer.concat([this.#stderr, bytes])
  }

  readonly #onError = (error: Error): void => {
    this.#fail(
      new AgentAttachTransportError(
        'GoodBuddy Agent attach channel failed',
        'closed',
        error
      )
    )
  }

  readonly #onClose = (): void => {
    const diagnostic = protocolFailureDiagnostic(this.#stderr)
    this.#fail(
      new AgentAttachTransportError(
        this.#stderr.byteLength > 0
          ? 'GoodBuddy Agent attach closed with diagnostic output'
          : 'GoodBuddy Agent attach channel closed',
        'closed',
        undefined,
        diagnostic
      )
    )
  }

  #acceptBytes(chunk: Buffer): void {
    if (
      this.#input.byteLength + chunk.byteLength >
      MAXIMUM_BUFFERED_BYTES + MAXIMUM_ENCODED_AGENT_FRAME_BYTES
    ) {
      this.#fail(
        new AgentAttachTransportError(
          'Agent attach input buffer exceeded its limit',
          'overflow'
        )
      )
      return
    }
    this.#input = Buffer.concat([this.#input, chunk])
    try {
      while (
        !this.#closed &&
        this.#input.byteLength >= AGENT_FRAME_FIXED_HEADER_BYTES
      ) {
        const frameLength =
          inspectAgentFramePrefix(this.#input).encodedByteLength
        if (this.#input.byteLength < frameLength) {
          break
        }
        const encoded = this.#input.subarray(0, frameLength)
        const frame = decodeAgentFrame(encoded, {
          protocolMajor: this.welcome.protocol.major,
          maximumProtocolMinor: this.welcome.protocol.minor,
          connectionId: this.welcome.connectionId,
          generation: this.welcome.generation
        })
        if (frame.header.direction !== 'agent-to-main') {
          throw new AgentFrameError(
            'Agent sent a frame in the wrong direction',
            'invalid'
          )
        }
        this.#input = this.#input.subarray(frameLength)
        this.#enqueueIncoming(frame)
        if (
          this.#incoming.length >= MAXIMUM_INCOMING_ITEMS ||
          this.#incomingBytes >= MAXIMUM_BUFFERED_BYTES
        ) {
          break
        }
      }
    } catch (error) {
      this.#fail(
        new AgentAttachTransportError(
          'Received a malformed Agent frame',
          'malformed',
          error
        )
      )
    }
  }

  #enqueueIncoming(frame: AgentFrame): void {
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) {
      if (waiter.abort !== undefined) {
        waiter.signal?.removeEventListener('abort', waiter.abort)
      }
      waiter.resolve(frame)
      return
    }
    const byteLength = encodedFrameLength(frame)
    if (
      this.#incoming.length >= MAXIMUM_INCOMING_ITEMS ||
      this.#incomingBytes + byteLength > MAXIMUM_BUFFERED_BYTES
    ) {
      this.#channel.pause()
      throw new AgentAttachTransportError(
        'Agent attach incoming queue is full',
        'overflow'
      )
    }
    this.#incoming.push(frame)
    this.#incomingBytes += byteLength
    if (
      this.#incoming.length === MAXIMUM_INCOMING_ITEMS ||
      this.#incomingBytes === MAXIMUM_BUFFERED_BYTES
    ) {
      this.#channel.pause()
    }
  }

  #resumeInputIfPossible(): void {
    if (
      !this.#closed &&
      this.#incoming.length < MAXIMUM_INCOMING_ITEMS &&
      this.#incomingBytes < MAXIMUM_BUFFERED_BYTES
    ) {
      if (this.#input.byteLength > 0) {
        this.#acceptBytes(Buffer.alloc(0))
      }
      if (
        this.#incoming.length < MAXIMUM_INCOMING_ITEMS &&
        this.#incomingBytes < MAXIMUM_BUFFERED_BYTES
      ) {
        this.#channel.resume()
      }
    }
  }

  #pumpWrites(): void {
    if (this.#writing || this.#closed) {
      return
    }
    const write = this.#writes.shift()
    if (write === undefined) {
      return
    }
    this.#writing = true
    this.#activeWrite = write
    this.#channel.write(write.bytes, (error?: Error | null) => {
      if (this.#activeWrite !== write) {
        return
      }
      this.#activeWrite = undefined
      this.#writing = false
      this.#outgoingBytes -= write.bytes.byteLength
      if (error !== undefined && error !== null) {
        const transportError = new AgentAttachTransportError(
          'Failed to write an Agent frame',
          'closed',
          error
        )
        write.reject(transportError)
        this.#fail(transportError)
        return
      }
      write.resolve()
      this.#pumpWrites()
    })
  }

  #enqueueWrite(bytes: Uint8Array): Promise<void> {
    if (
      this.#writes.length >= MAXIMUM_OUTGOING_ITEMS ||
      this.#outgoingBytes + bytes.byteLength > MAXIMUM_BUFFERED_BYTES
    ) {
      return Promise.reject(
        new AgentAttachTransportError(
          'Agent attach outgoing queue is full',
          'overflow'
        )
      )
    }
    return new Promise<void>((resolve, reject) => {
      const write = {
        bytes,
        resolve,
        reject
      }
      this.#writes.push(write)
      this.#outgoingBytes += bytes.byteLength
      this.#pumpWrites()
    })
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw (
        this.#closeError ??
        new AgentAttachTransportError(
          'GoodBuddy Agent attach transport is closed',
          'closed'
        )
      )
    }
  }

  #fail(error: AgentAttachTransportError): void {
    if (this.#closed) {
      return
    }
    this.#closed = true
    this.#closeError = error
    this.#channel.off('data', this.#onData)
    this.#channel.stderr.off('data', this.#onStderr)
    this.#channel.destroy()
    const activeWrite = this.#activeWrite
    this.#activeWrite = undefined
    this.#writing = false
    activeWrite?.reject(error)
    for (const waiter of this.#waiters.splice(0)) {
      if (waiter.abort !== undefined) {
        waiter.signal?.removeEventListener('abort', waiter.abort)
      }
      waiter.reject(error)
    }
    for (const write of this.#writes.splice(0)) {
      write.reject(error)
    }
    this.#incoming = []
    this.#input = Buffer.alloc(0)
    this.#incomingBytes = 0
    this.#outgoingBytes = 0
    for (const listener of this.#closeListeners) {
      listener(error)
    }
    this.#closeListeners.clear()
  }
}

function protocolFailureDiagnostic(
  stderr: Uint8Array
): string | undefined {
  for (const line of Buffer.from(stderr).toString('utf8').split(/\r?\n/u)) {
    if (!line.startsWith(AGENT_PROTOCOL_FAILURE_STDERR_PREFIX)) {
      continue
    }
    const category = agentProtocolFailureCategorySchema.safeParse(
      line.slice(AGENT_PROTOCOL_FAILURE_STDERR_PREFIX.length)
    )
    if (category.success) {
      return category.data
    }
  }
  return undefined
}

async function readWelcome(
  channel: ClientChannel,
  preface: AttachPreface,
  signal: AbortSignal
): Promise<{
  welcome: AttachWelcome
  trailingBytes: Buffer
  stderr: Buffer
}> {
  let input = Buffer.alloc(0)
  let stderr = Buffer.alloc(0)
  return await new Promise((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      channel.off('data', onData)
      channel.stderr.off('data', onStderr)
      channel.off('error', onError)
      channel.off('close', onClose)
      signal.removeEventListener('abort', onAbort)
    }
    const fail = (error: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      channel.destroy()
      reject(error)
    }
    const onAbort = (): void => fail(signal.reason)
    const onError = (error: Error): void => fail(error)
    const onClose = (): void => {
      const diagnostic = handshakeFailureDiagnostic(stderr)
      fail(
        new AgentAttachTransportError(
          stderr.byteLength > 0
            ? 'Agent attach closed during handshake with diagnostic output'
            : 'Agent attach closed during handshake',
          'closed',
          undefined,
          diagnostic
        )
      )
    }
    const onStderr = (chunk: Buffer | string): void => {
      const bytes = Buffer.from(chunk)
      if (stderr.byteLength + bytes.byteLength > MAXIMUM_STDERR_BYTES) {
        fail(
          new AgentAttachTransportError(
            'Agent attach handshake stderr exceeded its limit',
            'stderr'
          )
        )
      } else {
        stderr = Buffer.concat([stderr, bytes])
      }
    }
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.from(chunk)
      if (
        input.byteLength + bytes.byteLength >
        4 +
          HANDSHAKE_MAXIMUM_BYTES +
          MAXIMUM_BUFFERED_BYTES +
          MAXIMUM_ENCODED_AGENT_FRAME_BYTES
      ) {
        fail(
          new AgentAttachTransportError(
            'Agent attach handshake input exceeded its limit',
            'overflow'
          )
        )
        return
      }
      input = Buffer.concat([input, bytes])
      if (input.byteLength < 4) {
        return
      }
      const length = input.readUInt32BE(0)
      if (length < 2 || length > HANDSHAKE_MAXIMUM_BYTES) {
        fail(
          new AgentAttachTransportError(
            'Agent attach welcome is oversized',
            'malformed'
          )
        )
        return
      }
      if (input.byteLength < 4 + length) {
        return
      }
      try {
        const value: unknown = JSON.parse(
          input.subarray(4, 4 + length).toString('utf8')
        )
        const welcome = attachWelcomeSchema.parse(value)
        if (
          welcome.protocol.major !== preface.protocol.major ||
          welcome.protocol.minor > preface.protocol.minor
        ) {
          throw new Error('Agent attach protocol version is incompatible')
        }
        settled = true
        cleanup()
        resolve({
          welcome,
          trailingBytes: input.subarray(4 + length),
          stderr
        })
      } catch (error) {
        fail(
          new AgentAttachTransportError(
            'Agent attach welcome is malformed',
            'malformed',
            error
          )
        )
      }
    }
    channel.on('data', onData)
    channel.stderr.on('data', onStderr)
    channel.once('error', onError)
    channel.once('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
    const contents = Buffer.from(JSON.stringify(preface), 'utf8')
    if (contents.byteLength > HANDSHAKE_MAXIMUM_BYTES) {
      fail(
        new AgentAttachTransportError(
          'Agent attach preface is oversized',
          'malformed'
        )
      )
      return
    }
    const packet = Buffer.allocUnsafe(contents.byteLength + 4)
    packet.writeUInt32BE(contents.byteLength, 0)
    contents.copy(packet, 4)
    channel.write(packet, (error?: Error | null) => {
      if (error !== undefined && error !== null) {
        fail(error)
      }
    })
  })
}

function handshakeFailureDiagnostic(
  stderr: Uint8Array
): string | undefined {
  const text = Buffer.from(stderr).toString('utf8')
  if (
    /(?:unknown signing key|signature verification|manifest .*mismatch|manifest does not match|authorized registry role|payload (?:size|hash|mode) mismatch)/iu.test(
      text
    )
  ) {
    return 'installation-repair-required'
  }
  return protocolFailureDiagnostic(stderr)
}

function encodedFrameLength(frame: AgentFrame): number {
  return (
    AGENT_FRAME_FIXED_HEADER_BYTES +
    Buffer.byteLength(frame.header.connectionId) +
    Buffer.byteLength(frame.header.channelId) +
    frame.payload.byteLength
  )
}
