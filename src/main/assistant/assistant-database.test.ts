import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantDatabase } from './assistant-database'

const temporaryDirectories: string[] = []
const channelDefaultProfileId =
  '00000000-0000-4000-8000-000000000001'

afterEach(async () => {
  vi.useRealTimers()
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
  it('rejects a newer unsupported schema without changing its version', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-assistant-future-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const initial = new AssistantDatabase(databasePath)
    initial.initialize('C:\\Workspace')
    initial.close()
    const future = new DatabaseSync(databasePath)
    future.exec('PRAGMA user_version = 99;')
    future.close()

    const downgraded = new AssistantDatabase(databasePath)
    expect(() => downgraded.initialize('C:\\Workspace')).toThrow(
      '不支持助理数据库版本 99'
    )
    const unchanged = new DatabaseSync(databasePath)
    expect(
      (
        unchanged.prepare('PRAGMA user_version').get() as {
          user_version: number
        }
      ).user_version
    ).toBe(99)
    unchanged.close()
  })

  it('lists projects by creation time with newer projects last', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-07T00:00:00.000Z'))
    const database = await createDatabase()
    const defaultProject = database.listProjects()[0]!

    vi.setSystemTime(new Date('2026-08-07T00:01:00.000Z'))
    const secondProject = database.createProject({
      name: '第二项目',
      description: '',
      rootPath: 'C:\\Second',
      defaultWorkMode: 'ask'
    })
    vi.setSystemTime(new Date('2026-08-07T00:02:00.000Z'))
    const thirdProject = database.createProject({
      name: '第三项目',
      description: '',
      rootPath: 'C:\\Third',
      defaultWorkMode: 'execute'
    })

    database.updateProject(secondProject.id, {
      name: '第二项目（已更新）',
      description: '',
      rootPath: 'C:\\Second',
      defaultWorkMode: 'ask'
    })

    expect(database.listProjects().map((project) => project.id)).toEqual([
      defaultProject.id,
      secondProject.id,
      thirdProject.id
    ])
    expect(
      database.listProjects(true).map((project) => project.id)
    ).toEqual([
      defaultProject.id,
      secondProject.id,
      thirdProject.id
    ])
    database.close()
  })

  it('migrates existing databases to schema version 17', async () => {
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
      ALTER TABLE projects DROP COLUMN runtime_selection_json;
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
    ).toBe(17)
    expect(
      current
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'model_usage_calls'`
        )
        .get()
    ).toEqual({ name: 'model_usage_calls' })
    expect(
      current
        .prepare('PRAGMA table_info(projects)')
        .all()
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'runtime_selection_json' })
      ])
    )
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
    expect(
      (
        current.prepare('PRAGMA table_info(tasks)').all() as Array<{
          name: string
        }>
      ).some((column) => column.name === 'visible')
    ).toBe(true)
    expect(
      (
        current
          .prepare('PRAGMA table_info(magic_note_entries)')
          .all() as Array<{ name: string }>
      ).some((column) => column.name === 'image_bytes')
    ).toBe(true)
    expect(
      current
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'magic_todos'`
        )
        .get()
    ).toEqual({ name: 'magic_todos' })
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
    ).toBe(17)
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

  it('backfills checklist todos when migrating existing magic notes', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-magic-todo-migration-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const initial = new AssistantDatabase(databasePath)
    initial.initialize('C:\\Workspace')
    const note = initial.createMagicNote({
      title: '迁移笔记'
    })
    initial.createMagicNoteEntry({
      noteId: note.id,
      content: {
        version: 1,
        ops: [
          { insert: '迁移待办' },
          { insert: '\n', attributes: { list: 'unchecked' } }
        ]
      },
      plainText: '迁移待办'
    })
    initial.close()

    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      DELETE FROM magic_todos;
      PRAGMA user_version = 9;
    `)
    legacy.close()

    const migrated = new AssistantDatabase(databasePath)
    migrated.initialize('C:\\Workspace')
    expect(migrated.listMagicTodos()).toEqual([
      expect.objectContaining({
        noteId: note.id,
        source: 'note',
        title: '迁移待办',
        completed: false
      })
    ])
    migrated.close()
  })

  it('makes existing notes global and migrates manual todos into one note', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-global-magic-notes-migration-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const initial = new AssistantDatabase(databasePath)
    initial.initialize('C:\\Workspace')
    const project = initial.listProjects()[0]!
    const note = initial.createMagicNote({ title: '原项目笔记' })
    initial.close()

    const legacy = new DatabaseSync(databasePath)
    const now = '2026-08-10T00:00:00.000Z'
    legacy
      .prepare('UPDATE magic_notes SET project_id = ? WHERE id = ?')
      .run(project.id, note.id)
    legacy
      .prepare(
        `INSERT INTO magic_todos
          (id, project_id, note_id, entry_id, source_index, source,
           title, instructions, completed, comments_json, analyzed_at,
           revision, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, NULL, 'manual', ?, ?, 1, '[]',
                 NULL, 0, ?, ?)`
      )
      .run(
        '00000000-0000-4000-8000-000000000099',
        project.id,
        '旧手动待办',
        '保留的说明',
        now,
        now
      )
    legacy.exec('PRAGMA user_version = 16')
    legacy.close()

    const migrated = new AssistantDatabase(databasePath)
    migrated.initialize('C:\\Workspace')
    expect(migrated.listMagicNotes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: note.id, title: '原项目笔记' }),
        expect.objectContaining({ title: '迁入的待办' })
      ])
    )
    expect(migrated.listMagicTodos()).toEqual([
      expect.objectContaining({
        source: 'note',
        title: '旧手动待办',
        instructions: '保留的说明',
        completed: true,
        noteTitle: '迁入的待办'
      })
    ])
    migrated.close()
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
      defaultWorkMode: 'execute',
      runtimeSelection: {
        provider: 'continue'
      }
    })
    expect(updated).toMatchObject({
      name: '产品发布 2',
      defaultWorkMode: 'execute',
      runtimeSelection: {
        provider: 'continue'
      }
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

  it('idempotently creates protected channel projects by channel identity', async () => {
    const database = await createDatabase()
    const sameName = database.createProject({
      name: '微信 ClawBot',
      description: '普通同名项目',
      rootPath: 'C:\\Ordinary',
      defaultWorkMode: 'execute'
    })

    const first = database.ensureChannelProjects(
      'C:\\Users\\test',
      channelDefaultProfileId
    )
    const second = database.ensureChannelProjects(
      'C:\\Ignored',
      channelDefaultProfileId
    )

    expect(first).toEqual([
      expect.objectContaining({
        name: '微信 ClawBot',
        rootPath: 'C:\\Users\\test',
        defaultWorkMode: 'ask',
        runtimeSelection: {
          provider: 'model',
          profileId: channelDefaultProfileId
        },
        kind: 'channel',
        channel: 'weixin'
      }),
      expect.objectContaining({
        kind: 'channel',
        channel: 'wecom'
      }),
      expect.objectContaining({
        kind: 'channel',
        channel: 'dingtalk'
      })
    ])
    expect(second.map((project) => project.id)).toEqual(
      first.map((project) => project.id)
    )
    expect(database.getProject(sameName.id)).toMatchObject({
      kind: 'user',
      channel: undefined,
      rootPath: 'C:\\Ordinary'
    })

    const weixin = first[0]!
    const updated = database.updateProject(weixin.id, {
      name: '不可重命名',
      description: '更新后的通道说明',
      rootPath: 'C:\\Remote',
      defaultWorkMode: 'execute',
      runtimeSelection: {
        provider: 'opencode',
        profileId: '00000000-0000-4000-8000-000000000019'
      }
    })
    expect(updated).toMatchObject({
      name: '微信 ClawBot',
      description: '更新后的通道说明',
      rootPath: 'C:\\Remote',
      defaultWorkMode: 'execute',
      runtimeSelection: {
        provider: 'opencode',
        profileId: '00000000-0000-4000-8000-000000000019'
      }
    })
    expect(() =>
      database.updateProject(weixin.id, {
        name: weixin.name,
        description: weixin.description,
        rootPath: '  ',
        defaultWorkMode: 'execute'
      })
    ).toThrow('通道项目必须设置默认工作目录')
    expect(() =>
      database.setProjectArchived(weixin.id, true)
    ).toThrow('系统通道项目不能归档')
    expect(() =>
      database.deleteProject(weixin.id, weixin.name)
    ).toThrow('系统通道项目不能删除')
    database.close()
  })

  it('persists one protected remote conversation per channel identity', async () => {
    const database = await createDatabase()
    const project = database.ensureChannelProjects(
      'C:\\Users\\test',
      channelDefaultProfileId
    )[0]!
    const first = database.getOrCreateRemoteConversation({
      projectId: project.id,
      channel: 'weixin',
      accountId: 'default',
      externalConversationId: 'remote-user-1',
      conversationType: 'direct',
      title: '微信 ClawBot · ****0001',
      accountDisplay: '发送者 ****0001',
      runtimeSelection: { provider: 'continue' }
    })
    const second = database.getOrCreateRemoteConversation({
      projectId: project.id,
      channel: 'weixin',
      accountId: 'default',
      externalConversationId: 'remote-user-1',
      conversationType: 'direct',
      title: '微信 ClawBot · ****0001',
      accountDisplay: '发送者 ****0001',
      runtimeSelection: { provider: 'continue' }
    })
    expect(second.id).toBe(first.id)

    database.appendRemoteConversationMessage({
      conversationId: first.id,
      role: 'user',
      content: '请分析状态',
      attachments: [
        {
          id: '00000000-0000-4000-8000-000000000090',
          name: '状态.txt',
          size: 12,
          preview: '状态',
          kind: 'text'
        }
      ],
      status: '微信 ClawBot · 对话'
    })
    database.appendRemoteConversationMessage({
      conversationId: first.id,
      role: 'assistant',
      content: '状态正常',
      artifactIds: [
        '00000000-0000-4000-8000-000000000091'
      ],
      status: '微信 ClawBot · 已完成'
    })
    expect(database.getConversation(first.id)).toMatchObject({
      projectId: project.id,
      runtimeSelection: { provider: 'continue' },
      remote: {
        channel: 'weixin',
        accountDisplay: '发送者 ****0001',
        conversationType: 'direct'
      },
      messages: [
        {
          role: 'user',
          content: '请分析状态',
          attachments: [
            expect.objectContaining({ name: '状态.txt' })
          ],
          status: '微信 ClawBot · 对话'
        },
        {
          role: 'assistant',
          content: '状态正常',
          artifactIds: [
            '00000000-0000-4000-8000-000000000091'
          ],
          status: '微信 ClawBot · 已完成'
        }
      ]
    })

    database.replaceConversations([])
    expect(database.getConversation(first.id).remote?.channel).toBe(
      'weixin'
    )
    database.close()
  })

  it('persists remote event deduplication and failed reply outbox state', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-channel-state-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const database = new AssistantDatabase(databasePath)
    database.initialize('C:\\Workspace')
    expect(database.claimChannelEvent('weixin', 'event-1')).toBe(true)
    expect(database.claimChannelEvent('weixin', 'event-1')).toBe(false)
    expect(database.claimChannelEvent('dingtalk', 'event-1')).toBe(true)

    const entry = database.enqueueChannelResult({
      channel: 'weixin',
      eventId: 'event-1',
      conversationId: 'conversation-1',
      recipientId: 'sender-1',
      status: 'completed',
      output: '已完成'
    })
    database.markChannelResult(entry.id, 'failed')
    expect(database.listUndeliveredChannelResults()).toEqual([
      {
        ...entry,
        state: 'failed',
        attempts: 1
      }
    ])
    database.markChannelResult(entry.id, 'delivered')
    expect(database.listUndeliveredChannelResults()).toEqual([])
    database.close()

    const reopened = new AssistantDatabase(databasePath)
    reopened.initialize('C:\\Workspace')
    expect(reopened.claimChannelEvent('weixin', 'event-1')).toBe(
      false
    )
    reopened.close()
  })

  it('safely deletes a confirmed project and its scoped data', async () => {
    const database = await createDatabase()
    const project = database.createProject({
      name: '待删除项目',
      description: '删除测试',
      rootPath: 'C:\\Delete',
      defaultWorkMode: 'execute'
    })
    const conversationId = '00000000-0000-4000-8000-000000000111'
    const taskId = '00000000-0000-4000-8000-000000000211'
    database.replaceConversations([
      {
        id: conversationId,
        projectId: project.id,
        title: '项目对话',
        updatedAt: Date.now(),
        messages: []
      }
    ])
    database.createTask({
      id: taskId,
      projectId: project.id,
      conversationId,
      title: '项目任务',
      instructions: '执行任务',
      workMode: 'execute'
    })
    database.createTextArtifact({
      projectId: project.id,
      taskId,
      title: '项目成果',
      content: '内容'
    })
    database.createMemory({
      scope: 'project',
      scopeId: project.id,
      type: 'fact',
      content: '项目记忆'
    })
    database.createSchedule({
      projectId: project.id,
      title: '项目计划',
      prompt: '执行计划',
      workMode: 'ask',
      recurrence: 'daily',
      nextRunAt: '2026-08-08T00:00:00.000Z'
    })

    expect(() =>
      database.deleteProject(project.id, project.name)
    ).toThrow('项目仍有进行中的任务')
    database.updateTaskStatus(taskId, 'completed')
    expect(() =>
      database.deleteProject(project.id, '错误名称')
    ).toThrow('项目名称确认不匹配')

    database.deleteProject(project.id, project.name)

    expect(
      database.listProjects(true).some((item) => item.id === project.id)
    ).toBe(false)
    expect(
      database.listConversations().some(
        (conversation) => conversation.projectId === project.id
      )
    ).toBe(false)
    expect(
      database.listTasks().some((task) => task.projectId === project.id)
    ).toBe(false)
    expect(database.listArtifacts(project.id)).toEqual([])
    expect(database.listSchedules(project.id)).toEqual([])
    expect(
      database
        .listMemories(project.id)
        .some((memory) => memory.scopeId === project.id)
    ).toBe(false)
    expect(database.listProjects()).toHaveLength(1)
    database.close()
  })

  it('does not delete the final active project', async () => {
    const database = await createDatabase()
    const project = database.listProjects()[0]!

    expect(() =>
      database.deleteProject(project.id, project.name)
    ).toThrow('至少需要保留一个可用项目')
    expect(database.listProjects()).toHaveLength(1)
    database.close()
  })

  it('creates, updates, and soft-deletes expert roles', async () => {
    const database = await createDatabase()
    const expert = database.createExpert({
      name: '代码审查专家',
      description: '检查代码正确性',
      systemInstructions: 'Review code for actionable bugs.',
      routingKeywords: [' ＣＯＤＥ ', 'code', '代码审查']
    })
    expect(expert.routingKeywords).toEqual(['code', '代码审查'])

    const updated = database.updateExpert(expert.id, {
      name: '高级代码审查专家',
      description: '检查正确性和安全性',
      systemInstructions: 'Review correctness and security risks.',
      routingKeywords: ['security', '安全审查']
    })
    expect(updated).toMatchObject({
      id: expert.id,
      name: '高级代码审查专家',
      description: '检查正确性和安全性',
      systemInstructions: 'Review correctness and security risks.',
      routingKeywords: ['security', '安全审查'],
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

  it('roundtrips expert model profiles and tolerates malformed model policies', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-expert-model-policy-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const firstModelProfileId =
      '00000000-0000-4000-8000-000000000401'
    const secondModelProfileId =
      '00000000-0000-4000-8000-000000000402'
    const database = new AssistantDatabase(databasePath)
    database.initialize('C:\\Workspace')

    const expert = database.createExpert({
      name: '模型绑定专家',
      description: '验证模型策略持久化',
      systemInstructions: 'Use the assigned model connection.',
      modelProfileId: firstModelProfileId,
      routingKeywords: ['模型绑定']
    })
    expect(expert.modelProfileId).toBe(firstModelProfileId)
    expect(
      database.listExperts().find((item) => item.id === expert.id)
    ).toMatchObject({
      modelProfileId: firstModelProfileId,
      routingKeywords: ['模型绑定']
    })

    const updated = database.updateExpert(expert.id, {
      name: expert.name,
      description: expert.description,
      systemInstructions: expert.systemInstructions,
      modelProfileId: secondModelProfileId,
      routingKeywords: expert.routingKeywords
    })
    expect(updated.modelProfileId).toBe(secondModelProfileId)
    database.close()

    const persisted = new DatabaseSync(databasePath)
    expect(
      JSON.parse(
        (
          persisted
            .prepare(
              'SELECT model_policy_json FROM experts WHERE id = ?'
            )
            .get(expert.id) as { model_policy_json: string }
        ).model_policy_json
      )
    ).toEqual({ modelProfileId: secondModelProfileId })
    expect(
      (
        persisted.prepare('PRAGMA table_info(experts)').all() as Array<{
          name: string
        }>
      ).some((column) => column.name === 'model_profile_id')
    ).toBe(false)
    persisted
      .prepare(
        'UPDATE experts SET model_policy_json = ? WHERE id = ?'
      )
      .run('{malformed-json', expert.id)
    persisted.close()

    const reopened = new AssistantDatabase(databasePath)
    reopened.initialize('C:\\Workspace')
    const recoveredExpert = reopened
      .listExperts()
      .find((item) => item.id === expert.id)
    reopened.close()
    expect(recoveredExpert).toMatchObject({
      id: expert.id,
      routingKeywords: ['模型绑定']
    })
    expect(recoveredExpert?.modelProfileId).toBeUndefined()
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
    const expert = database.listExperts()[0]!
    const childTaskId = '00000000-0000-4000-8000-000000000202'
    database.createTask({
      id: childTaskId,
      projectId: project.id,
      conversationId: 'conversation-1',
      parentTaskId: taskId,
      expertId: expert.id,
      routingMode: 'smart',
      title: '研究子任务',
      instructions: '只读分析',
      workMode: 'ask',
      origin: 'subagent',
      status: 'queued'
    })
    expect(database.listTasks()[0]).toMatchObject({
      id: childTaskId,
      parentTaskId: taskId,
      expertId: expert.id,
      routingMode: 'smart',
      status: 'queued'
    })

    database.updateTaskStatus(taskId, 'waiting_approval')
    expect(
      database.listTasks().find((task) => task.id === taskId)
    ).toMatchObject({
      status: 'waiting_approval'
    })
    database.updateTaskStatus(taskId, 'completed')
    expect(
      database.listTasks().find((task) => task.id === taskId)
    ).toMatchObject({
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
        runtimeSelection: {
          provider: 'model',
          profileId: '00000000-0000-4000-8000-000000000299'
        },
        title: '发布讨论',
        updatedAt: 1_775_000_000_000,
        messages: [
          {
            id: '00000000-0000-4000-8000-000000000212',
            role: 'user',
            content: '整理发布说明',
            createdAt: 1_775_000_000_000,
            state: 'complete',
            attachments: [
              {
                id: '00000000-0000-4000-8000-000000000220',
                name: '发布清单.md',
                size: 2_048,
                preview: '发布前检查项',
                kind: 'text'
              },
              {
                id: '00000000-0000-4000-8000-000000000221',
                name: '发布页面.png',
                size: 4_096,
                preview: '1280 × 720',
                kind: 'image',
                thumbnailUrl:
                  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
              }
            ]
          },
          {
            id: '00000000-0000-4000-8000-000000000213',
            role: 'assistant',
            content: '处理中',
            reasoning: '先分析发布范围',
            blocks: [
              {
                id: '00000000-0000-4000-8000-000000000217',
                type: 'reasoning',
                content: '先分析发布范围'
              },
              {
                id: '00000000-0000-4000-8000-000000000218',
                type: 'tool',
                tool: {
                  callId: 'call-1',
                  name: 'read',
                  state: 'running',
                  summary: 'OpenCode 工具：read'
                }
              },
              {
                id: '00000000-0000-4000-8000-000000000219',
                type: 'text',
                content: '处理中'
              }
            ],
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
        runtimeSelection: {
          provider: 'model',
          profileId: '00000000-0000-4000-8000-000000000299'
        },
        messages: [
          expect.objectContaining({
            role: 'user',
            state: 'complete',
            attachments: [
              expect.objectContaining({
                name: '发布清单.md',
                kind: 'text'
              }),
              expect.objectContaining({
                name: '发布页面.png',
                kind: 'image',
                thumbnailUrl: expect.stringContaining(
                  'data:image/png;base64,'
                )
              })
            ]
          }),
          expect.objectContaining({
            role: 'assistant',
            state: 'error',
            status: expect.stringContaining('意外中断'),
            reasoning: '先分析发布范围',
            blocks: [
              expect.objectContaining({
                type: 'reasoning',
                content: '先分析发布范围'
              }),
              expect.objectContaining({
                type: 'tool',
                tool: expect.objectContaining({
                  callId: 'call-1',
                  state: 'interrupted'
                })
              }),
              expect.objectContaining({
                type: 'text',
                content: '处理中'
              })
            ],
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

  it('rebinds persisted conversations whose model profile was removed', async () => {
    const database = await createDatabase()
    const removedProfileId =
      '00000000-0000-4000-8000-000000000291'
    const defaultProfileId =
      '00000000-0000-4000-8000-000000000292'
    const runtimeProfileId =
      '00000000-0000-4000-8000-000000000293'
    const imageProfileId =
      '00000000-0000-4000-8000-000000000294'
    database.replaceConversations(
      ([
        ['model', removedProfileId],
        ['opencode', removedProfileId],
        ['continue', removedProfileId],
        ['model', runtimeProfileId]
      ] as const).map(([provider, profileId], index) => ({
        id: `00000000-0000-4000-8000-00000000030${index}`,
        runtimeSelection: { provider, profileId },
        title: `对话 ${index}`,
        updatedAt: index + 1,
        messages: []
      }))
    )
    const channelProject = database.ensureChannelProjects(
      'C:\\Users\\test',
      defaultProfileId
    )[0]!
    database.updateProject(channelProject.id, {
      name: channelProject.name,
      description: channelProject.description,
      rootPath: channelProject.rootPath,
      defaultWorkMode: channelProject.defaultWorkMode,
      runtimeSelection: {
        provider: 'opencode',
        profileId: runtimeProfileId
      }
    })
    const imageChannelProject = database.ensureChannelProjects(
      'C:\\Users\\test',
      defaultProfileId
    )[1]!
    database.updateProject(imageChannelProject.id, {
      name: imageChannelProject.name,
      description: imageChannelProject.description,
      rootPath: imageChannelProject.rootPath,
      defaultWorkMode: imageChannelProject.defaultWorkMode,
      runtimeSelection: {
        provider: 'model',
        profileId: imageProfileId
      }
    })
    const automaticChannelProject = database.ensureChannelProjects(
      'C:\\Users\\test',
      defaultProfileId
    )[2]!
    database.updateProject(automaticChannelProject.id, {
      name: automaticChannelProject.name,
      description: automaticChannelProject.description,
      rootPath: automaticChannelProject.rootPath,
      defaultWorkMode: automaticChannelProject.defaultWorkMode,
      runtimeSelection: { provider: 'auto' }
    })
    const automaticRemoteConversation =
      database.getOrCreateRemoteConversation({
        projectId: automaticChannelProject.id,
        channel: 'dingtalk',
        accountId: 'default',
        externalConversationId: 'legacy-auto-conversation',
        conversationType: 'direct',
        title: '钉钉 · 旧版自动后端',
        accountDisplay: '发送者 ****0001',
        runtimeSelection: { provider: 'auto' }
      })

    expect(
      database.repairConversationRuntimeSelections({
        modelProfiles: [
          { id: defaultProfileId },
          { id: runtimeProfileId },
          {
            id: imageProfileId,
            protocol: 'openai-images-generations'
          }
        ],
        defaultModelProfileId: defaultProfileId,
        opencodeModelSource: {
          kind: 'profile',
          profileId: runtimeProfileId
        },
        continueModelSource: { kind: 'platform' }
      })
    ).toBe(7)
    expect(
      database
        .listConversations()
        .filter((conversation) => !conversation.remote)
        .sort((left, right) => left.title.localeCompare(right.title))
        .map((conversation) => conversation.runtimeSelection)
    ).toEqual([
      { provider: 'model', profileId: defaultProfileId },
      { provider: 'opencode', profileId: runtimeProfileId },
      { provider: 'continue' },
      { provider: 'model', profileId: runtimeProfileId }
    ])
    expect(database.getProject(channelProject.id).runtimeSelection).toEqual({
      provider: 'opencode'
    })
    expect(
      database.getProject(imageChannelProject.id).runtimeSelection
    ).toEqual({
      provider: 'model',
      profileId: defaultProfileId
    })
    expect(
      database.getProject(automaticChannelProject.id).runtimeSelection
    ).toEqual({
      provider: 'model',
      profileId: defaultProfileId
    })
    expect(
      database.getConversation(
        automaticRemoteConversation.id
      ).runtimeSelection
    ).toEqual({
      provider: 'model',
      profileId: defaultProfileId
    })
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
                summary: '取消前仍在运行',
                error: 'runtime parser detail'
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
          state: 'interrupted',
          error: 'runtime parser detail'
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

  it('persists global magic notes and AI comments without todo proposals', async () => {
    const database = await createDatabase()
    const globalNote = database.createMagicNote({
      title: '全局笔记'
    })
    const secondNote = database.createMagicNote({
      title: '第二篇笔记'
    })

    expect(database.listMagicNotes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: globalNote.id, title: '全局笔记' }),
        expect.objectContaining({ id: secondNote.id, title: '第二篇笔记' })
      ])
    )

    const withEntry = database.createMagicNoteEntry({
      noteId: secondNote.id,
      content: {
        version: 1,
        ops: [
          { insert: '整理发布清单', attributes: { bold: true } },
          { insert: '\n' }
        ]
      },
      plainText: '整理发布清单'
    })
    const entry = withEntry.entries[0]!
    expect(withEntry).toMatchObject({
      entryCount: 1,
      preview: '整理发布清单'
    })
    expect(database.searchMagicNotes('发布', 5)).toEqual([
      expect.objectContaining({
        noteId: secondNote.id,
        noteTitle: '第二篇笔记',
        entryId: entry.id,
        content: '整理发布清单'
      })
    ])

    const analyzed = database.saveMagicNoteAnalysis({
      entryId: entry.id,
      expectedRevision: entry.revision,
      comments: [
        {
          id: '00000000-0000-4000-8000-000000000401',
          kind: 'suggestion',
          content: '可以拆成可检查的发布步骤。'
        }
      ]
    })
    expect(analyzed.entries[0]!.comments).toEqual([
      expect.objectContaining({
        kind: 'suggestion',
        content: '可以拆成可检查的发布步骤。'
      })
    ])
    const reanalyzed = database.saveMagicNoteAnalysis({
      entryId: entry.id,
      expectedRevision: analyzed.entries[0]!.revision,
      comments: [
        {
          id: '00000000-0000-4000-8000-000000000402',
          kind: 'narrative',
          content: '可以继续补充目标读者和发布场景。',
          direction: 'expand',
          format: 'narrative'
        }
      ]
    })
    expect(reanalyzed.entries[0]!.comments).toEqual([
      expect.objectContaining({
        content: '可以拆成可检查的发布步骤。'
      }),
      expect.objectContaining({
        content: '可以继续补充目标读者和发布场景。',
        direction: 'expand',
        format: 'narrative',
        analyzedAt: expect.any(String)
      })
    ])
    expect(database.listTasks()).toEqual([])
    database.close()
  })

  it('synchronizes derived todos when note checklists change', async () => {
    const database = await createDatabase()
    const note = database.createMagicNote({
      title: '发布笔记'
    })
    const withEntry = database.createMagicNoteEntry({
      noteId: note.id,
      content: {
        version: 1,
        ops: [
          { insert: '核对发布材料' },
          { insert: '\n', attributes: { list: 'unchecked' } },
          { insert: '上传构建产物' },
          { insert: '\n', attributes: { list: 'checked' } }
        ]
      },
      plainText: '核对发布材料\n上传构建产物'
    })
    const entry = withEntry.entries[0]!

    const noteTodos = database.listMagicTodos()
    expect(noteTodos).toEqual([
      expect.objectContaining({
        noteId: note.id,
        entryId: entry.id,
        source: 'note',
        title: '核对发布材料',
        completed: false
      }),
      expect.objectContaining({
        source: 'note',
        title: '上传构建产物',
        completed: true
      })
    ])

    const updatedEntry = database.getMagicNote(note.id).entries[0]!
    database.updateMagicNoteEntry({
      entryId: entry.id,
      expectedRevision: updatedEntry.revision,
      content: {
        version: 1,
        ops: [
          { insert: '新增首项' },
          { insert: '\n', attributes: { list: 'unchecked' } },
          { insert: '上传构建产物' },
          { insert: '\n', attributes: { list: 'unchecked' } },
          { insert: '核对发布材料' },
          { insert: '\n', attributes: { list: 'checked' } }
        ]
      },
      plainText: '新增首项\n上传构建产物\n核对发布材料'
    })
    const reordered = database.listMagicTodos()
    expect(
      reordered.find((todo) => todo.title === '核对发布材料')
    ).toMatchObject({
      id: noteTodos[0]!.id,
      completed: true,
      sourceIndex: 2
    })
    expect(
      reordered.find((todo) => todo.title === '上传构建产物')
    ).toMatchObject({
      id: noteTodos[1]!.id,
      completed: false,
      sourceIndex: 1
    })

    database.close()
  })

  it('updates a derived todo and its source checklist together', async () => {
    const database = await createDatabase()
    const note = database.createMagicNote({ title: '发布笔记' })
    database.createMagicNoteEntry({
      noteId: note.id,
      content: {
        version: 1,
        ops: [
          { insert: '核对发布材料' },
          { insert: '\n', attributes: { list: 'unchecked' } }
        ]
      },
      plainText: '核对发布材料'
    })
    const todo = database.listMagicTodos()[0]!

    const updated = database.updateMagicTodo({
      todoId: todo.id,
      completed: true,
      expectedRevision: todo.revision
    })

    expect(updated).toMatchObject({
      id: todo.id,
      completed: true,
      revision: todo.revision + 1
    })
    expect(
      database.getMagicNote(note.id).entries[0]!.content.ops
    ).toEqual([
      { insert: '核对发布材料' },
      { insert: '\n', attributes: { list: 'checked' } }
    ])
    expect(() =>
      database.updateMagicTodo({
        todoId: todo.id,
        completed: false,
        expectedRevision: todo.revision
      })
    ).toThrow('待办已被更新，请刷新后重试')

    database.close()
  })

  it('protects magic note records from stale revisions', async () => {
    const database = await createDatabase()
    const note = database.createMagicNote({ title: '并发笔记' })
    const withEntry = database.createMagicNoteEntry({
      noteId: note.id,
      content: { version: 1, ops: [{ insert: '初始内容\n' }] },
      plainText: '初始内容'
    })
    const entry = withEntry.entries[0]!

    database.updateMagicNoteEntry({
      entryId: entry.id,
      expectedRevision: entry.revision,
      content: { version: 1, ops: [{ insert: '新内容\n' }] },
      plainText: '新内容'
    })
    expect(() =>
      database.updateMagicNoteEntry({
        entryId: entry.id,
        expectedRevision: entry.revision,
        content: { version: 1, ops: [{ insert: '过期内容\n' }] },
        plainText: '过期内容'
      })
    ).toThrow('记录已被更新')
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
    database.createMagicNote({
      title: '待清除笔记'
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
    expect(database.listMagicNotes()).toEqual([])
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
