import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject
} from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AgentBundleManifest,
  type AgentReleaseKeyRegistry
} from '../shared/agent-installation-contracts'
import {
  canonicalInstalledAgentManifestBytes,
  installedAgentManifestSignaturePayload,
  loadRegisteredAgentBundle,
  verifyInstalledAgentBundle
} from './installed-bundle-verifier'

let root: string
let installationDirectory: string
let privateKey: KeyObject
let releaseKeyRegistry: AgentReleaseKeyRegistry

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goodbuddy-installed-agent-'))
  installationDirectory = join(root, 'install-10')
  mkdirSync(installationDirectory, { mode: 0o700 })
  const generated = generateKeyPairSync('ed25519')
  privateKey = generated.privateKey
  releaseKeyRegistry = {
    formatVersion: 1,
    keys: [
      {
        keyId: 'installed-test-key',
        publicKeySpkiBase64: generated.publicKey
          .export({ format: 'der', type: 'spki' })
          .toString('base64'),
        environment: 'test'
      }
    ],
    revocations: []
  }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('installed Agent bundle verifier', () => {
  it('binds the installation identity to a signed complete payload', async () => {
    writeBundle()

    await expect(verifyBundle()).resolves.toMatchObject({
      installationId: 'install-10',
      binaryDigest: `sha256:${createHash('sha256')
        .update(readFileSync(join(installationDirectory, 'manifest.json')))
        .digest('hex')}`,
      manifest: {
        agentVersion: '0.11.0',
        protocol: { major: 1, minor: 0 }
      }
    })
    await expect(
      verifyInstalledAgentBundle(installationDirectory, {
        installationId: 'different-id',
        architecture: 'x64',
        releaseKeyRegistry,
        verificationEnvironment: 'test'
      })
    ).rejects.toThrow('does not match')
  })

  it('rejects tampering, undeclared files, and symlinks', async () => {
    writeBundle()
    writeFileSync(
      join(installationDirectory, 'lib', 'agent.cjs'),
      'tampered'
    )
    await expect(verifyBundle()).rejects.toThrow(
      /size mismatch|hash mismatch/u
    )

    resetInstallation()
    writeBundle()
    writeFileSync(join(installationDirectory, 'undeclared'), 'no')
    await expect(verifyBundle()).rejects.toThrow('undeclared')

    if (process.platform !== 'win32') {
      resetInstallation()
      writeBundle()
      rmSync(join(installationDirectory, 'lib', 'agent.cjs'))
      symlinkSync(
        join(installationDirectory, 'goodbuddy-agent'),
        join(installationDirectory, 'lib', 'agent.cjs')
      )
      await expect(verifyBundle()).rejects.toThrow(/regular file|symlink/u)
    }
  })

  it('rejects mode, architecture, and signature violations', async () => {
    if (process.platform !== 'win32') {
      writeBundle()
      chmodSync(join(installationDirectory, 'goodbuddy-agent'), 0o777)
      await expect(verifyBundle()).rejects.toThrow('mode mismatch')
      resetInstallation()
    }

    writeBundle('arm64')
    await expect(verifyBundle()).rejects.toThrow(
      'current host'
    )

    resetInstallation()
    writeBundle()
    writeFileSync(
      join(installationDirectory, 'manifest.sig'),
      `${Buffer.alloc(64).toString('base64')}\n`,
      { mode: 0o644 }
    )
    await expect(verifyBundle()).rejects.toThrow(
      'signature verification failed'
    )

  })

  it('loads Host-managed registry evidence without repeating signature or payload verification', async () => {
    writeBundle()
    const manifestBytes = readFileSync(
      join(installationDirectory, 'manifest.json')
    )
    const manifestSha256 = createHash('sha256')
      .update(manifestBytes)
      .digest('hex')
    writeFileSync(
      join(installationDirectory, 'manifest.sig'),
      'not-used-during-attach\n',
      { mode: 0o644 }
    )

    await expect(
      loadRegisteredAgentBundle(installationDirectory, {
        installationId: 'install-10',
        architecture: 'x64',
        registered: {
          installationId: 'install-10',
          agentVersion: '0.11.0',
          manifestSha256,
          arch: 'x64'
        },
        enforceFilesystemMode: process.platform !== 'win32'
      })
    ).resolves.toMatchObject({
      installationId: 'install-10',
      manifestSha256,
      binaryDigest: `sha256:${manifestSha256}`,
      manifest: {
        agentVersion: '0.11.0',
        protocol: { major: 1, minor: 0 }
      }
    })

    writeFileSync(
      join(installationDirectory, 'manifest.json'),
      Buffer.concat([manifestBytes, Buffer.from(' ')])
    )
    await expect(
      loadRegisteredAgentBundle(installationDirectory, {
        installationId: 'install-10',
        architecture: 'x64',
        registered: {
          installationId: 'install-10',
          agentVersion: '0.11.0',
          manifestSha256,
          arch: 'x64'
        }
      })
    ).rejects.toThrow('Host-managed registry')
  })
})

function resetInstallation(): void {
  rmSync(installationDirectory, { recursive: true, force: true })
  mkdirSync(installationDirectory, { mode: 0o700 })
}

function writeBundle(arch: 'x64' | 'arm64' = 'x64'): void {
  for (const directory of ['lib', 'licenses']) {
    mkdirSync(join(installationDirectory, directory), { mode: 0o700 })
  }
  const contents = new Map<string, Buffer>([
    ['node', elf(arch)],
    ['goodbuddy-agent', Buffer.from('#!/bin/sh\n')],
    ['lib/agent.cjs', Buffer.from('module.exports = {}\n')],
    ['licenses/GoodBuddy-0BSD.txt', Buffer.from('0BSD')]
  ])
  for (const [path, bytes] of contents) {
    writeFileSync(
      join(installationDirectory, ...path.split('/')),
      bytes,
      { mode: path === 'node' || path === 'goodbuddy-agent' ? 0o755 : 0o644 }
    )
  }
  const manifest: AgentBundleManifest = {
    formatVersion: 1,
    product: 'GoodBuddy',
    agentVersion: '0.11.0',
    platform: 'linux',
    arch,
    protocol: { major: 1, minor: 0 },
    signingKeyId: 'installed-test-key',
    entrypoint: {
      path: 'goodbuddy-agent',
      runtimePath: 'node',
      scriptPath: 'lib/agent.cjs'
    },
    files: [...contents].map(([path, bytes]) => ({
      path,
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mode:
        path === 'node' || path === 'goodbuddy-agent'
          ? '0755'
          : '0644'
    })),
    licenses: [
      {
        package: 'GoodBuddy',
        version: '0.11.0',
        spdx: '0BSD',
        path: 'licenses/GoodBuddy-0BSD.txt'
      }
    ]
  }
  const bytes = canonicalInstalledAgentManifestBytes(manifest)
  writeFileSync(
    join(installationDirectory, 'manifest.json'),
    bytes,
    { mode: 0o644 }
  )
  writeFileSync(
    join(installationDirectory, 'manifest.sig'),
    `${sign(
      null,
      installedAgentManifestSignaturePayload(bytes),
      privateKey
    ).toString('base64')}\n`,
    { mode: 0o644 }
  )
}

function verifyBundle() {
  return verifyInstalledAgentBundle(installationDirectory, {
    installationId: 'install-10',
    architecture: 'x64',
    releaseKeyRegistry,
    verificationEnvironment: 'test',
    enforceFilesystemMode: process.platform !== 'win32'
  })
}

function elf(architecture: 'x64' | 'arm64'): Buffer {
  const header = Buffer.alloc(64)
  header.set([0x7f, 0x45, 0x4c, 0x46])
  header[5] = 1
  header.writeUInt16LE(architecture === 'x64' ? 62 : 183, 18)
  return header
}
