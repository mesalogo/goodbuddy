import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DEEPSEEK_HARNESS_BYTE_PROTOCOL,
  DEEPSEEK_HARNESS_BYTE_PROTOCOL_VERSION,
  DEEPSEEK_HARNESS_MAX_CHUNK_BYTES,
  createDeepSeekHarnessHostTransport,
  createDeepSeekHarnessUtilityChild,
  type DeepSeekHarnessParentPortLike
} from './deepseek-harness-utility-transport'
import {
  DEEPSEEK_HARNESS_CONTROL_PROTOCOL,
  DEEPSEEK_HARNESS_CONTROL_VERSION
} from './deepseek-harness-control-protocol'

type Listener = (value: unknown) => void

class LinkedPort {
  peer?: LinkedPort
  readonly sent: unknown[] = []
  private readonly listeners = new Set<Listener>()

  postMessage(message: unknown): void {
    this.sent.push(message)
    queueMicrotask(() => {
      for (const listener of this.peer?.listeners ?? []) {
        listener(message)
      }
    })
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

class FakeUtility {
  readonly port = new LinkedPort()
  readonly stderr = 'node-stderr'
  readonly kill = vi.fn(() => true)
  private readonly listeners = {
    message: new Set<(message: unknown) => void>(),
    exit: new Set<(exitCode: number) => void>()
  }

  constructor(hostPort: LinkedPort) {
    this.port.peer = hostPort
    hostPort.peer = this.port
    this.port.subscribe((message) => {
      for (const listener of this.listeners.message) {
        listener(message)
      }
    })
  }

  postMessage(message: unknown): void {
    this.port.postMessage(message)
  }

  on(event: 'message', listener: (message: unknown) => void): void
  on(event: 'exit', listener: (exitCode: number) => void): void
  on(
    event: keyof typeof this.listeners,
    listener: ((message: unknown) => void) | ((exitCode: number) => void)
  ): void {
    if (event === 'message') {
      this.listeners.message.add(listener as (message: unknown) => void)
    } else {
      this.listeners.exit.add(listener as (exitCode: number) => void)
    }
  }

  removeListener(event: 'message', listener: (message: unknown) => void): void
  removeListener(event: 'exit', listener: (exitCode: number) => void): void
  removeListener(
    event: keyof typeof this.listeners,
    listener: ((message: unknown) => void) | ((exitCode: number) => void)
  ): void {
    if (event === 'message') {
      this.listeners.message.delete(listener as (message: unknown) => void)
    } else {
      this.listeners.exit.delete(listener as (exitCode: number) => void)
    }
  }

  emitMessage(message: unknown): void {
    for (const listener of this.listeners.message) {
      listener(message)
    }
  }

  emitExit(exitCode: number): void {
    for (const listener of this.listeners.exit) {
      listener(exitCode)
    }
  }
}

function asParentPort(port: LinkedPort): DeepSeekHarnessParentPortLike {
  const wrapped = new Map<Listener, () => void>()
  return {
    postMessage: (message) => port.postMessage(message),
    on: (_event, listener) => {
      const adapter: Listener = (data) => listener({ data })
      wrapped.set(listener as Listener, port.subscribe(adapter))
    },
    removeListener: (_event, listener) => {
      wrapped.get(listener as Listener)?.()
      wrapped.delete(listener as Listener)
    }
  }
}

function setup() {
  const hostPort = new LinkedPort()
  const utility = new FakeUtility(hostPort)
  const stderr = new ReadableStream<Uint8Array>()
  const stderrToWeb = vi.fn(() => stderr)
  const child = createDeepSeekHarnessUtilityChild(utility, { stderrToWeb })
  const host = createDeepSeekHarnessHostTransport(asParentPort(hostPort))
  return { child, host, hostPort, utility, stderr, stderrToWeb }
}

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve))

describe('DeepSeek Harness utility byte transport', () => {
  it('keeps the Electron smoke protocol versions aligned', () => {
    const smokeSource = readFileSync(
      resolve('build/deepseek-harness-utility-smoke.cjs'),
      'utf8'
    )

    expect(smokeSource).toContain(
      `const controlVersion = ${DEEPSEEK_HARNESS_CONTROL_VERSION}`
    )
    expect(smokeSource).toContain(
      `const byteProtocolVersion = ${DEEPSEEK_HARNESS_BYTE_PROTOCOL_VERSION}`
    )
  })

  it('ignores trusted control-plane messages that share the UtilityProcess port', async () => {
    const { child, hostPort, utility } = setup()
    await tick()
    utility.kill.mockClear()
    utility.emitMessage({
      protocol: DEEPSEEK_HARNESS_CONTROL_PROTOCOL,
      version: DEEPSEEK_HARNESS_CONTROL_VERSION,
      type: 'ready',
      failedExtensionIds: []
    })

    const reader = child.stdout.getReader()
    const reading = reader.read()
    hostPort.postMessage({
      protocol: DEEPSEEK_HARNESS_BYTE_PROTOCOL,
      version: DEEPSEEK_HARNESS_BYTE_PROTOCOL_VERSION,
      type: 'data',
      stream: 'stdout',
      seq: 0,
      bytes: Uint8Array.of(7)
    })

    await expect(reading).resolves.toEqual({
      done: false,
      value: Uint8Array.of(7)
    })
    expect(utility.kill).toHaveBeenCalledOnce()
  })

  it('fails closed for malformed control-plane lookalikes', async () => {
    const { child, utility } = setup()
    const reader = child.stdout.getReader()
    utility.emitMessage({
      protocol: DEEPSEEK_HARNESS_CONTROL_PROTOCOL,
      version: DEEPSEEK_HARNESS_CONTROL_VERSION,
      type: 'ready',
      failedExtensionIds: [],
      unexpected: true
    })

    await expect(reader.read()).rejects.toThrow('PROTOCOL_VIOLATION')
    expect(utility.kill).toHaveBeenCalledOnce()
  })

  it('transports bytes in both directions and adapts stderr and exit', async () => {
    const { child, host, utility, stderr, stderrToWeb } = setup()
    const childWriter = child.stdin.getWriter()
    const hostInput = host.stdin.getReader()
    const hostWriter = host.stdout.getWriter()
    const childOutput = child.stdout.getReader()

    await childWriter.write(Uint8Array.of(1, 2, 3))
    await expect(hostInput.read()).resolves.toEqual({
      done: false,
      value: Uint8Array.of(1, 2, 3)
    })
    await hostWriter.write(Uint8Array.of(4, 5))
    await expect(childOutput.read()).resolves.toEqual({
      done: false,
      value: Uint8Array.of(4, 5)
    })

    expect(stderrToWeb).toHaveBeenCalledWith('node-stderr')
    expect(child.stderr).toBe(stderr)
    utility.emitExit(7)
    await expect(child.exited).resolves.toEqual({ exitCode: 7 })
  })

  it('splits chunks at 64 KiB and waits for ACK backpressure', async () => {
    const { child, host, utility } = setup()
    const writer = child.stdin.getWriter()
    const bytes = new Uint8Array(DEEPSEEK_HARNESS_MAX_CHUNK_BYTES + 3)
    bytes.fill(9)

    let settled = false
    const writing = writer.write(bytes).then(() => {
      settled = true
    })
    await tick()
    expect(settled).toBe(false)
    expect(utility.port.sent).toHaveLength(1)
    expect(utility.port.sent[0]).toMatchObject({
      type: 'data',
      seq: 0,
      bytes: expect.objectContaining({
        byteLength: DEEPSEEK_HARNESS_MAX_CHUNK_BYTES
      })
    })

    const reader = host.stdin.getReader()
    expect((await reader.read()).value).toHaveLength(
      DEEPSEEK_HARNESS_MAX_CHUNK_BYTES
    )
    await tick()
    expect(utility.port.sent).toHaveLength(2)
    expect(utility.port.sent[1]).toMatchObject({
      type: 'data',
      seq: 1,
      bytes: Uint8Array.of(9, 9, 9)
    })
    expect((await reader.read()).value).toEqual(Uint8Array.of(9, 9, 9))
    await writing
    expect(settled).toBe(true)
  })

  it('applies bounded receiver backpressure until the queued chunk is read', async () => {
    const { child, host, utility } = setup()
    const writer = child.stdin.getWriter()
    await writer.write(Uint8Array.of(1))

    let secondSettled = false
    const second = writer.write(Uint8Array.of(2)).then(() => {
      secondSettled = true
    })
    await tick()
    expect(secondSettled).toBe(false)
    expect(utility.port.sent).toHaveLength(2)

    const reader = host.stdin.getReader()
    await expect(reader.read()).resolves.toMatchObject({
      value: Uint8Array.of(1)
    })
    await tick()
    await second
    expect(secondSettled).toBe(true)
  })

  it.each([
    ['unknown message', { surprise: true }],
    [
      'unknown type',
      {
        protocol: DEEPSEEK_HARNESS_BYTE_PROTOCOL,
        version: DEEPSEEK_HARNESS_BYTE_PROTOCOL_VERSION,
        type: 'wat'
      }
    ],
    [
      'extra field',
      {
        protocol: DEEPSEEK_HARNESS_BYTE_PROTOCOL,
        version: DEEPSEEK_HARNESS_BYTE_PROTOCOL_VERSION,
        type: 'ack',
        stream: 'stdin',
        seq: 0,
        extra: true
      }
    ],
    [
      'oversized chunk',
      {
        protocol: DEEPSEEK_HARNESS_BYTE_PROTOCOL,
        version: DEEPSEEK_HARNESS_BYTE_PROTOCOL_VERSION,
        type: 'data',
        stream: 'stdout',
        seq: 0,
        bytes: new Uint8Array(DEEPSEEK_HARNESS_MAX_CHUNK_BYTES + 1)
      }
    ]
  ])('fails closed for %s without including payloads in errors', async (_, message) => {
    const { child, utility } = setup()
    const reader = child.stdout.getReader()
    utility.emitMessage(message)

    await expect(reader.read()).rejects.toThrow(
      'DeepSeek Harness byte transport failed (PROTOCOL_VIOLATION)'
    )
    expect(utility.kill).toHaveBeenCalledTimes(1)
    expect(String(await reader.closed.catch((error) => error))).not.toContain(
      'surprise'
    )
  })

  it('fails closed for duplicate and out-of-order sequence numbers', async () => {
    const first = setup()
    first.utility.emitMessage({
      protocol: DEEPSEEK_HARNESS_BYTE_PROTOCOL,
      version: DEEPSEEK_HARNESS_BYTE_PROTOCOL_VERSION,
      type: 'data',
      stream: 'stdout',
      seq: 1,
      bytes: Uint8Array.of(1)
    })
    await expect(first.child.stdout.getReader().read()).rejects.toThrow(
      'PROTOCOL_VIOLATION'
    )
    expect(first.utility.kill).toHaveBeenCalledOnce()

    const second = setup()
    const reader = second.child.stdout.getReader()
    second.utility.emitMessage({
      protocol: DEEPSEEK_HARNESS_BYTE_PROTOCOL,
      version: DEEPSEEK_HARNESS_BYTE_PROTOCOL_VERSION,
      type: 'data',
      stream: 'stdout',
      seq: 0,
      bytes: Uint8Array.of(1)
    })
    await reader.read()
    second.utility.emitMessage({
      protocol: DEEPSEEK_HARNESS_BYTE_PROTOCOL,
      version: DEEPSEEK_HARNESS_BYTE_PROTOCOL_VERSION,
      type: 'data',
      stream: 'stdout',
      seq: 0,
      bytes: Uint8Array.of(1)
    })
    await expect(reader.read()).rejects.toThrow('PROTOCOL_VIOLATION')
    expect(second.utility.kill).toHaveBeenCalledOnce()
  })

  it('propagates close and cancellation idempotently', async () => {
    const { child, host, utility } = setup()
    const writer = child.stdin.getWriter()
    const reader = host.stdin.getReader()
    const closing = writer.close()
    await expect(reader.read()).resolves.toEqual({
      done: true,
      value: undefined
    })
    await closing

    const childOutput = child.stdout.getReader()
    await childOutput.cancel()
    const hostWriter = host.stdout.getWriter()
    await expect(hostWriter.write(Uint8Array.of(8))).rejects.toThrow(
      'REMOTE_CANCELLED'
    )

    child.terminate()
    child.terminate()
    expect(utility.kill).toHaveBeenCalledTimes(1)
  })

  it('cancels a chunk waiting behind the bounded readable queue', async () => {
    const { child, host } = setup()
    const writer = child.stdin.getWriter()
    await writer.write(Uint8Array.of(1))
    const pendingWrite = writer.write(Uint8Array.of(2))
    await tick()

    await host.stdin.cancel()
    await expect(pendingWrite).rejects.toThrow('REMOTE_CANCELLED')
  })
})
