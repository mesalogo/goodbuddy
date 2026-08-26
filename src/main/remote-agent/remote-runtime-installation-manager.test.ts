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
import {
  RemoteRuntimeBundleResourcesUnavailableError,
  RemoteRuntimeInstallationError,
  RemoteRuntimeInstallationManager,
  type VerifiedRemoteRuntimeInstallationBundle
} from './remote-runtime-installation-manager'

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
  VerifiedRemoteRuntimeInstallationBundle
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

async function harness(options: {
  sftp?: MemorySftp
  resolverTargets?: SshConnectionPoolTarget[]
  bootstrapGate?: Promise<void>
  maximumConcurrentHosts?: number
} = {}) {
  const bundle = await bundleFixture()
  const sftp = options.sftp ?? new MemorySftp()
  const release = vi.fn()
  const activate = vi.fn(async () => undefined)
  const lease = {
    identity: {
      hostId: 'host-1',
      hostRevision: 1,
      hostKeyGeneration: 1,
      authenticationIdentity: 'b'.repeat(64)
    },
    isUsable: () => true,
    runAgentBootstrapProbe: vi.fn(
      async (signal?: AbortSignal) => {
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
      }
    ),
    openStagedSftp: vi.fn(async () => sftp),
    release
  } as unknown as SshConnectionLease
  let resolveCount = 0
  const targets = options.resolverTargets ?? [target()]
  const resolver = {
    resolve: vi.fn(async () =>
      targets[
        Math.min(resolveCount++, targets.length - 1)
      ]!
    )
  }
  const sshPool = {
    acquire: vi.fn(async () => lease)
  }
  const manager = new RemoteRuntimeInstallationManager({
    resolver,
    sshPool,
    loadVerifiedBundle: async () => bundle,
    activate,
    maximumConcurrentHosts: options.maximumConcurrentHosts
  })
  const destination =
    `.goodbuddy/runtimes/opencode/${
      bundle.manifest.bundleDigest.slice('sha256:'.length)
    }`
  return {
    manager,
    bundle,
    sftp,
    release,
    activate,
    lease,
    resolver,
    sshPool,
    destination
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

function populateBundle(
  fixture: Awaited<ReturnType<typeof harness>>
): void {
  fixture.sftp.add(fixture.destination, {
    type: 'directory',
    mode: 0o700,
    uid
  })
  fixture.sftp.add(`${fixture.destination}/bin`, {
    type: 'directory',
    mode: 0o700,
    uid
  })
  fixture.sftp.add(`${fixture.destination}/licenses`, {
    type: 'directory',
    mode: 0o700,
    uid
  })
  fixture.sftp.add(`${fixture.destination}/bin/opencode`, {
    type: 'file',
    mode: 0o755,
    uid,
    contents: Buffer.from('opencode')
  })
  fixture.sftp.add(`${fixture.destination}/licenses/LICENSE`, {
    type: 'file',
    mode: 0o644,
    uid,
    contents: Buffer.from('license')
  })
  fixture.sftp.add(`${fixture.destination}/manifest.json`, {
    type: 'file',
    mode: 0o644,
    uid,
    contents: canonical(fixture.bundle.manifest)
  })
  fixture.sftp.add(`${fixture.destination}/manifest.sig`, {
    type: 'file',
    mode: 0o644,
    uid,
    contents: Buffer.alloc(64, 7)
  })
}

async function metadataOnlyHarness(options: {
  corruptPath?: string
  remoteReleaseKeyBytes?: Buffer
  resolverTargets?: SshConnectionPoolTarget[]
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
  const bundle: VerifiedRemoteRuntimeInstallationBundle = {
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
  for (const [path, contents] of [
    [
      '.goodbuddy/runtimes/registry.json',
      runtimeRegistryBytes
    ],
    [
      '.goodbuddy/runtimes/release-keys.json',
      options.remoteReleaseKeyBytes ??
        releaseKeyRegistryBytes
    ],
    [
      '.goodbuddy/runtimes/remote-runtime-lock.json',
      remoteRuntimeLockBytes
    ]
  ] as const) {
    sftp.add(path, {
      type: 'file',
      mode: 0o600,
      uid,
      contents
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
  const activate = vi.fn(async () => {
    if (
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
    runAgentBootstrapProbe: vi.fn(async () => ({
      ready: true,
      platform: 'linux',
      architecture: 'x64',
      canonicalHomeDirectory: home,
      uid,
      shell: '/bin/bash',
      procfs: 'ready'
    }) as const),
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
    loadVerifiedBundle: async () => {
      throw new RemoteRuntimeBundleResourcesUnavailableError()
    },
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

    await expect(
      fixture.manager.ensureInstalled('host-1')
    ).resolves.toMatchObject({
      runtimeId: 'opencode',
      runtimeVersion: fixture.bundle.manifest.runtimeVersion,
      bundleDigest: fixture.bundle.manifest.bundleDigest,
      architecture: 'x64'
    })
    expect(fixture.activate).toHaveBeenCalledOnce()
    expect(
      fixture.sftp.operations.some((operation) =>
        operation.startsWith('write:')
      )
    ).toBe(false)
    expect(fixture.release).toHaveBeenCalledOnce()
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
      fixture.manager.ensureInstalled('host-1')
    ).rejects.toMatchObject({ reason: 'corrupt' })
    expect(fixture.activate).not.toHaveBeenCalled()
  })

  it('rejects metadata-only Runtime reuse when its signature is corrupt', async () => {
    const fixture = await metadataOnlyHarness({
      corruptPath: 'manifest.sig'
    })

    await expect(
      fixture.manager.ensureInstalled('host-1')
    ).rejects.toMatchObject({ reason: 'corrupt' })
    expect(fixture.activate).not.toHaveBeenCalled()
  })

  it('delegates exact payload re-verification to Agent activation', async () => {
    const fixture = await metadataOnlyHarness({
      corruptPath: 'bin/opencode'
    })

    await expect(
      fixture.manager.ensureInstalled('host-1')
    ).rejects.toMatchObject({ reason: 'activation' })
    expect(fixture.activate).toHaveBeenCalledOnce()
  })

  it('rejects metadata-only Runtime reuse after Host identity changes', async () => {
    const fixture = await metadataOnlyHarness({
      resolverTargets: [target(), target(2)]
    })

    await expect(
      fixture.manager.ensureInstalled('host-1')
    ).rejects.toMatchObject({
      reason: 'host-identity-changed'
    })
    expect(fixture.activate).not.toHaveBeenCalled()
  })

  it('installs, atomically publishes, then activates OpenCode', async () => {
    const fixture = await harness()
    const identity = await fixture.manager.ensureInstalled('host-1')

    expect(identity).toEqual({
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
    expect(
      fixture.sftp.entries.has(`${home}/${fixture.destination}`)
    ).toBe(true)
    expect(
      fixture.sftp.operations.filter((entry) =>
        entry.startsWith('replace:.goodbuddy/runtimes/')
      )
    ).toHaveLength(2)
    const publishIndex = fixture.sftp.operations.findIndex(
      (entry) =>
        entry.startsWith(
          'rename:.goodbuddy/runtimes/staging/op-'
        )
    )
    expect(publishIndex).toBeGreaterThan(-1)
    expect(fixture.activate).toHaveBeenCalledOnce()
    expect(fixture.activate).toHaveBeenCalledWith(
      fixture.lease,
      'opencode',
      fixture.bundle.manifest.bundleDigest,
      'x64',
      expect.any(AbortSignal)
    )
    expect(fixture.release).toHaveBeenCalledOnce()
  })

  it('fully verifies and reuses an existing digest destination', async () => {
    const fixture = await harness()
    populateBundle(fixture)

    const identity =
      await fixture.manager.ensureInstalled('host-1')

    expect(identity).toEqual({
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
    expect(
      fixture.sftp.operations.some((entry) =>
        entry.startsWith(
          'rename:.goodbuddy/runtimes/staging/op-'
        )
      )
    ).toBe(false)
    expect(fixture.activate).toHaveBeenCalledOnce()
  })

  it('rejects mutated remote readback, cleans staging, and never activates', async () => {
    const fixture = await harness()
    fixture.sftp.mutateRead = (path, contents) =>
      path.endsWith('/bin/opencode')
        ? Buffer.from('mutated')
        : contents

    await expect(
      fixture.manager.ensureInstalled('host-1')
    ).rejects.toMatchObject({
      reason: 'corrupt'
    })
    expect(fixture.activate).not.toHaveBeenCalled()
    expect(
      [...fixture.sftp.entries.keys()].some((path) =>
        path.includes('/runtimes/staging/op-')
      )
    ).toBe(false)
  })

  it('rejects an identity race before publication and activation', async () => {
    const fixture = await harness({
      resolverTargets: [target(1), target(2)]
    })

    await expect(
      fixture.manager.ensureInstalled('host-1')
    ).rejects.toMatchObject({
      reason: 'host-identity-changed'
    })
    expect(fixture.activate).not.toHaveBeenCalled()
    expect(
      [...fixture.sftp.entries.keys()].some((path) =>
        path.includes('/runtimes/staging/op-')
      )
    ).toBe(false)
  })

  it('cancels the shared operation when its final waiter leaves and cleans up', async () => {
    const sftp = new MemorySftp()
    let payloadStarted!: () => void
    const started = new Promise<void>((resolve) => {
      payloadStarted = resolve
    })
    const originalWrite = sftp.writeFile.bind(sftp)
    sftp.writeFile = vi.fn(async (
      path: string,
      contents: Buffer,
      signal?: AbortSignal
    ) => {
      await originalWrite(path, contents)
      if (path.endsWith('/bin/opencode')) {
        payloadStarted()
        await waitForGate(
          new Promise<void>(() => undefined),
          signal
        )
      }
    })
    const fixture = await harness({ sftp })
    const controller = new AbortController()
    const installation = fixture.manager.ensureInstalled('host-1', {
      signal: controller.signal
    })
    await started
    controller.abort()

    await expect(installation).rejects.toMatchObject({
      name: 'AbortError'
    })
    await vi.waitFor(() =>
      expect(fixture.release).toHaveBeenCalledOnce()
    )
    expect(
      [...sftp.entries.keys()].some((path) =>
        path.includes('/runtimes/staging/op-')
      )
    ).toBe(false)
  })

  it('deduplicates one host and enforces concurrent host capacity', async () => {
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const fixture = await harness({
      bootstrapGate: gate,
      maximumConcurrentHosts: 1,
      resolverTargets: [
        target(),
        target(),
        target(1, 'host-2'),
        target()
      ]
    })
    const first = fixture.manager.ensureInstalled('host-1')
    const second = fixture.manager.ensureInstalled('host-1', {
      force: true
    })
    await vi.waitFor(() =>
      expect(fixture.sshPool.acquire).toHaveBeenCalledOnce()
    )

    await expect(
      fixture.manager.ensureInstalled('host-2')
    ).rejects.toMatchObject({
      reason: 'capacity'
    })
    releaseGate()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(fixture.sshPool.acquire).toHaveBeenCalledOnce()
  })

  it('reuses a successful Runtime installation for the same Host identity', async () => {
    const fixture = await harness()
    const first = await fixture.manager.ensureInstalled('host-1')
    const phases: string[] = []
    const second = await fixture.manager.ensureInstalled('host-1', {
      onProgress: (phase) => phases.push(phase)
    })

    expect(second).toEqual(first)
    expect(fixture.sshPool.acquire).toHaveBeenCalledOnce()
    expect(fixture.activate).toHaveBeenCalledOnce()
    expect(phases).toEqual(['inspecting-host', 'complete'])
  })

  it('force bypasses the settled Runtime cache and refreshes it after verification', async () => {
    const fixture = await harness()
    const first = await fixture.manager.ensureInstalled('host-1')

    const refreshed = await fixture.manager.ensureInstalled(
      'host-1',
      { force: true }
    )
    const cached = await fixture.manager.ensureInstalled('host-1')

    expect(refreshed).toEqual(first)
    expect(cached).toEqual(refreshed)
    expect(fixture.sshPool.acquire).toHaveBeenCalledTimes(2)
    expect(fixture.activate).toHaveBeenCalledTimes(2)
  })

  it('reports activation errors distinctly after verified publication', async () => {
    const fixture = await harness()
    fixture.activate.mockRejectedValueOnce(
      new Error('fixed activation command failed')
    )

    await expect(
      fixture.manager.ensureInstalled('host-1')
    ).rejects.toBeInstanceOf(RemoteRuntimeInstallationError)
    await expect(
      fixture.manager.ensureInstalled('host-1')
    ).resolves.toMatchObject({ runtimeId: 'opencode' })
    expect(
      fixture.sftp.entries.has(`${home}/${fixture.destination}`)
    ).toBe(true)
    expect(fixture.activate).toHaveBeenCalledTimes(2)
  })
})
