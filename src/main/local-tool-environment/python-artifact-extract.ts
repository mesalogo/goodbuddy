import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, posix, resolve, sep } from 'node:path'
import { unzipSync } from 'fflate'
import { extract, list, type ReadEntry } from 'tar'
import type { PythonArtifact } from './python-artifact-catalog'

const MAX_ENTRIES = 20_000
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024
const zipSignature = 0x02014b50

type SafeEntry = {
  archivePath: string
  outputPath: string
  type: 'file' | 'directory' | 'symlink'
  mode?: number
  linkPath?: string
  size: number
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The operation was aborted', 'AbortError')
  }
}

function safePayloadPath(
  path: string,
  root: string,
  ignoreOutsideRoot = false
): string | undefined {
  if (
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[a-zA-Z]:/u.test(path)
  ) {
    throw new Error(`Unsafe archive path: ${path}`)
  }
  const normalized = posix.normalize(path)
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized !== path.replace(/\/+$/u, '')
  ) {
    throw new Error(`Unsafe archive path: ${path}`)
  }
  if (normalized === root) {
    return undefined
  }
  const prefix = `${root}/`
  if (!normalized.startsWith(prefix)) {
    if (ignoreOutsideRoot) {
      return undefined
    }
    throw new Error(`Archive entry is outside payload root ${root}: ${path}`)
  }
  const relative = normalized.slice(prefix.length)
  if (!relative) {
    return undefined
  }
  return relative
}

function destinationPath(root: string, relative: string): string {
  const destination = resolve(root, ...relative.split('/'))
  const prefix = `${resolve(root)}${sep}`
  if (!destination.startsWith(prefix)) {
    throw new Error(`Archive path escaped destination: ${relative}`)
  }
  return destination
}

function ensureSafeSymlink(relative: string, target: string): void {
  if (
    !target ||
    target.includes('\\') ||
    target.includes('\0') ||
    target.startsWith('/') ||
    /^[a-zA-Z]:/u.test(target)
  ) {
    throw new Error(`Unsafe archive symlink: ${relative}`)
  }
  const resolved = posix.normalize(posix.join(posix.dirname(relative), target))
  if (resolved === '..' || resolved.startsWith('../') || posix.isAbsolute(resolved)) {
    throw new Error(`Archive symlink escapes payload root: ${relative}`)
  }
}

function verifyEntrySet(entries: SafeEntry[]): void {
  if (entries.length === 0 || entries.length > MAX_ENTRIES) {
    throw new Error('Archive has an invalid number of payload entries')
  }
  let expanded = 0
  const seen = new Set<string>()
  for (const entry of entries) {
    const key = entry.outputPath.toLowerCase()
    if (seen.has(key)) {
      throw new Error(`Archive contains duplicate path: ${entry.outputPath}`)
    }
    seen.add(key)
    expanded += entry.size
    if (!Number.isSafeInteger(expanded) || expanded > MAX_EXPANDED_BYTES) {
      throw new Error('Archive expanded size exceeds the limit')
    }
  }
}

function readZipEntries(data: Buffer, root: string): SafeEntry[] {
  const entries: SafeEntry[] = []
  for (let offset = 0; offset + 46 <= data.length;) {
    if (data.readUInt32LE(offset) !== zipSignature) {
      offset += 1
      continue
    }
    const madeBy = data.readUInt16LE(offset + 4)
    const flags = data.readUInt16LE(offset + 8)
    const size = data.readUInt32LE(offset + 24)
    const nameLength = data.readUInt16LE(offset + 28)
    const extraLength = data.readUInt16LE(offset + 30)
    const commentLength = data.readUInt16LE(offset + 32)
    const attrs = data.readUInt32LE(offset + 38)
    const end = offset + 46 + nameLength + extraLength + commentLength
    if (end > data.length || (flags & 1) !== 0) {
      throw new Error('ZIP central directory is invalid or encrypted')
    }
    const archivePath = data.subarray(offset + 46, offset + 46 + nameLength)
      .toString((flags & 0x800) !== 0 ? 'utf8' : 'latin1')
    const relative = safePayloadPath(archivePath, root, true)
    if (relative) {
      const unixMode = (madeBy >>> 8) === 3 ? (attrs >>> 16) & 0xffff : undefined
      const fileType = unixMode === undefined ? 0 : unixMode & 0xf000
      if (fileType !== 0 && fileType !== 0x8000 && fileType !== 0x4000) {
        throw new Error(`ZIP contains a special file or link: ${archivePath}`)
      }
      entries.push({
        archivePath,
        outputPath: relative,
        type: archivePath.endsWith('/') || fileType === 0x4000
          ? 'directory'
          : 'file',
        mode: unixMode === undefined ? undefined : unixMode & 0o777,
        size
      })
    }
    offset = end
  }
  verifyEntrySet(entries)
  return entries
}

async function extractNuget(
  archivePath: string,
  destination: string,
  root: string,
  signal?: AbortSignal
): Promise<void> {
  ensureNotAborted(signal)
  const data = await readFile(archivePath)
  const entries = readZipEntries(data, root)
  const payloadPaths = new Set(entries.map((entry) => entry.archivePath))
  const unzipped = unzipSync(data, {
    filter: ({ name }) => payloadPaths.has(name)
  })
  for (const entry of entries.sort((left, right) =>
    left.type === 'directory' && right.type !== 'directory' ? -1 : 0
  )) {
    ensureNotAborted(signal)
    const output = destinationPath(destination, entry.outputPath)
    if (entry.type === 'directory') {
      await mkdir(output, { recursive: true, mode: entry.mode })
      continue
    }
    const content = unzipped[entry.archivePath]
    if (!content || content.byteLength !== entry.size) {
      throw new Error(`ZIP payload is missing or corrupt: ${entry.archivePath}`)
    }
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, content, { flag: 'wx', mode: entry.mode })
    if (entry.mode !== undefined && process.platform !== 'win32') {
      await chmod(output, entry.mode)
    }
  }
}

function tarEntry(entry: ReadEntry, root: string): SafeEntry | undefined {
  const relative = safePayloadPath(entry.path.replace(/\/+$/u, ''), root)
  if (!relative) {
    return undefined
  }
  if (entry.type === 'SymbolicLink') {
    const linkPath = entry.linkpath ?? ''
    ensureSafeSymlink(relative, linkPath)
    return {
      archivePath: entry.path,
      outputPath: relative,
      type: 'symlink',
      mode: entry.mode === undefined ? undefined : entry.mode & 0o777,
      linkPath,
      size: 0
    }
  }
  if (entry.type !== 'File' && entry.type !== 'Directory') {
    throw new Error(`TAR contains unsupported entry type ${entry.type}: ${entry.path}`)
  }
  return {
    archivePath: entry.path,
    outputPath: relative,
    type: entry.type === 'Directory' ? 'directory' : 'file',
    mode: entry.mode === undefined ? undefined : entry.mode & 0o777,
    size: entry.size
  }
}

async function extractTar(
  archivePath: string,
  destination: string,
  root: string,
  signal?: AbortSignal
): Promise<void> {
  const entries: SafeEntry[] = []
  let validationError: Error | undefined
  await list({
    file: archivePath,
    gzip: true,
    strict: true,
    onReadEntry: (entry) => {
      try {
        ensureNotAborted(signal)
        const safe = tarEntry(entry, root)
        if (safe) {
          entries.push(safe)
        }
      } catch (error) {
        validationError ??= error instanceof Error
          ? error
          : new Error('TAR validation failed')
        entry.resume()
      }
    }
  })
  if (validationError) {
    throw validationError
  }
  verifyEntrySet(entries)
  const allowed = new Map(entries.map((entry) => [entry.archivePath, entry]))
  await extract({
    file: archivePath,
    cwd: destination,
    gzip: true,
    strip: 1,
    strict: true,
    preservePaths: false,
    noChmod: false,
    filter: (path, entry) => {
      ensureNotAborted(signal)
      const expected = allowed.get(path)
      if (!expected) {
        return path.replace(/\/+$/u, '') === root
      }
      const checked = tarEntry(entry as ReadEntry, root)
      return checked?.outputPath === expected.outputPath &&
        checked.type === expected.type
    }
  })
  for (const entry of entries) {
    const output = destinationPath(destination, entry.outputPath)
    const status = await lstat(output)
    if (
      (entry.type === 'file' && !status.isFile()) ||
      (entry.type === 'directory' && !status.isDirectory()) ||
      (entry.type === 'symlink' && !status.isSymbolicLink())
    ) {
      throw new Error(`Extracted TAR entry has the wrong type: ${entry.outputPath}`)
    }
  }
}

export async function extractPythonArtifact(options: {
  artifact: Pick<PythonArtifact, 'archiveFormat' | 'payloadRoot'>
  archivePath: string
  destinationDirectory: string
  signal?: AbortSignal
}): Promise<void> {
  await mkdir(options.destinationDirectory, { recursive: false })
  if (options.artifact.archiveFormat === 'nuget-zip') {
    await extractNuget(
      options.archivePath,
      options.destinationDirectory,
      options.artifact.payloadRoot,
      options.signal
    )
  } else {
    await extractTar(
      options.archivePath,
      options.destinationDirectory,
      options.artifact.payloadRoot,
      options.signal
    )
  }
}
