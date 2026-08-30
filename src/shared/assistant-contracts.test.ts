import { describe, expect, it } from 'vitest'
import type { AssistantProject } from './assistant-contracts'
import {
  builtInDefaultProjectSeedDescription,
  builtInDefaultProjectSeedName,
  conversationBranchInputSchema,
  conversationSnapshotSchema,
  isUntouchedBuiltInDefaultProject,
  localConversationSaveBatchSchema,
  persistedProjectExecutionSpaceSchema,
  projectCreateSchema,
  projectExecutionSpaceSchema,
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

  it('persists only the SSH Host and remote path', () => {
    expect(
      persistedProjectExecutionSpaceSchema.parse({
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
      persistedProjectExecutionSpaceSchema.safeParse({
        kind: 'ssh',
        hostId: '00000000-0000-4000-8000-000000000301',
        remoteRootPath: '/srv/goodbuddy',
        validation: { hostRevision: 2 }
      }).success
    ).toBe(false)
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

describe('conversation persistence contracts', () => {
  it('preserves complete tool details without persistence length limits', () => {
    const input = 'input'.repeat(10_000)
    const output = 'output'.repeat(20_000)
    const error = 'error'.repeat(10_000)
    const batch = [
      {
        header: {
          id: '00000000-0000-4000-8000-000000000301',
          title: '远程工具会话',
          updatedAt: 1
        },
        messages: [
          {
            id: '00000000-0000-4000-8000-000000000302',
            role: 'assistant',
            content: '',
            createdAt: 1,
            state: 'complete',
            tools: [
              {
                callId: 'remote-tool-call',
                name: '远程工具',
                state: 'completed',
                summary: '完整远程工具结果',
                input,
                output,
                error
              }
            ]
          }
        ]
      }
    ]

    expect(localConversationSaveBatchSchema.parse(batch)).toEqual(batch)
  })
})
