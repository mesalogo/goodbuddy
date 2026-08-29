import {
  REMOTE_WORKSPACE_READ_CAPABILITIES,
  REMOTE_WORKSPACE_LIMITS,
  remoteGitDiffRequestSchema,
  remoteGitDiffResultSchema,
  remoteGitStatusRequestSchema,
  remoteGitStatusResultSchema,
  remoteWorkspaceCloseRequestSchema,
  remoteWorkspaceCloseResultSchema,
  remoteWorkspaceHandleSchema,
  remoteWorkspaceListRequestSchema,
  remoteWorkspaceListResultSchema,
  remoteWorkspaceReadTextRequestSchema,
  remoteWorkspaceReadTextResultSchema,
  remoteWorkspaceSearchRequestSchema,
  remoteWorkspaceSearchResultSchema,
  remoteWorkspaceStatRequestSchema,
  remoteWorkspaceStatResultSchema,
  remoteWorkspaceValidateRequestSchema,
  remoteWorkspaceValidateResultSchema,
  type RemoteGitDiffRequest,
  type RemoteGitDiffResult,
  type RemoteGitStatusRequest,
  type RemoteGitStatusResult,
  type RemoteWorkspaceCloseRequest,
  type RemoteWorkspaceCloseResult,
  type RemoteWorkspaceHandle,
  type RemoteWorkspaceListRequest,
  type RemoteWorkspaceListResult,
  type RemoteWorkspaceReadTextRequest,
  type RemoteWorkspaceReadTextResult,
  type RemoteWorkspaceSearchRequest,
  type RemoteWorkspaceSearchResult,
  type RemoteWorkspaceStatRequest,
  type RemoteWorkspaceStatResult,
  type RemoteWorkspaceValidateRequest,
  type RemoteWorkspaceValidateResult
} from '../../shared/remote-agent-contracts'
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

const DEFAULT_DIRECTORY_ENTRIES = 500
const DEFAULT_READ_BYTES = 256 * 1024
const DEFAULT_SEARCH_RESULTS = 100
export type RemoteWorkspaceProjectBinding = {
  hostId: string
  remoteRootPath: string
}

export type RemoteWorkspaceTransportBinding = {
  hostId: string
  hostRevision: number
  hostKeyGeneration: number
  remoteUsername: string
  agentInstallationId: string
  agentBinaryDigest: string
  agentVersion: string
  agentArchitecture: 'x64' | 'arm64'
  agentProtocolMajor: number
  capabilityGeneration: number
}

/**
 * A process-neutral, already-authenticated Agent API lease. It deliberately
 * exposes neither an SSH connection nor a generic JSON-RPC method.
 */
export interface RemoteWorkspaceTransportLease {
  readonly binding: RemoteWorkspaceTransportBinding
  validateWorkspace(
    request: RemoteWorkspaceValidateRequest,
    signal?: AbortSignal
  ): Promise<RemoteWorkspaceValidateResult>
  closeWorkspace(
    request: RemoteWorkspaceCloseRequest
  ): Promise<RemoteWorkspaceCloseResult>
  listWorkspace(
    request: RemoteWorkspaceListRequest,
    signal?: AbortSignal
  ): Promise<RemoteWorkspaceListResult>
  statWorkspace(
    request: RemoteWorkspaceStatRequest,
    signal?: AbortSignal
  ): Promise<RemoteWorkspaceStatResult>
  readWorkspaceText(
    request: RemoteWorkspaceReadTextRequest,
    signal?: AbortSignal
  ): Promise<RemoteWorkspaceReadTextResult>
  searchWorkspace(
    request: RemoteWorkspaceSearchRequest,
    signal?: AbortSignal
  ): Promise<RemoteWorkspaceSearchResult>
  getGitStatus(
    request: RemoteGitStatusRequest,
    signal?: AbortSignal
  ): Promise<RemoteGitStatusResult>
  getGitDiff(
    request: RemoteGitDiffRequest,
    signal?: AbortSignal
  ): Promise<RemoteGitDiffResult>
  release(): void | Promise<void>
}

export interface RemoteWorkspaceTransport {
  acquireLease(
    binding: RemoteWorkspaceProjectBinding,
    signal?: AbortSignal
  ): Promise<RemoteWorkspaceTransportLease>
}

export interface RemoteWorkspaceAccessFactory {
  create(binding: RemoteWorkspaceProjectBinding): WorkspaceAccess
}

type OpenRemoteWorkspace = {
  lease: RemoteWorkspaceTransportLease
  handle: RemoteWorkspaceHandle
  capabilityGeneration: number
}

function boundedInteger(
  value: number | undefined,
  defaultValue: number,
  maximum: number,
  message: string
): number {
  const resolved = value ?? defaultValue
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > maximum
  ) {
    throw new Error(message)
  }
  return resolved
}

function assertTransportBinding(
  expected: RemoteWorkspaceProjectBinding,
  actual: RemoteWorkspaceTransportBinding
): void {
  if (
    !Number.isSafeInteger(actual.capabilityGeneration) ||
    actual.capabilityGeneration < 1 ||
    actual.hostId !== expected.hostId
  ) {
    throw new Error('远程工作区连接绑定已失效')
  }
}

function assertHandleBinding(
  expected: RemoteWorkspaceProjectBinding,
  handleInput: unknown
): RemoteWorkspaceHandle {
  const handle = remoteWorkspaceHandleSchema.parse(handleInput)
  if (
    handle.canonicalDisplayPath !== expected.remoteRootPath ||
    handle.access !== 'read-only'
  ) {
    throw new Error('远程工作区身份绑定不匹配')
  }
  for (const capability of REMOTE_WORKSPACE_READ_CAPABILITIES) {
    if (!handle.capabilities.includes(capability)) {
      throw new Error(`远程工作区缺少必要能力：${capability}`)
    }
  }
  return handle
}

function entryType(
  kind: 'file' | 'directory' | 'symlink' | 'other'
): 'file' | 'directory' | 'other' {
  return kind === 'file' || kind === 'directory' ? kind : 'other'
}

function gitStatusCharacter(
  status:
    | 'unmodified'
    | 'added'
    | 'modified'
    | 'deleted'
    | 'renamed'
    | 'copied'
    | 'unmerged'
    | 'untracked'
    | 'ignored'
): string {
  switch (status) {
    case 'unmodified':
      return ' '
    case 'added':
      return 'A'
    case 'modified':
      return 'M'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'copied':
      return 'C'
    case 'unmerged':
      return 'U'
    case 'untracked':
      return '?'
    case 'ignored':
      return '!'
  }
}

function mapChangedFiles(
  result: RemoteGitStatusResult
): WorkspaceChangedFile[] {
  return result.entries.map((entry) => {
    const status =
      entry.index === 'untracked' || entry.worktree === 'untracked'
        ? '??'
        : entry.index === 'ignored' || entry.worktree === 'ignored'
          ? '!!'
          : `${gitStatusCharacter(entry.index)}${gitStatusCharacter(entry.worktree)}`
    return {
      path: entry.relativePath,
      status,
      ...(entry.originalRelativePath
        ? { previousPath: entry.originalRelativePath }
        : {})
    }
  })
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

export class RemoteWorkspaceAccess implements WorkspaceAccess {
  private opening?: Promise<OpenRemoteWorkspace>
  private opened?: OpenRemoteWorkspace
  private disposed = false
  private disposal?: Promise<void>

  constructor(
    private readonly binding: RemoteWorkspaceProjectBinding,
    private readonly transport: RemoteWorkspaceTransport
  ) {}

  private async open(signal?: AbortSignal): Promise<OpenRemoteWorkspace> {
    signal?.throwIfAborted()
    if (this.disposed) {
      throw new Error('远程工作区访问已关闭')
    }
    if (this.opened) {
      assertTransportBinding(this.binding, this.opened.lease.binding)
      return this.opened
    }
    this.opening ??= this.openNew(signal)
    try {
      const opened = await this.opening
      if (this.disposed) {
        throw new Error('远程工作区访问已关闭')
      }
      this.opened = opened
      signal?.throwIfAborted()
      return opened
    } catch (error) {
      this.opening = undefined
      throw error
    }
  }

  private async openNew(
    signal?: AbortSignal
  ): Promise<OpenRemoteWorkspace> {
    const lease = await this.transport.acquireLease(this.binding, signal)
    let retained = false
    try {
      assertTransportBinding(this.binding, lease.binding)
      signal?.throwIfAborted()
      const validation = remoteWorkspaceValidateResultSchema.parse(
        await lease.validateWorkspace(
          remoteWorkspaceValidateRequestSchema.parse({
            remoteRootPath: this.binding.remoteRootPath,
            requestedAccess: 'read-only',
            requiredCapabilities: [
              ...REMOTE_WORKSPACE_READ_CAPABILITIES
            ]
          }),
          signal
        )
      )
      const handle = assertHandleBinding(
        this.binding,
        validation.handle
      )
      assertTransportBinding(this.binding, lease.binding)
      retained = true
      return {
        lease,
        handle,
        capabilityGeneration: lease.binding.capabilityGeneration
      }
    } finally {
      if (!retained) {
        await lease.release()
      }
    }
  }

  private reference(opened: OpenRemoteWorkspace): {
    workspaceId: string
    generation: number
  } {
    assertTransportBinding(this.binding, opened.lease.binding)
    if (
      opened.lease.binding.capabilityGeneration !==
      opened.capabilityGeneration
    ) {
      throw new Error('远程工作区能力代际已失效')
    }
    return {
      workspaceId: opened.handle.workspaceId,
      generation: opened.handle.generation
    }
  }

  async getIdentity(): Promise<WorkspaceIdentity> {
    const { handle } = await this.open()
    return {
      kind: 'remote',
      id: `${this.binding.hostId}:${handle.workspaceIdentity}`,
      canonicalDisplayPath: handle.canonicalDisplayPath,
      access: 'read-only'
    }
  }

  async listDirectory(
    input: WorkspaceDirectoryInput
  ): Promise<DirectoryPage> {
    const maximumEntries = boundedInteger(
      input.maximumEntries,
      DEFAULT_DIRECTORY_ENTRIES,
      REMOTE_WORKSPACE_LIMITS.maximumDirectoryEntriesPerPage,
      '工作区目录条目上限无效'
    )
    const opened = await this.open(input.signal)
    const request = remoteWorkspaceListRequestSchema.parse({
      ...this.reference(opened),
      relativePath: input.path,
      limit: maximumEntries
    })
    const result = remoteWorkspaceListResultSchema.parse(
      await opened.lease.listWorkspace(request, input.signal)
    )
    const entries = result.entries
      .filter(
        (entry) =>
          (input.includeGit === true || entry.name !== '.git') &&
          (input.includeOther === true ||
            entryType(entry.kind) !== 'other')
      )
      .map((entry) => ({
        name: entry.name,
        path: entry.relativePath,
        type: entryType(entry.kind)
      }))
    return {
      path: input.path,
      entries,
      truncated: result.nextCursor !== undefined
    }
  }

  async stat(input: WorkspacePathInput): Promise<WorkspaceEntry> {
    const opened = await this.open(input.signal)
    const request = remoteWorkspaceStatRequestSchema.parse({
      ...this.reference(opened),
      relativePath: input.path
    })
    const result = remoteWorkspaceStatResultSchema.parse(
      await opened.lease.statWorkspace(request, input.signal)
    )
    if (
      result.relativePath !== input.path
    ) {
      throw new Error('远程工作区返回了不匹配的文件元数据')
    }
    return {
      name: result.name,
      path: result.relativePath,
      type: entryType(result.kind),
      size: result.byteLength ?? 0,
      modifiedAt: result.modifiedAt ?? ''
    }
  }

  async readText(input: WorkspaceReadInput): Promise<FilePreview> {
    const maximumBytes = boundedInteger(
      input.maximumBytes,
      DEFAULT_READ_BYTES,
      REMOTE_WORKSPACE_LIMITS.maximumReadBytes,
      '工作区读取上限无效'
    )
    const opened = await this.open(input.signal)
    const request = remoteWorkspaceReadTextRequestSchema.parse({
      ...this.reference(opened),
      relativePath: input.path,
      offsetBytes: 0,
      maximumBytes
    })
    const rawResult = await opened.lease.readWorkspaceText(
      request,
      input.signal
    )
    let result: RemoteWorkspaceReadTextResult
    try {
      result = remoteWorkspaceReadTextResultSchema.parse(rawResult)
    } catch (error) {
      if (input.signal?.aborted) {
        throw error
      }
      throw new Error(
        input.invalidUtf8Message ??
          '工作区读取目标不是有效 UTF-8 文本',
        { cause: error }
      )
    }
    if (
      result.relativePath !== input.path ||
      result.offsetBytes !== 0
    ) {
      throw new Error('远程工作区返回了不匹配的文件')
    }
    if (result.truncated || result.bytesRead !== result.totalBytes) {
      throw new Error(
        input.tooLargeMessage ?? '工作区文本文件超过安全限制'
      )
    }
    const name = input.path.split('/').at(-1) ?? input.path
    return {
      path: input.path,
      name,
      content: result.content,
      size: result.totalBytes
    }
  }

  async writeTextAtomic(
    input: WorkspaceWriteInput
  ): Promise<WriteResult> {
    input.signal?.throwIfAborted()
    throw new Error(
      '远程工作区写入需要可恢复的持久 operation transport'
    )
  }

  async search(input: WorkspaceSearchInput): Promise<SearchPage> {
    if (
      input.maximumFileBytes !== undefined ||
      input.maximumScannedBytes !== undefined
    ) {
      throw new Error('远程工作区搜索不支持本机扫描限额')
    }
    const maximumResults = boundedInteger(
      input.maximumResults,
      DEFAULT_SEARCH_RESULTS,
      REMOTE_WORKSPACE_LIMITS.maximumSearchMatchesPerPage,
      '工作区搜索结果上限无效'
    )
    const opened = await this.open(input.signal)
    const request = remoteWorkspaceSearchRequestSchema.parse({
      ...this.reference(opened),
      query: input.query,
      ...(input.path === undefined ? {} : { pathPrefix: input.path }),
      caseSensitive: true,
      limit: maximumResults
    })
    const result = remoteWorkspaceSearchResultSchema.parse(
      await opened.lease.searchWorkspace(request, input.signal)
    )
    return {
      matches: result.matches.map((match) => ({
        path: match.relativePath,
        line: match.line,
        column: match.column,
        preview: match.snippet
      })),
      truncated:
        result.truncated || result.nextCursor !== undefined
    }
  }

  async getChanges(
    input: WorkspaceChangesInput
  ): Promise<WorkspaceChanges> {
    try {
      const opened = await this.open(input.signal)
      if (opened.handle.git !== 'available') {
        return {
          rootPath: opened.handle.canonicalDisplayPath,
          available: false,
          status: '',
          patch: '',
          files: [],
          truncated: false
        }
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        input.signal?.throwIfAborted()
        const reference = this.reference(opened)
        const [status, diff] = await Promise.all([
          opened.lease
            .getGitStatus(
              remoteGitStatusRequestSchema.parse({
                ...reference,
                includeIgnored: false,
                maximumEntries:
                  REMOTE_WORKSPACE_LIMITS.maximumGitStatusEntries
              }),
              input.signal
            )
            .then((result) =>
              remoteGitStatusResultSchema.parse(result)
            ),
          opened.lease
            .getGitDiff(
              remoteGitDiffRequestSchema.parse({
                ...reference,
                staged: false,
                maximumBytes:
                  REMOTE_WORKSPACE_LIMITS.maximumGitDiffBytes
              }),
              input.signal
            )
            .then((result) =>
              remoteGitDiffResultSchema.parse(result)
            )
        ])
        if (status.repositoryIdentity !== diff.repositoryIdentity) {
          if (attempt === 0) {
            continue
          }
          throw new Error('Git 快照在读取期间持续变化')
        }
        const files = mapChangedFiles(status)
        return {
          rootPath: opened.handle.canonicalDisplayPath,
          available: true,
          status: formatChangedFiles(files),
          patch: diff.patch,
          files,
          truncated:
            status.truncated ||
            diff.truncated ||
            diff.nextCursor !== undefined
        }
      }
      throw new Error('Git 快照读取失败')
    } catch (error) {
      if (input.signal?.aborted) {
        throw error
      }
      return {
        rootPath: this.binding.remoteRootPath,
        available: false,
        status: '',
        patch: '',
        files: [],
        truncated: false,
        error:
          error instanceof Error
            ? error.message
            : '无法读取远程 Git 工作区'
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposal ??= this.disposeOnce()
    return await this.disposal
  }

  private async disposeOnce(): Promise<void> {
    this.disposed = true
    let opened = this.opened
    if (!opened && this.opening) {
      try {
        opened = await this.opening
      } catch {
        return
      }
    }
    if (!opened) {
      return
    }
    let closeError: unknown
    try {
      const request = remoteWorkspaceCloseRequestSchema.parse(
        {
          workspaceId: opened.handle.workspaceId,
          generation: opened.handle.generation
        }
      )
      const result = remoteWorkspaceCloseResultSchema.parse(
        await opened.lease.closeWorkspace(request)
      )
      if (
        result.workspaceId !== request.workspaceId ||
        result.generation !== request.generation
      ) {
        throw new Error('远程工作区关闭确认不匹配')
      }
    } catch (error) {
      closeError = error
    }
    try {
      await opened.lease.release()
    } catch (releaseError) {
      if (closeError === undefined) {
        throw releaseError
      }
      throw new AggregateError(
        [closeError, releaseError],
        '关闭远程工作区失败',
        { cause: releaseError }
      )
    }
    if (closeError !== undefined) {
      throw closeError
    }
  }
}
