import {
  createHash,
  createPublicKey,
  verify
} from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  lstat,
  open,
  readFile,
  readdir
} from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import {
  agentBundleManifestSchema,
  agentReleaseKeyRegistrySchema,
  agentRuntimeLockSchema,
  type AgentArchitecture,
  type AgentBundleManifest,
  type AgentReleaseKey,
  type AgentReleaseKeyRegistry,
  type AgentRuntimeLock
} from '../../shared/agent-installation-contracts'
import {
  getBundledAgentDirectory,
  type BundledAgentResourcePaths
} from './bundled-agent-resources'

const AGENT_MANIFEST_SIGNATURE_DOMAIN = Buffer.from(
  'GoodBuddy Agent Bundle Manifest Signature v1\0',
  'utf8'
)
const MANIFEST_FILE_NAME = 'manifest.json'
const SIGNATURE_FILE_NAME = 'manifest.sig'
const MAXIMUM_METADATA_BYTES = 1024 * 1024

export type AgentVerificationEnvironment = 'production' | 'test'

export type VerifiedAgentBundle = {
  bundleDirectory: string
  manifest: AgentBundleManifest
  manifestSha256: string
}

export type VerifyAgentBundleOptions = {
  architecture: AgentArchitecture
  registry: AgentReleaseKeyRegistry
  runtimeLock: AgentRuntimeLock
  verificationEnvironment?: AgentVerificationEnvironment
  enforceFilesystemMode?: boolean
  filesystemPlatform?: NodeJS.Platform
}

export type VerifyBundledAgentOptions = {
  verificationEnvironment?: AgentVerificationEnvironment
  enforceFilesystemMode?: boolean
  filesystemPlatform?: NodeJS.Platform
}

export async function readAgentReleaseKeyRegistry(
  filePath: string
): Promise<AgentReleaseKeyRegistry> {
  const bytes = await readBoundedFile(
    filePath,
    MAXIMUM_METADATA_BYTES,
    'Agent trusted key registry'
  )
  return parseAgentReleaseKeyRegistryBytes(
    bytes,
    'Agent trusted key registry'
  )
}

export async function readAgentRuntimeLock(
  filePath: string
): Promise<AgentRuntimeLock> {
  const value = await readJsonMetadata(filePath, 'Agent runtime lock')
  return parseContract(
    agentRuntimeLockSchema,
    value,
    'Agent runtime lock contract is invalid'
  )
}

export async function verifyBundledAgentResources(
  paths: BundledAgentResourcePaths,
  architecture: AgentArchitecture,
  options: VerifyBundledAgentOptions = {}
): Promise<VerifiedAgentBundle> {
  const [registry, runtimeLock] = await Promise.all([
    readAgentReleaseKeyRegistry(paths.keyRegistryPath),
    readAgentRuntimeLock(paths.runtimeLockPath)
  ])
  return verifyAgentBundleDirectory(
    getBundledAgentDirectory(paths, architecture),
    {
      ...options,
      architecture,
      registry,
      runtimeLock
    }
  )
}

export async function verifyAgentBundleDirectory(
  bundleDirectory: string,
  options: VerifyAgentBundleOptions
): Promise<VerifiedAgentBundle> {
  const registry = parseAgentReleaseKeyRegistry(options.registry)
  const runtimeLock = parseContract(
    agentRuntimeLockSchema,
    options.runtimeLock,
    'Agent runtime lock contract is invalid'
  )
  const verificationEnvironment =
    options.verificationEnvironment ?? 'production'
  assertProductionRegistryAvailable(registry, verificationEnvironment)
  await assertDirectoryWithoutSymlink(
    bundleDirectory,
    'Agent bundle directory'
  )

  const manifestBytes = await readBoundedFile(
    join(bundleDirectory, MANIFEST_FILE_NAME),
    MAXIMUM_METADATA_BYTES,
    'Agent manifest'
  )
  const signatureBytes = await readDetachedSignature(
    join(bundleDirectory, SIGNATURE_FILE_NAME)
  )
  const manifest = verifyAgentManifestSignature(
    manifestBytes,
    signatureBytes,
    registry,
    verificationEnvironment
  )
  assertAgentManifestMatchesRuntimeLock(
    manifest,
    runtimeLock,
    options.architecture
  )

  const declaredPaths = new Set(
    manifest.files.map((file) => file.path)
  )
  for (const file of manifest.files) {
    const absolutePath = join(
      bundleDirectory,
      ...file.path.split('/')
    )
    const fileStat = await lstat(absolutePath)
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error(
        `Agent payload is not a regular file: ${file.path}`
      )
    }
    if (fileStat.size !== file.size) {
      throw new Error(`Agent payload size mismatch: ${file.path}`)
    }
    if ((await sha256File(absolutePath)) !== file.sha256) {
      throw new Error(`Agent payload hash mismatch: ${file.path}`)
    }
    if (
      shouldEnforceFilesystemMode(options) &&
      modeString(fileStat.mode) !== file.mode
    ) {
      throw new Error(`Agent payload mode mismatch: ${file.path}`)
    }
  }

  const actualPaths = new Set(
    await listRegularBundleFiles(bundleDirectory)
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
    throw new Error('Agent bundle contains undeclared or missing files')
  }

  if (shouldEnforceFilesystemMode(options)) {
    for (const metadataName of [
      MANIFEST_FILE_NAME,
      SIGNATURE_FILE_NAME
    ]) {
      const metadataStat = await lstat(
        join(bundleDirectory, metadataName)
      )
      if (
        !metadataStat.isFile() ||
        metadataStat.isSymbolicLink() ||
        modeString(metadataStat.mode) !== '0644'
      ) {
        throw new Error(
          `Agent payload mode mismatch: ${metadataName}`
        )
      }
    }
  }

  await assertElfArchitecture(
    join(bundleDirectory, manifest.entrypoint.runtimePath),
    manifest.arch,
    'Agent Node runtime'
  )
  const koffiPaths = requiredKoffiPayloadPaths(manifest.arch)
  assertKoffiManifest(
    manifest,
    runtimeLock.koffi.version,
    koffiPaths.required
  )
  for (const nativePath of koffiPaths.native) {
    await assertElfArchitecture(
      join(bundleDirectory, ...nativePath.split('/')),
      manifest.arch,
      'Agent Koffi native binding'
    )
  }
  return {
    bundleDirectory,
    manifest,
    manifestSha256: sha256Bytes(manifestBytes)
  }
}

export function canonicalAgentManifestBytes(
  manifest: AgentBundleManifest
): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

export function canonicalAgentReleaseKeyRegistryBytes(
  registry: AgentReleaseKeyRegistry
): Buffer {
  const canonical = parseAgentReleaseKeyRegistry(registry)
  return Buffer.from(
    `${JSON.stringify(canonical, null, 2)}\n`,
    'utf8'
  )
}

export function parseAgentReleaseKeyRegistryBytes(
  bytes: Uint8Array,
  description = 'Agent trusted key registry'
): AgentReleaseKeyRegistry {
  let value: unknown
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    ) as unknown
  } catch (error) {
    throw new Error(`${description} is invalid JSON`, {
      cause: error
    })
  }
  try {
    return parseAgentReleaseKeyRegistry(value)
  } catch (error) {
    throw new Error(`${description} contract is invalid`, {
      cause: error
    })
  }
}

export function agentManifestSignaturePayload(
  manifestBytes: Uint8Array
): Buffer {
  return Buffer.concat([
    AGENT_MANIFEST_SIGNATURE_DOMAIN,
    Buffer.from(manifestBytes)
  ])
}

export function verifyAgentManifestSignature(
  manifestBytes: Buffer,
  signatureBytes: Buffer,
  registryInput: AgentReleaseKeyRegistry,
  verificationEnvironment: AgentVerificationEnvironment = 'production'
): AgentBundleManifest {
  const registry = parseAgentReleaseKeyRegistry(registryInput)
  assertProductionRegistryAvailable(registry, verificationEnvironment)

  let untrustedManifest: unknown
  try {
    untrustedManifest = JSON.parse(manifestBytes.toString('utf8'))
  } catch (error) {
    throw new Error('Agent manifest JSON is invalid', { cause: error })
  }
  const manifest = parseContract(
    agentBundleManifestSchema,
    untrustedManifest,
    'Agent manifest contract is invalid'
  )
  if (!canonicalAgentManifestBytes(manifest).equals(manifestBytes)) {
    throw new Error(
      'Agent manifest is not in canonical deterministic form'
    )
  }
  const trustedKey = trustedKeyForManifest(
    manifest,
    registry,
    verificationEnvironment
  )
  const publicKey = importEd25519PublicKey(trustedKey)
  if (
    signatureBytes.length !== 64 ||
    !verify(
      null,
      agentManifestSignaturePayload(manifestBytes),
      publicKey,
      signatureBytes
    )
  ) {
    throw new Error('Agent manifest signature verification failed')
  }
  return manifest
}

export function assertAgentManifestMatchesRuntimeLock(
  manifest: AgentBundleManifest,
  lock: AgentRuntimeLock,
  architecture: AgentArchitecture
): void {
  if (
    manifest.agentVersion !== lock.agentVersion
  ) {
    throw new Error(
      'Agent manifest version does not match the runtime lock'
    )
  }
  if (manifest.arch !== architecture) {
    throw new Error(
      'Agent manifest architecture does not match the selected bundle'
    )
  }
  if (
    manifest.protocol.major !== lock.protocol.major ||
    manifest.protocol.minor !== lock.protocol.minor
  ) {
    throw new Error(
      'Agent manifest protocol does not match the runtime lock'
    )
  }
}

function requiredKoffiPayloadPaths(
  architecture: AgentArchitecture
): {
  required: string[]
  native: string[]
} {
  const packageRoot = 'lib/node_modules/koffi'
  const nativePackage =
    `@koromix/koffi-linux-${architecture}`
  const nativeRoot = `lib/node_modules/${nativePackage}`
  return {
    required: [
      `${packageRoot}/package.json`,
      `${packageRoot}/index.js`,
      `${packageRoot}/src/koffi/index.js`,
      `${packageRoot}/src/koffi/src/static.js`,
      `${nativeRoot}/package.json`,
      `${nativeRoot}/index.js`,
      `${nativeRoot}/linux_${architecture}/koffi.node`,
      `${nativeRoot}/musl_${architecture}/koffi.node`
    ],
    native: [
      `${nativeRoot}/linux_${architecture}/koffi.node`,
      `${nativeRoot}/musl_${architecture}/koffi.node`
    ]
  }
}

function assertKoffiManifest(
  manifest: AgentBundleManifest,
  version: string,
  requiredPaths: readonly string[]
): void {
  const declaredPaths = new Set(
    manifest.files.map((file) => file.path)
  )
  for (const path of requiredPaths) {
    if (!declaredPaths.has(path)) {
      throw new Error(`Agent Koffi payload is missing: ${path}`)
    }
  }
  const nativePackage =
    `@koromix/koffi-linux-${manifest.arch}`
  const koffiLicense = manifest.licenses.find(
    (license) => license.package === 'koffi'
  )
  const nativeLicense = manifest.licenses.find(
    (license) => license.package === nativePackage
  )
  if (
    koffiLicense?.version !== version ||
    koffiLicense.spdx !== 'MIT' ||
    koffiLicense.path !== 'licenses/koffi-MIT.txt' ||
    nativeLicense?.version !== version ||
    nativeLicense.spdx !== 'MIT' ||
    nativeLicense.path !== 'licenses/koffi-native-MIT.txt'
  ) {
    throw new Error(
      'Agent Koffi dependencies do not match the runtime lock'
    )
  }
}

function trustedKeyForManifest(
  manifest: AgentBundleManifest,
  registry: AgentReleaseKeyRegistry,
  verificationEnvironment: AgentVerificationEnvironment
): AgentReleaseKey {
  const key = registry.keys.find(
    (candidate) => candidate.keyId === manifest.signingKeyId
  )
  if (!key) {
    throw new Error(
      `Agent manifest uses an unknown signing key: ${manifest.signingKeyId}`
    )
  }
  if (
    verificationEnvironment === 'production' &&
    key.environment !== 'production'
  ) {
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

function assertProductionRegistryAvailable(
  registry: AgentReleaseKeyRegistry,
  verificationEnvironment: AgentVerificationEnvironment
): void {
  if (
    verificationEnvironment === 'production' &&
    !registry.keys.some((key) => key.environment === 'production')
  ) {
    throw new Error(
      'Agent production key registry is empty; bundled Agent verification is unavailable'
    )
  }
}

function importEd25519PublicKey(key: AgentReleaseKey) {
  let publicKey
  try {
    publicKey = createPublicKey({
      key: Buffer.from(key.publicKeySpkiBase64, 'base64'),
      format: 'der',
      type: 'spki'
    })
  } catch (error) {
    throw new Error(
      `Agent trusted public key is invalid: ${key.keyId}`,
      { cause: error }
    )
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `Agent trusted public key is not Ed25519: ${key.keyId}`
    )
  }
  return publicKey
}

export function parseAgentReleaseKeyRegistry(
  value: unknown
): AgentReleaseKeyRegistry {
  const registry = parseContract(
    agentReleaseKeyRegistrySchema,
    value,
    'Agent trusted key registry contract is invalid'
  )
  for (const key of registry.keys) {
    importEd25519PublicKey(key)
  }
  return registry
}

async function readDetachedSignature(filePath: string): Promise<Buffer> {
  const signatureText = (
    await readBoundedFile(
      filePath,
      128,
      'Agent detached signature'
    )
  ).toString('utf8')
  if (!/^[A-Za-z0-9+/]{86}==\n$/u.test(signatureText)) {
    throw new Error('Agent detached signature encoding is invalid')
  }
  return Buffer.from(signatureText.trim(), 'base64')
}

async function readJsonMetadata(
  filePath: string,
  description: string
): Promise<unknown> {
  const contents = await readBoundedFile(
    filePath,
    MAXIMUM_METADATA_BYTES,
    description
  )
  try {
    return JSON.parse(contents.toString('utf8'))
  } catch (error) {
    throw new Error(`${description} is invalid JSON`, { cause: error })
  }
}

async function readBoundedFile(
  filePath: string,
  maximumBytes: number,
  description: string
): Promise<Buffer> {
  const fileStat = await lstat(filePath)
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`${description} is not a regular file`)
  }
  if (fileStat.size > maximumBytes) {
    throw new Error(`${description} exceeds its size limit`)
  }
  return readFile(filePath)
}

async function listRegularBundleFiles(
  bundleDirectory: string
): Promise<string[]> {
  const files: string[] = []
  const pending = [bundleDirectory]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) {
      continue
    }
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Agent bundle cannot contain a symlink: ${absolutePath}`
        )
      }
      if (entry.isDirectory()) {
        pending.push(absolutePath)
      } else if (entry.isFile()) {
        files.push(
          relative(bundleDirectory, absolutePath)
            .split(sep)
            .join('/')
        )
      } else {
        throw new Error(
          `Agent bundle contains an unsupported file: ${absolutePath}`
        )
      }
    }
  }
  return files
}

async function assertDirectoryWithoutSymlink(
  directory: string,
  description: string
): Promise<void> {
  const directoryStat = await lstat(directory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`${description} is not a regular directory`)
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

function sha256Bytes(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}

function shouldEnforceFilesystemMode(
  options: Pick<
    VerifyAgentBundleOptions,
    'enforceFilesystemMode' | 'filesystemPlatform'
  >
): boolean {
  return (
    options.enforceFilesystemMode !== false &&
    (options.filesystemPlatform ?? process.platform) !== 'win32'
  )
}

function modeString(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, '0')
}

async function assertElfArchitecture(
  filePath: string,
  expectedArchitecture: AgentArchitecture,
  description: string
): Promise<void> {
  const handle = await open(filePath, 'r')
  try {
    const header = Buffer.alloc(64)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    const actualArchitecture = detectElfArchitecture(
      header.subarray(0, bytesRead)
    )
    if (actualArchitecture !== expectedArchitecture) {
      throw new Error(
        `${description} architecture mismatch: expected ${expectedArchitecture}, received ${actualArchitecture ?? 'unknown'}`
      )
    }
  } finally {
    await handle.close()
  }
}

function detectElfArchitecture(
  buffer: Buffer
): AgentArchitecture | undefined {
  if (
    buffer.length < 20 ||
    buffer[0] !== 0x7f ||
    buffer.toString('ascii', 1, 4) !== 'ELF' ||
    (buffer[5] !== 1 && buffer[5] !== 2)
  ) {
    return undefined
  }
  const machine =
    buffer[5] === 2
      ? buffer.readUInt16BE(18)
      : buffer.readUInt16LE(18)
  if (machine === 62) {
    return 'x64'
  }
  if (machine === 183) {
    return 'arm64'
  }
  return undefined
}

function parseContract<T>(
  schema: { safeParse(value: unknown): {
    success: true
    data: T
  } | {
    success: false
    error: { message: string }
  } },
  value: unknown,
  message: string
): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new Error(`${message}: ${result.error.message}`)
  }
  return result.data
}
