import {
  RemoteWorkspaceAccess,
  type RemoteWorkspaceAccessFactory,
  type RemoteWorkspaceProjectBinding
} from '../workspace/remote-workspace-access'
import type { RemoteAgentConnectionManager } from './remote-agent-connection-manager'
import type { AgentInstallationManager } from './agent-installation-manager'
import {
  ProtocolRemoteWorkspaceTransport,
  type RemoteWorkspaceInstallationIdentityResolver
} from './protocol-remote-workspace-transport'

export type ManagedRemoteWorkspaceAccessFactoryOptions = {
  connectionManager: Pick<RemoteAgentConnectionManager, 'acquire'>
  installationManager: Pick<AgentInstallationManager, 'activateInstalled'>
}

/**
 * Resolves the Host's current Agent before opening a read-only Workspace
 * connection. Projects persist only the Host and remote path.
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
      resolve: async (hostId, signal) => {
        if (hostId !== binding.hostId) {
          throw new Error(
            'Remote workspace Host does not match its project binding'
          )
        }

        signal?.throwIfAborted()
        return {
          installation:
            await this.options.installationManager.activateInstalled(
              hostId,
              { ...(signal === undefined ? {} : { signal }) }
            )
        }
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
