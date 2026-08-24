import {
  createHash,
  generateKeyPairSync,
  sign
} from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type {
  AgentReleaseKeyRegistry
} from '../shared/agent-installation-contracts'
import {
  digestRemoteRuntimeBundleIdentity,
  remoteRuntimeBundleManifestSchema,
  type RemoteRuntimeBundleManifest,
  type RemoteRuntimeLock
} from '../shared/remote-runtime-launch-contracts'
import {
  canonicalRuntimeManifestBytes,
  runtimeManifestSignaturePayload
} from './runtime-bundle-verifier'

const RAW_DIGEST = 'a'.repeat(64)

export const TEST_REMOTE_RUNTIME_LOCK: RemoteRuntimeLock = {
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

export async function createRuntimeBundleTestFixture(
  overrides: {
    sourcePackage?: RemoteRuntimeBundleManifest['sourcePackage']
    directoryDigest?: string
  } = {}
): Promise<{
  root: string
  bundleDirectory: string
  manifest: RemoteRuntimeBundleManifest
  registry: AgentReleaseKeyRegistry
}> {
  const root = resolve(
    mkdtempSync(join(tmpdir(), 'goodbuddy-runtime-bundle-'))
  )
  if (process.platform !== 'win32') {
    chmodSync(root, 0o700)
  }
  const binary = elfHeader('x64')
  const license = Buffer.from('MIT\n', 'utf8')
  const initial = remoteRuntimeBundleManifestSchema.parse({
    formatVersion: 2,
    product: 'GoodBuddy',
    runtimeId: 'opencode',
    runtimeVersion: '1.18.9',
    provider: 'opencode',
    platform: 'linux',
    architecture: 'x64',
    signingKeyId: 'runtime-test',
    bundleDigest: `sha256:${RAW_DIGEST}`,
    adapterDigest: `sha256:${'b'.repeat(64)}`,
    sourcePackage:
      overrides.sourcePackage ??
      {
        name:
          TEST_REMOTE_RUNTIME_LOCK.runtimes.opencode.targets.x64
            .package,
        integrity:
          TEST_REMOTE_RUNTIME_LOCK.runtimes.opencode.targets.x64
            .integrity
      },
    entrypoint: {
      identity: 'opencode-acp',
      path: 'bin/opencode',
      sha256: sha256(binary),
      argvPrefix: ['acp']
    },
    files: [
      {
        path: 'bin/opencode',
        size: binary.byteLength,
        sha256: sha256(binary),
        mode: '0755'
      },
      {
        path: 'licenses/opencode.txt',
        size: license.byteLength,
        sha256: sha256(license),
        mode: '0644'
      }
    ],
    licenses: [
      {
        package: 'opencode-ai',
        version: '1.18.9',
        spdx: 'MIT',
        path: 'licenses/opencode.txt'
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
    acpCapabilitiesDigest: `sha256:${'d'.repeat(64)}`,
    limits: {
      maximumPromptRuntimeMilliseconds: 60_000,
      maximumPromptInputBytes: 4096,
      maximumPromptOutputBytes: 1024 * 1024
    }
  })
  const manifest = remoteRuntimeBundleManifestSchema.parse({
    ...initial,
    bundleDigest:
      await digestRemoteRuntimeBundleIdentity(initial)
  })
  const directoryDigest =
    overrides.directoryDigest ?? manifest.bundleDigest
  const bundleDirectory = resolve(
    root,
    'opencode',
    directoryDigest.slice('sha256:'.length)
  )
  writePayload(
    join(bundleDirectory, 'bin', 'opencode'),
    binary,
    0o755
  )
  writePayload(
    join(bundleDirectory, 'licenses', 'opencode.txt'),
    license,
    0o644
  )

  const { publicKey, privateKey } =
    generateKeyPairSync('ed25519')
  const registry: AgentReleaseKeyRegistry = {
    formatVersion: 1,
    keys: [
      {
        keyId: 'runtime-test',
        publicKeySpkiBase64: publicKey
          .export({ format: 'der', type: 'spki' })
          .toString('base64'),
        environment: 'test'
      }
    ],
    revocations: []
  }
  const manifestBytes = canonicalRuntimeManifestBytes(manifest)
  writePayload(
    join(bundleDirectory, 'manifest.json'),
    manifestBytes,
    0o644
  )
  writePayload(
    join(bundleDirectory, 'manifest.sig'),
    Buffer.from(
      `${sign(
        null,
        runtimeManifestSignaturePayload(manifestBytes),
        privateKey
      ).toString('base64')}\n`,
      'utf8'
    ),
    0o644
  )
  if (process.platform !== 'win32') {
    chmodSync(bundleDirectory, 0o700)
    chmodSync(join(bundleDirectory, 'bin'), 0o700)
    chmodSync(join(bundleDirectory, 'licenses'), 0o700)
  }
  return { root, bundleDirectory, manifest, registry }
}

function writePayload(
  path: string,
  contents: Uint8Array,
  mode: number
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, contents, { mode })
  if (process.platform !== 'win32') {
    chmodSync(path, mode)
  }
}

function elfHeader(architecture: 'x64' | 'arm64'): Buffer {
  const header = Buffer.alloc(64)
  header[0] = 0x7f
  header.write('ELF', 1, 'ascii')
  header[4] = 2
  header[5] = 1
  header.writeUInt16LE(architecture === 'x64' ? 62 : 183, 18)
  return header
}

function sha256(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}
