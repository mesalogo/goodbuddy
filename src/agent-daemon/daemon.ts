import { randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { arch } from 'node:os'
import {
  daemonStatusSchema,
  agentIdentifierSchema,
  AGENT_PROTOCOL_FAILURE_RECORD_NAME,
  agentProtocolFailureRecordSchema,
  protocolVersionSchema,
  sha256DigestSchema
} from '../shared/agent-protocol'
import type {
  DaemonStatus,
  AttachPreface,
  DaemonCapabilities,
  AgentFrame
} from '../shared/agent-protocol'
import { ControllerRegistry } from './controller-registry'
import { EventJournal } from './event-journal'
import { InstallationChallengeVerifier } from './installation-challenge'
import {
  ensurePrivateDirectory,
  ensurePrivateDirectoryTree,
  readOrCreatePrivateSecret,
  writePrivateFileAtomic
} from './managed-paths'
import {
  PrivateEndpoint,
  type UnixPeerIdentityProvider
} from './private-endpoint'
import {
  AgentProtocolServer,
  type ProtocolMethodHandler
} from './protocol-server'
import { AgentUnsupportedError } from './errors'
import { WorkspaceGitService } from './workspace-git-service'
import { createWorkspaceProtocolMethods } from './workspace-protocol-methods'
import { WorkspaceRegistry } from './workspace-registry'

export type AgentDaemonOptions = {
  installationId: string
  binaryDigest: string
  agentVersion: string
  protocol: AttachPreface['protocol']
  stateDirectory: string
  socketPath: string
  peerIdentityProvider: UnixPeerIdentityProvider
  now?: () => number
  gitExecutable?: string
  workspaceRequestTimeoutMs?: number
  runtimeProtocol?: {
    runtimes: () =>
      | DaemonCapabilities['runtimes']
      | Promise<DaemonCapabilities['runtimes']>
    methods: Readonly<Record<string, ProtocolMethodHandler>>
    onAcpFrame: NonNullable<ConstructorParameters<
      typeof AgentProtocolServer
    >[0]['onAcpFrame']>
    onBlobFrame?: NonNullable<ConstructorParameters<
      typeof AgentProtocolServer
    >[0]['onBlobFrame']>
    authorizeBlobFrame?: NonNullable<ConstructorParameters<
      typeof AgentProtocolServer
    >[0]['authorizeBlobFrame']>
    dispose?: () => void | Promise<void>
  }
  runtimeFactory?: (context: {
    events: EventJournal
    workspaces: WorkspaceRegistry
    outputSink: (
      frame: AgentFrame,
      context: {
        bindingId: string
        controllerId: string
        controllerGeneration: number
      }
    ) => void | Promise<void>
    blobSink: (
      frame: AgentFrame,
      context: {
        bindingId: string
        controllerId: string
        controllerGeneration: number
      }
    ) => void | Promise<void>
  }) =>
    | AgentDaemonOptions['runtimeProtocol']
    | undefined
    | Promise<AgentDaemonOptions['runtimeProtocol'] | undefined>
  reportError?: (message: string, error: unknown) => void
}

export type AgentDaemonStatus = DaemonStatus

export class AgentDaemon {
  readonly #installationId: string
  readonly #binaryDigest: string
  readonly #agentVersion: string
  readonly #protocol: AttachPreface['protocol']
  readonly #architecture: 'x64' | 'arm64'
  readonly #remoteUserIdentity: string
  readonly #stateDirectory: string
  readonly #socketPath: string
  readonly #bootId = `boot-${randomBytes(18).toString('base64url')}`
  readonly #peerIdentityProvider: UnixPeerIdentityProvider
  readonly #now: () => number
  readonly #gitExecutable?: string
  readonly #workspaceRequestTimeoutMs?: number
  readonly #runtimeProtocol?: AgentDaemonOptions['runtimeProtocol']
  readonly #runtimeFactory?: AgentDaemonOptions['runtimeFactory']
  readonly #reportError: (message: string, error: unknown) => void
  #state: 'starting' | 'ready' | 'stopped' = 'stopped'
  #endpoint?: PrivateEndpoint
  #events?: EventJournal
  #workspaces?: WorkspaceRegistry
  #activeRuntimeProtocol?: AgentDaemonOptions['runtimeProtocol']

  constructor(options: AgentDaemonOptions) {
    this.#installationId = agentIdentifierSchema.parse(options.installationId)
    this.#binaryDigest = sha256DigestSchema.parse(options.binaryDigest)
    this.#agentVersion =
      daemonStatusSchema.shape.agentVersion.parse(options.agentVersion)
    this.#protocol = protocolVersionSchema.parse(options.protocol)
    const hostArchitecture = arch()
    if (hostArchitecture !== 'x64' && hostArchitecture !== 'arm64') {
      throw new AgentUnsupportedError(
        `GoodBuddy Agent architecture is unsupported: ${hostArchitecture}`,
        'platform-incompatible'
      )
    }
    this.#architecture = hostArchitecture
    this.#remoteUserIdentity = agentIdentifierSchema.parse(
      process.getuid === undefined
        ? 'uid:unavailable'
        : `uid:${process.getuid()}`
    )
    this.#stateDirectory = resolve(options.stateDirectory)
    this.#socketPath = resolve(options.socketPath)
    this.#peerIdentityProvider = options.peerIdentityProvider
    this.#now = options.now ?? Date.now
    this.#gitExecutable = options.gitExecutable
    this.#workspaceRequestTimeoutMs = options.workspaceRequestTimeoutMs
    this.#runtimeProtocol = options.runtimeProtocol
    this.#runtimeFactory = options.runtimeFactory
    if (
      this.#runtimeProtocol !== undefined &&
      this.#runtimeFactory !== undefined
    ) {
      throw new Error(
        'Agent daemon accepts either Runtime protocol or Runtime factory'
      )
    }
    this.#reportError =
      options.reportError ??
      ((message, error) => {
        console.error(message, error)
      })
  }

  status(): AgentDaemonStatus {
    return daemonStatusSchema.parse({
      state: this.#state === 'stopped' ? 'offline' : this.#state,
      installationId: this.#installationId,
      binaryDigest: this.#binaryDigest,
      daemonBootId: this.#bootId,
      agentVersion: this.#agentVersion,
      protocol: this.#protocol,
      platform: 'linux',
      architecture: this.#architecture,
      supervisor: 'detached-on-demand',
      remoteUserIdentity: this.#remoteUserIdentity,
      draining: false
    })
  }

  async start(): Promise<void> {
    if (process.platform !== 'linux') {
      throw new AgentUnsupportedError(
        'GoodBuddy Agent daemon is certified only on Linux',
        'platform-incompatible'
      )
    }
    if (this.#state !== 'stopped') {
      throw new Error('GoodBuddy Agent daemon is already started')
    }
    this.#state = 'starting'
    try {
      ensurePrivateDirectory(this.#stateDirectory)
      ensurePrivateDirectoryTree(
        resolve(this.#stateDirectory, 'journal'),
        this.#stateDirectory
      )
      ensurePrivateDirectory(dirname(this.#socketPath))
      const secret = readOrCreatePrivateSecret(
        resolve(this.#stateDirectory, 'installation-identity')
      )
      const controllers = new ControllerRegistry({
        now: this.#now,
        storagePath: resolve(this.#stateDirectory, 'controllers.json')
      })
      this.#events = new EventJournal(
        resolve(this.#stateDirectory, 'journal', 'events.sqlite'),
        { now: this.#now }
      )
      const git = new WorkspaceGitService({
        ...(this.#gitExecutable === undefined
          ? {}
          : { gitExecutable: this.#gitExecutable })
      })
      this.#workspaces = new WorkspaceRegistry({
        controllers,
        now: this.#now,
        storagePath: resolve(
          this.#stateDirectory,
          'workspaces.json'
        ),
        inspectGit: async (access, io) => await git.inspect(access, io)
      })
      const workspaceMethods = createWorkspaceProtocolMethods({
        workspaces: this.#workspaces,
        git,
        ...(this.#workspaceRequestTimeoutMs === undefined
          ? {}
          : {
              requestTimeoutMs:
                this.#workspaceRequestTimeoutMs
            })
      })
      const protocolBox: {
        current?: AgentProtocolServer
      } = {}
      this.#activeRuntimeProtocol =
        this.#runtimeProtocol ??
        await this.#runtimeFactory?.({
          events: this.#events,
          workspaces: this.#workspaces,
          outputSink: async (frame) => {
            if (protocolBox.current === undefined) {
              throw new Error(
                'Agent Runtime output sink is not ready'
              )
            }
            await protocolBox.current.sendAcpFrame(frame)
          },
          blobSink: async (frame) => {
            if (protocolBox.current === undefined) {
              throw new Error(
                'Agent Runtime blob sink is not ready'
              )
            }
            await protocolBox.current.sendBlobFrame(frame)
          }
        })
      const protocol = new AgentProtocolServer({
        controllers,
        events: this.#events,
        status: () => this.status(),
        ...(this.#activeRuntimeProtocol === undefined
          ? {}
          : {
              runtimes: this.#activeRuntimeProtocol.runtimes,
              onAcpFrame: this.#activeRuntimeProtocol.onAcpFrame,
              ...(this.#activeRuntimeProtocol.onBlobFrame === undefined
                ? {}
                : {
                    onBlobFrame:
                      this.#activeRuntimeProtocol.onBlobFrame
                  }),
              ...(this.#activeRuntimeProtocol.authorizeBlobFrame === undefined
                ? {}
                : {
                    authorizeBlobFrame:
                      this.#activeRuntimeProtocol.authorizeBlobFrame
                  })
            }),
        onProtocolFailure: ({
          connectionId,
          category
        }) => {
          try {
            writePrivateFileAtomic(
              resolve(
                this.#stateDirectory,
                AGENT_PROTOCOL_FAILURE_RECORD_NAME
              ),
              `${JSON.stringify(
                agentProtocolFailureRecordSchema.parse({
                  formatVersion: 1,
                  connectionId,
                  category,
                  createdAt: this.#now()
                })
              )}\n`
            )
          } catch (error) {
            this.#reportError(
              'Agent protocol failure category could not be persisted',
              error
            )
          }
        },
        methods: mergeProtocolMethods(
          workspaceMethods,
          this.#activeRuntimeProtocol?.methods
        )
      })
      protocolBox.current = protocol
      this.#endpoint = new PrivateEndpoint({
        socketPath: this.#socketPath,
        peerIdentity: this.#peerIdentityProvider,
        challenge: new InstallationChallengeVerifier(secret, {
          now: this.#now
        }),
        controllers,
        installationId: this.#installationId,
        binaryDigest: this.#binaryDigest,
        daemonBootId: this.#bootId,
        protocol: this.#protocol,
        onAttach: ({ socket, controller }) => {
          protocol.accept(socket, controller)
        }
      })
      await this.#endpoint.listen()
      this.#state = 'ready'
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    const endpoint = this.#endpoint
    const events = this.#events
    const workspaces = this.#workspaces
    const runtimeProtocol = this.#activeRuntimeProtocol
    this.#endpoint = undefined
    this.#events = undefined
    this.#workspaces = undefined
    this.#activeRuntimeProtocol = undefined
    try {
      if (endpoint !== undefined) {
        await endpoint.close()
      }
    } finally {
      if (runtimeProtocol?.dispose !== undefined) {
        await Promise.resolve(runtimeProtocol.dispose()).catch(
          (error: unknown) => {
            this.#reportRuntimeShutdownError(error)
          }
        )
      }
      workspaces?.closeAll()
      events?.close()
      this.#state = 'stopped'
    }
  }

  #reportRuntimeShutdownError(error: unknown): void {
    try {
      this.#reportError('Agent Runtime shutdown failed', error)
    } catch (reportError) {
      console.error(
        'Agent Runtime shutdown failure reporting failed',
        reportError,
        error
      )
    }
  }

}

function mergeProtocolMethods(
  workspaceMethods: Readonly<Record<string, ProtocolMethodHandler>>,
  runtimeMethods:
    | Readonly<Record<string, ProtocolMethodHandler>>
    | undefined
): Readonly<Record<string, ProtocolMethodHandler>> {
  if (runtimeMethods === undefined) {
    return workspaceMethods
  }
  for (const method of Object.keys(runtimeMethods)) {
    if (!method.startsWith('runtime/')) {
      throw new Error(
        `Runtime protocol method must use the runtime/ namespace: ${method}`
      )
    }
    if (workspaceMethods[method] !== undefined) {
      throw new Error(
        `Runtime protocol method conflicts with a Workspace method: ${method}`
      )
    }
  }
  return { ...workspaceMethods, ...runtimeMethods }
}

export class UnsupportedPeerIdentityProvider
  implements UnixPeerIdentityProvider
{
  async getPeerIdentity(): Promise<never> {
    throw new AgentUnsupportedError(
      'A certified SO_PEERCRED helper is unavailable',
      'peer-identity-unavailable'
    )
  }
}
