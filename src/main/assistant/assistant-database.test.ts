import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
  it('migrates existing databases to schema version 6', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-assistant-migration-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const initial = new AssistantDatabase(databasePath)
    initial.initialize('C:\\Workspace')
    initial.close()

    const oldDatabase = new DatabaseSync(databasePath)
    oldDatabase.exec(`
      DROP TABLE model_usage_calls;
      PRAGMA user_version = 3;
    `)
    oldDatabase.close()

    const migrated = new AssistantDatabase(databasePath)
    migrated.initialize('C:\\Workspace')
    migrated.close()

    const current = new DatabaseSync(databasePath)
    expect(
      (
        current.prepare('PRAGMA user_version').get() as {
          user_version: number
        }
      ).user_version
    ).toBe(6)
    expect(
      current
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'model_usage_calls'`
        )
        .get()
    ).toEqual({ name: 'model_usage_calls' })
    const foreignKeys = current
      .prepare('PRAGMA foreign_key_list(model_usage_calls)')
      .all() as Array<{
      table: string
      from: string
      to: string
      on_delete: string
    }>
    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'tasks',
          from: 'request_id',
          to: 'id',
          on_delete: 'CASCADE'
        })
      ])
    )
    expect(
      current
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index'
             AND name IN ('tasks_status_idx', 'messages_state_idx')
           ORDER BY name`
        )
        .all()
    ).toEqual([
      { name: 'messages_state_idx' },
      { name: 'tasks_status_idx' }
    ])
    current.close()
  })

  it('idempotently migrates version 5 databases to computer control audit schema', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-control-audit-migration-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const initial = new AssistantDatabase(databasePath)
    initial.initialize('C:\\Workspace')
    initial.close()

    const versionFive = new DatabaseSync(databasePath)
    versionFive.exec(`
      DROP TABLE computer_control_actions;
      PRAGMA user_version = 5;
    `)
    versionFive.close()

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const migrated = new AssistantDatabase(databasePath)
      migrated.initialize('C:\\Workspace')
      migrated.close()
    }

    const current = new DatabaseSync(databasePath)
    expect(
      (
        current.prepare('PRAGMA user_version').get() as {
          user_version: number
        }
      ).user_version
    ).toBe(6)
    expect(
      current
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table'
             AND name = 'computer_control_actions'`
        )
        .get()
    ).toEqual({ name: 'computer_control_actions' })
    expect(
      current
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index'
             AND name = 'computer_control_actions_recent_idx'`
        )
        .get()
    ).toEqual({ name: 'computer_control_actions_recent_idx' })
    expect(
      current
        .prepare(
          'PRAGMA foreign_key_list(computer_control_actions)'
        )
        .all()
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'tasks',
          from: 'task_id',
          to: 'id',
          on_delete: 'CASCADE'
        })
      ])
    )
    current.close()
  })

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

  it('creates, updates, and soft-deletes expert roles', async () => {
    const database = await createDatabase()
    const expert = database.createExpert({
      name: '代码审查专家',
      description: '检查代码正确性',
      systemInstructions: 'Review code for actionable bugs.'
    })

    const updated = database.updateExpert(expert.id, {
      name: '高级代码审查专家',
      description: '检查正确性和安全性',
      systemInstructions: 'Review correctness and security risks.'
    })
    expect(updated).toMatchObject({
      id: expert.id,
      name: '高级代码审查专家',
      description: '检查正确性和安全性',
      systemInstructions: 'Review correctness and security risks.',
      enabled: true
    })

    database.removeExpert(expert.id)

    expect(
      database.listExperts().some((item) => item.id === expert.id)
    ).toBe(false)
    expect(() => database.getExpert(expert.id)).toThrow(
      '专家不存在或已停用'
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

  it('durably interrupts active tasks with completion times and audit events on startup', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-assistant-recovery-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const runningTaskId =
      '00000000-0000-4000-8000-000000000202'
    const approvalTaskId =
      '00000000-0000-4000-8000-000000000203'
    const initial = new AssistantDatabase(databasePath)
    initial.initialize('C:\\Workspace')
    initial.createTask({
      id: runningTaskId,
      title: '运行中的任务',
      instructions: '等待启动恢复',
      workMode: 'execute'
    })
    initial.createTask({
      id: approvalTaskId,
      title: '等待审批的任务',
      instructions: '等待启动恢复',
      workMode: 'execute'
    })
    initial.updateTaskStatus(approvalTaskId, 'waiting_approval')
    initial.close()

    const recovered = new AssistantDatabase(databasePath)
    recovered.initialize('C:\\Workspace')
    const recoveredTasks = recovered
      .listTasks()
      .filter((task) =>
        [runningTaskId, approvalTaskId].includes(task.id)
      )
    expect(recoveredTasks).toHaveLength(2)
    expect(recoveredTasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: runningTaskId,
          status: 'interrupted',
          completedAt: expect.any(String),
          error: '应用退出时任务仍在运行'
        }),
        expect.objectContaining({
          id: approvalTaskId,
          status: 'interrupted',
          completedAt: expect.any(String),
          error: '应用退出时任务仍在运行'
        })
      ])
    )
    recovered.close()

    const reopenedAgain = new AssistantDatabase(databasePath)
    reopenedAgain.initialize('C:\\Workspace')
    expect(
      reopenedAgain
        .listTasks()
        .filter((task) =>
          [runningTaskId, approvalTaskId].includes(task.id)
        )
    ).toEqual(recoveredTasks)
    reopenedAgain.close()

    const durable = new DatabaseSync(databasePath)
    const statusEvents = durable
      .prepare(
        `SELECT task_id, payload_json
         FROM task_events
         WHERE task_id IN (?, ?) AND kind = 'status'
         ORDER BY task_id, id`
      )
      .all(runningTaskId, approvalTaskId) as Array<{
      task_id: string
      payload_json: string
    }>
    const recoveryEvents = statusEvents
      .map((event) => ({
        taskId: event.task_id,
        payload: JSON.parse(event.payload_json) as {
          status: string
          error?: string
        }
      }))
      .filter((event) => event.payload.status === 'interrupted')
    expect(recoveryEvents).toEqual([
      {
        taskId: runningTaskId,
        payload: {
          status: 'interrupted',
          error: '应用退出时任务仍在运行'
        }
      },
      {
        taskId: approvalTaskId,
        payload: {
          status: 'interrupted',
          error: '应用退出时任务仍在运行'
        }
      }
    ])
    durable.close()
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
            state: 'streaming',
            artifactIds: [
              '00000000-0000-4000-8000-000000000216'
            ],
            sourceReferences: [
              {
                libraryId: '00000000-0000-4000-8000-000000000214',
                libraryName: '产品知识',
                documentId: '00000000-0000-4000-8000-000000000215',
                documentName: '发布说明.md',
                sourceName: '发布目录',
                snippet: '发布前需要完成验证。',
                rank: -0.03,
                retrievalChannels: ['fts', 'vector']
              }
            ]
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
            status: expect.stringContaining('意外中断'),
            artifactIds: [
              '00000000-0000-4000-8000-000000000216'
            ],
            sourceReferences: [
              expect.objectContaining({
                documentName: '发布说明.md',
                retrievalChannels: ['fts', 'vector']
              })
            ]
          })
        ]
      })
    ])
    database.replaceConversations([])
    expect(database.listConversations()).toEqual([])
    database.close()
  })

  it('durably interrupts active tool metadata during startup recovery', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-conversation-recovery-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const conversationId =
      '00000000-0000-4000-8000-000000000217'
    const messageId = '00000000-0000-4000-8000-000000000218'
    const cancelledMessageId =
      '00000000-0000-4000-8000-000000000219'
    const initial = new AssistantDatabase(databasePath)
    initial.initialize('C:\\Workspace')
    initial.replaceConversations([
      {
        id: conversationId,
        title: '工具恢复',
        updatedAt: 1_775_000_000_000,
        messages: [
          {
            id: messageId,
            role: 'assistant',
            content: '工具仍在运行',
            createdAt: 1_775_000_001_000,
            state: 'streaming',
            status: '正在执行工具',
            tools: [
              {
                name: 'pending-tool',
                state: 'pending',
                summary: '等待调用'
              },
              {
                name: 'running-tool',
                state: 'running',
                summary: '正在调用'
              },
              {
                name: 'completed-tool',
                state: 'completed',
                summary: '调用完成'
              },
              {
                name: 'failed-tool',
                state: 'failed',
                summary: '调用失败'
              }
            ]
          },
          {
            id: cancelledMessageId,
            role: 'assistant',
            content: '请求已取消',
            createdAt: 1_775_000_002_000,
            state: 'error',
            status: '请求已取消',
            tools: [
              {
                name: 'cancelled-tool',
                state: 'running',
                summary: '取消前仍在运行'
              }
            ]
          }
        ]
      }
    ])
    initial.close()

    const recovered = new AssistantDatabase(databasePath)
    recovered.initialize('C:\\Workspace')
    expect(recovered.listConversations()[0]?.messages[0]).toMatchObject({
      id: messageId,
      state: 'error',
      status: '上次运行意外中断，可以重新发送问题',
      tools: [
        expect.objectContaining({
          name: 'pending-tool',
          state: 'interrupted'
        }),
        expect.objectContaining({
          name: 'running-tool',
          state: 'interrupted'
        }),
        expect.objectContaining({
          name: 'completed-tool',
          state: 'completed'
        }),
        expect.objectContaining({ name: 'failed-tool', state: 'failed' })
      ]
    })
    expect(recovered.listConversations()[0]?.messages[1]).toMatchObject({
      id: cancelledMessageId,
      state: 'error',
      status: '请求已取消',
      tools: [
        expect.objectContaining({
          name: 'cancelled-tool',
          state: 'interrupted'
        })
      ]
    })
    recovered.close()

    const durable = new DatabaseSync(databasePath)
    const row = durable
      .prepare(
        `SELECT state, metadata_json
         FROM messages
         WHERE id = ?`
      )
      .get(messageId) as {
      state: string
      metadata_json: string
    }
    const metadata = JSON.parse(row.metadata_json) as {
      status?: string
      tools?: Array<{ name: string; state: string }>
    }
    expect(row.state).toBe('error')
    expect(metadata.status).toBe(
      '上次运行意外中断，可以重新发送问题'
    )
    expect(metadata.tools?.map((tool) => tool.state)).toEqual([
      'interrupted',
      'interrupted',
      'completed',
      'failed'
    ])
    const cancelledRow = durable
      .prepare(
        `SELECT metadata_json
         FROM messages
         WHERE id = ?`
      )
      .get(cancelledMessageId) as { metadata_json: string }
    expect(
      (
        JSON.parse(cancelledRow.metadata_json) as {
          tools?: Array<{ state: string }>
        }
      ).tools?.[0]?.state
    ).toBe('interrupted')
    durable.close()
  })

  it('loads image artifact content only when requested by id', async () => {
    const database = await createDatabase()
    const artifact = database.createInlineArtifact({
      kind: 'image',
      title: '生成图片',
      mimeType: 'image/png',
      content: 'data:image/png;base64,iVBORw0KGgo='
    })

    expect(
      database.listArtifacts().find((item) => item.id === artifact.id)
    ).toMatchObject({
      id: artifact.id,
      content: undefined
    })
    expect(database.getArtifact(artifact.id)).toMatchObject({
      id: artifact.id,
      content: 'data:image/png;base64,iVBORw0KGgo='
    })
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

  it('upserts absolute token usage snapshots idempotently', async () => {
    const database = await createDatabase()
    const taskId = '00000000-0000-4000-8000-000000000301'
    database.createTask({
      id: taskId,
      title: '统计令牌',
      instructions: '记录模型调用',
      workMode: 'ask'
    })

    database.upsertModelUsageCall({
      requestId: taskId,
      callId: 'call-1',
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet',
      input: 100,
      output: 20,
      cacheRead: 30,
      cacheWrite: 10
    })
    database.upsertModelUsageCall({
      requestId: taskId,
      callId: 'call-1',
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet',
      input: 125,
      output: 25,
      cacheRead: 40,
      cacheWrite: 12
    })

    expect(database.getTokenUsageSummary()).toEqual({
      totals: {
        callCount: 1,
        input: 125,
        output: 25,
        cacheRead: 40,
        cacheWrite: 12,
        totalTokens: 150
      },
      records: [
        expect.objectContaining({
          requestId: taskId,
          callCount: 1,
          input: 125,
          output: 25,
          cacheRead: 40,
          cacheWrite: 12,
          totalTokens: 150
        })
      ]
    })
    expect(() =>
      database.upsertModelUsageCall({
        requestId: taskId,
        callId: 'negative',
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet',
        input: -1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0
      })
    ).toThrow('input must be a nonnegative safe integer')
    expect(() =>
      database.upsertModelUsageCall({
        requestId: taskId,
        callId: 'fractional',
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet',
        input: 0,
        output: 0.5,
        cacheRead: 0,
        cacheWrite: 0
      })
    ).toThrow('output must be a nonnegative safe integer')
    expect(() =>
      database.upsertModelUsageCall({
        requestId: taskId,
        callId: 'call-2',
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'x'.repeat(501),
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0
      })
    ).toThrow('model must contain between 1 and 500 characters')
    database.close()
  })

  it('aggregates token usage with project and conversation metadata', async () => {
    const database = await createDatabase()
    const firstProject = database.listProjects()[0]!
    const secondProject = database.createProject({
      name: '第二项目',
      description: '',
      rootPath: 'C:\\Second',
      defaultWorkMode: 'ask'
    })
    const firstConversationId =
      '00000000-0000-4000-8000-000000000311'
    const secondConversationId =
      '00000000-0000-4000-8000-000000000312'
    database.replaceConversations([
      {
        id: firstConversationId,
        projectId: firstProject.id,
        title: '第一会话',
        updatedAt: 1_775_000_000_000,
        messages: []
      },
      {
        id: secondConversationId,
        projectId: secondProject.id,
        title: '第二会话',
        updatedAt: 1_775_000_001_000,
        messages: []
      }
    ])
    const firstTaskId = '00000000-0000-4000-8000-000000000321'
    const secondTaskId = '00000000-0000-4000-8000-000000000322'
    database.createTask({
      id: firstTaskId,
      projectId: firstProject.id,
      conversationId: firstConversationId,
      title: '第一请求',
      instructions: '测试',
      workMode: 'ask'
    })
    database.createTask({
      id: secondTaskId,
      projectId: secondProject.id,
      conversationId: secondConversationId,
      title: '第二请求',
      instructions: '测试',
      workMode: 'ask'
    })
    for (const usage of [
      {
        requestId: firstTaskId,
        callId: 'call-1',
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet',
        input: 100,
        output: 40,
        cacheRead: 30,
        cacheWrite: 10
      },
      {
        requestId: firstTaskId,
        callId: 'call-2',
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet',
        input: 50,
        output: 20,
        cacheRead: 5,
        cacheWrite: 2
      },
      {
        requestId: firstTaskId,
        callId: 'call-3',
        runtime: 'continue',
        provider: 'openai',
        model: 'gpt-5',
        input: 80,
        output: 30,
        cacheRead: 0,
        cacheWrite: 0
      },
      {
        requestId: secondTaskId,
        callId: 'call-1',
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet',
        input: 25,
        output: 15,
        cacheRead: 7,
        cacheWrite: 3
      }
    ]) {
      database.upsertModelUsageCall(usage)
    }

    const summary = database.getTokenUsageSummary()
    expect(summary.totals).toEqual({
      callCount: 4,
      input: 255,
      output: 105,
      cacheRead: 42,
      cacheWrite: 15,
      totalTokens: 360
    })
    expect(summary.records).toHaveLength(3)
    expect(summary.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: firstTaskId,
          projectId: firstProject.id,
          projectName: firstProject.name,
          conversationId: firstConversationId,
          conversationTitle: '第一会话',
          runtime: 'opencode',
          provider: 'anthropic',
          model: 'claude-sonnet',
          callCount: 2,
          input: 150,
          output: 60,
          cacheRead: 35,
          cacheWrite: 12,
          totalTokens: 210
        }),
        expect.objectContaining({
          requestId: firstTaskId,
          runtime: 'continue',
          provider: 'openai',
          model: 'gpt-5',
          callCount: 1,
          totalTokens: 110
        }),
        expect.objectContaining({
          requestId: secondTaskId,
          projectId: secondProject.id,
          projectName: '第二项目',
          conversationId: secondConversationId,
          conversationTitle: '第二会话',
          callCount: 1,
          totalTokens: 40
        })
      ])
    )
    database.close()
  })

  it('clears private assistant content while preserving workspace configuration', async () => {
    const database = await createDatabase()
    const project = database.listProjects()[0]!
    database.createMemory({
      scope: 'project',
      scopeId: project.id,
      type: 'fact',
      content: '待清除记忆'
    })
    database.createSchedule({
      projectId: project.id,
      title: '待清除任务',
      prompt: '总结',
      workMode: 'ask',
      recurrence: 'daily',
      nextRunAt: '2026-08-02T00:00:00.000Z'
    })
    database.createHeartbeatConfig(
      {
        projectId: project.id,
        name: '待清除心跳',
        timezone: 'Asia/Shanghai',
        recurrence: { type: 'daily', localTime: '09:00' },
        enabled: true,
        lookbackHours: 48,
        retentionDays: 90
      },
      new Date('2026-08-01T00:00:00.000Z')
    )
    const taskId = '00000000-0000-4000-8000-000000000331'
    database.createTask({
      id: taskId,
      projectId: project.id,
      title: '待清除用量',
      instructions: '测试',
      workMode: 'ask'
    })
    database.upsertModelUsageCall({
      requestId: taskId,
      callId: 'call-1',
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet',
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1
    })
    expect(database.getTokenUsageSummary().totals.totalTokens).toBe(15)

    database.clearAssistantData()

    expect(database.listProjects()).toHaveLength(1)
    expect(database.listExperts()).toHaveLength(3)
    expect(database.listMemories(project.id)).toEqual([])
    expect(database.listSchedules(project.id)).toEqual([])
    expect(database.listHeartbeatConfigs(project.id)).toEqual([])
    expect(database.listTasks()).toEqual([])
    expect(database.listArtifacts(project.id)).toEqual([])
    expect(database.getTokenUsageSummary()).toEqual({
      totals: {
        callCount: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0
      },
      records: []
    })
    database.close()
  })
})
