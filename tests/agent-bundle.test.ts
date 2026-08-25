import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject
} from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

type Manifest = {
  formatVersion: 1
  product: 'GoodBuddy'
  agentVersion: string
  platform: 'linux'
  arch: 'x64' | 'arm64'
  protocol: { major: number; minor: number }
  signingKeyId: string
  entrypoint: {
    path: string
    runtimePath: string
    scriptPath: string
  }
  files: Array<{
    path: string
    size: number
    sha256: string
    mode: string
  }>
  licenses: Array<{
    package: string
    version: string
    spdx: string
    path: string
  }>
}

type KeyRegistry = {
  formatVersion: 1
  keys: Array<{
    keyId: string
    publicKeySpkiBase64: string
    environment: 'production' | 'test'
  }>
  revocations: Array<{
    keyId: string
  }>
}

interface AgentBundleModule {
  assertSafeManifestPath: (path: string) => void
  canonicalManifestBytes: (manifest: Manifest) => Buffer
  createAgentArchive: (
    directory: string,
    archivePath: string
  ) => void
  createManifest: (
    directory: string,
    metadata: Record<string, unknown>
  ) => Manifest
  detectElfArchitecture: (
    contents: Buffer
  ) => 'x64' | 'arm64' | undefined
  lockedRuntimeInput: (
    lock: Record<string, unknown>,
    arch: string,
    path: string
  ) => unknown
  preflightProductionSigningKey: (options: {
    keyId?: string
    registry: KeyRegistry
  }) => KeyRegistry['keys'][number]
  productionSigningKey: (
    environment: NodeJS.ProcessEnv
  ) => { keyId: string; privateKey: string }
  publicKeySpkiBase64: (key: KeyObject) => string
  redactSecrets: (
    value: string,
    environment: NodeJS.ProcessEnv
  ) => string
  signManifestForTest: (
    manifest: Buffer,
    key: KeyObject
  ) => Buffer
  verifyBundleDirectory: (
    directory: string,
    options: {
      registry: KeyRegistry
      verificationEnvironment?: string
      enforceFilesystemMode?: boolean
    }
  ) => {
    manifest: Manifest
    manifestSha256: string
  }
  verifyManifestSignature: (
    manifest: Buffer,
    signature: Buffer,
    registry: KeyRegistry,
    options?: { verificationEnvironment?: string }
  ) => Manifest
}

const require = createRequire(import.meta.url)
const agentBundle = require(
  '../build/agent-bundle.cjs'
) as AgentBundleModule

let directory: string
let privateKey: KeyObject
let registry: KeyRegistry

function elf(arch: 'x64' | 'arm64'): Buffer {
  const contents = Buffer.alloc(64)
  contents.set([0x7f, 0x45, 0x4c, 0x46])
  contents[5] = 1
  contents.writeUInt16LE(arch === 'x64' ? 62 : 183, 18)
  return contents
}

function writeKoffiPayload(
  bundleDirectory: string,
  architecture: 'x64' | 'arm64'
): void {
  const packageRoot = join(
    bundleDirectory,
    'lib',
    'node_modules',
    'koffi'
  )
  const nativePackage = `@koromix/koffi-linux-${architecture}`
  const nativeRoot = join(
    bundleDirectory,
    'lib',
    'node_modules',
    ...nativePackage.split('/')
  )
  mkdirSync(join(packageRoot, 'src', 'koffi', 'src'), {
    recursive: true
  })
  mkdirSync(join(nativeRoot, `linux_${architecture}`), {
    recursive: true
  })
  mkdirSync(join(nativeRoot, `musl_${architecture}`), {
    recursive: true
  })
  const files = new Map<string, string | Buffer>([
    [
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: 'koffi',
        version: '3.1.4',
        type: 'module',
        exports: { '.': { import: './index.js' } }
      })
    ],
    [
      join(packageRoot, 'index.js'),
      'export { default } from "./src/koffi/index.js";\n'
    ],
    [
      join(packageRoot, 'src', 'koffi', 'index.js'),
      'export default {};\n'
    ],
    [
      join(packageRoot, 'src', 'koffi', 'src', 'static.js'),
      'export function loadStatic() { return null }\n'
    ],
    [
      join(nativeRoot, 'package.json'),
      JSON.stringify({
        name: nativePackage,
        version: '3.1.4',
        main: './index.js',
        os: ['linux'],
        cpu: [architecture]
      })
    ],
    [
      join(nativeRoot, 'index.js'),
      `module.exports = require('./linux_${architecture}/koffi.node');\n`
    ],
    [
      join(nativeRoot, `linux_${architecture}`, 'koffi.node'),
      elf(architecture)
    ],
    [
      join(nativeRoot, `musl_${architecture}`, 'koffi.node'),
      elf(architecture)
    ]
  ])
  for (const [filePath, contents] of files) {
    writeFileSync(filePath, contents)
    chmodSync(filePath, 0o644)
  }
}

function writeFixtureBundle(): {
  manifest: Manifest
  manifestBytes: Buffer
} {
  mkdirSync(join(directory, 'lib'), { recursive: true })
  mkdirSync(join(directory, 'licenses'), { recursive: true })
  writeFileSync(join(directory, 'node'), elf('x64'))
  writeFileSync(join(directory, 'goodbuddy-agent'), '#!/bin/sh\n')
  writeFileSync(join(directory, 'lib', 'agent.cjs'), 'module.exports={}\n')
  writeFileSync(join(directory, 'licenses', 'GoodBuddy-0BSD.txt'), '0BSD')
  writeFileSync(join(directory, 'licenses', 'Node.js-MIT.txt'), 'MIT')
  writeFileSync(join(directory, 'licenses', 'zod-MIT.txt'), 'MIT')
  writeFileSync(join(directory, 'licenses', 'koffi-MIT.txt'), 'MIT')
  writeFileSync(
    join(directory, 'licenses', 'koffi-native-MIT.txt'),
    'MIT'
  )
  writeKoffiPayload(directory, 'x64')
  for (const path of [
    'node',
    'goodbuddy-agent'
  ]) {
    chmodSync(join(directory, path), 0o755)
  }
  for (const path of [
    'lib/agent.cjs',
    'licenses/GoodBuddy-0BSD.txt',
    'licenses/Node.js-MIT.txt',
    'licenses/zod-MIT.txt',
    'licenses/koffi-MIT.txt',
    'licenses/koffi-native-MIT.txt'
  ]) {
    chmodSync(join(directory, ...path.split('/')), 0o644)
  }
  const manifest = agentBundle.createManifest(directory, {
    agentVersion: '0.11.0',
    nodeVersion: '24.19.0',
    zodVersion: '4.4.3',
    koffiVersion: '3.1.4',
    koffiNativePackage: '@koromix/koffi-linux-x64',
    arch: 'x64',
    protocol: { major: 1, minor: 0 },
    signingKeyId: 'fixture-test-key'
  })
  const manifestBytes =
    agentBundle.canonicalManifestBytes(manifest)
  writeFileSync(join(directory, 'manifest.json'), manifestBytes)
  writeFileSync(
    join(directory, 'manifest.sig'),
    `${agentBundle
      .signManifestForTest(manifestBytes, privateKey)
      .toString('base64')}\n`
  )
  chmodSync(join(directory, 'manifest.json'), 0o644)
  chmodSync(join(directory, 'manifest.sig'), 0o644)
  return { manifest, manifestBytes }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'goodbuddy-agent-bundle-'))
  // Deterministic repository-visible fixture seed; never a production key.
  privateKey = createPrivateKey({
    key: Buffer.from(
      '302e020100300506032b657004220420000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
      'hex'
    ),
    format: 'der',
    type: 'pkcs8'
  })
  const publicKey = createPublicKey(privateKey)
  registry = {
    formatVersion: 1,
    keys: [
      {
        keyId: 'fixture-test-key',
        publicKeySpkiBase64:
          agentBundle.publicKeySpkiBase64(publicKey),
        environment: 'test'
      }
    ],
    revocations: []
  }
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('deterministic signed Agent manifests', () => {
  it('produces byte-identical manifests and detached signatures', () => {
    const first = writeFixtureBundle()
    const firstSignature = readFileSync(
      join(directory, 'manifest.sig')
    )
    rmSync(join(directory, 'manifest.json'))
    rmSync(join(directory, 'manifest.sig'))
    const secondManifest = agentBundle.createManifest(directory, {
      agentVersion: '0.11.0',
      nodeVersion: '24.19.0',
      zodVersion: '4.4.3',
      koffiVersion: '3.1.4',
      koffiNativePackage: '@koromix/koffi-linux-x64',
      arch: 'x64',
      protocol: { major: 1, minor: 0 },
      signingKeyId: 'fixture-test-key'
    })
    const secondBytes =
      agentBundle.canonicalManifestBytes(secondManifest)
    const secondSignature = agentBundle.signManifestForTest(
      secondBytes,
      privateKey
    )

    expect(secondBytes).toEqual(first.manifestBytes)
    expect(secondSignature.toString('base64')).toBe(
      firstSignature.toString('utf8').trim()
    )
  })

  it('produces byte-identical portable archives', () => {
    writeFixtureBundle()
    const firstArchive = `${directory}-first.tar`
    const secondArchive = `${directory}-second.tar`
    try {
      agentBundle.createAgentArchive(directory, firstArchive)
      agentBundle.createAgentArchive(directory, secondArchive)
      expect(readFileSync(secondArchive)).toEqual(
        readFileSync(firstArchive)
      )
    } finally {
      rmSync(firstArchive, { force: true })
      rmSync(secondArchive, { force: true })
    }
  })

  it('verifies signature, hashes, paths, modes, licenses, and ELF arch', () => {
    writeFixtureBundle()
    expect(
      agentBundle.verifyBundleDirectory(directory, {
        registry,
        verificationEnvironment: 'test'
      }).manifest
    ).toMatchObject({
      arch: 'x64',
      protocol: { major: 1, minor: 0 }
    })

    writeFileSync(join(directory, 'lib', 'agent.cjs'), 'tampered')
    expect(() =>
      agentBundle.verifyBundleDirectory(directory, {
        registry,
        verificationEnvironment: 'test'
      })
    ).toThrow(/size mismatch|hash mismatch/u)
  })

  it('rejects a modified detached signature', () => {
    const { manifestBytes } = writeFixtureBundle()
    const signature = Buffer.from(
      readFileSync(join(directory, 'manifest.sig'), 'utf8').trim(),
      'base64'
    )
    signature[0] = (signature[0] ?? 0) ^ 1
    expect(() =>
      agentBundle.verifyManifestSignature(
        manifestBytes,
        signature,
        registry,
        { verificationEnvironment: 'test' }
      )
    ).toThrow('signature verification failed')
  })

  it.each([
    ['../outside'],
    ['/absolute'],
    ['nested\\windows'],
    ['nested//empty'],
    ['nested/./dot']
  ])('rejects unsafe manifest path %s', (path) => {
    expect(() =>
      agentBundle.assertSafeManifestPath(path)
    ).toThrow('Unsafe Agent manifest path')
  })

  it('rejects mode and architecture mismatches', () => {
    const { manifestBytes } = writeFixtureBundle()
    const modeManifest = JSON.parse(
      manifestBytes.toString('utf8')
    ) as Manifest
    const launcherEntry = modeManifest.files.find(
      (file) => file.path === 'goodbuddy-agent'
    )
    expect(launcherEntry).toBeDefined()
    if (launcherEntry) {
      launcherEntry.mode = '0644'
    }
    const modeManifestBytes =
      agentBundle.canonicalManifestBytes(modeManifest)
    writeFileSync(
      join(directory, 'manifest.json'),
      modeManifestBytes
    )
    writeFileSync(
      join(directory, 'manifest.sig'),
      `${agentBundle
        .signManifestForTest(modeManifestBytes, privateKey)
        .toString('base64')}\n`
    )
    expect(() =>
      agentBundle.verifyBundleDirectory(directory, {
        registry,
        verificationEnvironment: 'test'
      })
    ).toThrow('mode mismatch')

    writeFileSync(join(directory, 'node'), elf('arm64'))
    const manifest = JSON.parse(
      manifestBytes.toString('utf8')
    ) as Manifest
    const nodeEntry = manifest.files.find(
      (file) => file.path === 'node'
    )
    expect(nodeEntry).toBeDefined()
    if (nodeEntry) {
      nodeEntry.size = 64
      nodeEntry.sha256 = createHash('sha256')
        .update(elf('arm64'))
        .digest('hex')
    }
    const updatedBytes =
      agentBundle.canonicalManifestBytes(manifest)
    writeFileSync(join(directory, 'manifest.json'), updatedBytes)
    writeFileSync(
      join(directory, 'manifest.sig'),
      `${agentBundle
        .signManifestForTest(updatedBytes, privateKey)
        .toString('base64')}\n`
    )
    expect(() =>
      agentBundle.verifyBundleDirectory(directory, {
        registry,
        verificationEnvironment: 'test'
      })
    ).toThrow(/hash mismatch|architecture mismatch/u)
  })

  it('rejects test keys in production verification', () => {
    const { manifestBytes } = writeFixtureBundle()
    const signature = Buffer.from(
      readFileSync(join(directory, 'manifest.sig'), 'utf8').trim(),
      'base64'
    )
    expect(() =>
      agentBundle.verifyManifestSignature(
        manifestBytes,
        signature,
        registry
      )
    ).toThrow('rejects non-production key')
  })

  it('rejects revoked keys', () => {
    const { manifestBytes } = writeFixtureBundle()
    const signature = Buffer.from(
      readFileSync(join(directory, 'manifest.sig'), 'utf8').trim(),
      'base64'
    )
    registry.revocations.push({
      keyId: 'fixture-test-key'
    })
    expect(() =>
      agentBundle.verifyManifestSignature(
        manifestBytes,
        signature,
        registry,
        { verificationEnvironment: 'test' }
      )
    ).toThrow('is revoked')
  })
})

describe('Agent production input handling', () => {
  it('fails closed when the locked official Node runtime input is absent', () => {
    expect(() =>
      agentBundle.lockedRuntimeInput(
        {
          node: {
            version: '24.19.0',
            targets: {
              'linux-x64': {
                archive: 'node-v24.19.0-linux-x64.tar.gz',
                sha256: 'a'.repeat(64),
                binaryPath: 'node/bin/node',
                licensePath: 'node/LICENSE'
              }
            }
          }
        },
        'x64',
        join(directory, 'missing.tar.gz')
      )
    ).toThrow('Verified official Node 24.19.0 runtime input is required')
  })

  it('requires CI-only production key variables and redacts them', () => {
    expect(() =>
      agentBundle.productionSigningKey({})
    ).toThrow('required for production GoodBuddy signing')

    const secret = [
      '-----BEGIN PRIVATE KEY-----',
      'fixture-secret-material',
      '-----END PRIVATE KEY-----'
    ].join('\n')
    const error = `signing_key=${secret} key id prod-secret-id`
    const redacted = agentBundle.redactSecrets(error, {
      GOODBUDDY_SIGNING_PRIVATE_KEY: secret,
      GOODBUDDY_SIGNING_KEY_ID: 'prod-secret-id'
    })
    expect(redacted).not.toContain('fixture-secret-material')
    expect(redacted).not.toContain('prod-secret-id')
    expect(redacted).toContain('[redacted]')
  })

  it('fails closed when the production public key ID is not registered', () => {
    expect(() =>
      agentBundle.preflightProductionSigningKey({
        keyId: 'production-release-key',
        registry
      })
    ).toThrow(
      'Production GoodBuddy public signing key ID "production-release-key" is absent from resources/agent-release-keys.json'
    )
  })

  it('accepts only an enabled production registry entry', () => {
    const productionRegistry: KeyRegistry = {
      ...registry,
      keys: [
        {
          ...registry.keys[0]!,
          keyId: 'production-release-key',
          environment: 'production'
        }
      ]
    }
    expect(
      agentBundle.preflightProductionSigningKey({
        keyId: 'production-release-key',
        registry: productionRegistry
      }).keyId
    ).toBe('production-release-key')
  })

  it('detects both ELF byte orders through the shared helper', () => {
    const littleEndian = elf('arm64')
    const bigEndian = elf('x64')
    bigEndian[5] = 2
    bigEndian.writeUInt16BE(62, 18)

    expect(
      agentBundle.detectElfArchitecture(littleEndian)
    ).toBe('arm64')
    expect(
      agentBundle.detectElfArchitecture(bigEndian)
    ).toBe('x64')
  })
})
