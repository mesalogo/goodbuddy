import type { DeepSeekHarnessChild } from './deepseek-harness-runtime'

export const DEEPSEEK_HARNESS_BYTE_PROTOCOL =
  'goodbuddy.deepseek-harness.byte-stream'
export const DEEPSEEK_HARNESS_BYTE_PROTOCOL_VERSION = 1
export const DEEPSEEK_HARNESS_MAX_CHUNK_BYTES = 64 * 1024

type StreamName = 'stdin' | 'stdout'
type ForwardType = 'data' | 'close' | 'abort'

type MessageBase = {
  protocol: typeof DEEPSEEK_HARNESS_BYTE_PROTOCOL
  version: typeof DEEPSEEK_HARNESS_BYTE_PROTOCOL_VERSION
  stream: StreamName
  seq: number
}

type ProtocolMessage =
  | (MessageBase & {
      type: 'data'
      bytes: Uint8Array
    })
  | (MessageBase & { type: 'close' })
  | (MessageBase & { type: 'abort' })
  | (MessageBase & { type: 'ack' })
  | (MessageBase & { type: 'cancel' })
  | {
      protocol: typeof DEEPSEEK_HARNESS_BYTE_PROTOCOL
      version: typeof DEEPSEEK_HARNESS_BYTE_PROTOCOL_VERSION
      type: 'fail'
    }

type Deferred = {
  readonly promise: Promise<void>
  resolve(): void
  reject(error: Error): void
}

type PendingSend = {
  readonly seq: number
  readonly deferred: Deferred
}

type SenderState = {
  readonly stream: StreamName
  nextSeq: number
  pending?: PendingSend
  finished: boolean
  cancelled: boolean
  controller?: WritableStreamDefaultController
}

type ReceiverState = {
  readonly stream: StreamName
  nextSeq: number
  pendingBytes?: Uint8Array
  finished: boolean
  cancelled: boolean
  controller?: ReadableStreamDefaultController<Uint8Array>
}

type MessagePortAdapter = {
  postMessage(message: ProtocolMessage): void
  subscribe(listener: (message: unknown) => void): () => void
}

type EndpointOptions = {
  readonly senderStream: StreamName
  readonly receiverStream: StreamName
  readonly onFailure?: () => void
}

const CONTROL_PROTOCOL = 'goodbuddy.deepseek-harness.control'
const PROTOCOL_KEYS = ['protocol', 'version', 'type'] as const
const STREAM_KEYS = [...PROTOCOL_KEYS, 'stream', 'seq'] as const
const DATA_KEYS = [...STREAM_KEYS, 'bytes'] as const
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER

class ByteTransportError extends Error {
  constructor(code: string) {
    super(`DeepSeek Harness byte transport failed (${code})`)
    this.name = 'ByteTransportError'
  }
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined
  let rejectPromise: ((error: Error) => void) | undefined
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve: () => resolvePromise?.(),
    reject: (error) => rejectPromise?.(error)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function isSequence(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_SEQUENCE
  )
}

function parseMessage(value: unknown): ProtocolMessage | undefined {
  if (
    !isRecord(value) ||
    value.protocol !== DEEPSEEK_HARNESS_BYTE_PROTOCOL ||
    value.version !== DEEPSEEK_HARNESS_BYTE_PROTOCOL_VERSION ||
    typeof value.type !== 'string'
  ) {
    return undefined
  }

  if (value.type === 'fail') {
    return hasExactKeys(value, PROTOCOL_KEYS)
      ? (value as ProtocolMessage)
      : undefined
  }

  if (
    !['data', 'close', 'abort', 'ack', 'cancel'].includes(value.type) ||
    (value.stream !== 'stdin' && value.stream !== 'stdout') ||
    !isSequence(value.seq)
  ) {
    return undefined
  }

  if (value.type === 'data') {
    if (
      !hasExactKeys(value, DATA_KEYS) ||
      !(value.bytes instanceof Uint8Array) ||
      value.bytes.byteLength === 0 ||
      value.bytes.byteLength > DEEPSEEK_HARNESS_MAX_CHUNK_BYTES
    ) {
      return undefined
    }
    return value as ProtocolMessage
  }

  return hasExactKeys(value, STREAM_KEYS)
    ? (value as ProtocolMessage)
    : undefined
}

function isControlMessage(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value.protocol !== CONTROL_PROTOCOL ||
    value.version !== 1 ||
    typeof value.type !== 'string'
  ) {
    return false
  }
  if (value.type === 'ready') {
    return hasExactKeys(value, PROTOCOL_KEYS)
  }
  if (value.type === 'fatal') {
    return (
      hasExactKeys(value, [...PROTOCOL_KEYS, 'code']) &&
      typeof value.code === 'string' &&
      /^[A-Z][A-Z0-9_]{0,63}$/u.test(value.code)
    )
  }
  return (
    value.type === 'start' &&
    hasExactKeys(value, [...PROTOCOL_KEYS, 'config']) &&
    isRecord(value.config)
  )
}

class ByteTransportEndpoint {
  readonly writable: WritableStream<Uint8Array>
  readonly readable: ReadableStream<Uint8Array>

  private readonly sender: SenderState
  private readonly receiver: ReceiverState
  private readonly unsubscribe: () => void
  private failed = false
  private disposed = false

  constructor(
    private readonly port: MessagePortAdapter,
    private readonly options: EndpointOptions
  ) {
    this.sender = {
      stream: options.senderStream,
      nextSeq: 0,
      finished: false,
      cancelled: false
    }
    this.receiver = {
      stream: options.receiverStream,
      nextSeq: 0,
      finished: false,
      cancelled: false
    }

    this.writable = new WritableStream<Uint8Array>(
      {
        start: (controller) => {
          this.sender.controller = controller
        },
        write: async (chunk) => {
          if (!(chunk instanceof Uint8Array)) {
            throw new ByteTransportError('INVALID_WRITE')
          }
          for (
            let offset = 0;
            offset < chunk.byteLength;
            offset += DEEPSEEK_HARNESS_MAX_CHUNK_BYTES
          ) {
            const bytes = chunk.slice(
              offset,
              offset + DEEPSEEK_HARNESS_MAX_CHUNK_BYTES
            )
            await this.sendForward('data', bytes)
          }
        },
        close: () => this.sendForward('close'),
        abort: () => this.sendForward('abort')
      },
      new CountQueuingStrategy({ highWaterMark: 1 })
    )

    this.readable = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.receiver.controller = controller
        },
        pull: () => {
          this.flushReceiver()
        },
        cancel: () => {
          this.cancelReceiver()
        }
      },
      new CountQueuingStrategy({ highWaterMark: 1 })
    )

    this.unsubscribe = this.port.subscribe((message) => {
      if (isControlMessage(message)) {
        return
      }
      this.handleMessage(message)
    })
  }

  dispose(code = 'CLOSED'): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.unsubscribe()
    const error = new ByteTransportError(code)
    this.sender.pending?.deferred.reject(error)
    this.sender.pending = undefined
    try {
      this.sender.controller?.error(error)
    } catch {
      // The stream may already be closed.
    }
    try {
      this.receiver.controller?.error(error)
    } catch {
      // The stream may already be closed.
    }
  }

  private fail(code: string, notifyPeer: boolean): void {
    if (this.failed || this.disposed) {
      return
    }
    this.failed = true
    if (notifyPeer) {
      try {
        this.port.postMessage({
          protocol: DEEPSEEK_HARNESS_BYTE_PROTOCOL,
          version: DEEPSEEK_HARNESS_BYTE_PROTOCOL_VERSION,
          type: 'fail'
        })
      } catch {
        // The local endpoint still closes if peer notification fails.
      }
    }
    this.dispose(code)
    this.options.onFailure?.()
  }

  private post(message: ProtocolMessage): boolean {
    if (this.failed || this.disposed) {
      return false
    }
    try {
      this.port.postMessage(message)
      return true
    } catch {
      this.fail('CHANNEL_FAILURE', false)
      return false
    }
  }

  private async sendForward(
    type: ForwardType,
    bytes?: Uint8Array
  ): Promise<void> {
    if (
      this.failed ||
      this.disposed ||
      this.sender.finished ||
      this.sender.cancelled
    ) {
      throw new ByteTransportError(
        this.sender.cancelled ? 'REMOTE_CANCELLED' : 'CLOSED'
      )
    }
    if (this.sender.pending || this.sender.nextSeq > MAX_SEQUENCE) {
      this.fail('LOCAL_STATE', true)
      throw new ByteTransportError('LOCAL_STATE')
    }

    const waiting = deferred()
    const seq = this.sender.nextSeq
    this.sender.pending = { seq, deferred: waiting }
    const message: ProtocolMessage =
      type === 'data'
        ? {
            protocol: DEEPSEEK_HARNESS_BYTE_PROTOCOL,
            version: DEEPSEEK_HARNESS_BYTE_PROTOCOL_VERSION,
            type,
            stream: this.sender.stream,
            seq,
            bytes: bytes as Uint8Array
          }
        : {
            protocol: DEEPSEEK_HARNESS_BYTE_PROTOCOL,
            version: DEEPSEEK_HARNESS_BYTE_PROTOCOL_VERSION,
            type,
            stream: this.sender.stream,
            seq
          }

    if (!this.post(message)) {
      await waiting.promise
      return
    }
    await waiting.promise
    if (type !== 'data') {
      this.sender.finished = true
    }
  }

  private handleMessage(rawMessage: unknown): void {
    const message = parseMessage(rawMessage)
    if (!message) {
      this.fail('PROTOCOL_VIOLATION', true)
      return
    }
    if (message.type === 'fail') {
      this.fail('REMOTE_FAILURE', false)
      return
    }

    if (message.type === 'ack') {
      this.handleAck(message)
      return
    }
    if (message.type === 'cancel') {
      this.handleCancel(message)
      return
    }
    this.handleForward(message)
  }

  private handleAck(
    message: MessageBase & { type: 'ack' }
  ): void {
    const pending = this.sender.pending
    if (
      message.stream !== this.sender.stream ||
      !pending ||
      message.seq !== pending.seq
    ) {
      this.fail('PROTOCOL_VIOLATION', true)
      return
    }
    this.sender.pending = undefined
    this.sender.nextSeq += 1
    pending.deferred.resolve()
  }

  private handleCancel(
    message: MessageBase & { type: 'cancel' }
  ): void {
    const pending = this.sender.pending
    if (
      message.stream !== this.sender.stream ||
      this.sender.finished ||
      this.sender.cancelled ||
      message.seq !== (pending?.seq ?? this.sender.nextSeq)
    ) {
      this.fail('PROTOCOL_VIOLATION', true)
      return
    }
    this.sender.cancelled = true
    this.sender.pending = undefined
    const error = new ByteTransportError('REMOTE_CANCELLED')
    pending?.deferred.reject(error)
    try {
      this.sender.controller?.error(error)
    } catch {
      // The stream may already be closed.
    }
  }

  private handleForward(
    message: Extract<ProtocolMessage, { type: ForwardType }>
  ): void {
    if (
      message.stream !== this.receiver.stream ||
      this.receiver.finished ||
      this.receiver.cancelled ||
      message.seq !== this.receiver.nextSeq
    ) {
      this.fail('PROTOCOL_VIOLATION', true)
      return
    }
    this.receiver.nextSeq += 1

    if (message.type === 'data') {
      if (this.receiver.pendingBytes) {
        this.fail('PROTOCOL_VIOLATION', true)
        return
      }
      this.receiver.pendingBytes = message.bytes.slice()
      this.flushReceiver()
      return
    }

    this.receiver.finished = true
    if (message.type === 'close') {
      try {
        this.receiver.controller?.close()
      } catch {
        this.fail('LOCAL_STATE', true)
        return
      }
    } else {
      try {
        this.receiver.controller?.error(
          new ByteTransportError('REMOTE_ABORTED')
        )
      } catch {
        // The stream may already have been cancelled.
      }
    }
    this.sendAck(message.seq)
  }

  private flushReceiver(): void {
    const controller = this.receiver.controller
    const bytes = this.receiver.pendingBytes
    if (
      !controller ||
      !bytes ||
      this.receiver.cancelled ||
      this.receiver.finished ||
      (controller.desiredSize ?? 0) <= 0
    ) {
      return
    }
    this.receiver.pendingBytes = undefined
    controller.enqueue(bytes)
    this.sendAck(this.receiver.nextSeq - 1)
  }

  private sendAck(seq: number): void {
    this.post({
      protocol: DEEPSEEK_HARNESS_BYTE_PROTOCOL,
      version: DEEPSEEK_HARNESS_BYTE_PROTOCOL_VERSION,
      type: 'ack',
      stream: this.receiver.stream,
      seq
    })
  }

  private cancelReceiver(): void {
    if (
      this.receiver.cancelled ||
      this.receiver.finished ||
      this.failed ||
      this.disposed
    ) {
      return
    }
    this.receiver.cancelled = true
    const cancelSeq = this.receiver.pendingBytes
      ? this.receiver.nextSeq - 1
      : this.receiver.nextSeq
    this.receiver.pendingBytes = undefined
    this.post({
      protocol: DEEPSEEK_HARNESS_BYTE_PROTOCOL,
      version: DEEPSEEK_HARNESS_BYTE_PROTOCOL_VERSION,
      type: 'cancel',
      stream: this.receiver.stream,
      seq: cancelSeq
    })
  }
}

export type DeepSeekHarnessUtilityProcessLike<Stderr = unknown> = {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (exitCode: number) => void): unknown
  removeListener(
    event: 'message',
    listener: (message: unknown) => void
  ): unknown
  removeListener(event: 'exit', listener: (exitCode: number) => void): unknown
  kill(): boolean
  readonly pid?: number
  readonly stderr?: Stderr | null
}

export type DeepSeekHarnessUtilityChildOptions<Stderr> = {
  stderrToWeb?: (stderr: Stderr) => ReadableStream<Uint8Array>
  terminateProcess?: (
    utilityProcess: DeepSeekHarnessUtilityProcessLike<Stderr>
  ) => void
}

/**
 * Adapts an Electron UtilityProcess without importing Electron at runtime.
 * Configure the utility process with piped stderr and inject Node's
 * Readable.toWeb when stderr capture is required.
 */
export function createDeepSeekHarnessUtilityChild<Stderr = unknown>(
  utilityProcess: DeepSeekHarnessUtilityProcessLike<Stderr>,
  options: DeepSeekHarnessUtilityChildOptions<Stderr> = {}
): DeepSeekHarnessChild {
  let killed = false
  const killOnce = (): void => {
    if (killed) {
      return
    }
    killed = true
    if (options.terminateProcess) {
      options.terminateProcess(utilityProcess)
    } else {
      utilityProcess.kill()
    }
  }

  const endpoint = new ByteTransportEndpoint(
    {
      postMessage: (message) => utilityProcess.postMessage(message),
      subscribe: (listener) => {
        const onMessage = (message: unknown): void => listener(message)
        utilityProcess.on('message', onMessage)
        return () => utilityProcess.removeListener('message', onMessage)
      }
    },
    {
      senderStream: 'stdin',
      receiverStream: 'stdout',
      onFailure: killOnce
    }
  )

  let settleExit:
    | ((result: { exitCode: number | null; signal?: string | null }) => void)
    | undefined
  const exited = new Promise<{
    exitCode: number | null
    signal?: string | null
  }>((resolve) => {
    settleExit = resolve
  })
  let exitedSettled = false
  const onExit = (exitCode: number): void => {
    if (exitedSettled) {
      return
    }
    exitedSettled = true
    killed = true
    endpoint.dispose('PROCESS_EXITED')
    settleExit?.({ exitCode })
  }
  utilityProcess.on('exit', onExit)

  const stderr =
    utilityProcess.stderr != null && options.stderrToWeb
      ? options.stderrToWeb(utilityProcess.stderr)
      : undefined

  return {
    stdin: endpoint.writable,
    stdout: endpoint.readable,
    stderr,
    exited,
    terminate: () => {
      endpoint.dispose('TERMINATED')
      killOnce()
    }
  }
}

type ParentPortMessageEvent = {
  readonly data: unknown
}

export type DeepSeekHarnessParentPortLike = {
  postMessage(message: unknown): void
  on(
    event: 'message',
    listener: (event: ParentPortMessageEvent) => void
  ): unknown
  removeListener(
    event: 'message',
    listener: (event: ParentPortMessageEvent) => void
  ): unknown
}

export type DeepSeekHarnessHostTransport = {
  readonly stdin: ReadableStream<Uint8Array>
  readonly stdout: WritableStream<Uint8Array>
  dispose(): void
}

/** Creates the host-side streams backed by process.parentPort-like messaging. */
export function createDeepSeekHarnessHostTransport(
  parentPort: DeepSeekHarnessParentPortLike
): DeepSeekHarnessHostTransport {
  const endpoint = new ByteTransportEndpoint(
    {
      postMessage: (message) => parentPort.postMessage(message),
      subscribe: (listener) => {
        const onMessage = (event: ParentPortMessageEvent): void =>
          listener(event.data)
        parentPort.on('message', onMessage)
        return () => parentPort.removeListener('message', onMessage)
      }
    },
    {
      senderStream: 'stdout',
      receiverStream: 'stdin'
    }
  )

  return {
    stdin: endpoint.readable,
    stdout: endpoint.writable,
    dispose: () => endpoint.dispose()
  }
}
