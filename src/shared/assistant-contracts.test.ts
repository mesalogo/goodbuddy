import { describe, expect, it } from 'vitest'
import type { AssistantProject } from './assistant-contracts'
import {
  builtInDefaultProjectSeedDescription,
  builtInDefaultProjectSeedName,
  conversationBranchInputSchema,
  conversationSnapshotSchema,
  isUntouchedBuiltInDefaultProject,
  projectCreateSchema,
  projectUpdateSchema
} from './assistant-contracts'

const untouchedProject: AssistantProject = {
  id: '00000000-0000-4000-8000-000000000101',
  name: builtInDefaultProjectSeedName,
  description: builtInDefaultProjectSeedDescription,
  rootPath: 'C:\\Workspace',
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
