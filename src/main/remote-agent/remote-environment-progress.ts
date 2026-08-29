import type { RemoteEnvironmentUpdateProgress } from '../../shared/ssh-host-contracts'
import type { AgentInstallationPhase } from './agent-installation-manager'
import type { RemoteRuntimeInstallationPhase } from './remote-runtime-installation-manager'

export function mapAgentInstallationPhase(
  phase: AgentInstallationPhase
): RemoteEnvironmentUpdateProgress['phase'] | undefined {
  switch (phase) {
    case 'inspecting-host':
      return 'probing'
    case 'verifying-bundle':
      return 'verifying'
    case 'starting-agent':
      return 'installing-agent'
    case 'checking-health':
      return 'checking-health'
    case 'complete':
      return undefined
  }
}

export function mapRuntimeInstallationPhase(
  phase: RemoteRuntimeInstallationPhase
): RemoteEnvironmentUpdateProgress['phase'] | undefined {
  switch (phase) {
    case 'inspecting-host':
      return 'probing'
    case 'verifying-bundle':
      return 'verifying'
    case 'activating-runtime':
      return 'installing-runtime'
    case 'complete':
      return undefined
  }
}
