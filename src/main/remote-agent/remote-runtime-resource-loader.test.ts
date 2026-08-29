import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentReleaseKeyRegistry } from '../../shared/agent-installation-contracts'
import type { RemoteRuntimeLock } from '../../shared/remote-runtime-launch-contracts'
import type { BundledRemoteRuntimeResourcePaths } from './bundled-remote-runtime-resources'
import { loadRemoteRuntimeVerificationMetadata } from './remote-runtime-resource-loader'

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
        'HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR',
        'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
        'XDG_STATE_HOME'
      ],
      protocol: { major: 1, minor: 0 },
      targets: {
        x64: {
          package: 'opencode-linux-x64-baseline',
          integrity: `sha512-${'A'.repeat(86)}==`
        },
        arm64: {
          package: 'opencode-linux-arm64',
          integrity: `sha512-${'B'.repeat(86)}==`
        }
      }
    }
  }
}

function canonical(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

async function createFixture(): Promise<{
  root: string
  paths: BundledRemoteRuntimeResourcePaths
}> {
  const root = await mkdtemp(join(tmpdir(), 'runtime-metadata-loader-'))
  temporaryDirectories.push(root)
  const paths: BundledRemoteRuntimeResourcePaths = {
    keyRegistryPath: join(root, 'agent-release-keys.json'),
    runtimeLockPath: join(root, 'remote-runtime-lock.json'),
    runtimeRoots: {
      x64: join(root, 'unused-x64'),
      arm64: join(root, 'unused-arm64')
    }
  }
  await Promise.all([
    writeFile(paths.keyRegistryPath, canonical(registry)),
    writeFile(paths.runtimeLockPath, canonical(runtimeLock))
  ])
  return { root, paths }
}

describe('remote Runtime verification metadata loader', () => {
  it('loads canonical verification metadata without Runtime payloads', async () => {
    const fixture = await createFixture()

    await expect(
      loadRemoteRuntimeVerificationMetadata(fixture.paths)
    ).resolves.toEqual({
      releaseKeyRegistry: registry,
      runtimeLock,
      canonicalReleaseKeyRegistryBytes: canonical(registry),
      canonicalRemoteRuntimeLockBytes: canonical(runtimeLock)
    })
  })

  it('canonicalizes equivalent release-key registry formatting', async () => {
    const fixture = await createFixture()
    await writeFile(
      fixture.paths.keyRegistryPath,
      canonical(registry).toString('utf8').replace(/\n/gu, '\r\n')
    )

    await expect(
      loadRemoteRuntimeVerificationMetadata(fixture.paths)
    ).resolves.toMatchObject({
      releaseKeyRegistry: registry,
      canonicalReleaseKeyRegistryBytes: canonical(registry)
    })
  })

  it.each([
    { bytes: Buffer.from('not json\n'), error: 'invalid JSON' },
    {
      bytes: Buffer.alloc(1024 * 1024 + 1, 0x20),
      error: 'exceeds its safety limit'
    }
  ])('rejects invalid bounded metadata', async ({ bytes, error }) => {
    const fixture = await createFixture()
    await writeFile(fixture.paths.runtimeLockPath, bytes)

    await expect(
      loadRemoteRuntimeVerificationMetadata(fixture.paths)
    ).rejects.toThrow(error)
  })

  it('rejects metadata paths that are not regular files', async () => {
    const fixture = await createFixture()
    await rm(fixture.paths.keyRegistryPath)
    await mkdir(fixture.paths.keyRegistryPath)

    await expect(
      loadRemoteRuntimeVerificationMetadata(fixture.paths)
    ).rejects.toThrow('not a regular file')
  })
})
