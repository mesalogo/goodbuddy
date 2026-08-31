import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, posix, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import {
  AGENT_PROTOCOL_FAILURE_RECORD_NAME,
  AGENT_PROTOCOL_FAILURE_STDERR_PREFIX,
  agentProtocolFailureRecordSchema
} from '../shared/agent-protocol'
import type {
  AgentArchitecture,
  AgentReleaseKeyRegistry
} from '../shared/agent-installation-contracts'
import type { RemoteRuntimeLock } from '../shared/remote-runtime-launch-contracts'
import { AgentDaemon } from './daemon'
import { AgentUnsupportedError } from './errors'
import {
  derivePrivateTemporaryRoot,
  ensurePrivateTemporaryRoot,
  readPrivateFile,
  readPrivateSecret,
  ensurePrivateDirectory
} from './managed-paths'
import {
  attachRelay,
  probeAuthenticatedEndpoint,
  type UnixPeerIdentityProvider
} from './private-endpoint'
import { createLinuxPeerIdentityProvider } from './peer-identity-provider'
import {
  loadRegisteredAgentBundle,
  readManagedAgentReleaseKeyRegistry,
  RegisteredAgentBundleError,
  verifyPublishedAgentBundle,
  type VerifiedInstalledAgentBundle
} from './installed-bundle-verifier'
import { InstallationRegistry } from './installation-registry'
import {
  RuntimeBundleRegistry
} from './runtime-bundle-registry'
import {
  loadRegisteredRuntimeBundle,
  readRemoteRuntimeLock,
  verifyPublishedRuntimeBundle,
  type VerifiedRuntimeBundle
} from './runtime-bundle-verifier'
import { createProductionRuntimeProtocol } from './runtime-composition'
import {
  runOpenCodeModelBridgeHelper,
  type ModelBridgeProtocol
} from './model-bridge-helper'
import {
  DetachedAgentLifecycle,
  type DetachedAgentLifecycleOptions
} from './detached-agent-lifecycle'
import { readAgentDiagnostics } from './diagnostic-log'

type CliIo = {
  input: Readable
  output: Writable
  error: Writable
}

export type AgentCliDependencies = {
  io?: CliIo
  createLifecycle?: (
    options: DetachedAgentLifecycleOptions
  ) => DetachedAgentLifecycle
  peerIdentityProvider?: UnixPeerIdentityProvider
  createDaemon?: (options: ConstructorParameters<typeof AgentDaemon>[0]) => AgentDaemon
  waitForShutdown?: () => Promise<void>
  installationPaths?: (
    installationId: string
  ) => ManagedInstallationPaths
  attach?: typeof attachRelay
  releaseKeyRegistry?: AgentReleaseKeyRegistry
  installationRegistry?: InstallationRegistry
  verifyInstallation?: (
    installationDirectory: string,
    options: {
      installationId: string
      architecture: AgentArchitecture
      releaseKeyRegistry: AgentReleaseKeyRegistry
    }
  ) => Promise<VerifiedInstalledAgentBundle>
  loadRegisteredInstallation?: typeof loadRegisteredAgentBundle
  runtimePaths?: (
    installationId: string,
    runtimeId: 'opencode',
    bundleDigest: string
  ) => ManagedRuntimePaths
  runtimeReleaseKeyRegistry?: AgentReleaseKeyRegistry
  runtimeLock?: RemoteRuntimeLock
  runtimeRegistry?: RuntimeBundleRegistry
  verifyRuntime?: typeof verifyPublishedRuntimeBundle
  runtimeVerificationEnvironment?: 'production' | 'test'
  currentArchitecture?: () => AgentArchitecture
  runModelBridgeHelper?: typeof runOpenCodeModelBridgeHelper
}

export type ManagedInstallationPaths = {
  executablePath: string
  stateDirectory: string
  socketPath: string
}

export type ManagedRuntimePaths = {
  runtimeRoot: string
  bundleDirectory: string
  releaseKeyRegistryPath: string
  runtimeLockPath: string
  registryPath: string
}

const LIFECYCLE_ACTIONS = new Set([
  'adopt',
  'bootstrap',
  'status',
  'health',
  'stop',
  'retire'
])

export async function runAgentCli(
  argv: readonly string[],
  dependencies: AgentCliDependencies = {}
): Promise<number> {
  const io = dependencies.io ?? {
    input: process.stdin,
    output: process.stdout,
    error: process.stderr
  }
  const [command, ...rest] = argv
  try {
    switch (command) {
      case 'daemon':
        await runDaemon(rest, dependencies)
        return 0
      case 'attach-or-bootstrap':
        await runAttach(rest, dependencies, io)
        return 0
      case 'doctor':
        await runDoctor(rest, dependencies, io)
        return 0
      case 'diagnostics':
        runDiagnostics(rest, dependencies, io)
        return 0
      case 'runtime':
        await runRuntime(rest, dependencies, io)
        return 0
      case 'model-bridge-helper':
        return await runModelBridgeHelper(rest, dependencies)
      default:
        if (command !== undefined && LIFECYCLE_ACTIONS.has(command)) {
          await runLifecycle([command, ...rest], dependencies, io)
          return 0
        }
        throw new Error(
          'Expected daemon, attach-or-bootstrap, doctor, diagnostics, a lifecycle action, runtime, or model-bridge-helper'
        )
    }
  } catch (error) {
    if (
      error instanceof RegisteredAgentBundleError &&
      (command === 'daemon' || command === 'attach-or-bootstrap')
    ) {
      io.error.write(
        `${AGENT_PROTOCOL_FAILURE_STDERR_PREFIX}installation-repair-required\n`
      )
    } else {
      io.error.write(
        `${error instanceof Error ? error.message : String(error)}\n`
      )
    }
    return error instanceof AgentUnsupportedError ? 3 : 2
  }
}

async function runModelBridgeHelper(
  argv: readonly string[],
  dependencies: AgentCliDependencies
): Promise<number> {
  const options = parseOptions(argv, [
    'socket-path',
    'protocol',
    'model',
    'supports-image-input',
    'opencode-entrypoint'
  ])
  requireOptions(options, [
    'socket-path',
    'protocol',
    'model',
    'supports-image-input',
    'opencode-entrypoint'
  ])
  const protocol = options.protocol
  if (
    protocol !== 'anthropic-messages' &&
    protocol !== 'openai-chat-completions' &&
    protocol !== 'openai-responses'
  ) {
    throw new Error('Invalid model bridge protocol')
  }
  const imageInput = options['supports-image-input']
  if (imageInput !== 'true' && imageInput !== 'false') {
    throw new Error('Invalid model bridge image-input option')
  }
  return await (
    dependencies.runModelBridgeHelper ??
    runOpenCodeModelBridgeHelper
  )({
    socketPath: options['socket-path']!,
    protocol: protocol as ModelBridgeProtocol,
    model: options.model!,
    supportsImageInput: imageInput === 'true',
    opencodeEntrypoint: options['opencode-entrypoint']!
  })
}

async function runRuntime(
  argv: readonly string[],
  dependencies: AgentCliDependencies,
  io: CliIo
): Promise<void> {
  const [action, ...optionArguments] = argv
  if (action !== 'activate') {
    throw new Error('Invalid fixed Runtime action')
  }
  const options = parseOptions(optionArguments, [
    'installation-id',
    'runtime-id',
    'bundle-digest',
    'architecture',
    'force-verification'
  ])
  requireOptions(options, [
    'installation-id',
    'runtime-id',
    'bundle-digest',
    'architecture'
  ])
  const installationId = validateInstallationId(
    options['installation-id']!
  )
  const runtimeId = validateRuntimeId(options['runtime-id']!)
  const bundleDigest = validateBundleDigest(
    options['bundle-digest']!
  )
  const architecture = validateRuntimeArchitecture(
    options.architecture!
  )
  const forceVerification =
    options['force-verification'] === 'true'
  if (
    options['force-verification'] !== undefined &&
    !forceVerification
  ) {
    throw new Error(
      'Invalid Runtime force-verification option'
    )
  }
  const hostArchitecture =
    dependencies.currentArchitecture?.() ??
    currentAgentArchitecture()
  if (architecture !== hostArchitecture) {
    throw new Error(
      'Runtime activation architecture does not match the current Agent'
    )
  }
  const paths = resolveRuntimePaths(
    installationId,
    runtimeId,
    bundleDigest,
    dependencies
  )
  const releaseKeyRegistry =
    dependencies.runtimeReleaseKeyRegistry ??
    await readManagedAgentReleaseKeyRegistry(
      paths.releaseKeyRegistryPath
    )
  const runtimeLock =
    dependencies.runtimeLock ??
    await readRemoteRuntimeLock(paths.runtimeLockPath)
  const registry =
    dependencies.runtimeRegistry ??
    new RuntimeBundleRegistry({
      runtimeRoot: paths.runtimeRoot,
      storagePath: paths.registryPath
    })
  const verificationOptions = {
    architecture,
    releaseKeyRegistry,
    runtimeLock,
    verificationEnvironment:
      dependencies.runtimeVerificationEnvironment ?? 'production'
  } as const
  const registered = registry.find(
    runtimeId,
    bundleDigest,
    architecture
  )
  const verified =
    registered === undefined || forceVerification
    ? await (
        dependencies.verifyRuntime ?? verifyPublishedRuntimeBundle
      )(paths.bundleDirectory, verificationOptions)
    : await loadRegisteredRuntimeBundle(
        registered.bundleDirectory,
        {
          ...verificationOptions,
          registered: registered.entry
        }
      )
  assertActivatedRuntimeIdentity(
    verified,
    runtimeId,
    bundleDigest,
    architecture
  )
  const entry = registry.register(verified)
  io.output.write(`${JSON.stringify({
    activated: true,
    runtimeId: entry.runtimeId,
    bundleDigest: entry.bundleDigest,
    architecture: entry.architecture,
    runtimeVersion: entry.runtimeVersion
  })}\n`)
}

async function runDaemon(
  argv: readonly string[],
  dependencies: AgentCliDependencies
): Promise<void> {
  const options = parseOptions(argv, ['installation-id'])
  requireOptions(options, ['installation-id'])
  const installationId = validateInstallationId(
    options['installation-id']!
  )
  const paths = resolveInstallationPaths(installationId, dependencies)
  const { verified } = await loadManagedInstallation(
    installationId,
    paths,
    dependencies
  )
  prepareManagedSocketDirectory(paths)
  const daemonOptions: ConstructorParameters<typeof AgentDaemon>[0] = {
    installationId,
    binaryDigest: verified.binaryDigest,
    agentVersion: verified.manifest.agentVersion,
    protocol: verified.manifest.protocol,
    stateDirectory: paths.stateDirectory,
    socketPath: paths.socketPath,
    peerIdentityProvider:
      dependencies.peerIdentityProvider ??
      await createLinuxPeerIdentityProvider(),
    runtimeFactory: async ({
      events,
      workspaces,
      diagnostics,
      outputSink,
      blobSink
    }) =>
      await createProductionRuntimeProtocol({
        runtimeRoot: resolve(
          dirname(dirname(dirname(dirname(paths.executablePath)))),
          'runtimes'
        ),
        stateDirectory: paths.stateDirectory,
        architecture: currentAgentArchitecture(),
        events,
        workspaces,
        outputSink,
        blobSink,
        diagnostics,
        agentExecutablePath: paths.executablePath,
        installationId
      })
  }
  const daemon =
    dependencies.createDaemon?.(daemonOptions) ??
    new AgentDaemon(daemonOptions)
  await daemon.start()
  try {
    await createDetachedLifecycle(
      installationId,
      paths,
      dependencies,
      'registered',
      verified
    ).recordCurrentDaemonReady(daemon.status().daemonBootId)
    await (dependencies.waitForShutdown?.() ?? waitForShutdownSignal())
  } finally {
    await daemon.stop()
  }
}

async function runAttach(
  argv: readonly string[],
  dependencies: AgentCliDependencies,
  io: CliIo
): Promise<void> {
  const options = parseOptions(argv, ['installation-id'])
  requireOptions(options, ['installation-id'])
  const installationId = validateInstallationId(
    options['installation-id']!
  )
  const paths = resolveInstallationPaths(
    installationId,
    dependencies
  )
  const { verified } = await loadManagedInstallation(
    installationId,
    paths,
    dependencies
  )
  prepareManagedSocketDirectory(paths)
  const stateDirectory = paths.stateDirectory
  ensurePrivateDirectory(stateDirectory, { create: false })
  const secret = readPrivateSecret(
    resolve(stateDirectory, 'installation-identity')
  )
  let connectionId: string | undefined
  await (dependencies.attach ?? attachRelay)({
    socketPath: paths.socketPath,
    secret,
    input: io.input,
    output: io.output,
    onWelcome: (welcome) => {
      connectionId = welcome.connectionId
    },
    ensureEndpoint: async () => {
      await createDetachedLifecycle(
        installationId,
        paths,
        dependencies,
        'registered',
        verified
      ).bootstrap()
    }
  })
  if (connectionId !== undefined) {
    const category = readProtocolFailureCategory(
      stateDirectory,
      connectionId
    )
    if (category !== undefined) {
      io.error.write(
        `${AGENT_PROTOCOL_FAILURE_STDERR_PREFIX}${category}\n`
      )
    }
  }
}

function readProtocolFailureCategory(
  stateDirectory: string,
  connectionId: string
): string | undefined {
  try {
    const record = agentProtocolFailureRecordSchema.parse(
      JSON.parse(
        readPrivateFile(
          resolve(
            stateDirectory,
            AGENT_PROTOCOL_FAILURE_RECORD_NAME
          ),
          4096
        ).toString('utf8')
      )
    )
    return record.connectionId === connectionId
      ? record.category
      : undefined
  } catch {
    return undefined
  }
}

async function runDoctor(
  argv: readonly string[],
  dependencies: AgentCliDependencies,
  io: CliIo
): Promise<void> {
  const options = parseOptions(argv, ['installation-id'])
  requireOptions(options, ['installation-id'])
  const installationId = validateInstallationId(
    options['installation-id']!
  )
  const paths = resolveInstallationPaths(installationId, dependencies)
  const { verified } = await loadManagedInstallation(
    installationId,
    paths,
    dependencies
  )
  const status = await createDetachedLifecycle(
    installationId,
    paths,
    dependencies,
    'registered',
    verified
  ).status()
  io.output.write(`${JSON.stringify({
    platform: process.platform,
    architecture: process.arch,
    supervisor: 'detached-on-demand',
    lifecycle: status
  })}\n`)
}

function runDiagnostics(
  argv: readonly string[],
  dependencies: AgentCliDependencies,
  io: CliIo
): void {
  const options = parseOptions(argv, ['installation-id'])
  requireOptions(options, ['installation-id'])
  const installationId = validateInstallationId(
    options['installation-id']!
  )
  const paths = resolveInstallationPaths(installationId, dependencies)
  for (const record of readAgentDiagnostics(paths.stateDirectory)) {
    io.output.write(`${JSON.stringify(record)}\n`)
  }
}

async function runLifecycle(
  argv: readonly string[],
  dependencies: AgentCliDependencies,
  io: CliIo
): Promise<void> {
  const [action, ...optionArguments] = argv
  if (action === undefined || !LIFECYCLE_ACTIONS.has(action)) {
    throw new Error('Invalid fixed lifecycle action')
  }
  const options = parseOptions(optionArguments, ['installation-id'])
  requireOptions(options, ['installation-id'])
  const installationId = validateInstallationId(
    options['installation-id']!
  )
  const paths = resolveInstallationPaths(installationId, dependencies)
  switch (action) {
    case 'adopt': {
      const { verified, registry } =
        await verifyManagedInstallation(
          installationId,
          paths,
          dependencies
        )
      const currentInstallationMatches =
        registry.snapshot().current?.installationId ===
        installationId
      const alreadyCurrent = registry.isCurrent(verified)
      if (!alreadyCurrent && !currentInstallationMatches) {
        registry.stageCandidate(verified)
      }
      prepareManagedSocketDirectory(paths)
      const status = await createDetachedLifecycle(
        installationId,
        paths,
        dependencies,
        'verified',
        verified
      ).bootstrap()
      if (!alreadyCurrent) {
        if (currentInstallationMatches) {
          registry.refreshCurrent(verified)
        } else {
          registry.promoteCandidate(installationId)
        }
      }
      io.output.write(`${JSON.stringify(status)}\n`)
      break
    }
    case 'bootstrap': {
      const agentRoot = dirname(
        dirname(dirname(paths.executablePath))
      )
      const registry =
        dependencies.installationRegistry ??
        new InstallationRegistry({
          storagePath: resolve(agentRoot, 'registry.json')
        })
      const snapshot = registry.snapshot()
      const current = snapshot.current?.installationId ===
        installationId
        ? snapshot.current
        : undefined
      const candidate = snapshot.candidate?.installationId ===
        installationId
        ? snapshot.candidate
        : undefined
      const registered = current ?? candidate
      const isNewInstallation = registered === undefined
      const verified = isNewInstallation
        ? (
            await verifyManagedInstallation(
              installationId,
              paths,
              dependencies
            )
          ).verified
        : await (
            dependencies.loadRegisteredInstallation ??
            loadRegisteredAgentBundle
          )(dirname(paths.executablePath), {
            installationId,
            architecture: currentAgentArchitecture(),
            registered
          })
      if (isNewInstallation) {
        registry.stageCandidate(verified)
      }
      prepareManagedSocketDirectory(paths)
      const lifecycle = createDetachedLifecycle(
        installationId,
        paths,
        dependencies,
        'verified',
        verified
      )
      const status = await lifecycle.bootstrap()
      if (current === undefined) {
        registry.promoteCandidate(installationId)
      }
      io.output.write(`${JSON.stringify(status)}\n`)
      break
    }
    case 'status': {
      const { verified } = await loadManagedInstallation(
        installationId,
        paths,
        dependencies
      )
      const lifecycle = createDetachedLifecycle(
        installationId,
        paths,
        dependencies,
        'registered',
        verified
      )
      io.output.write(`${JSON.stringify(await lifecycle.status())}\n`)
      break
    }
    case 'health': {
      const { verified } = await loadManagedInstallation(
        installationId,
        paths,
        dependencies
      )
      const lifecycle = createDetachedLifecycle(
        installationId,
        paths,
        dependencies,
        'registered',
        verified
      )
      const status = await lifecycle.health()
      io.output.write(`${JSON.stringify(status)}\n`)
      break
    }
    case 'stop': {
      const { verified } = await loadManagedInstallation(
        installationId,
        paths,
        dependencies
      )
      const lifecycle = createDetachedLifecycle(
        installationId,
        paths,
        dependencies,
        'registered',
        verified
      )
      io.output.write(`${JSON.stringify(await lifecycle.stop())}\n`)
      break
    }
    case 'retire': {
      const { verified } = await loadManagedInstallation(
        installationId,
        paths,
        dependencies
      )
      const lifecycle = createDetachedLifecycle(
        installationId,
        paths,
        dependencies,
        'registered',
        verified
      )
      io.output.write(`${JSON.stringify(await lifecycle.retire())}\n`)
      break
    }
  }
}

function createDetachedLifecycle(
  installationId: string,
  paths: ManagedInstallationPaths,
  dependencies: AgentCliDependencies,
  identitySource: 'verified' | 'registered' = 'verified',
  verifiedInstallation?: VerifiedInstalledAgentBundle
): DetachedAgentLifecycle {
  const options: DetachedAgentLifecycleOptions = {
    installationId,
    executablePath: paths.executablePath,
    stateDirectory: paths.stateDirectory,
    socketPath: paths.socketPath,
    verifyInstallation: async () => {
      if (verifiedInstallation !== undefined) {
        return verifiedInstallation
      }
      if (identitySource === 'registered') {
        return (
          await loadManagedInstallation(
            installationId,
            paths,
            dependencies
          )
        ).verified
      }
      const { verified, registry } =
        await verifyManagedInstallation(
          installationId,
          paths,
          dependencies
        )
      registry.assertVerifiedRole(verified, [
        'current',
        'candidate'
      ])
      return verified
    },
    probeEndpoint: async (verified) =>
      await probeAuthenticatedEndpoint({
        socketPath: paths.socketPath,
        secret: readPrivateSecret(
          resolve(paths.stateDirectory, 'installation-identity')
        ),
        installationId,
        binaryDigest: verified.binaryDigest,
        protocol: verified.manifest.protocol
      })
  }
  return (
    dependencies.createLifecycle?.(options) ??
    new DetachedAgentLifecycle(options)
  )
}

function prepareManagedSocketDirectory(
  paths: ManagedInstallationPaths
): void {
  if (process.platform !== 'linux') {
    ensurePrivateDirectory(dirname(paths.socketPath))
    return
  }
  const expected = derivePrivateTemporaryRoot()
  if (dirname(paths.socketPath) === expected.rootPath) {
    ensurePrivateTemporaryRoot(expected)
    return
  }
  ensurePrivateDirectory(dirname(paths.socketPath))
}

async function verifyManagedInstallation(
  installationId: string,
  paths: ManagedInstallationPaths,
  dependencies: AgentCliDependencies
): Promise<{
  verified: VerifiedInstalledAgentBundle
  registry: InstallationRegistry
  releaseKeyRegistry: AgentReleaseKeyRegistry
}> {
  const architecture = currentAgentArchitecture()
  const agentRoot = dirname(dirname(dirname(paths.executablePath)))
  const releaseKeyRegistry =
    dependencies.releaseKeyRegistry ??
    await readManagedAgentReleaseKeyRegistry(
      resolve(agentRoot, 'release-keys.json')
    )
  const registry =
    dependencies.installationRegistry ??
    new InstallationRegistry({
      storagePath: resolve(agentRoot, 'registry.json')
    })
  const verified = await (
    dependencies.verifyInstallation ?? verifyPublishedAgentBundle
  )(dirname(paths.executablePath), {
    installationId,
    architecture,
    releaseKeyRegistry
  })
  return { verified, registry, releaseKeyRegistry }
}

async function loadManagedInstallation(
  installationId: string,
  paths: ManagedInstallationPaths,
  dependencies: AgentCliDependencies
): Promise<{
  verified: VerifiedInstalledAgentBundle
  registry: InstallationRegistry
}> {
  const architecture = currentAgentArchitecture()
  const agentRoot = dirname(dirname(dirname(paths.executablePath)))
  const registry =
    dependencies.installationRegistry ??
    new InstallationRegistry({
      storagePath: resolve(agentRoot, 'registry.json')
    })
  const registered = registry.assertRegisteredRole(
    installationId,
    ['current', 'candidate']
  )
  const verified = await (
    dependencies.loadRegisteredInstallation ??
    loadRegisteredAgentBundle
  )(dirname(paths.executablePath), {
    installationId,
    architecture,
    registered
  })
  return { verified, registry }
}

export function deriveManagedInstallationPaths(
  installationIdInput: string,
  options: {
    platform?: NodeJS.Platform
    homeDirectory?: string
    uid?: number
  } = {}
): ManagedInstallationPaths {
  const installationId = validateInstallationId(installationIdInput)
  const platform = options.platform ?? process.platform
  const uid = options.uid ?? process.getuid?.()
  if (
    platform !== 'linux' ||
    uid === undefined ||
    !Number.isSafeInteger(uid) ||
    uid < 0
  ) {
    throw new AgentUnsupportedError(
      'Managed Agent paths require a current Linux UID',
      'platform-incompatible'
    )
  }
  const homeDirectory = posix.resolve(
    options.homeDirectory ?? homedir()
  )
  const homeHash = createHash('sha256')
    .update(`${uid}\0${homeDirectory}`, 'utf8')
    .digest('hex')
    .slice(0, 20)
  const socketRoot = posix.join(
    '/tmp',
    `goodbuddy-${uid}-${homeHash}`
  )
  const socketName = createHash('sha256')
    .update(`goodbuddy-agent-socket-v1\0${installationId}`, 'utf8')
    .digest('hex')
    .slice(0, 32)
  return {
    executablePath: posix.join(
      homeDirectory,
      '.goodbuddy',
      'agent',
      'installations',
      installationId,
      'goodbuddy-agent'
    ),
    stateDirectory: posix.join(
      homeDirectory,
      '.goodbuddy',
      'state',
      installationId
    ),
    socketPath: posix.join(socketRoot, `${socketName}.sock`)
  }
}

export function deriveManagedRuntimePaths(
  installationIdInput: string,
  runtimeIdInput: string,
  bundleDigestInput: string,
  options: {
    homeDirectory?: string
  } = {}
): ManagedRuntimePaths {
  validateInstallationId(installationIdInput)
  const runtimeId = validateRuntimeId(runtimeIdInput)
  const bundleDigest = validateBundleDigest(bundleDigestInput)
  const runtimeRoot = posix.join(
    posix.resolve(options.homeDirectory ?? homedir()),
    '.goodbuddy',
    'runtimes'
  )
  return {
    runtimeRoot,
    bundleDirectory: posix.join(
      runtimeRoot,
      runtimeId,
      bundleDigest.slice('sha256:'.length)
    ),
    releaseKeyRegistryPath: posix.join(
      runtimeRoot,
      'release-keys.json'
    ),
    runtimeLockPath: posix.join(
      runtimeRoot,
      'remote-runtime-lock.json'
    ),
    registryPath: posix.join(runtimeRoot, 'registry.json')
  }
}

function resolveInstallationPaths(
  installationId: string,
  dependencies: AgentCliDependencies
): ManagedInstallationPaths {
  validateInstallationId(installationId)
  const paths =
    dependencies.installationPaths?.(installationId) ??
    deriveManagedInstallationPaths(installationId)
  return {
    executablePath: resolve(paths.executablePath),
    stateDirectory: resolve(paths.stateDirectory),
    socketPath: resolve(paths.socketPath)
  }
}

function resolveRuntimePaths(
  installationId: string,
  runtimeId: 'opencode',
  bundleDigest: string,
  dependencies: AgentCliDependencies
): ManagedRuntimePaths {
  const paths =
    dependencies.runtimePaths?.(
      installationId,
      runtimeId,
      bundleDigest
    ) ??
    deriveManagedRuntimePaths(
      installationId,
      runtimeId,
      bundleDigest
    )
  const runtimeRoot = resolve(paths.runtimeRoot)
  const expected = {
    runtimeRoot,
    bundleDirectory: resolve(
      runtimeRoot,
      runtimeId,
      bundleDigest.slice('sha256:'.length)
    ),
    releaseKeyRegistryPath: resolve(
      runtimeRoot,
      'release-keys.json'
    ),
    runtimeLockPath: resolve(
      runtimeRoot,
      'remote-runtime-lock.json'
    ),
    registryPath: resolve(runtimeRoot, 'registry.json')
  }
  if (
    Object.entries(expected).some(
      ([key, value]) =>
        resolve(paths[key as keyof ManagedRuntimePaths]) !== value
    )
  ) {
    throw new Error('Runtime activation paths are not GoodBuddy-managed')
  }
  return expected
}

function validateInstallationId(value: string): string {
  if (
    value.length > 128 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9])?$/u.test(value)
  ) {
    throw new Error('Invalid Agent installation ID')
  }
  return value
}

function validateRuntimeId(value: string): 'opencode' {
  if (value !== 'opencode') {
    throw new Error('Invalid Runtime ID')
  }
  return value
}

function validateBundleDigest(value: string): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error('Invalid Runtime bundle digest')
  }
  return value
}

function validateRuntimeArchitecture(
  value: string
): AgentArchitecture {
  if (value !== 'x64' && value !== 'arm64') {
    throw new Error('Invalid Runtime architecture')
  }
  return value
}

function assertActivatedRuntimeIdentity(
  verified: VerifiedRuntimeBundle,
  runtimeId: 'opencode',
  bundleDigest: string,
  architecture: AgentArchitecture
): void {
  if (
    verified.manifest.runtimeId !== runtimeId ||
    verified.manifest.provider !== 'opencode' ||
    verified.manifest.bundleDigest !== bundleDigest ||
    verified.manifest.architecture !== architecture
  ) {
    throw new Error(
      'Verified Runtime does not match the activation request'
    )
  }
}

function currentAgentArchitecture(): AgentArchitecture {
  if (process.arch === 'x64' || process.arch === 'arm64') {
    return process.arch
  }
  throw new AgentUnsupportedError(
    `Managed Agent architecture is unsupported: ${process.arch}`,
    'platform-incompatible'
  )
}

function parseOptions(
  argv: readonly string[],
  allowed: readonly string[]
): Record<string, string> {
  const allowedSet = new Set(allowed)
  const output: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (
      flag === undefined ||
      !flag.startsWith('--') ||
      !allowedSet.has(flag.slice(2)) ||
      value === undefined ||
      value.startsWith('--')
    ) {
      throw new Error('Invalid or unsupported command option')
    }
    const key = flag.slice(2)
    if (output[key] !== undefined) {
      throw new Error('Duplicate command option')
    }
    output[key] = value
  }
  return output
}

function requireOptions(
  options: Readonly<Record<string, string>>,
  names: readonly string[]
): void {
  for (const name of names) {
    if (options[name] === undefined) {
      throw new Error(`Missing required --${name}`)
    }
  }
}

async function waitForShutdownSignal(): Promise<void> {
  await new Promise<void>((resolveSignal) => {
    const done = (): void => {
      process.off('SIGINT', done)
      process.off('SIGTERM', done)
      resolveSignal()
    }
    process.once('SIGINT', done)
    process.once('SIGTERM', done)
  })
}
