import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RemoteRuntimeBundleManifest } from '../shared/remote-runtime-launch-contracts'
import { RuntimeBundleRegistry } from './runtime-bundle-registry'
import type { VerifiedRuntimeBundle } from './runtime-bundle-verifier'

const temporaryPaths: string[] = []

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('Runtime bundle registry', () => {
  it('registers and resolves the current signed digest atomically', () => {
    const fixture = createRegistry()
    const verified = runtimeBundle(fixture, '1.18.9', 'a')

    const entry = fixture.registry.register(verified)

    expect(entry).toMatchObject({
      runtimeId: 'opencode',
      runtimeVersion: '1.18.9',
      architecture: 'x64',
      bundleDigest: verified.manifest.bundleDigest
    })
    expect(
      fixture.registry.resolve(
        'opencode',
        verified.manifest.bundleDigest,
        'x64'
      )
    ).toEqual({
      entry,
      bundleDirectory: verified.bundleDirectory
    })
    expect(
      new RuntimeBundleRegistry({
        runtimeRoot: fixture.runtimeRoot
      }).snapshot()
    ).toEqual(fixture.registry.snapshot())
  })

  it('reuses an exact bundle and replaces it with another signed identity', () => {
    const fixture = createRegistry()
    const first = runtimeBundle(fixture, '1.18.9', 'a')
    const second = runtimeBundle(fixture, '1.19.0', 'b')

    expect(fixture.registry.register(first)).toEqual(
      fixture.registry.register(first)
    )
    fixture.registry.register(second)

    expect(fixture.registry.snapshot().current).toEqual([
      expect.objectContaining({
        runtimeVersion: '1.19.0',
        bundleDigest: second.manifest.bundleDigest
      })
    ])
    expect(() =>
      fixture.registry.resolve(
        'opencode',
        first.manifest.bundleDigest,
        'x64'
      )
    ).toThrow('not the verified current bundle')
  })

  it('rewrites the previous sequence registry into the minimal format', () => {
    const fixture = createRegistry()
    writeFileSync(
      fixture.storagePath,
      `${JSON.stringify({
        formatVersion: 1,
        minimumTrustedReleaseSequence: 1,
        current: [{
          runtimeId: 'opencode',
          provider: 'opencode',
          runtimeVersion: '1.18.9',
          releaseSequence: 3,
          architecture: 'x64',
          signingKeyId: 'test-key',
          bundleDigest: `sha256:${'a'.repeat(64)}`,
          manifestDigest: `sha256:${'b'.repeat(64)}`,
          acpCapabilitiesDigest: `sha256:${'c'.repeat(64)}`
        }]
      }, null, 2)}\n`,
      { mode: 0o600 }
    )

    expect(
      new RuntimeBundleRegistry({
        runtimeRoot: fixture.runtimeRoot
      }).snapshot()
    ).toEqual({
      formatVersion: 1,
      current: [{
        runtimeId: 'opencode',
        runtimeVersion: '1.18.9',
        architecture: 'x64',
        bundleDigest: `sha256:${'a'.repeat(64)}`,
        manifestDigest: `sha256:${'b'.repeat(64)}`,
        acpCapabilitiesDigest: `sha256:${'c'.repeat(64)}`
      }]
    })
    expect(readFileSync(fixture.storagePath, 'utf8')).not.toContain(
      'releaseSequence'
    )
  })

  it('observes activations from another registry instance without no-op writes', () => {
    const fixture = createRegistry()
    const activator = new RuntimeBundleRegistry({
      runtimeRoot: fixture.runtimeRoot
    })
    const first = runtimeBundle(fixture, '1.18.9', 'a')
    const firstEntry = activator.register(first)

    expect(fixture.registry.current('x64')).toEqual([firstEntry])
    expect(
      fixture.registry.resolve(
        'opencode',
        first.manifest.bundleDigest,
        'x64'
      )
    ).toEqual({
      entry: firstEntry,
      bundleDirectory: first.bundleDirectory
    })
    const beforeNoOp = fileIdentity(fixture.storagePath)
    expect(fixture.registry.register(first)).toEqual(firstEntry)
    expect(fileIdentity(fixture.storagePath)).toEqual(beforeNoOp)

    const second = runtimeBundle(fixture, '1.19.0', 'b')
    const secondEntry = new RuntimeBundleRegistry({
      runtimeRoot: fixture.runtimeRoot
    }).register(second)
    const beforeSecondNoOp = fileIdentity(fixture.storagePath)
    expect(fixture.registry.register(second)).toEqual(secondEntry)
    expect(fileIdentity(fixture.storagePath)).toEqual(
      beforeSecondNoOp
    )
    expect(fixture.registry.current('x64')).toEqual([secondEntry])
    expect(() =>
      fixture.registry.resolve(
        'opencode',
        first.manifest.bundleDigest,
        'x64'
      )
    ).toThrow('not the verified current bundle')
  })

  it('fails closed when the live registry becomes corrupt', () => {
    const fixture = createRegistry()
    writeFileSync(fixture.storagePath, '{"formatVersion":1}', {
      mode: 0o600
    })
    expect(() => fixture.registry.current('x64')).toThrow(
      /corrupt/iu
    )
    expect(() =>
      new RuntimeBundleRegistry({
        runtimeRoot: fixture.runtimeRoot
      })
    ).toThrow(/corrupt/iu)
    expect(readFileSync(fixture.storagePath, 'utf8')).toContain(
      'formatVersion'
    )
  })
})

function fileIdentity(path: string): {
  ino: bigint
  mtimeNs: bigint
  ctimeNs: bigint
} {
  const stat = statSync(path, { bigint: true })
  return {
    ino: stat.ino,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs
  }
}

function createRegistry(): {
  registry: RuntimeBundleRegistry
  runtimeRoot: string
  storagePath: string
} {
  const root = resolve(
    mkdtempSync(join(tmpdir(), 'goodbuddy-runtime-registry-'))
  )
  temporaryPaths.push(root)
  if (process.platform !== 'win32') {
    chmodSync(root, 0o700)
  }
  const runtimeRoot = resolve(root, 'runtimes')
  const storagePath = resolve(runtimeRoot, 'registry.json')
  return {
    registry: new RuntimeBundleRegistry({ runtimeRoot }),
    runtimeRoot,
    storagePath
  }
}

function runtimeBundle(
  fixture: ReturnType<typeof createRegistry>,
  runtimeVersion: string,
  digestCharacter: string
): VerifiedRuntimeBundle {
  const rawBundleDigest = digestCharacter.repeat(64)
  const bundleDigest = `sha256:${rawBundleDigest}`
  const bundleDirectory =
    fixture.registry.bundleDirectory('opencode', bundleDigest)
  mkdirSync(bundleDirectory, {
    recursive: true,
    mode: 0o700
  })
  const manifest = {
    formatVersion: 2,
    product: 'GoodBuddy',
    runtimeId: 'opencode',
    runtimeVersion,
    provider: 'opencode',
    platform: 'linux',
    architecture: 'x64',
    signingKeyId: 'runtime-test',
    bundleDigest,
    adapterDigest: `sha256:${'a'.repeat(64)}`,
    sourcePackage: {
      name: 'opencode-linux-x64-baseline',
      integrity:
        'sha512-x4KiJk9EF7ktM18Ru5Jue4kTntxMvlhWb7tHniQGGRvY2KeoK1iIkyAFd7ri5H/fSkM22hNv/Gg1Jk6/h9IlxQ=='
    },
    entrypoint: {
      identity: 'opencode-acp',
      path: 'bin/opencode',
      sha256: 'c'.repeat(64),
      argvPrefix: ['acp']
    },
    files: [
      {
        path: 'bin/opencode',
        size: 64,
        sha256: 'c'.repeat(64),
        mode: '0755'
      },
      {
        path: 'licenses/opencode.txt',
        size: 4,
        sha256: 'd'.repeat(64),
        mode: '0644'
      }
    ],
    licenses: [
      {
        package: 'opencode-ai',
        version: runtimeVersion,
        spdx: 'MIT',
        path: 'licenses/opencode.txt'
      }
    ],
    allowedEnvironmentNames: ['HOME'],
    protocol: { major: 1, minor: 0 },
    acpCapabilitiesDigest: `sha256:${'e'.repeat(64)}`,
    limits: {
      maximumPromptRuntimeMilliseconds: 60_000,
      maximumPromptInputBytes: 4096,
      maximumPromptOutputBytes: 1024 * 1024
    }
  } as const satisfies RemoteRuntimeBundleManifest
  return {
    bundleDirectory,
    executablePath: resolve(bundleDirectory, 'bin', 'opencode'),
    manifest,
    manifestDigest: `sha256:${rawBundleDigest}`
  }
}
