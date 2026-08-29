import { isDeepStrictEqual } from 'node:util'
import type { ResolvedModelProfile } from '../runtime-settings-store'
import type { RemoteAgentConnection } from './remote-agent-connection-manager'
import type {
  RemoteProjectRuntimeValidationInput,
  RemoteProjectRuntimeValidationLease,
  RemoteProjectRuntimeValidator
} from './remote-project-save-service'
import type {
  RemoteRuntimeInstallationIdentity,
  RemoteRuntimeInstallationManager
} from './remote-runtime-installation-manager'

const RUNTIME_ACP_CAPABILITY = 'runtime/acp'
const RUNTIME_ACP_CAPABILITY_VERSION = 3
const RUNTIME_MODEL_BRIDGE_CAPABILITY = 'runtime/model-bridge'
const RUNTIME_MODEL_BRIDGE_CAPABILITY_VERSION = 1

export class ManagedRemoteProjectRuntimeValidator
  implements RemoteProjectRuntimeValidator
{
  readonly #installationManager: Pick<
    RemoteRuntimeInstallationManager,
    'activateInstalled'
  >
  readonly #resolveModelProfile: (
    selection: RemoteProjectRuntimeValidationInput['selection']
  ) => Promise<ResolvedModelProfile | undefined>

  constructor(options: {
    installationManager: Pick<
      RemoteRuntimeInstallationManager,
      'activateInstalled'
    >
    resolveModelProfile(
      selection: RemoteProjectRuntimeValidationInput['selection']
    ): Promise<ResolvedModelProfile | undefined>
  }) {
    this.#installationManager = options.installationManager
    this.#resolveModelProfile = options.resolveModelProfile
  }

  async validate(
    input: RemoteProjectRuntimeValidationInput
  ): Promise<RemoteProjectRuntimeValidationLease> {
    input.signal.throwIfAborted()
    if (
      input.selection.provider !== 'opencode'
    ) {
      throw new Error(
        'Managed remote projects require the OpenCode Runtime'
      )
    }
    assertInputIdentity(input)
    const modelProfile = await this.#resolveModelProfile(
      input.selection
    )
    input.signal.throwIfAborted()
    if (
      modelProfile === undefined ||
      modelProfile.protocol === 'openai-images-generations' ||
      (modelProfile.authentication === 'api-key' &&
        !modelProfile.apiKey)
    ) {
      throw new Error(
        'Managed remote OpenCode requires a usable text model profile'
      )
    }
    const installation =
      await this.#installationManager.activateInstalled(
        input.host.hostId,
        {
          signal: input.signal,
          agentInstallationId: input.agent.installationId
        }
      )
    input.signal.throwIfAborted()
    assertInstallationIdentity(input, installation)

    const refreshed = await input.connection.refreshCapabilities(
      input.signal
    )
    input.signal.throwIfAborted()
    if (
      input.connection.state !== 'ready' ||
      !isDeepStrictEqual(input.connection.capabilities, refreshed)
    ) {
      throw new Error(
        'Remote Agent capabilities changed during Runtime validation'
      )
    }
    assertRuntimeCapability(refreshed, installation)

    const capabilitySnapshot = structuredClone(refreshed)
    let released = false
    return {
      assertCurrent: (): void => {
        if (released) {
          throw new Error(
            'Remote Runtime validation lease is released'
          )
        }
        if (input.connection.state !== 'ready') {
          throw new Error(
            'Remote Runtime validation connection is not ready'
          )
        }
        let current: RemoteAgentConnection['capabilities']
        try {
          current = input.connection.capabilities
        } catch (error) {
          throw new Error(
            'Remote Runtime validation connection is not ready',
            { cause: error }
          )
        }
        if (!isDeepStrictEqual(current, capabilitySnapshot)) {
          throw new Error(
            'Remote Runtime capability validation is stale'
          )
        }
      },
      release: (): void => {
        released = true
      }
    }
  }
}

function assertInputIdentity(
  input: RemoteProjectRuntimeValidationInput
): void {
  const connection = input.connection
  if (
    connection.state !== 'ready' ||
    connection.identity.hostId !== input.host.hostId ||
    connection.identity.hostRevision !== input.host.hostRevision ||
    connection.identity.hostKeyGeneration !==
      input.host.hostKeyGeneration ||
    connection.identity.remoteUsername !==
      input.host.remoteUsername ||
    connection.identity.installationId !==
      input.agent.installationId ||
    connection.identity.binaryDigest !== input.agent.binaryDigest ||
    connection.identity.protocolMajor !== input.agent.protocolMajor ||
    connection.status.state !== 'ready' ||
    connection.status.draining ||
    connection.status.installationId !==
      input.agent.installationId ||
    connection.status.binaryDigest !== input.agent.binaryDigest ||
    connection.status.agentVersion !== input.agent.version ||
    connection.status.architecture !== input.agent.architecture ||
    connection.status.protocol.major !== input.agent.protocolMajor
  ) {
    throw new Error(
      'Remote Agent identity does not match Runtime validation'
    )
  }
}

function assertInstallationIdentity(
  input: RemoteProjectRuntimeValidationInput,
  installation: RemoteRuntimeInstallationIdentity
): void {
  if (
    installation.runtimeId !== 'opencode' ||
    installation.platform !== 'linux' ||
    installation.architecture !== input.agent.architecture
  ) {
    throw new Error(
      'Installed OpenCode Runtime architecture is incompatible'
    )
  }
}

function assertRuntimeCapability(
  capabilities: RemoteAgentConnection['capabilities'],
  installation: RemoteRuntimeInstallationIdentity
): void {
  const acp = capabilities.capabilities.find(
    (capability) => capability.name === RUNTIME_ACP_CAPABILITY
  )
  const modelBridge = capabilities.capabilities.find(
    (capability) =>
      capability.name === RUNTIME_MODEL_BRIDGE_CAPABILITY
  )
  const runtimes = capabilities.runtimes.filter(
    (runtime) => runtime.runtimeId === 'opencode'
  )
  if (
    acp === undefined ||
    acp.version !== RUNTIME_ACP_CAPABILITY_VERSION ||
    !acp.critical ||
    modelBridge === undefined ||
    modelBridge.version !==
      RUNTIME_MODEL_BRIDGE_CAPABILITY_VERSION ||
    !modelBridge.critical ||
    runtimes.length !== 1
  ) {
    throw new Error(
      'Remote Agent does not advertise the required Runtime ACP capability'
    )
  }
  const runtime = runtimes[0]!
  if (
    runtime.version !== installation.runtimeVersion ||
    runtime.bundleDigest !== installation.bundleDigest ||
    runtime.acpCapabilitiesDigest !==
      installation.acpCapabilitiesDigest ||
    !runtime.sessionLoad ||
    !runtime.sessionResume
  ) {
    throw new Error(
      'Advertised OpenCode Runtime does not match the verified installation'
    )
  }
}
