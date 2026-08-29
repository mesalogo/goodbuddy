import { isAbsolute, normalize, resolve } from 'node:path'
import type { AssistantProject } from '../../shared/assistant-contracts'
import {
  LocalWorkspaceAccess,
  UnsupportedRemoteWorkspaceAccess,
  type RemoteWorkspaceAccessFactory,
  type RemoteWorkspaceProjectBinding,
  type WorkspaceAccess
} from '../workspace'

export const REMOTE_EXECUTION_SPACE_UNAVAILABLE =
  '远程执行空间尚不可用'

export type LocalExecutionSpaceDescriptor = {
  kind: 'local'
  rootPath: string
  cacheIdentity: string
  routeIdentity: string
  workspaceAccess: WorkspaceAccess
}

export type SshExecutionSpaceDescriptor = {
  kind: 'ssh'
  hostId: string
  remoteRootPath: string
  cacheIdentity: string
  routeIdentity: string
  workspaceAccess: WorkspaceAccess
}

export type ExecutionSpaceDescriptor =
  | LocalExecutionSpaceDescriptor
  | SshExecutionSpaceDescriptor

function normalizeLocalIdentity(rootPath: string): string {
  const trimmed = rootPath.trim()
  if (!trimmed) {
    return 'local:unconfigured'
  }
  const normalized = normalize(
    isAbsolute(trimmed) ? trimmed : resolve(trimmed)
  )
  return `local:${
    process.platform === 'win32'
      ? normalized.toLocaleLowerCase('en-US')
      : normalized
  }`
}

export class ExecutionSpaceResolver {
  constructor(
    private readonly remoteWorkspaceAccessFactory?:
      RemoteWorkspaceAccessFactory
  ) {}

  resolveLocal(rootPath: string): LocalExecutionSpaceDescriptor {
    const cacheIdentity = normalizeLocalIdentity(rootPath)
    return {
      kind: 'local',
      rootPath,
      cacheIdentity,
      routeIdentity: cacheIdentity,
      workspaceAccess: new LocalWorkspaceAccess(rootPath)
    }
  }

  resolveProject(project: AssistantProject): ExecutionSpaceDescriptor {
    const executionSpace = project.executionSpace ?? {
      kind: 'local' as const,
      rootPath: project.rootPath
    }
    if (executionSpace.kind === 'local') {
      return this.resolveLocal(executionSpace.rootPath)
    }

    const binding: RemoteWorkspaceProjectBinding = {
      hostId: executionSpace.hostId,
      remoteRootPath: executionSpace.remoteRootPath
    }
    return {
      kind: 'ssh',
      ...binding,
      cacheIdentity: JSON.stringify([
        'ssh',
        binding.hostId,
        binding.remoteRootPath
      ]),
      routeIdentity: JSON.stringify([
        'ssh',
        project.id,
        binding.hostId,
        binding.remoteRootPath
      ]),
      workspaceAccess:
        this.remoteWorkspaceAccessFactory
          ? this.remoteWorkspaceAccessFactory.create(binding)
          : new UnsupportedRemoteWorkspaceAccess(
              REMOTE_EXECUTION_SPACE_UNAVAILABLE
            )
    }
  }

  assertLocal(
    descriptor: ExecutionSpaceDescriptor
  ): asserts descriptor is LocalExecutionSpaceDescriptor {
    if (descriptor.kind !== 'local') {
      throw new Error(REMOTE_EXECUTION_SPACE_UNAVAILABLE)
    }
  }
}
