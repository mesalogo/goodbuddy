import {
  createHash,
  generateKeyPairSync,
  sign
} from 'node:crypto'
import {
  chmod,
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
  AgentInstallationError,
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

const registry: AgentReleaseKeyRegistry = {
  formatVersion: 1,
  keys: [{
    keyId: 'test-key',
    publicKeySpkiBase64: 'AAAA',
    environment: 'test'
  }],
  revocations: []
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

function elfFixture(architecture: 'x64' | 'arm64'): Buffer {
  const header = Buffer.alloc(64)
  header[0] = 0x7f
  header.write('ELF', 1, 'ascii')
  header[4] = 2
  header[5] = 1
  header.writeUInt16LE(
    architecture === 'x64' ? 62 : 183,
    18
  )
  return header
}

async function harness(options: {
  sftp?: MemorySftp
  lifecycleFailure?: 'bootstrap' | 'health'
  lifecycleCancellation?: 'health'
  emulateInstallationRegistry?: boolean
  resolverTargets?: SshConnectionPoolTarget[]
  bootstrapGate?: Promise<void>
} = {}) {
  const bundle = await bundleFixture()
  const sftp = options.sftp ?? new MemorySftp()
  const release = vi.fn()
  const lifecycleActions: string[] = []
  const installationId =
    `agent-${bundle.manifestSha256}`
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
      async (
        _installationId,
        action: string,
        signal?: AbortSignal
      ) => {
        lifecycleActions.push(action)
        if (
          options.emulateInstallationRegistry &&
          action === 'bootstrap'
        ) {
          stageEmulatedCandidate(
            sftp,
            bundle,
            installationId
          )
        }
        if (options.lifecycleCancellation === action) {
          await waitForGate(
            new Promise<void>(() => undefined),
            signal
          )
        }
        const failed = options.lifecycleFailure === action
        if (
          options.emulateInstallationRegistry &&
          action === 'health' &&
          !failed
        ) {
          promoteEmulatedCandidate(
            sftp,
            bundle,
            installationId
          )
        }
        return {
          exitCode: failed ? 1 : 0,
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
  const sshPool = {
    acquire: vi.fn(async () => lease)
  }
  const manager = new AgentInstallationManager({
    resolver,
    sshPool,
    resourcePaths: {
      keyRegistryPath: 'unused',
      runtimeLockPath: 'unused',
      bundleDirectories: { x64: 'unused', arm64: 'unused' }
    },
    verificationEnvironment: 'test',
    loadVerifiedBundle: async () => ({ bundle, registry })
  })
  return {
    manager,
    bundle,
    sftp,
    release,
    lifecycleActions,
    resolver,
    sshPool,
    installationId
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

function populateManagedRegistries(
  fixture: Awaited<ReturnType<typeof harness>>,
  installationRegistry: Buffer,
  releaseKeyRegistry: Buffer
): void {
  for (const path of [
    '.goodbuddy',
    '.goodbuddy/agent',
    '.goodbuddy/agent/staging',
    '.goodbuddy/agent/installations'
  ]) {
    fixture.sftp.add(path, {
      type: 'directory',
      mode: 0o700,
      uid
    })
  }
  fixture.sftp.add('.goodbuddy/agent/registry.json', {
    type: 'file',
    mode: 0o600,
    uid,
    contents: Buffer.from(installationRegistry)
  })
  fixture.sftp.add('.goodbuddy/agent/release-keys.json', {
    type: 'file',
    mode: 0o600,
    uid,
    contents: Buffer.from(releaseKeyRegistry)
  })
  fixture.sftp.add(
    '.goodbuddy/agent/installations/old-current',
    { type: 'directory', mode: 0o700, uid }
  )
}

function managedBytes(
  fixture: Awaited<ReturnType<typeof harness>>,
  path: string
): Buffer | undefined {
  return fixture.sftp.entries.get(`${home}/${path}`)?.contents
}

function bundledRegistryBytes(): Buffer {
  return Buffer.from(`${JSON.stringify(registry, null, 2)}\n`)
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

function populateInstallation(
  fixture: Awaited<ReturnType<typeof harness>>
): void {
  const root =
    `.goodbuddy/agent/installations/${fixture.installationId}`
  fixture.sftp.add(root, {
    type: 'directory',
    mode: 0o700,
    uid
  })
  const directories = new Set<string>()
  for (const file of fixture.bundle.manifest.files) {
    const parts = file.path.split('/')
    let directory = root
    for (const part of parts.slice(0, -1)) {
      directory = `${directory}/${part}`
      if (!directories.has(directory)) {
        fixture.sftp.add(directory, {
          type: 'directory',
          mode: 0o700,
          uid
        })
        directories.add(directory)
      }
    }
    fixture.sftp.add(`${root}/${file.path}`, {
      type: 'file',
      mode: file.mode === '0755' ? 0o755 : 0o644,
      uid,
      contents: Buffer.from(
        file.path === 'node'
          ? 'node'
          : file.path === 'goodbuddy-agent'
            ? 'agent'
            : file.path === 'lib/agent.cjs'
              ? 'script'
              : 'license'
      )
    })
  }
  const manifestBytes = Buffer.from(
    `${JSON.stringify(fixture.bundle.manifest, null, 2)}\n`
  )
  fixture.sftp.add(`${root}/manifest.json`, {
    type: 'file',
    mode: 0o644,
    uid,
    contents: manifestBytes
  })
  fixture.sftp.add(`${root}/manifest.sig`, {
    type: 'file',
    mode: 0o644,
    uid,
    contents: Buffer.from('fixture-signature\n')
  })
}

async function metadataOnlyHarness(options: {
  remoteRegistryBytes?: Buffer
  remoteReleaseKeyBytes?: Buffer
  hostRegistrySubset?: boolean
  corruptPath?: string
  resolverTargets?: SshConnectionPoolTarget[]
  candidateResources?: boolean
  currentAgentVersion?: string
  currentNodeContents?: Buffer
  trustCurrentSignature?: boolean
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
  sftp.add('.goodbuddy/agent/registry.json', {
    type: 'file',
    mode: 0o600,
    uid,
    contents: persistedRegistry
  })
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
  const release = vi.fn()
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
    runAgentLifecycleAction: vi.fn(
      async (_installationId, action: string) => {
        lifecycleActions.push(action)
        return {
          exitCode:
            options.corruptPath === 'node' &&
            !options.candidateResources &&
            action === 'health'
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
    verificationEnvironment: 'test',
    ...(options.candidateResources
      ? {
          loadVerifiedBundle: async () => ({
            bundle,
            registry: signedRegistry
          })
        }
      : {})
  })
  return {
    manager,
    bundle,
    installationId,
    currentInstallationId,
    lifecycleActions,
    resolver,
    sftp,
    release
  }
}

describe('AgentInstallationManager', () => {
  it('requires the independently verified package loader in production', () => {
    expect(() =>
      new AgentInstallationManager({
        resolver: { resolve: vi.fn() },
        sshPool: { acquire: vi.fn() },
        resourcePaths: {
          keyRegistryPath: 'unused',
          runtimeLockPath: 'unused',
          bundleDirectories: {
            x64: 'unused',
            arm64: 'unused'
          }
        }
      })
    ).toThrow(
      'Production Agent installation requires a verified package loader'
    )
  })

  it('cryptographically reuses an exact current Host Agent when bundle resources are absent', async () => {
    const fixture = await metadataOnlyHarness()

    await expect(
      fixture.manager.ensureInstalled('host-1')
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

  it('reuses a canonical older Host key subset containing the current signing key', async () => {
    const fixture = await metadataOnlyHarness({
      hostRegistrySubset: true
    })

    await expect(
      fixture.manager.ensureInstalled('host-1')
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
      fixture.manager.ensureInstalled('host-1')
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
      fixture.manager.ensureInstalled('host-1')
    ).rejects.toMatchObject({ reason: 'corrupt' })
    expect(fixture.lifecycleActions).toEqual([])
  })

  it('keeps a lock-matching Agent with an invalid signature classified as corrupt', async () => {
    const fixture = await metadataOnlyHarness({
      corruptPath: 'manifest.sig'
    })

    await expect(
      fixture.manager.ensureInstalled('host-1')
    ).rejects.toMatchObject({ reason: 'corrupt' })
    expect(fixture.lifecycleActions).toEqual([])
  })

  it.each(['lib/agent.cjs'])(
    'rejects metadata-only Agent reuse when %s is corrupt',
    async (corruptPath) => {
      const fixture = await metadataOnlyHarness({ corruptPath })

      await expect(
        fixture.manager.ensureInstalled('host-1')
      ).rejects.toMatchObject({ reason: 'corrupt' })
      expect(fixture.lifecycleActions).toEqual([])
    }
  )

  it('delegates the large Node runtime hash check to Agent health', async () => {
    const fixture = await metadataOnlyHarness({
      corruptPath: 'node'
    })

    await expect(
      fixture.manager.ensureInstalled('host-1')
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
      fixture.manager.ensureInstalled('host-1')
    ).rejects.toMatchObject({
      reason: 'host-identity-changed'
    })
    expect(fixture.lifecycleActions).toEqual([])
  })

  it('installs in manifest order with exact modes and verified readback', async () => {
    const fixture = await harness()
    const phases: string[] = []
    const identity = await fixture.manager.ensureInstalled(
      'host-1',
      { onProgress: (phase) => phases.push(phase) }
    )

    expect(identity).toMatchObject({
      installationId: fixture.installationId,
      binaryDigest: `sha256:${fixture.bundle.manifestSha256}`,
      architecture: 'x64',
      supervisor: 'detached-on-demand'
    })
    expect(fixture.lifecycleActions).toEqual(['bootstrap', 'health'])
    const payloadWrites = fixture.sftp.operations
      .filter((operation) => operation.startsWith('write:') &&
        !operation.includes('.release-keys-'))
      .map((operation) =>
        operation.slice(operation.lastIndexOf('/') + 1)
      )
    expect(payloadWrites).toEqual([
      'node',
      'goodbuddy-agent',
      'agent.cjs',
      'LICENSE.txt',
      'manifest.json',
      'manifest.sig'
    ])
    expect(
      fixture.sftp.operations.some((operation) =>
        /chmod:.*goodbuddy-agent:755/u.test(operation)
      )
    ).toBe(true)
    expect(phases.at(-1)).toBe('complete')
    expect(fixture.release).toHaveBeenCalledOnce()
    expect(fixture.sftp.closed).toBe(true)
  })

  it('dispatches an arm64 Host through the normal arm64 bundle-directory loader', async () => {
    const resourceRoot = await mkdtemp(
      join(tmpdir(), 'agent-normal-loader-')
    )
    const x64Directory = join(resourceRoot, 'linux-x64')
    const arm64Directory = join(resourceRoot, 'linux-arm64')
    await Promise.all([
      mkdir(x64Directory, { recursive: true }),
      mkdir(arm64Directory, { recursive: true })
    ])
    await writeFile(
      join(x64Directory, 'manifest.json'),
      'not the selected architecture\n'
    )

    const payloads = [
      {
        path: 'node',
        contents: elfFixture('arm64'),
        mode: '0755' as const
      },
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
      ...[
        'lib/node_modules/koffi/package.json',
        'lib/node_modules/koffi/index.js',
        'lib/node_modules/koffi/src/koffi/index.js',
        'lib/node_modules/koffi/src/koffi/src/static.js',
        'lib/node_modules/@koromix/koffi-linux-arm64/package.json',
        'lib/node_modules/@koromix/koffi-linux-arm64/index.js'
      ].map((path) => ({
        path,
        contents: Buffer.from(path),
        mode: '0644' as const
      })),
      ...[
        'lib/node_modules/@koromix/koffi-linux-arm64/linux_arm64/koffi.node',
        'lib/node_modules/@koromix/koffi-linux-arm64/musl_arm64/koffi.node'
      ].map((path) => ({
        path,
        contents: elfFixture('arm64'),
        mode: '0644' as const
      })),
      {
        path: 'licenses/koffi-MIT.txt',
        contents: Buffer.from('koffi license'),
        mode: '0644' as const
      },
      {
        path: 'licenses/koffi-native-MIT.txt',
        contents: Buffer.from('native license'),
        mode: '0644' as const
      }
    ]
    const manifest: AgentBundleManifest = {
      formatVersion: 1,
      product: 'GoodBuddy',
      agentVersion: '1.0.0',
      platform: 'linux',
      arch: 'arm64',
      protocol: { major: 1, minor: 0 },
      signingKeyId: 'test-key',
      entrypoint: {
        path: 'goodbuddy-agent',
        runtimePath: 'node',
        scriptPath: 'lib/agent.cjs'
      },
      files: payloads.map((file) => ({
        path: file.path,
        size: file.contents.byteLength,
        sha256: sha256(file.contents),
        mode: file.mode
      })),
      licenses: [
        {
          package: 'koffi',
          version: '3.1.4',
          spdx: 'MIT',
          path: 'licenses/koffi-MIT.txt'
        },
        {
          package: '@koromix/koffi-linux-arm64',
          version: '3.1.4',
          spdx: 'MIT',
          path: 'licenses/koffi-native-MIT.txt'
        }
      ]
    }
    for (const payload of payloads) {
      const destination = join(
        arm64Directory,
        ...payload.path.split('/')
      )
      await mkdir(join(destination, '..'), { recursive: true })
      await writeFile(destination, payload.contents)
      await chmod(
        destination,
        payload.mode === '0755' ? 0o755 : 0o644
      )
    }
    const keyPair = generateKeyPairSync('ed25519')
    const signedRegistry: AgentReleaseKeyRegistry = {
      formatVersion: 1,
      keys: [{
        keyId: 'test-key',
        publicKeySpkiBase64: keyPair.publicKey.export({
          format: 'der',
          type: 'spki'
        }).toString('base64'),
        environment: 'test'
      }],
      revocations: []
    }
    const manifestBytes = Buffer.from(
      `${JSON.stringify(manifest, null, 2)}\n`
    )
    await Promise.all([
      writeFile(
        join(arm64Directory, 'manifest.json'),
        manifestBytes
      ),
      writeFile(
        join(arm64Directory, 'manifest.sig'),
        Buffer.from(`${sign(
          null,
          agentManifestSignaturePayload(manifestBytes),
          keyPair.privateKey
        ).toString('base64')}\n`)
      )
    ])
    await Promise.all([
      chmod(join(arm64Directory, 'manifest.json'), 0o644),
      chmod(join(arm64Directory, 'manifest.sig'), 0o644)
    ])
    const rootLock = JSON.parse(
      await readFile(
        join(process.cwd(), 'agent-runtime-lock.json'),
        'utf8'
      )
    ) as Record<string, unknown>
    const keyRegistryPath = join(
      resourceRoot,
      'agent-release-keys.json'
    )
    const runtimeLockPath = join(
      resourceRoot,
      'agent-runtime-lock.json'
    )
    await Promise.all([
      writeFile(
        keyRegistryPath,
        Buffer.from(`${JSON.stringify(
          signedRegistry,
          null,
          2
        )}\n`)
      ),
      writeFile(
        runtimeLockPath,
        Buffer.from(`${JSON.stringify({
          ...rootLock,
          agentVersion: manifest.agentVersion,
          protocol: manifest.protocol
        }, null, 2)}\n`)
      )
    ])

    const sftp = new MemorySftp()
    const release = vi.fn()
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
        architecture: 'arm64',
        canonicalHomeDirectory: home,
        uid,
        shell: '/bin/bash',
        procfs: 'ready'
      }) as const),
      openStagedSftp: vi.fn(async () => sftp),
      runAgentLifecycleAction: vi.fn(async () => ({
        exitCode: 0,
        stdout: '',
        stderr: ''
      })),
      release
    } as unknown as SshConnectionLease
    const manager = new AgentInstallationManager({
      resolver: { resolve: vi.fn(async () => target()) },
      sshPool: { acquire: vi.fn(async () => lease) },
      resourcePaths: {
        keyRegistryPath,
        runtimeLockPath,
        bundleDirectories: {
          x64: x64Directory,
          arm64: arm64Directory
        }
      },
      verificationEnvironment: 'test'
    })

    await expect(
      manager.ensureInstalled('host-1')
    ).resolves.toMatchObject({
      architecture: 'arm64',
      agentVersion: manifest.agentVersion
    })
    expect(
      sftp.operations.some((operation) =>
        operation.endsWith('/node')
      )
    ).toBe(true)
    expect(release).toHaveBeenCalledOnce()
  })

  it('upgrades an unverifiable current Agent when candidate resources exist', async () => {
    const fixture = await metadataOnlyHarness({
      candidateResources: true,
      currentAgentVersion: '0.9.0',
      trustCurrentSignature: false
    })

    await expect(
      fixture.manager.ensureInstalled('host-1')
    ).resolves.toMatchObject({
      installationId: fixture.installationId,
      agentVersion: fixture.bundle.manifest.agentVersion
    })
    expect(fixture.lifecycleActions).toEqual([
      'bootstrap',
      'health'
    ])
    expect(
      fixture.sftp.operations.some((operation) =>
        operation.startsWith('write:') &&
        operation.endsWith('/node')
      )
    ).toBe(true)
    expect(
      fixture.sftp.entries.has(
        `${home}/.goodbuddy/agent/installations/${fixture.currentInstallationId}`
      )
    ).toBe(true)
  })

  it('reuses an exactly verified current Node without uploading it', async () => {
    const fixture = await metadataOnlyHarness({
      candidateResources: true,
      currentAgentVersion: '0.9.0'
    })

    await expect(
      fixture.manager.ensureInstalled('host-1')
    ).resolves.toMatchObject({
      installationId: fixture.installationId
    })

    expect(
      fixture.sftp.operations.some((operation) =>
        /^link:\.goodbuddy\/agent\/installations\/agent-[a-f0-9]{64}\/node:\.goodbuddy\/agent\/staging\/op-[^/]+\/node$/u
          .test(operation)
      )
    ).toBe(true)
    expect(
      fixture.sftp.operations.some((operation) =>
        operation.startsWith('write:') &&
        operation.endsWith('/node')
      )
    ).toBe(false)
  })

  it.each([
    {
      condition: 'untrusted current manifest',
      options: { trustCurrentSignature: false }
    },
    {
      condition: 'corrupt current Node',
      options: { corruptPath: 'node' }
    },
    {
      condition: 'different verified current Node',
      options: { currentNodeContents: Buffer.from('old-node') }
    }
  ])(
    'uploads candidate Node for $condition',
    async ({ options }) => {
      const fixture = await metadataOnlyHarness({
        candidateResources: true,
        currentAgentVersion: '0.9.0',
        ...options
      })

      await expect(
        fixture.manager.ensureInstalled('host-1')
      ).resolves.toMatchObject({
        installationId: fixture.installationId
      })
      expect(
        fixture.sftp.operations.some((operation) =>
          operation.startsWith('link:')
        )
      ).toBe(false)
      expect(
        fixture.sftp.operations.some((operation) =>
          operation.startsWith('write:') &&
          operation.endsWith('/node')
        )
      ).toBe(true)
    }
  )

  it('bootstraps a stopped exact installation and reuses it without upload', async () => {
    const fixture = await harness()
    populateInstallation(fixture)
    await fixture.manager.ensureInstalled('host-1')

    expect(fixture.lifecycleActions).toEqual(['bootstrap', 'health'])
    expect(
      fixture.sftp.operations.some((entry) =>
        entry.startsWith('rename:.goodbuddy/agent/staging/')
      )
    ).toBe(false)
  })

  it('reports lifecycle recovery failure without marking a valid bundle corrupt', async () => {
    const fixture = await harness({ lifecycleFailure: 'health' })
    populateInstallation(fixture)

    await expect(
      fixture.manager.ensureInstalled('host-1')
    ).rejects.toMatchObject({ reason: 'lifecycle' })
    expect(fixture.lifecycleActions).toEqual([
      'bootstrap',
      'health',
      'stop'
    ])
    expect(
      fixture.sftp.operations.some((entry) =>
        entry.startsWith('rename:.goodbuddy/agent/staging/')
      )
    ).toBe(false)
  })

  it('rejects corrupt readback and removes operation-owned staging', async () => {
    const sftp = new MemorySftp()
    const fixture = await harness({ sftp })
    const originalRead = sftp.readFile.bind(sftp)
    sftp.readFile = vi.fn(async (path: string) => {
      const value = await originalRead(path)
      if (path.endsWith('/node')) {
        return Buffer.from('bad')
      }
      return value
    })

    await expect(
      fixture.manager.ensureInstalled('host-1')
    ).rejects.toThrow('readback mismatch')
    expect(
      [...sftp.entries.keys()].some((path) =>
        path.includes('/staging/op-')
      )
    ).toBe(false)
    expect(fixture.release).toHaveBeenCalledOnce()
  })

  it('atomically replaces the managed release-key registry', async () => {
    const fixture = await harness()
    fixture.sftp.add('.goodbuddy', {
      type: 'directory',
      mode: 0o700,
      uid
    })
    fixture.sftp.add('.goodbuddy/agent', {
      type: 'directory',
      mode: 0o700,
      uid
    })
    fixture.sftp.add('.goodbuddy/agent/staging', {
      type: 'directory',
      mode: 0o700,
      uid
    })
    fixture.sftp.add('.goodbuddy/agent/installations', {
      type: 'directory',
      mode: 0o700,
      uid
    })
    fixture.sftp.add('.goodbuddy/agent/release-keys.json', {
      type: 'file',
      mode: 0o600,
      uid,
      contents: Buffer.from('old')
    })
    await fixture.manager.ensureInstalled('host-1')

    expect(
      fixture.sftp.operations.some((operation) =>
        /^replace:\.goodbuddy\/agent\/\.release-keys-.*\.tmp:\.goodbuddy\/agent\/release-keys\.json$/u
          .test(operation)
      )
    ).toBe(true)
  })

  it('deduplicates concurrent ensures for the same full host identity', async () => {
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const fixture = await harness({ bootstrapGate: gate })
    const first = fixture.manager.ensureInstalled('host-1')
    const second = fixture.manager.ensureInstalled('host-1', {
      force: true
    })
    await vi.waitFor(() =>
      expect(fixture.sshPool.acquire).toHaveBeenCalledOnce()
    )
    releaseGate()
    const [left, right] = await Promise.all([first, second])
    expect(left).toEqual(right)
    expect(fixture.sshPool.acquire).toHaveBeenCalledOnce()
  })

  it('reuses a successful installation for the same Host identity', async () => {
    const fixture = await harness()
    const first = await fixture.manager.ensureInstalled('host-1')
    const phases: string[] = []
    const second = await fixture.manager.ensureInstalled('host-1', {
      onProgress: (phase) => phases.push(phase)
    })

    expect(second).toEqual(first)
    expect(fixture.sshPool.acquire).toHaveBeenCalledOnce()
    expect(phases).toEqual(['inspecting-host', 'complete'])
  })

  it('force bypasses the settled installation cache and refreshes it after verification', async () => {
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
    expect(fixture.lifecycleActions).toEqual([
      'bootstrap',
      'health',
      'bootstrap',
      'health'
    ])
  })

  it('keeps a shared install running when the first waiter cancels', async () => {
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const fixture = await harness({ bootstrapGate: gate })
    const controller = new AbortController()
    const canceledPhases: string[] = []
    const first = fixture.manager.ensureInstalled('host-1', {
      signal: controller.signal,
      onProgress: (phase) => canceledPhases.push(phase)
    })
    const survivor = fixture.manager.ensureInstalled('host-1')
    await vi.waitFor(() =>
      expect(fixture.sshPool.acquire).toHaveBeenCalledOnce()
    )

    controller.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    releaseGate()

    await expect(survivor).resolves.toMatchObject({
      installationId: fixture.installationId
    })
    expect(fixture.sshPool.acquire).toHaveBeenCalledOnce()
    expect(canceledPhases).toEqual(['inspecting-host'])
    expect(fixture.release).toHaveBeenCalledOnce()
  })

  it('aborts a shared install after its last waiter cancels', async () => {
    const gate = new Promise<void>(() => undefined)
    const fixture = await harness({ bootstrapGate: gate })
    const controller = new AbortController()
    const installation = fixture.manager.ensureInstalled('host-1', {
      signal: controller.signal
    })
    await vi.waitFor(() =>
      expect(fixture.sshPool.acquire).toHaveBeenCalledOnce()
    )

    controller.abort()

    await expect(installation).rejects.toMatchObject({
      name: 'AbortError'
    })
    await vi.waitFor(() =>
      expect(fixture.release).toHaveBeenCalledOnce()
    )
  })

  it('dispose aborts active installs, cleans up, and rejects new calls', async () => {
    const sftp = new MemorySftp()
    let startedNodeWrite!: () => void
    const nodeWriteStarted = new Promise<void>((resolve) => {
      startedNodeWrite = resolve
    })
    const originalWrite = sftp.writeFile.bind(sftp)
    sftp.writeFile = vi.fn(async (
      path: string,
      contents: Buffer,
      signal?: AbortSignal
    ) => {
      await originalWrite(path, contents)
      if (path.endsWith('/node')) {
        startedNodeWrite()
        await waitForGate(
          new Promise<void>(() => undefined),
          signal
        )
      }
    })
    const fixture = await harness({ sftp })
    const installation = fixture.manager.ensureInstalled('host-1')
    await nodeWriteStarted

    const firstDispose = fixture.manager.dispose()
    const secondDispose = fixture.manager.dispose()
    expect(secondDispose).toBe(firstDispose)
    await expect(installation).rejects.toMatchObject({
      name: 'AbortError'
    })
    await firstDispose

    expect(fixture.release).toHaveBeenCalledOnce()
    expect(fixture.sftp.closed).toBe(true)
    expect(
      [...sftp.entries.keys()].some((path) =>
        path.includes('/staging/op-')
      )
    ).toBe(false)
    await expect(
      fixture.manager.ensureInstalled('host-1')
    ).rejects.toThrow('Agent installation manager is disposed')
    expect(fixture.resolver.resolve).toHaveBeenCalledOnce()
  })

  it('cleans tracked staging and releases the lease after abort', async () => {
    const controller = new AbortController()
    const sftp = new MemorySftp()
    sftp.abortController = controller
    const fixture = await harness({ sftp })
    const originalWrite = sftp.writeFile.bind(sftp)
    sftp.writeFile = vi.fn(async (path: string, contents: Buffer) => {
      await originalWrite(path, contents)
      if (path.endsWith('/node')) {
        controller.abort()
        throw controller.signal.reason
      }
    })

    await expect(
      fixture.manager.ensureInstalled('host-1', {
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() =>
      expect(fixture.release).toHaveBeenCalledOnce()
    )
    expect(
      [...sftp.entries.keys()].some((path) =>
        path.includes('/staging/op-')
      )
    ).toBe(false)
  })

  it('stops before activation when the host identity changes', async () => {
    const fixture = await harness({
      resolverTargets: [target(1), target(2)]
    })
    await expect(
      fixture.manager.ensureInstalled('host-1')
    ).rejects.toMatchObject({
      reason: 'host-identity-changed'
    })
    expect(fixture.lifecycleActions).toEqual([])
  })

  it('reports an existing bad destination as corrupt without replacing it', async () => {
    const fixture = await harness()
    const destination =
      `.goodbuddy/agent/installations/${fixture.installationId}`
    fixture.sftp.add(destination, {
      type: 'directory',
      mode: 0o700,
      uid
    })
    await expect(
      fixture.manager.ensureInstalled('host-1')
    ).rejects.toMatchObject({
      reason: 'corrupt'
    })
    expect(fixture.sftp.entries.has(`${home}/${destination}`)).toBe(true)
    expect(
      fixture.sftp.operations.some((entry) =>
        entry.startsWith('rename:.goodbuddy/agent/staging/')
      )
    ).toBe(false)
  })

  it('leaves an old installation untouched when candidate bootstrap fails', async () => {
    const fixture = await harness({ lifecycleFailure: 'bootstrap' })
    fixture.sftp.add(
      '.goodbuddy/agent/installations/old-current',
      { type: 'directory', mode: 0o700, uid }
    )
    await expect(
      fixture.manager.ensureInstalled('host-1')
    ).rejects.toBeInstanceOf(AgentInstallationError)
    expect(
      fixture.sftp.entries.has(
        `${home}/.goodbuddy/agent/installations/old-current`
      )
    ).toBe(true)
    expect(fixture.lifecycleActions).toEqual(['bootstrap', 'stop'])
  })

  it('restores legacy registry and release-key bytes after upgrade health failure', async () => {
    const oldRegistry = legacyRegistryBytes()
    const oldReleaseKeys = Buffer.from(
      '{ "legacy": true, "spacing": "preserved" }\n'
    )
    const fixture = await harness({
      lifecycleFailure: 'health',
      emulateInstallationRegistry: true
    })
    populateManagedRegistries(
      fixture,
      oldRegistry,
      oldReleaseKeys
    )

    await expect(
      fixture.manager.ensureInstalled('host-1')
    ).rejects.toMatchObject({ reason: 'lifecycle' })

    expect(fixture.lifecycleActions).toEqual([
      'bootstrap',
      'health',
      'stop'
    ])
    expect(
      managedBytes(fixture, '.goodbuddy/agent/registry.json')
    ).toEqual(oldRegistry)
    expect(
      managedBytes(
        fixture,
        '.goodbuddy/agent/release-keys.json'
      )
    ).toEqual(oldReleaseKeys)
    expect(
      fixture.sftp.entries.has(
        `${home}/.goodbuddy/agent/installations/old-current`
      )
    ).toBe(true)
  })

  it('stops the candidate and restores exact registry bytes after cancellation', async () => {
    const oldRegistry = legacyRegistryBytes()
    const oldReleaseKeys = Buffer.from('old release key bytes\n')
    const fixture = await harness({
      lifecycleCancellation: 'health',
      emulateInstallationRegistry: true
    })
    populateManagedRegistries(
      fixture,
      oldRegistry,
      oldReleaseKeys
    )
    const controller = new AbortController()
    const installation = fixture.manager.ensureInstalled('host-1', {
      signal: controller.signal
    })
    await vi.waitFor(() =>
      expect(fixture.lifecycleActions).toContain('health')
    )

    controller.abort()

    await expect(installation).rejects.toMatchObject({
      name: 'AbortError'
    })
    await vi.waitFor(() =>
      expect(fixture.release).toHaveBeenCalledOnce()
    )
    expect(fixture.lifecycleActions).toContain('stop')
    expect(
      managedBytes(fixture, '.goodbuddy/agent/registry.json')
    ).toEqual(oldRegistry)
    expect(
      managedBytes(
        fixture,
        '.goodbuddy/agent/release-keys.json'
      )
    ).toEqual(oldReleaseKeys)
  })

  it('keeps only the promoted current registry after successful upgrade health', async () => {
    const oldRegistry = legacyRegistryBytes()
    const fixture = await harness({
      emulateInstallationRegistry: true
    })
    populateManagedRegistries(
      fixture,
      oldRegistry,
      Buffer.from('old release keys\n')
    )

    await expect(
      fixture.manager.ensureInstalled('host-1')
    ).resolves.toMatchObject({
      installationId: fixture.installationId
    })

    expect(fixture.lifecycleActions).toEqual([
      'bootstrap',
      'health'
    ])
    expect(JSON.parse(
      managedBytes(
        fixture,
        '.goodbuddy/agent/registry.json'
      )!.toString('utf8')
    )).toEqual({
      formatVersion: 1,
      current: registryEntry(
        fixture.bundle,
        fixture.installationId
      )
    })
    expect(
      managedBytes(
        fixture,
        '.goodbuddy/agent/release-keys.json'
      )
    ).toEqual(bundledRegistryBytes())
  })
})
