import { join } from 'node:path'
import type { AgentArchitecture } from '../../shared/agent-installation-contracts'

export type BundledRemoteRuntimeResourcePaths = {
  keyRegistryPath: string
  runtimeLockPath: string
  runtimeRoots: Record<AgentArchitecture, string>
}

export type BundledRemoteRuntimeResourceEnvironment = {
  appPath: string
  resourcesPath: string
  packaged: boolean
}

export function resolveBundledRemoteRuntimeResourcePaths(
  environment: BundledRemoteRuntimeResourceEnvironment
): BundledRemoteRuntimeResourcePaths {
  if (environment.packaged) {
    return {
      keyRegistryPath: join(
        environment.resourcesPath,
        'agent-release-keys.json'
      ),
      runtimeLockPath: join(
        environment.resourcesPath,
        'remote-runtime-lock.json'
      ),
      runtimeRoots: {
        x64: join(
          environment.resourcesPath,
          'remote-runtimes',
          'linux-x64',
          'opencode'
        ),
        arm64: join(
          environment.resourcesPath,
          'remote-runtimes',
          'linux-arm64',
          'opencode'
        )
      }
    }
  }

  return {
    keyRegistryPath: join(
      environment.appPath,
      'resources',
      'agent-release-keys.json'
    ),
    runtimeLockPath: join(
      environment.appPath,
      'remote-runtime-lock.json'
    ),
    runtimeRoots: {
      x64: join(
        environment.appPath,
        '.remote-runtime-resources',
        'linux-x64',
        'opencode'
      ),
      arm64: join(
        environment.appPath,
        '.remote-runtime-resources',
        'linux-arm64',
        'opencode'
      )
    }
  }
}

export function getBundledRemoteRuntimeRoot(
  paths: BundledRemoteRuntimeResourcePaths,
  architecture: AgentArchitecture
): string {
  return paths.runtimeRoots[architecture]
}
