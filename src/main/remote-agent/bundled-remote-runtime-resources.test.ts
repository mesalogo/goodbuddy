import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getBundledRemoteRuntimeRoot,
  resolveBundledRemoteRuntimeResourcePaths
} from './bundled-remote-runtime-resources'

describe('bundled remote Runtime resource paths', () => {
  it('resolves development metadata and architecture roots', () => {
    const paths = resolveBundledRemoteRuntimeResourcePaths({
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
        'remote-runtime-lock.json'
      ),
      runtimeRoots: {
        x64: join(
          'workspace',
          'goodbuddy',
          '.remote-runtime-resources',
          'linux-x64',
          'opencode'
        ),
        arm64: join(
          'workspace',
          'goodbuddy',
          '.remote-runtime-resources',
          'linux-arm64',
          'opencode'
        )
      }
    })
  })

  it('resolves packaged metadata and Runtime roots outside ASAR', () => {
    const paths = resolveBundledRemoteRuntimeResourcePaths({
      appPath: join('installed', 'resources', 'app.asar'),
      resourcesPath: join('installed', 'resources'),
      packaged: true
    })

    expect(paths.keyRegistryPath).toBe(
      join('installed', 'resources', 'agent-release-keys.json')
    )
    expect(paths.runtimeLockPath).toBe(
      join('installed', 'resources', 'remote-runtime-lock.json')
    )
    expect(getBundledRemoteRuntimeRoot(paths, 'x64')).toBe(
      join(
        'installed',
        'resources',
        'remote-runtimes',
        'linux-x64',
        'opencode'
      )
    )
    expect(getBundledRemoteRuntimeRoot(paths, 'arm64')).toBe(
      join(
        'installed',
        'resources',
        'remote-runtimes',
        'linux-arm64',
        'opencode'
      )
    )
  })
})
