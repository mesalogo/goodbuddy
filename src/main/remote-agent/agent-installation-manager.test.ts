import {
  createHash,
  generateKeyPairSync,
  sign
} from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentBundleManifest,
  AgentReleaseKeyRegistry
} from '../../shared/agent-installation-contracts'
import type {
  SftpEntryMetadata,
  StagedSftp
} from '../ssh/bounded-sftp'
import type {
  SshConnectionLease,
  SshConnectionPoolTarget
} from '../ssh/ssh-connection-pool'
import {
  agentManifestSignaturePayload,
  type VerifiedAgentBundle
} from './agent-bundle-verifier'
import {
  AgentInstallationManager
} from './agent-installation-manager'

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
  corruptReadPath?: string
  abortWritePath?: string
  abortController?: AbortController
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
    const absolute = this.absolute(path)
    this.operations.push(`mkdir:${path}`)
    if (this.entries.has(absolute)) {
      throw Object.assign(new Error('exists'), { code: 4 })
    }
    this.entries.set(absolute, {
      type: 'directory',
      mode: 0o700,
      uid
    })
  }

  async writeFile(path: string, contents: Buffer): Promise<void> {
    const absolute = this.absolute(path)
    this.operations.push(`write:${path}`)
    if (this.entries.has(absolute)) {
      throw Object.assign(new Error('exists'), { code: 4 })
    }
    this.entries.set(absolute, {
      type: 'file',
      mode: 0o600,
      uid,
      contents: Buffer.from(contents)
    })
    if (this.abortWritePath === path) {
      this.abortController?.abort()
      throw this.abortController?.signal.reason
    }
  }

  async readFile(path: string): Promise<Buffer> {
    this.operations.push(`read:${path}`)
    const contents = this.entry(path).contents ?? Buffer.alloc(0)
    return path === this.corruptReadPath
      ? Buffer.from('corrupt')
      : Buffer.from(contents)
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

  async chmod(path: string, mode: 0o600 | 0o644 | 0o700 | 0o755): Promise<void> {
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

  async replaceFile(source: string, destination: string): Promise<void> {
    this.operations.push(`replace:${source}:${destination}`)
    const sourceEntry = this.entry(source)
    const destinationEntry = this.entries.get(this.absolute(destination))
    if (
      sourceEntry.type !== 'file' ||
      (destinationEntry && destinationEntry.type !== 'file')
    ) {
      throw new Error('unsafe replacement')
    }
    this.entries.delete(this.absolute(destination))
    this.entries.delete(this.absolute(source))
    this.entries.set(this.absolute(destination), sourceEntry)
  }

  async hardLink(source: string, destination: string): Promise<void> {
    this.operations.push(`link:${source}:${destination}`)
    const sourceEntry = this.entry(source)
    if (sourceEntry.type !== 'file') {
      throw new Error('not file')
    }
    if (this.entries.has(this.absolute(destination))) {
      throw new Error('destination exists')
    }
    this.entries.set(this.absolute(destination), sourceEntry)
  }

  async unlink(path: string): Promise<void> {
    this.operations.push(`unlink:${path}`)
    const entry = this.entry(path)
    if (entry.type !== 'file') {
      throw new Error('not file')
    }
    this.entries.delete(this.absolute(path))
  }

  async rmdir(path: string): Promise<void> {
    this.operations.push(`rmdir:${path}`)
    const absolute = this.absolute(path)
    const entry = this.entry(path)
    if (entry.type !== 'directory') {
      throw new Error('not directory')
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

function target(revision = 1): SshConnectionPoolTarget {
  return {
    host: {
      id: 'host-1',
      name: 'Host',
      hostname: 'host.example',
      port: 22,
      username: 'tester',
      authentication: 'password',
      password: 'secret',
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

async function bundleFixture(): Promise<VerifiedAgentBundle> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-manager-'))
  const files = [
    { path: 'node', contents: Buffer.from('node'), mode: '0755' as const },
    {
      path: 'goodbuddy-agent',
      contents: Buffer.from('agent'),
      mode: '0755' as const
    },
    {
      path: 'lib/agent.cjs',
      contents: Buffer.from('script'),
      mode: '0644' as const
    },
    {
      path: 'licenses/LICENSE.txt',
      contents: Buffer.from('license'),
      mode: '0644' as const
    }
  ]
  const manifest: AgentBundleManifest = {
    formatVersion: 1,
    product: 'GoodBuddy',
    agentVersion: '1.0.0',
    platform: 'linux',
    arch: 'x64',
    protocol: { major: 1, minor: 0 },
    signingKeyId: 'test-key',
    entrypoint: {
      path: 'goodbuddy-agent',
      runtimePath: 'node',
      scriptPath: 'lib/agent.cjs'
    },
    files: files.map((file) => ({
      path: file.path,
      size: file.contents.byteLength,
      sha256: sha256(file.contents),
      mode: file.mode
    })),
    licenses: [{
      package: 'fixture',
      version: '1.0.0',
      spdx: 'MIT',
      path: 'licenses/LICENSE.txt'
    }]
  }
  for (const file of files) {
    const destination = join(directory, ...file.path.split('/'))
    await mkdir(join(destination, '..'), { recursive: true })
    await writeFile(destination, file.contents)
  }
  const manifestBytes = Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`
  )
  await writeFile(join(directory, 'manifest.json'), manifestBytes)
  await writeFile(join(directory, 'manifest.sig'), 'fixture-signature\n')
  return {
    bundleDirectory: directory,
    manifest,
    manifestSha256: sha256(manifestBytes)
  }
}

function stageEmulatedCandidate(
  sftp: MemorySftp,
  bundle: VerifiedAgentBundle,
  installationId: string
): void {
  const path = '.goodbuddy/agent/registry.json'
  const persisted = JSON.parse(
    sftp.entries.get(`${home}/${path}`)?.contents?.toString('utf8') ??
    '{"formatVersion":1}'
  ) as {
    current?: Record<string, unknown>
  }
  const current = persisted.current
  sftp.add(path, {
    type: 'file',
    mode: 0o600,
    uid,
    contents: Buffer.from(`${JSON.stringify({
      formatVersion: 1,
      ...(current === undefined
        ? {}
        : {
            current: {
              installationId: current.installationId,
              agentVersion: current.agentVersion,
              manifestSha256: current.manifestSha256,
              arch: current.arch
            }
          }),
      candidate: registryEntry(bundle, installationId)
    }, null, 2)}\n`)
  })
}

function promoteEmulatedCandidate(
  sftp: MemorySftp,
  bundle: VerifiedAgentBundle,
  installationId: string
): void {
  sftp.add('.goodbuddy/agent/registry.json', {
    type: 'file',
    mode: 0o600,
    uid,
    contents: Buffer.from(`${JSON.stringify({
      formatVersion: 1,
      current: registryEntry(bundle, installationId)
    }, null, 2)}\n`)
  })
}

function registryEntry(
  bundle: VerifiedAgentBundle,
  installationId: string
): Record<string, string> {
  return {
    installationId,
    agentVersion: bundle.manifest.agentVersion,
    manifestSha256: bundle.manifestSha256,
    arch: bundle.manifest.arch
  }
}

function legacyRegistryBytes(): Buffer {
  return Buffer.from(`{
  "formatVersion": 1,
  "minimumTrustedReleaseSequence": 7,
  "current": {
    "installationId": "old-current",
    "productVersion": "0.9.0",
    "agentVersion": "0.9.0",
    "releaseSequence": 7,
    "manifestSha256": "${'d'.repeat(64)}",
    "binaryDigest": "sha256:${'d'.repeat(64)}",
    "arch": "x64",
    "protocol": { "major": 1, "minor": 0 },
    "signingKeyId": "old-key",
    "previouslyVerified": true
  },
  "draining": []
}
`)
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
  remoteRegistryBytes?: Buffer
  remoteReleaseKeyBytes?: Buffer
  hostRegistrySubset?: boolean
  corruptPath?: string
  resolverTargets?: SshConnectionPoolTarget[]
  currentAgentVersion?: string
  currentNodeContents?: Buffer
  trustCurrentSignature?: boolean
  agentStopped?: boolean
  bootstrapGate?: Promise<void>
  publishedLifecycleFailure?: 'bootstrap' | 'health'
  emulatePublishedRegistry?: boolean
  remoteRegistryAbsent?: boolean
  remoteReleaseKeysAbsent?: boolean
} = {}) {
  const bundle = await bundleFixture()
  const keyPair = generateKeyPairSync('ed25519')
  const unrelatedKeyPair = generateKeyPairSync('ed25519')
  const signedRegistry: AgentReleaseKeyRegistry = {
    formatVersion: 1,
    keys: [
      {
        keyId: 'test-key',
        publicKeySpkiBase64: keyPair.publicKey.export({
          format: 'der',
          type: 'spki'
        }).toString('base64'),
        environment: 'test'
      },
      {
        keyId: 'unrelated-new-key',
        publicKeySpkiBase64: unrelatedKeyPair.publicKey.export({
          format: 'der',
          type: 'spki'
        }).toString('base64'),
        environment: 'test'
      }
    ],
    revocations: []
  }
  const manifestBytes = await readFile(
    join(bundle.bundleDirectory, 'manifest.json')
  )
  const candidateSignatureBytes = Buffer.from(
    `${sign(
      null,
      agentManifestSignaturePayload(manifestBytes),
      keyPair.privateKey
    ).toString('base64')}\n`
  )
  await writeFile(
    join(bundle.bundleDirectory, 'manifest.sig'),
    candidateSignatureBytes
  )
  const resourceRoot = await mkdtemp(
    join(tmpdir(), 'agent-metadata-only-')
  )
  const registryBytes = Buffer.from(
    `${JSON.stringify(signedRegistry, null, 2)}\n`
  )
  const rootLock = JSON.parse(
    await readFile(
      join(process.cwd(), 'agent-runtime-lock.json'),
      'utf8'
    )
  ) as Record<string, unknown>
  const runtimeLock = {
    ...rootLock,
    agentVersion: bundle.manifest.agentVersion,
    protocol: bundle.manifest.protocol
  }
  const runtimeLockBytes = Buffer.from(
    `${JSON.stringify(runtimeLock, null, 2)}\n`
  )
  const keyRegistryPath = join(
    resourceRoot,
    'agent-release-keys.json'
  )
  const runtimeLockPath = join(
    resourceRoot,
    'agent-runtime-lock.json'
  )
  await Promise.all([
    writeFile(keyRegistryPath, registryBytes),
    writeFile(runtimeLockPath, runtimeLockBytes)
  ])

  const sftp = new MemorySftp()
  const currentManifest: AgentBundleManifest = {
    ...bundle.manifest,
    agentVersion:
      options.currentAgentVersion ??
      bundle.manifest.agentVersion,
    files: bundle.manifest.files.map((file) =>
      file.path === bundle.manifest.entrypoint.runtimePath &&
      options.currentNodeContents !== undefined
        ? {
            ...file,
            size: options.currentNodeContents.byteLength,
            sha256: sha256(options.currentNodeContents)
          }
        : { ...file }
    )
  }
  const currentManifestBytes = Buffer.from(
    `${JSON.stringify(currentManifest, null, 2)}\n`
  )
  const currentManifestSha256 = sha256(currentManifestBytes)
  const currentInstallationId =
    `agent-${currentManifestSha256}`
  const currentSigningKey = options.trustCurrentSignature === false
    ? generateKeyPairSync('ed25519').privateKey
    : keyPair.privateKey
  const currentSignatureBytes = Buffer.from(
    `${sign(
      null,
      agentManifestSignaturePayload(currentManifestBytes),
      currentSigningKey
    ).toString('base64')}\n`
  )
  const installationId = `agent-${bundle.manifestSha256}`
  const installationRoot =
    `.goodbuddy/agent/installations/${currentInstallationId}`
  for (const path of [
    '.goodbuddy',
    '.goodbuddy/agent',
    '.goodbuddy/agent/installations',
    installationRoot,
    `${installationRoot}/lib`,
    `${installationRoot}/licenses`
  ]) {
    sftp.add(path, {
      type: 'directory',
      mode: 0o700,
      uid
    })
  }
  const persistedRegistry =
    options.remoteRegistryBytes ??
    Buffer.from(`${JSON.stringify({
      formatVersion: 1,
      current: {
        installationId: currentInstallationId,
        agentVersion: currentManifest.agentVersion,
        manifestSha256: currentManifestSha256,
        arch: currentManifest.arch
      }
    }, null, 2)}\n`)
  if (!options.remoteRegistryAbsent) {
    sftp.add('.goodbuddy/agent/registry.json', {
      type: 'file',
      mode: 0o600,
      uid,
      contents: persistedRegistry
    })
  }
  if (!options.remoteReleaseKeysAbsent) {
    sftp.add('.goodbuddy/agent/release-keys.json', {
      type: 'file',
      mode: 0o600,
      uid,
      contents:
        options.remoteReleaseKeyBytes ??
        (
          options.hostRegistrySubset
            ? Buffer.from(`${JSON.stringify({
                ...signedRegistry,
                keys: [signedRegistry.keys[0]]
              }, null, 2)}\n`)
            : registryBytes
        )
    })
  }
  for (const file of bundle.manifest.files) {
    const contents = await readFile(
      join(bundle.bundleDirectory, ...file.path.split('/'))
    )
    sftp.add(`${installationRoot}/${file.path}`, {
      type: 'file',
      mode: file.mode === '0755' ? 0o755 : 0o644,
      uid,
      contents:
        options.corruptPath === file.path
          ? Buffer.alloc(contents.byteLength, 0x78)
          : file.path === bundle.manifest.entrypoint.runtimePath &&
              options.currentNodeContents !== undefined
            ? options.currentNodeContents
            : contents
    })
  }
  sftp.add(`${installationRoot}/manifest.json`, {
    type: 'file',
    mode: 0o644,
    uid,
    contents: currentManifestBytes
  })
  sftp.add(`${installationRoot}/manifest.sig`, {
    type: 'file',
    mode: 0o644,
    uid,
    contents:
      options.corruptPath === 'manifest.sig'
        ? Buffer.from(`${'A'.repeat(86)}==\n`)
        : currentSignatureBytes
  })

  const lifecycleActions: string[] = []
  let healthCalls = 0
  const release = vi.fn()
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
    runAgentLifecycleAction: vi.fn(
      async (_installationId, action: string) => {
        lifecycleActions.push(action)
        if (
          options.emulatePublishedRegistry &&
          action === 'bootstrap'
        ) {
          stageEmulatedCandidate(
            sftp,
            {
              ...bundle,
              manifest: currentManifest,
              manifestSha256: currentManifestSha256
            },
            currentInstallationId
          )
        }
        if (action === 'health') {
          healthCalls += 1
        }
        const publishedFailure =
          options.publishedLifecycleFailure === action
        if (
          options.emulatePublishedRegistry &&
          action === 'health' &&
          !publishedFailure
        ) {
          promoteEmulatedCandidate(
            sftp,
            {
              ...bundle,
              manifest: currentManifest,
              manifestSha256: currentManifestSha256
            },
            currentInstallationId
          )
        }
        return {
          exitCode:
            publishedFailure ||
            (
              action === 'health' &&
              (
                (
                  options.corruptPath === 'node'
                ) ||
                (options.agentStopped === true && healthCalls === 1)
              )
            )
              ? 1
              : 0,
          stdout: '',
          stderr: ''
        }
      }
    ),
    release
  } as unknown as SshConnectionLease
  let resolveCount = 0
  const targets = options.resolverTargets ?? [target()]
  const resolver = {
    resolve: vi.fn(async () =>
      targets[Math.min(resolveCount++, targets.length - 1)]!
    )
  }
  const manager = new AgentInstallationManager({
    resolver,
    sshPool: { acquire: vi.fn(async () => lease) },
    resourcePaths: {
      keyRegistryPath,
      runtimeLockPath,
      bundleDirectories: {
        x64: join(resourceRoot, 'missing-x64'),
        arm64: join(resourceRoot, 'missing-arm64')
      }
    },
    verificationEnvironment: 'test'
  })
  return {
    manager,
    bundle,
    installationId,
    currentInstallationId,
    publishedIdentity: {
      installationId: currentInstallationId,
      agentVersion: currentManifest.agentVersion,
      manifestSha256: currentManifestSha256,
      binaryDigest: `sha256:${currentManifestSha256}`,
      platform: 'linux' as const,
      architecture: currentManifest.arch,
      protocol: { ...currentManifest.protocol },
      supervisor: 'detached-on-demand' as const
    },
    lifecycleActions,
    resolver,
    sftp,
    release
  }
}

describe('AgentInstallationManager', () => {
  it('cryptographically reuses an exact current Host Agent when bundle resources are absent', async () => {
    const fixture = await metadataOnlyHarness()

    await expect(
      fixture.manager.activateInstalled('host-1')
    ).resolves.toMatchObject({
      installationId: fixture.installationId,
      agentVersion: fixture.bundle.manifest.agentVersion,
      architecture: 'x64'
    })
    expect(fixture.lifecycleActions).toEqual(['health'])
    expect(
      fixture.sftp.operations.some((operation) =>
        operation.startsWith('write:')
      )
    ).toBe(false)
    expect(fixture.release).toHaveBeenCalledOnce()
  })

  it('reuses the current Agent identity until the Host is invalidated', async () => {
    const fixture = await metadataOnlyHarness()

    const first = await fixture.manager.activateInstalled('host-1')
    await expect(
      fixture.manager.activateInstalled('host-1')
    ).resolves.toEqual(first)
    expect(fixture.lifecycleActions).toEqual(['health'])
    expect(fixture.release).toHaveBeenCalledOnce()

    fixture.manager.invalidateHost('host-1')
    await expect(
      fixture.manager.activateInstalled('host-1')
    ).resolves.toEqual(first)
    expect(fixture.lifecycleActions).toEqual(['health', 'health'])
    expect(fixture.release).toHaveBeenCalledTimes(2)
  })

  it('activates an exact installed Agent without loading or publishing installable payloads', async () => {
    const fixture = await metadataOnlyHarness({})

    await expect(
      fixture.manager.activateInstalled('host-1')
    ).resolves.toMatchObject({
      installationId: fixture.currentInstallationId,
      architecture: 'x64'
    })

    expect(fixture.lifecycleActions).toEqual(['health'])
    expect(
      fixture.sftp.operations.filter((operation) =>
        /^(?:mkdir|write|chmod|rename|replace|link|unlink|rmdir):/u
          .test(operation)
      )
    ).toEqual([])
  })

  it('bootstraps a stopped installed Agent without SFTP mutation', async () => {
    const fixture = await metadataOnlyHarness({
      agentStopped: true
    })

    await expect(
      fixture.manager.activateInstalled('host-1')
    ).resolves.toMatchObject({
      installationId: fixture.currentInstallationId
    })

    expect(fixture.lifecycleActions).toEqual([
      'health',
      'bootstrap',
      'health'
    ])
    expect(
      fixture.sftp.operations.filter((operation) =>
        /^(?:mkdir|write|chmod|rename|replace|link|unlink|rmdir):/u
          .test(operation)
      )
    ).toEqual([])
  })

  it('adopts the exact package-published Agent without loading or mutating payloads', async () => {
    const fixture = await metadataOnlyHarness({})

    await expect(
      fixture.manager.activatePublished(
        'host-1',
        fixture.publishedIdentity
      )
    ).resolves.toMatchObject({
      installationId: fixture.currentInstallationId,
      agentVersion: fixture.bundle.manifest.agentVersion,
      architecture: 'x64'
    })

    expect(fixture.lifecycleActions).toEqual([
      'bootstrap',
      'health'
    ])
    expect(
      fixture.sftp.operations.filter((operation) =>
        /^(?:mkdir|write|chmod|rename|replace|link|unlink|rmdir):/u
          .test(operation)
      )
    ).toEqual([])
  })

  it('adopts a package-published Agent when all global Agent metadata is absent', async () => {
    const fixture = await metadataOnlyHarness({
      remoteRegistryAbsent: true,
      remoteReleaseKeysAbsent: true
    })

    await expect(
      fixture.manager.activatePublished(
        'host-1',
        fixture.publishedIdentity
      )
    ).resolves.toMatchObject({
      installationId: fixture.currentInstallationId,
      architecture: 'x64'
    })

    expect(fixture.lifecycleActions).toEqual([
      'bootstrap',
      'health'
    ])
    expect(
      fixture.sftp.entries.get(
        `${home}/.goodbuddy/agent/release-keys.json`
      )?.contents
    ).toBeDefined()
    expect(
      fixture.sftp.entries.has(
        `${home}/.goodbuddy/agent/registry.json`
      )
    ).toBe(false)
  })

  it('verifies a published Agent with packaged trust instead of stale Host keys', async () => {
    const fixture = await metadataOnlyHarness({
      remoteReleaseKeyBytes: Buffer.from(
        '{"formatVersion":1,"keys":[],"revocations":[]}\n'
      )
    })

    await expect(
      fixture.manager.activatePublished(
        'host-1',
        fixture.publishedIdentity
      )
    ).resolves.toMatchObject({
      installationId: fixture.currentInstallationId
    })
    expect(fixture.lifecycleActions).toEqual([
      'bootstrap',
      'health'
    ])
  })

  it('rejects a package-published Agent identity mismatch before activation', async () => {
    const fixture = await metadataOnlyHarness()

    await expect(
      fixture.manager.activatePublished('host-1', {
        ...fixture.publishedIdentity,
        agentVersion: '9.9.9'
      })
    ).rejects.toMatchObject({ reason: 'corrupt' })

    expect(fixture.lifecycleActions).toEqual(['stop'])
  })

  it('does not transfer installer-verified Agent payloads back through SFTP', async () => {
    const fixture = await metadataOnlyHarness()

    await expect(
      fixture.manager.activatePublished(
        'host-1',
        fixture.publishedIdentity
      )
    ).resolves.toMatchObject({
      installationId: fixture.currentInstallationId
    })

    expect(fixture.lifecycleActions).toEqual([
      'bootstrap',
      'health'
    ])
    for (const file of fixture.bundle.manifest.files) {
      expect(fixture.sftp.operations).not.toContain(
        `read:.goodbuddy/agent/installations/` +
          `${fixture.currentInstallationId}/${file.path}`
      )
    }
  })

  it('rejects package-published Agent adoption after Host identity changes', async () => {
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

    expect(fixture.lifecycleActions).toEqual(['stop'])
  })

  it('stops a failed package-published Agent and restores registry bytes exactly', async () => {
    const oldRegistry = legacyRegistryBytes()
    const oldReleaseKeys = Buffer.from(
      '{ "legacy": "release keys", "spacing": true }\n'
    )
    const fixture = await metadataOnlyHarness({
      remoteRegistryBytes: oldRegistry,
      remoteReleaseKeyBytes: oldReleaseKeys,
      publishedLifecycleFailure: 'health',
      emulatePublishedRegistry: true
    })

    await expect(
      fixture.manager.activatePublished(
        'host-1',
        fixture.publishedIdentity
      )
    ).rejects.toMatchObject({ reason: 'lifecycle' })

    expect(fixture.lifecycleActions).toEqual([
      'bootstrap',
      'health',
      'stop'
    ])
    expect(
      fixture.sftp.entries.get(
        `${home}/.goodbuddy/agent/registry.json`
      )?.contents
    ).toEqual(oldRegistry)
    expect(
      fixture.sftp.entries.get(
        `${home}/.goodbuddy/agent/release-keys.json`
      )?.contents
    ).toEqual(oldReleaseKeys)
  })

  it('stops a failed package-published Agent and restores global metadata absence', async () => {
    const fixture = await metadataOnlyHarness({
      remoteRegistryAbsent: true,
      remoteReleaseKeysAbsent: true,
      publishedLifecycleFailure: 'health',
      emulatePublishedRegistry: true
    })

    await expect(
      fixture.manager.activatePublished(
        'host-1',
        fixture.publishedIdentity
      )
    ).rejects.toMatchObject({ reason: 'lifecycle' })

    expect(fixture.lifecycleActions).toEqual([
      'bootstrap',
      'health',
      'stop'
    ])
    expect(
      fixture.sftp.entries.has(
        `${home}/.goodbuddy/agent/registry.json`
      )
    ).toBe(false)
    expect(
      fixture.sftp.entries.has(
        `${home}/.goodbuddy/agent/release-keys.json`
      )
    ).toBe(false)
  })

  it('reuses a canonical older Host key subset containing the current signing key', async () => {
    const fixture = await metadataOnlyHarness({
      hostRegistrySubset: true
    })

    await expect(
      fixture.manager.activateInstalled('host-1')
    ).resolves.toMatchObject({
      installationId: fixture.installationId,
      architecture: 'x64'
    })
    expect(fixture.lifecycleActions).toEqual(['health'])
  })

  it('classifies an old Agent as incompatible before reading differing Host key bytes', async () => {
    const fixture = await metadataOnlyHarness({
      currentAgentVersion: '0.9.0',
      remoteReleaseKeyBytes: Buffer.from(
        '{\n  "formatVersion": 1,\n  "keys": [],\n  "revocations": []\n}\n'
      )
    })

    await expect(
      fixture.manager.activateInstalled('host-1')
    ).rejects.toMatchObject({
      reason: 'incompatible',
      message: expect.stringContaining(
        'lacks matching Agent installation resources'
      )
    })
    expect(fixture.sftp.operations).not.toContain(
      'read:.goodbuddy/agent/release-keys.json'
    )
    expect(fixture.lifecycleActions).toEqual([])
  })

  it('rejects a lock-matching Agent when the Host registry lacks its signing key', async () => {
    const fixture = await metadataOnlyHarness({
      remoteReleaseKeyBytes: Buffer.from(
        '{"formatVersion":1,"keys":[],"revocations":[]}\n'
      )
    })

    await expect(
      fixture.manager.activateInstalled('host-1')
    ).rejects.toMatchObject({ reason: 'corrupt' })
    expect(fixture.lifecycleActions).toEqual([])
  })

  it('keeps a lock-matching Agent with an invalid signature classified as corrupt', async () => {
    const fixture = await metadataOnlyHarness({
      corruptPath: 'manifest.sig'
    })

    await expect(
      fixture.manager.activateInstalled('host-1')
    ).rejects.toMatchObject({ reason: 'corrupt' })
    expect(fixture.lifecycleActions).toEqual([])
  })

  it.each(['lib/agent.cjs'])(
    'rejects metadata-only Agent reuse when %s is corrupt',
    async (corruptPath) => {
      const fixture = await metadataOnlyHarness({ corruptPath })

      await expect(
        fixture.manager.activateInstalled('host-1')
      ).rejects.toMatchObject({ reason: 'corrupt' })
      expect(fixture.lifecycleActions).toEqual([])
    }
  )

  it('delegates the large Node runtime hash check to Agent health', async () => {
    const fixture = await metadataOnlyHarness({
      corruptPath: 'node'
    })

    await expect(
      fixture.manager.activateInstalled('host-1')
    ).rejects.toMatchObject({ reason: 'lifecycle' })
    expect(fixture.lifecycleActions).toEqual([
      'health',
      'bootstrap',
      'health'
    ])
  })

  it('rejects metadata-only Agent reuse after Host identity changes', async () => {
    const fixture = await metadataOnlyHarness({
      resolverTargets: [target(), target(2)]
    })

    await expect(
      fixture.manager.activateInstalled('host-1')
    ).rejects.toMatchObject({
      reason: 'host-identity-changed'
    })
    expect(fixture.lifecycleActions).toEqual([])
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
    await expect(survivor).resolves.toMatchObject({
      installationId: fixture.currentInstallationId
    })
    expect(fixture.lifecycleActions).toEqual(['health'])
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
    ).rejects.toThrow('Agent installation manager is disposed')
  })
})
