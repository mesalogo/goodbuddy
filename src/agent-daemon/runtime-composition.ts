import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import type {
  AgentArchitecture,
  AgentReleaseKeyRegistry
} from '../shared/agent-installation-contracts'
import type { AgentFrame } from '../shared/agent-protocol'
import type {
  RuntimeRegistryEntry
} from '../shared/remote-environment-registry-contracts'
import type {
  RemotePromptOperationPreparation
} from '../shared/remote-agent-contracts'
import type { RemoteRuntimeLock } from '../shared/remote-runtime-launch-contracts'
import type { EventJournal } from './event-journal'
import {
  derivePrivateTemporaryRoot,
  ensurePrivateDirectory,
  ensurePrivateDirectoryTree,
  ensurePrivateTemporaryRoot
} from './managed-paths'
import { readManagedAgentReleaseKeyRegistry } from './installed-bundle-verifier'
import {
  RuntimeBundleRegistry,
  createVerifiedRuntimeCapabilitySource
} from './runtime-bundle-registry'
import {
  readRemoteRuntimeLock,
  loadRegisteredRuntimeBundle,
  type VerifiedRuntimeBundle
} from './runtime-bundle-verifier'
import { RuntimeAcpBackend } from './runtime-acp-backend'
import type { ProtocolMethodContext } from './protocol-server'
import {
  launchDirectLinuxStdioProcessOwner,
  reconcileOrphanedDirectLinuxStdioProcesses
} from './direct-linux-stdio-process-owner'
import { RuntimeOwnerRegistry } from './runtime-owner-registry'
import type { WorkspaceRegistry } from './workspace-registry'
import { SemanticPromptStore } from './semantic-prompt-store'
import {
  AgentModelCallLedger,
  AgentModelGateway
} from './agent-model-gateway'
import type { AgentDiagnosticLog } from './diagnostic-log'

const BWRAP_EXECUTABLE = '/usr/bin/bwrap'

export type ProductionRuntimeProtocol = {
  runtimes: ReturnType<typeof createVerifiedRuntimeCapabilitySource>
  methods: RuntimeAcpBackend['methods']
  onAcpFrame: RuntimeAcpBackend['onAcpFrame']
  onBlobFrame?: RuntimeAcpBackend['onBlobFrame']
  authorizeBlobFrame?: RuntimeAcpBackend['authorizeBlobFrame']
  dispose: () => Promise<void>
}

export type ProductionRuntimeCompositionOptions = {
  runtimeRoot: string
  stateDirectory: string
  architecture: AgentArchitecture
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
  blobSink?: (
    frame: AgentFrame,
    context: {
      bindingId: string
      controllerId: string
      controllerGeneration: number
    }
  ) => void | Promise<void>
  agentExecutablePath?: string
  installationId?: string
  agentServiceUnitName?: string
  releaseKeyRegistry?: AgentReleaseKeyRegistry
  runtimeLock?: RemoteRuntimeLock
  registry?: RuntimeBundleRegistry
  prerequisitesAvailable?: () => boolean | Promise<boolean>
  launchProcess?: typeof launchDirectLinuxStdioProcessOwner
  reconcileOrphanedProcesses?: (
    installationId: string
  ) => Promise<unknown>
  ownerRegistry?: RuntimeOwnerRegistry
  verificationEnvironment?: 'production' | 'test'
  filesystemPlatform?: NodeJS.Platform
  reportError?: (message: string, error: unknown) => void
  diagnostics?: Pick<AgentDiagnosticLog, 'tryRecord'>
}

export async function createProductionRuntimeProtocol(
  options: ProductionRuntimeCompositionOptions
): Promise<ProductionRuntimeProtocol> {
  const runtimeRoot = resolve(options.runtimeRoot)
  const stateDirectory = resolve(options.stateDirectory)
  const verificationEnvironment =
    options.verificationEnvironment ?? 'production'
  const installationId =
    options.installationId ??
    (verificationEnvironment === 'test'
      ? 'test-installation'
      : undefined)
  if (installationId === undefined) {
    throw new Error(
      'Production Runtime composition requires its Agent installation identity'
    )
  }
  ensurePrivateDirectory(stateDirectory, { create: false })
  const ownerRegistry =
    options.ownerRegistry ??
    new RuntimeOwnerRegistry(join(stateDirectory, 'runtime-owners.sqlite'))
  const semanticPrompts = new SemanticPromptStore(
    join(stateDirectory, 'semantic-prompts.sqlite')
  )
  const modelCallLedger = new AgentModelCallLedger(
    join(stateDirectory, 'model-calls.sqlite')
  )
  const modelGateway = new AgentModelGateway({
    ledger: modelCallLedger
  })
  let registry = options.registry
  const currentRegistry = (): RuntimeBundleRegistry => {
    if (registry === undefined) {
      registry = new RuntimeBundleRegistry({ runtimeRoot })
    }
    return registry
  }
  let verificationOptionsPromise:
    | Promise<{
        architecture: AgentArchitecture
        releaseKeyRegistry: AgentReleaseKeyRegistry
        runtimeLock: RemoteRuntimeLock
        verificationEnvironment: 'production' | 'test'
        filesystemPlatform?: NodeJS.Platform
      }>
    | undefined
  const currentVerificationOptions = () => {
    verificationOptionsPromise ??= (async () => {
      const metadataOptions =
        options.filesystemPlatform === undefined
          ? {}
          : {
              filesystemPlatform:
                options.filesystemPlatform
            }
      const [releaseKeyRegistry, runtimeLock] =
        await Promise.all([
          options.releaseKeyRegistry ??
            readManagedAgentReleaseKeyRegistry(
              join(runtimeRoot, 'release-keys.json'),
              metadataOptions
            ),
          options.runtimeLock ??
            readRemoteRuntimeLock(
              join(
                runtimeRoot,
                'remote-runtime-lock.json'
              ),
              metadataOptions
            )
        ])
      return {
        architecture: options.architecture,
        releaseKeyRegistry,
        runtimeLock,
        verificationEnvironment,
        ...(options.filesystemPlatform === undefined
          ? {}
          : {
              filesystemPlatform:
                options.filesystemPlatform
            })
      }
    })()
    void verificationOptionsPromise.catch(() => {
      verificationOptionsPromise = undefined
    })
    return verificationOptionsPromise
  }
  const verifiedRuntimeCache =
    new Map<string, Promise<VerifiedRuntimeBundle>>()
  const loadRegistered = (
    entry: RuntimeRegistryEntry,
    bundleDirectory: string
  ): Promise<VerifiedRuntimeBundle> => {
    const key = `${bundleDirectory}\0${JSON.stringify(entry)}`
    const cached = verifiedRuntimeCache.get(key)
    if (cached !== undefined) {
      return cached
    }
    const loading = (async () =>
      await loadRegisteredRuntimeBundle(
        bundleDirectory,
        {
          ...(await currentVerificationOptions()),
          registered: entry
        }
      ))()
    verifiedRuntimeCache.set(key, loading)
    void loading.catch(() => {
      if (verifiedRuntimeCache.get(key) === loading) {
        verifiedRuntimeCache.delete(key)
      }
    })
    return loading
  }
  const verifiedCapabilities = async () => {
    const source = createVerifiedRuntimeCapabilitySource({
      registry: currentRegistry(),
      ...(await currentVerificationOptions()),
      loadRegistered,
      reportError: options.reportError
    })
    return await source()
  }
  const prerequisites =
    options.prerequisitesAvailable ??
    productionRuntimePrerequisitesAvailable
  const launchProcess =
    options.launchProcess ?? launchDirectLinuxStdioProcessOwner
  let backend: RuntimeAcpBackend
  try {
    if (
      verificationEnvironment === 'production' &&
      process.platform === 'linux'
    ) {
      await (
        options.reconcileOrphanedProcesses ??
        (async (currentInstallationId: string) =>
          await reconcileOrphanedDirectLinuxStdioProcesses({
            installationId: currentInstallationId,
            registry: ownerRegistry
          }))
      )(installationId)
    }
    ensurePrivateDirectoryTree(
      join(stateDirectory, 'runtime-scratch'),
      stateDirectory
    )
    ensurePrivateDirectoryTree(
      join(stateDirectory, 'model-bridges'),
      stateDirectory
    )
    backend = new RuntimeAcpBackend({
      journal: options.events,
      resolveRuntimeBundle: (runtimeId, bundleDigest) =>
        currentRegistry().resolve(
          runtimeId,
          bundleDigest,
          options.architecture
        ),
      loadRegisteredRuntimeBundle: async (resolved) => {
        return await loadRegistered(
          resolved.entry,
          resolved.bundleDirectory
        )
      },
      resolveWorkspace: async (preparation, context) =>
        resolveCurrentWorkspace(
          options.workspaces,
          stateDirectory,
          preparation,
          context
        ),
      launchProcess: async (launch) =>
        await launchProcess({
          manifest: launch.manifest,
          profileInput: {
            bundleDirectory: launch.bundle.bundleDirectory,
            workspaceDirectory: launch.workspace.workspaceDirectory,
            scratchDirectory: launch.scratch,
            workMode: launch.workMode,
            ...(launch.modelBridge === undefined ||
            options.agentExecutablePath === undefined
              ? {}
              : {
                  modelBridge: {
                    agentExecutablePath: resolve(
                      options.agentExecutablePath
                    ),
                    bridgeDirectory:
                      launch.workspace.bridgeDirectory!,
                    socketPath: launch.modelBridge.socketPath,
                    policy: launch.modelBridge.policy
                  }
                })
          },
          identity: {
            launchId: `launch-${randomUUID()}`,
            processId: `process-${randomUUID()}`
          },
          installationId,
          registry: ownerRegistry,
          deadlineAt: launch.deadlineAt,
          maximumInputBytes: launch.budget.maximumInputBytes
        }),
      outputSink: options.outputSink,
      semanticPrompts,
      modelGateway,
      diagnostics: options.diagnostics,
      ...(options.blobSink === undefined
        ? {}
        : { blobSink: options.blobSink })
    })
  } catch (error) {
    semanticPrompts.close()
    modelCallLedger.close()
    if (options.ownerRegistry === undefined) {
      ownerRegistry.close()
    }
    throw error
  }

  return {
    runtimes: async () => {
      try {
        if (
          options.blobSink === undefined ||
          options.agentExecutablePath === undefined ||
          !(await executableAvailable(
            resolve(options.agentExecutablePath)
          )) ||
          !(await prerequisites())
        ) {
          return []
        }
      } catch (error) {
        options.reportError?.(
          'Agent Runtime prerequisites are unavailable',
          error
        )
        return []
      }
      try {
        return await verifiedCapabilities()
      } catch (error) {
        options.reportError?.(
          'Agent Runtime metadata is unavailable; Runtime remains disabled',
          error
        )
        return []
      }
    },
    methods: backend.methods,
    onAcpFrame: backend.onAcpFrame,
    ...(options.blobSink === undefined ||
    options.agentExecutablePath === undefined
      ? {}
      : {
          onBlobFrame: backend.onBlobFrame,
          authorizeBlobFrame: backend.authorizeBlobFrame
        }),
    dispose: async () => {
      await backend.dispose()
      semanticPrompts.close()
      modelCallLedger.close()
      if (options.ownerRegistry === undefined) {
        ownerRegistry.close()
      }
    }
  }
}

async function executableAvailable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function resolveCurrentWorkspace(
  workspaces: WorkspaceRegistry,
  stateDirectory: string,
  preparation: Pick<
    RemotePromptOperationPreparation,
    | 'bindingId'
    | 'runtimeBundleDigest'
    | 'workspaceIdentity'
    | 'modelBridge'
    | 'modelProfile'
  >,
  context: ProtocolMethodContext
): Promise<{
  workspaceIdentity: string
  workspaceDirectory: string
  scratchDirectory: string
  bridgeDirectory?: string
}> {
  const lease = await workspaces.getCurrentByIdentity(
    preparation.workspaceIdentity,
    context.controller,
    { signal: context.signal }
  )
  const scratchDirectory = derivePrivateRuntimeScratchDirectory(
    stateDirectory,
    {
      bindingId: preparation.bindingId,
      runtimeBundleDigest: preparation.runtimeBundleDigest,
      workspaceIdentity: preparation.workspaceIdentity
    }
  )
  const bridgeDirectory =
    preparation.modelBridge === undefined &&
    preparation.modelProfile === undefined
      ? undefined
      : derivePrivateModelBridgeDirectory(
          stateDirectory,
          {
            bindingId: preparation.bindingId,
            runtimeBundleDigest:
              preparation.runtimeBundleDigest,
            workspaceIdentity:
              preparation.workspaceIdentity
          }
        )
  return {
    workspaceIdentity: lease.handle.workspaceIdentity,
    workspaceDirectory: lease.access.root.canonicalPath,
    scratchDirectory,
    ...(bridgeDirectory === undefined
      ? {}
      : { bridgeDirectory })
  }
}

export function derivePrivateModelBridgeDirectory(
  stateDirectoryInput: string,
  binding: {
    bindingId: string
    runtimeBundleDigest: string
    workspaceIdentity: string
    controllerId?: string
    controllerGeneration?: number
  }
): string {
  if (process.platform === 'linux') {
    const stateDirectory = resolve(stateDirectoryInput)
    ensurePrivateDirectory(stateDirectory, { create: false })
    const userRoot = ensurePrivateTemporaryRoot(
      derivePrivateTemporaryRoot()
    )
    const bridgeRoot = join(userRoot, 'mb')
    ensurePrivateDirectoryTree(bridgeRoot, userRoot)
    const bindingDirectory = join(
      bridgeRoot,
      createHash('sha256')
        .update(
          JSON.stringify([
            'goodbuddy-model-bridge-v2',
            stateDirectory,
            binding.bindingId,
            binding.runtimeBundleDigest,
            binding.workspaceIdentity
          ])
        )
        .digest('hex')
        .slice(0, 32)
    )
    ensurePrivateDirectoryTree(bindingDirectory, bridgeRoot)
    return bindingDirectory
  }
  return derivePrivateBindingDirectory(
    stateDirectoryInput,
    'model-bridges',
    'goodbuddy-model-bridge-v1',
    binding
  )
}

export function derivePrivateRuntimeScratchDirectory(
  stateDirectoryInput: string,
  binding: {
    bindingId: string
    runtimeBundleDigest: string
    workspaceIdentity: string
    controllerId?: string
    controllerGeneration?: number
  }
): string {
  return derivePrivateBindingDirectory(
    stateDirectoryInput,
    'runtime-scratch',
    'goodbuddy-runtime-scratch-v1',
    binding
  )
}

function derivePrivateBindingDirectory(
  stateDirectoryInput: string,
  rootName: 'model-bridges' | 'runtime-scratch',
  digestDomain:
    | 'goodbuddy-model-bridge-v1'
    | 'goodbuddy-runtime-scratch-v1',
  binding: {
    bindingId: string
    runtimeBundleDigest: string
    workspaceIdentity: string
  }
): string {
  const stateDirectory = resolve(stateDirectoryInput)
  ensurePrivateDirectory(stateDirectory, { create: false })
  const bindingRoot = join(stateDirectory, rootName)
  ensurePrivateDirectoryTree(bindingRoot, stateDirectory)
  const bindingDigest = bindingDirectoryDigest(
    digestDomain,
    binding
  )
  const bindingDirectory = join(bindingRoot, bindingDigest)
  ensurePrivateDirectoryTree(bindingDirectory, bindingRoot)
  return bindingDirectory
}

function bindingDirectoryDigest(
  digestDomain:
    | 'goodbuddy-model-bridge-v1'
    | 'goodbuddy-runtime-scratch-v1',
  binding: {
    bindingId: string
    runtimeBundleDigest: string
    workspaceIdentity: string
  }
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      digestDomain,
      binding.bindingId,
      binding.runtimeBundleDigest,
      binding.workspaceIdentity
    ]))
    .digest('hex')
}

async function productionRuntimePrerequisitesAvailable(): Promise<boolean> {
  try {
    await access(BWRAP_EXECUTABLE, constants.X_OK)
    return true
  } catch {
    return false
  }
}
