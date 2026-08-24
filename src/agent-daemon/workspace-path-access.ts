import { createHash } from 'node:crypto'
import {
  constants,
  type Dirent,
  type Stats
} from 'node:fs'
import {
  access,
  lstat,
  open,
  opendir,
  realpath,
  stat
} from 'node:fs/promises'
import {
  basename,
  isAbsolute,
  join,
  relative
} from 'node:path'
import {
  REMOTE_WORKSPACE_LIMITS,
  remoteAbsolutePathSchema,
  remoteRelativePathSchema,
  type RemoteWorkspaceEntry,
  type RemoteWorkspaceListRequest,
  type RemoteWorkspaceListResult,
  type RemoteWorkspaceReadTextRequest,
  type RemoteWorkspaceReadTextResult,
  type RemoteWorkspaceSearchRequest,
  type RemoteWorkspaceSearchResult,
  type RemoteWorkspaceStatResult
} from '../shared/remote-agent-contracts'

export const WORKSPACE_SEARCH_LIMITS = {
  maximumEntries: 100_000,
  maximumDepth: 64,
  maximumScannedBytes: 64 * 1024 * 1024,
  maximumFileBytes: REMOTE_WORKSPACE_LIMITS.maximumReadBytes
} as const

const READ_BUFFER_BYTES = 64 * 1024
const SEARCH_DIRECTORY_PAGE = 1_000
const MAXIMUM_READABLE_FILE_BYTES = 64 * 1024 * 1024
const noFollow = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)

export type WorkspaceRootIdentity = {
  canonicalPath: string
  device: string
  inode: string
  workspaceIdentity: string
}

export type WorkspaceIoOptions = {
  signal?: AbortSignal
  deadlineAt?: number
}

export class WorkspaceServiceError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'aborted'
      | 'capacity-exceeded'
      | 'deadline-exceeded'
      | 'digest-mismatch'
      | 'git-failed'
      | 'git-unsafe'
      | 'git-unavailable'
      | 'invalid-path'
      | 'invalid-utf8'
      | 'not-directory'
      | 'not-owner'
      | 'read-only'
      | 'special-file'
      | 'stale-generation'
      | 'stale-workspace'
      | 'symlink-rejected'
      | 'unavailable'
      | 'workspace-not-found'
  ) {
    super(message)
    this.name = 'WorkspaceServiceError'
  }
}

export async function inspectWorkspaceRoot(
  rootPathInput: string,
  options: WorkspaceIoOptions = {}
): Promise<WorkspaceRootIdentity> {
  checkCancelled(options)
  const rootPath = remoteAbsolutePathSchema.parse(rootPathInput)
  await assertSafeAbsoluteRootPath(rootPath, options)
  const rootMetadata = await lstat(rootPath)
  checkCancelled(options)
  if (rootMetadata.isSymbolicLink()) {
    throw new WorkspaceServiceError(
      'Workspace root cannot be a symbolic link',
      'symlink-rejected'
    )
  }
  if (!rootMetadata.isDirectory()) {
    throw new WorkspaceServiceError(
      'Workspace root is not a directory',
      'not-directory'
    )
  }
  const canonicalPath = await realpath(rootPath)
  if (!isAbsolute(canonicalPath)) {
    throw new WorkspaceServiceError(
      'Workspace root did not resolve to an absolute path',
      'invalid-path'
    )
  }
  const canonicalMetadata = await stat(canonicalPath)
  if (
    !canonicalMetadata.isDirectory() ||
    !sameFileIdentity(rootMetadata, canonicalMetadata)
  ) {
    throw new WorkspaceServiceError(
      'Workspace root changed while it was validated',
      'stale-workspace'
    )
  }
  await access(
    canonicalPath,
    constants.R_OK | constants.X_OK
  )
  const device = canonicalMetadata.dev.toString()
  const inode = canonicalMetadata.ino.toString()
  return {
    canonicalPath,
    device,
    inode,
    workspaceIdentity: `workspace-${createHash('sha256')
      .update(`linux\0${device}\0${inode}`, 'utf8')
      .digest('hex')}`
  }
}

async function assertSafeAbsoluteRootPath(
  rootPath: string,
  options: WorkspaceIoOptions
): Promise<void> {
  const rawSegments = rootPath.split('/')
  const segments = rawSegments.slice(1)
  if (segments.at(-1) === '') {
    segments.pop()
  }
  if (
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        Buffer.byteLength(segment, 'utf8') >
          REMOTE_WORKSPACE_LIMITS.maximumPathSegmentBytes
    )
  ) {
    throw new WorkspaceServiceError(
      'Workspace root contains traversal or empty path segments',
      'invalid-path'
    )
  }
  let current = '/'
  for (const segment of segments) {
    checkCancelled(options)
    current = join(current, segment)
    const metadata = await lstat(current)
    if (metadata.isSymbolicLink()) {
      throw new WorkspaceServiceError(
        'Workspace root path cannot contain symbolic links',
        'symlink-rejected'
      )
    }
    if (!metadata.isDirectory()) {
      throw new WorkspaceServiceError(
        'Workspace root path segment is not a directory',
        'not-directory'
      )
    }
  }
}

export class WorkspacePathAccess {
  readonly root: WorkspaceRootIdentity

  constructor(root: WorkspaceRootIdentity) {
    this.root = { ...root }
  }

  async assertCurrent(options: WorkspaceIoOptions = {}): Promise<void> {
    checkCancelled(options)
    await assertSafeAbsoluteRootPath(
      this.root.canonicalPath,
      options
    )
    let metadata: Stats
    try {
      metadata = await lstat(this.root.canonicalPath)
    } catch (error) {
      throw staleRoot(error)
    }
    checkCancelled(options)
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.dev.toString() !== this.root.device ||
      metadata.ino.toString() !== this.root.inode
    ) {
      throw new WorkspaceServiceError(
        'Workspace root identity is stale',
        'stale-workspace'
      )
    }
  }

  async resolveDirectory(
    relativePathInput: string,
    options: WorkspaceIoOptions = {}
  ): Promise<string> {
    return await this.#resolveExisting(
      relativePathInput,
      'directory',
      options
    )
  }

  async list(
    request: RemoteWorkspaceListRequest,
    options: WorkspaceIoOptions = {}
  ): Promise<RemoteWorkspaceListResult> {
    const directoryPath = await this.resolveDirectory(
      request.relativePath,
      options
    )
    const entries: Dirent[] = []
    const directory = await opendir(directoryPath)
    try {
      for await (const entry of directory) {
        checkCancelled(options)
        entries.push(entry)
        if (
          entries.length >
          REMOTE_WORKSPACE_LIMITS.maximumDirectoryEntriesPerPage * 100
        ) {
          throw new WorkspaceServiceError(
            'Directory exceeds the bounded enumeration limit',
            'capacity-exceeded'
          )
        }
      }
    } finally {
      await directory.close().catch(() => undefined)
    }
    entries.sort(compareDirectoryEntries)
    const offset = parseCursor(request.cursor)
    if (offset > entries.length) {
      throw new WorkspaceServiceError(
        'Directory cursor is no longer valid',
        'stale-generation'
      )
    }
    const selected = entries.slice(offset, offset + request.limit)
    const resultEntries: RemoteWorkspaceEntry[] = []
    for (const entry of selected) {
      checkCancelled(options)
      const relativePath = appendRelative(request.relativePath, entry.name)
      const metadata = await lstat(join(directoryPath, entry.name))
      resultEntries.push(entryFromMetadata(relativePath, entry.name, metadata))
    }
    const nextOffset = offset + selected.length
    return {
      entries: resultEntries,
      ...(nextOffset < entries.length
        ? { nextCursor: String(nextOffset) }
        : {})
    }
  }

  async stat(
    relativePathInput: string,
    options: WorkspaceIoOptions = {}
  ): Promise<RemoteWorkspaceStatResult> {
    const relativePath = remoteRelativePathSchema.parse(relativePathInput)
    const candidate = await this.#resolveExisting(
      relativePath,
      'entry',
      options
    )
    const metadata = await lstat(candidate)
    rejectUnsafeMetadata(metadata)
    return entryFromMetadata(
      relativePath,
      relativePath === ''
        ? basename(this.root.canonicalPath) || '/'
        : basename(candidate),
      metadata
    )
  }

  async readText(
    request: RemoteWorkspaceReadTextRequest,
    options: WorkspaceIoOptions = {}
  ): Promise<RemoteWorkspaceReadTextResult> {
    const relativePath = remoteRelativePathSchema.parse(request.relativePath)
    if (relativePath === '') {
      throw new WorkspaceServiceError(
        'Workspace root is not a regular file',
        'special-file'
      )
    }
    const filePath = await this.#resolveExisting(
      relativePath,
      'file',
      options
    )
    const handle = await open(filePath, noFollow)
    try {
      const before = await handle.stat()
      if (!before.isFile()) {
        throw new WorkspaceServiceError(
          'Workspace read target is not a regular file',
          'special-file'
        )
      }
      if (
        request.offsetBytes > before.size ||
        before.size > Number.MAX_SAFE_INTEGER
      ) {
        throw new WorkspaceServiceError(
          'Workspace read range is invalid',
          'invalid-path'
        )
      }
      if (before.size > MAXIMUM_READABLE_FILE_BYTES) {
        throw new WorkspaceServiceError(
          'Workspace file exceeds the bounded read limit',
          'capacity-exceeded'
        )
      }
      const digest = createHash('sha256')
      const chunks: Buffer[] = []
      let position = 0
      let selectedBytes = 0
      while (position < before.size) {
        checkCancelled(options)
        const buffer = Buffer.allocUnsafe(
          Math.min(READ_BUFFER_BYTES, before.size - position)
        )
        const result = await handle.read(
          buffer,
          0,
          buffer.byteLength,
          position
        )
        if (result.bytesRead === 0) {
          break
        }
        const chunk = buffer.subarray(0, result.bytesRead)
        digest.update(chunk)
        const chunkStart = position
        const chunkEnd = position + result.bytesRead
        const selectionStart = Math.max(request.offsetBytes, chunkStart)
        const selectionEnd = Math.min(
          request.offsetBytes + request.maximumBytes,
          chunkEnd
        )
        if (selectionStart < selectionEnd) {
          const selected = chunk.subarray(
            selectionStart - chunkStart,
            selectionEnd - chunkStart
          )
          chunks.push(selected)
          selectedBytes += selected.byteLength
        }
        position = chunkEnd
      }
      const after = await handle.stat()
      if (
        position !== before.size ||
        !sameSnapshot(before, after)
      ) {
        throw new WorkspaceServiceError(
          'Workspace file changed while it was read',
          'stale-workspace'
        )
      }
      const contentBuffer = Buffer.concat(chunks, selectedBytes)
      const content = decodeUtf8(contentBuffer)
      const contentDigest = `sha256:${digest.digest('hex')}`
      if (
        request.expectedDigest !== undefined &&
        request.expectedDigest !== contentDigest
      ) {
        throw new WorkspaceServiceError(
          'Workspace file digest does not match',
          'digest-mismatch'
        )
      }
      return {
        relativePath,
        content,
        offsetBytes: request.offsetBytes,
        bytesRead: contentBuffer.byteLength,
        totalBytes: before.size,
        digest: contentDigest,
        truncated:
          request.offsetBytes + contentBuffer.byteLength < before.size
      }
    } finally {
      await handle.close()
    }
  }

  async search(
    request: RemoteWorkspaceSearchRequest,
    options: WorkspaceIoOptions = {}
  ): Promise<RemoteWorkspaceSearchResult> {
    const prefix = request.pathPrefix ?? ''
    await this.resolveDirectory(prefix, options)
    const query = request.caseSensitive
      ? request.query
      : request.query.toLocaleLowerCase('en-US')
    const cursor = parseCursor(request.cursor)
    const matches: RemoteWorkspaceSearchResult['matches'] = []
    const queue: Array<{ relativePath: string; depth: number }> = [
      { relativePath: prefix, depth: 0 }
    ]
    let visitedEntries = 0
    let scannedBytes = 0
    let seenMatches = 0
    let truncated = false
    while (queue.length > 0 && !truncated) {
      checkCancelled(options)
      const current = queue.shift()!
      if (current.depth > WORKSPACE_SEARCH_LIMITS.maximumDepth) {
        truncated = true
        break
      }
      const page = await this.list(
          {
            workspaceId: request.workspaceId,
            generation: request.generation,
            relativePath: current.relativePath,
            limit: SEARCH_DIRECTORY_PAGE
          },
          options
        )
        for (const entry of page.entries) {
          visitedEntries += 1
          if (visitedEntries > WORKSPACE_SEARCH_LIMITS.maximumEntries) {
            truncated = true
            break
          }
          if (entry.kind === 'directory') {
            if (current.depth >= WORKSPACE_SEARCH_LIMITS.maximumDepth) {
              truncated = true
              break
            }
            queue.push({
              relativePath: entry.relativePath,
              depth: current.depth + 1
            })
            continue
          }
          if (entry.kind !== 'file') {
            continue
          }
          const size = entry.byteLength ?? 0
          if (
            size > WORKSPACE_SEARCH_LIMITS.maximumFileBytes ||
            scannedBytes + size >
              WORKSPACE_SEARCH_LIMITS.maximumScannedBytes
          ) {
            truncated = true
            break
          }
          scannedBytes += size
          let text: string
          try {
            text = (
              await this.readText(
                {
                  workspaceId: request.workspaceId,
                  generation: request.generation,
                  relativePath: entry.relativePath,
                  offsetBytes: 0,
                  maximumBytes: Math.max(1, size)
                },
                options
              )
            ).content
          } catch (error) {
            if (
              error instanceof WorkspaceServiceError &&
              (error.code === 'invalid-utf8' ||
                error.code === 'special-file')
            ) {
              continue
            }
            throw error
          }
          const lines = text.split(/\r?\n/u)
          for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const line = lines[lineIndex]!
            const searchable = request.caseSensitive
              ? line
              : line.toLocaleLowerCase('en-US')
            let from = 0
            while (from <= searchable.length) {
              const column = searchable.indexOf(query, from)
              if (column < 0) {
                break
              }
              if (seenMatches >= cursor) {
                matches.push({
                  relativePath: entry.relativePath,
                  line: lineIndex + 1,
                  column: column + 1,
                  snippet: boundedUtf8Snippet(line)
                })
              }
              seenMatches += 1
              if (matches.length > request.limit) {
                truncated = true
                break
              }
              from = column + Math.max(1, query.length)
            }
            if (truncated) {
              break
            }
          }
          if (truncated) {
            break
          }
        }
      if (page.nextCursor !== undefined) {
        truncated = true
      }
    }
    const hasNextPage = matches.length > request.limit
    if (hasNextPage) {
      matches.length = request.limit
    }
    return {
      matches,
      ...((hasNextPage || truncated) && matches.length > 0
        ? { nextCursor: String(cursor + matches.length) }
        : {}),
      truncated: hasNextPage || truncated
    }
  }

  async #resolveExisting(
    relativePathInput: string,
    expected: 'directory' | 'entry' | 'file',
    options: WorkspaceIoOptions
  ): Promise<string> {
    const relativePath = remoteRelativePathSchema.parse(relativePathInput)
    await this.assertCurrent(options)
    if (relativePath === '') {
      if (expected === 'file') {
        throw new WorkspaceServiceError(
          'Workspace root is not a regular file',
          'special-file'
        )
      }
      return this.root.canonicalPath
    }
    let current = this.root.canonicalPath
    const segments = relativePath.split('/')
    for (let index = 0; index < segments.length; index += 1) {
      checkCancelled(options)
      current = join(current, segments[index]!)
      const difference = relative(this.root.canonicalPath, current)
      if (
        difference.startsWith('..') ||
        isAbsolute(difference)
      ) {
        throw new WorkspaceServiceError(
          'Workspace path escapes its root',
          'invalid-path'
        )
      }
      const metadata = await lstat(current)
      if (metadata.isSymbolicLink()) {
        throw new WorkspaceServiceError(
          'Workspace paths cannot contain symbolic links',
          'symlink-rejected'
        )
      }
      const final = index === segments.length - 1
      if (!final && !metadata.isDirectory()) {
        throw new WorkspaceServiceError(
          'Workspace path segment is not a directory',
          'not-directory'
        )
      }
      if (final) {
        if (expected === 'directory' && !metadata.isDirectory()) {
          throw new WorkspaceServiceError(
            'Workspace target is not a directory',
            'not-directory'
          )
        }
        if (expected === 'file' && !metadata.isFile()) {
          throw new WorkspaceServiceError(
            'Workspace target is not a regular file',
            'special-file'
          )
        }
        if (expected === 'entry') {
          rejectUnsafeMetadata(metadata)
        }
      }
    }
    const canonical = await realpath(current)
    const difference = relative(this.root.canonicalPath, canonical)
    if (difference.startsWith('..') || isAbsolute(difference)) {
      throw new WorkspaceServiceError(
        'Workspace path resolved outside its root',
        'symlink-rejected'
      )
    }
    return canonical
  }
}

export function checkCancelled(options: WorkspaceIoOptions): void {
  if (
    options.deadlineAt !== undefined &&
    Date.now() >= options.deadlineAt
  ) {
    throw new WorkspaceServiceError(
      'Workspace operation deadline exceeded',
      'deadline-exceeded'
    )
  }
  if (options.signal?.aborted === true) {
    throw new WorkspaceServiceError(
      'Workspace operation was aborted',
      'aborted'
    )
  }
}

function staleRoot(cause: unknown): WorkspaceServiceError {
  return new WorkspaceServiceError(
    cause instanceof Error
      ? `Workspace root is stale: ${cause.message}`
      : 'Workspace root is stale',
    'stale-workspace'
  )
}

function rejectUnsafeMetadata(metadata: Stats): void {
  if (metadata.isSymbolicLink()) {
    throw new WorkspaceServiceError(
      'Symbolic links are not workspace entries',
      'symlink-rejected'
    )
  }
  if (!metadata.isFile() && !metadata.isDirectory()) {
    throw new WorkspaceServiceError(
      'Special files are not supported workspace entries',
      'special-file'
    )
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameSnapshot(left: Stats, right: Stats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function entryFromMetadata(
  relativePath: string,
  name: string,
  metadata: Stats
): RemoteWorkspaceEntry {
  const kind = metadata.isSymbolicLink()
    ? 'symlink'
    : metadata.isDirectory()
      ? 'directory'
      : metadata.isFile()
        ? 'file'
        : 'other'
  return {
    relativePath,
    name,
    kind,
    ...(metadata.isFile() ? { byteLength: metadata.size } : {}),
    modifiedAt: metadata.mtime.toISOString(),
    executable: metadata.isFile() && (metadata.mode & 0o111) !== 0
  }
}

function compareDirectoryEntries(left: Dirent, right: Dirent): number {
  const leftDirectory = left.isDirectory() && !left.isSymbolicLink()
  const rightDirectory = right.isDirectory() && !right.isSymbolicLink()
  if (leftDirectory !== rightDirectory) {
    return leftDirectory ? -1 : 1
  }
  return Buffer.from(left.name).compare(Buffer.from(right.name))
}

function parseCursor(value: string | undefined): number {
  if (value === undefined) {
    return 0
  }
  const cursor = Number(value)
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new WorkspaceServiceError(
      'Workspace cursor is invalid',
      'invalid-path'
    )
  }
  return cursor
}

function appendRelative(parent: string, name: string): string {
  return remoteRelativePathSchema.parse(parent === '' ? name : `${parent}/${name}`)
}

function decodeUtf8(value: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch (error) {
    throw new WorkspaceServiceError(
      error instanceof Error
        ? `Workspace file is not valid UTF-8: ${error.message}`
        : 'Workspace file is not valid UTF-8',
      'invalid-utf8'
    )
  }
}

function boundedUtf8Snippet(line: string): string {
  const maximum = REMOTE_WORKSPACE_LIMITS.maximumSearchSnippetBytes
  const encoded = Buffer.from(line, 'utf8')
  if (encoded.byteLength <= maximum) {
    return line
  }
  let end = maximum
  while (end > 0) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(
        encoded.subarray(0, end)
      )
    } catch {
      end -= 1
    }
  }
  return ''
}
