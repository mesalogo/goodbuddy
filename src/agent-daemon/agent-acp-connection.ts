import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type InitializeRequest,
  type InitializeResponse
} from '@agentclientprotocol/sdk'
import type { RuntimeAcpProcessOwner } from './runtime-acp-backend'

/** One decoder and handshake per native process, with Session-scoped clients. */
export class AgentAcpConnection {
  readonly connection: ClientSideConnection
  readonly exited: Promise<never>
  private initialization?: Promise<InitializeResponse>
  private readonly sessions = new Map<string, Client>()
  private readonly unsubscribeOutput: () => void
  private readonly unsubscribeExit: () => void
  private closed = false
  private closeInput?: () => void
  private bridgeOrigin?: string

  constructor(
    process: RuntimeAcpProcessOwner,
    fallback?: () => Client,
    createConnection?: (client: () => Client, stream: ReturnType<typeof ndJsonStream>) => ClientSideConnection
  ) {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let rejectExit!: (error: Error) => void
    this.exited = new Promise<never>((_resolve, reject) => { rejectExit = reject })
    void this.exited.catch(() => undefined)
    const input = new ReadableStream<Uint8Array>({
      start(value) { controller = value }
    })
    this.closeInput = () => {
      controller?.close()
      controller = undefined
    }
    this.unsubscribeOutput = process.subscribeOutput((output) => {
      if (!this.closed && output.stream === 'stdout' && output.data.byteLength > 0) {
        controller?.enqueue(output.data.slice())
      }
    }) ?? (() => undefined)
    this.unsubscribeExit = process.subscribeExit?.(() => {
      if (this.closed) return
      const error = new Error('ACP Runtime process exited')
      controller?.error(error)
      controller = undefined
      rejectExit(error)
    }) ?? (() => undefined)
    const output = new WritableStream<Uint8Array>({
      write: async (data) => { await process.writeStdin(data) }
    })
    const client = (): Client => ({
      sessionUpdate: async (notification) => {
        await (this.sessions.get(notification.sessionId) ?? fallback?.())
          ?.sessionUpdate(notification)
      },
      requestPermission: async (request) =>
        await (this.sessions.get(request.sessionId) ?? fallback?.())
          ?.requestPermission(request) ?? { outcome: { outcome: 'cancelled' } },
      extMethod: async () => ({}),
      extNotification: async (method, params) => {
        if (
          method === 'goodbuddy/modelBridgeReady' &&
          typeof params.origin === 'string' &&
          /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}$/u.test(params.origin)
        ) this.bridgeOrigin = params.origin
      }
    })
    const stream = ndJsonStream(output, input)
    this.connection = createConnection?.(client, stream) ?? new ClientSideConnection(client, stream)
  }

  initialize(request: InitializeRequest): Promise<InitializeResponse> {
    return this.initialization ??= this.connection.initialize(request)
  }

  register(sessionId: string, client: Client): () => void {
    if (this.sessions.has(sessionId)) throw new Error('ACP Session already has an owner')
    this.sessions.set(sessionId, client)
    return () => {
      if (this.sessions.get(sessionId) === client) this.sessions.delete(sessionId)
    }
  }

  async setModelRoute(
    sessionId: string,
    operationId: string,
    socketPath?: string,
    workMode?: 'ask' | 'execute',
    imageToolName?: string
  ): Promise<void> {
    if (!this.bridgeOrigin) throw new Error('Shared model bridge is not ready')
    const response = await fetch(`${this.bridgeOrigin}/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, operationId, ...(socketPath ? { socketPath, workMode, imageToolName } : { release: true }) }),
      signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) throw new Error(`Shared model bridge route failed (${response.status})`)
  }
  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.sessions.clear()
    this.unsubscribeOutput()
    this.unsubscribeExit()
    this.closeInput?.()
  }
}
