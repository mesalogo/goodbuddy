import { extname } from 'node:path'
import type {
  WorkspaceChanges,
  WorkspaceDirectoryListing,
  WorkspaceFilePreview
} from '../../shared/assistant-contracts'
import {
  LocalWorkspaceAccess,
  type WorkspaceAccess
} from '../workspace'

const MAX_DIRECTORY_ENTRIES = 500
const MAX_PREVIEW_BYTES = 256 * 1024
const previewExtensions = new Set([
  '.c',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.kts',
  '.log',
  '.md',
  '.markdown',
  '.php',
  '.ps1',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.svelte',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml'
])
const previewFileNames = new Set([
  'dockerfile',
  'license',
  'makefile',
  'notice',
  'readme'
])

export class WorkspaceChangesService {
  constructor(private readonly workspace: WorkspaceAccess) {}

  getChanges(signal?: AbortSignal): Promise<WorkspaceChanges> {
    return this.workspace.getChanges({ signal })
  }

  async listDirectory(
    inputPath: string,
    signal?: AbortSignal
  ): Promise<WorkspaceDirectoryListing> {
    const listing = await this.workspace.listDirectory({
      path: inputPath,
      maximumEntries: MAX_DIRECTORY_ENTRIES,
      includeGit: false,
      includeOther: false,
      signal
    })
    return {
      path: listing.path,
      entries: listing.entries.map((entry) => {
        if (entry.type === 'other') {
          throw new Error('工作区目录返回了不支持的条目类型')
        }
        return {
          name: entry.name,
          path: entry.path,
          type: entry.type
        }
      }),
      truncated: listing.truncated
    }
  }

  async readFile(
    inputPath: string,
    signal?: AbortSignal
  ): Promise<WorkspaceFilePreview> {
    const entry = await this.workspace.stat({
      path: inputPath,
      signal
    })
    if (entry.type !== 'file') {
      throw new Error('目标不是普通文件')
    }
    const extension = extname(entry.name).toLowerCase()
    if (
      !previewExtensions.has(extension) &&
      !previewFileNames.has(entry.name.toLowerCase())
    ) {
      throw new Error('当前文件类型不支持安全预览')
    }
    const preview = await this.workspace.readText({
      path: inputPath,
      maximumBytes: MAX_PREVIEW_BYTES,
      tooLargeMessage: '工作区文件超过 256KB 预览限制',
      invalidUtf8Message: '工作区文件不是有效 UTF-8 文本',
      signal
    })
    return {
      path: preview.path,
      name: preview.name,
      content: preview.content,
      mimeType:
        extension === '.md' || extension === '.markdown'
          ? 'text/markdown'
          : extension === '.json'
            ? 'application/json'
            : 'text/plain',
      size: preview.size
    }
  }
}

async function withLocalWorkspace<T>(
  rootPath: string,
  operation: (workspace: LocalWorkspaceAccess) => Promise<T>
): Promise<T> {
  const workspace = new LocalWorkspaceAccess(rootPath)
  try {
    return await operation(workspace)
  } finally {
    await workspace.dispose()
  }
}

export async function resolveWorkspaceEntryPath(
  rootPath: string,
  inputPath: string,
  expected: 'file' | 'directory'
): Promise<string> {
  return withLocalWorkspace(rootPath, (workspace) =>
    workspace.resolveEntryPath(inputPath, expected)
  )
}

export async function getWorkspaceChanges(
  workspace: string | WorkspaceAccess
): Promise<WorkspaceChanges> {
  if (typeof workspace !== 'string') {
    return new WorkspaceChangesService(workspace).getChanges()
  }
  return withLocalWorkspace(workspace, (access) =>
    new WorkspaceChangesService(access).getChanges()
  )
}

export async function listWorkspaceDirectory(
  workspace: string | WorkspaceAccess,
  inputPath: string
): Promise<WorkspaceDirectoryListing> {
  if (typeof workspace !== 'string') {
    return new WorkspaceChangesService(workspace).listDirectory(inputPath)
  }
  return withLocalWorkspace(workspace, (access) =>
    new WorkspaceChangesService(access).listDirectory(inputPath)
  )
}

export async function readWorkspaceFile(
  workspace: string | WorkspaceAccess,
  inputPath: string
): Promise<WorkspaceFilePreview> {
  if (typeof workspace !== 'string') {
    return new WorkspaceChangesService(workspace).readFile(inputPath)
  }
  return withLocalWorkspace(workspace, (access) =>
    new WorkspaceChangesService(access).readFile(inputPath)
  )
}
