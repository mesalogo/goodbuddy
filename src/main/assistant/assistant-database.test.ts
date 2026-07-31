import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AssistantDatabase } from './assistant-database'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

async function createDatabase(): Promise<AssistantDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-assistant-'))
  temporaryDirectories.push(directory)
  const database = new AssistantDatabase(join(directory, 'assistant.sqlite'))
  database.initialize('C:\\Workspace')
  return database
}

describe('AssistantDatabase', () => {
  it('creates a default project and persists project updates', async () => {
    const database = await createDatabase()
    const [defaultProject] = database.listProjects()
    expect(defaultProject).toMatchObject({
      name: '默认项目',
      rootPath: 'C:\\Workspace',
      defaultWorkMode: 'ask',
      status: 'active'
    })
    expect(database.listExperts()).toHaveLength(3)

    const project = database.createProject({
      name: '产品发布',
      description: '发布资料和任务',
      rootPath: 'C:\\Release',
      defaultWorkMode: 'plan'
    })
    expect(database.listProjects()).toHaveLength(2)

    const updated = database.updateProject(project.id, {
      name: '产品发布 2',
      description: '更新后的项目',
      rootPath: 'C:\\Release',
      defaultWorkMode: 'execute'
    })
    expect(updated).toMatchObject({
      name: '产品发布 2',
      defaultWorkMode: 'execute'
    })

    database.setProjectArchived(project.id, true)
    expect(database.listProjects()).toHaveLength(1)
    expect(database.listProjects(true)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: project.id,
          status: 'archived'
        })
      ])
    )
    database.close()
  })

  it('persists task lifecycle and events', async () => {
    const database = await createDatabase()
    const project = database.listProjects()[0]!
    const taskId = '00000000-0000-4000-8000-000000000201'
    database.createTask({
      id: taskId,
      projectId: project.id,
      conversationId: 'conversation-1',
      title: '整理发布说明',
      instructions: '根据本次变更整理说明',
      workMode: 'execute'
    })
    expect(database.listTasks()[0]).toMatchObject({
      id: taskId,
      status: 'running',
      projectId: project.id
    })

    database.updateTaskStatus(taskId, 'waiting_approval')
    expect(database.listTasks()[0]).toMatchObject({
      status: 'waiting_approval'
    })
    database.updateTaskStatus(taskId, 'completed')
    expect(database.listTasks()[0]).toMatchObject({
      status: 'completed',
      completedAt: expect.any(String)
    })
    const artifact = database.createTextArtifact({
      projectId: project.id,
      taskId,
      title: '发布说明',
      content: '# 发布说明\n\n内容'
    })
    expect(database.listArtifacts(project.id)).toEqual([
      expect.objectContaining({
        id: artifact.id,
        kind: 'markdown',
        content: '# 发布说明\n\n内容'
      })
    ])
    const memory = database.createMemory({
      scope: 'project',
      scopeId: project.id,
      type: 'preference',
      content: '使用简洁中文回复'
    })
    expect(database.listMemories(project.id)).toEqual([
      expect.objectContaining({
        id: memory.id,
        status: 'confirmed',
        content: '使用简洁中文回复'
      })
    ])
    database.removeMemory(memory.id)
    expect(database.listMemories(project.id)).toEqual([])
    const schedule = database.createSchedule({
      projectId: project.id,
      title: '每日摘要',
      prompt: '总结今天的任务状态',
      workMode: 'ask',
      recurrence: 'daily',
      nextRunAt: '2026-07-31T00:00:00.000Z'
    })
    expect(
      database.claimDueSchedules(new Date('2026-07-31T00:01:00.000Z'))
    ).toEqual([expect.objectContaining({ id: schedule.id })])
    expect(database.listSchedules(project.id)[0]).toMatchObject({
      id: schedule.id,
      nextRunAt: '2026-08-01T00:00:00.000Z',
      lastRunAt: '2026-07-31T00:01:00.000Z'
    })
    const overdue = database.createSchedule({
      projectId: project.id,
      title: '过期摘要',
      prompt: '总结任务状态',
      workMode: 'ask',
      recurrence: 'daily',
      nextRunAt: '2025-07-31T00:00:00.000Z'
    })
    database.claimDueSchedules(
      new Date('2026-07-31T00:01:00.000Z')
    )
    expect(
      database
        .listSchedules(project.id)
        .find((item) => item.id === overdue.id)
    ).toMatchObject({
      nextRunAt: '2026-08-01T00:00:00.000Z'
    })
    database.close()
  })

  it('replaces and restores bounded conversation snapshots', async () => {
    const database = await createDatabase()
    const project = database.listProjects()[0]!
    const conversationId = '00000000-0000-4000-8000-000000000211'
    database.replaceConversations([
      {
        id: conversationId,
        projectId: project.id,
        title: '发布讨论',
        updatedAt: 1_775_000_000_000,
        messages: [
          {
            id: '00000000-0000-4000-8000-000000000212',
            role: 'user',
            content: '整理发布说明',
            createdAt: 1_775_000_000_000,
            state: 'complete'
          },
          {
            id: '00000000-0000-4000-8000-000000000213',
            role: 'assistant',
            content: '处理中',
            createdAt: 1_775_000_001_000,
            state: 'streaming'
          }
        ]
      }
    ])

    expect(database.listConversations()).toEqual([
      expect.objectContaining({
        id: conversationId,
        projectId: project.id,
        messages: [
          expect.objectContaining({ role: 'user', state: 'complete' }),
          expect.objectContaining({
            role: 'assistant',
            state: 'error',
            status: expect.stringContaining('意外中断')
          })
        ]
      })
    ])
    database.replaceConversations([])
    expect(database.listConversations()).toEqual([])
    database.close()
  })

  it('persists remote delegation results until delivery succeeds', async () => {
    const database = await createDatabase()
    const taskId = '00000000-0000-4000-8000-000000000221'
    database.saveDelegationResult(taskId, {
      status: 'completed',
      output: '远程结果'
    })

    expect(database.listPendingDelegationResults()).toEqual([
      {
        taskId,
        result: {
          status: 'completed',
          output: '远程结果'
        }
      }
    ])
    database.markDelegationDelivered(taskId)
    expect(database.listPendingDelegationResults()).toEqual([])
    expect(database.getDelegationDeliveryStatus(taskId)).toBe(
      'delivered'
    )
    database.close()
  })
})
