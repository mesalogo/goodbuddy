import spawn from 'cross-spawn'
import { randomUUID } from 'node:crypto'
import { constants as fileSystemConstants } from 'node:fs'
import {
  access,
  lstat,
  open,
  realpath,
  rename,
  rm,
  stat
} from 'node:fs/promises'
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve
} from 'node:path'
import {
  getCanonicalWorkspace,
  isPathInside,
  listBoundedDirectoryEntries,
  readBoundedUtf8File,
  readUtf8FileRange,
  resolveExistingWorkspacePath
} from '../workspace-file-access'
import type {
  DirectoryPage,
  FilePreview,
  SearchPage,
  WorkspaceAccess,
  WorkspaceChangedFile,
  WorkspaceChanges,
  WorkspaceChangesInput,
  WorkspaceDirectoryInput,
  WorkspaceEntry,
  WorkspaceIdentity,
  WorkspacePathInput,
  WorkspaceReadInput,
  WorkspaceSearchInput,
  WorkspaceWriteInput,
  WriteResult
} from './workspace-access'

const MAX_GIT_OUTPUT_BYTES = 512 * 1024
const GIT_COMMAND_TIMEOUT_MS = 10_000
const MAX_GIT_FILTER_DRIVERS = 256
const MAX_DIRECTORY_ENTRIES = 500
const MAX_CHANGED_FILES = 2_000
const DEFAULT_READ_BYTES = 256 * 1024
const DEFAULT_WRITE_BYTES = 512 * 1024
const DEFAULT_SEARCH_RESULTS = 100
const MAX_SEARCH_RESULTS = 1_000
const DEFAULT_SEARCH_SCAN_BYTES = 2 * 1024 * 1024
const MAX_SEARCH_SCAN_BYTES = 8 * 1024 * 1024
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null'

const gitEnvironmentAllowlist = [
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE'
] as const

const safeGitArguments = [
  '--no-pager',
  '--no-optional-locks',
  '-c',
  `core.hooksPath=${NULL_DEVICE}`,
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.askPass=',
  '-c',
  'credential.helper=',
  '-c',
  'diff.external=',
  '-c',
  'interactive.diffFilter='
] as const

let gitExecutable: Promise<string> | undefined

type CommandResult = {
  code: number | null
  stdout: string
  stderr: string
  truncated: boolean
}

type GitConfigOverride = readonly [key: string, value: string]

/**
 * Git runs inside user-controlled repositories, so build a fresh environment
 * rather than filtering Electron Main's environment in place.
 */
export function buildWorkspaceGitEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  configOverrides: readonly GitConfigOverride[] = []
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    GIT_ASKPASS: '',
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: '',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    SSH_ASKPASS: ''
  }
  const path = source.PATH ?? source.Path ?? source.path
  if (path !== undefined) {
    environment.PATH = path
  }
  for (const name of gitEnvironmentAllowlist) {
    if (source[name] !== undefined) {
      environment[name] = source[name]
    }
  }
  if (configOverrides.length > 0) {
    environment.GIT_CONFIG_COUNT = String(configOverrides.length)
    configOverrides.forEach(([key, value], index) => {
      environment[`GIT_CONFIG_KEY_${index}`] = key
      environment[`GIT_CONFIG_VALUE_${index}`] = value
    })
  }
  return environment
}

async function resolveGitExecutable(
  source: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const path = source.PATH ?? source.Path ?? source.path ?? ''
  const executableName =
    process.platform === 'win32' ? 'git.exe' : 'git'
  for (const rawDirectory of path.split(delimiter)) {
    const trimmed = rawDirectory.trim()
    const directory =
      trimmed.startsWith('"') && trimmed.endsWith('"')
        ? trimmed.slice(1, -1)
        : trimmed
    if (!directory || !isAbsolute(directory)) {
      continue
    }
    const candidate = join(directory, executableName)
    try {
      await access(candidate, fileSystemConstants.X_OK)
      const canonicalPath = await realpath(candidate)
      if (
        isAbsolute(canonicalPath) &&
        (await stat(canonicalPath)).isFile()
      ) {
        return canonicalPath
      }
    } catch {
      // Continue through the explicit PATH candidates.
    }
  }
  throw new Error('无法找到安全的 Git 可执行文件')
}

function getGitExecutable(): Promise<string> {
  gitExecutable ??= resolveGitExecutable()
  return gitExecutable
}

function getBoundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  message: string
): number {
  const resolved = value ?? fallback
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > maximum
  ) {
    throw new Error(message)
  }
  return resolved
}

function normalizeRelativePath(
  inputPath: string,
  allowRoot: boolean
): { path: string; segments: string[] } {
  const normalized = inputPath.replaceAll('\\', '/')
  if (allowRoot && (normalized === '' || normalized === '.')) {
    return { path: '', segments: [] }
  }
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:\//u.test(normalized) ||
    isAbsolute(normalized) ||
    normalized.includes('\0')
  ) {
    throw new Error('路径必须是工作区内的相对路径')
  }
  const segments = normalized.split('/')
  if (
    segments.some(
      (segment) =>
        !segment || segment === '.' || segment === '..'
    )
  ) {
    throw new Error('路径必须是工作区内的相对路径，不能超出工作区')
  }
  return {
    path: segments.join('/'),
    segments
  }
}

async function runGit(
  rootPath: string,
  args: string[],
  signal?: AbortSignal,
  configOverrides: readonly GitConfigOverride[] = []
): Promise<CommandResult> {
  const executablePath = await getGitExecutable()
  return new Promise((resolveResult, reject) => {
    signal?.throwIfAborted()
    const child = spawn(executablePath, args, {
      cwd: rootPath,
      env: buildWorkspaceGitEnvironment(
        process.env,
        configOverrides
      ),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let truncated = false
    let settled = false
    const capture = (target: Buffer[], chunk: Buffer | string): void => {
      const buffer = Buffer.from(chunk)
      const remaining = MAX_GIT_OUTPUT_BYTES - bytes
      if (remaining <= 0) {
        truncated = true
        return
      }
      target.push(buffer.subarray(0, remaining))
      bytes += Math.min(buffer.byteLength, remaining)
      truncated ||= buffer.byteLength > remaining
    }
    const finish = (
      callback: () => void
    ): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      callback()
    }
    const abort = (): void => {
      child.kill()
      finish(() => reject(signal?.reason))
    }
    child.stdout?.on('data', (chunk: Buffer | string) =>
      capture(stdout, chunk)
    )
    child.stderr?.on('data', (chunk: Buffer | string) =>
      capture(stderr, chunk)
    )
    const timeout = setTimeout(() => {
      child.kill()
      finish(() => reject(new Error('读取文件更改超时')))
    }, GIT_COMMAND_TIMEOUT_MS)
    signal?.addEventListener('abort', abort, { once: true })
    child.once('error', (error) => {
      finish(() => reject(error))
    })
    child.once('close', (code) => {
      finish(() =>
        resolveResult({
          code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          truncated
        })
      )
    })
  })
}

function withSafeGitArguments(args: string[]): string[] {
  return [...safeGitArguments, ...args]
}

async function getFilterOverrides(
  rootPath: string,
  signal?: AbortSignal
): Promise<GitConfigOverride[]> {
  const result = await runGit(
    rootPath,
    withSafeGitArguments([
      'config',
      '--local',
      '--includes',
      '--name-only',
      '-z',
      '--get-regexp',
      '^filter\\..*\\.(clean|smudge|process|required)$'
    ]),
    signal
  )
  if (result.truncated) {
    throw new Error('Git 过滤器配置超过安全限制')
  }
  // `git config --get-regexp` returns 1 when no names matched.
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(
      result.stderr.trim().slice(0, 2_000) ||
        '无法安全读取 Git 过滤器配置'
    )
  }

  const drivers = new Set<string>()
  for (const name of result.stdout.split('\0')) {
    const match = /^(filter\..*)\.(?:clean|smudge|process|required)$/iu.exec(
      name
    )
    if (match?.[1]) {
      drivers.add(match[1])
      if (drivers.size > MAX_GIT_FILTER_DRIVERS) {
        throw new Error('Git 过滤器配置超过安全限制')
      }
    }
  }

  return [...drivers].flatMap(
    (driver): GitConfigOverride[] => [
      [`${driver}.clean`, ''],
      [`${driver}.smudge`, ''],
      [`${driver}.process`, ''],
      [`${driver}.required`, 'false']
    ]
  )
}

function parseChangedFiles(status: string): {
  files: WorkspaceChangedFile[]
  truncated: boolean
} {
  const records = status.split('\0')
  const files: WorkspaceChangedFile[] = []
  let index = 0
  while (index < records.length && files.length < MAX_CHANGED_FILES) {
    const record = records[index]
    index += 1
    if (!record) {
      continue
    }
    const statusCode = record.slice(0, 2)
    const path = record.slice(3)
    if (!path) {
      continue
    }
    const renamed = statusCode.includes('R') || statusCode.includes('C')
    const previousPath = renamed ? records[index] : undefined
    if (renamed) {
      index += 1
    }
    files.push({
      path,
      status: statusCode,
      ...(previousPath ? { previousPath } : {})
    })
  }
  return {
    files,
    truncated: index < records.length - 1
  }
}

function formatChangedFiles(files: WorkspaceChangedFile[]): string {
  return files
    .map((file) =>
      file.previousPath
        ? `${file.status} ${file.previousPath} -> ${file.path}`
        : `${file.status} ${file.path}`
    )
    .join('\n')
}

export class LocalWorkspaceAccess implements WorkspaceAccess {
  private canonicalWorkspace?: Promise<string>

  constructor(private readonly rootPath: string) {}

  private getWorkspace(): Promise<string> {
    this.canonicalWorkspace ??= getCanonicalWorkspace(
      this.rootPath,
      '项目工作区不是目录'
    )
    return this.canonicalWorkspace
  }

  private async resolveExisting(
    inputPath: string,
    expected: 'file' | 'directory'
  ): Promise<{ canonicalPath: string; path: string }> {
    const root = await this.getWorkspace()
    const normalized = normalizeRelativePath(
      inputPath,
      expected === 'directory'
    )
    return {
      canonicalPath: await resolveExistingWorkspacePath(
        root,
        normalized.segments,
        expected
      ),
      path: normalized.path
    }
  }

  async resolveEntryPath(
    inputPath: string,
    expected: 'file' | 'directory'
  ): Promise<string> {
    return (await this.resolveExisting(inputPath, expected)).canonicalPath
  }

  private async resolveWritable(inputPath: string): Promise<{
    canonicalPath: string
    path: string
  }> {
    const root = await this.getWorkspace()
    const normalized = normalizeRelativePath(inputPath, false)
    const candidate = resolve(root, ...normalized.segments)
    if (!isPathInside(root, candidate) || candidate === root) {
      throw new Error('工具路径不能超出工作区')
    }
    const canonicalParent = await realpath(dirname(candidate))
    if (!isPathInside(root, canonicalParent)) {
      throw new Error('工具路径不能通过符号链接超出工作区')
    }
    const existing = await lstat(candidate).catch((error: unknown) => {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return undefined
      }
      throw error
    })
    if (existing?.isSymbolicLink()) {
      throw new Error('工作区写入工具拒绝符号链接')
    }
    if (existing && !existing.isFile()) {
      throw new Error('工作区写入目标不是普通文件')
    }
    return { canonicalPath: candidate, path: normalized.path }
  }

  async getIdentity(): Promise<WorkspaceIdentity> {
    const canonicalRoot = await this.getWorkspace()
    const metadata = await stat(canonicalRoot)
    return {
      kind: 'local',
      id: `local:${metadata.dev}:${metadata.ino}:${canonicalRoot}`,
      canonicalDisplayPath: canonicalRoot,
      access: 'read-write'
    }
  }

  async listDirectory(
    input: WorkspaceDirectoryInput
  ): Promise<DirectoryPage> {
    input.signal?.throwIfAborted()
    const maximumEntries = getBoundedInteger(
      input.maximumEntries,
      MAX_DIRECTORY_ENTRIES,
      MAX_DIRECTORY_ENTRIES,
      '工作区目录条目上限无效'
    )
    const directory = await this.resolveExisting(input.path, 'directory')
    const listing = await listBoundedDirectoryEntries(
      directory.canonicalPath,
      maximumEntries,
      (entry) =>
        (input.includeGit === true || entry.name !== '.git') &&
        (input.includeOther === true ||
          entry.isDirectory() ||
          entry.isFile())
    )
    input.signal?.throwIfAborted()
    const entries = listing.entries.sort((left, right) => {
      if (
        input.includeOther !== true &&
        left.isDirectory() !== right.isDirectory()
      ) {
        return left.isDirectory() ? -1 : 1
      }
      return left.name.localeCompare(right.name)
    })
    return {
      path: directory.path,
      entries: entries.map((entry) => ({
        name: entry.name,
        path: [directory.path, entry.name].filter(Boolean).join('/'),
        type: entry.isDirectory()
          ? 'directory'
          : entry.isFile()
            ? 'file'
            : 'other'
      })),
      truncated: listing.truncated
    }
  }

  async stat(input: WorkspacePathInput): Promise<WorkspaceEntry> {
    input.signal?.throwIfAborted()
    const root = await this.getWorkspace()
    const normalized = normalizeRelativePath(input.path, true)
    const candidate = resolve(root, ...normalized.segments)
    if (!isPathInside(root, candidate)) {
      throw new Error('文件路径不能超出项目工作区')
    }
    const canonicalPath = await realpath(candidate)
    if (!isPathInside(root, canonicalPath)) {
      throw new Error('文件路径不能通过符号链接超出项目工作区')
    }
    const metadata = await stat(canonicalPath)
    input.signal?.throwIfAborted()
    return {
      name: basename(canonicalPath),
      path: normalized.path,
      type: metadata.isDirectory()
        ? 'directory'
        : metadata.isFile()
          ? 'file'
          : 'other',
      size: metadata.size,
      modifiedAt: metadata.mtime.toISOString()
    }
  }

  async readText(input: WorkspaceReadInput): Promise<FilePreview> {
    input.signal?.throwIfAborted()
    const maximumBytes = getBoundedInteger(
      input.maximumBytes,
      DEFAULT_READ_BYTES,
      DEFAULT_WRITE_BYTES,
      '工作区读取上限无效'
    )
    const file = await this.resolveExisting(input.path, 'file')
    const offsetBytes = input.offsetBytes ?? 0
    if (input.allowTruncated || offsetBytes > 0) {
      const preview = await readUtf8FileRange(
        file.canonicalPath,
        offsetBytes,
        maximumBytes,
        input.invalidUtf8Message ??
          '工作区读取目标不是有效 UTF-8 文本'
      )
      if (preview.truncated && !input.allowTruncated) {
        throw new Error(
          input.tooLargeMessage ?? '工作区文本文件超过安全限制'
        )
      }
      if (preview.truncated && preview.bytesRead === 0) {
        throw new Error('工作区读取分页无法继续')
      }
      input.signal?.throwIfAborted()
      return {
        path: file.path,
        name: basename(file.canonicalPath),
        ...preview
      }
    }
    const preview = await readBoundedUtf8File(
      file.canonicalPath,
      maximumBytes,
      input.tooLargeMessage ?? '工作区文本文件超过安全限制',
      input.invalidUtf8Message ?? '工作区读取目标不是有效 UTF-8 文本'
    )
    input.signal?.throwIfAborted()
    return {
      path: file.path,
      name: basename(file.canonicalPath),
      content: preview.content,
      size: preview.size,
      offsetBytes: 0,
      bytesRead: preview.size,
      truncated: false
    }
  }

  async writeTextAtomic(
    input: WorkspaceWriteInput
  ): Promise<WriteResult> {
    input.signal?.throwIfAborted()
    const maximumBytes = getBoundedInteger(
      input.maximumBytes,
      DEFAULT_WRITE_BYTES,
      DEFAULT_WRITE_BYTES,
      '工作区写入上限无效'
    )
    const bytesWritten = Buffer.byteLength(input.content)
    if (bytesWritten > maximumBytes) {
      throw new Error('写入内容超过 512KB 安全限制')
    }
    const file = await this.resolveWritable(input.path)
    const temporaryPath = `${file.canonicalPath}.${randomUUID()}.tmp`
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      try {
        await handle.writeFile(input.content, 'utf8')
      } finally {
        await handle.close()
      }
      input.signal?.throwIfAborted()
      await rename(temporaryPath, file.canonicalPath)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      if (input.signal?.aborted) {
        throw error
      }
      throw new Error('无法安全写入工作区文件', { cause: error })
    }
    return { path: file.path, bytesWritten }
  }

  async search(input: WorkspaceSearchInput): Promise<SearchPage> {
    input.signal?.throwIfAborted()
    if (
      !input.query ||
      input.query.includes('\0') ||
      Buffer.byteLength(input.query) > 4_096
    ) {
      throw new Error('工作区搜索词无效')
    }
    const maximumResults = getBoundedInteger(
      input.maximumResults,
      DEFAULT_SEARCH_RESULTS,
      MAX_SEARCH_RESULTS,
      '工作区搜索结果上限无效'
    )
    const maximumFileBytes = getBoundedInteger(
      input.maximumFileBytes,
      DEFAULT_READ_BYTES,
      DEFAULT_WRITE_BYTES,
      '工作区搜索文件上限无效'
    )
    const maximumScannedBytes = getBoundedInteger(
      input.maximumScannedBytes,
      DEFAULT_SEARCH_SCAN_BYTES,
      MAX_SEARCH_SCAN_BYTES,
      '工作区搜索扫描上限无效'
    )
    const queue = [input.path ?? '']
    const matches: SearchPage['matches'] = []
    let scannedBytes = 0
    let truncated = false
    while (queue.length > 0 && !truncated) {
      input.signal?.throwIfAborted()
      const currentPath = queue.shift()!
      const listing = await this.listDirectory({
        path: currentPath,
        maximumEntries: MAX_DIRECTORY_ENTRIES,
        signal: input.signal
      })
      truncated ||= listing.truncated
      for (const entry of listing.entries) {
        if (entry.type === 'directory') {
          queue.push(entry.path)
          continue
        }
        if (entry.type !== 'file') {
          continue
        }
        const metadata = await this.stat({
          path: entry.path,
          signal: input.signal
        })
        if (
          metadata.size > maximumFileBytes ||
          scannedBytes + metadata.size > maximumScannedBytes
        ) {
          truncated = true
          break
        }
        scannedBytes += metadata.size
        let content: string
        try {
          content = (
            await this.readText({
              path: entry.path,
              maximumBytes: maximumFileBytes,
              signal: input.signal
            })
          ).content
        } catch (error) {
          if (input.signal?.aborted) {
            throw error
          }
          continue
        }
        const lines = content.split(/\r?\n/u)
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]!
          const column = line.indexOf(input.query)
          if (column < 0) {
            continue
          }
          matches.push({
            path: entry.path,
            line: index + 1,
            column: column + 1,
            preview: line.slice(0, 1_000)
          })
          if (matches.length >= maximumResults) {
            truncated = true
            break
          }
        }
        if (truncated) {
          break
        }
      }
    }
    return { matches, truncated }
  }

  async getChanges(
    input: WorkspaceChangesInput
  ): Promise<WorkspaceChanges> {
    input.signal?.throwIfAborted()
    if (!this.rootPath.trim()) {
      return {
        rootPath: this.rootPath,
        available: false,
        status: '',
        patch: '',
        files: [],
        truncated: false,
        error: '项目尚未配置工作区目录'
      }
    }
    const gitMetadata = await stat(join(this.rootPath, '.git')).catch(
      () => undefined
    )
    if (!gitMetadata) {
      return {
        rootPath: this.rootPath,
        available: false,
        status: '',
        patch: '',
        files: [],
        truncated: false
      }
    }
    try {
      const canonicalRoot = await this.getWorkspace()
      const filterOverrides = await getFilterOverrides(
        canonicalRoot,
        input.signal
      )
      const [statusResult, patchResult] = await Promise.all([
        runGit(
          canonicalRoot,
          withSafeGitArguments([
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=normal'
          ]),
          input.signal,
          filterOverrides
        ),
        runGit(
          canonicalRoot,
          withSafeGitArguments([
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--no-color',
            'HEAD'
          ]),
          input.signal,
          filterOverrides
        )
      ])
      if (statusResult.code !== 0 || patchResult.code !== 0) {
        const detail = statusResult.stderr || patchResult.stderr
        return {
          rootPath: this.rootPath,
          available: false,
          status: '',
          patch: '',
          files: [],
          truncated: statusResult.truncated || patchResult.truncated,
          error: detail.trim().slice(0, 2_000) || '无法读取 Git 工作区'
        }
      }
      const changedFiles = parseChangedFiles(statusResult.stdout)
      return {
        rootPath: this.rootPath,
        available: true,
        status: formatChangedFiles(changedFiles.files),
        patch: patchResult.stdout,
        files: changedFiles.files,
        truncated:
          statusResult.truncated ||
          patchResult.truncated ||
          changedFiles.truncated
      }
    } catch (error) {
      if (input.signal?.aborted) {
        throw error
      }
      return {
        rootPath: this.rootPath,
        available: false,
        status: '',
        patch: '',
        files: [],
        truncated: false,
        error:
          error instanceof Error ? error.message : '无法读取 Git 工作区'
      }
    }
  }

  async dispose(): Promise<void> {}
}
