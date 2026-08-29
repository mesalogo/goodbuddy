import { join } from 'node:path'
import type { AgentArchitecture } from '../../shared/agent-installation-contracts'

export type BundledAgentResourcePaths = {
  keyRegistryPath: string
  runtimeLockPath: string
  bundleDirectories: Record<AgentArchitecture, string>
}

export type BundledAgentResourceEnvironment = {
  appPath: string
  resourcesPath: string
  packaged: boolean
}

export function resolveBundledAgentResourcePaths(
  environment: BundledAgentResourceEnvironment
): BundledAgentResourcePaths {
  const metadataRoot = environment.packaged
    ? environment.resourcesPath
    : environment.appPath
  const bundleRoot = environment.packaged
    ? join(environment.resourcesPath, 'agents')
    : join(environment.appPath, '.agent-resources')

  return {
    keyRegistryPath: environment.packaged
      ? join(metadataRoot, 'agent-release-keys.json')
      : join(metadataRoot, 'resources', 'agent-release-keys.json'),
    runtimeLockPath: join(metadataRoot, 'agent-runtime-lock.json'),
    bundleDirectories: {
      x64: join(bundleRoot, 'linux-x64'),
      arm64: join(bundleRoot, 'linux-arm64')
    }
  }
}

export function resolveControlPlanePackageInstallerPath(
  environment: Pick<BundledAgentResourceEnvironment, 'appPath'>
): string {
  return join(
    environment.appPath,
    'out',
    'main',
    'remote-package-installer.mjs'
  )
}

export function getBundledAgentDirectory(
  paths: BundledAgentResourcePaths,
  architecture: AgentArchitecture
): string {
  return paths.bundleDirectories[architecture]
}
