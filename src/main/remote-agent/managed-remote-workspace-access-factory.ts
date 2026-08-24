import {
  RemoteWorkspaceAccess,
  type RemoteWorkspaceAccessFactory,
  type RemoteWorkspaceProjectBinding
} from '../workspace/remote-workspace-access'
import type { AgentInstallationManager } from './agent-installation-manager'
import type { RemoteAgentConnectionManager } from './remote-agent-connection-manager'
import {
  ProtocolRemoteWorkspaceTransport,
  type RemoteWorkspaceInstallationIdentityResolver
} from './protocol-remote-workspace-transport'

export type ManagedRemoteWorkspaceAccessFactoryOptions = {
  installationManager: Pick<
    AgentInstallationManager,
    'ensureInstalled'
  >
  connectionManager: Pick<RemoteAgentConnectionManager, 'acquire'>
}

/**
 * Composes persisted project validation with fresh installation and
 * connection leases. The resulting WorkspaceAccess remains strictly
 * read-only and owns every acquired connection lease.
 */
export class ManagedRemoteWorkspaceAccessFactory
  implements RemoteWorkspaceAccessFactory
{
  constructor(
    private readonly options: ManagedRemoteWorkspaceAccessFactoryOptions
  ) {}

  create(bindingInput: RemoteWorkspaceProjectBinding): RemoteWorkspaceAccess {
    const binding = { ...bindingInput }
    const resolver: RemoteWorkspaceInstallationIdentityResolver = {
      resolve: async (hostId, installationId, signal) => {
        if (
          hostId !== binding.hostId ||
          installationId !== binding.agentInstallationId
        ) {
          throw new Error(
            'Remote workspace installation request does not match its project binding'
          )
        }

        signal?.throwIfAborted()
        const installation =
          await this.options.installationManager.ensureInstalled(
            binding.hostId,
            { signal }
          )
        signal?.throwIfAborted()
        assertInstallationMatches(binding, installation)
        return { installation }
      }
    }
    return new RemoteWorkspaceAccess(
      binding,
      new ProtocolRemoteWorkspaceTransport(
        this.options.connectionManager,
        resolver
      )
    )
  }
}

function assertInstallationMatches(
  binding: RemoteWorkspaceProjectBinding,
  installation: Awaited<
    ReturnType<AgentInstallationManager['ensureInstalled']>
  >
): void {
  if (
    installation.installationId !== binding.agentInstallationId ||
    installation.binaryDigest !== binding.agentBinaryDigest ||
    installation.agentVersion !== binding.agentVersion ||
    installation.architecture !== binding.agentArchitecture ||
    installation.protocol.major !== binding.agentProtocolMajor
  ) {
    throw new Error(
      'Installed Remote Agent does not match the persisted project binding'
    )
  }
}
