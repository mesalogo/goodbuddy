import {
  createHash,
  createPublicKey,
  verify
} from 'node:crypto'
import {
  lstat,
  readFile,
  readdir
} from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import {
  agentBundleManifestSchema,
  agentReleaseKeyRegistrySchema,
  type AgentArchitecture,
  type AgentBundleManifest,
  type AgentReleaseKey,
  type AgentReleaseKeyRegistry
} from '../shared/agent-installation-contracts'
import {
  installationRegistryEntrySchema,
  type InstallationRegistryEntry
} from '../shared/remote-environment-registry-contracts'
import { assertAbsoluteManagedPath } from './managed-paths'
import {
  assertElfArchitecture,
  sha256File
} from './bundle-file-verification'

const SIGNATURE_DOMAIN = Buffer.from(
  'GoodBuddy Agent Bundle Manifest Signature v1\0',
  'utf8'
)
const MAXIMUM_METADATA_BYTES = 1024 * 1024
const MANIFEST_FILE_NAME = 'manifest.json'
const SIGNATURE_FILE_NAME = 'manifest.sig'
const installationIdPattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9])?$/u

export type InstalledBundleVerificationEnvironment =
  | 'production'
  | 'test'

export type VerifiedInstalledAgentBundle = {
  installationId: string
  installationDirectory: string
  executablePath: string
  manifest: AgentBundleManifest
  manifestSha256: string
  binaryDigest: string
}

export type VerifyInstalledAgentBundleOptions = {
  installationId: string
  architecture: AgentArchitecture
  releaseKeyRegistry: AgentReleaseKeyRegistry
  verificationEnvironment?: InstalledBundleVerificationEnvironment
  enforceFilesystemMode?: boolean
  filesystemPlatform?: NodeJS.Platform
  uid?: number
}

export type LoadRegisteredAgentBundleOptions = {
  installationId: string
  architecture: AgentArchitecture
  registered: InstallationRegistryEntry
  enforceFilesystemMode?: boolean
  filesystemPlatform?: NodeJS.Platform
  uid?: number
}

export class RegisteredAgentBundleError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'RegisteredAgentBundleError'
  }
}

export async function readManagedAgentReleaseKeyRegistry(
  filePath: string,
  options: { uid?: number; filesystemPlatform?: NodeJS.Platform } = {}
): Promise<AgentReleaseKeyRegistry> {
  const normalizedPath = assertAbsoluteManagedPath(resolve(filePath))
  const stat = await lstat(normalizedPath)
  assertOwnedRegularFile(stat, normalizedPath, options.uid)
  if (
    shouldEnforceMode(options) &&
    modeString(stat.mode) !== '0600'
  ) {
    throw new Error(
      'Managed Agent release-key registry permissions must be 0600'
    )
  }
  if (stat.size > MAXIMUM_METADATA_BYTES) {
    throw new Error('Managed Agent release-key registry exceeds its size limit')
  }
  let value: unknown
  try {
    value = JSON.parse(
      (await readFile(normalizedPath)).toString('utf8')
    )
  } catch (error) {
    throw new Error('Managed Agent release-key registry is invalid JSON', {
      cause: error
    })
  }
  return parseReleaseKeyRegistry(value)
}

export async function verifyInstalledAgentBundle(
  installationDirectoryInput: string,
  options: VerifyInstalledAgentBundleOptions
): Promise<VerifiedInstalledAgentBundle> {
  const installationId = validateInstallationId(options.installationId)
  const installationDirectory = resolve(installationDirectoryInput)
  assertAbsoluteManagedPath(installationDirectory)
  if (basename(installationDirectory) !== installationId) {
    throw new Error(
      'Agent installation ID does not match its managed directory'
    )
  }
  const releaseKeyRegistry = parseReleaseKeyRegistry(
    options.releaseKeyRegistry
  )
  const verificationEnvironment =
    options.verificationEnvironment ?? 'production'
  assertRegistryAvailable(releaseKeyRegistry, verificationEnvironment)

  const rootStat = await lstat(installationDirectory)
  assertOwnedDirectory(
    rootStat,
    'Agent installation directory',
    options.uid
  )
  if (
    shouldEnforceMode(options) &&
    modeString(rootStat.mode) !== '0700'
  ) {
    throw new Error(
      'Agent installation directory permissions must be 0700'
    )
  }

  const manifestBytes = await readMetadataFile(
    join(installationDirectory, MANIFEST_FILE_NAME),
    'Agent manifest',
    options
  )
  const signatureBytes = await readSignature(
    join(installationDirectory, SIGNATURE_FILE_NAME),
    options
  )
  const manifest = verifyInstalledAgentManifestSignature(
    manifestBytes,
    signatureBytes,
    releaseKeyRegistry,
    verificationEnvironment
  )
  if (manifest.arch !== options.architecture) {
    throw new Error(
      'Agent manifest architecture does not match the current host'
    )
  }

  const declaredPaths = new Set(
    manifest.files.map((file) => file.path)
  )
  for (const file of manifest.files) {
    const filePath = join(
      installationDirectory,
      ...file.path.split('/')
    )
    const stat = await lstat(filePath)
    assertOwnedRegularFile(stat, file.path, options.uid)
    if (stat.size !== file.size) {
      throw new Error(`Agent payload size mismatch: ${file.path}`)
    }
    if ((await sha256File(filePath)) !== file.sha256) {
      throw new Error(`Agent payload hash mismatch: ${file.path}`)
    }
    if (
      shouldEnforceMode(options) &&
      modeString(stat.mode) !== file.mode
    ) {
      throw new Error(`Agent payload mode mismatch: ${file.path}`)
    }
  }

  const actualPaths = new Set(
    await listInstallationFiles(installationDirectory, options)
  )
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
      'Agent installation contains undeclared or missing files'
    )
  }

  await assertElfArchitecture(
    join(installationDirectory, manifest.entrypoint.runtimePath),
    manifest.arch,
    'Agent Node runtime'
  )
  const manifestSha256 = sha256Bytes(manifestBytes)
  return {
    installationId,
    installationDirectory,
    executablePath: join(
      installationDirectory,
      manifest.entrypoint.path
    ),
    manifest,
    manifestSha256,
    binaryDigest: `sha256:${manifestSha256}`
  }
}

/**
 * Reconstructs the identity previously verified and committed by Host
 * management. Normal attach/bootstrap uses this bounded metadata path instead
 * of rehashing the complete installation on every project switch.
 */
export async function loadRegisteredAgentBundle(
  installationDirectoryInput: string,
  options: LoadRegisteredAgentBundleOptions
): Promise<VerifiedInstalledAgentBundle> {
  try {
    return await loadRegisteredAgentBundleUnchecked(
      installationDirectoryInput,
      options
    )
  } catch (error) {
    if (error instanceof RegisteredAgentBundleError) {
      throw error
    }
    throw new RegisteredAgentBundleError(
      error instanceof Error
        ? error.message
        : 'Registered Agent installation is invalid',
      error
    )
  }
}

async function loadRegisteredAgentBundleUnchecked(
  installationDirectoryInput: string,
  options: LoadRegisteredAgentBundleOptions
): Promise<VerifiedInstalledAgentBundle> {
  const installationId = validateInstallationId(options.installationId)
  const installationDirectory = resolve(installationDirectoryInput)
  assertAbsoluteManagedPath(installationDirectory)
  if (basename(installationDirectory) !== installationId) {
    throw new Error(
      'Agent installation ID does not match its managed directory'
    )
  }
  const registered = installationRegistryEntrySchema.parse(
    options.registered
  )
  if (
    registered.installationId !== installationId ||
    registered.arch !== options.architecture
  ) {
    throw new Error(
      'Registered Agent identity does not match the current installation'
    )
  }

  const rootStat = await lstat(installationDirectory)
  assertOwnedDirectory(
    rootStat,
    'Agent installation directory',
    options.uid
  )
  if (
    shouldEnforceMode(options) &&
    modeString(rootStat.mode) !== '0700'
  ) {
    throw new Error(
      'Agent installation directory permissions must be 0700'
    )
  }

  const manifestBytes = await readMetadataFile(
    join(installationDirectory, MANIFEST_FILE_NAME),
    'Agent manifest',
    options
  )
  if (sha256Bytes(manifestBytes) !== registered.manifestSha256) {
    throw new Error(
      'Agent manifest does not match the Host-managed registry'
    )
  }
  let untrusted: unknown
  try {
    untrusted = JSON.parse(manifestBytes.toString('utf8'))
  } catch (error) {
    throw new Error('Agent manifest JSON is invalid', { cause: error })
  }
  const manifest = agentBundleManifestSchema.parse(untrusted)
  if (
    !canonicalInstalledAgentManifestBytes(manifest).equals(
      manifestBytes
    ) ||
    manifest.agentVersion !== registered.agentVersion ||
    manifest.arch !== registered.arch ||
    (
      registered.protocol !== undefined &&
      (
        manifest.protocol.major !==
          registered.protocol.major ||
        manifest.protocol.minor !==
          registered.protocol.minor
      )
    )
  ) {
    throw new Error(
      'Agent manifest does not match the Host-managed registry'
    )
  }

  const executablePath = join(
    installationDirectory,
    manifest.entrypoint.path
  )
  await assertRegisteredEntrypoint(executablePath, '0755', options)
  await assertRegisteredEntrypoint(
    join(installationDirectory, manifest.entrypoint.runtimePath),
    '0755',
    options
  )
  await assertRegisteredEntrypoint(
    join(installationDirectory, manifest.entrypoint.scriptPath),
    '0644',
    options
  )
  return {
    installationId,
    installationDirectory,
    executablePath,
    manifest,
    manifestSha256: registered.manifestSha256,
    binaryDigest: `sha256:${registered.manifestSha256}`
  }
}

export function canonicalInstalledAgentManifestBytes(
  manifest: AgentBundleManifest
): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

export function installedAgentManifestSignaturePayload(
  manifestBytes: Uint8Array
): Buffer {
  return Buffer.concat([
    SIGNATURE_DOMAIN,
    Buffer.from(manifestBytes)
  ])
}

export function verifyInstalledAgentManifestSignature(
  manifestBytes: Buffer,
  signatureBytes: Buffer,
  registryInput: AgentReleaseKeyRegistry,
  verificationEnvironment: InstalledBundleVerificationEnvironment =
    'production'
): AgentBundleManifest {
  const registry = parseReleaseKeyRegistry(registryInput)
  assertRegistryAvailable(registry, verificationEnvironment)
  let untrusted: unknown
  try {
    untrusted = JSON.parse(manifestBytes.toString('utf8'))
  } catch (error) {
    throw new Error('Agent manifest JSON is invalid', { cause: error })
  }
  const parsed = agentBundleManifestSchema.safeParse(untrusted)
  if (!parsed.success) {
    throw new Error(
      `Agent manifest contract is invalid: ${parsed.error.message}`
    )
  }
  const manifest = parsed.data
  if (
    !canonicalInstalledAgentManifestBytes(manifest).equals(manifestBytes)
  ) {
    throw new Error(
      'Agent manifest is not in canonical deterministic form'
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
      installedAgentManifestSignaturePayload(manifestBytes),
      publicKey,
      signatureBytes
    )
  ) {
    throw new Error('Agent manifest signature verification failed')
  }
  return manifest
}

function validateInstallationId(value: string): string {
  if (value.length > 128 || !installationIdPattern.test(value)) {
    throw new Error('Invalid Agent installation ID')
  }
  return value
}

function parseReleaseKeyRegistry(
  value: unknown
): AgentReleaseKeyRegistry {
  const parsed = agentReleaseKeyRegistrySchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(
      `Agent trusted key registry contract is invalid: ${parsed.error.message}`
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
      'Agent production key registry is empty; installed Agent verification is unavailable'
    )
  }
}

function trustedKeyForManifest(
  manifest: AgentBundleManifest,
  registry: AgentReleaseKeyRegistry,
  environment: InstalledBundleVerificationEnvironment
): AgentReleaseKey {
  const key = registry.keys.find(
    (candidate) => candidate.keyId === manifest.signingKeyId
  )
  if (key === undefined) {
    throw new Error(
      `Agent manifest uses an unknown signing key: ${manifest.signingKeyId}`
    )
  }
  if (environment === 'production' && key.environment !== 'production') {
    throw new Error(
      `Production Agent verification rejects non-production key: ${key.keyId}`
    )
  }
  if (
    registry.revocations.some(
      (revocation) => revocation.keyId === key.keyId
    )
  ) {
    throw new Error(`Agent signing key is revoked: ${key.keyId}`)
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
    throw new Error(`Agent trusted public key is invalid: ${key.keyId}`, {
      cause: error
    })
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `Agent trusted public key is not Ed25519: ${key.keyId}`
    )
  }
  return publicKey
}

async function assertRegisteredEntrypoint(
  filePath: string,
  expectedMode: string,
  options: Pick<
    LoadRegisteredAgentBundleOptions,
    'uid' | 'filesystemPlatform' | 'enforceFilesystemMode'
  >
): Promise<void> {
  const stat = await lstat(filePath)
  assertOwnedRegularFile(stat, filePath, options.uid)
  if (
    shouldEnforceMode(options) &&
    modeString(stat.mode) !== expectedMode
  ) {
    throw new Error(
      `Agent payload mode mismatch: ${basename(filePath)}`
    )
  }
}

async function readMetadataFile(
  filePath: string,
  label: string,
  options: Pick<
    VerifyInstalledAgentBundleOptions,
    'uid' | 'filesystemPlatform' | 'enforceFilesystemMode'
  >
): Promise<Buffer> {
  const stat = await lstat(filePath)
  assertOwnedRegularFile(stat, label, options.uid)
  if (
    shouldEnforceMode(options) &&
    modeString(stat.mode) !== '0644'
  ) {
    throw new Error(`Agent payload mode mismatch: ${basename(filePath)}`)
  }
  if (stat.size > MAXIMUM_METADATA_BYTES) {
    throw new Error(`${label} exceeds its size limit`)
  }
  return readFile(filePath)
}

async function readSignature(
  filePath: string,
  options: Pick<
    VerifyInstalledAgentBundleOptions,
    'uid' | 'filesystemPlatform' | 'enforceFilesystemMode'
  >
): Promise<Buffer> {
  const text = (await readMetadataFile(
    filePath,
    'Agent detached signature',
    options
  )).toString('utf8')
  if (!/^[A-Za-z0-9+/]{86}==\n$/u.test(text)) {
    throw new Error('Agent detached signature encoding is invalid')
  }
  return Buffer.from(text.trim(), 'base64')
}

async function listInstallationFiles(
  installationDirectory: string,
  options: Pick<
    VerifyInstalledAgentBundleOptions,
    'uid' | 'filesystemPlatform' | 'enforceFilesystemMode'
  >
): Promise<string[]> {
  const files: string[] = []
  const pending = [installationDirectory]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) {
      continue
    }
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Agent installation cannot contain a symlink: ${absolutePath}`
        )
      }
      if (entry.isDirectory()) {
        const stat = await lstat(absolutePath)
        assertOwnedDirectory(stat, absolutePath, options.uid)
        if (
          shouldEnforceMode(options) &&
          modeString(stat.mode) !== '0700'
        ) {
          throw new Error(
            `Agent installation directory permissions must be 0700: ${absolutePath}`
          )
        }
        pending.push(absolutePath)
      } else if (entry.isFile()) {
        files.push(
          relative(installationDirectory, absolutePath)
            .split(sep)
            .join('/')
        )
      } else {
        throw new Error(
          `Agent installation contains an unsupported file: ${absolutePath}`
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

function shouldEnforceMode(
  options: {
    enforceFilesystemMode?: boolean
    filesystemPlatform?: NodeJS.Platform
  }
): boolean {
  return (
    options.enforceFilesystemMode !== false &&
    (options.filesystemPlatform ?? process.platform) !== 'win32'
  )
}

function modeString(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, '0')
}

function sha256Bytes(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}
