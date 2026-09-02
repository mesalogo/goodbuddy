import {
  createHash,
  createPublicKey,
  verify
} from 'node:crypto'
import { createReadStream, lstatSync } from 'node:fs'
import {
  lstat,
  open,
  readFile,
  readdir
} from 'node:fs/promises'
import {
  basename,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep
} from 'node:path'
import {
  agentReleaseKeyRegistrySchema,
  type AgentArchitecture,
  type AgentReleaseKey,
  type AgentReleaseKeyRegistry
} from '../agent-installation-contracts'
import {
  digestRemoteRuntimeBundleIdentity,
  digestRemoteRuntimeBundleManifest,
  remoteRuntimeBundleManifestSchema,
  remoteRuntimeLockSchema,
  type RemoteRuntimeBundleManifest,
  type RemoteRuntimeLock
} from '../remote-runtime-launch-contracts'
import {
  runtimeRegistryEntrySchema,
  type RuntimeRegistryEntry
} from '../remote-environment-registry-contracts'

export type InstalledBundleVerificationEnvironment =
  | 'production'
  | 'test'

const SIGNATURE_DOMAIN = Buffer.from(
  'GoodBuddy Remote Runtime Bundle Manifest Signature v1\0',
  'utf8'
)
const MANIFEST_FILE_NAME = 'manifest.json'
const SIGNATURE_FILE_NAME = 'manifest.sig'
const MAXIMUM_METADATA_BYTES = 1024 * 1024

export type VerifiedRuntimeBundle = {
  bundleDirectory: string
  executablePath: string
  manifest: RemoteRuntimeBundleManifest
  manifestDigest: string
}

export type VerifyRuntimeBundleOptions = {
  architecture: AgentArchitecture
  releaseKeyRegistry: AgentReleaseKeyRegistry
  runtimeLock: RemoteRuntimeLock
  verificationEnvironment?: InstalledBundleVerificationEnvironment
  enforceFilesystemMode?: boolean
  filesystemPlatform?: NodeJS.Platform
  uid?: number
}

export type LoadRegisteredRuntimeBundleOptions =
  VerifyRuntimeBundleOptions & {
    registered: RuntimeRegistryEntry
  }

export async function verifyRuntimeBundle(
  bundleDirectoryInput: string,
  options: VerifyRuntimeBundleOptions
): Promise<VerifiedRuntimeBundle> {
  const verified = await verifyPublishedRuntimeBundle(
    bundleDirectoryInput,
    options
  )
  const { bundleDirectory, manifest } = verified
  const inventory = await inventoryBundleFiles(
    bundleDirectory,
    options.uid
  )
  const declaredPaths = new Set(
    manifest.files.map((file) => file.path)
  )
  for (const file of manifest.files) {
    const filePath = join(
      bundleDirectory,
      ...file.path.split('/')
    )
    const stat = inventory.get(file.path)
    if (stat === undefined) {
      throw new Error(`Runtime payload is missing: ${file.path}`)
    }
    if (stat.size !== file.size) {
      throw new Error(`Runtime payload size mismatch: ${file.path}`)
    }
    if ((await sha256File(filePath)) !== file.sha256) {
      throw new Error(`Runtime payload hash mismatch: ${file.path}`)
    }
    if (
      shouldEnforceMode(options) &&
      modeString(stat.mode) !== file.mode
    ) {
      throw new Error(`Runtime payload mode mismatch: ${file.path}`)
    }
  }

  const actualPaths = new Set(inventory.keys())
  const expectedPaths = new Set([
    ...declaredPaths,
    MANIFEST_FILE_NAME,
    SIGNATURE_FILE_NAME
  ])
  if (
    actualPaths.size !== expectedPaths.size ||
    [...actualPaths].some((path) => !expectedPaths.has(path))
  ) {
    throw new Error(
      'Runtime bundle contains undeclared or missing files'
    )
  }

  return verified
}

/**
 * Authenticates a package-installer-published Runtime from signed metadata and
 * bounded entrypoint metadata. The installer already hashed every payload
 * file while extracting it.
 */
export async function verifyPublishedRuntimeBundle(
  bundleDirectoryInput: string,
  options: VerifyRuntimeBundleOptions
): Promise<VerifiedRuntimeBundle> {
  const bundleDirectory = assertAbsoluteManagedPath(
    resolve(bundleDirectoryInput)
  )
  const registry = parseReleaseKeyRegistry(
    options.releaseKeyRegistry
  )
  const runtimeLock = remoteRuntimeLockSchema.parse(options.runtimeLock)
  const verificationEnvironment =
    options.verificationEnvironment ?? 'production'
  assertRegistryAvailable(registry, verificationEnvironment)

  const rootStat = await lstat(bundleDirectory)
  assertOwnedDirectory(rootStat, 'Runtime bundle directory', options.uid)
  if (
    shouldEnforceMode(options) &&
    modeString(rootStat.mode) !== '0700'
  ) {
    throw new Error('Runtime bundle directory permissions must be 0700')
  }

  const manifestBytes = await readMetadataFile(
    join(bundleDirectory, MANIFEST_FILE_NAME),
    'Runtime manifest',
    options
  )
  const signatureBytes = await readSignature(
    join(bundleDirectory, SIGNATURE_FILE_NAME),
    options
  )
  const manifest = await verifyRuntimeManifestSignature(
    manifestBytes,
    signatureBytes,
    registry,
    verificationEnvironment
  )
  assertRuntimeManifestMatchesLock(
    manifest,
    runtimeLock,
    options.architecture
  )
  if (
    basename(bundleDirectory) !==
    manifest.bundleDigest.slice('sha256:'.length)
  ) {
    throw new Error(
      'Runtime bundle digest does not match its managed directory'
    )
  }

  const executableRecord = manifest.files.find(
    (file) => file.path === manifest.entrypoint.path
  )
  if (executableRecord === undefined) {
    throw new Error(
      'Published Runtime entrypoint is not declared'
    )
  }
  const executablePath = join(
    bundleDirectory,
    ...manifest.entrypoint.path.split('/')
  )
  const executableStat = await lstat(executablePath)
  assertOwnedRegularFile(
    executableStat,
    'Runtime executable',
    options.uid
  )
  if (
    executableStat.size !== executableRecord.size ||
    (
      shouldEnforceMode(options) &&
      modeString(executableStat.mode) !== executableRecord.mode
    )
  ) {
    throw new Error(
      'Published Runtime entrypoint metadata changed'
    )
  }
  await assertElfArchitecture(
    executablePath,
    options.architecture,
    'Runtime executable'
  )
  return {
    bundleDirectory,
    executablePath,
    manifest,
    manifestDigest:
      await digestRemoteRuntimeBundleManifest(manifest)
  }
}

/**
 * Reconstructs a Runtime identity that was fully verified when it was
 * registered. Normal capabilities and prompt launches use this bounded
 * metadata path instead of re-verifying or executing the Runtime binary.
 */
export async function loadRegisteredRuntimeBundle(
  bundleDirectoryInput: string,
  options: LoadRegisteredRuntimeBundleOptions
): Promise<VerifiedRuntimeBundle> {
  const registered = runtimeRegistryEntrySchema.parse(
    options.registered
  )
  const bundleDirectory = assertAbsoluteManagedPath(
    resolve(bundleDirectoryInput)
  )
  const rootStat = await lstat(bundleDirectory)
  assertOwnedDirectory(
    rootStat,
    'Runtime bundle directory',
    options.uid
  )
  if (
    shouldEnforceMode(options) &&
    modeString(rootStat.mode) !== '0700'
  ) {
    throw new Error('Runtime bundle directory permissions must be 0700')
  }
  const manifestBytes = await readMetadataFile(
    join(bundleDirectory, MANIFEST_FILE_NAME),
    'Runtime manifest',
    options
  )
  let value: unknown
  try {
    value = JSON.parse(manifestBytes.toString('utf8'))
  } catch (error) {
    throw new Error('Runtime manifest is invalid JSON', {
      cause: error
    })
  }
  const manifest = remoteRuntimeBundleManifestSchema.parse(value)
  if (!canonicalRuntimeManifestBytes(manifest).equals(manifestBytes)) {
    throw new Error(
      'Runtime manifest is not in canonical deterministic form'
    )
  }
  assertRuntimeManifestMatchesLock(
    manifest,
    remoteRuntimeLockSchema.parse(options.runtimeLock),
    options.architecture
  )
  const manifestDigest =
    await digestRemoteRuntimeBundleManifest(manifest)
  if (
    basename(bundleDirectory) !==
      registered.bundleDigest.slice('sha256:'.length) ||
    manifest.runtimeId !== registered.runtimeId ||
    manifest.runtimeVersion !== registered.runtimeVersion ||
    manifest.architecture !== registered.architecture ||
    manifest.bundleDigest !== registered.bundleDigest ||
    manifestDigest !== registered.manifestDigest ||
    (
      registered.runtimeAdapterDigest !== undefined &&
      manifest.adapterDigest !== registered.runtimeAdapterDigest
    ) ||
    manifest.acpCapabilitiesDigest !==
      registered.acpCapabilitiesDigest
  ) {
    throw new Error(
      'Runtime manifest does not match its registered identity'
    )
  }

  return {
    bundleDirectory,
    executablePath: join(
      bundleDirectory,
      ...manifest.entrypoint.path.split('/')
    ),
    manifest,
    manifestDigest
  }
}

export function canonicalRuntimeManifestBytes(
  manifest: RemoteRuntimeBundleManifest
): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

export function runtimeManifestSignaturePayload(
  manifestBytes: Uint8Array
): Buffer {
  return Buffer.concat([
    SIGNATURE_DOMAIN,
    Buffer.from(manifestBytes)
  ])
}

export async function verifyRuntimeManifestSignature(
  manifestBytes: Buffer,
  signatureBytes: Buffer,
  registryInput: AgentReleaseKeyRegistry,
  verificationEnvironment: InstalledBundleVerificationEnvironment =
    'production'
): Promise<RemoteRuntimeBundleManifest> {
  const registry = parseReleaseKeyRegistry(registryInput)
  assertRegistryAvailable(registry, verificationEnvironment)
  let untrusted: unknown
  try {
    untrusted = JSON.parse(manifestBytes.toString('utf8'))
  } catch (error) {
    throw new Error('Runtime manifest JSON is invalid', { cause: error })
  }
  const parsed = remoteRuntimeBundleManifestSchema.safeParse(untrusted)
  if (!parsed.success) {
    throw new Error(
      `Runtime manifest contract is invalid: ${parsed.error.message}`
    )
  }
  const manifest = parsed.data
  if (!canonicalRuntimeManifestBytes(manifest).equals(manifestBytes)) {
    throw new Error(
      'Runtime manifest is not in canonical deterministic form'
    )
  }
  const key = trustedKeyForManifest(
    manifest,
    registry,
    verificationEnvironment
  )
  const publicKey = importPublicKey(key)
  if (
    signatureBytes.length !== 64 ||
    !verify(
      null,
      runtimeManifestSignaturePayload(manifestBytes),
      publicKey,
      signatureBytes
    )
  ) {
    throw new Error('Runtime manifest signature verification failed')
  }
  if (
    await digestRemoteRuntimeBundleIdentity(manifest) !==
    manifest.bundleDigest
  ) {
    throw new Error('Runtime bundle identity digest does not match')
  }
  return manifest
}

export async function readRemoteRuntimeLock(
  filePathInput: string,
  options: {
    uid?: number
    filesystemPlatform?: NodeJS.Platform
  } = {}
): Promise<RemoteRuntimeLock> {
  const filePath = assertAbsoluteManagedPath(resolve(filePathInput))
  const contents = await readMetadataFile(
    filePath,
    'Remote Runtime lock',
    options
  )
  let value: unknown
  try {
    value = JSON.parse(contents.toString('utf8'))
  } catch (error) {
    throw new Error('Remote Runtime lock is invalid JSON', {
      cause: error
    })
  }
  return remoteRuntimeLockSchema.parse(value)
}

export function assertRuntimeManifestMatchesLock(
  manifest: RemoteRuntimeBundleManifest,
  lock: RemoteRuntimeLock,
  architecture: AgentArchitecture
): void {
  const expected = lock.runtimes.opencode
  const target = expected.targets[architecture]
  if (
    manifest.runtimeId !== 'opencode' ||
    manifest.provider !== expected.provider ||
    manifest.runtimeVersion !== expected.version ||
    manifest.architecture !== architecture ||
    manifest.entrypoint.path !== expected.entrypoint ||
    manifest.entrypoint.identity !== expected.entrypointIdentity ||
    manifest.entrypoint.argvPrefix.length !==
      expected.argvPrefix.length ||
    manifest.entrypoint.argvPrefix.some(
      (argument, index) => argument !== expected.argvPrefix[index]
    ) ||
    manifest.protocol.major !== expected.protocol.major ||
    manifest.protocol.minor !== expected.protocol.minor ||
    manifest.allowedEnvironmentNames.length !==
      expected.allowedEnvironmentNames.length ||
    manifest.allowedEnvironmentNames.some(
      (name, index) =>
        name !== expected.allowedEnvironmentNames[index]
    ) ||
    manifest.sourcePackage.name !== target.package ||
    manifest.sourcePackage.integrity !== target.integrity
  ) {
    throw new Error(
      'Runtime manifest does not match the locked OpenCode profile'
    )
  }
}

function parseReleaseKeyRegistry(
  value: unknown
): AgentReleaseKeyRegistry {
  const parsed = agentReleaseKeyRegistrySchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(
      `Runtime trusted key registry contract is invalid: ${parsed.error.message}`
    )
  }
  for (const key of parsed.data.keys) {
    importPublicKey(key)
  }
  return parsed.data
}

function assertRegistryAvailable(
  registry: AgentReleaseKeyRegistry,
  environment: InstalledBundleVerificationEnvironment
): void {
  if (
    environment === 'production' &&
    !registry.keys.some((key) => key.environment === 'production')
  ) {
    throw new Error(
      'Runtime production key registry is empty; verification is unavailable'
    )
  }
}

function trustedKeyForManifest(
  manifest: RemoteRuntimeBundleManifest,
  registry: AgentReleaseKeyRegistry,
  environment: InstalledBundleVerificationEnvironment
): AgentReleaseKey {
  const key = registry.keys.find(
    (candidate) => candidate.keyId === manifest.signingKeyId
  )
  if (key === undefined) {
    throw new Error(
      `Runtime manifest uses an unknown signing key: ${manifest.signingKeyId}`
    )
  }
  if (environment === 'production' && key.environment !== 'production') {
    throw new Error(
      `Production Runtime verification rejects non-production key: ${key.keyId}`
    )
  }
  if (
    registry.revocations.some(
      (revocation) => revocation.keyId === key.keyId
    )
  ) {
    throw new Error(`Runtime signing key is revoked: ${key.keyId}`)
  }
  return key
}

function importPublicKey(key: AgentReleaseKey) {
  let publicKey
  try {
    publicKey = createPublicKey({
      key: Buffer.from(key.publicKeySpkiBase64, 'base64'),
      format: 'der',
      type: 'spki'
    })
  } catch (error) {
    throw new Error(
      `Runtime trusted public key is invalid: ${key.keyId}`,
      { cause: error }
    )
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `Runtime trusted public key is not Ed25519: ${key.keyId}`
    )
  }
  return publicKey
}

async function readMetadataFile(
  filePath: string,
  label: string,
  options: {
    enforceFilesystemMode?: boolean
    filesystemPlatform?: NodeJS.Platform
    uid?: number
  }
): Promise<Buffer> {
  const stat = await lstat(filePath)
  assertOwnedRegularFile(stat, label, options.uid)
  if (
    shouldEnforceMode(options) &&
    modeString(stat.mode) !== '0644' &&
    modeString(stat.mode) !== '0600'
  ) {
    throw new Error(`${label} permissions must be 0600 or 0644`)
  }
  if (stat.size > MAXIMUM_METADATA_BYTES) {
    throw new Error(`${label} exceeds its size limit`)
  }
  return readFile(filePath)
}

async function readSignature(
  filePath: string,
  options: VerifyRuntimeBundleOptions
): Promise<Buffer> {
  const contents = await readMetadataFile(
    filePath,
    'Runtime detached signature',
    options
  )
  const text = contents.toString('utf8')
  if (!/^[A-Za-z0-9+/]{86}==\n$/u.test(text)) {
    throw new Error('Runtime detached signature encoding is invalid')
  }
  return Buffer.from(text.trim(), 'base64')
}

async function inventoryBundleFiles(
  bundleDirectory: string,
  uid = process.getuid?.()
): Promise<Map<string, Awaited<ReturnType<typeof lstat>>>> {
  const files = new Map<
    string,
    Awaited<ReturnType<typeof lstat>>
  >()
  const pending = [bundleDirectory]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) {
      continue
    }
    for (const entry of await readdir(current, {
      withFileTypes: true
    })) {
      const absolutePath = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Runtime bundle cannot contain a symlink: ${absolutePath}`
        )
      }
      const stat = await lstat(absolutePath)
      if (entry.isDirectory()) {
        assertOwnedDirectory(
          stat,
          absolutePath,
          uid
        )
        pending.push(absolutePath)
      } else if (entry.isFile()) {
        assertOwnedRegularFile(
          stat,
          absolutePath,
          uid
        )
        files.set(
          relative(bundleDirectory, absolutePath)
            .split(sep)
            .join('/'),
          stat
        )
      } else {
        throw new Error(
          `Runtime bundle contains an unsupported file: ${absolutePath}`
        )
      }
    }
  }
  return files
}

function assertOwnedDirectory(
  stat: Awaited<ReturnType<typeof lstat>>,
  label: string,
  uid = process.getuid?.()
): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory`)
  }
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${label} is not owned by the current user`)
  }
}

function assertOwnedRegularFile(
  stat: Awaited<ReturnType<typeof lstat>>,
  label: string,
  uid = process.getuid?.()
): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file`)
  }
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${label} is not owned by the current user`)
  }
}

function shouldEnforceMode(options: {
  enforceFilesystemMode?: boolean
  filesystemPlatform?: NodeJS.Platform
}): boolean {
  return (
    options.enforceFilesystemMode !== false &&
    (options.filesystemPlatform ?? process.platform) !== 'win32'
  )
}

function modeString(mode: number | bigint): string {
  return (Number(mode) & 0o777).toString(8).padStart(4, '0')
}

function assertAbsoluteManagedPath(path: string): string {
  if (
    path.includes('\0') ||
    !isAbsolute(path) ||
    resolve(path) !== path
  ) {
    throw new Error('Managed paths must be normalized absolute paths')
  }
  const root = parse(path).root
  const components = relative(root, path).split(sep).filter(Boolean)
  let current = root
  for (const component of components) {
    current = resolve(current, component)
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error('Managed paths cannot traverse a symlink')
      }
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return path
      }
      throw error
    }
  }
  return path
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

async function assertElfArchitecture(
  filePath: string,
  expected: AgentArchitecture,
  label: string
): Promise<void> {
  const handle = await open(filePath, 'r')
  try {
    const header = Buffer.alloc(64)
    const { bytesRead } = await handle.read(
      header,
      0,
      header.length,
      0
    )
    const actual = detectElfArchitecture(
      header.subarray(0, bytesRead)
    )
    if (actual !== expected) {
      throw new Error(
        `${label} architecture mismatch: expected ${expected}, received ${actual ?? 'unknown'}`
      )
    }
  } finally {
    await handle.close()
  }
}

function detectElfArchitecture(
  header: Buffer
): AgentArchitecture | undefined {
  if (
    header.length < 20 ||
    header[0] !== 0x7f ||
    header.toString('ascii', 1, 4) !== 'ELF' ||
    (header[5] !== 1 && header[5] !== 2)
  ) {
    return undefined
  }
  const machine =
    header[5] === 2
      ? header.readUInt16BE(18)
      : header.readUInt16LE(18)
  return machine === 62
    ? 'x64'
    : machine === 183
      ? 'arm64'
      : undefined
}
