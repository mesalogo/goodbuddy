import {
  chmodSync,
  mkdtempSync,
  rmSync
} from 'node:fs'
import {
  createConnection,
  createServer,
  type Socket
} from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROTOCOL_VERSION,
  attachWelcomeSchema,
  daemonCapabilitiesSchema,
  daemonStatusSchema
} from '../shared/agent-protocol'
import {
  decodeAgentFrame,
  encodeAgentFrame,
  type AgentFrame
} from '../shared/agent-protocol/frame'
import { ControllerRegistry } from './controller-registry'
import { EventJournal } from './event-journal'
import { InstallationChallengeVerifier } from './installation-challenge'
import {
  attachRelay,
  PrivateEndpoint,
  type PeerIdentity
} from './private-endpoint'
import { AgentProtocolServer } from './protocol-server'

const runOnUnix = process.platform !== 'win32' ? it : it.skip
const temporaryPaths: string[] = []
const binaryDigest = `sha256:${'a'.repeat(64)}`
const endpointIdentity = {
  installationId: 'installation-a',
  binaryDigest,
  daemonBootId: 'boot-a',
  protocol: AGENT_PROTOCOL_VERSION
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('private endpoint lifecycle', () => {
  runOnUnix(
    'never pre-unlinks an endpoint that may still be live',
    async () => {
      const root = privateTemporaryDirectory()
      const socketPath = resolve(root, 'agent.sock')
      const existing = createServer()
      await new Promise<void>((resolveListen, reject) => {
        existing.once('error', reject)
        existing.listen(socketPath, resolveListen)
      })
      const endpoint = new PrivateEndpoint({
        socketPath,
        peerIdentity: currentPeerIdentity(),
        challenge: new InstallationChallengeVerifier(Buffer.alloc(32, 7)),
        controllers: new ControllerRegistry(),
        ...endpointIdentity,
        onAttach: vi.fn()
      })

      await expect(endpoint.listen()).rejects.toMatchObject({
        code: 'EADDRINUSE'
      })
      const client = createConnection(socketPath)
      await expect(onceConnected(client)).resolves.toBeUndefined()
      client.destroy()
      await new Promise<void>((resolveClose) =>
        existing.close(() => resolveClose())
      )
    }
  )

  runOnUnix(
    'destroys an authenticated persistent socket during shutdown',
    async () => {
      const root = privateTemporaryDirectory()
      const secret = Buffer.alloc(32, 7)
      const verifier = new InstallationChallengeVerifier(secret)
      const attached = vi.fn()
      const endpoint = new PrivateEndpoint({
        socketPath: resolve(root, 'agent.sock'),
        peerIdentity: currentPeerIdentity(),
        challenge: verifier,
        controllers: new ControllerRegistry(),
        ...endpointIdentity,
        onAttach: attached
      })
      await endpoint.listen()
      const client = createConnection(resolve(root, 'agent.sock'))
      await onceConnected(client)
      const challenge = await readPacket(client)
      const clientNonce = 'client-nonce'
      await writePacket(client, {
        type: 'response',
        version: 1,
        controllerId: 'controller-a',
        clientNonce,
        response: verifier.createResponse({
          serverNonce: String(challenge.serverNonce),
          clientNonce,
          controllerId: 'controller-a'
        }),
        protocol: AGENT_PROTOCOL_VERSION
      })
      const welcome = await readPacket(client)
      expect(attachWelcomeSchema.parse(welcome)).toEqual({
        type: 'goodbuddy-agent-welcome',
        protocol: AGENT_PROTOCOL_VERSION,
        connectionId: expect.any(String),
        generation: 1,
        ...endpointIdentity,
        serverNonce: challenge.serverNonce
      })
      await vi.waitFor(() => expect(attached).toHaveBeenCalledOnce())

      const closed = onceClosed(client)
      await expect(endpoint.close()).resolves.toBeUndefined()
      await closed
    }
  )

  runOnUnix(
    'settles a socket that is still resolving peer identity',
    async () => {
      const root = privateTemporaryDirectory()
      let resolvePeer: ((peer: PeerIdentity) => void) | undefined
      const peerIdentity = vi.fn(
        () =>
          new Promise<PeerIdentity>((resolveIdentity) => {
            resolvePeer = resolveIdentity
          })
      )
      const attached = vi.fn()
      const endpoint = new PrivateEndpoint({
        socketPath: resolve(root, 'agent.sock'),
        peerIdentity: { getPeerIdentity: peerIdentity },
        challenge: new InstallationChallengeVerifier(Buffer.alloc(32, 7)),
        controllers: new ControllerRegistry(),
        ...endpointIdentity,
        onAttach: attached
      })
      await endpoint.listen()
      const client = createConnection(resolve(root, 'agent.sock'))
      await onceConnected(client)
      await vi.waitFor(() => expect(peerIdentity).toHaveBeenCalledOnce())

      const closed = onceClosed(client)
      await expect(endpoint.close()).resolves.toBeUndefined()
      await closed
      resolvePeer?.({ uid: process.getuid!() })
      await Promise.resolve()
      expect(attached).not.toHaveBeenCalled()
    }
  )

  runOnUnix('rejects connections beyond the configured cap', async () => {
    const root = privateTemporaryDirectory()
    const peerIdentity = vi.fn(
      () => new Promise<PeerIdentity>(() => undefined)
    )
    const endpoint = new PrivateEndpoint({
      socketPath: resolve(root, 'agent.sock'),
      peerIdentity: { getPeerIdentity: peerIdentity },
      challenge: new InstallationChallengeVerifier(Buffer.alloc(32, 7)),
      controllers: new ControllerRegistry(),
      ...endpointIdentity,
      onAttach: vi.fn(),
      maximumConnections: 1
    })
    await endpoint.listen()
    const first = createConnection(resolve(root, 'agent.sock'))
    await onceConnected(first)
    await vi.waitFor(() => expect(peerIdentity).toHaveBeenCalledOnce())

    const second = createConnection(resolve(root, 'agent.sock'))
    const rejected = onceClosed(second)
    await onceConnected(second)
    await rejected
    expect(peerIdentity).toHaveBeenCalledOnce()

    await endpoint.close()
    first.destroy()
  })

  runOnUnix(
    'rejects malformed or client-extended authentication packets',
    async () => {
      const root = privateTemporaryDirectory()
      const endpoint = new PrivateEndpoint({
        socketPath: resolve(root, 'agent.sock'),
        peerIdentity: currentPeerIdentity(),
        challenge: new InstallationChallengeVerifier(Buffer.alloc(32, 7)),
        controllers: new ControllerRegistry(),
        ...endpointIdentity,
        onAttach: vi.fn()
      })
      await endpoint.listen()
      const client = createConnection(resolve(root, 'agent.sock'))
      await onceConnected(client)
      await readPacket(client)
      await writePacket(client, {
        type: 'response',
        version: 1,
        controllerId: 'controller-a',
        clientNonce: 'client-nonce',
        protocol: AGENT_PROTOCOL_VERSION,
        response: 'not-authenticated',
        installationId: 'client-claimed'
      })
      await onceClosed(client)
      await endpoint.close()
    }
  )

  runOnUnix(
    'relays a strict Main attach into real protocol status and capabilities',
    async () => {
      const root = privateTemporaryDirectory()
      const controllers = new ControllerRegistry()
      const events = new EventJournal(resolve(root, 'events.sqlite'))
      const status = {
        state: 'ready' as const,
        installationId: endpointIdentity.installationId,
        binaryDigest,
        daemonBootId: endpointIdentity.daemonBootId,
        agentVersion: '0.11.0',
        protocol: AGENT_PROTOCOL_VERSION,
        platform: 'linux' as const,
        architecture: 'x64' as const,
        supervisor: 'detached-on-demand' as const,
        remoteUserIdentity: `uid:${process.getuid!()}`,
        draining: false
      }
      const readMethods = Object.fromEntries(
        [
          'workspace/validate',
          'workspace/open',
          'workspace/resume',
          'workspace/close',
          'workspace/list',
          'workspace/stat',
          'workspace/readText',
          'workspace/search',
          'git/status',
          'git/diff'
        ].map((method) => [method, () => null])
      )
      const protocol = new AgentProtocolServer({
        controllers,
        events,
        status: () => status,
        methods: readMethods
      })
      const secret = Buffer.alloc(32, 7)
      const endpoint = new PrivateEndpoint({
        socketPath: resolve(root, 'agent.sock'),
        peerIdentity: currentPeerIdentity(),
        challenge: new InstallationChallengeVerifier(secret),
        controllers,
        ...endpointIdentity,
        onAttach: ({ socket, controller }) => {
          protocol.accept(socket, controller)
        }
      })
      await endpoint.listen()
      const input = new PassThrough()
      const output = new PassThrough()
      const relay = attachRelay({
        socketPath: resolve(root, 'agent.sock'),
        secret,
        input,
        output
      })
      writeStreamPacket(input, {
        type: 'goodbuddy-agent-attach',
        protocol: AGENT_PROTOCOL_VERSION,
        goodBuddyVersion: '0.11.0',
        controllerId: 'controller-main',
        clientNonce: 'main-client-nonce',
        hostRevision: 2,
        hostKeyGeneration: 3
      })
      const welcome = attachWelcomeSchema.parse(
        await readStreamPacket(output)
      )
      expect(welcome).toMatchObject({
        type: 'goodbuddy-agent-welcome',
        protocol: AGENT_PROTOCOL_VERSION,
        installationId: endpointIdentity.installationId,
        binaryDigest,
        daemonBootId: endpointIdentity.daemonBootId,
        generation: 1
      })

      input.write(
        controlRequest(welcome, 'status-channel', 1, 'agent/status')
      )
      const statusResponse = await readFrame(output)
      await readFrame(output)
      expect(
        daemonStatusSchema.parse(jsonRpcResult(statusResponse))
      ).toEqual(status)

      input.write(
        controlRequest(
          welcome,
          'capabilities-channel',
          2,
          'agent/capabilities'
        )
      )
      const capabilitiesResponse = await readFrame(output)
      await readFrame(output)
      expect(
        daemonCapabilitiesSchema.parse(
          jsonRpcResult(capabilitiesResponse)
        )
      ).toEqual({
        generation: welcome.generation,
        capabilities: [
          { name: 'agent/control', version: 1, critical: true },
          { name: 'workspace/read', version: 1, critical: true }
        ],
        runtimes: []
      })

      input.end()
      await relay
      await endpoint.close()
      events.close()
    }
  )
})

describe('attach relay preface validation', () => {
  it('rejects unknown Main preface fields before opening an endpoint', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    writeStreamPacket(input, {
      type: 'goodbuddy-agent-attach',
      protocol: AGENT_PROTOCOL_VERSION,
      goodBuddyVersion: '0.11.0',
      controllerId: 'controller-main',
      clientNonce: 'main-client-nonce',
      hostRevision: 2,
      hostKeyGeneration: 3,
      installationId: 'client-claimed'
    })
    await expect(
      attachRelay({
        socketPath: resolve('missing-agent.sock'),
        secret: Buffer.alloc(32, 7),
        input,
        output
      })
    ).rejects.toThrow()
  })

  it('rejects malformed and oversized Main prefaces deterministically', async () => {
    const malformed = new PassThrough()
    writeStreamPacket(malformed, {
      type: 'goodbuddy-agent-attach',
      protocol: { major: 1, minor: -1 }
    })
    await expect(
      attachRelay({
        socketPath: resolve('missing-agent.sock'),
        secret: Buffer.alloc(32, 7),
        input: malformed,
        output: new PassThrough()
      })
    ).rejects.toThrow()

    const oversized = new PassThrough()
    const length = Buffer.alloc(4)
    length.writeUInt32BE(4097)
    oversized.end(length)
    await expect(
      attachRelay({
        socketPath: resolve('missing-agent.sock'),
        secret: Buffer.alloc(32, 7),
        input: oversized,
        output: new PassThrough()
      })
    ).rejects.toThrow('oversized')
  })
})

function currentPeerIdentity(): {
  getPeerIdentity(): Promise<PeerIdentity>
} {
  return {
    async getPeerIdentity() {
      return { uid: process.getuid!() }
    }
  }
}

function privateTemporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'goodbuddy-endpoint-'))
  chmodSync(path, 0o700)
  temporaryPaths.push(path)
  return path
}

async function onceConnected(socket: Socket): Promise<void> {
  await new Promise<void>((resolveConnection, reject) => {
    socket.once('connect', resolveConnection)
    socket.once('error', reject)
  })
}

async function onceClosed(socket: Socket): Promise<void> {
  await new Promise<void>((resolveClose) => {
    socket.once('close', resolveClose)
  })
}

async function readPacket(socket: Socket): Promise<Record<string, unknown>> {
  const length = await readExactly(socket, 4)
  const contents = await readExactly(socket, length.readUInt32BE(0))
  return JSON.parse(contents.toString('utf8')) as Record<string, unknown>
}

async function writePacket(
  socket: Socket,
  value: Record<string, unknown>
): Promise<void> {
  const contents = Buffer.from(JSON.stringify(value), 'utf8')
  const packet = Buffer.allocUnsafe(contents.byteLength + 4)
  packet.writeUInt32BE(contents.byteLength, 0)
  contents.copy(packet, 4)
  await new Promise<void>((resolveWrite, reject) => {
    socket.write(packet, (error) => {
      if (error === null || error === undefined) {
        resolveWrite()
      } else {
        reject(error)
      }
    })
  })
}

async function readExactly(
  socket: NodeJS.ReadableStream & {
    read(size?: number): Buffer | string | null
  },
  byteLength: number
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let remaining = byteLength
  while (remaining > 0) {
    const chunk = socket.read(remaining)
    if (chunk !== null) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      chunks.push(bytes)
      remaining -= bytes.byteLength
      continue
    }
    await new Promise<void>((resolveRead, reject) => {
      socket.once('readable', resolveRead)
      socket.once('error', reject)
    })
  }
  return Buffer.concat(chunks, byteLength)
}

function writeStreamPacket(
  output: NodeJS.WritableStream,
  value: Record<string, unknown>
): void {
  const contents = Buffer.from(JSON.stringify(value), 'utf8')
  const packet = Buffer.allocUnsafe(contents.byteLength + 4)
  packet.writeUInt32BE(contents.byteLength, 0)
  contents.copy(packet, 4)
  output.write(packet)
}

async function readStreamPacket(
  input: PassThrough
): Promise<Record<string, unknown>> {
  const length = await readExactly(input, 4)
  const contents = await readExactly(input, length.readUInt32BE(0))
  return JSON.parse(contents.toString('utf8')) as Record<string, unknown>
}

function controlRequest(
  welcome: {
    connectionId: string
    generation: number
    protocol: { major: number; minor: number }
  },
  channelId: string,
  id: number,
  method: string
): Uint8Array {
  const payload = Buffer.from(
    JSON.stringify({ jsonrpc: '2.0', id, method, params: {} }),
    'utf8'
  )
  return encodeAgentFrame({
    header: {
      protocolMajor: welcome.protocol.major,
      protocolMinor: welcome.protocol.minor,
      connectionId: welcome.connectionId,
      generation: welcome.generation,
      channelId,
      channelEpoch: '1',
      direction: 'main-to-agent',
      sequence: '1',
      kind: 'control',
      payloadLength: payload.byteLength
    },
    payload
  })
}

async function readFrame(input: PassThrough): Promise<AgentFrame> {
  const header = await readExactly(input, 40)
  const connectionLength = header.readUInt16BE(32)
  const channelLength = header.readUInt16BE(34)
  const payloadLength = header.readUInt32BE(36)
  const remainder = await readExactly(
    input,
    connectionLength + channelLength + payloadLength
  )
  return decodeAgentFrame(Buffer.concat([header, remainder]))
}

function jsonRpcResult(frame: AgentFrame): unknown {
  const response = JSON.parse(
    Buffer.from(frame.payload).toString('utf8')
  ) as { result?: unknown }
  return response.result
}
