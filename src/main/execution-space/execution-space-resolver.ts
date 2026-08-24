import { isAbsolute, normalize, resolve } from 'node:path'
import type {
  AssistantProject,
  ProjectRuntimeValidation,
  SshExecutionValidation
} from '../../shared/assistant-contracts'
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
  validation?: SshExecutionValidation
  runtimeValidation?: ProjectRuntimeValidation
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

    const sshValidation = executionSpace.validation
    const runtimeValidation = project.runtimeValidation
    const identity = {
      hostId: executionSpace.hostId,
      remoteRootPath: executionSpace.remoteRootPath,
      validation: sshValidation,
      runtimeValidation
    }
    const remoteBinding: RemoteWorkspaceProjectBinding | undefined =
      sshValidation &&
      runtimeValidation &&
      sshValidation.agentInstallationIdAtValidation ===
        runtimeValidation.agentInstallationIdAtValidation
        ? {
            hostId: executionSpace.hostId,
            remoteRootPath: executionSpace.remoteRootPath,
            hostRevision: sshValidation.hostRevision,
            hostKeyGeneration: sshValidation.hostKeyGeneration,
            remoteUsername: sshValidation.remoteUsername,
            workspaceIdentity: sshValidation.workspaceIdentity,
            agentProtocolMajor: sshValidation.agentProtocolMajor,
            agentInstallationId:
              sshValidation.agentInstallationIdAtValidation,
            agentBinaryDigest:
              sshValidation.agentBinaryDigestAtValidation,
            agentVersion: sshValidation.agentVersionAtValidation,
            agentArchitecture:
              sshValidation.agentArchitectureAtValidation
          }
        : undefined
    return {
      kind: 'ssh',
      ...identity,
      cacheIdentity: JSON.stringify([
        'ssh',
        identity.hostId,
        identity.remoteRootPath,
        identity.validation
          ? [
              identity.validation.hostRevision,
              identity.validation.hostKeyGeneration,
              identity.validation.remoteUsername,
              identity.validation.workspaceIdentity,
              identity.validation.agentProtocolMajor,
              identity.validation.agentInstallationIdAtValidation,
              identity.validation.agentBinaryDigestAtValidation,
              identity.validation.agentVersionAtValidation,
              identity.validation.agentArchitectureAtValidation,
              identity.validation.validatedAt
            ]
          : null,
        identity.runtimeValidation
          ? [
              identity.runtimeValidation.runtimeSelectionKey,
              identity.runtimeValidation.runtimeBundleDigest,
              identity.runtimeValidation.runtimeAdapterDigest,
              identity.runtimeValidation
                .agentInstallationIdAtValidation,
              identity.runtimeValidation.validatedAt,
              identity.runtimeValidation.workMode
            ]
          : null
      ]),
      routeIdentity: JSON.stringify([
        'ssh',
        project.id,
        identity.hostId,
        identity.remoteRootPath
      ]),
      workspaceAccess:
        remoteBinding && this.remoteWorkspaceAccessFactory
          ? this.remoteWorkspaceAccessFactory.create(remoteBinding)
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
