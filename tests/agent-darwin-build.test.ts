import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { c as createTar } from 'tar'
import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { createOpenCodeConfigFixture } from './support/opencode-config-fixture'

const require = createRequire(import.meta.url)
const ci = require('../build/agent-ci-bundle.cjs') as {
  readCiLocks(platform?: string, arch?: string): {
    lock: { agentVersion: string; node: { targets: Record<string, unknown> }; protocol: object }
    runtimeLock: { runtimes: { opencode: { version: string; targets: Record<string, { package: string; integrity: string }> } } }
  }
}
const agent = require('../build/agent-bundle.cjs') as {
  koffiPayloadPaths(arch: string, platform: string): { required: string[]; native: string[] }
  createManifest(directory: string, metadata: object): object
  canonicalManifestBytes(manifest: object): Buffer
  signaturePayload(bytes: Buffer): Buffer
}
const runtime = require('../build/remote-runtime-bundle.cjs') as {
  buildRuntimeBundle(options: object): { bundleDirectory: string; manifest: { platform: string } }
}
const packager = require('../build/agent-package.cjs') as {
  assembleAgentPackage(options: object): { sha256: string; descriptor: { platform: string } }
}
const target = require('../build/agent-build-target.cjs') as {
  assertTargetBinary(path: string, arch: string, platform: string, label: string): void
}
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'goodbuddy-darwin-build-test-'))
  roots.push(root)
  return root
}

function machO(): Buffer {
  const bytes = Buffer.alloc(64)
  bytes.writeUInt32LE(0xfeedfacf)
  bytes.writeUInt32LE(0x0100000c, 4)
  return bytes
}

function write(root: string, path: string, contents: string | Buffer, mode = 0o644): void {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents)
  chmodSync(file, mode)
}

describe('Darwin arm64 Agent packages', () => {
  it('uses the same pinned native inputs for CI and production packaging', () => {
    const linux = ci.readCiLocks()
    const darwin = ci.readCiLocks('darwin', 'arm64')
    expect(linux).toEqual(darwin)
    expect(darwin.lock.node.targets['darwin-arm64']).toMatchObject({
      archive: 'node-v24.19.0-darwin-arm64.tar.gz',
      sha256: '8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d'
    })
    expect(darwin.runtimeLock.runtimes.opencode.targets['darwin-arm64']?.package)
      .toBe('opencode-darwin-arm64')
    expect(ci.readCiLocks().lock).toEqual(linux.lock)
  })

  it('rejects a Linux ELF binary even when its architecture is arm64', () => {
    const root = scratch()
    write(root, 'native', machO())
    expect(() => target.assertTargetBinary(join(root, 'native'), 'arm64', 'darwin', 'test')).not.toThrow()
    expect(() => target.assertTargetBinary(join(root, 'native'), 'arm64', 'linux', 'test')).toThrow()
    const elf = Buffer.alloc(64)
    elf.set([0x7f, 0x45, 0x4c, 0x46])
    elf[5] = 1
    elf.writeUInt16LE(183, 18)
    write(root, 'native', elf)
    expect(() => target.assertTargetBinary(join(root, 'native'), 'arm64', 'darwin', 'test')).toThrow()
  })

  it('assembles deterministic Darwin packages and rejects cross-platform bundle selection', () => {
    const root = scratch()
    createOpenCodeConfigFixture(root)
    const bundle = join(root, 'agent')
    const { lock, runtimeLock } = ci.readCiLocks('darwin', 'arm64')
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const identity = { keyId: 'darwin-build-test', privateKey }
    const registry = {
      formatVersion: 1,
      keys: [{
        keyId: identity.keyId,
        publicKeySpkiBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        environment: 'test'
      }],
      revocations: []
    }
    write(bundle, 'node', machO(), 0o755)
    write(bundle, 'goodbuddy-agent', '#!/bin/sh\n', 0o755)
    write(bundle, 'lib/agent.cjs', '// fixture\n')
    const koffi = agent.koffiPayloadPaths('arm64', 'darwin')
    expect(koffi.native).toEqual([
      'lib/node_modules/@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node'
    ])
    for (const path of koffi.required) {
      write(bundle, path, koffi.native.includes(path) ? machO() : '{}')
    }
    for (const license of ['GoodBuddy-0BSD', 'Node.js-MIT', 'zod-MIT', 'koffi-MIT', 'koffi-native-MIT']) {
      write(bundle, `licenses/${license}.txt`, 'fixture license')
    }
    const manifest = agent.createManifest(bundle, {
      platform: 'darwin', arch: 'arm64', agentVersion: lock.agentVersion,
      nodeVersion: '24.19.0', zodVersion: '4.4.3', koffiVersion: '3.1.4',
      koffiNativePackage: '@koromix/koffi-darwin-arm64',
      protocol: lock.protocol, signingKeyId: identity.keyId
    })
    const bytes = agent.canonicalManifestBytes(manifest)
    write(bundle, 'manifest.json', bytes)
    write(bundle, 'manifest.sig', `${sign(null, agent.signaturePayload(bytes), privateKey).toString('base64')}\n`)
    const source = join(root, 'source')
    write(source, 'package/package.json', JSON.stringify({
      name: 'opencode-darwin-arm64', version: runtimeLock.runtimes.opencode.version
    }))
    write(source, 'package/bin/opencode', machO(), 0o755)
    const archive = join(root, `opencode-darwin-arm64-${runtimeLock.runtimes.opencode.version}.tgz`)
    createTar({ cwd: source, file: archive, sync: true, gzip: true }, ['package'])
    runtimeLock.runtimes.opencode.targets['darwin-arm64']!.integrity =
      `sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`
    const built = runtime.buildRuntimeBundle({
      projectRoot: root,
      platform: 'darwin', architecture: 'arm64', runtimeArchive: archive,
      outputRoot: join(root, 'runtime'), lock: runtimeLock, registry,
      testSigningIdentity: identity
    })
    expect(built.manifest.platform).toBe('darwin')
    const output = join(root, `goodbuddy-agent-${lock.agentVersion}-darwin-arm64.gbagent`)
    const options = {
      platform: 'darwin', architecture: 'arm64', minimumDesktopVersion: '0.12.4',
      agentBundle: bundle, runtimeBundle: built.bundleDirectory,
      agentLock: lock, runtimeLock, registry, testSigningIdentity: identity, output
    }
    const first = packager.assembleAgentPackage(options)
    const second = packager.assembleAgentPackage(options)
    expect(first.sha256).toBe(second.sha256)
    expect(first.descriptor.platform).toBe('darwin')
    const files = unzipSync(readFileSync(output))
    expect(JSON.parse(Buffer.from(files['agent-package.json']!).toString()).platform).toBe('darwin')
    expect(() => packager.assembleAgentPackage({ ...options, platform: 'linux' }))
      .toThrow('platform')
  })
})
