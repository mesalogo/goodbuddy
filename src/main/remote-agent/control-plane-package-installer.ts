import {
  createHash,
  createPublicKey,
  verify
} from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { homedir } from 'node:os'
import {
  basename,
  dirname,
  join,
  resolve
} from 'node:path'
import { crc32 } from 'node:zlib'

const PACKAGE_DESCRIPTOR = 'agent-package.json'
const PACKAGE_SIGNATURE = 'agent-package.sig'
const NODE_PATH = 'agent/node'
const MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024
const MAXIMUM_EXPANDED_BYTES = 1024 * 1024 * 1024
const MAXIMUM_ENTRY_BYTES = 384 * 1024 * 1024
const MAXIMUM_METADATA_BYTES = 1024 * 1024
const MAXIMUM_ENTRIES = 50_002
const MAXIMUM_CENTRAL_BYTES = 32 * 1024 * 1024
const ZIP_LOCAL = 0x04034b50
const ZIP_CENTRAL = 0x02014b50
const ZIP_END = 0x06054b50
const PACKAGE_SIGNATURE_DOMAIN = Buffer.from(
  'GoodBuddy Agent Package Descriptor Signature v1\0',
  'utf8'
)
const AGENT_SIGNATURE_DOMAIN = Buffer.from(
  'GoodBuddy Agent Bundle Manifest Signature v1\0',
  'utf8'
)
const RUNTIME_SIGNATURE_DOMAIN = Buffer.from(
  'GoodBuddy Remote Runtime Bundle Manifest Signature v1\0',
  'utf8'
)
const sha256Pattern = /^[a-f0-9]{64}$/u
const digestPattern = /^sha256:[a-f0-9]{64}$/u
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u
const windowsReservedNamePattern =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu

type JsonRecord = Record<string, unknown>
type Architecture = 'x64' | 'arm64'
type Protocol = { major: number; minor: number }
type FileRecord = {
  path: string
  size: number
  sha256: string
  mode: '0644' | '0755'
}
type ZipEntry = {
  name: string
  size: number
  checksum: number
  mode: '0644' | '0755'
  dataOffset: number
  recordStart: number
  recordEnd: number
}
type TrustedRegistry = {
  formatVersion: 1
  keys: Array<{
    keyId: string
    publicKeySpkiBase64: string
    environment: 'production' | 'test'
  }>
  revocations: Array<{ keyId: string }>
}

export type PackageInstallerAgentIdentity = {
  installationId: string
  agentVersion: string
  manifestSha256: string
  binaryDigest: string
  platform: 'linux'
  architecture: Architecture
  protocol: Protocol
  supervisor: 'detached-on-demand'
}

export type PackageInstallerRuntimeIdentity = {
  runtimeId: 'opencode'
  runtimeVersion: string
  bundleDigest: string
  manifestDigest: string
  runtimeAdapterDigest: string
  acpCapabilitiesDigest: string
  platform: 'linux'
  architecture: Architecture
  protocol: Protocol
}

export type PackageInstallerResult = {
  type: 'result'
  command: 'prepare' | 'commit'
  status: 'prepared' | 'committed'
  archiveSha256: string
  agent: PackageInstallerAgentIdentity
  runtime: PackageInstallerRuntimeIdentity
}

export type PackageInstallerEvent =
  | {
      type: 'progress'
      command: 'prepare' | 'commit'
      phase: string
    }
  | PackageInstallerResult
  | {
      type: 'error'
      command: 'prepare' | 'commit'
      status: 'failed' | 'rollback-incomplete'
      message: string
    }

class PackageInstallerRollbackIncompleteError
  extends AggregateError {}

type InstallerOptions = {
  operationRoot: string
  archive: string
  expectedSha256: string
  /** The acquisition path verified the archive before installer execution. */
  archiveSha256Verified?: boolean
  homeDirectory?: string
  emit?: (event: PackageInstallerEvent) => void
}

type VerifiedPackage = {
  archiveSha256: string
  entries: Map<string, ZipEntry>
  descriptor: JsonRecord
  descriptorBytes: Buffer
  packageSignatureBytes: Buffer
  registry: TrustedRegistry
  releaseKeyRegistryBytes: Buffer
  agentRuntimeLockBytes: Buffer
  remoteRuntimeLockBytes: Buffer
  agentManifest: JsonRecord
  runtimeManifest: JsonRecord
  agentManifestSha256: string
  runtimeManifestDigest: string
  agent: PackageInstallerAgentIdentity
  runtime: PackageInstallerRuntimeIdentity
}

type PreparedState = {
  formatVersion: 1
  archiveSha256: string
  releaseKeyRegistrySha256: string
  agentRuntimeLockSha256: string
  remoteRuntimeLockSha256: string
  packageDescriptorSha256: string
  packageSignatureSha256: string
  agent: PackageInstallerAgentIdentity
  runtime: PackageInstallerRuntimeIdentity
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Canonical JSON contains a non-finite number')
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (!isRecord(value)) {
    throw new Error('Canonical JSON contains a non-JSON value')
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`
}

function prettyBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function digestCanonicalOperation(
  method: string,
  scope: unknown,
  payload: unknown
): string {
  return `sha256:${sha256(
    Buffer.from(canonicalJson({ method, payload, scope }), 'utf8')
  )}`
}

function isRecord(value: unknown): value is JsonRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function exactKeys(
  value: JsonRecord,
  keys: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} has unsupported or missing fields`)
  }
}

function protocol(value: unknown, label: string): Protocol {
  if (!isRecord(value)) {
    throw new Error(`${label} is invalid`)
  }
  exactKeys(value, ['major', 'minor'], label)
  if (
    !Number.isSafeInteger(value.major) ||
    Number(value.major) < 0 ||
    !Number.isSafeInteger(value.minor) ||
    Number(value.minor) < 0
  ) {
    throw new Error(`${label} is invalid`)
  }
  return {
    major: Number(value.major),
    minor: Number(value.minor)
  }
}

function safePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.includes('\\') &&
    value.split('/').every(
      (part) =>
        part.length > 0 &&
        part !== '.' &&
        part !== '..' &&
        !part.endsWith('.') &&
        !part.endsWith(' ') &&
        !part.includes(':') &&
        [...part].every((character) => character.charCodeAt(0) > 0x1f) &&
        !windowsReservedNamePattern.test(part)
    )
  )
}

function safeManifestPath(value: unknown): value is string {
  return (
    safePath(value) &&
    value.length <= 240
  )
}

function readExact(
  handle: number,
  length: number,
  position: number,
  label: string
): Buffer {
  const output = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const count = readSync(
      handle,
      output,
      offset,
      length - offset,
      position + offset
    )
    if (count <= 0) {
      throw new Error(`${label} is truncated`)
    }
    offset += count
  }
  return output
}

function parseZip(handle: number, archiveSize: number): Map<string, ZipEntry> {
  if (archiveSize < 22) {
    throw new Error('Agent package ZIP end record is missing')
  }
  const endSize = Math.min(archiveSize, 65_557)
  const endStart = archiveSize - endSize
  const tail = readExact(handle, endSize, endStart, 'Agent package ZIP end record')
  let endOffset = -1
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (
      tail.readUInt32LE(offset) === ZIP_END &&
      offset + 22 + tail.readUInt16LE(offset + 20) === tail.length
    ) {
      endOffset = offset
      break
    }
  }
  if (endOffset < 0 || tail.readUInt16LE(endOffset + 20) !== 0) {
    throw new Error('Agent package ZIP end record is invalid')
  }
  const count = tail.readUInt16LE(endOffset + 10)
  const centralSize = tail.readUInt32LE(endOffset + 12)
  const centralOffset = tail.readUInt32LE(endOffset + 16)
  if (
    tail.readUInt16LE(endOffset + 4) !== 0 ||
    tail.readUInt16LE(endOffset + 6) !== 0 ||
    tail.readUInt16LE(endOffset + 8) !== count ||
    count < 1 ||
    count > MAXIMUM_ENTRIES ||
    centralSize < 46 ||
    centralSize > MAXIMUM_CENTRAL_BYTES ||
    centralOffset + centralSize !== endStart + endOffset
  ) {
    throw new Error('Agent package ZIP central directory is invalid')
  }
  const central = readExact(
    handle,
    centralSize,
    centralOffset,
    'Agent package ZIP central directory'
  )
  const entries = new Map<string, ZipEntry>()
  let offset = 0
  let expanded = 0
  let previousName: string | undefined
  for (let index = 0; index < count; index += 1) {
    if (
      offset + 46 > central.length ||
      central.readUInt32LE(offset) !== ZIP_CENTRAL
    ) {
      throw new Error('Agent package ZIP central entry is invalid')
    }
    const nameLength = central.readUInt16LE(offset + 28)
    const extraLength = central.readUInt16LE(offset + 30)
    const commentLength = central.readUInt16LE(offset + 32)
    const recordLength = 46 + nameLength + extraLength + commentLength
    const flags = central.readUInt16LE(offset + 8)
    const compressed = central.readUInt32LE(offset + 20)
    const size = central.readUInt32LE(offset + 24)
    const external = central.readUInt32LE(offset + 38)
    const unixMode = external >>> 16
    const permissions = unixMode & 0o777
    const mode =
      permissions === 0o644
        ? '0644'
        : permissions === 0o755
          ? '0755'
          : undefined
    if (
      offset + recordLength > central.length ||
      central.readUInt16LE(offset + 4) !== 0x0314 ||
      central.readUInt16LE(offset + 6) !== 20 ||
      flags !== 0x0800 ||
      central.readUInt16LE(offset + 10) !== 0 ||
      central.readUInt16LE(offset + 30) !== 0 ||
      central.readUInt16LE(offset + 32) !== 0 ||
      central.readUInt16LE(offset + 34) !== 0 ||
      compressed !== size ||
      size > MAXIMUM_ENTRY_BYTES ||
      (unixMode & 0o170000) !== 0o100000 ||
      mode === undefined
    ) {
      throw new Error('Agent package ZIP entry is unsupported')
    }
    const nameBytes = central.subarray(offset + 46, offset + 46 + nameLength)
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes)
    if (
      !safePath(name) ||
      entries.has(name) ||
      (
        previousName !== undefined &&
        Buffer.compare(
          Buffer.from(previousName, 'utf8'),
          Buffer.from(name, 'utf8')
        ) >= 0
      )
    ) {
      throw new Error('Agent package contains an unsafe, duplicate, or unordered path')
    }
    previousName = name
    expanded += size
    if (expanded > MAXIMUM_EXPANDED_BYTES) {
      throw new Error('Agent package expanded payload exceeds its limit')
    }
    const localOffset = central.readUInt32LE(offset + 42)
    const local = readExact(handle, 30, localOffset, 'Agent package ZIP local header')
    const localNameLength = local.readUInt16LE(26)
    const localExtraLength = local.readUInt16LE(28)
    if (
      local.readUInt32LE(0) !== ZIP_LOCAL ||
      local.readUInt16LE(4) !== 20 ||
      local.readUInt16LE(6) !== flags ||
      local.readUInt16LE(8) !== 0 ||
      local.readUInt32LE(14) !== central.readUInt32LE(offset + 16) ||
      local.readUInt32LE(18) !== size ||
      local.readUInt32LE(22) !== size ||
      localNameLength !== nameLength ||
      localExtraLength !== 0 ||
      !readExact(
        handle,
        nameLength,
        localOffset + 30,
        'Agent package ZIP local name'
      ).equals(nameBytes)
    ) {
      throw new Error('Agent package ZIP local header is invalid')
    }
    const dataOffset = localOffset + 30 + nameLength
    entries.set(name, {
      name,
      size,
      checksum: central.readUInt32LE(offset + 16),
      mode,
      dataOffset,
      recordStart: localOffset,
      recordEnd: dataOffset + size
    })
    offset += recordLength
  }
  if (offset !== central.length) {
    throw new Error('Agent package ZIP central count is invalid')
  }
  const ordered = [...entries.values()].sort(
    (left, right) => left.recordStart - right.recordStart
  )
  let end = 0
  for (const entry of ordered) {
    if (entry.recordStart !== end || entry.recordEnd > centralOffset) {
      throw new Error('Agent package ZIP entries overlap or contain gaps')
    }
    end = entry.recordEnd
  }
  if (end !== centralOffset) {
    throw new Error('Agent package ZIP data region is invalid')
  }
  return entries
}

function streamEntry(
  handle: number,
  entry: ZipEntry,
  destination?: string
): { sha256: string; crc32: number; bytes?: Buffer } {
  const wantedBytes =
    destination === undefined && entry.size <= MAXIMUM_METADATA_BYTES
      ? Buffer.allocUnsafe(entry.size)
      : undefined
  let output: number | undefined
  if (destination !== undefined) {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    output = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      entry.mode === '0755' ? 0o755 : 0o644
    )
  }
  const hash = createHash('sha256')
  const chunk = Buffer.allocUnsafe(1024 * 1024)
  let checksum = 0
  let position = 0
  try {
    while (position < entry.size) {
      const count = readSync(
        handle,
        chunk,
        0,
        Math.min(chunk.length, entry.size - position),
        entry.dataOffset + position
      )
      if (count <= 0) {
        throw new Error(`Agent package entry is truncated: ${entry.name}`)
      }
      const bytes = chunk.subarray(0, count)
      hash.update(bytes)
      checksum = crc32(bytes, checksum)
      if (wantedBytes !== undefined) {
        bytes.copy(wantedBytes, position)
      }
      if (output !== undefined) {
        let written = 0
        while (written < count) {
          const amount = writeFileChunk(output, bytes, written)
          written += amount
        }
      }
      position += count
    }
    if (output !== undefined) {
      fsyncSync(output)
    }
  } finally {
    if (output !== undefined) {
      closeSync(output)
      chmodSync(destination!, entry.mode === '0755' ? 0o755 : 0o644)
    }
  }
  return {
    sha256: hash.digest('hex'),
    crc32: checksum >>> 0,
    ...(wantedBytes === undefined ? {} : { bytes: wantedBytes })
  }
}

function writeFileChunk(handle: number, bytes: Buffer, offset: number): number {
  const written = writeSync(handle, bytes, offset, bytes.length - offset)
  if (written <= 0) {
    throw new Error('Agent package extraction made no progress')
  }
  return written
}

function readEntry(handle: number, entries: Map<string, ZipEntry>, name: string): Buffer {
  const entry = entries.get(name)
  if (entry === undefined || entry.size > MAXIMUM_METADATA_BYTES) {
    throw new Error(`Agent package metadata is missing or too large: ${name}`)
  }
  const actual = streamEntry(handle, entry)
  if (actual.crc32 !== entry.checksum) {
    throw new Error(`Agent package ZIP checksum mismatch: ${name}`)
  }
  return actual.bytes!
}

function assertDeclaredMetadata(
  name: string,
  bytes: Buffer,
  declared: ReadonlyMap<string, FileRecord>
): void {
  const expected = declared.get(name)
  if (
    expected === undefined ||
    expected.size !== bytes.byteLength ||
    expected.sha256 !== sha256(bytes)
  ) {
    throw new Error(
      `Agent package metadata digest mismatch: ${name}`
    )
  }
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (error) {
    throw new Error(`${label} is invalid JSON`, { cause: error })
  }
}

function parseCanonicalJson(bytes: Buffer, label: string): JsonRecord {
  const value = parseJson(bytes, label)
  if (!isRecord(value) || !prettyBytes(value).equals(bytes)) {
    throw new Error(`${label} is not canonical`)
  }
  return value
}

function parseRegistry(bytes: Buffer): TrustedRegistry {
  const value = parseJson(bytes, 'Agent package key registry')
  if (!isRecord(value)) {
    throw new Error('Agent package key registry is invalid')
  }
  exactKeys(value, ['formatVersion', 'keys', 'revocations'], 'Agent package key registry')
  if (
    value.formatVersion !== 1 ||
    !Array.isArray(value.keys) ||
    !Array.isArray(value.revocations) ||
    value.keys.length < 1 ||
    value.keys.length > 1_000 ||
    value.revocations.length > 1_000
  ) {
    throw new Error('Agent package key registry is invalid')
  }
  const ids = new Set<string>()
  const keys = value.keys.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new Error('Agent package key registry is invalid')
    }
    exactKeys(
      candidate,
      ['keyId', 'publicKeySpkiBase64', 'environment'],
      'Agent package key'
    )
    if (
      typeof candidate.keyId !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(candidate.keyId) ||
      ids.has(candidate.keyId) ||
      typeof candidate.publicKeySpkiBase64 !== 'string' ||
      !['production', 'test'].includes(String(candidate.environment))
    ) {
      throw new Error('Agent package key registry is invalid')
    }
    const publicKey = createPublicKey({
      key: Buffer.from(candidate.publicKeySpkiBase64, 'base64'),
      format: 'der',
      type: 'spki'
    })
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('Agent package registry key is not Ed25519')
    }
    ids.add(candidate.keyId)
    return {
      keyId: candidate.keyId,
      publicKeySpkiBase64: candidate.publicKeySpkiBase64,
      environment: candidate.environment as 'production' | 'test'
    }
  })
  const revoked = new Set<string>()
  const revocations = value.revocations.map((candidate) => {
    if (!isRecord(candidate) || typeof candidate.keyId !== 'string') {
      throw new Error('Agent package key revocation is invalid')
    }
    if (revoked.has(candidate.keyId)) {
      throw new Error('Agent package key revocation is duplicated')
    }
    revoked.add(candidate.keyId)
    return { keyId: candidate.keyId }
  })
  if (!keys.some((key) => key.environment === 'production')) {
    throw new Error('Agent package has no production trust root')
  }
  return { formatVersion: 1, keys, revocations }
}

function trustedProductionKey(registry: TrustedRegistry, keyId: unknown) {
  const key = registry.keys.find(
    (candidate) =>
      candidate.keyId === keyId &&
      candidate.environment === 'production'
  )
  if (
    key === undefined ||
    registry.revocations.some((item) => item.keyId === key.keyId)
  ) {
    throw new Error(`GoodBuddy signing key is not trusted: ${String(keyId)}`)
  }
  return createPublicKey({
    key: Buffer.from(key.publicKeySpkiBase64, 'base64'),
    format: 'der',
    type: 'spki'
  })
}

function verifySignature(
  bytes: Buffer,
  signatureBytes: Buffer,
  publicKey: ReturnType<typeof createPublicKey>,
  domain: Buffer,
  label: string
): void {
  const text = signatureBytes.toString('utf8')
  if (!/^[A-Za-z0-9+/]{86}==\n$/u.test(text)) {
    throw new Error(`${label} detached signature encoding is invalid`)
  }
  const signature = Buffer.from(text.trim(), 'base64')
  if (
    signature.length !== 64 ||
    !verify(null, Buffer.concat([domain, bytes]), publicKey, signature)
  ) {
    throw new Error(`${label} signature verification failed`)
  }
}

function parseFiles(value: unknown, label: string): FileRecord[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50_000) {
    throw new Error(`${label} file inventory is invalid`)
  }
  const paths = new Set<string>()
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new Error(`${label} file inventory is invalid`)
    }
    exactKeys(item, ['path', 'size', 'sha256', 'mode'], `${label} file`)
    if (
      !safePath(item.path) ||
      !Number.isSafeInteger(item.size) ||
      Number(item.size) < 0 ||
      !sha256Pattern.test(String(item.sha256)) ||
      !['0644', '0755'].includes(String(item.mode)) ||
      paths.has(item.path)
    ) {
      throw new Error(`${label} file inventory is invalid`)
    }
    paths.add(item.path)
    return {
      path: item.path,
      size: Number(item.size),
      sha256: String(item.sha256),
      mode: item.mode as '0644' | '0755'
    }
  })
}

function validateLicenses(
  value: unknown,
  declared: Set<string>,
  label: string
): Array<{
  package: string
  version: string
  spdx: string
  path: string
}> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1_000) {
    throw new Error(`${label} license inventory is invalid`)
  }
  const paths = new Set<string>()
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new Error(`${label} license inventory is invalid`)
    }
    exactKeys(
      item,
      ['package', 'version', 'spdx', 'path'],
      `${label} license`
    )
    if (
      typeof item.package !== 'string' ||
      item.package.length < 1 ||
      typeof item.version !== 'string' ||
      item.version.length < 1 ||
      typeof item.spdx !== 'string' ||
      item.spdx.length < 1 ||
      !safeManifestPath(item.path) ||
      !declared.has(item.path) ||
      paths.has(item.path)
    ) {
      throw new Error(`${label} license inventory is invalid`)
    }
    paths.add(item.path)
    return {
      package: item.package,
      version: item.version,
      spdx: item.spdx,
      path: item.path
    }
  })
}

function expectedAgentMode(path: string): '0644' | '0755' {
  return (
    path === 'node' ||
    path === 'goodbuddy-agent' ||
    path.startsWith('helpers/')
  )
    ? '0755'
    : '0644'
}

function assertOuterDescriptor(
  descriptor: JsonRecord,
  bytes: Buffer,
  entries: Map<string, ZipEntry>,
  registry: TrustedRegistry,
  signature: Buffer
): FileRecord[] {
  exactKeys(
    descriptor,
    [
      'format',
      'formatVersion',
      'product',
      'component',
      'version',
      'minimumDesktopVersion',
      'platform',
      'architecture',
      'signingKeyId',
      'agentProtocol',
      'remoteRuntime',
      'contentDigest',
      'files'
    ],
    'Agent package descriptor'
  )
  const architecture = descriptor.architecture
  const remoteRuntime = descriptor.remoteRuntime
  if (
    descriptor.format !== 'goodbuddy-agent-package' ||
    descriptor.formatVersion !== 1 ||
    descriptor.product !== 'GoodBuddy' ||
    descriptor.component !== 'agent' ||
    !versionPattern.test(String(descriptor.version)) ||
    !versionPattern.test(String(descriptor.minimumDesktopVersion)) ||
    descriptor.platform !== 'linux' ||
    !['x64', 'arm64'].includes(String(architecture)) ||
    typeof descriptor.signingKeyId !== 'string' ||
    !digestPattern.test(String(descriptor.contentDigest)) ||
    !isRecord(remoteRuntime)
  ) {
    throw new Error('Agent package descriptor is invalid')
  }
  exactKeys(
    remoteRuntime,
    ['runtimeId', 'provider', 'version', 'bundleDigest', 'protocol'],
    'Agent package Runtime identity'
  )
  if (
    remoteRuntime.runtimeId !== 'opencode' ||
    remoteRuntime.provider !== 'opencode' ||
    !versionPattern.test(String(remoteRuntime.version)) ||
    !digestPattern.test(String(remoteRuntime.bundleDigest))
  ) {
    throw new Error('Agent package Runtime identity is invalid')
  }
  protocol(descriptor.agentProtocol, 'Agent package protocol')
  protocol(remoteRuntime.protocol, 'Agent package Runtime protocol')
  const { contentDigest: _contentDigest, ...content } = descriptor
  void _contentDigest
  if (
    descriptor.contentDigest !==
    `sha256:${sha256(Buffer.from(canonicalJson(content), 'utf8'))}`
  ) {
    throw new Error('Agent package content identity is invalid')
  }
  verifySignature(
    bytes,
    signature,
    trustedProductionKey(registry, descriptor.signingKeyId),
    PACKAGE_SIGNATURE_DOMAIN,
    'Agent package'
  )
  const files = parseFiles(descriptor.files, 'Agent package')
  const expected = new Set([
    ...files.map((file) => file.path),
    PACKAGE_DESCRIPTOR,
    PACKAGE_SIGNATURE
  ])
  if (
    entries.size !== expected.size ||
    [...entries.keys()].some((name) => !expected.has(name))
  ) {
    throw new Error('Agent package contains undeclared or missing files')
  }
  for (const file of files) {
    const entry = entries.get(file.path)
    if (
      entry === undefined ||
      entry.size !== file.size ||
      entry.mode !== file.mode
    ) {
      throw new Error(`Agent package ZIP inventory mismatch: ${file.path}`)
    }
  }
  for (const metadata of [PACKAGE_DESCRIPTOR, PACKAGE_SIGNATURE]) {
    if (entries.get(metadata)?.mode !== '0644') {
      throw new Error('Agent package metadata mode is invalid')
    }
  }
  if (
    !files.some((file) => file.path === NODE_PATH && file.mode === '0755')
  ) {
    throw new Error('Agent package is not self-bootstrap capable')
  }
  return files
}

function assertAgentManifest(
  bytes: Buffer,
  signature: Buffer,
  registry: TrustedRegistry,
  lock: JsonRecord,
  descriptor: JsonRecord,
  packageFiles: Map<string, FileRecord>
): JsonRecord {
  const manifest = parseCanonicalJson(bytes, 'Agent manifest')
  exactKeys(
    manifest,
    [
      'formatVersion',
      'product',
      'agentVersion',
      'platform',
      'arch',
      'protocol',
      'signingKeyId',
      'entrypoint',
      'files',
      'licenses'
    ],
    'Agent manifest'
  )
  if (
    manifest.formatVersion !== 1 ||
    manifest.product !== 'GoodBuddy' ||
    !versionPattern.test(String(manifest.agentVersion)) ||
    manifest.platform !== 'linux' ||
    !['x64', 'arm64'].includes(String(manifest.arch)) ||
    !isRecord(manifest.entrypoint) ||
    !Array.isArray(manifest.licenses)
  ) {
    throw new Error('Agent manifest contract is invalid')
  }
  exactKeys(
    manifest.entrypoint,
    ['path', 'runtimePath', 'scriptPath'],
    'Agent entrypoint'
  )
  if (
    manifest.entrypoint.path !== 'goodbuddy-agent' ||
    manifest.entrypoint.runtimePath !== 'node' ||
    manifest.entrypoint.scriptPath !== 'lib/agent.cjs'
  ) {
    throw new Error('Agent entrypoint is invalid')
  }
  const agentProtocol = protocol(manifest.protocol, 'Agent manifest protocol')
  if (
    lock.formatVersion !== 1 ||
    manifest.agentVersion !== lock.agentVersion ||
    manifest.arch !== descriptor.architecture ||
    manifest.agentVersion !== descriptor.version ||
    canonicalJson(agentProtocol) !== canonicalJson(descriptor.agentProtocol) ||
    canonicalJson(agentProtocol) !== canonicalJson(lock.protocol)
  ) {
    throw new Error('Agent manifest does not match package identity or lock')
  }
  verifySignature(
    bytes,
    signature,
    trustedProductionKey(registry, manifest.signingKeyId),
    AGENT_SIGNATURE_DOMAIN,
    'Agent manifest'
  )
  const files = parseFiles(manifest.files, 'Agent manifest')
  const declared = new Set<string>()
  for (const file of files) {
    if (
      !safeManifestPath(file.path) ||
      file.mode !== expectedAgentMode(file.path)
    ) {
      throw new Error(`Agent manifest path or mode is invalid: ${file.path}`)
    }
    declared.add(file.path)
    const outer = packageFiles.get(`agent/${file.path}`)
    if (
      outer === undefined ||
      outer.size !== file.size ||
      outer.sha256 !== file.sha256 ||
      outer.mode !== file.mode
    ) {
      throw new Error(`Agent inner inventory mismatch: ${file.path}`)
    }
  }
  const expectedAgentPaths = new Set([
    ...files.map((file) => `agent/${file.path}`),
    'agent/manifest.json',
    'agent/manifest.sig'
  ])
  const actualAgentPaths = [...packageFiles.keys()].filter((path) =>
    path.startsWith('agent/')
  )
  if (
    actualAgentPaths.length !== expectedAgentPaths.size ||
    actualAgentPaths.some((path) => !expectedAgentPaths.has(path))
  ) {
    throw new Error('Agent bundle contains undeclared or missing files')
  }
  for (const required of [
    'node',
    'goodbuddy-agent',
    'lib/agent.cjs'
  ]) {
    if (!declared.has(required)) {
      throw new Error(`Agent required payload is missing: ${required}`)
    }
  }
  const architecture = manifest.arch as Architecture
  const koffiPackageRoot = 'lib/node_modules/koffi'
  const koffiNativePackage = `@koromix/koffi-linux-${architecture}`
  const koffiNativeRoot =
    `lib/node_modules/${koffiNativePackage}`
  for (const required of [
    `${koffiPackageRoot}/package.json`,
    `${koffiPackageRoot}/index.js`,
    `${koffiPackageRoot}/src/koffi/index.js`,
    `${koffiPackageRoot}/src/koffi/src/static.js`,
    `${koffiNativeRoot}/package.json`,
    `${koffiNativeRoot}/index.js`
  ]) {
    if (!declared.has(required)) {
      throw new Error(`Agent Koffi payload is missing: ${required}`)
    }
  }
  for (const native of [
    `lib/node_modules/@koromix/koffi-linux-${manifest.arch}/linux_${manifest.arch}/koffi.node`,
    `lib/node_modules/@koromix/koffi-linux-${manifest.arch}/musl_${manifest.arch}/koffi.node`
  ]) {
    if (!declared.has(native)) {
      throw new Error(`Agent Koffi payload is missing: ${native}`)
    }
  }
  if (
    !isRecord(lock.koffi) ||
    typeof lock.koffi.version !== 'string'
  ) {
    throw new Error('Agent runtime lock contract is invalid')
  }
  const licenses = validateLicenses(
    manifest.licenses,
    declared,
    'Agent manifest'
  )
  const koffiLicense = licenses.find(
    (license) => license.package === 'koffi'
  )
  const nativeLicense = licenses.find(
    (license) => license.package === koffiNativePackage
  )
  if (
    koffiLicense?.version !== lock.koffi.version ||
    koffiLicense.spdx !== 'MIT' ||
    koffiLicense.path !== 'licenses/koffi-MIT.txt' ||
    nativeLicense?.version !== lock.koffi.version ||
    nativeLicense.spdx !== 'MIT' ||
    nativeLicense.path !== 'licenses/koffi-native-MIT.txt'
  ) {
    throw new Error('Agent Koffi license declaration is invalid')
  }
  return manifest
}

function assertRuntimeManifest(
  bytes: Buffer,
  signature: Buffer,
  registry: TrustedRegistry,
  lock: JsonRecord,
  descriptor: JsonRecord,
  packageFiles: Map<string, FileRecord>
): { manifest: JsonRecord; manifestDigest: string } {
  const manifest = parseCanonicalJson(bytes, 'Runtime manifest')
  exactKeys(
    manifest,
    [
      'formatVersion',
      'product',
      'runtimeId',
      'runtimeVersion',
      'provider',
      'platform',
      'architecture',
      'signingKeyId',
      'bundleDigest',
      'adapterDigest',
      'sourcePackage',
      'entrypoint',
      'files',
      'licenses',
      'allowedEnvironmentNames',
      'protocol',
      'acpCapabilitiesDigest',
      'limits'
    ],
    'Runtime manifest'
  )
  const runtime = isRecord(lock.runtimes) && isRecord(lock.runtimes.opencode)
    ? lock.runtimes.opencode
    : undefined
  const target =
    runtime !== undefined &&
    isRecord(runtime.targets) &&
    isRecord(runtime.targets[String(descriptor.architecture)])
      ? runtime.targets[String(descriptor.architecture)]
      : undefined
  const remote = descriptor.remoteRuntime as JsonRecord
  if (
    manifest.formatVersion !== 2 ||
    manifest.product !== 'GoodBuddy' ||
    manifest.runtimeId !== 'opencode' ||
    manifest.provider !== 'opencode' ||
    manifest.platform !== 'linux' ||
    manifest.architecture !== descriptor.architecture ||
    !versionPattern.test(String(manifest.runtimeVersion)) ||
    !digestPattern.test(String(manifest.bundleDigest)) ||
    !digestPattern.test(String(manifest.adapterDigest)) ||
    !digestPattern.test(String(manifest.acpCapabilitiesDigest)) ||
    !isRecord(manifest.entrypoint) ||
    !isRecord(manifest.sourcePackage) ||
    !isRecord(manifest.limits) ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.licenses) ||
    !Array.isArray(manifest.allowedEnvironmentNames) ||
    runtime === undefined ||
    target === undefined
  ) {
    throw new Error('Runtime manifest contract or lock is invalid')
  }
  const lockedTarget = target as JsonRecord
  const entrypoint = manifest.entrypoint as JsonRecord
  const sourcePackage = manifest.sourcePackage as JsonRecord
  const limits = manifest.limits as JsonRecord
  exactKeys(
    entrypoint,
    ['identity', 'path', 'sha256', 'argvPrefix'],
    'Runtime entrypoint'
  )
  exactKeys(
    sourcePackage,
    ['name', 'integrity'],
    'Runtime source package'
  )
  exactKeys(
    limits,
    [
      'maximumPromptRuntimeMilliseconds',
      'maximumPromptInputBytes',
      'maximumPromptOutputBytes'
    ],
    'Runtime limits'
  )
  const runtimeProtocol = protocol(manifest.protocol, 'Runtime manifest protocol')
  if (
    manifest.runtimeVersion !== runtime.version ||
    manifest.runtimeVersion !== remote.version ||
    manifest.bundleDigest !== remote.bundleDigest ||
    canonicalJson(runtimeProtocol) !== canonicalJson(runtime.protocol) ||
    canonicalJson(runtimeProtocol) !== canonicalJson(remote.protocol) ||
    entrypoint.path !== runtime.entrypoint ||
    entrypoint.identity !== runtime.entrypointIdentity ||
    canonicalJson(entrypoint.argvPrefix) !==
      canonicalJson(runtime.argvPrefix) ||
    canonicalJson(manifest.allowedEnvironmentNames) !==
      canonicalJson(runtime.allowedEnvironmentNames) ||
    sourcePackage.name !== lockedTarget.package ||
    sourcePackage.integrity !== lockedTarget.integrity ||
    !sha256Pattern.test(String(entrypoint.sha256)) ||
    !Number.isSafeInteger(limits.maximumPromptRuntimeMilliseconds) ||
    Number(limits.maximumPromptRuntimeMilliseconds) < 1 ||
    !Number.isSafeInteger(limits.maximumPromptInputBytes) ||
    Number(limits.maximumPromptInputBytes) < 1 ||
    !Number.isSafeInteger(limits.maximumPromptOutputBytes) ||
    Number(limits.maximumPromptOutputBytes) < 0
  ) {
    throw new Error('Runtime manifest does not match package identity or lock')
  }
  const { bundleDigest: _bundleDigest, ...identity } = manifest
  void _bundleDigest
  if (
    manifest.bundleDigest !==
    digestCanonicalOperation(
      'runtime/bundleIdentity',
      { kind: 'installation', installationId: manifest.runtimeId },
      identity
    )
  ) {
    throw new Error('Runtime bundle identity digest does not match')
  }
  verifySignature(
    bytes,
    signature,
    trustedProductionKey(registry, manifest.signingKeyId),
    RUNTIME_SIGNATURE_DOMAIN,
    'Runtime manifest'
  )
  const files = parseFiles(manifest.files, 'Runtime manifest')
  const digestDirectory = String(manifest.bundleDigest).slice('sha256:'.length)
  const prefix = `runtime/opencode/${digestDirectory}/`
  const expectedRuntimePaths = new Set([
    ...files.map((file) => `${prefix}${file.path}`),
    `${prefix}manifest.json`,
    `${prefix}manifest.sig`
  ])
  const actualRuntimePaths = [...packageFiles.keys()].filter((path) =>
    path.startsWith('runtime/')
  )
  if (
    actualRuntimePaths.length !== expectedRuntimePaths.size ||
    actualRuntimePaths.some((path) => !expectedRuntimePaths.has(path))
  ) {
    throw new Error('Runtime bundle contains undeclared or missing files')
  }
  for (const file of files) {
    if (!safeManifestPath(file.path)) {
      throw new Error(`Runtime manifest path is invalid: ${file.path}`)
    }
    const expectedMode = file.path === 'bin/opencode' ? '0755' : '0644'
    const outer = packageFiles.get(`${prefix}${file.path}`)
    if (
      file.mode !== expectedMode ||
      outer === undefined ||
      outer.size !== file.size ||
      outer.sha256 !== file.sha256 ||
      outer.mode !== file.mode
    ) {
      throw new Error(`Runtime inner inventory mismatch: ${file.path}`)
    }
  }
  const runtimeLicenses = validateLicenses(
    manifest.licenses,
    new Set(files.map((file) => file.path)),
    'Runtime manifest'
  )
  const openCodeLicense = runtimeLicenses.find(
    (license) => license.package === 'opencode-ai'
  )
  if (
    openCodeLicense?.version !== manifest.runtimeVersion ||
    openCodeLicense?.spdx !== 'MIT' ||
    openCodeLicense?.path !== 'licenses/opencode-MIT.txt'
  ) {
    throw new Error('Runtime license declaration is invalid')
  }
  if (
    entrypoint.path !== 'bin/opencode' ||
    !files.some(
      (file) =>
        file.path === 'bin/opencode' &&
        file.sha256 === entrypoint.sha256
    )
  ) {
    throw new Error('Runtime entrypoint is missing')
  }
  return {
    manifest,
    manifestDigest: digestCanonicalOperation(
      'runtime/bundleManifest',
      { kind: 'installation', installationId: manifest.runtimeId },
      manifest
    )
  }
}

function elfArchitecture(bytes: Buffer): Architecture | undefined {
  if (
    bytes.length < 20 ||
    !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  ) {
    return undefined
  }
  const machine =
    bytes[5] === 1
      ? bytes.readUInt16LE(18)
      : bytes[5] === 2
        ? bytes.readUInt16BE(18)
        : 0
  return machine === 62 ? 'x64' : machine === 183 ? 'arm64' : undefined
}

function assertExtractedArchitectures(
  preparedRoot: string,
  architecture: Architecture
): void {
  for (const path of [
    join(preparedRoot, 'agent', 'node'),
    join(
      preparedRoot,
      'agent',
      'lib',
      'node_modules',
      `@koromix/koffi-linux-${architecture}`,
      `linux_${architecture}`,
      'koffi.node'
    ),
    join(
      preparedRoot,
      'agent',
      'lib',
      'node_modules',
      `@koromix/koffi-linux-${architecture}`,
      `musl_${architecture}`,
      'koffi.node'
    ),
    join(preparedRoot, 'runtime', 'bin', 'opencode')
  ]) {
    if (
      elfArchitecture(readFileHeader(path, 64)) !== architecture
    ) {
      throw new Error(`Installed executable architecture mismatch: ${basename(path)}`)
    }
  }
}

function readFileHeader(path: string, maximumBytes: number): Buffer {
  const handle = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  )
  try {
    const snapshot = fstatSync(handle)
    if (!snapshot.isFile()) {
      throw new Error(`Installed payload is not a regular file: ${path}`)
    }
    return readExact(
      handle,
      Math.min(snapshot.size, maximumBytes),
      0,
      'Installed payload header'
    )
  } finally {
    closeSync(handle)
  }
}

function hashArchive(handle: number, size: number): string {
  const hash = createHash('sha256')
  const chunk = Buffer.allocUnsafe(1024 * 1024)
  let position = 0
  while (position < size) {
    const count = readSync(
      handle,
      chunk,
      0,
      Math.min(chunk.length, size - position),
      position
    )
    if (count <= 0) {
      throw new Error('Agent package archive is truncated')
    }
    hash.update(chunk.subarray(0, count))
    position += count
  }
  return hash.digest('hex')
}

function sameSnapshot(
  before: ReturnType<typeof fstatSync>,
  after: ReturnType<typeof fstatSync>
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  )
}

function verifyArchive(
  archivePath: string,
  expectedSha256: string,
  archiveSha256Verified: boolean,
  emit: (phase: string) => void
): VerifiedPackage {
  const handle = openSync(
    archivePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  )
  try {
    const snapshot = fstatSync(handle)
    if (
      !snapshot.isFile() ||
      snapshot.size <= 0 ||
      snapshot.size > MAXIMUM_ARCHIVE_BYTES
    ) {
      throw new Error('Agent package archive is not a bounded regular file')
    }
    if (!archiveSha256Verified) {
      emit('hashing-archive')
      const archiveSha256 = hashArchive(handle, snapshot.size)
      if (archiveSha256 !== expectedSha256) {
        throw new Error('Agent package archive SHA-256 does not match the authenticated catalog')
      }
    }
    const archiveSha256 = expectedSha256
    emit('verifying-zip')
    const entries = parseZip(handle, snapshot.size)
    const descriptorBytes = readEntry(handle, entries, PACKAGE_DESCRIPTOR)
    const signatureBytes = readEntry(handle, entries, PACKAGE_SIGNATURE)
    const registryBytes = readEntry(handle, entries, 'agent-release-keys.json')
    const descriptor = parseCanonicalJson(
      descriptorBytes,
      'Agent package descriptor'
    )
    const registry = parseRegistry(registryBytes)
    const declared = assertOuterDescriptor(
      descriptor,
      descriptorBytes,
      entries,
      registry,
      signatureBytes
    )
    const declaredMap = new Map(declared.map((file) => [file.path, file]))
    assertDeclaredMetadata(
      'agent-release-keys.json',
      registryBytes,
      declaredMap
    )
    emit('verifying-payload')
    const agentManifestBytes = readEntry(handle, entries, 'agent/manifest.json')
    assertDeclaredMetadata(
      'agent/manifest.json',
      agentManifestBytes,
      declaredMap
    )
    const agentRuntimeLockBytes = readEntry(
      handle,
      entries,
      'agent-runtime-lock.json'
    )
    assertDeclaredMetadata(
      'agent-runtime-lock.json',
      agentRuntimeLockBytes,
      declaredMap
    )
    const agentSignatureBytes = readEntry(
      handle,
      entries,
      'agent/manifest.sig'
    )
    assertDeclaredMetadata(
      'agent/manifest.sig',
      agentSignatureBytes,
      declaredMap
    )
    const agentManifest = assertAgentManifest(
      agentManifestBytes,
      agentSignatureBytes,
      registry,
      parseCanonicalJson(
        agentRuntimeLockBytes,
        'Agent runtime lock'
      ),
      descriptor,
      declaredMap
    )
    const runtimeDigest = String(
      (descriptor.remoteRuntime as JsonRecord).bundleDigest
    ).slice('sha256:'.length)
    const runtimeManifestBytes = readEntry(
      handle,
      entries,
      `runtime/opencode/${runtimeDigest}/manifest.json`
    )
    assertDeclaredMetadata(
      `runtime/opencode/${runtimeDigest}/manifest.json`,
      runtimeManifestBytes,
      declaredMap
    )
    const remoteRuntimeLockBytes = readEntry(
      handle,
      entries,
      'remote-runtime-lock.json'
    )
    assertDeclaredMetadata(
      'remote-runtime-lock.json',
      remoteRuntimeLockBytes,
      declaredMap
    )
    const runtimeSignaturePath =
      `runtime/opencode/${runtimeDigest}/manifest.sig`
    const runtimeSignatureBytes = readEntry(
      handle,
      entries,
      runtimeSignaturePath
    )
    assertDeclaredMetadata(
      runtimeSignaturePath,
      runtimeSignatureBytes,
      declaredMap
    )
    const runtime = assertRuntimeManifest(
      runtimeManifestBytes,
      runtimeSignatureBytes,
      registry,
      parseCanonicalJson(
        remoteRuntimeLockBytes,
        'Remote Runtime lock'
      ),
      descriptor,
      declaredMap
    )
    if (!sameSnapshot(snapshot, fstatSync(handle))) {
      throw new Error('Agent package archive changed during verification')
    }
    const agentManifestSha256 = sha256(agentManifestBytes)
    const architecture = descriptor.architecture as Architecture
    return {
      archiveSha256,
      entries,
      descriptor,
      descriptorBytes,
      packageSignatureBytes: signatureBytes,
      registry,
      releaseKeyRegistryBytes: registryBytes,
      agentRuntimeLockBytes,
      remoteRuntimeLockBytes,
      agentManifest,
      runtimeManifest: runtime.manifest,
      agentManifestSha256,
      runtimeManifestDigest: runtime.manifestDigest,
      agent: {
        installationId: `agent-${agentManifestSha256}`,
        agentVersion: String(agentManifest.agentVersion),
        manifestSha256: agentManifestSha256,
        binaryDigest: `sha256:${agentManifestSha256}`,
        platform: 'linux',
        architecture,
        protocol: protocol(agentManifest.protocol, 'Agent protocol'),
        supervisor: 'detached-on-demand'
      },
      runtime: {
        runtimeId: 'opencode',
        runtimeVersion: String(runtime.manifest.runtimeVersion),
        bundleDigest: String(runtime.manifest.bundleDigest),
        manifestDigest: runtime.manifestDigest,
        runtimeAdapterDigest: String(runtime.manifest.adapterDigest),
        acpCapabilitiesDigest: String(runtime.manifest.acpCapabilitiesDigest),
        platform: 'linux',
        architecture,
        protocol: protocol(runtime.manifest.protocol, 'Runtime protocol')
      }
    }
  } finally {
    closeSync(handle)
  }
}

function assertAbsoluteInputs(
  options: InstallerOptions,
  createOperationRoot = true
): {
  operationRoot: string
  archive: string
  expectedSha256: string
} {
  if (
    !sha256Pattern.test(options.expectedSha256) ||
    resolve(options.operationRoot) !== options.operationRoot ||
    resolve(options.archive) !== options.archive
  ) {
    throw new Error('Installer paths must be absolute and archive SHA-256 must be lowercase hexadecimal')
  }
  const operationRoot = resolve(options.operationRoot)
  const archive = resolve(options.archive)
  if (
    operationRoot === resolve(options.homeDirectory ?? homedir()) ||
    operationRoot === dirname(operationRoot)
  ) {
    throw new Error('Installer operation root is unsafe')
  }
  if (createOperationRoot) {
    mkdirSync(operationRoot, { recursive: true, mode: 0o700 })
  }
  if (
    !existsSync(operationRoot) ||
    !statSync(operationRoot).isDirectory() ||
    lstatSync(operationRoot).isSymbolicLink()
  ) {
    throw new Error('Installer operation root is not a real directory')
  }
  return {
    operationRoot,
    archive,
    expectedSha256: options.expectedSha256
  }
}

function persistPreparedState(
  operationRoot: string,
  verified: VerifiedPackage
): void {
  const preparedRoot = join(operationRoot, 'prepared')
  if (existsSync(preparedRoot)) {
    const metadata = lstatSync(preparedRoot)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('Prepared package state directory is invalid')
    }
  } else {
    mkdirSync(preparedRoot, { recursive: false, mode: 0o700 })
  }
  writePreparedFile(
    preparedRoot,
    'agent-release-keys.json',
    verified.releaseKeyRegistryBytes
  )
  writePreparedFile(
    preparedRoot,
    'agent-runtime-lock.json',
    verified.agentRuntimeLockBytes
  )
  writePreparedFile(
    preparedRoot,
    'remote-runtime-lock.json',
    verified.remoteRuntimeLockBytes
  )
  writePreparedFile(
    preparedRoot,
    PACKAGE_DESCRIPTOR,
    verified.descriptorBytes
  )
  writePreparedFile(
    preparedRoot,
    PACKAGE_SIGNATURE,
    verified.packageSignatureBytes
  )
  const destination = join(preparedRoot, 'result.json')
  const temporary = join(
    preparedRoot,
    `.result-${process.pid}-${Date.now().toString(36)}.tmp`
  )
  const state: PreparedState = {
    formatVersion: 1,
    archiveSha256: verified.archiveSha256,
    releaseKeyRegistrySha256:
      sha256(verified.releaseKeyRegistryBytes),
    agentRuntimeLockSha256:
      sha256(verified.agentRuntimeLockBytes),
    remoteRuntimeLockSha256:
      sha256(verified.remoteRuntimeLockBytes),
    packageDescriptorSha256:
      sha256(verified.descriptorBytes),
    packageSignatureSha256:
      sha256(verified.packageSignatureBytes),
    agent: verified.agent,
    runtime: verified.runtime
  }
  const bytes = prettyBytes(state)
  if (bytes.length > MAXIMUM_METADATA_BYTES) {
    throw new Error('Prepared package state exceeds its limit')
  }
  writeBufferAtomically(destination, temporary, bytes)
}

function writePreparedFile(
  directory: string,
  name: string,
  bytes: Buffer
): void {
  if (
    bytes.byteLength <= 0 ||
    bytes.byteLength > MAXIMUM_METADATA_BYTES
  ) {
    throw new Error(`Prepared package metadata is invalid: ${name}`)
  }
  const destination = join(directory, name)
  const temporary = join(
    directory,
    `.${name}-${process.pid}-${Date.now().toString(36)}.tmp`
  )
  writeBufferAtomically(destination, temporary, bytes)
}

function writeBufferAtomically(
  destination: string,
  temporary: string,
  bytes: Buffer,
  replaceExistingOnWindows = false
): void {
  const handle = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600
  )
  try {
    let offset = 0
    while (offset < bytes.length) {
      offset += writeFileChunk(handle, bytes, offset)
    }
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  try {
    chmodSync(temporary, 0o600)
    if (
      replaceExistingOnWindows &&
      process.platform === 'win32' &&
      existsSync(destination)
    ) {
      unlinkSync(destination)
    }
    renameSync(temporary, destination)
  } finally {
    if (existsSync(temporary)) {
      unlinkSync(temporary)
    }
  }
}

function extractPayload(
  archive: string,
  destinationRoot: string,
  verified: VerifiedPackage
): void {
  if (existsSync(destinationRoot)) {
    throw new Error('Prepared package payload already exists')
  }
  const temporary = mkdtempSync(
    join(dirname(destinationRoot), '.payload-')
  )
  try {
    mkdirSync(join(temporary, 'agent'), { recursive: true, mode: 0o700 })
    mkdirSync(join(temporary, 'runtime'), { recursive: true, mode: 0o700 })
    const runtimePrefix =
      `runtime/opencode/${verified.runtime.bundleDigest.slice('sha256:'.length)}/`
    const declared = new Map(
      parseFiles(verified.descriptor.files, 'Agent package')
        .map((file) => [file.path, file])
    )
    const handle = openSync(
      archive,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    )
    try {
      const snapshot = fstatSync(handle)
      if (
        !snapshot.isFile() ||
        snapshot.size <= 0 ||
        snapshot.size > MAXIMUM_ARCHIVE_BYTES
      ) {
        throw new Error('Agent package archive is not a bounded regular file')
      }
      for (const [name, entry] of verified.entries) {
        let target: string | undefined
        if (name.startsWith('agent/')) {
          target = join(temporary, 'agent', ...name.slice(6).split('/'))
        } else if (name.startsWith(runtimePrefix)) {
          target = join(
            temporary,
            'runtime',
            ...name.slice(runtimePrefix.length).split('/')
          )
        }
        if (target !== undefined) {
          const actual = streamEntry(handle, entry, target)
          const expected = declared.get(name)
          if (
            expected === undefined ||
            actual.crc32 !== entry.checksum ||
            actual.sha256 !== expected.sha256
          ) {
            throw new Error(
              `Extracted package payload digest or checksum mismatch: ${name}`
            )
          }
        }
      }
      if (!sameSnapshot(snapshot, fstatSync(handle))) {
        throw new Error('Agent package archive changed during extraction')
      }
    } finally {
      closeSync(handle)
    }
    assertExtractedArchitectures(temporary, verified.agent.architecture)
    chmodSync(temporary, 0o700)
    renameSync(temporary, destinationRoot)
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

function eventEmitter(
  command: 'prepare' | 'commit',
  emit?: (event: PackageInstallerEvent) => void
): (phase: string) => void {
  return (phase) => emit?.({ type: 'progress', command, phase })
}

export function preparePackage(options: InstallerOptions): PackageInstallerResult {
  const inputs = assertAbsoluteInputs(options)
  const progress = eventEmitter('prepare', options.emit)
  progress('validating')
  const preparedRoot = join(inputs.operationRoot, 'prepared')
  const preparedStatePath = join(preparedRoot, 'result.json')
  if (existsSync(preparedStatePath)) {
    const state = readPreparedState(preparedStatePath)
    if (state.archiveSha256 !== inputs.expectedSha256) {
      throw new Error(
        'Prepared package state does not match the requested archive'
      )
    }
    const result: PackageInstallerResult = {
      type: 'result',
      command: 'prepare',
      status: 'prepared',
      archiveSha256: state.archiveSha256,
      agent: state.agent,
      runtime: state.runtime
    }
    options.emit?.(result)
    return result
  }
  const verified = verifyArchive(
    inputs.archive,
    inputs.expectedSha256,
    options.archiveSha256Verified === true,
    progress
  )
  try {
    mkdirSync(preparedRoot, { recursive: false, mode: 0o700 })
    progress('extracting-payload')
    extractPayload(
      inputs.archive,
      join(preparedRoot, 'payload'),
      verified
    )
    progress('persisting-prepared-state')
    persistPreparedState(inputs.operationRoot, verified)
  } catch (error) {
    rmSync(preparedRoot, { recursive: true, force: true })
    throw error
  }
  const result: PackageInstallerResult = {
    type: 'result',
    command: 'prepare',
    status: 'prepared',
    archiveSha256: verified.archiveSha256,
    agent: verified.agent,
    runtime: verified.runtime
  }
  options.emit?.(result)
  return result
}

type PublishedDirectory = {
  destination: string
  backupRoot?: string
  backup?: string
}

function publishDirectory(
  source: string,
  destination: string,
  operationRoot: string
): PublishedDirectory {
  assertOwnedManagedDirectory(dirname(destination))
  if (existsSync(destination)) {
    const destinationMetadata = lstatSync(destination)
    if (
      !destinationMetadata.isDirectory() ||
      destinationMetadata.isSymbolicLink() ||
      (
        typeof process.getuid === 'function' &&
        destinationMetadata.uid !== process.getuid()
      )
    ) {
      throw new Error(`Existing digest destination has conflicting content: ${destination}`)
    }
    const backupRoot = mkdtempSync(
      join(operationRoot, '.replaced-destination-')
    )
    const backup = join(backupRoot, 'payload')
    renameSync(destination, backup)
    try {
      renameSync(source, destination)
    } catch (error) {
      renameSync(backup, destination)
      rmSync(backupRoot, { recursive: true, force: true })
      throw new Error(
        'Prepared payload could not replace the conflicting managed destination',
        { cause: error }
      )
    }
    return { destination, backupRoot, backup }
  }
  try {
    renameSync(source, destination)
  } catch (error) {
    throw new Error(
      'Prepared payload could not be atomically published on the managed filesystem',
      { cause: error }
    )
  }
  return { destination }
}

function ensureOwnedManagedHierarchy(
  home: string,
  runtimeId: string
): void {
  assertOwnedManagedDirectory(home, false)
  const managedRoot = join(home, '.goodbuddy')
  for (const directory of [
    managedRoot,
    join(managedRoot, 'agent'),
    join(managedRoot, 'agent', 'installations'),
    join(managedRoot, 'runtimes'),
    join(managedRoot, 'runtimes', runtimeId)
  ]) {
    ensureOwnedManagedDirectory(directory)
  }
}

type LocalMetadataSnapshot = {
  path: string
  contents: Buffer | undefined
}

function snapshotLocalMetadata(
  paths: readonly string[]
): LocalMetadataSnapshot[] {
  return paths.map((path) => ({
    path,
    contents: existsSync(path)
      ? readBoundedRegularFile(
          path,
          MAXIMUM_METADATA_BYTES,
          'Managed environment metadata',
          '0600'
        )
      : undefined
  }))
}

function writePrivateFileAtomic(
  destination: string,
  contents: Buffer
): void {
  if (
    contents.byteLength <= 0 ||
    contents.byteLength > MAXIMUM_METADATA_BYTES
  ) {
    throw new Error('Managed environment metadata is invalid')
  }
  const temporary = join(
    dirname(destination),
    `.${basename(destination)}-${process.pid}-${Date.now().toString(36)}.tmp`
  )
  writeBufferAtomically(
    destination,
    temporary,
    contents,
    true
  )
}

function restoreLocalMetadata(
  snapshots: readonly LocalMetadataSnapshot[]
): void {
  const errors: unknown[] = []
  for (const snapshot of snapshots) {
    try {
      if (snapshot.contents === undefined) {
        rmSync(snapshot.path, { force: true })
      } else {
        writePrivateFileAtomic(
          snapshot.path,
          snapshot.contents
        )
      }
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'Managed environment metadata rollback was incomplete'
    )
  }
}

function ensureOwnedManagedDirectory(path: string): void {
  try {
    mkdirSync(path, { recursive: false, mode: 0o700 })
  } catch (error) {
    if (!isExistingPathError(error)) {
      throw error
    }
  }
  assertOwnedManagedDirectory(path)
}

function assertOwnedManagedDirectory(
  path: string,
  requirePrivateMode = true
): void {
  const metadata = lstatSync(path)
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (
      typeof process.getuid === 'function' &&
      metadata.uid !== process.getuid()
    ) ||
    (
      requirePrivateMode &&
      process.platform !== 'win32' &&
      (metadata.mode & 0o777) !== 0o700
    )
  ) {
    throw new Error(
      `Managed installation directory is unsafe: ${path}`
    )
  }
}

function isExistingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  )
}

function restoreReplacedDirectory(published: PublishedDirectory): void {
  if (!published.backup || !published.backupRoot) {
    return
  }
  rmSync(published.destination, { recursive: true, force: true })
  renameSync(published.backup, published.destination)
  rmSync(published.backupRoot, { recursive: true, force: true })
}

function discardReplacedDirectory(published: PublishedDirectory): void {
  if (published.backupRoot) {
    try {
      rmSync(published.backupRoot, { recursive: true, force: true })
    } catch {
      // The bootstrap removes the bounded operation root after commit.
    }
  }
}

function readPreparedState(path: string): PreparedState {
  const bytes = readBoundedRegularFile(
    path,
    MAXIMUM_METADATA_BYTES,
    'Prepared package state',
    '0600'
  )
  const value = parseCanonicalJson(bytes, 'Prepared package state')
  exactKeys(
    value,
    [
      'formatVersion',
      'archiveSha256',
      'releaseKeyRegistrySha256',
      'agentRuntimeLockSha256',
      'remoteRuntimeLockSha256',
      'packageDescriptorSha256',
      'packageSignatureSha256',
      'agent',
      'runtime'
    ],
    'Prepared package state'
  )
  if (
    value.formatVersion !== 1 ||
    !sha256Pattern.test(String(value.archiveSha256)) ||
    !sha256Pattern.test(
      String(value.releaseKeyRegistrySha256)
    ) ||
    !sha256Pattern.test(
      String(value.agentRuntimeLockSha256)
    ) ||
    !sha256Pattern.test(
      String(value.remoteRuntimeLockSha256)
    ) ||
    !sha256Pattern.test(
      String(value.packageDescriptorSha256)
    ) ||
    !sha256Pattern.test(
      String(value.packageSignatureSha256)
    ) ||
    !isRecord(value.agent) ||
    !isRecord(value.runtime)
  ) {
    throw new Error('Prepared package state is invalid')
  }
  const agent = value.agent
  const runtime = value.runtime
  exactKeys(
    agent,
    [
      'installationId',
      'agentVersion',
      'manifestSha256',
      'binaryDigest',
      'platform',
      'architecture',
      'protocol',
      'supervisor'
    ],
    'Prepared Agent identity'
  )
  exactKeys(
    runtime,
    [
      'runtimeId',
      'runtimeVersion',
      'bundleDigest',
      'manifestDigest',
      'runtimeAdapterDigest',
      'acpCapabilitiesDigest',
      'platform',
      'architecture',
      'protocol'
    ],
    'Prepared Runtime identity'
  )
  const agentProtocol = protocol(agent.protocol, 'Prepared Agent protocol')
  const runtimeProtocol = protocol(
    runtime.protocol,
    'Prepared Runtime protocol'
  )
  if (
    typeof agent.installationId !== 'string' ||
    !versionPattern.test(String(agent.agentVersion)) ||
    !sha256Pattern.test(String(agent.manifestSha256)) ||
    agent.installationId !== `agent-${String(agent.manifestSha256)}` ||
    agent.binaryDigest !== `sha256:${String(agent.manifestSha256)}` ||
    agent.platform !== 'linux' ||
    !['x64', 'arm64'].includes(String(agent.architecture)) ||
    agent.supervisor !== 'detached-on-demand' ||
    runtime.runtimeId !== 'opencode' ||
    !versionPattern.test(String(runtime.runtimeVersion)) ||
    !digestPattern.test(String(runtime.bundleDigest)) ||
    !digestPattern.test(String(runtime.manifestDigest)) ||
    !digestPattern.test(String(runtime.runtimeAdapterDigest)) ||
    !digestPattern.test(String(runtime.acpCapabilitiesDigest)) ||
    runtime.platform !== 'linux' ||
    runtime.architecture !== agent.architecture
  ) {
    throw new Error('Prepared package state identity is invalid')
  }
  return {
    formatVersion: 1,
    archiveSha256: String(value.archiveSha256),
    releaseKeyRegistrySha256:
      String(value.releaseKeyRegistrySha256),
    agentRuntimeLockSha256:
      String(value.agentRuntimeLockSha256),
    remoteRuntimeLockSha256:
      String(value.remoteRuntimeLockSha256),
    packageDescriptorSha256:
      String(value.packageDescriptorSha256),
    packageSignatureSha256:
      String(value.packageSignatureSha256),
    agent: {
      installationId: agent.installationId,
      agentVersion: String(agent.agentVersion),
      manifestSha256: String(agent.manifestSha256),
      binaryDigest: String(agent.binaryDigest),
      platform: 'linux',
      architecture: agent.architecture as Architecture,
      protocol: agentProtocol,
      supervisor: 'detached-on-demand'
    },
    runtime: {
      runtimeId: 'opencode',
      runtimeVersion: String(runtime.runtimeVersion),
      bundleDigest: String(runtime.bundleDigest),
      manifestDigest: String(runtime.manifestDigest),
      runtimeAdapterDigest: String(runtime.runtimeAdapterDigest),
      acpCapabilitiesDigest: String(runtime.acpCapabilitiesDigest),
      platform: 'linux',
      architecture: runtime.architecture as Architecture,
      protocol: runtimeProtocol
    }
  }
}

function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
  label: string,
  expectedMode: '0600' | '0644' | '0755'
): Buffer {
  const handle = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  )
  try {
    const snapshot = fstatSync(handle)
    const getuid = process.getuid
    const expectedPermissions =
      expectedMode === '0755'
        ? 0o755
        : expectedMode === '0600'
          ? 0o600
          : 0o644
    if (
      !snapshot.isFile() ||
      snapshot.size <= 0 ||
      snapshot.size > maximumBytes ||
      (getuid !== undefined && snapshot.uid !== getuid.call(process)) ||
      (
        process.platform !== 'win32' &&
        (snapshot.mode & 0o777) !== expectedPermissions
      )
    ) {
      throw new Error(`${label} is not a bounded trusted regular file`)
    }
    const bytes = readExact(handle, snapshot.size, 0, label)
    if (!sameSnapshot(snapshot, fstatSync(handle))) {
      throw new Error(`${label} changed while it was read`)
    }
    return bytes
  } finally {
    closeSync(handle)
  }
}

function assertPreparedIdentity(
  agentRoot: string,
  runtimeRoot: string,
  state: PreparedState,
  releaseKeyRegistryBytes: Buffer,
  agentRuntimeLockBytes: Buffer,
  remoteRuntimeLockBytes: Buffer,
  descriptorBytes: Buffer,
  packageSignatureBytes: Buffer
): void {
  const descriptor = parseCanonicalJson(
    descriptorBytes,
    'Prepared Agent package descriptor'
  )
  const declared = parseFiles(
    descriptor.files,
    'Prepared Agent package'
  )
  const entries = new Map<string, ZipEntry>()
  for (const file of declared) {
    entries.set(file.path, {
      name: file.path,
      size: file.size,
      checksum: 0,
      mode: file.mode,
      dataOffset: 0,
      recordStart: 0,
      recordEnd: 0
    })
  }
  for (const name of [PACKAGE_DESCRIPTOR, PACKAGE_SIGNATURE]) {
    entries.set(name, {
      name,
      size: name === PACKAGE_DESCRIPTOR
        ? descriptorBytes.byteLength
        : packageSignatureBytes.byteLength,
      checksum: 0,
      mode: '0644',
      dataOffset: 0,
      recordStart: 0,
      recordEnd: 0
    })
  }
  const registry = parseRegistry(releaseKeyRegistryBytes)
  const packageFiles = new Map(
    assertOuterDescriptor(
      descriptor,
      descriptorBytes,
      entries,
      registry,
      packageSignatureBytes
    ).map((file) => [file.path, file])
  )
  const agentManifestBytes = readBoundedRegularFile(
    join(agentRoot, 'manifest.json'),
    MAXIMUM_METADATA_BYTES,
    'Prepared Agent manifest',
    '0644'
  )
  const agentManifest = assertAgentManifest(
    agentManifestBytes,
    readBoundedRegularFile(
      join(agentRoot, 'manifest.sig'),
      MAXIMUM_METADATA_BYTES,
      'Prepared Agent manifest signature',
      '0644'
    ),
    registry,
    parseCanonicalJson(
      agentRuntimeLockBytes,
      'Prepared Agent runtime lock'
    ),
    descriptor,
    packageFiles
  )
  const runtime = assertRuntimeManifest(
    readBoundedRegularFile(
      join(runtimeRoot, 'manifest.json'),
      MAXIMUM_METADATA_BYTES,
      'Prepared Runtime manifest',
      '0644'
    ),
    readBoundedRegularFile(
      join(runtimeRoot, 'manifest.sig'),
      MAXIMUM_METADATA_BYTES,
      'Prepared Runtime manifest signature',
      '0644'
    ),
    registry,
    parseCanonicalJson(
      remoteRuntimeLockBytes,
      'Prepared Remote Runtime lock'
    ),
    descriptor,
    packageFiles
  )
  const agentManifestSha256 = sha256(agentManifestBytes)
  const architecture = descriptor.architecture as Architecture
  const expectedAgent: PackageInstallerAgentIdentity = {
    installationId: `agent-${agentManifestSha256}`,
    agentVersion: String(agentManifest.agentVersion),
    manifestSha256: agentManifestSha256,
    binaryDigest: `sha256:${agentManifestSha256}`,
    platform: 'linux',
    architecture,
    protocol: protocol(agentManifest.protocol, 'Agent protocol'),
    supervisor: 'detached-on-demand'
  }
  const expectedRuntime: PackageInstallerRuntimeIdentity = {
    runtimeId: 'opencode',
    runtimeVersion: String(runtime.manifest.runtimeVersion),
    bundleDigest: String(runtime.manifest.bundleDigest),
    manifestDigest: runtime.manifestDigest,
    runtimeAdapterDigest: String(runtime.manifest.adapterDigest),
    acpCapabilitiesDigest: String(
      runtime.manifest.acpCapabilitiesDigest
    ),
    platform: 'linux',
    architecture,
    protocol: protocol(
      runtime.manifest.protocol,
      'Runtime protocol'
    )
  }
  if (
    canonicalJson(state.agent) !== canonicalJson(expectedAgent) ||
    canonicalJson(state.runtime) !== canonicalJson(expectedRuntime)
  ) {
    throw new Error(
      'Prepared package identity does not match the authenticated archive'
    )
  }
}

export function commitPackage(options: InstallerOptions): PackageInstallerResult {
  const inputs = assertAbsoluteInputs(options, false)
  const progress = eventEmitter('commit', options.emit)
  progress('validating-prepared-state')
  const preparedRoot = join(inputs.operationRoot, 'prepared')
  if (
    !existsSync(preparedRoot) ||
    !lstatSync(preparedRoot).isDirectory() ||
    lstatSync(preparedRoot).isSymbolicLink()
  ) {
    throw new Error('Prepared package state directory is invalid')
  }
  const state = readPreparedState(join(preparedRoot, 'result.json'))
  if (state.archiveSha256 !== inputs.expectedSha256) {
    throw new Error('Prepared package state does not match the requested archive')
  }
  const releaseKeyRegistryBytes = readBoundedRegularFile(
    join(preparedRoot, 'agent-release-keys.json'),
    MAXIMUM_METADATA_BYTES,
    'Prepared Agent release-key registry',
    '0600'
  )
  const agentRuntimeLockBytes = readBoundedRegularFile(
    join(preparedRoot, 'agent-runtime-lock.json'),
    MAXIMUM_METADATA_BYTES,
    'Prepared Agent runtime lock',
    '0600'
  )
  const remoteRuntimeLockBytes = readBoundedRegularFile(
    join(preparedRoot, 'remote-runtime-lock.json'),
    MAXIMUM_METADATA_BYTES,
    'Prepared Remote Runtime lock',
    '0600'
  )
  const descriptorBytes = readBoundedRegularFile(
    join(preparedRoot, PACKAGE_DESCRIPTOR),
    MAXIMUM_METADATA_BYTES,
    'Prepared Agent package descriptor',
    '0600'
  )
  const packageSignatureBytes = readBoundedRegularFile(
    join(preparedRoot, PACKAGE_SIGNATURE),
    MAXIMUM_METADATA_BYTES,
    'Prepared Agent package signature',
    '0600'
  )
  if (
    sha256(releaseKeyRegistryBytes) !==
      state.releaseKeyRegistrySha256 ||
    sha256(agentRuntimeLockBytes) !==
      state.agentRuntimeLockSha256 ||
    sha256(remoteRuntimeLockBytes) !==
      state.remoteRuntimeLockSha256 ||
    sha256(descriptorBytes) !==
      state.packageDescriptorSha256 ||
    sha256(packageSignatureBytes) !==
      state.packageSignatureSha256
  ) {
    throw new Error(
      'Prepared package metadata does not match its authenticated identity'
    )
  }
  const payloadRoot = join(preparedRoot, 'payload')
  if (
    !existsSync(payloadRoot) ||
    !lstatSync(payloadRoot).isDirectory() ||
    lstatSync(payloadRoot).isSymbolicLink()
  ) {
    throw new Error('Prepared package payload directory is invalid')
  }
  const agentSource = join(payloadRoot, 'agent')
  const runtimeSource = join(payloadRoot, 'runtime')
  const agentSourceExists = existsSync(agentSource)
  const runtimeSourceExists = existsSync(runtimeSource)
  if (agentSourceExists && runtimeSourceExists) {
    assertPreparedIdentity(
      agentSource,
      runtimeSource,
      state,
      releaseKeyRegistryBytes,
      agentRuntimeLockBytes,
      remoteRuntimeLockBytes,
      descriptorBytes,
      packageSignatureBytes
    )
  }
  const home = resolve(options.homeDirectory ?? homedir())
  const managedRoot = join(home, '.goodbuddy')
  ensureOwnedManagedHierarchy(
    home,
    state.runtime.runtimeId
  )
  const agentDestination = join(
    managedRoot,
    'agent',
    'installations',
    state.agent.installationId
  )
  const runtimeDestination = join(
    managedRoot,
    'runtimes',
    state.runtime.runtimeId,
    state.runtime.bundleDigest.slice('sha256:'.length)
  )
  const metadataPaths = [
    join(managedRoot, 'agent', 'release-keys.json'),
    join(managedRoot, 'runtimes', 'release-keys.json'),
    join(managedRoot, 'runtimes', 'remote-runtime-lock.json')
  ] as const
  if (!agentSourceExists || !runtimeSourceExists) {
    assertPreparedIdentity(
      agentSourceExists ? agentSource : agentDestination,
      runtimeSourceExists ? runtimeSource : runtimeDestination,
      state,
      releaseKeyRegistryBytes,
      agentRuntimeLockBytes,
      remoteRuntimeLockBytes,
      descriptorBytes,
      packageSignatureBytes
    )
  }
  progress('publishing-content')
  const metadataSnapshots = snapshotLocalMetadata(metadataPaths)
  const published: PublishedDirectory[] = []
  try {
    if (agentSourceExists) {
      published.push(
        publishDirectory(
          agentSource,
          agentDestination,
          inputs.operationRoot
        )
      )
    }
    if (runtimeSourceExists) {
      published.push(
        publishDirectory(
          runtimeSource,
          runtimeDestination,
          inputs.operationRoot
        )
      )
    }
    progress('publishing-metadata')
    writePrivateFileAtomic(
      metadataPaths[0],
      releaseKeyRegistryBytes
    )
    writePrivateFileAtomic(
      metadataPaths[1],
      releaseKeyRegistryBytes
    )
    writePrivateFileAtomic(
      metadataPaths[2],
      remoteRuntimeLockBytes
    )
    for (const entry of published) {
      discardReplacedDirectory(entry)
    }
    const result: PackageInstallerResult = {
      type: 'result',
      command: 'commit',
      status: 'committed',
      archiveSha256: state.archiveSha256,
      agent: state.agent,
      runtime: state.runtime
    }
    options.emit?.(result)
    return result
  } catch (error) {
    const rollbackErrors: unknown[] = []
    try {
      restoreLocalMetadata(metadataSnapshots)
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError)
    }
    for (const entry of [...published].reverse()) {
      try {
        restoreReplacedDirectory(entry)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length > 0) {
      throw new PackageInstallerRollbackIncompleteError(
        [error, ...rollbackErrors],
        'Package commit failed and managed state could not be fully restored',
        { cause: error }
      )
    }
    throw error
  }
}

function parseCli(argv: readonly string[]): {
  command: 'prepare' | 'commit'
  options: InstallerOptions
} {
  const command = argv[0]
  if (command !== 'prepare' && command !== 'commit') {
    throw new Error(
      'Usage: remote-package-installer.mjs <prepare|commit> --operation-root <absolute-path> --archive <absolute-path> --expected-sha256 <hex> [--archive-sha256-verified true]'
    )
  }
  const values: Record<string, string> = {}
  const required = [
    '--operation-root',
    '--archive',
    '--expected-sha256'
  ] as const
  const allowed = new Set([
    ...required,
    '--archive-sha256-verified'
  ])
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (
      flag === undefined ||
      value === undefined ||
      value.startsWith('--') ||
      !allowed.has(flag) ||
      values[flag] !== undefined
    ) {
      throw new Error('Invalid package installer argument')
    }
    values[flag] = value
  }
  for (const flag of required) {
    if (values[flag] === undefined) {
      throw new Error(`Missing required package installer argument: ${flag}`)
    }
  }
  if (
    values['--archive-sha256-verified'] !== undefined &&
    values['--archive-sha256-verified'] !== 'true'
  ) {
    throw new Error('Invalid package installer argument')
  }
  return {
    command,
    options: {
      operationRoot: values['--operation-root']!,
      archive: values['--archive']!,
      expectedSha256: values['--expected-sha256']!,
      archiveSha256Verified:
        values['--archive-sha256-verified'] === 'true'
    }
  }
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n]+/gu, ' ').slice(0, 2_000)
}

export function runPackageInstallerCli(
  argv: readonly string[] = process.argv.slice(2)
): number {
  let command: 'prepare' | 'commit' = argv[0] === 'commit' ? 'commit' : 'prepare'
  const emit = (event: PackageInstallerEvent): void => {
    process.stdout.write(`${JSON.stringify(event)}\n`)
  }
  try {
    const parsed = parseCli(argv)
    command = parsed.command
    const options = { ...parsed.options, emit }
    if (command === 'prepare') {
      preparePackage(options)
    } else {
      commitPackage(options)
    }
    return 0
  } catch (error) {
    emit({
      type: 'error',
      command,
      status:
        error instanceof PackageInstallerRollbackIncompleteError
          ? 'rollback-incomplete'
          : 'failed',
      message: boundedMessage(error)
    })
    return 1
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  process.exitCode = runPackageInstallerCli()
}
