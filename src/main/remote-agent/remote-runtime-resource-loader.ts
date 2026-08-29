import { constants } from 'node:fs'
import {
  lstat,
  open,
  readdir
} from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import {
  verifyRuntimeBundle,
  type VerifiedRuntimeBundle,
  type VerifyRuntimeBundleOptions
} from '../../shared/node/runtime-bundle-verifier'
import {
  type AgentArchitecture,
  type AgentReleaseKeyRegistry
} from '../../shared/agent-installation-contracts'
import {
  digestRemoteRuntimeBundleManifest,
  remoteRuntimeBundleManifestSchema,
  remoteRuntimeLockSchema,
  type RemoteRuntimeBundleManifest,
  type RemoteRuntimeLock
} from '../../shared/remote-runtime-launch-contracts'
import {
  getBundledRemoteRuntimeRoot,
  type BundledRemoteRuntimeResourcePaths
} from './bundled-remote-runtime-resources'
import {
  parseAgentReleaseKeyRegistry
} from './agent-bundle-verifier'
import { isMissingPathError } from './path-errors'

const MAXIMUM_METADATA_BYTES = 1024 * 1024
const digestDirectoryPattern = /^[a-f0-9]{64}$/u

type RuntimeBundleVerifier = (
  bundleDirectory: string,
  options: VerifyRuntimeBundleOptions
) => Promise<VerifiedRuntimeBundle>

export type RemoteRuntimeResourceLoaderOptions = {
  verificationEnvironment?: 'production' | 'test'
  verifyRuntimeBundle?: RuntimeBundleVerifier
}

type CanonicalMetadata<T> = {
  bytes: Buffer
  value: T
}

export type RemoteRuntimeVerificationMetadata = {
  releaseKeyRegistry: AgentReleaseKeyRegistry
  runtimeLock: RemoteRuntimeLock
  canonicalReleaseKeyRegistryBytes: Buffer
  canonicalRemoteRuntimeLockBytes: Buffer
}

export type VerifiedRemoteRuntimeResourceBundle = {
  bundleDirectory: string
  manifest: RemoteRuntimeBundleManifest
  manifestDigest: string
  canonicalReleaseKeyRegistryBytes: Buffer
  canonicalRemoteRuntimeLockBytes: Buffer
}

export async function loadVerifiedRemoteRuntimeResourceBundle(
  paths: BundledRemoteRuntimeResourcePaths,
  architecture: AgentArchitecture,
  options: RemoteRuntimeResourceLoaderOptions = {}
): Promise<VerifiedRemoteRuntimeResourceBundle> {
  assertSafeVerificationInjection(options)
  const verificationEnvironment =
    options.verificationEnvironment ?? 'production'
  const metadata =
    await loadRemoteRuntimeVerificationMetadata(paths)
  const bundleDirectory = await resolveSingleDigestDirectory(
    getBundledRemoteRuntimeRoot(paths, architecture)
  )
  const verifier = options.verifyRuntimeBundle ?? verifyRuntimeBundle
  const verified = await verifier(bundleDirectory, {
    architecture,
    releaseKeyRegistry: metadata.releaseKeyRegistry,
    runtimeLock: metadata.runtimeLock,
    verificationEnvironment
  })

  return validateVerifiedBundle(
    verified,
    bundleDirectory,
    architecture,
    metadata.canonicalReleaseKeyRegistryBytes,
    metadata.canonicalRemoteRuntimeLockBytes
  )
}

export async function loadRemoteRuntimeVerificationMetadata(
  paths: BundledRemoteRuntimeResourcePaths
): Promise<RemoteRuntimeVerificationMetadata> {
  const [keyRegistry, runtimeLock] = await Promise.all([
    readCanonicalMetadata(
      paths.keyRegistryPath,
      { parse: parseAgentReleaseKeyRegistry },
      'Runtime release-key registry',
      true
    ),
    readCanonicalMetadata(
      paths.runtimeLockPath,
      remoteRuntimeLockSchema,
      'Remote Runtime lock'
    )
  ])
  return {
    releaseKeyRegistry: keyRegistry.value,
    runtimeLock: runtimeLock.value,
    canonicalReleaseKeyRegistryBytes: keyRegistry.bytes,
    canonicalRemoteRuntimeLockBytes: runtimeLock.bytes
  }
}

function assertSafeVerificationInjection(
  options: RemoteRuntimeResourceLoaderOptions
): void {
  if (
    options.verifyRuntimeBundle !== undefined &&
    options.verificationEnvironment !== 'test'
  ) {
    throw new Error(
      'Injected Runtime bundle verification is allowed only in test verification'
    )
  }
}

async function readCanonicalMetadata<T>(
  filePathInput: string,
  schema: { parse(value: unknown): T },
  label: string,
  acceptEquivalentJsonFormatting = false
): Promise<CanonicalMetadata<T>> {
  const filePath = resolve(filePathInput)
  const pathStat = await lstat(filePath)
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file`)
  }
  if (
    pathStat.size === 0 ||
    pathStat.size > MAXIMUM_METADATA_BYTES
  ) {
    throw new Error(`${label} exceeds its safety limit`)
  }

  const handle = await open(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  )
  let bytes: Buffer
  try {
    const openedStat = await handle.stat()
    if (
      !openedStat.isFile() ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino ||
      openedStat.size === 0 ||
      openedStat.size > MAXIMUM_METADATA_BYTES
    ) {
      throw new Error(`${label} changed while it was being opened`)
    }
    const bounded = Buffer.alloc(MAXIMUM_METADATA_BYTES + 1)
    let offset = 0
    while (offset < bounded.byteLength) {
      const { bytesRead } = await handle.read(
        bounded,
        offset,
        bounded.byteLength - offset,
        offset
      )
      if (bytesRead === 0) {
        break
      }
      offset += bytesRead
    }
    bytes = bounded.subarray(0, offset)
  } finally {
    await handle.close()
  }
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAXIMUM_METADATA_BYTES
  ) {
    throw new Error(`${label} exceeds its safety limit`)
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    )
  } catch (error) {
    throw new Error(`${label} is invalid JSON`, { cause: error })
  }
  let value: T
  try {
    value = schema.parse(parsedJson)
  } catch (error) {
    throw new Error(`${label} contract is invalid`, { cause: error })
  }
  const canonicalBytes = Buffer.from(
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8'
  )
  if (
    !acceptEquivalentJsonFormatting &&
    !canonicalBytes.equals(bytes)
  ) {
    throw new Error(`${label} is not canonical`)
  }
  return { bytes: canonicalBytes, value }
}

async function resolveSingleDigestDirectory(
  runtimeRootInput: string
): Promise<string> {
  const runtimeRoot = resolve(runtimeRootInput)
  let rootStat
  try {
    rootStat = await lstat(runtimeRoot)
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(
        'OpenCode Runtime resources are not included in this package',
        { cause: error }
      )
    }
    throw error
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('OpenCode Runtime resource root is not a real directory')
  }
  const entries = await readdir(runtimeRoot, { withFileTypes: true })
  if (entries.length !== 1) {
    throw new Error(
      'OpenCode Runtime resource root must contain exactly one digest directory'
    )
  }
  const entry = entries[0]
  if (entry === undefined || !digestDirectoryPattern.test(entry.name)) {
    throw new Error(
      'OpenCode Runtime resource directory name is not a SHA-256 digest'
    )
  }
  const bundleDirectory = join(runtimeRoot, entry.name)
  const bundleStat = await lstat(bundleDirectory)
  if (
    entry.isSymbolicLink() ||
    !bundleStat.isDirectory() ||
    bundleStat.isSymbolicLink()
  ) {
    throw new Error(
      'OpenCode Runtime digest entry is not a real directory'
    )
  }
  return bundleDirectory
}

async function validateVerifiedBundle(
  verified: VerifiedRuntimeBundle,
  bundleDirectory: string,
  architecture: AgentArchitecture,
  keyRegistryBytes: Buffer,
  runtimeLockBytes: Buffer
): Promise<VerifiedRemoteRuntimeResourceBundle> {
  const manifest = remoteRuntimeBundleManifestSchema.parse(
    verified.manifest
  )
  if (
    verified.bundleDirectory !== bundleDirectory ||
    manifest.runtimeId !== 'opencode' ||
    manifest.provider !== 'opencode' ||
    manifest.platform !== 'linux' ||
    manifest.architecture !== architecture
  ) {
    throw new Error(
      'Verified Runtime bundle does not match the requested OpenCode target'
    )
  }
  if (
    manifest.bundleDigest !==
    `sha256:${basename(bundleDirectory)}`
  ) {
    throw new Error(
      'Runtime bundle digest does not match its resource directory'
    )
  }
  if (
    verified.manifestDigest !==
    await digestRemoteRuntimeBundleManifest(manifest)
  ) {
    throw new Error('Verified Runtime manifest digest is invalid')
  }

  return {
    bundleDirectory,
    manifest,
    manifestDigest: verified.manifestDigest,
    canonicalReleaseKeyRegistryBytes: keyRegistryBytes,
    canonicalRemoteRuntimeLockBytes: runtimeLockBytes
  }
}
