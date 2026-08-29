import {
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type RemoteRuntimeBundleManifest
} from '../shared/remote-runtime-launch-contracts'
import { verifyRuntimeBundle } from './runtime-bundle-verifier'
import {
  RuntimeBundleRegistry,
  createVerifiedRuntimeCapabilitySource
} from './runtime-bundle-registry'
import {
  createRuntimeBundleTestFixture,
  TEST_REMOTE_RUNTIME_LOCK
} from './runtime-bundle-test-fixture'

const temporaryPaths: string[] = []
const lock = TEST_REMOTE_RUNTIME_LOCK

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('Remote Runtime bundle verifier', () => {
  it('verifies an authentic digest-addressed OpenCode bundle', async () => {
    const fixture = await createBundle()

    await expect(
      verifyRuntimeBundle(fixture.bundleDirectory, {
        architecture: 'x64',
        releaseKeyRegistry: fixture.registry,
        runtimeLock: lock,
        verificationEnvironment: 'test',
        filesystemPlatform: 'win32'
      })
    ).resolves.toMatchObject({
      bundleDirectory: fixture.bundleDirectory,
      executablePath: join(
        fixture.bundleDirectory,
        'bin',
        'opencode'
      ),
      manifest: fixture.manifest,
      manifestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
    })
  })

  it('fails closed on test signing keys in production verification', async () => {
    const fixture = await createBundle()

    await expect(
      verifyRuntimeBundle(fixture.bundleDirectory, {
        architecture: 'x64',
        releaseKeyRegistry: fixture.registry,
        runtimeLock: lock,
        filesystemPlatform: 'win32'
      })
    ).rejects.toThrow(/production key registry is empty/iu)
  })

  it('rejects a forged signature and payload mutation', async () => {
    const forged = await createBundle()
    const signaturePath = join(
      forged.bundleDirectory,
      'manifest.sig'
    )
    const signature = Buffer.from(
      readFileSync(signaturePath, 'utf8').trim(),
      'base64'
    )
    signature[0] ^= 0xff
    writeFileSync(
      signaturePath,
      `${signature.toString('base64')}\n`
    )
    await expect(
      verifyRuntimeBundle(forged.bundleDirectory, {
        architecture: 'x64',
        releaseKeyRegistry: forged.registry,
        runtimeLock: lock,
        verificationEnvironment: 'test',
        filesystemPlatform: 'win32'
      })
    ).rejects.toThrow(/signature verification failed/iu)

    const mutated = await createBundle()
    writeFileSync(
      join(mutated.bundleDirectory, 'licenses', 'opencode.txt'),
      'mutated'
    )
    await expect(
      verifyRuntimeBundle(mutated.bundleDirectory, {
        architecture: 'x64',
        releaseKeyRegistry: mutated.registry,
        runtimeLock: lock,
        verificationEnvironment: 'test',
        filesystemPlatform: 'win32'
      })
    ).rejects.toThrow(/payload (?:size|hash) mismatch/iu)
  })

  it('rejects a validly signed bundle outside the locked profile', async () => {
    const fixture = await createBundle({
      sourcePackage: {
        name: 'opencode-linux-x64',
        integrity:
          'sha512-VrvzV5Agrj0T2ZPvr5gzmh8xc4zqQ5pW8UeNgTzt5cJ/9Cbdxw6oFywgv7nfJqlpSfQqTWYJYH+LIHt3QdCS5g=='
      }
    })

    await expect(
      verifyRuntimeBundle(fixture.bundleDirectory, {
        architecture: 'x64',
        releaseKeyRegistry: fixture.registry,
        runtimeLock: lock,
        verificationEnvironment: 'test',
        filesystemPlatform: 'win32'
      })
    ).rejects.toThrow(/locked OpenCode profile/iu)
  })

  it('rejects undeclared files and a mismatched digest directory', async () => {
    const undeclared = await createBundle()
    writeFileSync(
      join(undeclared.bundleDirectory, 'unexpected.txt'),
      'unexpected'
    )
    await expect(
      verifyRuntimeBundle(undeclared.bundleDirectory, {
        architecture: 'x64',
        releaseKeyRegistry: undeclared.registry,
        runtimeLock: lock,
        verificationEnvironment: 'test',
        filesystemPlatform: 'win32'
      })
    ).rejects.toThrow(/undeclared or missing/iu)

    const mismatched = await createBundle({
      directoryDigest: `sha256:${'f'.repeat(64)}`
    })
    await expect(
      verifyRuntimeBundle(mismatched.bundleDirectory, {
        architecture: 'x64',
        releaseKeyRegistry: mismatched.registry,
        runtimeLock: lock,
        verificationEnvironment: 'test',
        filesystemPlatform: 'win32'
      })
    ).rejects.toThrow(/managed directory/iu)
  })

  it('uses registered metadata without rereading Runtime payload files', async () => {
    const fixture = await createBundle()
    const runtimeRoot = dirname(dirname(fixture.bundleDirectory))
    const registry = new RuntimeBundleRegistry({
      runtimeRoot
    })
    const verified = await verifyRuntimeBundle(
      fixture.bundleDirectory,
      {
        architecture: 'x64',
        releaseKeyRegistry: fixture.registry,
        runtimeLock: lock,
        verificationEnvironment: 'test',
        filesystemPlatform: 'win32'
      }
    )
    new RuntimeBundleRegistry({ runtimeRoot }).register(verified)
    const reportError = vi.fn()
    const capabilities = createVerifiedRuntimeCapabilitySource({
      registry,
      architecture: 'x64',
      releaseKeyRegistry: fixture.registry,
      runtimeLock: lock,
      verificationEnvironment: 'test',
      filesystemPlatform: 'win32',
      reportError
    })
    await expect(capabilities()).resolves.toEqual([
      {
        runtimeId: 'opencode',
        version: '1.18.9',
        bundleDigest: fixture.manifest.bundleDigest,
        acpCapabilitiesDigest:
          fixture.manifest.acpCapabilitiesDigest,
        sessionLoad: true,
        sessionResume: true
      }
    ])

    writeFileSync(
      join(fixture.bundleDirectory, 'licenses', 'opencode.txt'),
      'mutated'
    )
    await expect(capabilities()).resolves.toHaveLength(1)
    expect(reportError).not.toHaveBeenCalled()

    writeFileSync(
      join(fixture.bundleDirectory, 'bin', 'opencode'),
      Buffer.concat([
        readFileSync(
          join(fixture.bundleDirectory, 'bin', 'opencode')
        ),
        Buffer.from('changed')
      ])
    )
    await expect(capabilities()).resolves.toEqual([])
    expect(reportError).toHaveBeenCalledWith(
      'Verified Runtime unavailable: opencode',
      expect.any(Error)
    )
  })
})

async function createBundle(
  overrides: {
    sourcePackage?: RemoteRuntimeBundleManifest['sourcePackage']
    directoryDigest?: string
  } = {}
): Promise<Awaited<
  ReturnType<typeof createRuntimeBundleTestFixture>
>> {
  const fixture = await createRuntimeBundleTestFixture(overrides)
  temporaryPaths.push(fixture.root)
  return fixture
}
