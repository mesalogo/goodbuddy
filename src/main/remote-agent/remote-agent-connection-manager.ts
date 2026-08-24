import { createHash, createHmac, randomBytes } from 'node:crypto'
import {
  AGENT_PROTOCOL_VERSION,
  agentCapabilitySchema,
  daemonCapabilitiesSchema,
  daemonStatusSchema,
  protocolVersionSchema,
  sha256DigestSchema,
  type DaemonCapabilities,
  type DaemonStatus
} from '../../shared/agent-protocol'
import type {
  SshConnectionLease,
  SshConnectionPoolTarget
} from '../ssh/ssh-connection-pool'
import {
  verifyAgentInstallationId,
  type VerifiedAgentInstallationId
} from '../ssh/ssh-agent-command'
import { defaultSystemAgent } from '../ssh/ssh-transport'
import { AgentAttachTransport } from './agent-attach-transport'
import {
  AgentProtocolClient,
  type AgentProtocolClientError
} from './agent-protocol-client'
import {
  ControllerStateStore,
  type ControllerAcpRecoveryBinding,
  type ControllerConnectionState
} from './controller-state-store'

const DEFAULT_IDLE_TIMEOUT_MS = 60_000
const DEFAULT_ATTACH_TIMEOUT_MS = 10_000
const MAXIMUM_CONNECTIONS = 32

export interface RemoteAgentTargetResolver {
  resolve(hostId: string): Promise<SshConnectionPoolTarget>
}

export interface RemoteAgentSshPool {
  acquire(
    target: SshConnectionPoolTarget,
    signal?: AbortSignal
  ): Promise<SshConnectionLease>
  disposeHost(hostId: string): void
}

export type RemoteAgentInstallationIdentity = {
  installationId: VerifiedAgentInstallationId
  binaryDigest: string
  agentVersion?: string
  protocol?: {
    major: number
    minor: number
  }
  platform: 'linux'
  architecture: 'x64' | 'arm64'
  supervisor: 'detached-on-demand'
  requiredCapabilities?: ReadonlyArray<{
    name: string
    minimumVersion?: number
    exactVersion?: number
    critical?: boolean
  }>
}

export type RemoteAgentConnectionIdentity = {
  cacheKey: string
  hostId: string
  hostRevision: number
  hostKeyGeneration: number
  remoteUsername: string
  installationId: string
  binaryDigest: string
  protocolMajor: number
  protocolMinor: number
}

export type RemoteAgentConnectionState =
  | 'connecting'
  | 'ready'
  | 'offline'
  | 'terminal'
  | 'disposed'

export interface RemoteAgentConnection {
  readonly identity: RemoteAgentConnectionIdentity
  readonly status: DaemonStatus
  readonly capabilities: DaemonCapabilities
  readonly client: AgentProtocolClient
  readonly state: RemoteAgentConnectionState
  refreshCapabilities(signal?: AbortSignal): Promise<DaemonCapabilities>
  reconnect(signal?: AbortSignal): Promise<void>
  onClientChange?(listener: () => void): () => void
  updateAcpBinding(
    bindingId: string,
    binding: ControllerAcpRecoveryBinding | undefined
  ): Promise<void>
  flushAcpBindings(): Promise<void>
  release(): void
}

export class RemoteAgentConnectionError extends Error {
  constructor(
    message: string,
    readonly disposition: 'transient' | 'terminal',
    readonly reason:
      | 'network'
      | 'host-invalidated'
      | 'host-identity'
      | 'authentication'
      | 'installation'
      | 'protocol'
      | 'daemon-status'
      | 'platform'
      | 'capability'
      | 'shutdown',
    readonly cause?: unknown
  ) {
    super(message)
    this.name = 'RemoteAgentConnectionError'
  }
}

type ActiveConnection = {
  sshLease: SshConnectionLease
  transport: AgentAttachTransport
  client: AgentProtocolClient
  status: DaemonStatus
  capabilities: DaemonCapabilities
  unsubscribeClose: () => void
}

type ConnectionEntry = {
  key: string
  stateKey: string
  hostId: string
  identity: RemoteAgentConnectionIdentity
  installation: RemoteAgentInstallationIdentity
  target: SshConnectionPoolTarget
  controller: AbortController
  connectPromise: Promise<ActiveConnection>
  reconnectPromise?: Promise<void>
  connection?: ActiveConnection
  connectionState: RemoteAgentConnectionState
  failure?: RemoteAgentConnectionError
  refs: number
  waiters: number
  idleTimer?: ReturnType<typeof setTimeout>
  clientChangeListeners: Set<() => void>
}

export class RemoteAgentConnectionManager {
  readonly #resolver: RemoteAgentTargetResolver
  readonly #sshPool: RemoteAgentSshPool
  readonly #controllerState: ControllerStateStore
  readonly #connectTransport: typeof AgentAttachTransport.connect
  readonly #createProtocolClient: (
    transport: AgentAttachTransport
  ) => AgentProtocolClient
  readonly #goodBuddyVersion: string
  readonly #idleTimeoutMs: number
  readonly #attachTimeoutMs: number
  readonly #identityKey = randomBytes(32)
  readonly #entries = new Map<string, ConnectionEntry>()
  #disposed = false

  constructor(options: {
    resolver: RemoteAgentTargetResolver
    sshPool: RemoteAgentSshPool
    controllerState: ControllerStateStore
    goodBuddyVersion: string
    idleTimeoutMs?: number
    attachTimeoutMs?: number
    connectTransport?: typeof AgentAttachTransport.connect
    createProtocolClient?: (
      transport: AgentAttachTransport
    ) => AgentProtocolClient
  }) {
    this.#resolver = options.resolver
    this.#sshPool = options.sshPool
    this.#controllerState = options.controllerState
    this.#connectTransport =
      options.connectTransport ?? AgentAttachTransport.connect
    this.#createProtocolClient =
      options.createProtocolClient ??
      ((transport) => new AgentProtocolClient(transport))
    this.#goodBuddyVersion = options.goodBuddyVersion
    this.#idleTimeoutMs =
      options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.#attachTimeoutMs =
      options.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS
    if (
      this.#goodBuddyVersion.length < 1 ||
      Buffer.byteLength(this.#goodBuddyVersion, 'utf8') > 64
    ) {
      throw new Error('Invalid GoodBuddy version for Agent attach')
    }
    if (
      !Number.isSafeInteger(this.#idleTimeoutMs) ||
      this.#idleTimeoutMs < 0 ||
      !Number.isSafeInteger(this.#attachTimeoutMs) ||
      this.#attachTimeoutMs < 1 ||
      this.#attachTimeoutMs > 60_000
    ) {
      throw new RangeError('Invalid remote Agent connection timeout')
    }
  }

  async acquire(
    hostId: string,
    installationInput: RemoteAgentInstallationIdentity,
    signal?: AbortSignal
  ): Promise<RemoteAgentConnection> {
    if (this.#disposed) {
      throw terminalError(
        'Remote Agent connection manager is closed',
        'shutdown'
      )
    }
    signal?.throwIfAborted()
    const installation = validateInstallation(installationInput)
    // One atomic resolver call supplies the complete current host target.
    const target = await this.#resolver.resolve(hostId)
    signal?.throwIfAborted()
    if (target.host.id !== hostId) {
      throw terminalError(
        'Resolved SSH Host identity does not match the request',
        'host-identity'
      )
    }
    const identity = this.#identity(target, installation)
    let entry = this.#entries.get(identity.cacheKey)
    if (entry === undefined) {
      if (this.#entries.size >= MAXIMUM_CONNECTIONS) {
        throw new RemoteAgentConnectionError(
          'Remote Agent connection cache is full',
          'transient',
          'network'
        )
      }
      const controller = new AbortController()
      entry = {
        key: identity.cacheKey,
        stateKey: recoveryStateKey(target, installation),
        hostId,
        identity,
        installation,
        target,
        controller,
        connectPromise: Promise.resolve(undefined as never),
        connectionState: 'connecting',
        refs: 0,
        waiters: 0,
        clientChangeListeners: new Set()
      }
      entry.connectPromise = this.#connect(entry, target, false)
      this.#entries.set(identity.cacheKey, entry)
    } else if (
      entry.connectionState === 'terminal' ||
      entry.connectionState === 'disposed'
    ) {
      throw (
        entry.failure ??
        terminalError('Remote Agent connection is not reusable', 'protocol')
      )
    }
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
    }
    entry.waiters += 1
    try {
      await waitForShared(entry.connectPromise, signal)
      if (
        this.#disposed ||
        this.#entries.get(entry.key) !== entry ||
        entry.connectionState !== 'ready'
      ) {
        throw new RemoteAgentConnectionError(
          'Remote Agent connection request became stale',
          'transient',
          'network'
        )
      }
      entry.refs += 1
      return this.#lease(entry)
    } finally {
      entry.waiters -= 1
      if (entry.waiters === 0 && entry.refs === 0) {
        if (entry.connectionState === 'connecting') {
          this.#disposeEntry(entry)
        } else {
          this.#scheduleIdle(entry)
        }
      }
    }
  }

  async invalidateHost(hostId: string): Promise<void> {
    for (const entry of [...this.#entries.values()]) {
      if (entry.hostId === hostId) {
        entry.failure = terminalError(
          'SSH Host was invalidated',
          'host-invalidated'
        )
        entry.connectionState = 'terminal'
        this.#disposeEntry(entry)
      }
    }
    this.#sshPool.disposeHost(hostId)
    await this.#controllerState.invalidateHost(hostId)
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return
    }
    this.#disposed = true
    for (const entry of [...this.#entries.values()]) {
      entry.failure = terminalError(
        'Remote Agent connection manager was shut down',
        'shutdown'
      )
      this.#disposeEntry(entry)
    }
    await this.#controllerState.flush()
    this.#controllerState.dispose()
  }

  async #connect(
    entry: ConnectionEntry,
    target: SshConnectionPoolTarget,
    requireExactResume: boolean
  ): Promise<ActiveConnection> {
    let sshLease: SshConnectionLease | undefined
    let transport: AgentAttachTransport | undefined
    let client: AgentProtocolClient | undefined
    const connectionTimer = setTimeout(() => {
      entry.controller.abort(
        new RemoteAgentConnectionError(
          'Remote Agent readiness handshake timed out',
          'transient',
          'network'
        )
      )
    }, this.#attachTimeoutMs)
    try {
      const controllerId =
        await this.#controllerState.getControllerId()
      sshLease = await this.#sshPool.acquire(
        target,
        entry.controller.signal
      )
      transport = await this.#connectTransport({
        sshLease,
        installationId: entry.installation.installationId,
        preface: {
          type: 'goodbuddy-agent-attach',
          protocol: protocolVersion(entry.installation),
          goodBuddyVersion: this.#goodBuddyVersion,
          controllerId,
          clientNonce: randomBytes(24).toString('base64url'),
          hostRevision: target.hostRevision,
          hostKeyGeneration: target.hostKeyGeneration
        },
        signal: entry.controller.signal,
        timeoutMs: this.#attachTimeoutMs
      })
      this.#validateWelcome(entry, transport)
      client = this.#createProtocolClient(transport)
      const status = daemonStatusSchema.parse(
        await client.request('agent/status', {})
      )
      const capabilities = daemonCapabilitiesSchema.parse(
        await client.request('agent/capabilities', {})
      )
      this.#validateDaemon(entry, transport, status, capabilities)
      let previous = await this.#controllerState.getConnection(
        entry.stateKey
      )
      if (previous !== undefined) {
        if (
          previous.daemonBootId ===
            transport.welcome.daemonBootId &&
          previous.capabilityGeneration === capabilities.generation
        ) {
          await this.#resume(
            client,
            previous,
            transport.welcome.daemonBootId,
            capabilities.generation
          )
        } else if (requireExactResume) {
          throw terminalError(
            previous.daemonBootId !==
              transport.welcome.daemonBootId
              ? 'Agent daemon boot changed before controller resume'
              : 'Agent capability generation changed before controller resume',
            previous.daemonBootId !==
              transport.welcome.daemonBootId
              ? 'daemon-status'
              : 'capability'
          )
        } else {
          previous = undefined
        }
      }
      if (
        this.#disposed ||
        this.#entries.get(entry.key) !== entry ||
        entry.connectionState === 'disposed' ||
        entry.controller.signal.aborted
      ) {
        throw new RemoteAgentConnectionError(
          'Remote Agent connection request became stale',
          'transient',
          'network'
        )
      }
      const active: ActiveConnection = {
        sshLease,
        transport,
        client,
        status,
        capabilities,
        unsubscribeClose: () => undefined
      }
      active.unsubscribeClose = client.onClose((error) => {
        this.#connectionClosed(entry, error)
      })
      entry.connection = active
      entry.connectionState = 'ready'
      entry.failure = undefined
      await this.#persistConnection(
        entry,
        active,
        previous,
        previous !== undefined
      )
      for (const listener of entry.clientChangeListeners) {
        try {
          listener()
        } catch {
          // One retained lease cannot invalidate the shared client swap.
        }
      }
      return active
    } catch (error) {
      const published = entry.connection
      if (published !== undefined && published.client === client) {
        published.unsubscribeClose()
        entry.connection = undefined
      }
      client?.dispose()
      transport?.dispose()
      sshLease?.release()
      const classified = classifyConnectionError(error)
      if (
        this.#entries.get(entry.key) === entry &&
        entry.connectionState !== 'disposed'
      ) {
        entry.failure = classified
        entry.connectionState =
          classified.disposition === 'terminal'
            ? 'terminal'
            : 'offline'
        if (entry.refs === 0) {
          this.#entries.delete(entry.key)
        }
      }
      throw classified
    } finally {
      clearTimeout(connectionTimer)
    }
  }

  async #resume(
    client: AgentProtocolClient,
    previous: ControllerConnectionState,
    daemonBootId: string,
    capabilityGeneration: number
  ): Promise<void> {
    if (previous.daemonBootId !== daemonBootId) {
      throw terminalError(
        'Agent daemon boot changed before controller resume',
        'daemon-status'
      )
    }
    if (previous.capabilityGeneration !== capabilityGeneration) {
      throw terminalError(
        'Agent capability generation changed before controller resume',
        'capability'
      )
    }
    let result
    try {
      result = await client.request('controller/resume', {
        previousGeneration: previous.previousGeneration,
        previousConnectionId: previous.previousConnectionId,
        daemonBootId,
        capabilityGeneration: previous.capabilityGeneration
      })
    } catch (error) {
      throw terminalError(
        'Agent refused the stable controller generation resume',
        'protocol',
        error
      )
    }
    if (
      !result.resumed ||
      result.generation !== client.generation ||
      result.daemonBootId !== daemonBootId ||
      result.capabilityGeneration !== capabilityGeneration
    ) {
      throw terminalError(
        'Agent refused the stable controller generation resume',
        'protocol'
      )
    }
  }

  #validateWelcome(
    entry: ConnectionEntry,
    transport: AgentAttachTransport
  ): void {
    const welcome = transport.welcome
    const expectedProtocol = protocolVersion(entry.installation)
    if (
      welcome.protocol.major !== expectedProtocol.major ||
      welcome.protocol.minor > expectedProtocol.minor
    ) {
      throw terminalError(
        'GoodBuddy Agent protocol is incompatible',
        'protocol'
      )
    }
    if (
      welcome.installationId !== entry.installation.installationId ||
      welcome.binaryDigest !== entry.installation.binaryDigest
    ) {
      throw terminalError(
        'GoodBuddy Agent installation handshake identity is invalid',
        'installation'
      )
    }
  }

  #validateDaemon(
    entry: ConnectionEntry,
    transport: AgentAttachTransport,
    status: DaemonStatus,
    capabilities: DaemonCapabilities
  ): void {
    const expected = entry.installation
    if (
      status.state !== 'ready' ||
      status.draining ||
      status.installationId !== expected.installationId ||
      status.binaryDigest !== expected.binaryDigest ||
      status.daemonBootId !== transport.welcome.daemonBootId
    ) {
      throw terminalError(
        'GoodBuddy Agent daemon is not ready with the expected installation',
        'daemon-status'
      )
    }
    if (
      status.platform !== expected.platform ||
      status.architecture !== expected.architecture ||
      status.supervisor !== expected.supervisor
    ) {
      throw terminalError(
        'GoodBuddy Agent platform or supervisor is incompatible',
        'platform'
      )
    }
    const protocol = protocolVersion(expected)
    if (
      status.protocol.major !== protocol.major ||
      status.protocol.minor > protocol.minor
    ) {
      throw terminalError(
        'GoodBuddy Agent status reports an incompatible protocol',
        'protocol'
      )
    }
    if (
      expected.agentVersion !== undefined &&
      status.agentVersion !== expected.agentVersion
    ) {
      throw terminalError(
        'GoodBuddy Agent version does not match its installation',
        'installation'
      )
    }
    if (
      capabilities.generation < 1 ||
      !requiredCapabilitiesPresent(
        capabilities,
        expected.requiredCapabilities ?? []
      )
    ) {
      throw terminalError(
        'GoodBuddy Agent is missing a required capability',
        'capability'
      )
    }
  }

  #lease(entry: ConnectionEntry): RemoteAgentConnection {
    let released = false
    const assertRetained = (): void => {
      if (
        released ||
        this.#entries.get(entry.key) !== entry ||
        entry.connectionState === 'disposed'
      ) {
        throw new Error('Remote Agent connection lease is released')
      }
    }
    const assertActive = (): ActiveConnection => {
      assertRetained()
      const connection = entry.connection
      if (connection === undefined || entry.connectionState !== 'ready') {
        throw (
          entry.failure ??
          new RemoteAgentConnectionError(
            'Remote Agent connection is offline',
            'transient',
            'network'
          )
        )
      }
      return connection
    }
    return {
      identity: entry.identity,
      get status() {
        return assertActive().status
      },
      get capabilities() {
        return assertActive().capabilities
      },
      get client() {
        return assertActive().client
      },
      get state() {
        return released ? 'disposed' : entry.connectionState
      },
      refreshCapabilities: async (signal) => {
        const active = assertActive()
        const client = active.client
        const generation = client.generation
        const previousCapabilities = active.capabilities
        const capabilities = daemonCapabilitiesSchema.parse(
          await client.request(
            'agent/capabilities',
            {},
            { signal }
          )
        )
        signal?.throwIfAborted()
        const current = assertActive()
        if (
          this.#entries.get(entry.key) !== entry ||
          current !== active ||
          current.client !== client ||
          client.generation !== generation ||
          current.capabilities !== previousCapabilities
        ) {
          throw new RemoteAgentConnectionError(
            'Remote Agent capability refresh became stale',
            'transient',
            'network'
          )
        }
        this.#validateDaemon(
          entry,
          active.transport,
          active.status,
          capabilities
        )
        active.capabilities = capabilities
        try {
          await this.#persistConnection(
            entry,
            active,
            await this.#controllerState.getConnection(entry.stateKey),
            true
          )
        } catch (error) {
          active.capabilities = previousCapabilities
          throw error
        }
        return capabilities
      },
      reconnect: async (signal) => {
        if (released) {
          throw new Error('Remote Agent connection lease is released')
        }
        await this.#reconnect(entry, signal)
      },
      onClientChange: (listener) => {
        if (released) {
          throw new Error('Remote Agent connection lease is released')
        }
        entry.clientChangeListeners.add(listener)
        return () => entry.clientChangeListeners.delete(listener)
      },
      updateAcpBinding: async (bindingId, binding) => {
        assertRetained()
        await this.#controllerState.updateAcpBinding(
          entry.stateKey,
          bindingId,
          binding
        )
      },
      flushAcpBindings: async () => {
        assertRetained()
        await this.#controllerState.flush()
      },
      release: () => {
        if (released) {
          return
        }
        released = true
        entry.refs -= 1
        if (entry.refs === 0 && entry.waiters === 0) {
          this.#scheduleIdle(entry)
        }
      }
    }
  }

  async #reconnect(
    entry: ConnectionEntry,
    signal?: AbortSignal
  ): Promise<void> {
    if (entry.connectionState === 'ready') {
      return
    }
    if (
      entry.connectionState === 'terminal' ||
      entry.connectionState === 'disposed'
    ) {
      throw (
        entry.failure ??
        terminalError('Remote Agent connection cannot reconnect', 'protocol')
      )
    }
    if (entry.reconnectPromise !== undefined) {
      await waitForShared(entry.reconnectPromise, signal)
      return
    }
    const reconnect = (async () => {
      const target = await this.#resolver.resolve(entry.hostId)
      const identity = this.#identity(target, entry.installation)
      if (identity.cacheKey !== entry.key) {
        entry.failure = terminalError(
          'SSH Host identity changed while reconnecting',
          'host-identity'
        )
        entry.connectionState = 'terminal'
        throw entry.failure
      }
      entry.controller = new AbortController()
      entry.connectionState = 'connecting'
      entry.connectPromise = this.#connect(entry, target, true)
      await entry.connectPromise
    })()
    entry.reconnectPromise = reconnect.finally(() => {
      entry.reconnectPromise = undefined
    })
    await waitForShared(entry.reconnectPromise, signal)
  }

  #connectionClosed(
    entry: ConnectionEntry,
    error: AgentProtocolClientError
  ): void {
    if (
      this.#entries.get(entry.key) !== entry ||
      entry.connectionState === 'disposed'
    ) {
      return
    }
    const active = entry.connection
    entry.connection = undefined
    entry.failure = new RemoteAgentConnectionError(
      'Remote Agent transport disconnected',
      'transient',
      'network',
      error
    )
    entry.connectionState = 'offline'
    active?.unsubscribeClose()
    active?.sshLease.release()
    if (entry.refs === 0 && entry.waiters === 0) {
      this.#scheduleIdle(entry)
    }
  }

  async #persistConnection(
    entry: ConnectionEntry,
    active: ActiveConnection,
    previous?: Partial<ControllerConnectionState>,
    preserveRecovery = false
  ): Promise<void> {
    const connection = {
      cacheKey: entry.stateKey,
      hostId: entry.hostId,
      installationId: entry.installation.installationId,
      protocolMajor: protocolVersion(entry.installation).major,
      previousConnectionId: active.client.connectionId,
      previousGeneration: active.client.generation,
      daemonBootId: active.status.daemonBootId,
      capabilityGeneration: active.capabilities.generation,
      acpBindings: previous?.acpBindings ?? []
    }
    if (preserveRecovery) {
      await this.#controllerState.updateConnectionPreservingRecovery(
        connection
      )
    } else {
      await this.#controllerState.updateConnection(connection)
    }
  }

  #identity(
    target: SshConnectionPoolTarget,
    installation: RemoteAgentInstallationIdentity
  ): RemoteAgentConnectionIdentity {
    const protocol = protocolVersion(installation)
    const hostKey = target.host.hostKey
    if (
      hostKey === undefined ||
      hostKey.generation !== target.hostKeyGeneration
    ) {
      throw terminalError(
        'SSH Host Key generation is not current',
        'host-identity'
      )
    }
    const authenticationValue =
      target.host.authentication === 'password'
        ? target.host.password
        : defaultSystemAgent()
    if (!authenticationValue) {
      throw terminalError(
        'SSH authentication identity is unavailable',
        'authentication'
      )
    }
    const authIdentity = createHmac('sha256', this.#identityKey)
      .update(authenticationValue)
      .digest('hex')
    const material = JSON.stringify([
      target.host.id,
      target.hostRevision,
      target.hostKeyGeneration,
      target.host.hostname,
      target.host.port,
      target.host.username,
      target.host.authentication,
      hostKey.algorithm,
      hostKey.publicKeyBase64,
      authIdentity,
      installation.installationId,
      installation.binaryDigest,
      protocol.major,
      protocol.minor
    ])
    return {
      cacheKey: createHash('sha256').update(material).digest('hex'),
      hostId: target.host.id,
      hostRevision: target.hostRevision,
      hostKeyGeneration: target.hostKeyGeneration,
      remoteUsername: target.host.username,
      installationId: installation.installationId,
      binaryDigest: installation.binaryDigest,
      protocolMajor: protocol.major,
      protocolMinor: protocol.minor
    }
  }

  #scheduleIdle(entry: ConnectionEntry): void {
    if (
      this.#entries.get(entry.key) !== entry ||
      entry.idleTimer !== undefined
    ) {
      return
    }
    if (this.#idleTimeoutMs === 0) {
      this.#disposeEntry(entry)
      return
    }
    entry.idleTimer = setTimeout(() => {
      if (entry.refs === 0 && entry.waiters === 0) {
        this.#disposeEntry(entry)
      }
    }, this.#idleTimeoutMs)
  }

  #disposeEntry(entry: ConnectionEntry): void {
    if (this.#entries.get(entry.key) === entry) {
      this.#entries.delete(entry.key)
    }
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
    }
    entry.connectionState = 'disposed'
    entry.controller.abort()
    entry.connection?.unsubscribeClose()
    entry.connection?.client.dispose()
    entry.connection?.transport.dispose()
    entry.connection?.sshLease.release()
    entry.connection = undefined
    entry.clientChangeListeners.clear()
  }
}

function validateInstallation(
  input: RemoteAgentInstallationIdentity
): RemoteAgentInstallationIdentity {
  const installationId = verifyAgentInstallationId(input.installationId)
  const binaryDigest = sha256DigestSchema.parse(input.binaryDigest)
  const protocol = protocolVersionSchema.parse(
    input.protocol ?? AGENT_PROTOCOL_VERSION
  )
  if (
    input.platform !== 'linux' ||
    !['x64', 'arm64'].includes(input.architecture) ||
    input.supervisor !== 'detached-on-demand'
  ) {
    throw terminalError(
      'Remote Agent installation platform is unsupported',
      'platform'
    )
  }
  const requiredCapabilities = (input.requiredCapabilities ?? []).map(
    (requirement) => ({
      name: agentCapabilitySchema.shape.name.parse(requirement.name),
      ...(requirement.minimumVersion === undefined
        ? {}
        : { minimumVersion: requirement.minimumVersion }),
      ...(requirement.exactVersion === undefined
        ? {}
        : { exactVersion: requirement.exactVersion }),
      critical: requirement.critical
    })
  )
  for (const requirement of requiredCapabilities) {
    const versions = [
      requirement.minimumVersion,
      requirement.exactVersion
    ].filter((value): value is number => value !== undefined)
    if (
      versions.length !== 1 ||
      !Number.isSafeInteger(versions[0]) ||
      versions[0]! < 1 ||
      versions[0]! > 65_535
    ) {
      throw new Error('Invalid required Agent capability version')
    }
  }
  return {
    ...input,
    installationId,
    binaryDigest,
    protocol,
    requiredCapabilities
  }
}

function protocolVersion(
  installation: RemoteAgentInstallationIdentity
): { major: number; minor: number } {
  return protocolVersionSchema.parse(
    installation.protocol ?? AGENT_PROTOCOL_VERSION
  )
}

function recoveryStateKey(
  target: SshConnectionPoolTarget,
  installation: RemoteAgentInstallationIdentity
): string {
  const protocol = protocolVersion(installation)
  return createHash('sha256')
    .update(
      JSON.stringify([
        'goodbuddy-controller-recovery-v1',
        target.host.id,
        target.hostRevision,
        target.hostKeyGeneration,
        installation.installationId,
        installation.binaryDigest,
        protocol.major
      ])
    )
    .digest('hex')
}

function requiredCapabilitiesPresent(
  capabilities: DaemonCapabilities,
  requirements: ReadonlyArray<{
    name: string
    minimumVersion?: number
    exactVersion?: number
    critical?: boolean
  }>
): boolean {
  const byName = new Map(
    capabilities.capabilities.map((capability) => [
      capability.name,
      capability
    ])
  )
  return requirements.every((requirement) => {
    const available = byName.get(requirement.name)
    return (
      available !== undefined &&
      (requirement.exactVersion === undefined
        ? available.version >= requirement.minimumVersion!
        : available.version === requirement.exactVersion) &&
      (!requirement.critical || available.critical)
    )
  })
}

function classifyConnectionError(error: unknown): RemoteAgentConnectionError {
  if (error instanceof RemoteAgentConnectionError) {
    return error
  }
  const message = error instanceof Error ? error.message : String(error)
  if (
    /host key|主机密钥|authentication|认证|credential|凭据/iu.test(
      message
    )
  ) {
    return terminalError(message, 'authentication', error)
  }
  return new RemoteAgentConnectionError(
    'Remote Agent connection failed',
    'transient',
    'network',
    error
  )
}

function terminalError(
  message: string,
  reason: RemoteAgentConnectionError['reason'],
  cause?: unknown
): RemoteAgentConnectionError {
  return new RemoteAgentConnectionError(
    message,
    'terminal',
    reason,
    cause
  )
}

function waitForShared<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (signal === undefined) {
    return promise
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}
