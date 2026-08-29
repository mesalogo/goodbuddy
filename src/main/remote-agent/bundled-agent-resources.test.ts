import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getBundledAgentDirectory,
  resolveBundledAgentResourcePaths,
  resolveControlPlanePackageInstallerPath
} from './bundled-agent-resources'

describe('bundled Agent resource paths', () => {
  it('resolves development resources from injected application paths', () => {
    const paths = resolveBundledAgentResourcePaths({
      appPath: join('workspace', 'goodbuddy'),
      resourcesPath: join('electron', 'resources'),
      packaged: false
    })

    expect(paths).toEqual({
      keyRegistryPath: join(
        'workspace',
        'goodbuddy',
        'resources',
        'agent-release-keys.json'
      ),
      runtimeLockPath: join(
        'workspace',
        'goodbuddy',
        'agent-runtime-lock.json'
      ),
      bundleDirectories: {
        x64: join(
          'workspace',
          'goodbuddy',
          '.agent-resources',
          'linux-x64'
        ),
        arm64: join(
          'workspace',
          'goodbuddy',
          '.agent-resources',
          'linux-arm64'
        )
      }
    })
  })

  it('resolves packaged metadata and both Agent bundles outside ASAR', () => {
    const paths = resolveBundledAgentResourcePaths({
      appPath: join('installed', 'resources', 'app.asar'),
      resourcesPath: join('installed', 'resources'),
      packaged: true
    })

    expect(paths.keyRegistryPath).toBe(
      join('installed', 'resources', 'agent-release-keys.json')
    )
    expect(paths.runtimeLockPath).toBe(
      join('installed', 'resources', 'agent-runtime-lock.json')
    )
    expect(
      resolveControlPlanePackageInstallerPath({
        appPath: join(
          'installed',
          'resources',
          'app.asar'
        )
      })
    ).toBe(
      join(
        'installed',
        'resources',
        'app.asar',
        'out',
        'main',
        'remote-package-installer.mjs'
      )
    )
    expect(getBundledAgentDirectory(paths, 'x64')).toBe(
      join('installed', 'resources', 'agents', 'linux-x64')
    )
    expect(getBundledAgentDirectory(paths, 'arm64')).toBe(
      join('installed', 'resources', 'agents', 'linux-arm64')
    )
  })
})
