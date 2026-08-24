import type {
  WorkspaceChanges,
  WorkspaceChangedFile
} from '../../shared/assistant-contracts'

export type WorkspaceIdentity = {
  kind: 'local' | 'remote'
  id: string
  canonicalDisplayPath: string
  access: 'read-only' | 'read-write'
}

export type WorkspacePathInput = {
  path: string
  signal?: AbortSignal
}

export type WorkspaceDirectoryInput = WorkspacePathInput & {
  maximumEntries?: number
  includeGit?: boolean
  includeOther?: boolean
}

export type WorkspaceDirectoryEntry = {
  name: string
  path: string
  type: 'file' | 'directory' | 'other'
}

export type DirectoryPage = {
  path: string
  entries: WorkspaceDirectoryEntry[]
  truncated: boolean
}

export type WorkspaceEntry = WorkspaceDirectoryEntry & {
  size: number
  modifiedAt: string
}

export type WorkspaceReadInput = WorkspacePathInput & {
  maximumBytes?: number
  tooLargeMessage?: string
  invalidUtf8Message?: string
}

export type FilePreview = {
  path: string
  name: string
  content: string
  size: number
}

export type WorkspaceWriteInput = WorkspacePathInput & {
  content: string
  maximumBytes?: number
}

export type WriteResult = {
  path: string
  bytesWritten: number
}

export type WorkspaceSearchInput = {
  query: string
  path?: string
  maximumResults?: number
  maximumFileBytes?: number
  maximumScannedBytes?: number
  signal?: AbortSignal
}

export type WorkspaceSearchMatch = {
  path: string
  line: number
  column: number
  preview: string
}

export type SearchPage = {
  matches: WorkspaceSearchMatch[]
  truncated: boolean
}

export type WorkspaceChangesInput = {
  signal?: AbortSignal
}

export type { WorkspaceChanges, WorkspaceChangedFile }

export interface WorkspaceAccess {
  getIdentity(): Promise<WorkspaceIdentity>
  listDirectory(input: WorkspaceDirectoryInput): Promise<DirectoryPage>
  stat(input: WorkspacePathInput): Promise<WorkspaceEntry>
  readText(input: WorkspaceReadInput): Promise<FilePreview>
  writeTextAtomic(input: WorkspaceWriteInput): Promise<WriteResult>
  search(input: WorkspaceSearchInput): Promise<SearchPage>
  getChanges(input: WorkspaceChangesInput): Promise<WorkspaceChanges>
  dispose(): Promise<void>
}
