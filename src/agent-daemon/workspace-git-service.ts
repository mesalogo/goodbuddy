import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  lstat,
  open,
  opendir,
  readFile,
  realpath,
  stat
} from 'node:fs/promises'
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import {
  remoteRelativePathSchema,
  type RemoteGitDiffRequest,
  type RemoteGitDiffResult,
  type RemoteGitStatusRequest,
  type RemoteGitStatusResult
} from '../shared/remote-agent-contracts'
import {
  checkCancelled,
  WorkspacePathAccess,
  WorkspaceServiceError,
  type WorkspaceIoOptions
} from './workspace-path-access'

const NULL_DEVICE = '/dev/null'
const GIT_TIMEOUT_MS = 15_000
const MAXIMUM_GIT_PROCESS_BYTES = 16 * 1024 * 1024
const MAXIMUM_FILTER_DRIVERS = 256
const MAXIMUM_CONFIG_BYTES = 1024 * 1024
const MAXIMUM_GIT_METADATA_ENTRIES = 500_000
const MAXIMUM_GIT_METADATA_DEPTH = 64
const MAXIMUM_DIFF_SNAPSHOTS = 32
const MAXIMUM_DIFF_SNAPSHOT_BYTES = 64 * 1024 * 1024

type Repository = {
  rootPath: string
  gitDirectory: string
  commonDirectory: string
  repositoryIdentity: string
  configOverrides: ReadonlyArray<readonly [string, string]>
}

type GitSnapshot = {
  root: string
  gitDirectory: string
  head: string
  index: string
}

type CommandResult = {
  exitCode: number
  stdout: Buffer
  stderr: Buffer
  truncated: boolean
}

export class WorkspaceGitService {
  readonly #getGitExecutable: () => Promise<string>
  readonly #diffSnapshots = new Map<
    string,
    {
      repositoryIdentity: string
      bytes: Buffer
    }
  >()

  constructor(options: {
    gitExecutable?: string | Promise<string>
    environment?: NodeJS.ProcessEnv
  } = {}) {
    let executable: Promise<string> | undefined
    this.#getGitExecutable = () => {
      executable ??=
        options.gitExecutable === undefined
          ? resolveVerifiedGitExecutable(options.environment)
          : Promise.resolve(options.gitExecutable).then(
              verifyGitExecutable
            )
      return executable
    }
  }

  async inspect(
    accessService: WorkspacePathAccess,
    options: WorkspaceIoOptions = {}
  ): Promise<'available' | 'not-a-repository' | 'unavailable'> {
    try {
      await this.#repository(accessService, options)
      return 'available'
    } catch (error) {
      if (
        error instanceof WorkspaceServiceError &&
        error.code === 'git-unavailable'
      ) {
        return 'not-a-repository'
      }
      if (
        error instanceof WorkspaceServiceError &&
        (error.code === 'git-unsafe' ||
          error.code === 'stale-workspace' ||
          error.code === 'aborted' ||
          error.code === 'deadline-exceeded')
      ) {
        throw error
      }
      return 'unavailable'
    }
  }

  async status(
    accessService: WorkspacePathAccess,
    request: RemoteGitStatusRequest,
    options: WorkspaceIoOptions = {}
  ): Promise<RemoteGitStatusResult> {
    const repository = await this.#repository(accessService, options)
    const before = await repositorySnapshot(repository, accessService)
    const result = await this.#run(
      repository,
      [
        'status',
        '--porcelain=v2',
        '--branch',
        '-z',
        '--ignore-submodules=all',
        request.includeIgnored ? '--ignored=matching' : '--ignored=no',
        '--untracked-files=all'
      ],
      options,
      MAXIMUM_GIT_PROCESS_BYTES
    )
    if (result.exitCode !== 0) {
      throw gitFailure(result)
    }
    const middle = await repositorySnapshot(repository, accessService)
    assertSameSnapshot(before, middle)
    const verification = await this.#run(
      repository,
      [
        'status',
        '--porcelain=v2',
        '--branch',
        '-z',
        '--ignore-submodules=all',
        request.includeIgnored ? '--ignored=matching' : '--ignored=no',
        '--untracked-files=all'
      ],
      options,
      MAXIMUM_GIT_PROCESS_BYTES
    )
    if (
      verification.exitCode !== 0 ||
      verification.truncated !== result.truncated ||
      !verification.stdout.equals(result.stdout)
    ) {
      throw new WorkspaceServiceError(
        'Git status changed while its snapshot was read',
        'stale-workspace'
      )
    }
    const after = await repositorySnapshot(repository, accessService)
    assertSameSnapshot(middle, after)
    const parsed = parseStatus(
      result.stdout,
      request.maximumEntries,
      result.truncated
    )
    return {
      repositoryIdentity: repository.repositoryIdentity,
      branch: parsed.branch,
      ...(parsed.headDigest === undefined
        ? {}
        : { headDigest: parsed.headDigest }),
      entries: parsed.entries,
      truncated: result.truncated || parsed.truncated
    }
  }

  async diff(
    accessService: WorkspacePathAccess,
    request: RemoteGitDiffRequest,
    options: WorkspaceIoOptions = {}
  ): Promise<RemoteGitDiffResult> {
    const repository = await this.#repository(accessService, options)
    if (request.relativePath !== undefined && request.relativePath !== '') {
      await accessService.stat(request.relativePath, options)
    }
    const cursor = parseCursor(request.cursor)
    if (cursor > MAXIMUM_GIT_PROCESS_BYTES) {
      throw new WorkspaceServiceError(
        'Git diff cursor exceeds the bounded snapshot',
        'capacity-exceeded'
      )
    }
    const snapshotKey = diffSnapshotKey(
      request.workspaceId,
      request.generation,
      request.staged,
      request.relativePath
    )
    const args = [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--no-renames',
      '--ignore-submodules=all',
      ...(request.staged ? ['--cached'] : []),
      ...(request.relativePath === undefined ||
      request.relativePath === ''
        ? []
        : ['--', request.relativePath])
    ]
    if (cursor > 0) {
      const cached = this.#diffSnapshots.get(snapshotKey)
      const current =
        cached === undefined
          ? undefined
          : await this.#run(
              repository,
              args,
              options,
              MAXIMUM_GIT_PROCESS_BYTES
            )
      if (
        cached === undefined ||
        cached.repositoryIdentity !== repository.repositoryIdentity ||
        current === undefined ||
        current.exitCode !== 0 ||
        current.truncated ||
        !current.stdout.equals(cached.bytes) ||
        cursor > cached.bytes.byteLength
      ) {
        this.#diffSnapshots.delete(snapshotKey)
        throw new WorkspaceServiceError(
          'Git diff cursor is no longer valid',
          'stale-generation'
        )
      }
      return diffPage(
        cached.repositoryIdentity,
        cached.bytes,
        cursor,
        request.maximumBytes,
        false
      )
    }
    const before = await repositorySnapshot(repository, accessService)
    const result = await this.#run(
      repository,
      args,
      options,
      MAXIMUM_GIT_PROCESS_BYTES
    )
    if (result.exitCode !== 0) {
      throw gitFailure(result)
    }
    const middle = await repositorySnapshot(repository, accessService)
    assertSameSnapshot(before, middle)
    const verification = await this.#run(
      repository,
      args,
      options,
      MAXIMUM_GIT_PROCESS_BYTES
    )
    if (
      verification.exitCode !== 0 ||
      verification.truncated !== result.truncated ||
      !verification.stdout.equals(result.stdout)
    ) {
      throw new WorkspaceServiceError(
        'Git diff changed while its snapshot was read',
        'stale-workspace'
      )
    }
    const after = await repositorySnapshot(repository, accessService)
    assertSameSnapshot(middle, after)
    if (result.truncated) {
      this.#diffSnapshots.delete(snapshotKey)
    } else {
      this.#cacheDiffSnapshot(snapshotKey, {
        repositoryIdentity: repository.repositoryIdentity,
        bytes: Buffer.from(result.stdout)
      })
    }
    return diffPage(
      repository.repositoryIdentity,
      result.stdout,
      0,
      request.maximumBytes,
      result.truncated
    )
  }

  async #repository(
    accessService: WorkspacePathAccess,
    options: WorkspaceIoOptions
  ): Promise<Repository> {
    await accessService.assertCurrent(options)
    const rootPath = accessService.root.canonicalPath
    const dotGit = join(rootPath, '.git')
    let gitMetadata
    try {
      gitMetadata = await lstat(dotGit)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        throw new WorkspaceServiceError(
          'Workspace is not a Git repository',
          'git-unavailable'
        )
      }
      throw error
    }
    if (gitMetadata.isSymbolicLink() || !gitMetadata.isDirectory()) {
      throw new WorkspaceServiceError(
        'Git directory must be a non-symbolic directory inside the workspace',
        'git-unsafe'
      )
    }
    await this.#getGitExecutable()
    const gitDirectory = await realpath(dotGit)
    assertInside(rootPath, gitDirectory, 'Git directory')
    let commonDirectory = gitDirectory
    const commonPath = join(gitDirectory, 'commondir')
    const commonMetadata = await lstat(commonPath).catch((error: unknown) => {
      if (isErrno(error, 'ENOENT')) {
        return undefined
      }
      throw error
    })
    if (commonMetadata !== undefined) {
      if (commonMetadata.isSymbolicLink() || !commonMetadata.isFile()) {
        throw new WorkspaceServiceError(
          'Git common directory metadata is unsafe',
          'git-unsafe'
        )
      }
      const commonValue = (await readBoundedFile(commonPath, 4096)).trim()
      if (commonValue === '' || commonValue.includes('\0')) {
        throw new WorkspaceServiceError(
          'Git common directory metadata is invalid',
          'git-unsafe'
        )
      }
      commonDirectory = await realpath(
        resolve(gitDirectory, commonValue)
      )
      assertInside(rootPath, commonDirectory, 'Git common directory')
      if (!(await stat(commonDirectory)).isDirectory()) {
        throw new WorkspaceServiceError(
          'Git common directory is not a directory',
          'git-unsafe'
        )
      }
    }
    await assertSafeGitTree(rootPath, gitDirectory, options)
    if (commonDirectory !== gitDirectory) {
      await assertSafeGitTree(rootPath, commonDirectory, options)
    }
    await rejectAlternates(rootPath, commonDirectory)
    const configPath = join(commonDirectory, 'config')
    const configMetadata = await lstat(configPath)
    if (configMetadata.isSymbolicLink() || !configMetadata.isFile()) {
      throw new WorkspaceServiceError(
        'Git configuration is not a regular repository file',
        'git-unsafe'
      )
    }
    if (configMetadata.size > MAXIMUM_CONFIG_BYTES) {
      throw new WorkspaceServiceError(
        'Git configuration exceeds its safety limit',
        'git-unsafe'
      )
    }
    const config = await this.#readConfig(configPath, rootPath, options)
    const gitDirectoryMetadata = await stat(gitDirectory)
    const repositoryIdentity = `repository-${createHash('sha256')
      .update(
        [
          accessService.root.device,
          accessService.root.inode,
          gitDirectoryMetadata.dev.toString(),
          gitDirectoryMetadata.ino.toString()
        ].join('\0'),
        'utf8'
      )
      .digest('hex')}`
    return {
      rootPath,
      gitDirectory,
      commonDirectory,
      repositoryIdentity,
      configOverrides: config
    }
  }

  async #readConfig(
    configPath: string,
    rootPath: string,
    options: WorkspaceIoOptions
  ): Promise<ReadonlyArray<readonly [string, string]>> {
    const executable = await this.#getGitExecutable()
    const result = await runBoundedCommand(
      executable,
      ['config', '--file', configPath, '--no-includes', '--null', '--list'],
      rootPath,
      gitEnvironment([]),
      options,
      MAXIMUM_CONFIG_BYTES
    )
    if (result.exitCode !== 0 || result.truncated) {
      throw new WorkspaceServiceError(
        'Git configuration could not be parsed safely',
        'git-unsafe'
      )
    }
    const overrides: Array<readonly [string, string]> = []
    const filters = new Set<string>()
    for (const [rawKey, value] of parseGitConfigListOutput(
      result.stdout
    )) {
      const key = rawKey.toLocaleLowerCase('en-US')
      if (
        key === 'include.path' ||
        key.startsWith('includeif.') ||
        key === 'core.worktree' ||
        key === 'core.attributesfile' ||
        key === 'core.excludesfile' ||
        key === 'extensions.worktreeconfig'
      ) {
        throw new WorkspaceServiceError(
          'Git includes and external worktrees are not allowed',
          'git-unsafe'
        )
      }
      const filter = /^(filter\..*)\.(?:clean|smudge|process|required)$/u.exec(
        key
      )?.[1]
      if (filter !== undefined) {
        filters.add(filter)
        if (filters.size > MAXIMUM_FILTER_DRIVERS) {
          throw new WorkspaceServiceError(
            'Git filter configuration exceeds its safety limit',
            'git-unsafe'
          )
        }
      }
      if (
        key === 'extensions.objectformat' &&
        value !== '' &&
        value !== 'sha1' &&
        value !== 'sha256'
      ) {
        throw new WorkspaceServiceError(
          'Git object format is unsupported',
          'git-unsafe'
        )
      }
    }
    for (const filter of filters) {
      overrides.push(
        [`${filter}.clean`, ''],
        [`${filter}.smudge`, ''],
        [`${filter}.process`, ''],
        [`${filter}.required`, 'false']
      )
    }
    return overrides
  }

  async #run(
    repository: Repository,
    args: readonly string[],
    options: WorkspaceIoOptions,
    maximumBytes: number
  ): Promise<CommandResult> {
    const executable = await this.#getGitExecutable()
    return await runBoundedCommand(
      executable,
      [
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
        'interactive.diffFilter=',
        ...args
      ],
      repository.rootPath,
      gitEnvironment(repository.configOverrides),
      options,
      maximumBytes
    )
  }

  #cacheDiffSnapshot(
    key: string,
    snapshot: {
      repositoryIdentity: string
      bytes: Buffer
    }
  ): void {
    this.#diffSnapshots.delete(key)
    let totalBytes = [...this.#diffSnapshots.values()].reduce(
      (total, value) => total + value.bytes.byteLength,
      0
    )
    while (
      this.#diffSnapshots.size >= MAXIMUM_DIFF_SNAPSHOTS ||
      totalBytes + snapshot.bytes.byteLength >
        MAXIMUM_DIFF_SNAPSHOT_BYTES
    ) {
      const oldest = this.#diffSnapshots.entries().next().value as
        | [string, { repositoryIdentity: string; bytes: Buffer }]
        | undefined
      if (oldest === undefined) {
        break
      }
      this.#diffSnapshots.delete(oldest[0])
      totalBytes -= oldest[1].bytes.byteLength
    }
    this.#diffSnapshots.set(key, snapshot)
  }
}

export function parseGitConfigListOutput(
  output: Buffer
): ReadonlyArray<readonly [string, string]> {
  const records = output.toString('utf8').split('\0')
  if (records.at(-1) === '') {
    records.pop()
  }
  return records.map((record) => {
    const separator = record.indexOf('\n')
    if (separator <= 0) {
      throw new WorkspaceServiceError(
        'Git configuration output is malformed',
        'git-unsafe'
      )
    }
    return [
      record.slice(0, separator),
      record.slice(separator + 1)
    ] as const
  })
}

export async function resolveVerifiedGitExecutable(
  environment: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const path = environment.PATH ?? environment.Path ?? environment.path ?? ''
  for (const directory of path.split(delimiter)) {
    if (directory === '' || !isAbsolute(directory)) {
      continue
    }
    const candidate = join(directory, 'git')
    try {
      await access(candidate, constants.X_OK)
      return await verifyGitExecutable(candidate)
    } catch {
      // Try the next absolute PATH entry.
    }
  }
  throw new WorkspaceServiceError(
    'A verified absolute Git executable is unavailable',
    'unavailable'
  )
}

async function verifyGitExecutable(input: string): Promise<string> {
  if (!isAbsolute(input)) {
    throw new WorkspaceServiceError(
      'Git executable must be an absolute path',
      'git-unsafe'
    )
  }
  const metadata = await lstat(input)
  if (metadata.isSymbolicLink()) {
    throw new WorkspaceServiceError(
      'Git executable cannot be a symbolic link',
      'git-unsafe'
    )
  }
  const canonical = await realpath(input)
  const canonicalMetadata = await stat(canonical)
  if (!canonicalMetadata.isFile()) {
    throw new WorkspaceServiceError(
      'Git executable is not a regular file',
      'git-unsafe'
    )
  }
  await access(canonical, constants.X_OK)
  return canonical
}

function gitEnvironment(
  overrides: ReadonlyArray<readonly [string, string]>
): NodeJS.ProcessEnv {
  const values: Array<readonly [string, string]> = [
    ...overrides
  ]
  const environment: NodeJS.ProcessEnv = {
    HOME: NULL_DEVICE,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    GIT_ASKPASS: '',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: '',
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'false',
    GCM_INTERACTIVE: 'Never',
    SSH_ASKPASS: '',
    ...(values.length === 0
      ? {}
      : { GIT_CONFIG_COUNT: String(values.length) })
  }
  values.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key
    environment[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return environment
}

async function runBoundedCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  options: WorkspaceIoOptions,
  maximumBytes: number
): Promise<CommandResult> {
  checkCancelled(options)
  return await new Promise<CommandResult>((resolveResult, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let settled = false
    const configuredDeadline =
      options.deadlineAt === undefined
        ? Date.now() + GIT_TIMEOUT_MS
        : Math.min(options.deadlineAt, Date.now() + GIT_TIMEOUT_MS)
    const timeout = setTimeout(
      () => terminate('deadline-exceeded'),
      Math.max(1, configuredDeadline - Date.now())
    )
    const capture = (
      target: Buffer[],
      chunk: Buffer,
      stdoutTarget: boolean
    ): void => {
      const current = stdoutTarget ? stdoutBytes : stderrBytes
      const limit = stdoutTarget ? maximumBytes : 64 * 1024
      const remaining = limit - current
      if (remaining <= 0) {
        truncated = true
        return
      }
      const selected = chunk.subarray(0, remaining)
      target.push(selected)
      if (stdoutTarget) {
        stdoutBytes += selected.byteLength
      } else {
        stderrBytes += selected.byteLength
      }
      truncated ||= chunk.byteLength > selected.byteLength
    }
    const finish = (action: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      action()
    }
    const terminate = (
      code: 'aborted' | 'deadline-exceeded'
    ): void => {
      child.kill('SIGKILL')
      finish(() =>
        reject(
          new WorkspaceServiceError(
            code === 'aborted'
              ? 'Git operation was aborted'
              : 'Git operation deadline exceeded',
            code
          )
        )
      )
    }
    const abort = (): void => terminate('aborted')
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) =>
      capture(stdout, chunk, true)
    )
    child.stderr.on('data', (chunk: Buffer) =>
      capture(stderr, chunk, false)
    )
    child.once('error', (error) => {
      finish(() => reject(error))
    })
    child.once('close', (code) => {
      finish(() =>
        resolveResult({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdout, stdoutBytes),
          stderr: Buffer.concat(stderr, stderrBytes),
          truncated
        })
      )
    })
  })
}

async function repositorySnapshot(
  repository: Repository,
  accessService: WorkspacePathAccess
): Promise<GitSnapshot> {
  await accessService.assertCurrent()
  return {
    root: await metadataFingerprint(repository.rootPath),
    gitDirectory: await metadataFingerprint(repository.gitDirectory),
    head: await optionalFileFingerprint(
      join(repository.commonDirectory, 'HEAD')
    ),
    index: await optionalFileFingerprint(
      join(repository.gitDirectory, 'index')
    )
  }
}

async function metadataFingerprint(path: string): Promise<string> {
  const value = await lstat(path)
  return [
    value.dev,
    value.ino,
    value.size,
    value.mtimeMs,
    value.ctimeMs
  ].join(':')
}

async function optionalFileFingerprint(path: string): Promise<string> {
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new WorkspaceServiceError(
        'Git snapshot metadata is unsafe',
        'git-unsafe'
      )
    }
    const data =
      metadata.size <= 4096
        ? await readFile(path)
        : Buffer.alloc(0)
    return `${await metadataFingerprint(path)}:${createHash('sha256')
      .update(data)
      .digest('hex')}`
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return 'absent'
    }
    throw error
  }
}

function assertSameSnapshot(
  before: GitSnapshot,
  after: GitSnapshot
): void {
  if (
    before.root !== after.root ||
    before.gitDirectory !== after.gitDirectory ||
    before.head !== after.head ||
    before.index !== after.index
  ) {
    throw new WorkspaceServiceError(
      'Git repository changed while its snapshot was read',
      'stale-workspace'
    )
  }
}

function parseStatus(
  output: Buffer,
  maximumEntries: number,
  sourceTruncated: boolean
): {
  branch: string | null
  headDigest?: string
  entries: RemoteGitStatusResult['entries']
  truncated: boolean
} {
  const completeOutput =
    sourceTruncated && output.at(-1) !== 0
      ? output.subarray(0, Math.max(0, output.lastIndexOf(0) + 1))
      : output
  const records = completeOutput.toString('utf8').split('\0')
  let branch: string | null = null
  let headDigest: string | undefined
  const entries: RemoteGitStatusResult['entries'] = []
  let truncated = false
  for (let index = 0; index < records.length; index += 1) {
    let record = records[index]!
    if (record === '') {
      continue
    }
    while (record.startsWith('# ')) {
      const newline = record.indexOf('\n')
      const header = newline < 0 ? record : record.slice(0, newline)
      record = newline < 0 ? '' : record.slice(newline + 1)
      if (header.startsWith('# branch.oid ')) {
        const value = header.slice('# branch.oid '.length)
        if (/^[a-f0-9]{40,64}$/u.test(value)) {
          headDigest = value
        }
      } else if (header.startsWith('# branch.head ')) {
        const value = header.slice('# branch.head '.length)
        branch = value === '(detached)' ? null : value
      }
    }
    if (record === '') {
      continue
    }
    let relativePath: string
    let originalRelativePath: string | undefined
    let statusCode: string
    if (record.startsWith('1 ')) {
      const fields = splitFixedFields(record, 9)
      statusCode = fields[1]!
      relativePath = fields[8]!
    } else if (record.startsWith('2 ')) {
      const fields = splitFixedFields(record, 10)
      statusCode = fields[1]!
      relativePath = fields[9]!
      originalRelativePath = records[++index]
      if (originalRelativePath === undefined) {
        throw unsafeStatus()
      }
    } else if (record.startsWith('u ')) {
      const fields = splitFixedFields(record, 11)
      statusCode = fields[1]!
      relativePath = fields[10]!
    } else if (record.startsWith('? ')) {
      statusCode = '??'
      relativePath = record.slice(2)
    } else if (record.startsWith('! ')) {
      statusCode = '!!'
      relativePath = record.slice(2)
    } else {
      throw unsafeStatus()
    }
    if (entries.length >= maximumEntries) {
      truncated = true
      continue
    }
    entries.push({
      relativePath: remoteRelativePathSchema.parse(relativePath),
      index: mapStatus(statusCode[0]!, statusCode),
      worktree: mapStatus(statusCode[1]!, statusCode),
      ...(originalRelativePath === undefined
        ? {}
        : {
            originalRelativePath:
              remoteRelativePathSchema.parse(originalRelativePath)
          })
    })
  }
  return {
    branch,
    ...(headDigest === undefined ? {} : { headDigest }),
    entries,
    truncated
  }
}

function splitFixedFields(
  record: string,
  count: number
): string[] {
  const fields: string[] = []
  let start = 0
  for (let field = 1; field < count; field += 1) {
    const separator = record.indexOf(' ', start)
    if (separator < 0) {
      throw unsafeStatus()
    }
    fields.push(record.slice(start, separator))
    start = separator + 1
  }
  fields.push(record.slice(start))
  if (fields.at(-1) === '') {
    throw unsafeStatus()
  }
  return fields
}

function mapStatus(
  value: string,
  pair: string
): RemoteGitStatusResult['entries'][number]['index'] {
  if (pair === '??') {
    return 'untracked'
  }
  if (pair === '!!') {
    return 'ignored'
  }
  return (
    {
      '.': 'unmodified',
      ' ': 'unmodified',
      A: 'added',
      M: 'modified',
      D: 'deleted',
      R: 'renamed',
      C: 'copied',
      U: 'unmerged',
      T: 'modified'
    } as const
  )[value] ?? 'unmerged'
}

function unsafeStatus(): WorkspaceServiceError {
  return new WorkspaceServiceError(
    'Git returned an invalid status snapshot',
    'git-failed'
  )
}

function gitFailure(result: CommandResult): WorkspaceServiceError {
  const message = result.stderr.toString('utf8').trim().slice(0, 2_000)
  return new WorkspaceServiceError(
    message === '' ? 'Git read operation failed' : message,
    'git-failed'
  )
}

async function assertSafeGitTree(
  rootPath: string,
  metadataRoot: string,
  options: WorkspaceIoOptions
): Promise<void> {
  const queue: Array<{ path: string; depth: number }> = [
    { path: metadataRoot, depth: 0 }
  ]
  let entries = 0
  while (queue.length > 0) {
    checkCancelled(options)
    const current = queue.shift()!
    if (current.depth > MAXIMUM_GIT_METADATA_DEPTH) {
      throw new WorkspaceServiceError(
        'Git metadata exceeds its directory depth limit',
        'git-unsafe'
      )
    }
    const directory = await opendir(current.path)
    try {
      for await (const entry of directory) {
        checkCancelled(options)
        entries += 1
        if (entries > MAXIMUM_GIT_METADATA_ENTRIES) {
          throw new WorkspaceServiceError(
            'Git metadata exceeds its entry limit',
            'git-unsafe'
          )
        }
        const candidate = join(current.path, entry.name)
        assertInside(rootPath, candidate, 'Git metadata')
        const metadata = await lstat(candidate)
        if (metadata.isSymbolicLink()) {
          throw new WorkspaceServiceError(
            'Git metadata cannot contain symbolic links',
            'git-unsafe'
          )
        }
        if (metadata.isDirectory()) {
          queue.push({
            path: candidate,
            depth: current.depth + 1
          })
        } else if (!metadata.isFile()) {
          throw new WorkspaceServiceError(
            'Git metadata cannot contain special files',
            'git-unsafe'
          )
        }
      }
    } finally {
      await directory.close().catch(() => undefined)
    }
  }
}

async function rejectAlternates(
  rootPath: string,
  commonDirectory: string
): Promise<void> {
  const alternatesPath = join(
    commonDirectory,
    'objects',
    'info',
    'alternates'
  )
  const metadata = await lstat(alternatesPath).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) {
      return undefined
    }
    throw error
  })
  if (metadata === undefined) {
    return
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new WorkspaceServiceError(
      'Git object alternates metadata is unsafe',
      'git-unsafe'
    )
  }
  const data = await readBoundedFile(alternatesPath, 64 * 1024)
  for (const line of data.split(/\r?\n/u)) {
    if (line.trim() === '') {
      continue
    }
    const candidate = resolve(
      join(commonDirectory, 'objects'),
      line
    )
    assertInside(rootPath, candidate, 'Git object alternate')
    throw new WorkspaceServiceError(
      'Git object alternates are not supported',
      'git-unsafe'
    )
  }
}

async function readBoundedFile(
  path: string,
  maximumBytes: number
): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size > maximumBytes) {
      throw new WorkspaceServiceError(
        'Git metadata exceeds its safety limit',
        'git-unsafe'
      )
    }
    return (await handle.readFile()).toString('utf8')
  } finally {
    await handle.close()
  }
}

function assertInside(
  rootPath: string,
  candidatePath: string,
  label: string
): void {
  const difference = relative(rootPath, candidatePath)
  if (
    difference === '' ||
    difference.startsWith('..') ||
    isAbsolute(difference)
  ) {
    throw new WorkspaceServiceError(
      `${label} must remain beneath the workspace root`,
      'git-unsafe'
    )
  }
}

function parseCursor(value: string | undefined): number {
  if (value === undefined) {
    return 0
  }
  const cursor = Number(value)
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new WorkspaceServiceError(
      'Git diff cursor is invalid',
      'stale-generation'
    )
  }
  return cursor
}

function diffSnapshotKey(
  workspaceId: string,
  generation: number,
  staged: boolean,
  relativePath: string | undefined
): string {
  return [
    workspaceId,
    generation.toString(),
    staged ? 'staged' : 'worktree',
    relativePath ?? ''
  ].join('\0')
}

function diffPage(
  repositoryIdentity: string,
  bytes: Buffer,
  cursor: number,
  maximumBytes: number,
  sourceTruncated: boolean
): RemoteGitDiffResult {
  if (cursor > bytes.byteLength) {
    throw new WorkspaceServiceError(
      'Git diff cursor is no longer valid',
      'stale-generation'
    )
  }
  const requestedEnd = Math.min(
    bytes.byteLength,
    cursor + maximumBytes
  )
  const end = utf8BoundaryAtOrBefore(bytes, requestedEnd, cursor)
  const patchBytes = bytes.subarray(cursor, end)
  if (end === cursor && cursor < bytes.byteLength) {
    throw new WorkspaceServiceError(
      'Git diff page is too small for the next UTF-8 character',
      'capacity-exceeded'
    )
  }
  const patch = decodeGitUtf8(patchBytes)
  const hasMore = end < bytes.byteLength || sourceTruncated
  const resumable = !sourceTruncated && end < bytes.byteLength
  return {
    repositoryIdentity,
    patch,
    byteLength: patchBytes.byteLength,
    ...(resumable && end > cursor ? { nextCursor: String(end) } : {}),
    truncated: hasMore
  }
}

function utf8BoundaryAtOrBefore(
  value: Buffer,
  requested: number,
  minimum: number
): number {
  let end = requested
  while (end > minimum) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(
        value.subarray(minimum, end)
      )
      return end
    } catch {
      end -= 1
    }
  }
  return minimum
}

function decodeGitUtf8(value: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch (error) {
    throw new WorkspaceServiceError(
      error instanceof Error
        ? `Git output is not valid UTF-8: ${error.message}`
        : 'Git output is not valid UTF-8',
      'git-failed'
    )
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === code
  )
}
