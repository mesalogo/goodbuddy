import type {
  DirectoryPage,
  FilePreview,
  SearchPage,
  WorkspaceAccess,
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

const unsupportedRemoteMessage = '远程工作区访问尚不可用'

export class UnsupportedRemoteWorkspaceAccess
implements WorkspaceAccess {
  constructor(
    private readonly message: string = unsupportedRemoteMessage
  ) {}

  private unsupported(): never {
    throw new Error(this.message)
  }

  async getIdentity(): Promise<WorkspaceIdentity> {
    return this.unsupported()
  }

  async listDirectory(
    input: WorkspaceDirectoryInput
  ): Promise<DirectoryPage> {
    void input
    return this.unsupported()
  }

  async stat(input: WorkspacePathInput): Promise<WorkspaceEntry> {
    void input
    return this.unsupported()
  }

  async readText(input: WorkspaceReadInput): Promise<FilePreview> {
    void input
    return this.unsupported()
  }

  async writeTextAtomic(
    input: WorkspaceWriteInput
  ): Promise<WriteResult> {
    void input
    return this.unsupported()
  }

  async search(input: WorkspaceSearchInput): Promise<SearchPage> {
    void input
    return this.unsupported()
  }

  async getChanges(
    input: WorkspaceChangesInput
  ): Promise<WorkspaceChanges> {
    void input
    return this.unsupported()
  }

  async dispose(): Promise<void> {
    // Cleanup is always safe and idempotent, even when access is unsupported.
  }
}
