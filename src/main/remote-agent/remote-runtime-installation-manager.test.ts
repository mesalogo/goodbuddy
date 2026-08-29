import {
  createHash,
  generateKeyPairSync,
  sign
} from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentReleaseKeyRegistry
} from '../../shared/agent-installation-contracts'
import {
  digestRemoteRuntimeBundleIdentity,
  digestRemoteRuntimeBundleManifest,
  type RemoteRuntimeBundleManifest,
  type RemoteRuntimeLock
} from '../../shared/remote-runtime-launch-contracts'
import {
  runtimeManifestSignaturePayload
} from '../../shared/node/runtime-bundle-verifier'
import type {
  SftpEntryMetadata,
  StagedSftp
} from '../ssh/bounded-sftp'
import type {
  SshConnectionLease,
  SshConnectionPoolTarget
} from '../ssh/ssh-connection-pool'
import { verifyAgentInstallationId } from '../ssh/ssh-agent-command'
import {
  RemoteRuntimeInstallationManager,
  type RemoteRuntimeActivator
} from './remote-runtime-installation-manager'
import type { VerifiedRemoteRuntimeResourceBundle } from './remote-runtime-resource-loader'

type RemoteEntry = {
  type: 'file' | 'directory' | 'symbolic-link'
  mode: number
  uid: number
  contents?: Buffer
}

const home = '/home/tester'
const uid = 1000

function sha256(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}

function missing(): Error & { code: number } {
  return Object.assign(new Error('missing'), { code: 2 })
}

class MemorySftp implements StagedSftp {
  readonly stagingDirectory = home
  readonly operations: string[] = []
  readonly entries = new Map<string, RemoteEntry>([
    [home, { type: 'directory', mode: 0o700, uid }]
  ])
  mutateRead?: (path: string, contents: Buffer) => Buffer
  closed = false

  private absolute(path: string): string {
    return `${home}/${path}`
  }

  private metadata(entry: RemoteEntry): SftpEntryMetadata {
    return {
      type: entry.type,
      size: entry.contents?.byteLength ?? 0,
      mode: entry.mode,
      uid: entry.uid,
      gid: entry.uid,
      atime: 1,
      mtime: 1
    }
  }

  async uploadFile(): Promise<void> {
    throw new Error('uploadFile is unused in this fixture')
  }

  async mkdir(path: string): Promise<void> {
    this.operations.push(`mkdir:${path}`)
    const absolute = this.absolute(path)
    if (this.entries.has(absolute)) {
      throw new Error('exists')
    }
    this.entries.set(absolute, {
      type: 'directory',
      mode: 0o700,
      uid
    })
  }

  async writeFile(path: string, contents: Buffer): Promise<void> {
    this.operations.push(`write:${path}`)
    const absolute = this.absolute(path)
    if (this.entries.has(absolute)) {
      throw new Error('exists')
    }
    this.entries.set(absolute, {
      type: 'file',
      mode: 0o600,
      uid,
      contents: Buffer.from(contents)
    })
  }

  async readFile(path: string): Promise<Buffer> {
    this.operations.push(`read:${path}`)
    const contents = Buffer.from(
      this.entry(path).contents ?? Buffer.alloc(0)
    )
    return this.mutateRead?.(path, contents) ?? contents
  }

  async lstat(path: string): Promise<SftpEntryMetadata> {
    return this.metadata(this.entry(path))
  }

  async stat(path: string): Promise<SftpEntryMetadata> {
    const entry = this.entry(path)
    if (entry.type === 'symbolic-link') {
      throw new Error('symbolic link')
    }
    return this.metadata(entry)
  }

  async chmod(
    path: string,
    mode: 0o600 | 0o644 | 0o700 | 0o755
  ): Promise<void> {
    this.operations.push(`chmod:${path}:${mode.toString(8)}`)
    this.entry(path).mode = mode
  }

  async setExecutable(path: string): Promise<void> {
    await this.chmod(path, 0o700)
  }

  async rename(source: string, destination: string): Promise<void> {
    this.operations.push(`rename:${source}:${destination}`)
    if (this.entries.has(this.absolute(destination))) {
      throw new Error('destination exists')
    }
    this.moveTree(source, destination)
  }

  async replaceFile(
    source: string,
    destination: string
  ): Promise<void> {
    this.operations.push(`replace:${source}:${destination}`)
    const sourceEntry = this.entry(source)
    const destinationEntry = this.entries.get(
      this.absolute(destination)
    )
    if (
      sourceEntry.type !== 'file' ||
      (destinationEntry && destinationEntry.type !== 'file')
    ) {
      throw new Error('unsafe replacement')
    }
    this.entries.delete(this.absolute(source))
    this.entries.delete(this.absolute(destination))
    this.entries.set(this.absolute(destination), sourceEntry)
  }

  async unlink(path: string): Promise<void> {
    this.operations.push(`unlink:${path}`)
    if (this.entry(path).type !== 'file') {
      throw new Error('not a file')
    }
    this.entries.delete(this.absolute(path))
  }

  async rmdir(path: string): Promise<void> {
    this.operations.push(`rmdir:${path}`)
    const absolute = this.absolute(path)
    if (this.entry(path).type !== 'directory') {
      throw new Error('not a directory')
    }
    if (
      [...this.entries.keys()].some(
        (candidate) => candidate.startsWith(`${absolute}/`)
      )
    ) {
      throw new Error('not empty')
    }
    this.entries.delete(absolute)
  }

  close(): void {
    this.closed = true
  }

  add(path: string, entry: RemoteEntry): void {
    this.entries.set(this.absolute(path), entry)
  }

  private entry(path: string): RemoteEntry {
    const entry = this.entries.get(this.absolute(path))
    if (!entry) {
      throw missing()
    }
    return entry
  }

  private moveTree(source: string, destination: string): void {
    const sourceAbsolute = this.absolute(source)
    const destinationAbsolute = this.absolute(destination)
    const matches = [...this.entries.entries()].filter(
      ([path]) =>
        path === sourceAbsolute ||
        path.startsWith(`${sourceAbsolute}/`)
    )
    if (matches.length === 0) {
      throw missing()
    }
    for (const [path] of matches) {
      this.entries.delete(path)
    }
    for (const [path, entry] of matches) {
      this.entries.set(
        `${destinationAbsolute}${path.slice(sourceAbsolute.length)}`,
        entry
      )
    }
  }
}

const registry: AgentReleaseKeyRegistry = {
  formatVersion: 1,
  keys: [{
    keyId: 'test-key',
    publicKeySpkiBase64: Buffer.from(
      '302a300506032b6570032100000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
      'hex'
    ).toString('base64'),
    environment: 'test'
  }],
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

function target(
  revision = 1,
  hostId = 'host-1'
): SshConnectionPoolTarget {
  return {
    host: {
      id: hostId,
      name: 'Host',
      hostname: 'host.example',
      port: 22,
      username: 'tester',
      authentication: 'password',
      password: 'not-logged',
      hostKey: {
        algorithm: 'ssh-ed25519',
        publicKeyBase64: 'AAAA',
        fingerprintSha256: `SHA256:${'a'.repeat(43)}`,
        generation: revision
      }
    },
    hostRevision: revision,
    hostKeyGeneration: revision
  }
}

async function bundleFixture(): Promise<
  VerifiedRemoteRuntimeResourceBundle
> {
  const directory = await mkdtemp(
    join(tmpdir(), 'runtime-manager-')
  )
  const files = [
    {
      path: 'bin/opencode',
      contents: Buffer.from('opencode'),
      mode: '0755' as const
    },
    {
      path: 'licenses/LICENSE',
      contents: Buffer.from('license'),
      mode: '0644' as const
    }
  ]
  const initial: RemoteRuntimeBundleManifest = {
    formatVersion: 2,
    product: 'GoodBuddy',
    runtimeId: 'opencode',
    runtimeVersion: '1.18.9',
    provider: 'opencode',
    platform: 'linux',
    architecture: 'x64',
    signingKeyId: 'test-key',
    bundleDigest: `sha256:${'0'.repeat(64)}`,
    adapterDigest: `sha256:${'1'.repeat(64)}`,
    sourcePackage: {
      name: 'opencode-linux-x64-baseline',
      integrity: runtimeLock.runtimes.opencode.targets.x64.integrity
    },
    entrypoint: {
      identity: 'opencode-acp',
      path: 'bin/opencode',
      sha256: sha256(files[0]!.contents),
      argvPrefix: ['acp']
    },
    files: files.map((file) => ({
      path: file.path,
      size: file.contents.byteLength,
      sha256: sha256(file.contents),
      mode: file.mode
    })),
    licenses: [{
      package: 'opencode',
      version: '1.18.9',
      spdx: 'MIT',
      path: 'licenses/LICENSE'
    }],
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
      maximumPromptInputBytes: 4096,
      maximumPromptOutputBytes: 1024 * 1024
    }
  }
  const manifest = {
    ...initial,
    bundleDigest: await digestRemoteRuntimeBundleIdentity(initial)
  }
  for (const file of files) {
    const destination = join(
      directory,
      ...file.path.split('/')
    )
    await mkdir(join(destination, '..'), { recursive: true })
    await writeFile(destination, file.contents)
  }
  await writeFile(
    join(directory, 'manifest.json'),
    canonical(manifest)
  )
  await writeFile(
    join(directory, 'manifest.sig'),
    Buffer.alloc(64, 7)
  )
  return {
    bundleDirectory: directory,
    manifest,
    manifestDigest:
      await digestRemoteRuntimeBundleManifest(manifest),
    canonicalReleaseKeyRegistryBytes: canonical(registry),
    canonicalRemoteRuntimeLockBytes: canonical(runtimeLock)
  }
}

async function waitForGate(
  gate: Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  if (!signal) {
    await gate
    return
  }
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      reject(
        signal.reason ??
        new DOMException('The operation was aborted', 'AbortError')
      )
    }
    signal.addEventListener('abort', abort, { once: true })
    gate.then(
      () => {
        signal.removeEventListener('abort', abort)
        resolve()
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}

async function metadataOnlyHarness(options: {
  corruptPath?: string
  remoteReleaseKeyBytes?: Buffer
  remoteRuntimeLockBytes?: Buffer
  remoteReleaseKeysAbsent?: boolean
  remoteRuntimeLockAbsent?: boolean
  resolverTargets?: SshConnectionPoolTarget[]
  runtimeRegistryBytes?: Buffer
  runtimeRegistryAbsent?: boolean
  activationFailure?: boolean
  activationMutatesRegistry?: boolean
  bootstrapGate?: Promise<void>
} = {}) {
  const baseBundle = await bundleFixture()
  const keyPair = generateKeyPairSync('ed25519')
  const signedRegistry: AgentReleaseKeyRegistry = {
    formatVersion: 1,
    keys: [{
      keyId: 'test-key',
      publicKeySpkiBase64: keyPair.publicKey.export({
        format: 'der',
        type: 'spki'
      }).toString('base64'),
      environment: 'production'
    }],
    revocations: []
  }
  const manifestBytes = canonical(baseBundle.manifest)
  const signatureBytes = Buffer.from(
    `${sign(
      null,
      runtimeManifestSignaturePayload(manifestBytes),
      keyPair.privateKey
    ).toString('base64')}\n`
  )
  const releaseKeyRegistryBytes = canonical(signedRegistry)
  const remoteRuntimeLockBytes = canonical(runtimeLock)
  const bundle: VerifiedRemoteRuntimeResourceBundle = {
    bundleDirectory: baseBundle.bundleDirectory,
    manifest: baseBundle.manifest,
    manifestDigest: baseBundle.manifestDigest,
    canonicalReleaseKeyRegistryBytes:
      releaseKeyRegistryBytes,
    canonicalRemoteRuntimeLockBytes:
      remoteRuntimeLockBytes
  }
  const sftp = new MemorySftp()
  const destination =
    `.goodbuddy/runtimes/opencode/${
      bundle.manifest.bundleDigest.slice('sha256:'.length)
    }`
  for (const path of [
    '.goodbuddy',
    '.goodbuddy/runtimes',
    '.goodbuddy/runtimes/opencode',
    destination,
    `${destination}/bin`,
    `${destination}/licenses`
  ]) {
    sftp.add(path, {
      type: 'directory',
      mode: 0o700,
      uid
    })
  }
  const runtimeRegistryBytes = canonical({
    formatVersion: 1,
    current: [{
      runtimeId: 'opencode',
      runtimeVersion: bundle.manifest.runtimeVersion,
      architecture: bundle.manifest.architecture,
      bundleDigest: bundle.manifest.bundleDigest,
      manifestDigest: bundle.manifestDigest,
      acpCapabilitiesDigest:
        bundle.manifest.acpCapabilitiesDigest
    }]
  })
  if (!options.remoteReleaseKeysAbsent) {
    sftp.add('.goodbuddy/runtimes/release-keys.json', {
      type: 'file',
      mode: 0o600,
      uid,
      contents:
        options.remoteReleaseKeyBytes ??
        releaseKeyRegistryBytes
    })
  }
  if (!options.remoteRuntimeLockAbsent) {
    sftp.add('.goodbuddy/runtimes/remote-runtime-lock.json', {
      type: 'file',
      mode: 0o600,
      uid,
      contents:
        options.remoteRuntimeLockBytes ??
        remoteRuntimeLockBytes
    })
  }
  if (!options.runtimeRegistryAbsent) {
    sftp.add('.goodbuddy/runtimes/registry.json', {
      type: 'file',
      mode: 0o600,
      uid,
      contents:
        options.runtimeRegistryBytes ?? runtimeRegistryBytes
    })
  }
  for (const file of bundle.manifest.files) {
    const contents = await readFile(
      join(bundle.bundleDirectory, ...file.path.split('/'))
    )
    sftp.add(`${destination}/${file.path}`, {
      type: 'file',
      mode: file.mode === '0755' ? 0o755 : 0o644,
      uid,
      contents:
        options.corruptPath === file.path
          ? Buffer.alloc(contents.byteLength, 0x78)
          : contents
    })
  }
  sftp.add(`${destination}/manifest.json`, {
    type: 'file',
    mode: 0o644,
    uid,
    contents: manifestBytes
  })
  sftp.add(`${destination}/manifest.sig`, {
    type: 'file',
    mode: 0o644,
    uid,
    contents:
      options.corruptPath === 'manifest.sig'
        ? Buffer.from(`${'A'.repeat(86)}==\n`)
        : signatureBytes
  })

  const release = vi.fn()
  const activate = vi.fn<RemoteRuntimeActivator>(async () => {
    if (options.activationMutatesRegistry) {
      sftp.add('.goodbuddy/runtimes/registry.json', {
        type: 'file',
        mode: 0o600,
        uid,
        contents: Buffer.from('changed registry bytes\n')
      })
    }
    if (
      options.activationFailure ||
      options.corruptPath !== undefined &&
      options.corruptPath !== 'manifest.sig'
    ) {
      throw new Error('Agent Runtime verification failed')
    }
  })
  const lease = {
    identity: {
      hostId: 'host-1',
      hostRevision: 1,
      hostKeyGeneration: 1,
      authenticationIdentity: 'b'.repeat(64)
    },
    isUsable: () => true,
    runAgentBootstrapProbe: vi.fn(async (signal?: AbortSignal) => {
      if (options.bootstrapGate) {
        await waitForGate(options.bootstrapGate, signal)
      }
      return {
      ready: true,
      platform: 'linux',
      architecture: 'x64',
      canonicalHomeDirectory: home,
      uid,
      shell: '/bin/bash',
      procfs: 'ready'
      } as const
    }),
    openStagedSftp: vi.fn(async () => sftp),
    release
  } as unknown as SshConnectionLease
  let resolveCount = 0
  const targets = options.resolverTargets ?? [target()]
  const resolver = {
    resolve: vi.fn(async () =>
      targets[Math.min(resolveCount++, targets.length - 1)]!
    )
  }
  const manager = new RemoteRuntimeInstallationManager({
    resolver,
    sshPool: { acquire: vi.fn(async () => lease) },
    loadVerificationMetadata: async () => ({
      releaseKeyRegistry: signedRegistry,
      runtimeLock,
      canonicalReleaseKeyRegistryBytes:
        releaseKeyRegistryBytes,
      canonicalRemoteRuntimeLockBytes:
        remoteRuntimeLockBytes
    }),
    activate
  })
  return {
    manager,
    bundle,
    publishedIdentity: {
      runtimeId: 'opencode' as const,
      runtimeVersion: bundle.manifest.runtimeVersion,
      bundleDigest: bundle.manifest.bundleDigest,
      manifestDigest: bundle.manifestDigest,
      runtimeAdapterDigest: bundle.manifest.adapterDigest,
      acpCapabilitiesDigest:
        bundle.manifest.acpCapabilitiesDigest,
      platform: 'linux' as const,
      architecture: bundle.manifest.architecture,
      protocol: { ...bundle.manifest.protocol }
    },
    activate,
    destination,
    release,
    resolver,
    sftp
  }
}

describe('RemoteRuntimeInstallationManager', () => {
  it('cryptographically reuses an exact current Host Runtime when bundle resources are absent', async () => {
    const fixture = await metadataOnlyHarness()
    const agentInstallationId =
      verifyAgentInstallationId('agent-current')

    await expect(
      fixture.manager.activateInstalled('host-1', {
        agentInstallationId
      })
    ).resolves.toMatchObject({
      runtimeId: 'opencode',
      runtimeVersion: fixture.bundle.manifest.runtimeVersion,
      bundleDigest: fixture.bundle.manifest.bundleDigest,
      architecture: 'x64'
    })
    expect(fixture.activate).toHaveBeenCalledOnce()
    expect(fixture.activate.mock.calls[0]?.[4]).toBe(
      agentInstallationId
    )
    expect(
      fixture.sftp.operations.some((operation) =>
        operation.startsWith('write:')
      )
    ).toBe(false)
    expect(fixture.release).toHaveBeenCalledOnce()
  })

  it('reuses the current Runtime identity until the Host is invalidated', async () => {
    const fixture = await metadataOnlyHarness()
    const agentInstallationId =
      verifyAgentInstallationId('agent-current')

    const first = await fixture.manager.activateInstalled('host-1', {
      agentInstallationId
    })
    await expect(
      fixture.manager.activateInstalled('host-1', {
        agentInstallationId
      })
    ).resolves.toEqual(first)
    expect(fixture.activate).toHaveBeenCalledOnce()
    expect(fixture.release).toHaveBeenCalledOnce()

    fixture.manager.invalidateHost('host-1')
    await expect(
      fixture.manager.activateInstalled('host-1', {
        agentInstallationId
      })
    ).resolves.toEqual(first)
    expect(fixture.activate).toHaveBeenCalledTimes(2)
    expect(fixture.release).toHaveBeenCalledTimes(2)
  })

  it('activates an exact installed Runtime without loading or publishing installable payloads', async () => {
    const fixture = await metadataOnlyHarness()

    await expect(
      fixture.manager.activateInstalled('host-1')
    ).resolves.toMatchObject({
      runtimeId: 'opencode',
      bundleDigest: fixture.bundle.manifest.bundleDigest,
      architecture: 'x64'
    })

    expect(fixture.activate).toHaveBeenCalledOnce()
    expect(
      fixture.sftp.operations.filter((operation) =>
        /^(?:mkdir|write|chmod|rename|replace|unlink|rmdir):/u
          .test(operation)
      )
    ).toEqual([])
  })

  it('adopts the exact package-published Runtime without loading or mutating payloads', async () => {
    const fixture = await metadataOnlyHarness()

    await expect(
      fixture.manager.activatePublished(
        'host-1',
        fixture.publishedIdentity
      )
    ).resolves.toEqual({
      runtimeId: 'opencode',
      runtimeVersion: fixture.bundle.manifest.runtimeVersion,
      bundleDigest: fixture.bundle.manifest.bundleDigest,
      manifestDigest: fixture.bundle.manifestDigest,
      runtimeAdapterDigest:
        fixture.bundle.manifest.adapterDigest,
      acpCapabilitiesDigest:
        fixture.bundle.manifest.acpCapabilitiesDigest,
      platform: 'linux',
      architecture: 'x64'
    })

    expect(fixture.activate).toHaveBeenCalledOnce()
    expect(
      fixture.sftp.operations.filter((operation) =>
        /^(?:mkdir|write|chmod|rename|replace|unlink|rmdir):/u
          .test(operation)
      )
    ).toEqual([])
  })

  it('adopts a package-published Runtime when all global Runtime metadata is absent', async () => {
    const fixture = await metadataOnlyHarness({
      remoteReleaseKeysAbsent: true,
      remoteRuntimeLockAbsent: true,
      runtimeRegistryAbsent: true
    })

    await expect(
      fixture.manager.activatePublished(
        'host-1',
        fixture.publishedIdentity
      )
    ).resolves.toMatchObject({
      runtimeId: 'opencode',
      bundleDigest: fixture.bundle.manifest.bundleDigest
    })

    expect(fixture.activate).toHaveBeenCalledOnce()
    expect(
      fixture.sftp.entries.has(
        `${home}/.goodbuddy/runtimes/release-keys.json`
      )
    ).toBe(true)
    expect(
      fixture.sftp.entries.has(
        `${home}/.goodbuddy/runtimes/remote-runtime-lock.json`
      )
    ).toBe(true)
    expect(
      fixture.sftp.entries.has(
        `${home}/.goodbuddy/runtimes/registry.json`
      )
    ).toBe(false)
  })

  it('verifies a published Runtime with packaged trust instead of stale Host metadata', async () => {
    const fixture = await metadataOnlyHarness({
      remoteReleaseKeyBytes: canonical({
        formatVersion: 1,
        keys: [],
        revocations: []
      }),
      remoteRuntimeLockBytes: Buffer.from(
        '{ "legacy": "runtime lock" }\n'
      )
    })

    await expect(
      fixture.manager.activatePublished(
        'host-1',
        fixture.publishedIdentity
      )
    ).resolves.toMatchObject({
      runtimeId: 'opencode'
    })
    expect(fixture.activate).toHaveBeenCalledOnce()
  })

  it('rejects a package-published Runtime identity mismatch before activation', async () => {
    const fixture = await metadataOnlyHarness()

    await expect(
      fixture.manager.activatePublished('host-1', {
        ...fixture.publishedIdentity,
        runtimeAdapterDigest: `sha256:${'f'.repeat(64)}`
      })
    ).rejects.toMatchObject({ reason: 'corrupt' })

    expect(fixture.activate).not.toHaveBeenCalled()
  })

  it('does not transfer installer-verified Runtime payloads back through SFTP', async () => {
    const fixture = await metadataOnlyHarness()

    await expect(
      fixture.manager.activatePublished(
        'host-1',
        fixture.publishedIdentity
      )
    ).resolves.toMatchObject({
      bundleDigest: fixture.bundle.manifest.bundleDigest
    })

    expect(fixture.activate).toHaveBeenCalledOnce()
    for (const file of fixture.bundle.manifest.files) {
      expect(fixture.sftp.operations).not.toContain(
        `read:${fixture.destination}/${file.path}`
      )
    }
  })

  it('rejects package-published Runtime adoption after Host identity changes', async () => {
    const fixture = await metadataOnlyHarness({
      resolverTargets: [target(), target(2)]
    })

    await expect(
      fixture.manager.activatePublished(
        'host-1',
        fixture.publishedIdentity
      )
    ).rejects.toMatchObject({
      reason: 'host-identity-changed'
    })

    expect(fixture.activate).not.toHaveBeenCalled()
  })

  it('restores exact Runtime registry bytes when published activation fails', async () => {
    const oldRegistry = Buffer.from(
      '{ "legacy": true, "spacing": "preserved" }\n'
    )
    const oldReleaseKeys = Buffer.from(
      '{ "legacy": "release keys" }\n'
    )
    const oldRuntimeLock = Buffer.from(
      '{ "legacy": "runtime lock" }\n'
    )
    const fixture = await metadataOnlyHarness({
      runtimeRegistryBytes: oldRegistry,
      remoteReleaseKeyBytes: oldReleaseKeys,
      remoteRuntimeLockBytes: oldRuntimeLock,
      activationFailure: true,
      activationMutatesRegistry: true
    })

    await expect(
      fixture.manager.activatePublished(
        'host-1',
        fixture.publishedIdentity
      )
    ).rejects.toMatchObject({ reason: 'activation' })

    expect(
      fixture.sftp.entries.get(
        `${home}/.goodbuddy/runtimes/registry.json`
      )?.contents
    ).toEqual(oldRegistry)
    expect(
      fixture.sftp.entries.get(
        `${home}/.goodbuddy/runtimes/release-keys.json`
      )?.contents
    ).toEqual(oldReleaseKeys)
    expect(
      fixture.sftp.entries.get(
        `${home}/.goodbuddy/runtimes/remote-runtime-lock.json`
      )?.contents
    ).toEqual(oldRuntimeLock)
  })

  it('restores absent Runtime metadata when published activation fails', async () => {
    const fixture = await metadataOnlyHarness({
      runtimeRegistryAbsent: true,
      remoteReleaseKeysAbsent: true,
      remoteRuntimeLockAbsent: true,
      activationFailure: true,
      activationMutatesRegistry: true
    })

    await expect(
      fixture.manager.activatePublished(
        'host-1',
        fixture.publishedIdentity
      )
    ).rejects.toMatchObject({ reason: 'activation' })

    expect(
      fixture.sftp.entries.has(
        `${home}/.goodbuddy/runtimes/registry.json`
      )
    ).toBe(false)
    expect(
      fixture.sftp.entries.has(
        `${home}/.goodbuddy/runtimes/release-keys.json`
      )
    ).toBe(false)
    expect(
      fixture.sftp.entries.has(
        `${home}/.goodbuddy/runtimes/remote-runtime-lock.json`
      )
    ).toBe(false)
  })

  it('rejects metadata-only Runtime reuse when trust metadata differs', async () => {
    const fixture = await metadataOnlyHarness({
      remoteReleaseKeyBytes: canonical({
        formatVersion: 1,
        keys: [],
        revocations: []
      })
    })

    await expect(
      fixture.manager.activateInstalled('host-1')
    ).rejects.toMatchObject({ reason: 'corrupt' })
    expect(fixture.activate).not.toHaveBeenCalled()
  })

  it('rejects metadata-only Runtime reuse when its signature is corrupt', async () => {
    const fixture = await metadataOnlyHarness({
      corruptPath: 'manifest.sig'
    })

    await expect(
      fixture.manager.activateInstalled('host-1')
    ).rejects.toMatchObject({ reason: 'corrupt' })
    expect(fixture.activate).not.toHaveBeenCalled()
  })

  it('delegates exact payload re-verification to Agent activation', async () => {
    const fixture = await metadataOnlyHarness({
      corruptPath: 'bin/opencode'
    })

    await expect(
      fixture.manager.activateInstalled('host-1')
    ).rejects.toMatchObject({ reason: 'activation' })
    expect(fixture.activate).toHaveBeenCalledOnce()
  })

  it('rejects metadata-only Runtime reuse after Host identity changes', async () => {
    const fixture = await metadataOnlyHarness({
      resolverTargets: [target(), target(2)]
    })

    await expect(
      fixture.manager.activateInstalled('host-1')
    ).rejects.toMatchObject({
      reason: 'host-identity-changed'
    })
    expect(fixture.activate).not.toHaveBeenCalled()
  })

  it('deduplicates installed activation and lets one waiter cancel', async () => {
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const fixture = await metadataOnlyHarness({ bootstrapGate: gate })
    const controller = new AbortController()
    const canceled = fixture.manager.activateInstalled('host-1', {
      signal: controller.signal
    })
    const survivor = fixture.manager.activateInstalled('host-1')
    await vi.waitFor(() =>
      expect(fixture.resolver.resolve).toHaveBeenCalledTimes(2)
    )

    controller.abort()
    await expect(canceled).rejects.toMatchObject({ name: 'AbortError' })
    releaseGate()
    await expect(survivor).resolves.toMatchObject({ runtimeId: 'opencode' })
    expect(fixture.activate).toHaveBeenCalledOnce()
    expect(fixture.release).toHaveBeenCalledOnce()
  })

  it('cancels installed activation when its final waiter leaves', async () => {
    const fixture = await metadataOnlyHarness({
      bootstrapGate: new Promise<void>(() => undefined)
    })
    const controller = new AbortController()
    const activation = fixture.manager.activateInstalled('host-1', {
      signal: controller.signal
    })
    await vi.waitFor(() =>
      expect(fixture.resolver.resolve).toHaveBeenCalledOnce()
    )

    controller.abort()
    await expect(activation).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledOnce())
  })

  it('dispose aborts active activation and rejects future calls', async () => {
    const fixture = await metadataOnlyHarness({
      bootstrapGate: new Promise<void>(() => undefined)
    })
    const activation = fixture.manager.activateInstalled('host-1')
    await vi.waitFor(() =>
      expect(fixture.resolver.resolve).toHaveBeenCalledOnce()
    )

    const first = fixture.manager.dispose()
    expect(fixture.manager.dispose()).toBe(first)
    await expect(activation).rejects.toMatchObject({ name: 'AbortError' })
    await first
    await expect(
      fixture.manager.activateInstalled('host-1')
    ).rejects.toThrow('Remote Runtime installation manager is disposed')
  })
})
