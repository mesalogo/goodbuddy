import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject
} from 'node:crypto'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it
} from 'vitest'
import type {
  AgentBundleManifest,
  AgentReleaseKeyRegistry,
  AgentRuntimeLock
} from '../../shared/agent-installation-contracts'
import {
  agentManifestSignaturePayload,
  canonicalAgentManifestBytes,
  canonicalAgentReleaseKeyRegistryBytes,
  parseAgentReleaseKeyRegistryBytes,
  verifyAgentBundleDirectory,
  verifyAgentManifestSignature,
  type VerifiedAgentBundle
} from './agent-bundle-verifier'

type BuildAgentBundleModule = {
  canonicalManifestBytes(
    manifest: AgentBundleManifest
  ): Buffer
  createManifest(
    directory: string,
    metadata: {
      agentVersion: string
      nodeVersion: string
      zodVersion: string
      koffiVersion: string
      koffiNativePackage: string
      arch: 'x64' | 'arm64'
      protocol: { major: number; minor: number }
      signingKeyId: string
    }
  ): AgentBundleManifest
  signaturePayload(manifestBytes: Buffer): Buffer
}

const require = createRequire(import.meta.url)
const buildAgentBundle = require(
  '../../../build/agent-bundle.cjs'
) as BuildAgentBundleModule

let directory: string
let privateKey: KeyObject
let registry: AgentReleaseKeyRegistry
let runtimeLock: AgentRuntimeLock

function elf(architecture: 'x64' | 'arm64'): Buffer {
  const contents = Buffer.alloc(64)
  contents.set([0x7f, 0x45, 0x4c, 0x46])
  contents[5] = 1
  contents.writeUInt16LE(architecture === 'x64' ? 62 : 183, 18)
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

function writeBundle(
  signingKeyId = 'generated-test-key'
): AgentBundleManifest {
  mkdirSync(join(directory, 'lib'), { recursive: true })
  mkdirSync(join(directory, 'licenses'), { recursive: true })
  writeFileSync(join(directory, 'node'), elf('x64'))
  writeFileSync(join(directory, 'goodbuddy-agent'), '#!/bin/sh\n')
  writeFileSync(
    join(directory, 'lib', 'agent.cjs'),
    'module.exports = {}\n'
  )
  writeFileSync(
    join(directory, 'licenses', 'GoodBuddy-0BSD.txt'),
    '0BSD'
  )
  writeFileSync(
    join(directory, 'licenses', 'Node.js-MIT.txt'),
    'MIT'
  )
  writeFileSync(
    join(directory, 'licenses', 'zod-MIT.txt'),
    'MIT'
  )
  writeFileSync(
    join(directory, 'licenses', 'koffi-MIT.txt'),
    'MIT'
  )
  writeFileSync(
    join(directory, 'licenses', 'koffi-native-MIT.txt'),
    'MIT'
  )
  writeKoffiPayload(directory, 'x64')
  for (const filePath of ['node', 'goodbuddy-agent']) {
    chmodSync(join(directory, filePath), 0o755)
  }
  for (const filePath of [
    'lib/agent.cjs',
    'licenses/GoodBuddy-0BSD.txt',
    'licenses/Node.js-MIT.txt',
    'licenses/zod-MIT.txt',
    'licenses/koffi-MIT.txt',
    'licenses/koffi-native-MIT.txt'
  ]) {
    chmodSync(join(directory, ...filePath.split('/')), 0o644)
  }

  const manifest = buildAgentBundle.createManifest(directory, {
    agentVersion: '0.11.0',
    nodeVersion: '24.19.0',
    zodVersion: '4.4.3',
    koffiVersion: '3.1.4',
    koffiNativePackage: '@koromix/koffi-linux-x64',
    arch: 'x64',
    protocol: { major: 1, minor: 0 },
    signingKeyId
  })
  const manifestBytes =
    buildAgentBundle.canonicalManifestBytes(manifest)
  writeFileSync(join(directory, 'manifest.json'), manifestBytes)
  writeFileSync(
    join(directory, 'manifest.sig'),
    `${sign(
      null,
      buildAgentBundle.signaturePayload(manifestBytes),
      privateKey
    ).toString('base64')}\n`
  )
  chmodSync(join(directory, 'manifest.json'), 0o644)
  chmodSync(join(directory, 'manifest.sig'), 0o644)
  return manifest
}

async function verifyBundle(): Promise<VerifiedAgentBundle> {
  return verifyAgentBundleDirectory(directory, {
    architecture: 'x64',
    registry,
    runtimeLock,
    verificationEnvironment: 'test',
    enforceFilesystemMode: process.platform !== 'win32'
  })
}

beforeEach(() => {
  directory = mkdtempSync(
    join(tmpdir(), 'goodbuddy-runtime-agent-bundle-')
  )
  const generated = generateKeyPairSync('ed25519')
  privateKey = generated.privateKey
  registry = {
    formatVersion: 1,
    keys: [
      {
        keyId: 'generated-test-key',
        publicKeySpkiBase64: generated.publicKey
          .export({ format: 'der', type: 'spki' })
          .toString('base64'),
        environment: 'test'
      }
    ],
    revocations: []
  }
  const target = {
    archive: 'node-v24.19.0-linux.tar.gz',
    sha256: 'a'.repeat(64),
    binaryPath: 'node/bin/node',
    licensePath: 'node/LICENSE'
  }
  runtimeLock = {
    formatVersion: 1,
    agentVersion: '0.11.0',
    protocol: { major: 1, minor: 0 },
    node: {
      version: '24.19.0',
      source: 'https://nodejs.org/dist/v24.19.0/',
      targets: {
        'linux-x64': target,
        'linux-arm64': target
      }
    },
    koffi: { version: '3.1.4' }
  }
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('runtime and build-time Agent verifier parity', () => {
  it('accepts equivalent registry whitespace and canonicalizes validated keys', () => {
    const canonical = canonicalAgentReleaseKeyRegistryBytes(registry)
    const crlf = Buffer.from(
      canonical.toString('utf8').replace(/\n/gu, '\r\n'),
      'utf8'
    )

    const parsed = parseAgentReleaseKeyRegistryBytes(crlf)

    expect(parsed).toEqual(registry)
    expect(canonicalAgentReleaseKeyRegistryBytes(parsed)).toEqual(
      canonical
    )
  })

  it('rejects malformed or non-Ed25519 registry keys', () => {
    expect(() =>
      parseAgentReleaseKeyRegistryBytes(
        Buffer.from(JSON.stringify({
          ...registry,
          keys: [{
            ...registry.keys[0],
            publicKeySpkiBase64: 'AAAA'
          }]
        }))
      )
    ).toThrow('contract is invalid')
  })

  it('uses the exact build-time canonical bytes and signature domain', async () => {
    const manifest = writeBundle()
    const manifestBytes = readFileSync(
      join(directory, 'manifest.json')
    )

    expect(canonicalAgentManifestBytes(manifest)).toEqual(
      buildAgentBundle.canonicalManifestBytes(manifest)
    )
    expect(agentManifestSignaturePayload(manifestBytes)).toEqual(
      buildAgentBundle.signaturePayload(manifestBytes)
    )
    await expect(verifyBundle()).resolves.toMatchObject({
      manifest: {
        arch: 'x64',
        protocol: { major: 1, minor: 0 }
      }
    })
  })

  it('rejects corrupt, undeclared, missing, and architecture-mismatched payloads', async () => {
    writeBundle()
    writeFileSync(join(directory, 'lib', 'agent.cjs'), 'corrupt')
    await expect(verifyBundle()).rejects.toThrow(
      /size mismatch|hash mismatch/u
    )

    rmSync(directory, { recursive: true, force: true })
    directory = mkdtempSync(
      join(tmpdir(), 'goodbuddy-runtime-agent-bundle-')
    )
    writeBundle()
    writeFileSync(join(directory, 'undeclared.txt'), 'no')
    await expect(verifyBundle()).rejects.toThrow(
      'undeclared or missing files'
    )

    rmSync(join(directory, 'licenses', 'zod-MIT.txt'))
    await expect(verifyBundle()).rejects.toThrow()

    rmSync(directory, { recursive: true, force: true })
    directory = mkdtempSync(
      join(tmpdir(), 'goodbuddy-runtime-agent-bundle-')
    )
    writeBundle()
    writeFileSync(join(directory, 'node'), elf('arm64'))
    const manifest = JSON.parse(
      readFileSync(join(directory, 'manifest.json'), 'utf8')
    ) as AgentBundleManifest
    const nodeFile = manifest.files.find((file) => file.path === 'node')
    if (!nodeFile) {
      throw new Error('Fixture Node entry is missing')
    }
    nodeFile.sha256 = createHash('sha256')
      .update(elf('arm64'))
      .digest('hex')
    const bytes = canonicalAgentManifestBytes(manifest)
    writeFileSync(join(directory, 'manifest.json'), bytes)
    writeFileSync(
      join(directory, 'manifest.sig'),
      `${sign(
        null,
        agentManifestSignaturePayload(bytes),
        privateKey
      ).toString('base64')}\n`
    )
    await expect(verifyBundle()).rejects.toThrow(
      'architecture mismatch'
    )
  })

  it('refuses symlink payloads', async () => {
    writeBundle()
    const targetDirectory = join(directory, '.lib-target')
    renameSync(
      join(directory, 'lib'),
      targetDirectory
    )
    symlinkSync(
      targetDirectory,
      join(directory, 'lib'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    await expect(verifyBundle()).rejects.toThrow(
      /symlink|regular file/u
    )
  })

  it('rejects non-canonical manifests and signature corruption', () => {
    const manifest = writeBundle()
    const canonical = canonicalAgentManifestBytes(manifest)
    const nonCanonical = Buffer.from(JSON.stringify(manifest), 'utf8')
    const nonCanonicalSignature = sign(
      null,
      agentManifestSignaturePayload(nonCanonical),
      privateKey
    )
    expect(() =>
      verifyAgentManifestSignature(
        nonCanonical,
        nonCanonicalSignature,
        registry,
        'test'
      )
    ).toThrow('not in canonical deterministic form')

    const signature = sign(
      null,
      agentManifestSignaturePayload(canonical),
      privateKey
    )
    signature[0] = (signature[0] ?? 0) ^ 1
    expect(() =>
      verifyAgentManifestSignature(
        canonical,
        signature,
        registry,
        'test'
      )
    ).toThrow('signature verification failed')
  })

  it('enforces key revocation and production keys', () => {
    const manifest = writeBundle()
    const manifestBytes = canonicalAgentManifestBytes(manifest)
    const signature = sign(
      null,
      agentManifestSignaturePayload(manifestBytes),
      privateKey
    )

    expect(() =>
      verifyAgentManifestSignature(
        manifestBytes,
        signature,
        { ...registry, keys: [] }
      )
    ).toThrow('production key registry is empty')
    expect(() =>
      verifyAgentManifestSignature(
        manifestBytes,
        signature,
        {
          ...registry,
          revocations: [
            {
              keyId: 'generated-test-key'
            }
          ]
        },
        'test'
      )
    ).toThrow('is revoked')

  })
})
