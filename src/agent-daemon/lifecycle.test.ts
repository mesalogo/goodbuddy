import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createConnection, createServer, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_PROTOCOL_VERSION } from '../shared/agent-protocol/contracts'
import {
  decodeAgentFrame,
  encodeAgentFrame
} from '../shared/agent-protocol/frame'
import {
  ControllerRegistry,
  ControllerRegistryError
} from './controller-registry'
import { EventJournal } from './event-journal'
import { InstallationChallengeVerifier } from './installation-challenge'
import {
  ensurePrivateDirectory,
  ManagedPathError
} from './managed-paths'
import { AgentProtocolServer } from './protocol-server'

const temporaryPaths: string[] = []
const digest = `sha256:${'a'.repeat(64)}`

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('managed daemon lifecycle', () => {
  it('creates private directories and rejects symlink-managed paths', () => {
    const root = temporaryDirectory()
    const privateDirectory = join(root, 'private')
    ensurePrivateDirectory(privateDirectory)
    if (process.platform !== 'win32') {
      expect(chmodMode(privateDirectory)).toBe(0o700)
    }
    const target = join(root, 'target')
    mkdirSync(target)
    const link = join(root, 'link')
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => ensurePrivateDirectory(resolve(link))).toThrow(ManagedPathError)
  })

  it('uses one-shot installation HMAC challenges', () => {
    let now = 10
    const verifier = new InstallationChallengeVerifier(Buffer.alloc(32, 7), {
      now: () => now,
      lifetimeMs: 100
    })
    const challenge = verifier.issue()
    expect(challenge.serverNonce).toMatch(/^[a-f0-9]{64}$/u)
    const response = verifier.createResponse({
      serverNonce: challenge.serverNonce,
      clientNonce: 'client-1',
      controllerId: 'controller-1'
    })
    expect(
      verifier.verify({
        serverNonce: challenge.serverNonce,
        clientNonce: 'client-1',
        controllerId: 'controller-1',
        response
      })
    ).toBe(true)
    expect(
      verifier.verify({
        serverNonce: challenge.serverNonce,
        clientNonce: 'client-1',
        controllerId: 'controller-1',
        response
      })
    ).toBe(false)
    const expired = verifier.issue()
    now = 111
    expect(
      verifier.verify({
        serverNonce: expired.serverNonce,
        clientNonce: 'client-1',
        controllerId: 'controller-1',
        response: verifier.createResponse({
          serverNonce: expired.serverNonce,
          clientNonce: 'client-1',
          controllerId: 'controller-1'
        })
      })
    ).toBe(false)
  })

  it('persists generations and enforces controller ownership', () => {
    const root = privateTemporaryDirectory()
    const registryPath = resolve(root, 'controllers.json')
    const first = new ControllerRegistry({ storagePath: registryPath })
    const attached = first.attach('controller-a')
    first.claim(
      attached.controllerId,
      attached.generation,
      'process',
      'process-a'
    )
    const second = new ControllerRegistry({ storagePath: registryPath })
    const resumed = second.attach('controller-a')
    expect(resumed.generation).toBe(attached.generation + 1)
    expect(() =>
      second.assertCurrent('controller-a', attached.generation)
    ).toThrow(ControllerRegistryError)
    expect(() =>
      second.assertOwner(
        'controller-b',
        resumed.generation,
        'process',
        'process-a'
      )
    ).toThrow(ControllerRegistryError)
    expect(() =>
      second.assertOwner(
        'controller-a',
        resumed.generation,
        'process',
        'process-a'
      )
    ).not.toThrow()
  })

  it('frames attach control requests with stale-generation rejection', async () => {
    const root = privateTemporaryDirectory()
    const events = new EventJournal(resolve(root, 'events.sqlite'))
    const controllers = new ControllerRegistry()
    const controller = controllers.attach('controller-a')
    const protocol = new AgentProtocolServer({
      controllers,
      events,
      status: () => ({
        state: 'ready',
        installationId: 'install-1',
        binaryDigest: digest,
        daemonBootId: 'boot-1',
        agentVersion: '1.0.0',
        protocol: AGENT_PROTOCOL_VERSION,
        platform: 'linux',
        architecture: 'x64',
        supervisor: 'detached-on-demand',
        remoteUserIdentity: 'uid:1000',
        draining: false
      })
    })
    const server = createServer((socket) => protocol.accept(socket, controller))
    await listen(server)
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('Test server did not open a TCP endpoint')
    }
    const client = createConnection(address.port, '127.0.0.1')
    try {
      await onceConnected(client)
      const payload = Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'agent/status',
          params: {}
        })
      )
      client.write(
        encodeAgentFrame({
          header: {
            protocolMajor: AGENT_PROTOCOL_VERSION.major,
            protocolMinor: AGENT_PROTOCOL_VERSION.minor,
            connectionId: controller.connectionId,
            generation: controller.generation,
            channelId: 'control',
            channelEpoch: '1',
            direction: 'main-to-agent',
            sequence: '1',
            kind: 'control',
            payloadLength: payload.byteLength
          },
          payload
        })
      )
      const replies = await readFrames(client, 2)
      expect(
        JSON.parse(Buffer.from(replies[0]!.payload).toString('utf8'))
      ).toMatchObject({
        id: 1,
        result: {
          state: 'ready',
          installationId: 'install-1',
          binaryDigest: digest
        }
      })

      controllers.attach('controller-a')
      client.write(
        encodeAgentFrame({
          header: {
            protocolMajor: AGENT_PROTOCOL_VERSION.major,
            protocolMinor: AGENT_PROTOCOL_VERSION.minor,
            connectionId: controller.connectionId,
            generation: controller.generation,
            channelId: 'control',
            channelEpoch: '1',
            direction: 'main-to-agent',
            sequence: '2',
            kind: 'control',
            payloadLength: payload.byteLength
          },
          payload
        })
      )
      await onceClosed(client)
    } finally {
      client.destroy()
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose())
      )
      events.close()
    }
  })
})

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'goodbuddy-agent-'))
  temporaryPaths.push(path)
  return path
}

function privateTemporaryDirectory(): string {
  const path = temporaryDirectory()
  if (process.platform !== 'win32') {
    chmodSync(path, 0o700)
  }
  return path
}

function chmodMode(path: string): number {
  const descriptor = openSync(path, 'r')
  try {
    return fstatSync(descriptor).mode & 0o777
  } finally {
    closeSync(descriptor)
  }
}

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
}

async function onceConnected(socket: Socket): Promise<void> {
  await new Promise<void>((resolveConnect, reject) => {
    socket.once('connect', resolveConnect)
    socket.once('error', reject)
  })
}

async function onceClosed(socket: Socket): Promise<void> {
  await new Promise<void>((resolveClose) => socket.once('close', resolveClose))
}

async function readFrames(
  socket: Socket,
  count: number
): Promise<ReturnType<typeof decodeAgentFrame>[]> {
  return await new Promise((resolveFrames, reject) => {
    let buffer = Buffer.alloc(0)
    const frames: ReturnType<typeof decodeAgentFrame>[] = []
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.byteLength >= 40) {
        const length =
          40 +
          buffer.readUInt16BE(32) +
          buffer.readUInt16BE(34) +
          buffer.readUInt32BE(36)
        if (buffer.byteLength < length) {
          break
        }
        frames.push(decodeAgentFrame(buffer.subarray(0, length)))
        buffer = buffer.subarray(length)
      }
      if (frames.length >= count) {
        resolveFrames(frames)
      }
    })
    socket.once('error', reject)
  })
}
