import {
  createHash,
  createPublicKey,
  verify
} from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  type FileHandle
} from 'node:fs/promises'
import {
  dirname,
  join,
  relative,
  resolve,
  sep
} from 'node:path'
import {
  Unzip,
  UnzipInflate,
  UnzipPassThrough
} from 'fflate'
import {
  agentPackageDescriptorSchema,
  isSafeAgentPackagePath,
  type AgentPackageDescriptor
} from '../../shared/agent-package-contracts'
import {
  AGENT_PROTOCOL_VERSION
} from '../../shared/agent-protocol/contracts'
import {
  canonicalJson
} from '../../shared/agent-protocol/canonical'
import {
  agentReleaseKeyRegistrySchema,
  type AgentArchitecture,
  type AgentReleaseKeyRegistry
} from '../../shared/agent-installation-contracts'
import {
  canonicalAgentReleaseKeyRegistryBytes,
  verifyAgentBundleDirectory,
  type AgentVerificationEnvironment,
  type VerifiedAgentBundle
} from './agent-bundle-verifier'
import {
  loadVerifiedRemoteRuntimeResourceBundle,
  loadRemoteRuntimeVerificationMetadata,
  type RemoteRuntimeVerificationMetadata
} from './remote-runtime-resource-loader'
import type {
  BundledRemoteRuntimeResourcePaths
} from './bundled-remote-runtime-resources'
import type {
  VerifiedRemoteRuntimeInstallationBundle
} from './remote-runtime-installation-manager'

const DESCRIPTOR_NAME = 'agent-package.json'
const SIGNATURE_NAME = 'agent-package.sig'
const MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024
const MAXIMUM_EXPANDED_BYTES = 1024 * 1024 * 1024
const MAXIMUM_FILE_BYTES = 384 * 1024 * 1024
const MAXIMUM_METADATA_BYTES = 1024 * 1024
const MAXIMUM_ENTRIES = 50_002
const PRIVATE_DIRECTORY_MODE = 0o700
const SIGNATURE_DOMAIN = Buffer.from(
  'GoodBuddy Agent Package Descriptor Signature v1\0',
  'utf8'
)

export type VerifiedAgentPackage = {
  rootDirectory: string
  descriptor: AgentPackageDescriptor
  agentBundle: VerifiedAgentBundle
  runtimeBundle: VerifiedRemoteRuntimeInstallationBundle
  runtimeMetadata: RemoteRuntimeVerificationMetadata
}

export async function extractAndVerifyAgentPackage(options: {
  archivePath: string
  destinationDirectory: string
  architecture?: AgentArchitecture
  desktopVersion: string
  trustedRegistry: AgentReleaseKeyRegistry
  verificationEnvironment?: AgentVerificationEnvironment
}): Promise<VerifiedAgentPackage> {
  const archivePath = resolve(options.archivePath)
  const destinationDirectory = resolve(options.destinationDirectory)
  await assertArchiveFile(archivePath)
  await mkdir(destinationDirectory, {
    recursive: false,
    mode: PRIVATE_DIRECTORY_MODE
  })
  try {
    await extractArchive(archivePath, destinationDirectory)
    return await verifyExtractedAgentPackage({
      rootDirectory: destinationDirectory,
      architecture: options.architecture,
      desktopVersion: options.desktopVersion,
      trustedRegistry: options.trustedRegistry,
      verificationEnvironment: options.verificationEnvironment
    })
  } catch (error) {
    await rm(destinationDirectory, { recursive: true, force: true })
    throw error
  }
}

export async function verifyExtractedAgentPackage(options: {
  rootDirectory: string
  architecture?: AgentArchitecture
  desktopVersion: string
  trustedRegistry: AgentReleaseKeyRegistry
  verificationEnvironment?: AgentVerificationEnvironment
}): Promise<VerifiedAgentPackage> {
  const rootDirectory = resolve(options.rootDirectory)
  await assertRealDirectory(rootDirectory, 'Agent package directory')
  const [descriptorBytes, signatureBytes, registryBytes] =
    await Promise.all([
      readBoundedFile(
        join(rootDirectory, DESCRIPTOR_NAME),
        MAXIMUM_METADATA_BYTES
      ),
      readBoundedFile(
        join(rootDirectory, SIGNATURE_NAME),
        MAXIMUM_METADATA_BYTES
      ),
      readBoundedFile(
        join(rootDirectory, 'agent-release-keys.json'),
        MAXIMUM_METADATA_BYTES
      )
    ])
  const descriptor = parseCanonicalDescriptor(descriptorBytes)
  if (
    options.architecture !== undefined &&
    descriptor.architecture !== options.architecture
  ) {
    throw new Error(
      'Agent package architecture does not match the requested target'
    )
  }
  if (
    compareSemanticVersions(
      options.desktopVersion,
      descriptor.minimumDesktopVersion
    ) < 0 ||
    descriptor.agentProtocol.major !== AGENT_PROTOCOL_VERSION.major ||
    descriptor.agentProtocol.minor > AGENT_PROTOCOL_VERSION.minor
  ) {
    throw new Error(
      'Agent package is not compatible with this GoodBuddy version'
    )
  }
  const registry = parseCanonicalRegistry(registryBytes)
  const trustedRegistry = agentReleaseKeyRegistrySchema.parse(
    options.trustedRegistry
  )
  verifyDescriptorSignature(
    descriptor,
    descriptorBytes,
    signatureBytes,
    trustedRegistry,
    options.verificationEnvironment ?? 'production'
  )
  if (
    descriptor.contentDigest !==
    descriptorContentDigest(descriptor)
  ) {
    throw new Error('Agent package content identity is invalid')
  }
  await verifyDeclaredFiles(rootDirectory, descriptor)

  const agentRuntimeLock = JSON.parse(
    (
      await readBoundedFile(
        join(rootDirectory, 'agent-runtime-lock.json'),
        MAXIMUM_METADATA_BYTES
      )
    ).toString('utf8')
  ) as unknown
  const agentBundle = await verifyAgentBundleDirectory(
    join(rootDirectory, 'agent'),
    {
      architecture: descriptor.architecture,
      registry,
      runtimeLock: agentRuntimeLock as never,
      verificationEnvironment:
        options.verificationEnvironment ?? 'production'
    }
  )
  if (
    agentBundle.manifest.agentVersion !== descriptor.version ||
    agentBundle.manifest.protocol.major !==
      descriptor.agentProtocol.major ||
    agentBundle.manifest.protocol.minor !==
      descriptor.agentProtocol.minor
  ) {
    throw new Error(
      'Agent package descriptor does not match its Agent bundle'
    )
  }

  const runtimePaths: BundledRemoteRuntimeResourcePaths = {
    keyRegistryPath: join(
      rootDirectory,
      'agent-release-keys.json'
    ),
    runtimeLockPath: join(
      rootDirectory,
      'remote-runtime-lock.json'
    ),
    runtimeRoots: {
      x64: join(
        rootDirectory,
        'runtime',
        'opencode'
      ),
      arm64: join(
        rootDirectory,
        'runtime',
        'opencode'
      )
    }
  }
  const runtimeBundle =
    await loadVerifiedRemoteRuntimeResourceBundle(
      runtimePaths,
      descriptor.architecture,
      {
        verificationEnvironment:
          options.verificationEnvironment ?? 'production'
      }
    )
  const runtimeMetadata =
    await loadRemoteRuntimeVerificationMetadata(runtimePaths)
  if (
    runtimeBundle.manifest.runtimeVersion !==
      descriptor.remoteRuntime.version ||
    runtimeBundle.manifest.bundleDigest !==
      descriptor.remoteRuntime.bundleDigest ||
    runtimeBundle.manifest.protocol.major !==
      descriptor.remoteRuntime.protocol.major ||
    runtimeBundle.manifest.protocol.minor !==
      descriptor.remoteRuntime.protocol.minor
  ) {
    throw new Error(
      'Agent package descriptor does not match its Runtime bundle'
    )
  }
  return {
    rootDirectory,
    descriptor,
    agentBundle,
    runtimeBundle,
    runtimeMetadata
  }
}

async function assertArchiveFile(filePath: string): Promise<void> {
  const status = await lstat(filePath)
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.size <= 0 ||
    status.size > MAXIMUM_ARCHIVE_BYTES
  ) {
    throw new Error('Agent package must be a bounded regular file')
  }
}

async function assertRealDirectory(
  directory: string,
  label: string
): Promise<void> {
  const status = await lstat(directory)
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory`)
  }
}

function safeArchivePath(name: string): string {
  if (!isSafeAgentPackagePath(name)) {
    throw new Error(`Agent package path is unsafe: ${name}`)
  }
  return name
}

async function extractArchive(
  archivePath: string,
  destination: string
): Promise<void> {
  const input = await open(
    archivePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  )
  const openHandles = new Set<FileHandle>()
  const openingHandles = new Set<Promise<FileHandle>>()
  const completions: Promise<
    { ok: true } | { ok: false; error: Error }
  >[] = []
  const pendingWrites = new Set<Promise<void>>()
  const seen = new Set<string>()
  let entryCount = 0
  let totalBytes = 0
  let fatalError: Error | undefined
  const fail = (error: unknown): Error => {
    const resolved =
      error instanceof Error
        ? error
        : new Error('Agent package archive is invalid')
    fatalError ??= resolved
    return resolved
  }
  const unzip = new Unzip((file) => {
    let rejectEntry: ((error: Error) => void) | undefined
    let completionRegistered = false
    try {
      entryCount += 1
      if (entryCount > MAXIMUM_ENTRIES) {
        throw new Error('Agent package contains too many entries')
      }
      const name = safeArchivePath(file.name)
      if (seen.has(name)) {
        throw new Error('Agent package contains duplicate entries')
      }
      seen.add(name)
      const maximum =
        name === DESCRIPTOR_NAME || name === SIGNATURE_NAME
          ? MAXIMUM_METADATA_BYTES
          : MAXIMUM_FILE_BYTES
      if (
        file.originalSize !== undefined &&
        (
          file.originalSize < 0 ||
          file.originalSize > maximum ||
          totalBytes + file.originalSize >
            MAXIMUM_EXPANDED_BYTES
        )
      ) {
        throw new Error(
          `Agent package entry exceeds its limit: ${name}`
        )
      }
      const destinationPath = resolve(
        destination,
        ...name.split('/')
      )
      const pathFromRoot = relative(destination, destinationPath)
      if (
        pathFromRoot.startsWith('..') ||
        resolve(destination, pathFromRoot) !== destinationPath
      ) {
        throw new Error('Agent package entry escapes its destination')
      }
      const handlePromise = mkdir(dirname(destinationPath), {
        recursive: true,
        mode: PRIVATE_DIRECTORY_MODE
      }).then(async () => {
        const handle = await open(destinationPath, 'wx')
        openHandles.add(handle)
        return handle
      })
      openingHandles.add(handlePromise)
      void handlePromise.finally(() =>
        openingHandles.delete(handlePromise)
      ).catch(() => undefined)
      let written = 0
      let writeChain = Promise.resolve()
      let resolveEntry: (() => void) | undefined
      const completion = new Promise<void>((resolvePromise, rejectPromise) => {
        resolveEntry = resolvePromise
        rejectEntry = rejectPromise
      })
      completionRegistered = true
      completions.push(
        completion.then(
          () => ({ ok: true as const }),
          (error: Error) => ({ ok: false as const, error })
        )
      )
      file.ondata = (error, data, final) => {
        if (error || fatalError) {
          file.terminate()
          rejectEntry?.(fail(error ?? fatalError))
          return
        }
        written += data.byteLength
        totalBytes += data.byteLength
        if (
          written > maximum ||
          totalBytes > MAXIMUM_EXPANDED_BYTES
        ) {
          file.terminate()
          rejectEntry?.(
            fail(
              new Error(
                `Agent package entry exceeds its limit: ${name}`
              )
            )
          )
          return
        }
        writeChain = writeChain.then(async () => {
          const handle = await handlePromise
          if (data.byteLength > 0) {
            await writeAll(handle, data)
          }
        })
        const pendingWrite = writeChain
        pendingWrites.add(pendingWrite)
        void pendingWrite
          .finally(() =>
            pendingWrites.delete(pendingWrite)
          )
          .catch(() => undefined)
        if (final) {
          void writeChain
            .then(async () => {
              const handle = await handlePromise
              await handle.close()
              openHandles.delete(handle)
            })
            .then(
              () => resolveEntry?.(),
              (writeError: unknown) => {
                rejectEntry?.(fail(writeError))
              }
            )
        }
      }
      file.start()
    } catch (error) {
      file.terminate()
      const resolved = fail(error)
      if (completionRegistered) {
        rejectEntry?.(resolved)
      } else {
        completions.push(
          Promise.resolve({ ok: false as const, error: resolved })
        )
      }
    }
  })
  unzip.register(UnzipPassThrough)
  unzip.register(UnzipInflate)
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    const opened = await input.stat()
    if (!opened.isFile() || opened.size > MAXIMUM_ARCHIVE_BYTES) {
      throw new Error('Agent package changed while it was being opened')
    }
    while (true) {
      if (fatalError) {
        throw fatalError
      }
      const { bytesRead } = await input.read(
        buffer,
        0,
        buffer.length
      )
      if (bytesRead === 0) {
        unzip.push(new Uint8Array(), true)
        break
      }
      unzip.push(
        Uint8Array.from(buffer.subarray(0, bytesRead)),
        false
      )
      await Promise.all([...pendingWrites])
    }
    const results = await Promise.all(completions)
    const failed = results.find((result) => !result.ok)
    if (failed && !failed.ok) {
      throw failed.error
    }
    if (fatalError) {
      throw fatalError
    }
  } finally {
    await input.close()
    await Promise.allSettled([...openingHandles])
    await Promise.all(
      [...openHandles].map((handle) =>
        handle.close().catch(() => undefined)
      )
    )
  }
}

async function writeAll(
  handle: FileHandle,
  bytes: Uint8Array
): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset
    )
    if (bytesWritten <= 0) {
      throw new Error('Agent package write made no progress')
    }
    offset += bytesWritten
  }
}

async function readBoundedFile(
  filePath: string,
  maximumBytes: number
): Promise<Buffer> {
  const status = await lstat(filePath)
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.size <= 0 ||
    status.size > maximumBytes
  ) {
    throw new Error('Agent package metadata is invalid')
  }
  return readFile(filePath)
}

function parseCanonicalDescriptor(
  bytes: Buffer
): AgentPackageDescriptor {
  const descriptor = agentPackageDescriptorSchema.parse(
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    )
  )
  if (
    !Buffer.from(
      `${JSON.stringify(descriptor, null, 2)}\n`,
      'utf8'
    ).equals(bytes)
  ) {
    throw new Error('Agent package descriptor is not canonical')
  }
  return descriptor
}

function parseCanonicalRegistry(bytes: Buffer) {
  const registry = agentReleaseKeyRegistrySchema.parse(
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    )
  )
  if (
    !canonicalAgentReleaseKeyRegistryBytes(registry).equals(bytes)
  ) {
    throw new Error('Agent package key registry is not canonical')
  }
  return registry
}

function verifyDescriptorSignature(
  descriptor: AgentPackageDescriptor,
  descriptorBytes: Buffer,
  signatureText: Buffer,
  registry: AgentReleaseKeyRegistry,
  verificationEnvironment: AgentVerificationEnvironment
): void {
  const key = registry.keys.find(
    (candidate) =>
      candidate.keyId === descriptor.signingKeyId &&
      (
        verificationEnvironment === 'test' ||
        candidate.environment === 'production'
      )
  )
  if (
    !key ||
    registry.revocations.some(
      (revocation) => revocation.keyId === key.keyId
    )
  ) {
    throw new Error('Agent package signing key is not trusted')
  }
  const signature = Buffer.from(
    signatureText.toString('utf8').trim(),
    'base64'
  )
  const publicKey = createPublicKey({
    key: Buffer.from(key.publicKeySpkiBase64, 'base64'),
    format: 'der',
    type: 'spki'
  })
  if (
    signature.length !== 64 ||
    !verify(
      null,
      Buffer.concat([SIGNATURE_DOMAIN, descriptorBytes]),
      publicKey,
      signature
    )
  ) {
    throw new Error('Agent package signature verification failed')
  }
}

function descriptorContentDigest(
  descriptor: AgentPackageDescriptor
): string {
  const { contentDigest: _contentDigest, ...content } = descriptor
  void _contentDigest
  return `sha256:${createHash('sha256')
    .update(canonicalJson(content))
    .digest('hex')}`
}

async function verifyDeclaredFiles(
  rootDirectory: string,
  descriptor: AgentPackageDescriptor
): Promise<void> {
  const declared = new Set(descriptor.files.map((file) => file.path))
  const actual = await listRegularFiles(rootDirectory)
  const expected = new Set([
    ...declared,
    DESCRIPTOR_NAME,
    SIGNATURE_NAME
  ])
  if (
    actual.length !== expected.size ||
    actual.some((path) => !expected.has(path))
  ) {
    throw new Error('Agent package contains undeclared or missing files')
  }
  for (const file of descriptor.files) {
    const filePath = join(
      rootDirectory,
      ...file.path.split('/')
    )
    const status = await lstat(filePath)
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.size !== file.size ||
      (await sha256File(filePath)) !== file.sha256
    ) {
      throw new Error(
        `Agent package payload verification failed: ${file.path}`
      )
    }
    await chmod(filePath, file.mode === '0755' ? 0o755 : 0o644)
  }
  await Promise.all([
    chmod(join(rootDirectory, DESCRIPTOR_NAME), 0o644),
    chmod(join(rootDirectory, SIGNATURE_NAME), 0o644)
  ])
}

async function listRegularFiles(directory: string): Promise<string[]> {
  const output: string[] = []
  const visit = async (current: string): Promise<void> => {
    const status = await lstat(current)
    if (status.isSymbolicLink()) {
      throw new Error('Agent package contains a symbolic link')
    }
    if (status.isFile()) {
      output.push(relative(directory, current).split(sep).join('/'))
      return
    }
    if (!status.isDirectory()) {
      throw new Error('Agent package contains an unsupported entry')
    }
    const entries = await readdir(current)
    await Promise.all(
      entries.map((entry) => visit(join(current, entry)))
    )
  }
  await visit(directory)
  return output.sort()
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const handle = await open(filePath, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length
      )
      if (bytesRead === 0) {
        break
      }
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

function parseSemanticVersion(
  value: string
): [bigint, bigint, bigint, string[] | undefined] {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/u
      .exec(value)
  const prerelease = match?.[4]?.split('.')
  if (
    !match ||
    prerelease?.some(
      (part) =>
        part.length === 0 ||
        (
          /^\d+$/u.test(part) &&
          !/^(?:0|[1-9]\d*)$/u.test(part)
        )
    )
  ) {
    throw new Error(`Invalid semantic version: ${value}`)
  }
  return [
    BigInt(match[1]!),
    BigInt(match[2]!),
    BigInt(match[3]!),
    prerelease
  ]
}

export function compareSemanticVersions(
  left: string,
  right: string
): number {
  const leftParts = parseSemanticVersion(left)
  const rightParts = parseSemanticVersion(right)
  for (const index of [0, 1, 2] as const) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1
    }
  }
  const leftPrerelease = leftParts[3]
  const rightPrerelease = rightParts[3]
  if (
    leftPrerelease === undefined &&
    rightPrerelease === undefined
  ) {
    return 0
  }
  if (leftPrerelease === undefined) {
    return 1
  }
  if (rightPrerelease === undefined) {
    return -1
  }
  for (
    let index = 0;
    index < Math.max(
      leftPrerelease.length,
      rightPrerelease.length
    );
    index += 1
  ) {
    const leftIdentifier = leftPrerelease[index]
    const rightIdentifier = rightPrerelease[index]
    if (leftIdentifier === undefined) {
      return -1
    }
    if (rightIdentifier === undefined) {
      return 1
    }
    if (leftIdentifier === rightIdentifier) {
      continue
    }
    const leftNumeric = /^\d+$/u.test(leftIdentifier)
    const rightNumeric = /^\d+$/u.test(rightIdentifier)
    if (leftNumeric && rightNumeric) {
      return BigInt(leftIdentifier) > BigInt(rightIdentifier)
        ? 1
        : -1
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1
    }
    return leftIdentifier > rightIdentifier ? 1 : -1
  }
  return 0
}