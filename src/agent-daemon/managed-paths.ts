import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import type { Stats } from 'node:fs'
import {
  dirname,
  isAbsolute,
  parse,
  relative,
  resolve,
  sep
} from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'

export class ManagedPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManagedPathError'
  }
}

function assertOwner(stat: Stats, label: string): void {
  const uid = process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) {
    throw new ManagedPathError(`${label} is not owned by the current user`)
  }
}

export function assertAbsoluteManagedPath(path: string): string {
  if (path.includes('\0')) {
    throw new ManagedPathError('Managed paths cannot contain NUL')
  }
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new ManagedPathError('Managed paths must be normalized absolute paths')
  }
  assertNoSymlinkComponents(path)
  return path
}

export function ensurePrivateDirectory(
  path: string,
  options: { create?: boolean } = {}
): void {
  assertAbsoluteManagedPath(path)
  let created = false
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ManagedPathError('Managed directory is not a real directory')
    }
    assertOwner(stat, 'Managed directory')
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new ManagedPathError('Managed directory permissions must be 0700')
    }
  } catch (error) {
    if (
      error instanceof ManagedPathError ||
      !isNodeError(error) ||
      error.code !== 'ENOENT' ||
      options.create === false
    ) {
      throw error
    }
    mkdirSync(path, { mode: 0o700 })
    created = true
  }
  if (created && process.platform !== 'win32') {
    chmodSync(path, 0o700)
  }
}

function assertNoSymlinkComponents(path: string): void {
  const root = parse(path).root
  const components = relative(root, path).split(sep).filter(Boolean)
  let current = root
  for (const component of components) {
    current = resolve(current, component)
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new ManagedPathError('Managed paths cannot traverse a symlink')
      }
    } catch (error) {
      if (
        error instanceof ManagedPathError ||
        !isNodeError(error) ||
        error.code !== 'ENOENT'
      ) {
        throw error
      }
      return
    }
  }
}

export function ensurePrivateDirectoryTree(path: string, anchor: string): void {
  const normalizedPath = assertAbsoluteManagedPath(path)
  const normalizedAnchor = assertAbsoluteManagedPath(anchor)
  if (
    normalizedPath !== normalizedAnchor &&
    !normalizedPath.startsWith(`${normalizedAnchor}${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new ManagedPathError('Managed path escapes its configured anchor')
  }
  const relative = normalizedPath.slice(normalizedAnchor.length)
  ensurePrivateDirectory(normalizedAnchor)
  let current = normalizedAnchor
  for (const segment of relative.split(/[\\/]/u).filter(Boolean)) {
    current = resolve(current, segment)
    ensurePrivateDirectory(current)
  }
}

export function assertPrivateRegularFile(path: string): void {
  assertAbsoluteManagedPath(path)
  const stat = lstatSync(path)
  assertPrivateRegularFileStat(stat)
}

function assertPrivateRegularFileStat(stat: Stats): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ManagedPathError('Managed file is not a regular file')
  }
  assertOwner(stat, 'Managed file')
  if (process.platform !== 'win32' && (stat.mode & 0o177) !== 0) {
    throw new ManagedPathError('Managed file permissions must be 0600')
  }
}

export function readOrCreatePrivateSecret(path: string): Buffer {
  assertAbsoluteManagedPath(path)
  ensurePrivateDirectory(dirname(path), { create: false })
  const noFollow = constants.O_NOFOLLOW ?? 0
  let descriptor: number
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow,
      0o600
    )
    const secret = randomBytes(32)
    try {
      writeFileSync(descriptor, secret)
      if (process.platform !== 'win32') {
        fchmodSync(descriptor, 0o600)
      }
    } finally {
      closeSync(descriptor)
    }
    return secret
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') {
      throw error
    }
  }
  assertPrivateRegularFile(path)
  descriptor = openSync(path, constants.O_RDONLY | noFollow)
  try {
    const stat = fstatSync(descriptor)
    assertPrivateRegularFileStat(stat)
    if (stat.size !== 32) {
      throw new ManagedPathError('Installation identity must contain 32 bytes')
    }
    const output = Buffer.alloc(32)
    if (readSync(descriptor, output, 0, output.length, 0) !== output.length) {
      throw new ManagedPathError('Installation identity could not be read')
    }
    return output
  } finally {
    closeSync(descriptor)
  }
}

export function readPrivateSecret(path: string): Buffer {
  const output = readPrivateFile(path, 32)
  if (output.byteLength !== 32) {
    throw new ManagedPathError('Installation identity must contain 32 bytes')
  }
  return output
}

export function readPrivateFile(path: string, maximumBytes: number): Buffer {
  assertAbsoluteManagedPath(path)
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new ManagedPathError('Managed file size limit is invalid')
  }
  const noFollow = constants.O_NOFOLLOW ?? 0
  const descriptor = openSync(path, constants.O_RDONLY | noFollow)
  try {
    const stat = fstatSync(descriptor)
    assertPrivateRegularFileStat(stat)
    if (stat.size > maximumBytes) {
      throw new ManagedPathError('Managed file exceeds its size limit')
    }
    const output = Buffer.alloc(stat.size)
    if (
      stat.size > 0 &&
      readSync(descriptor, output, 0, output.length, 0) !== output.length
    ) {
      throw new ManagedPathError('Managed file could not be read')
    }
    return output
  } finally {
    closeSync(descriptor)
  }
}

export function writePrivateFileAtomic(path: string, contents: string): void {
  assertAbsoluteManagedPath(path)
  ensurePrivateDirectory(dirname(path), { create: false })
  assertPrivateTargetIfPresent(path)
  const temporary = `${path}.tmp-${randomBytes(12).toString('hex')}`
  const noFollow = constants.O_NOFOLLOW ?? 0
  const descriptor = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
    0o600
  )
  let descriptorOpen = true
  let renamed = false
  let operationError: unknown
  try {
    writeFileSync(descriptor, contents, { encoding: 'utf8' })
    if (process.platform !== 'win32') {
      fchmodSync(descriptor, 0o600)
    }
    closeSync(descriptor)
    descriptorOpen = false
    assertPrivateTargetIfPresent(path)
    renameSync(temporary, path)
    renamed = true
    assertPrivateRegularFile(path)
  } catch (error) {
    operationError = error
  }
  if (descriptorOpen) {
    try {
      closeSync(descriptor)
    } catch (error) {
      operationError ??= error
    }
  }
  if (!renamed) {
    try {
      unlinkSync(temporary)
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        operationError ??= error
      }
    }
  }
  if (operationError !== undefined) {
    throw operationError
  }
}

export function unlinkOwnedPrivateFile(path: string): void {
  assertPrivateRegularFile(path)
  unlinkSync(path)
}

const TEMP_ROOT_MARKER = '.goodbuddy-private-root-v1'

export type PrivateTemporaryRootIdentity = {
  rootPath: string
  uid: number
  canonicalHomeDirectory: string
}

export function derivePrivateTemporaryRoot(options: {
  uid?: number
  homeDirectory?: string
  temporaryDirectory?: string
  platform?: NodeJS.Platform
} = {}): PrivateTemporaryRootIdentity {
  const platform = options.platform ?? process.platform
  const uid = options.uid ?? process.getuid?.()
  if (
    platform !== 'linux' ||
    uid === undefined ||
    !Number.isSafeInteger(uid) ||
    uid < 0
  ) {
    throw new ManagedPathError(
      'Private Agent endpoint root requires a current Linux UID'
    )
  }
  const canonicalHomeDirectory = resolve(
    options.homeDirectory ?? homedir()
  )
  const temporaryDirectory = resolve(
    options.temporaryDirectory ?? '/tmp'
  )
  assertAbsoluteManagedPath(canonicalHomeDirectory)
  assertAbsoluteManagedPath(temporaryDirectory)
  const homeHash = createHash('sha256')
    .update(`${uid}\0${canonicalHomeDirectory}`, 'utf8')
    .digest('hex')
    .slice(0, 20)
  return {
    rootPath: resolve(
      temporaryDirectory,
      `goodbuddy-${uid}-${homeHash}`
    ),
    uid,
    canonicalHomeDirectory
  }
}

export function ensurePrivateTemporaryRoot(
  identityInput: PrivateTemporaryRootIdentity
): string {
  const identity = {
    rootPath: assertAbsoluteManagedPath(identityInput.rootPath),
    uid: identityInput.uid,
    canonicalHomeDirectory: assertAbsoluteManagedPath(
      identityInput.canonicalHomeDirectory
    )
  }
  if (!Number.isSafeInteger(identity.uid) || identity.uid < 0) {
    throw new ManagedPathError('Private Agent endpoint root UID is invalid')
  }
  ensurePrivateDirectory(identity.rootPath)
  const markerPath = resolve(identity.rootPath, TEMP_ROOT_MARKER)
  const expected = `${JSON.stringify({
    formatVersion: 1,
    uid: identity.uid,
    canonicalHomeDirectory: identity.canonicalHomeDirectory
  }, null, 2)}\n`
  try {
    assertPrivateRegularFile(markerPath)
    if (readPrivateText(markerPath) !== expected) {
      throw new ManagedPathError(
        'Private Agent endpoint root marker does not match this user'
      )
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error
    }
    writePrivateFileAtomic(markerPath, expected)
  }
  return identity.rootPath
}

function readPrivateText(path: string): string {
  return readPrivateFile(path, 16 * 1024).toString('utf8')
}

function assertPrivateTargetIfPresent(path: string): void {
  try {
    assertPrivateRegularFile(path)
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
