import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROTOCOL_VERSION,
  type AgentFrame,
  daemonStatusSchema
} from '../shared/agent-protocol'
import { AgentProtocolServer } from './protocol-server'
import { AgentDaemon } from './daemon'
import { EventJournal } from './event-journal'
import { PrivateEndpoint } from './private-endpoint'
import { WorkspaceRegistry } from './workspace-registry'

const digest = `sha256:${'a'.repeat(64)}`
const temporaryPaths: string[] = []
const nativePlatform = process.platform
let originalPlatform: PropertyDescriptor | undefined

beforeEach(() => {
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  let firstRead = true
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    get() {
      if (nativePlatform === 'linux') {
        return nativePlatform
      }
      if (firstRead) {
        firstRead = false
        return 'linux'
      }
      return nativePlatform
    }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalPlatform !== undefined) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('Agent daemon lifecycle', () => {
  it('returns the strict manifest-bound Linux daemon status', () => {
    const daemon = daemonForTest()
    const status = daemonStatusSchema.parse(daemon.status())

    expect(status).toEqual({
      state: 'offline',
      installationId: 'installation-a',
      binaryDigest: digest,
      daemonBootId: expect.stringMatching(/^boot-/u),
      agentVersion: '0.11.0',
      protocol: AGENT_PROTOCOL_VERSION,
      platform: 'linux',
      architecture: process.arch === 'arm64' ? 'arm64' : 'x64',
      supervisor: 'detached-on-demand',
      remoteUserIdentity:
        process.getuid === undefined
          ? 'uid:unavailable'
          : `uid:${process.getuid()}`,
      draining: false
    })
    expect(Object.keys(status).sort()).toEqual([
      'agentVersion',
      'architecture',
      'binaryDigest',
      'daemonBootId',
      'draining',
      'installationId',
      'platform',
      'protocol',
      'remoteUserIdentity',
      'state',
      'supervisor'
    ])
  })

  it('does not schedule unused generic journal maintenance', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    vi.spyOn(PrivateEndpoint.prototype, 'listen').mockResolvedValue()
    vi.spyOn(PrivateEndpoint.prototype, 'close').mockResolvedValue()
    const daemon = daemonForTest()

    await daemon.start()
    expect(setIntervalSpy).not.toHaveBeenCalled()
    await daemon.stop()
  })

  it('retires workspace handles before closing journals', async () => {
    vi.spyOn(PrivateEndpoint.prototype, 'listen').mockResolvedValue()
    vi.spyOn(PrivateEndpoint.prototype, 'close').mockResolvedValue()
    const closeWorkspaces = vi.spyOn(
      WorkspaceRegistry.prototype,
      'closeAll'
    )
    const closeEvents = vi.spyOn(EventJournal.prototype, 'close')
    const daemon = daemonForTest()

    await daemon.start()
    await daemon.stop()

    expect(closeWorkspaces).toHaveBeenCalledOnce()
    expect(closeEvents).toHaveBeenCalledOnce()
    expect(closeWorkspaces.mock.invocationCallOrder[0]).toBeLessThan(
      closeEvents.mock.invocationCallOrder[0]!
    )
  })

  it('keeps injected Runtime methods in their protocol namespace', async () => {
    vi.spyOn(PrivateEndpoint.prototype, 'listen').mockResolvedValue()
    vi.spyOn(PrivateEndpoint.prototype, 'close').mockResolvedValue()
    const daemon = daemonForTest({
      runtimeProtocol: {
        runtimes: () => [],
        methods: {
          'agent/status': () => null
        },
        onAcpFrame: async () => {}
      }
    })

    await expect(daemon.start()).rejects.toThrow(
      /runtime\/ namespace/iu
    )
    expect(daemon.status().state).toBe('offline')
  })

  it('routes factory Runtime output and disposes Runtime before journals', async () => {
    vi.spyOn(PrivateEndpoint.prototype, 'listen').mockResolvedValue()
    vi.spyOn(PrivateEndpoint.prototype, 'close').mockResolvedValue()
    const sendAcpFrame = vi
      .spyOn(AgentProtocolServer.prototype, 'sendAcpFrame')
      .mockResolvedValue()
    const dispose = vi.fn(async () => undefined)
    let outputSink:
      | Parameters<NonNullable<
          ConstructorParameters<typeof AgentDaemon>[0]['runtimeFactory']
        >>[0]['outputSink']
      | undefined
    const runtimeFactory = vi.fn(async (context) => {
      outputSink = context.outputSink
      return {
        runtimes: () => [],
        methods: Object.fromEntries(
          [
            'openAcpChannel',
            'closeAcpChannel',
            'preparePrompt',
            'getAcpCursors',
            'escalateCancellation',
            'reconcilePrompt'
          ].map((method) => [`runtime/${method}`, () => null])
        ),
        onAcpFrame: async () => {},
        dispose
      }
    })
    const daemon = daemonForTest({ runtimeFactory })

    await daemon.start()
    const frame = {
      header: {
        protocolMajor: 1,
        protocolMinor: 0,
        connectionId: 'connection-1',
        generation: 1,
        channelId: 'binding-1',
        channelEpoch: '1',
        direction: 'agent-to-main',
        sequence: '1',
        kind: 'acp',
        payloadLength: 2
      },
      payload: Buffer.from('ok')
    } satisfies AgentFrame
    await outputSink!(frame, {
      bindingId: 'binding-1',
      controllerId: 'controller-1',
      controllerGeneration: 1
    })
    expect(sendAcpFrame).toHaveBeenCalledWith(frame)

    await daemon.stop()
    expect(runtimeFactory).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })
})

function daemonForTest(
  overrides: Partial<ConstructorParameters<typeof AgentDaemon>[0]> = {}
): AgentDaemon {
  const root = mkdtempSync(join(tmpdir(), 'goodbuddy-daemon-'))
  chmodSync(root, 0o700)
  temporaryPaths.push(root)
  return new AgentDaemon({
    installationId: 'installation-a',
    binaryDigest: digest,
    agentVersion: '0.11.0',
    protocol: AGENT_PROTOCOL_VERSION,
    stateDirectory: resolve(root, 'state'),
    socketPath: resolve(root, 'runtime', 'agent.sock'),
    peerIdentityProvider: {
      async getPeerIdentity() {
        return { uid: 1 }
      }
    },
    ...overrides
  })
}
