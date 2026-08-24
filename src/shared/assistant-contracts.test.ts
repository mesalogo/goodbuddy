import { describe, expect, it } from 'vitest'
import type { AssistantProject } from './assistant-contracts'
import {
  builtInDefaultProjectSeedDescription,
  builtInDefaultProjectSeedName,
  conversationBranchInputSchema,
  conversationSnapshotSchema,
  isUntouchedBuiltInDefaultProject,
  persistedProjectExecutionSpaceSchema,
  projectCreateSchema,
  projectExecutionSpaceSchema,
  projectRuntimeValidationSchema,
  sshExecutionValidationSchema,
  projectUpdateSchema
} from './assistant-contracts'

const untouchedProject: AssistantProject = {
  id: '00000000-0000-4000-8000-000000000101',
  name: builtInDefaultProjectSeedName,
  description: builtInDefaultProjectSeedDescription,
  rootPath: 'C:\\Workspace',
  executionSpace: {
    kind: 'local',
    rootPath: 'C:\\Workspace'
  },
  defaultWorkMode: 'ask',
  kind: 'user',
  builtInDefault: true,
  status: 'active',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z'
}

describe('isUntouchedBuiltInDefaultProject', () => {
  it('requires the persistent marker and exact seed text', () => {
    expect(isUntouchedBuiltInDefaultProject(untouchedProject)).toBe(true)

    const changedProjects: AssistantProject[] = [
      { ...untouchedProject, name: '默认项目 ' },
      { ...untouchedProject, description: 'GoodBuddy 默认工作区 ' },
      { ...untouchedProject, builtInDefault: false },
      { ...untouchedProject, builtInDefault: undefined }
    ]

    expect(
      changedProjects.every(
        (project) => !isUntouchedBuiltInDefaultProject(project)
      )
    ).toBe(true)
  })

  it('does not infer identity for an independently created identical project', () => {
    const independentProject = { ...untouchedProject }
    delete independentProject.builtInDefault
    expect(
      isUntouchedBuiltInDefaultProject(independentProject)
    ).toBe(false)
  })

  it('keeps identity across unrelated project setting changes', () => {
    expect(
      isUntouchedBuiltInDefaultProject({
        ...untouchedProject,
        rootPath: 'D:\\Moved',
        defaultWorkMode: 'execute',
        runtimeSelection: { provider: 'continue' },
        status: 'archived',
        updatedAt: '2026-08-01T00:00:01.000Z'
      })
    ).toBe(true)
  })

  it('does not accept the read-only marker in project inputs', () => {
    const input = {
      name: builtInDefaultProjectSeedName,
      description: builtInDefaultProjectSeedDescription,
      rootPath: 'C:\\Workspace',
      defaultWorkMode: 'ask',
      builtInDefault: true
    }
    expect(projectCreateSchema.safeParse(input).success).toBe(false)
    expect(projectUpdateSchema.safeParse(input).success).toBe(false)
  })
})

describe('project execution space contracts', () => {
  it('parses strict local and SSH output without normalizing paths', () => {
    expect(
      projectExecutionSpaceSchema.parse({
        kind: 'local',
        rootPath: ''
      })
    ).toEqual({ kind: 'local', rootPath: '' })
    expect(
      projectExecutionSpaceSchema.parse({
        kind: 'local',
        rootPath: '  '
      })
    ).toEqual({ kind: 'local', rootPath: '  ' })
    expect(
      projectExecutionSpaceSchema.parse({
        kind: 'ssh',
        hostId: '00000000-0000-4000-8000-000000000301',
        remoteRootPath: '/srv/goodbuddy'
      })
    ).toEqual({
      kind: 'ssh',
      hostId: '00000000-0000-4000-8000-000000000301',
      remoteRootPath: '/srv/goodbuddy'
    })

    expect(
      projectExecutionSpaceSchema.safeParse({
        kind: 'local',
        rootPath: 'C:\\Workspace',
        hostId: '00000000-0000-4000-8000-000000000301'
      }).success
    ).toBe(false)
    expect(
      projectExecutionSpaceSchema.safeParse({
        kind: 'ssh',
        hostId: 'not-a-host-id',
        remoteRootPath: '/srv/goodbuddy'
      }).success
    ).toBe(false)
    expect(
      projectExecutionSpaceSchema.safeParse({
        kind: 'ssh',
        hostId: '00000000-0000-4000-8000-000000000301',
        remoteRootPath: ' '
      }).success
    ).toBe(false)
  })

  it('keeps SSH and Runtime validation identities separate and strict', () => {
    const validatedAt = '2026-08-21T00:00:00.000Z'
    const validation = {
      hostRevision: 2,
      hostKeyGeneration: 3,
      remoteUsername: 'builder',
      workspaceIdentity: 'workspace-identity',
      agentProtocolMajor: 1,
      agentInstallationIdAtValidation: 'agent-installation',
      agentBinaryDigestAtValidation: `sha256:${'a'.repeat(64)}`,
      agentVersionAtValidation: '0.11.0',
      agentArchitectureAtValidation: 'x64',
      validatedAt
    }
    const runtimeValidation = {
      runtimeSelectionKey: 'opencode:profile',
      runtimeBundleDigest: `sha256:${'b'.repeat(64)}`,
      runtimeAdapterDigest: `sha256:${'c'.repeat(64)}`,
      agentInstallationIdAtValidation: 'agent-installation',
      validatedAt,
      workMode: 'execute'
    }
    expect(
      sshExecutionValidationSchema.safeParse(validation).success
    ).toBe(true)
    expect(
      projectRuntimeValidationSchema.safeParse(runtimeValidation)
        .success
    ).toBe(true)
    expect(
      persistedProjectExecutionSpaceSchema.parse({
        kind: 'ssh',
        hostId: '00000000-0000-4000-8000-000000000301',
        remoteRootPath: '/srv/goodbuddy',
        validation
      })
    ).toEqual({
      kind: 'ssh',
      hostId: '00000000-0000-4000-8000-000000000301',
      remoteRootPath: '/srv/goodbuddy',
      validation
    })
    expect(
      sshExecutionValidationSchema.safeParse({
        hostRevision: 2,
        hostKeyGeneration: 3,
        remoteUsername: 'builder',
        workspaceIdentity: 'workspace-identity',
        agentProtocolMajor: 1,
        agentInstallationIdAtValidation: 'agent-installation',
        agentBinaryDigestAtValidation: `sha256:${'a'.repeat(64)}`,
        agentVersionAtValidation: '0.11.0',
        agentArchitectureAtValidation: 'x64',
        validatedAt,
        runtimeBundleDigest: 'must-not-be-here'
      }).success
    ).toBe(false)
    expect(
      persistedProjectExecutionSpaceSchema.safeParse({
        kind: 'local',
        rootPath: 'C:\\Workspace',
        validation
      }).success
    ).toBe(false)
    expect(
      persistedProjectExecutionSpaceSchema.safeParse({
        kind: 'ssh',
        hostId: '00000000-0000-4000-8000-000000000301',
        remoteRootPath: '/srv/goodbuddy',
        hostRevision: 2
      }).success
    ).toBe(false)

    for (const invalid of [
      { ...validation, hostRevision: 0 },
      { ...validation, trustAttestationRevision: 4 },
      {
        ...validation,
        agentBinaryDigestAtValidation: `sha256:${'A'.repeat(64)}`
      },
      { ...validation, agentVersionAtValidation: ' version ' },
      { ...validation, agentArchitectureAtValidation: 'ia32' }
    ]) {
      expect(
        sshExecutionValidationSchema.safeParse(invalid).success
      ).toBe(false)
    }

    for (const invalid of [
      {
        ...runtimeValidation,
        runtimeBundleDigest: 'runtime-digest'
      },
      { ...runtimeValidation, trustTier: 'T3' },
      {
        ...runtimeValidation,
        confinementPolicyDigest: `sha256:${'d'.repeat(64)}`
      },
      { ...runtimeValidation, approvalBridgeVersion: '1' },
      {
        ...runtimeValidation,
        workMode: 'plan'
      }
    ]) {
      expect(
        projectRuntimeValidationSchema.safeParse(invalid).success
      ).toBe(false)
    }
    expect(
      projectRuntimeValidationSchema.safeParse({
        ...runtimeValidation,
        workMode: 'ask'
      }).success
    ).toBe(true)
  })

  it('keeps renderer project create and update inputs local-only', () => {
    const input = {
      name: '远程草稿',
      description: '',
      rootPath: '/srv/goodbuddy',
      defaultWorkMode: 'ask',
      executionSpace: {
        kind: 'ssh',
        hostId: '00000000-0000-4000-8000-000000000301',
        remoteRootPath: '/srv/goodbuddy'
      }
    }
    expect(projectCreateSchema.safeParse(input).success).toBe(false)
    expect(projectUpdateSchema.safeParse(input).success).toBe(false)
  })
})

describe('conversation branch contracts', () => {
  it('accepts bounded branch provenance and rejects renderer extras', () => {
    const sourceConversationId =
      '00000000-0000-4000-8000-000000000201'
    expect(
      conversationBranchInputSchema.parse({
        sourceConversationId,
        title: '方案讨论 · 分支'
      })
    ).toEqual({
      sourceConversationId,
      title: '方案讨论 · 分支'
    })
    expect(
      conversationBranchInputSchema.safeParse({
        sourceConversationId,
        title: '方案讨论 · 分支',
        copyTasks: true
      }).success
    ).toBe(false)
    expect(
      conversationSnapshotSchema.safeParse({
        id: '00000000-0000-4000-8000-000000000202',
        branch: {
          sourceConversationId,
          sourceTitle: '方案讨论'
        },
        title: '方案讨论 · 分支',
        updatedAt: 1,
        messages: []
      }).success
    ).toBe(true)
  })
})
