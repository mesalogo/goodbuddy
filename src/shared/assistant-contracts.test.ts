import { describe, expect, it } from 'vitest'
import type { AssistantProject } from './assistant-contracts'
import {
  builtInDefaultProjectSeedDescription,
  builtInDefaultProjectSeedName,
  conversationBranchInputSchema,
  conversationMessageSchema,
  conversationSubagentActivitySchema,
  conversationSnapshotSchema,
  isUntouchedBuiltInDefaultProject,
  localConversationSaveBatchSchema,
  persistedProjectExecutionSpaceSchema,
  projectCreateSchema,
  projectExecutionSpaceSchema,
  projectUpdateSchema
} from './assistant-contracts'
import { subagentEventSchema } from './contracts'

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

describe('conversation activity contracts', () => {
  it('accepts long activity runs within the retained display bounds', () => {
    const tools = Array.from({ length: 101 }, (_, index) => ({
      callId: `call-${index + 1}`,
      name: 'read',
      state: 'completed' as const,
      summary: `Tool ${index + 1}`
    }))
    const subagents = Array.from({ length: 101 }, (_, index) => ({
      childTaskId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      routingMode: 'native' as const,
      actor: {
        kind: 'direct-model' as const,
        label: '编程 Subagent' as const
      },
      state: 'completed' as const
    }))

    expect(
      conversationMessageSchema.parse({
        id: '00000000-0000-4000-8000-000000000999',
        role: 'assistant',
        content: '',
        blocks: tools.map((tool, index) => ({
          id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          type: 'tool',
          tool
        })),
        createdAt: 1,
        state: 'complete',
        displayCaptureTruncated: true,
        tools,
        subagents
      })
    ).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({ callId: 'call-101' })
      ]),
      subagents: expect.arrayContaining([
        expect.objectContaining({
          childTaskId: '00000000-0000-4000-8000-000000000101'
        })
      ])
    })
  })

  it('rejects conversation activity and block arrays beyond display bounds', () => {
    const baseMessage = {
      id: '00000000-0000-4000-8000-000000000999',
      role: 'assistant' as const,
      content: '',
      createdAt: 1,
      state: 'complete' as const
    }
    expect(
      conversationMessageSchema.safeParse({
        ...baseMessage,
        tools: Array.from({ length: 501 }, (_, index) => ({
          callId: `call-${index + 1}`,
          name: 'read',
          state: 'completed' as const,
          summary: `Tool ${index + 1}`
        }))
      }).success
    ).toBe(false)
    expect(
      conversationMessageSchema.safeParse({
        ...baseMessage,
        blocks: Array.from({ length: 2_001 }, (_, index) => ({
          id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          type: 'text' as const,
          content: 'x'
        }))
      }).success
    ).toBe(false)
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

  it('accepts persisted native OpenCode subagent activity', () => {
    const batch = [
      {
        header: {
          id: '00000000-0000-4000-8000-000000000311',
          title: 'OpenCode 子 Agent',
          updatedAt: 1
        },
        messages: [
          {
            id: '00000000-0000-4000-8000-000000000312',
            role: 'assistant',
            content: '',
            createdAt: 1,
            state: 'complete',
            blocks: [
              {
                id: '00000000-0000-4000-8000-000000000315',
                type: 'subagent',
                childTaskId:
                  '00000000-0000-4000-8000-000000000313'
              }
            ],
            subagents: [
              {
                childTaskId:
                  '00000000-0000-4000-8000-000000000313',
                expertId:
                  '00000000-0000-4000-8000-000000000314',
                expertName: 'explorer',
                routingMode: 'native',
                runtimeCallId: 'call-task-1',
                state: 'completed',
                reason: 'Review application architecture',
                output: 'Architecture review complete.'
              }
            ]
          }
        ]
      }
    ]

    expect(localConversationSaveBatchSchema.parse(batch)).toEqual(batch)
  })

  it('keeps legacy expert activities', () => {
    const legacy = {
      childTaskId: '00000000-0000-4000-8000-000000000321',
      expertId: '00000000-0000-4000-8000-000000000322',
      expertName: '代码专家',
      routingMode: 'manual',
      state: 'completed'
    }
    expect(conversationSubagentActivitySchema.parse(legacy))
      .toEqual(legacy)
  })

  it('stores a direct-model child run in the existing child task slot', () => {
    const directModel = {
      childTaskId: '00000000-0000-4000-8000-000000000325',
      actor: {
        kind: 'direct-model',
        label: '编程 Subagent'
      },
      routingMode: 'native',
      workMode: 'execute',
      state: 'completed',
      reason: '修复并验证聚焦变更',
      output: '验证通过'
    }

    expect(
      conversationSubagentActivitySchema.parse(directModel)
    ).toEqual(directModel)
    expect(
      conversationSubagentActivitySchema.safeParse({
        ...directModel,
        childRunId: directModel.childTaskId
      }).success
    ).toBe(false)
    expect(
      subagentEventSchema.parse({
        requestId: '00000000-0000-4000-8000-000000000326',
        type: 'subagent',
        ...directModel
      })
    ).toEqual({
      requestId: '00000000-0000-4000-8000-000000000326',
      type: 'subagent',
      ...directModel
    })
  })
})
