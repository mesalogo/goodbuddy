import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentArchitecture,
  AgentReleaseKeyRegistry
} from '../../shared/agent-installation-contracts'
import {
  digestRemoteRuntimeBundleIdentity,
  digestRemoteRuntimeBundleManifest,
  type RemoteRuntimeBundleManifest,
  type RemoteRuntimeLock
} from '../../shared/remote-runtime-launch-contracts'
import type { BundledRemoteRuntimeResourcePaths } from './bundled-remote-runtime-resources'
import {
  createRemoteRuntimeResourceLoader,
  loadRemoteRuntimeVerificationMetadata,
  loadVerifiedRemoteRuntimeResourceBundle
} from './remote-runtime-resource-loader'
import {
  RemoteRuntimeBundleResourcesUnavailableError
} from './remote-runtime-installation-manager'

const temporaryDirectories: string[] = []
const registry: AgentReleaseKeyRegistry = {
  formatVersion: 1,
  keys: [],
  revocations: []
}
const runtimeLock: RemoteRuntimeLock = {
  formatVersion: 1,
  runtimes: {
    opencode: {
      version: '1.18.9',
      provider: 'opencode',
      entrypoint: 'bin/opencode',
      entrypointIdentity: 'opencode-acp',
      argvPrefix: ['acp'],
      allowedEnvironmentNames: [
        'HOME',
        'LANG',
        'LC_ALL',
        'PATH',
        'TMPDIR',
        'XDG_CACHE_HOME',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME'
      ],
      protocol: { major: 1, minor: 0 },
      targets: {
        x64: {
          package: 'opencode-linux-x64-baseline',
          integrity:
            'sha512-x4KiJk9EF7ktM18Ru5Jue4kTntxMvlhWb7tHniQGGRvY2KeoK1iIkyAFd7ri5H/fSkM22hNv/Gg1Jk6/h9IlxQ=='
        },
        arm64: {
          package: 'opencode-linux-arm64',
          integrity:
            'sha512-2IN4lLjhx2FICcMDnBsKgwrey0AvAM0SlNzzj7L71uakNxWvrhcqPYVpEhrEYUjIn+uQGMY5PjA+uupXigJE2A=='
        }
      }
    }
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('remote Runtime resource loader', () => {
  it('loads one verified digest directory and preserves metadata bytes', async () => {
    const fixture = await createFixture()
    const verify = vi.fn(async (bundleDirectory) => ({
      bundleDirectory,
      executablePath: join(bundleDirectory, 'bin', 'opencode'),
      manifest: fixture.manifest,
      manifestDigest:
        await digestRemoteRuntimeBundleManifest(fixture.manifest)
    }))

    const loaded = await loadVerifiedRemoteRuntimeResourceBundle(
      fixture.paths,
      'x64',
      {
        verificationEnvironment: 'test',
        verifyRuntimeBundle: verify
      }
    )

    expect(verify).toHaveBeenCalledWith(fixture.bundleDirectory, {
      architecture: 'x64',
      releaseKeyRegistry: registry,
      runtimeLock,
      verificationEnvironment: 'test'
    })
    expect(loaded).toEqual({
      bundleDirectory: fixture.bundleDirectory,
      manifest: fixture.manifest,
      manifestDigest:
        await digestRemoteRuntimeBundleManifest(fixture.manifest),
      canonicalReleaseKeyRegistryBytes: canonical(registry),
      canonicalRemoteRuntimeLockBytes: canonical(runtimeLock)
    })
    expect(Object.keys(loaded)).toHaveLength(5)
  })

  it('rejects verification injection outside test verification', async () => {
    const fixture = await createFixture()
    const verify = vi.fn()

    expect(() =>
      createRemoteRuntimeResourceLoader(fixture.paths, {
        verifyRuntimeBundle: verify
      })
    ).toThrow('allowed only in test verification')
    await expect(
      loadVerifiedRemoteRuntimeResourceBundle(
        fixture.paths,
        'x64',
        { verifyRuntimeBundle: verify }
      )
    ).rejects.toThrow('allowed only in test verification')
  })

  it('rejects missing and multiple digest directories', async () => {
    const missing = await createFixture({ digestDirectories: 0 })
    const multiple = await createFixture({ digestDirectories: 2 })
    const verify = vi.fn()

    await expect(loadWithTestVerifier(missing.paths, verify))
      .rejects.toThrow('exactly one digest directory')
    await expect(loadWithTestVerifier(multiple.paths, verify))
      .rejects.toThrow('exactly one digest directory')
    expect(verify).not.toHaveBeenCalled()
  })

  it('loads verification metadata when installable Runtime resources are not packaged', async () => {
    const fixture = await createFixture()
    await rm(fixture.paths.runtimeRoots.x64, {
      recursive: true,
      force: true
    })

    await expect(
      loadVerifiedRemoteRuntimeResourceBundle(
        fixture.paths,
        'x64',
        { verificationEnvironment: 'test' }
      )
    ).rejects.toBeInstanceOf(
      RemoteRuntimeBundleResourcesUnavailableError
    )
    await expect(
      loadRemoteRuntimeVerificationMetadata(fixture.paths)
    ).resolves.toEqual({
      releaseKeyRegistry: registry,
      runtimeLock,
      canonicalReleaseKeyRegistryBytes: canonical(registry),
      canonicalRemoteRuntimeLockBytes: canonical(runtimeLock)
    })
  })

  it('accepts equivalent key-registry formatting and returns canonical bytes', async () => {
    const fixture = await createFixture()
    await writeFile(
      fixture.paths.keyRegistryPath,
      Buffer.from(
        canonical(registry).toString('utf8').replace(/\n/gu, '\r\n')
      )
    )

    await expect(
      loadRemoteRuntimeVerificationMetadata(fixture.paths)
    ).resolves.toMatchObject({
      releaseKeyRegistry: registry,
      canonicalReleaseKeyRegistryBytes: canonical(registry)
    })
  })

  it('rejects a symlinked digest directory', async () => {
    const fixture = await createFixture({ digestDirectories: 0 })
    const target = join(fixture.root, 'target')
    await mkdir(target)
    await symlink(
      target,
      join(fixture.paths.runtimeRoots.x64, 'a'.repeat(64)),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    await expect(loadWithTestVerifier(fixture.paths, vi.fn()))
      .rejects.toThrow('not a real directory')
  })

  it('rejects architecture and digest-directory mismatches', async () => {
    const fixture = await createFixture()
    const wrongArchitecture = {
      ...fixture.manifest,
      architecture: 'arm64' as const
    }
    const architectureVerifier = vi.fn(async (bundleDirectory) => ({
      bundleDirectory,
      executablePath: join(bundleDirectory, 'bin', 'opencode'),
      manifest: wrongArchitecture,
      manifestDigest:
        await digestRemoteRuntimeBundleManifest(wrongArchitecture)
    }))
    await expect(
      loadWithTestVerifier(fixture.paths, architectureVerifier)
    ).rejects.toThrow('does not match the requested OpenCode target')

    const wrongDigest = {
      ...fixture.manifest,
      bundleDigest: `sha256:${'f'.repeat(64)}` as const
    }
    const digestVerifier = vi.fn(async (bundleDirectory) => ({
      bundleDirectory,
      executablePath: join(bundleDirectory, 'bin', 'opencode'),
      manifest: wrongDigest,
      manifestDigest:
        await digestRemoteRuntimeBundleManifest(wrongDigest)
    }))
    await expect(
      loadWithTestVerifier(fixture.paths, digestVerifier)
    ).rejects.toThrow('does not match its resource directory')
  })

  it.each([
    {
      name: 'malformed',
      bytes: Buffer.from('not json\n'),
      error: 'invalid JSON'
    },
    {
      name: 'oversize',
      bytes: Buffer.alloc(1024 * 1024 + 1, 0x20),
      error: 'exceeds its safety limit'
    }
  ])('rejects $name metadata', async ({ bytes, error }) => {
    const fixture = await createFixture()
    await writeFile(fixture.paths.keyRegistryPath, bytes)

    await expect(loadWithTestVerifier(fixture.paths, vi.fn()))
      .rejects.toThrow(error)
  })
})

async function createFixture(options: {
  digestDirectories?: number
} = {}): Promise<{
  root: string
  paths: BundledRemoteRuntimeResourcePaths
  bundleDirectory: string
  manifest: RemoteRuntimeBundleManifest
}> {
  const root = await mkdtemp(join(tmpdir(), 'runtime-loader-'))
  temporaryDirectories.push(root)
  const paths: BundledRemoteRuntimeResourcePaths = {
    keyRegistryPath: join(root, 'agent-release-keys.json'),
    runtimeLockPath: join(root, 'remote-runtime-lock.json'),
    runtimeRoots: {
      x64: join(root, 'linux-x64', 'opencode'),
      arm64: join(root, 'linux-arm64', 'opencode')
    }
  }
  await mkdir(paths.runtimeRoots.x64, { recursive: true })
  await mkdir(paths.runtimeRoots.arm64, { recursive: true })
  await writeFile(paths.keyRegistryPath, canonical(registry))
  await writeFile(paths.runtimeLockPath, canonical(runtimeLock))
  const manifest = await createManifest('x64')
  const digest = manifest.bundleDigest.slice('sha256:'.length)
  const directoryCount = options.digestDirectories ?? 1
  for (let index = 0; index < directoryCount; index += 1) {
    await mkdir(
      join(
        paths.runtimeRoots.x64,
        index === 0 ? digest : 'e'.repeat(64)
      )
    )
  }
  return {
    root,
    paths,
    bundleDirectory: join(paths.runtimeRoots.x64, digest),
    manifest
  }
}

async function createManifest(
  architecture: AgentArchitecture
): Promise<RemoteRuntimeBundleManifest> {
  const executable = Buffer.from('opencode')
  const license = Buffer.from('license')
  const initial: RemoteRuntimeBundleManifest = {
    formatVersion: 2,
    product: 'GoodBuddy',
    runtimeId: 'opencode',
    runtimeVersion: '1.18.9',
    provider: 'opencode',
    platform: 'linux',
    architecture,
    signingKeyId: 'test-key',
    bundleDigest: `sha256:${'0'.repeat(64)}`,
    adapterDigest: `sha256:${'1'.repeat(64)}`,
    sourcePackage: {
      name:
        runtimeLock.runtimes.opencode.targets[architecture].package,
      integrity:
        runtimeLock.runtimes.opencode.targets[architecture].integrity
    },
    entrypoint: {
      identity: 'opencode-acp',
      path: 'bin/opencode',
      sha256: sha256(executable),
      argvPrefix: ['acp']
    },
    files: [
      {
        path: 'bin/opencode',
        size: executable.byteLength,
        sha256: sha256(executable),
        mode: '0755'
      },
      {
        path: 'licenses/LICENSE',
        size: license.byteLength,
        sha256: sha256(license),
        mode: '0644'
      }
    ],
    licenses: [
      {
        package: 'opencode',
        version: '1.18.9',
        spdx: 'MIT',
        path: 'licenses/LICENSE'
      }
    ],
    allowedEnvironmentNames: [
      'HOME',
      'LANG',
      'LC_ALL',
      'PATH',
      'TMPDIR',
      'XDG_CACHE_HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME'
    ],
    protocol: { major: 1, minor: 0 },
    acpCapabilitiesDigest: `sha256:${'3'.repeat(64)}`,
    limits: {
      maximumPromptRuntimeMilliseconds: 60_000,
      maximumPromptInputBytes: 1024 * 1024,
      maximumPromptOutputBytes: 1024 * 1024
    }
  }
  return {
    ...initial,
    bundleDigest: await digestRemoteRuntimeBundleIdentity(initial)
  }
}

function loadWithTestVerifier(
  paths: BundledRemoteRuntimeResourcePaths,
  verifyRuntimeBundle: NonNullable<
    Parameters<
      typeof loadVerifiedRemoteRuntimeResourceBundle
    >[2]
  >['verifyRuntimeBundle']
) {
  return loadVerifiedRemoteRuntimeResourceBundle(paths, 'x64', {
    verificationEnvironment: 'test',
    verifyRuntimeBundle
  })
}

function canonical(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function sha256(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}
