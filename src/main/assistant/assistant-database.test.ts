import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  builtInDefaultProjectSeedDescription,
  builtInDefaultProjectSeedName,
  conversationSnapshotSchema,
  isUntouchedBuiltInDefaultProject
} from '../../shared/assistant-contracts'
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

async function createDatabase(
  options: {
    onMagicTodosChanged?: () => void
  } = {}
): Promise<AssistantDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-assistant-'))
  temporaryDirectories.push(directory)
  const database = new AssistantDatabase(
    join(directory, 'assistant.sqlite'),
    options
  )
  database.initialize('C:\\Workspace')
  return database
}

const validatedSshHostId =
  '00000000-0000-4000-8000-000000000321'

function validatedSshProjectWrite(
  overrides: {
    rootPath?: string
    hostId?: string
    assertCurrent?: Parameters<
      AssistantDatabase['createSshProject']
    >[0]['assertCurrent']
  } = {}
): Parameters<
  AssistantDatabase['createSshProject']
>[0] {
  const rootPath = overrides.rootPath ?? '/srv/goodbuddy'
  const hostId = overrides.hostId ?? validatedSshHostId
  return {
    project: {
      name: '远程项目',
      description: '原子持久化',
      rootPath,
      defaultWorkMode: 'execute',
      runtimeSelection: { provider: 'opencode' }
    },
    executionSpace: {
      kind: 'ssh',
      hostId,
      remoteRootPath: rootPath
    },
    assertCurrent: overrides.assertCurrent ?? (() => {})
  }
}

function claimQueuedSchedules(
  database: AssistantDatabase,
  now: Date,
  limit = 4
): Array<{
  schedule: ReturnType<AssistantDatabase['listSchedules']>[number]
  runId: string
}> {
  database.queueDueSchedules(now, limit)
  const claims: Array<{
    schedule: ReturnType<AssistantDatabase['listSchedules']>[number]
    runId: string
  }> = []
  const seenConversations = new Set<string>()
  for (const item of database.listConversationQueueItems()) {
    if (
      item.source !== 'schedule' ||
      seenConversations.has(item.conversationId) ||
      claims.length >= limit
    ) {
      continue
    }
    const claimed = database.claimConversationQueueItem(
      item.conversationId,
      item.id
    )
    if (claimed?.source === 'schedule') {
      claims.push({
        schedule: claimed.schedule,
        runId: claimed.runId
      })
      seenConversations.add(item.conversationId)
    }
  }
  return claims
}

function claimManualScheduleQueueItem(
  database: AssistantDatabase,
  scheduleId: string
): {
  schedule: ReturnType<AssistantDatabase['listSchedules']>[number]
  runId: string
} {
  const item = database.queueScheduleNow(scheduleId)
  const claimed = database.claimConversationQueueItem(
    item.conversationId,
    item.id
  )
  if (claimed?.source !== 'schedule') {
    throw new Error('Expected a claimed schedule queue item')
  }
  return {
    schedule: claimed.schedule,
    runId: claimed.runId
  }
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

  it('migrates existing databases to schema version 32', async () => {
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
    ).toBe(32)
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
        expect.objectContaining({ name: 'runtime_selection_json' }),
        expect.objectContaining({
          name: 'built_in_default',
          notnull: 1,
          dflt_value: '0'
        })
      ])
    )
    expect(
      current
        .prepare('PRAGMA table_info(conversations)')
        .all()
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'branch_source_conversation_id'
        }),
        expect.objectContaining({ name: 'branch_source_title' })
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
    expect(
      current
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table'
             AND name = 'conversation_queue_items'`
        )
        .get()
    ).toEqual({ name: 'conversation_queue_items' })
    expect(
      current
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index'
             AND name = 'conversations_branch_source_idx'`
        )
        .get()
    ).toEqual({ name: 'conversations_branch_source_idx' })
    current.close()
  })

  it('backfills every v26 project as a local execution space without changing project data', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-execution-space-migration-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const initial = new AssistantDatabase(databasePath)
    initial.initialize('')
    const blankRootProject = initial.listProjects()[0]!
    const project = initial.createProject({
      name: '迁移项目',
      description: '保留全部项目字段',
      rootPath: 'D:\\Migration',
      defaultWorkMode: 'execute',
      runtimeSelection: { provider: 'continue' }
    })
    initial.close()

    const legacy = new DatabaseSync(databasePath)
    const projectRowsBefore = legacy
      .prepare('SELECT * FROM projects ORDER BY rowid')
      .all()
    legacy.exec(`
      DROP TABLE project_execution_spaces;
      PRAGMA user_version = 26;
    `)
    legacy.close()

    const migrated = new AssistantDatabase(databasePath)
    migrated.initialize('C:\\MustNotReplaceBlank')
    expect(migrated.getProject(blankRootProject.id)).toMatchObject({
      id: blankRootProject.id,
      rootPath: '',
      executionSpace: { kind: 'local', rootPath: '' }
    })
    expect(migrated.getProject(project.id)).toMatchObject({
      id: project.id,
      name: '迁移项目',
      description: '保留全部项目字段',
      rootPath: 'D:\\Migration',
      defaultWorkMode: 'execute',
      runtimeSelection: { provider: 'continue' },
      executionSpace: {
        kind: 'local',
        rootPath: 'D:\\Migration'
      }
    })
    migrated.close()

    const inspected = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true
    })
    expect(inspected.prepare('PRAGMA user_version').get()).toEqual({
      user_version: 32
    })
    expect(
      inspected.prepare('SELECT * FROM projects ORDER BY rowid').all()
    ).toEqual(projectRowsBefore)
    expect(
      inspected
        .prepare(
          `SELECT project_id, kind, root_path, ssh_host_id
           FROM project_execution_spaces
           ORDER BY project_id`
        )
        .all()
    ).toEqual([
      {
        project_id: blankRootProject.id,
        kind: 'local',
        root_path: '',
        ssh_host_id: null
      },
      {
        project_id: project.id,
        kind: 'local',
        root_path: 'D:\\Migration',
        ssh_host_id: null
      }
    ].sort((left, right) =>
      left.project_id.localeCompare(right.project_id)
    ))
    expect(
      inspected
        .prepare('PRAGMA foreign_key_list(project_execution_spaces)')
        .all()
    ).toEqual([
      expect.objectContaining({
        table: 'projects',
        from: 'project_id',
        to: 'id',
        on_delete: 'CASCADE'
      })
    ])
    expect(() =>
      inspected
        .prepare(
          `UPDATE project_execution_spaces
           SET ssh_host_id = ?
           WHERE project_id = ?`
        )
        .run(
          '00000000-0000-4000-8000-000000000310',
          blankRootProject.id
        )
    ).toThrow()
    inspected.close()
  })

  it('preserves SSH project locations when removing legacy evidence', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-v27-ssh-migration-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const initial = new AssistantDatabase(databasePath)
    initial.initialize('C:\\Workspace')
    const project = initial.createSshProject(
      validatedSshProjectWrite({ rootPath: '/srv/legacy' })
    )
    initial.close()

    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      ALTER TABLE project_execution_spaces
        ADD COLUMN workspace_identity TEXT;
      UPDATE project_execution_spaces
      SET workspace_identity = 'workspace-legacy'
      WHERE project_id = '${project.id}';
      CREATE TABLE project_runtime_validations (
        project_id TEXT PRIMARY KEY,
        runtime_bundle_digest TEXT NOT NULL
      );
      PRAGMA user_version = 30;
    `)
    legacy.close()

    const migrated = new AssistantDatabase(databasePath)
    migrated.initialize('C:\\Workspace')
    expect(migrated.getProject(project.id)).toMatchObject({
      id: project.id,
      executionSpace: {
        kind: 'ssh',
        hostId: validatedSshHostId,
        remoteRootPath: '/srv/legacy'
      }
    })
    migrated.close()

    const inspected = new DatabaseSync(databasePath)
    expect(inspected.prepare('PRAGMA user_version').get()).toEqual({
      user_version: 32
    })
    expect(
      inspected
        .prepare(
          `SELECT project_id, kind, root_path, ssh_host_id
           FROM project_execution_spaces WHERE project_id = ?`
        )
        .get(project.id)
    ).toEqual({
      project_id: project.id,
      kind: 'ssh',
      root_path: '/srv/legacy',
      ssh_host_id: validatedSshHostId
    })
    inspected.close()
  })

  it('migrates v30 projects while deleting installation evidence', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-v30-evidence-migration-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const initial = new AssistantDatabase(databasePath)
    initial.initialize('C:\\Workspace')
    const project = initial.createSshProject(
      validatedSshProjectWrite()
    )
    const taskId = '00000000-0000-4000-8000-000000000399'
    initial.createTask({
      id: taskId,
      projectId: project.id,
      title: '保留任务',
      instructions: '迁移后仍应存在',
      workMode: 'execute'
    })
    initial.close()

    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      ALTER TABLE project_execution_spaces
        ADD COLUMN agent_installation_id_at_validation TEXT;
      UPDATE project_execution_spaces
      SET agent_installation_id_at_validation = 'old-agent'
      WHERE project_id = '${project.id}';
      CREATE TABLE project_runtime_validations (
        project_id TEXT PRIMARY KEY,
        runtime_bundle_digest TEXT NOT NULL
      );
      INSERT INTO project_runtime_validations
        (project_id, runtime_bundle_digest)
      VALUES ('${project.id}', 'sha256:${'d'.repeat(64)}');
      PRAGMA user_version = 30;
    `)
    legacy.close()

    const migrated = new AssistantDatabase(databasePath)
    migrated.initialize('C:\\Workspace')
    expect(migrated.getProject(project.id)).toMatchObject({
      id: project.id,
      defaultWorkMode: 'execute',
      executionSpace: {
        kind: 'ssh',
        hostId: validatedSshHostId,
        remoteRootPath: '/srv/goodbuddy'
      }
    })
    expect(
      migrated.listTasks().find((task) => task.id === taskId)
    ).toMatchObject({
      id: taskId,
      projectId: project.id
    })

    const inspected = new DatabaseSync(databasePath)
    expect(inspected.prepare('PRAGMA user_version').get()).toEqual({
      user_version: 32
    })
    expect(
      inspected
        .prepare('PRAGMA table_info(project_execution_spaces)')
        .all()
        .map((column) => column.name)
    ).toEqual([
      'project_id',
      'kind',
      'root_path',
      'ssh_host_id'
    ])
    expect(
      inspected
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table'
             AND name = 'project_runtime_validations'`
        )
        .get()
    ).toBeUndefined()
    inspected.close()
    migrated.close()
  })

  it('fails closed when a project execution-space row is missing', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-missing-execution-space-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const database = new AssistantDatabase(databasePath)
    database.initialize('C:\\Workspace')
    const project = database.listProjects()[0]!
    const raw = new DatabaseSync(databasePath)
    raw
      .prepare(
        'DELETE FROM project_execution_spaces WHERE project_id = ?'
      )
      .run(project.id)
    raw.close()

    expect(() => database.getProject(project.id)).toThrow(
      '缺少执行空间配置'
    )
    expect(() => database.listProjects()).toThrow(
      '缺少执行空间配置'
    )
    database.close()
  })

  it('backfills one exact legacy built-in default candidate', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-default-project-migration-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const initial = new AssistantDatabase(databasePath)
    initial.initialize('C:\\Workspace')
    initial.close()

    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      DROP INDEX projects_built_in_default_unique;
      ALTER TABLE projects DROP COLUMN built_in_default;
      PRAGMA user_version = 24;
    `)
    legacy.close()

    const migrated = new AssistantDatabase(databasePath)
    migrated.initialize('C:\\Workspace')
    const [project] = migrated.listProjects()
    expect(project).toMatchObject({
      name: builtInDefaultProjectSeedName,
      description: builtInDefaultProjectSeedDescription,
      builtInDefault: true
    })
    expect(
      project && isUntouchedBuiltInDefaultProject(project)
    ).toBe(true)
    migrated.close()
  })

  it('does not backfill an ambiguous legacy default identity', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-ambiguous-default-project-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const initial = new AssistantDatabase(databasePath)
    initial.initialize('C:\\Workspace')
    const independent = initial.createProject({
      name: builtInDefaultProjectSeedName,
      description: builtInDefaultProjectSeedDescription,
      rootPath: 'D:\\Independent',
      defaultWorkMode: 'ask'
    })
    expect(independent.builtInDefault).toBe(false)
    expect(isUntouchedBuiltInDefaultProject(independent)).toBe(false)
    initial.close()

    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      DROP INDEX projects_built_in_default_unique;
      ALTER TABLE projects DROP COLUMN built_in_default;
      PRAGMA user_version = 24;
    `)
    legacy.close()

    const migrated = new AssistantDatabase(databasePath)
    migrated.initialize('C:\\Workspace')
    expect(
      migrated
        .listProjects()
        .map((project) => project.builtInDefault)
    ).toEqual([false, false])
    migrated.close()
  })

  it('does not mark a later exact clone after the original default was edited', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-edited-default-project-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const initial = new AssistantDatabase(databasePath)
    initial.initialize('C:\\Workspace')
    const original = initial.listProjects()[0]!
    initial.updateProject(original.id, {
      name: '已编辑默认项目',
      description: builtInDefaultProjectSeedDescription,
      rootPath: original.rootPath,
      defaultWorkMode: 'ask'
    })
    const clone = initial.createProject({
      name: builtInDefaultProjectSeedName,
      description: builtInDefaultProjectSeedDescription,
      rootPath: original.rootPath,
      defaultWorkMode: 'ask'
    })
    initial.close()

    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      DROP INDEX projects_built_in_default_unique;
      ALTER TABLE projects DROP COLUMN built_in_default;
      PRAGMA user_version = 24;
    `)
    legacy.close()

    const migrated = new AssistantDatabase(databasePath)
    migrated.initialize('C:\\Workspace')
    expect(
      migrated
        .listProjects()
        .filter((project) => project.builtInDefault)
    ).toEqual([])
    expect(migrated.getProject(clone.id).builtInDefault).toBe(false)
    migrated.close()
  })

  it('does not mark a later exact clone after the original default was deleted', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-deleted-default-project-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const initial = new AssistantDatabase(databasePath)
    initial.initialize('C:\\Workspace')
    const original = initial.listProjects()[0]!
    const clone = initial.createProject({
      name: builtInDefaultProjectSeedName,
      description: builtInDefaultProjectSeedDescription,
      rootPath: original.rootPath,
      defaultWorkMode: 'ask'
    })
    initial.deleteProject(original.id, original.name)
    initial.close()

    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      DROP INDEX projects_built_in_default_unique;
      ALTER TABLE projects DROP COLUMN built_in_default;
      PRAGMA user_version = 24;
    `)
    legacy.close()

    const migrated = new AssistantDatabase(databasePath)
    migrated.initialize('C:\\Workspace')
    expect(migrated.getProject(clone.id).builtInDefault).toBe(false)
    migrated.close()
  })

  it('does not backfill when no exact legacy candidate exists', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-missing-default-project-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const initial = new AssistantDatabase(databasePath)
    initial.initialize('C:\\Workspace')
    initial.close()

    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      UPDATE projects
      SET updated_at = created_at || '-edited';
      DROP INDEX projects_built_in_default_unique;
      ALTER TABLE projects DROP COLUMN built_in_default;
      PRAGMA user_version = 24;
    `)
    legacy.close()

    const migrated = new AssistantDatabase(databasePath)
    migrated.initialize('C:\\Workspace')
    expect(migrated.listProjects()[0]?.builtInDefault).toBe(false)
    migrated.close()
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
    ).toBe(32)
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

  it('backfills one stable Task and Conversation for each v21 schedule', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-stable-schedule-migration-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const initial = new AssistantDatabase(databasePath)
    initial.initialize('C:\\Workspace')
    const project = initial.listProjects()[0]!
    const legacySchedule = initial.createSchedule({
      projectId: project.id,
      title: '旧版每日报告',
      prompt: '生成每日报告',
      workMode: 'ask',
      recurrence: 'daily',
      nextRunAt: '2026-08-20T00:00:00.000Z'
    })
    initial.close()

    const legacyTaskId =
      '00000000-0000-4000-8000-000000000221'
    const legacyRunId =
      '00000000-0000-4000-8000-000000000222'
    const raw = new DatabaseSync(databasePath)
    raw.exec('BEGIN IMMEDIATE')
    raw
      .prepare('DELETE FROM tasks WHERE id = ?')
      .run(legacySchedule.taskId)
    raw
      .prepare('DELETE FROM conversations WHERE id = ?')
      .run(legacySchedule.conversationId)
    raw
      .prepare(
        `INSERT INTO tasks
          (id, project_id, conversation_id, schedule_id, parent_task_id,
           expert_id, routing_mode, title, instructions, origin, status,
           priority, work_mode, progress, created_at, started_at,
           completed_at, error, visible)
         VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 'schedule',
                 'completed', 0, 'ask', NULL, ?, ?, ?, NULL, 1)`
      )
      .run(
        legacyTaskId,
        project.id,
        `schedule:${legacySchedule.id}`,
        legacySchedule.title,
        legacySchedule.prompt,
        '2026-08-18T00:00:00.000Z',
        '2026-08-18T00:00:00.000Z',
        '2026-08-18T00:01:00.000Z'
      )
    raw
      .prepare(
        `INSERT INTO schedule_runs
          (id, schedule_id, scheduled_for, task_id, status)
         VALUES (?, ?, ?, ?, 'completed')`
      )
      .run(
        legacyRunId,
        legacySchedule.id,
        '2026-08-18T00:00:00.000Z',
        legacyTaskId
      )
    raw.exec(`
      DROP INDEX IF EXISTS idx_tasks_schedule;
      PRAGMA user_version = 21;
      COMMIT;
    `)
    raw.close()

    const migrated = new AssistantDatabase(databasePath)
    migrated.initialize('C:\\Workspace')
    const [schedule] = migrated.listSchedules(project.id)
    expect(schedule).toMatchObject({
      id: legacySchedule.id,
      title: legacySchedule.title,
      taskId: expect.any(String),
      conversationId: expect.any(String)
    })
    expect(schedule!.taskId).not.toBe(legacyTaskId)
    expect(
      migrated.getConversation(schedule!.conversationId)
    ).toMatchObject({
      projectId: project.id,
      title: legacySchedule.title,
      messages: []
    })
    expect(migrated.listTasks()).toEqual([
      expect.objectContaining({
        id: schedule!.taskId,
        conversationId: schedule!.conversationId,
        scheduleId: schedule!.id,
        status: 'idle'
      })
    ])
    migrated.close()

    const inspected = new DatabaseSync(databasePath)
    expect(
      inspected.prepare('PRAGMA user_version').get()
    ).toEqual({ user_version: 32 })
    expect(
      inspected
        .prepare(
          `SELECT parent_task_id, visible
           FROM tasks
           WHERE id = ?`
        )
        .get(legacyTaskId)
    ).toEqual({
      parent_task_id: schedule!.taskId,
      visible: 0
    })
    expect(
      inspected
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'index' AND name = 'idx_tasks_schedule'`
        )
        .get()
    ).toEqual({ name: 'idx_tasks_schedule' })
    inspected.close()
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
      status: 'active'
    })
    expect(defaultProject?.runtimeSelection).toBeUndefined()
    expect(defaultProject?.createdAt).toBe(defaultProject?.updatedAt)
    expect(
      defaultProject &&
        isUntouchedBuiltInDefaultProject(defaultProject)
    ).toBe(true)
    const reconfiguredDefault = database.updateProject(
      defaultProject!.id,
      {
        name: builtInDefaultProjectSeedName,
        description: builtInDefaultProjectSeedDescription,
        rootPath: 'D:\\Moved',
        defaultWorkMode: 'execute',
        runtimeSelection: { provider: 'continue' }
      }
    )
    expect(reconfiguredDefault.builtInDefault).toBe(true)
    expect(
      isUntouchedBuiltInDefaultProject(reconfiguredDefault)
    ).toBe(true)
    expect(database.listExperts()).toHaveLength(3)

    const project = database.createProject({
      name: '产品发布',
      description: '发布资料和任务',
      rootPath: 'C:\\Release',
      defaultWorkMode: 'ask'
    })
    expect(project.builtInDefault).toBe(false)
    expect(project.executionSpace).toEqual({
      kind: 'local',
      rootPath: 'C:\\Release'
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
      executionSpace: {
        kind: 'local',
        rootPath: 'C:\\Release'
      },
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

  it('atomically creates and updates projects with local execution spaces', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-project-execution-rollback-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const database = new AssistantDatabase(databasePath)
    database.initialize('C:\\Workspace')
    const project = database.createProject({
      name: '原始项目',
      description: '原始说明',
      rootPath: '',
      defaultWorkMode: 'ask'
    })
    expect(project).toMatchObject({
      rootPath: '',
      executionSpace: { kind: 'local', rootPath: '' }
    })

    const raw = new DatabaseSync(databasePath)
    raw.exec(`
      CREATE TRIGGER reject_blocked_execution_space_insert
      BEFORE INSERT ON project_execution_spaces
      WHEN NEW.root_path = 'blocked-insert'
      BEGIN
        SELECT RAISE(ABORT, 'forced execution-space insert failure');
      END;
      CREATE TRIGGER reject_blocked_execution_space_update
      BEFORE UPDATE ON project_execution_spaces
      WHEN NEW.root_path = 'blocked-update'
      BEGIN
        SELECT RAISE(ABORT, 'forced execution-space update failure');
      END;
    `)
    raw.close()

    expect(() =>
      database.createProject({
        name: '不能半创建',
        description: '',
        rootPath: 'blocked-insert',
        defaultWorkMode: 'ask'
      })
    ).toThrow('forced execution-space insert failure')
    expect(
      database
        .listProjects(true)
        .some((candidate) => candidate.name === '不能半创建')
    ).toBe(false)

    expect(() =>
      database.updateProject(project.id, {
        name: '不能半更新',
        description: '不能保留',
        rootPath: 'blocked-update',
        defaultWorkMode: 'execute'
      })
    ).toThrow('forced execution-space update failure')
    expect(database.getProject(project.id)).toMatchObject({
      name: '原始项目',
      description: '原始说明',
      rootPath: '',
      defaultWorkMode: 'ask',
      executionSpace: { kind: 'local', rootPath: '' }
    })
    database.close()
  })

  it('maps SSH execution spaces and lists projects referencing a host', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-ssh-project-reference-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const database = new AssistantDatabase(databasePath)
    database.initialize('C:\\Workspace')
    const project = database.createProject({
      name: '远程项目',
      description: '',
      rootPath: 'C:\\LegacyProjection',
      defaultWorkMode: 'ask',
      runtimeSelection: { provider: 'opencode' }
    })
    const hostId = '00000000-0000-4000-8000-000000000311'
    const raw = new DatabaseSync(databasePath)
    raw
      .prepare(
        `UPDATE project_execution_spaces
         SET kind = 'ssh', root_path = ?, ssh_host_id = ?
         WHERE project_id = ?`
      )
      .run(
        '/srv/goodbuddy',
        hostId,
        project.id
      )
    raw.close()

    expect(database.getProject(project.id)).toEqual({
      ...project,
      rootPath: '/srv/goodbuddy',
      id: project.id,
      executionSpace: {
        kind: 'ssh',
        hostId,
        remoteRootPath: '/srv/goodbuddy'
      }
    })
    database.setProjectArchived(project.id, true)
    const taskId = '00000000-0000-4000-8000-000000000313'
    database.createTask({
      id: taskId,
      projectId: project.id,
      title: '无法连接的远程任务',
      instructions: '本地清理不应等待远端任务停止',
      workMode: 'execute'
    })
    expect(database.listProjectsReferencingSshHost(hostId)).toEqual([
      { id: project.id, name: project.name }
    ])
    expect(database.listSshHostProjectReferences()).toEqual([
      { hostId, id: project.id, name: project.name }
    ])
    expect(
      database.listProjectsReferencingSshHost(
        '00000000-0000-4000-8000-000000000312'
      )
    ).toEqual([])
    expect(
      database.deleteProjectsReferencingSshHost(hostId)
    ).toEqual([{ id: project.id, name: project.name }])
    expect(
      database.listProjects(true).some(
        (candidate) => candidate.id === project.id
      )
    ).toBe(false)
    expect(
      database.listTasks().some((task) => task.id === taskId)
    ).toBe(false)
    expect(database.listProjects()).toHaveLength(1)
    database.close()
  })

  it('keeps the final active project when deleting its Host', async () => {
    const database = await createDatabase()
    const localProject = database.listProjects()[0]!
    const remoteProject = database.createSshProject(
      validatedSshProjectWrite()
    )
    database.setProjectArchived(localProject.id, true)

    expect(() =>
      database.deleteProjectsReferencingSshHost(
        validatedSshHostId
      )
    ).toThrow('至少需要保留一个可用项目')
    expect(database.getProject(remoteProject.id)).toMatchObject({
      id: remoteProject.id,
      status: 'active'
    })
    database.close()
  })

  it('requires a local fallback before deleting an active remote project', async () => {
    const database = await createDatabase()
    const localProject = database.listProjects()[0]!
    const remoteProject = database.createSshProject(
      validatedSshProjectWrite()
    )
    database.createSshProject(
      validatedSshProjectWrite({
        rootPath: '/srv/other-project'
      })
    )
    database.setProjectArchived(localProject.id, true)

    expect(() =>
      database.deleteProject(
        remoteProject.id,
        remoteProject.name,
        { allowActiveTasks: true }
      )
    ).toThrow('至少需要保留一个可用项目')
    expect(database.getProject(remoteProject.id).id).toBe(
      remoteProject.id
    )
    database.close()
  })

  it('fails closed when an SSH project lacks a Runtime selection', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-invalid-ssh-project-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const database = new AssistantDatabase(databasePath)
    database.initialize('C:\\Workspace')
    const project = database.listProjects()[0]!
    const raw = new DatabaseSync(databasePath)
    raw
      .prepare(
        `UPDATE project_execution_spaces
         SET kind = 'ssh', root_path = ?, ssh_host_id = ?
         WHERE project_id = ?`
      )
      .run(
        '/srv/goodbuddy',
        '00000000-0000-4000-8000-000000000313',
        project.id
      )
    raw.close()

    expect(() => database.getProject(project.id)).toThrow(
      '缺少远程 Runtime 选择'
    )
    database.close()
  })

  it('atomically creates a fully validated SSH project', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-validated-ssh-create-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const database = new AssistantDatabase(databasePath)
    database.initialize('C:\\Workspace')
    const precondition = vi.fn()
    const project = database.createSshProject(
      validatedSshProjectWrite({
        assertCurrent: precondition
      })
    )

    expect(precondition).toHaveBeenCalledWith()
    expect(project).toMatchObject({
      name: '远程项目',
      rootPath: '/srv/goodbuddy',
      runtimeSelection: { provider: 'opencode' },
      executionSpace: {
        kind: 'ssh',
        hostId: validatedSshHostId,
        remoteRootPath: '/srv/goodbuddy'
      }
    })
    expect(project).toEqual(database.getProject(project.id))
    const raw = new DatabaseSync(databasePath)
    expect(
      raw
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM projects WHERE id = ?) AS projects,
             (SELECT COUNT(*) FROM project_execution_spaces
                WHERE project_id = ?) AS execution_spaces`
        )
        .get(project.id, project.id)
    ).toEqual({
      projects: 1,
      execution_spaces: 1
    })
    raw.close()
    database.close()
  })

  it('rejects mismatched SSH candidates before persisting rows', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-invalid-ssh-candidate-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const database = new AssistantDatabase(databasePath)
    database.initialize('C:\\Workspace')
    const baseline = database.listProjects().length

    const rootMismatch = validatedSshProjectWrite()
    rootMismatch.executionSpace.remoteRootPath = '/srv/other'
    expect(() =>
      database.createSshProject(rootMismatch)
    ).toThrow('目录不匹配')

    const missingRuntime = validatedSshProjectWrite()
    delete missingRuntime.project.runtimeSelection
    expect(() =>
      database.createSshProject(missingRuntime)
    ).toThrow('必须选择 Runtime')

    expect(() =>
      database.createSshProject(
        validatedSshProjectWrite({
          assertCurrent: () => {
            throw new Error('SSH Host 已变化')
          }
        })
      )
    ).toThrow('SSH Host 已变化')

    expect(database.listProjects()).toHaveLength(baseline)
    database.close()
  })

  it('optimistically updates validated SSH projects without moving them', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T01:00:00.000Z'))
    const database = await createDatabase()
    const created = database.createSshProject(
      validatedSshProjectWrite()
    )
    const write = validatedSshProjectWrite()
    write.project.name = '已重新验证'
    write.project.description = '更新后的配置'

    const updated = database.updateSshProject(
      created.id,
      created.updatedAt,
      write
    )
    expect(updated.name).toBe('已重新验证')
    expect(updated.updatedAt).not.toBe(created.updatedAt)
    expect(updated.executionSpace).toEqual({
      kind: 'ssh',
      hostId: validatedSshHostId,
      remoteRootPath: '/srv/goodbuddy'
    })
    expect(updated).toEqual(database.getProject(created.id))

    const beforeRejectedPrecondition = database.getProject(created.id)
    const rejectedWrite = validatedSshProjectWrite({
      assertCurrent: () => {
        throw new Error('SSH Host 已变化')
      }
    })
    rejectedWrite.project.name = '不应保存'
    expect(() =>
      database.updateSshProject(
        created.id,
        updated.updatedAt,
        rejectedWrite
      )
    ).toThrow('SSH Host 已变化')
    expect(database.getProject(created.id)).toEqual(
      beforeRejectedPrecondition
    )

    expect(() =>
      database.updateSshProject(
        created.id,
        created.updatedAt,
        write
      )
    ).toThrow('项目已被其他操作更新')

    const moved = validatedSshProjectWrite({
      rootPath: '/srv/moved'
    })
    expect(() =>
      database.updateSshProject(
        created.id,
        updated.updatedAt,
        moved
      )
    ).toThrow('执行位置不能通过此更新修改')

    const otherHost = validatedSshProjectWrite({
      hostId: '00000000-0000-4000-8000-000000000322'
    })
    expect(() =>
      database.updateSshProject(
        created.id,
        updated.updatedAt,
        otherHost
      )
    ).toThrow('执行位置不能通过此更新修改')

    const localProject = database.createProject({
      name: '本地项目',
      description: '',
      rootPath: 'D:\\Local',
      defaultWorkMode: 'ask'
    })
    expect(() =>
      database.updateSshProject(
        localProject.id,
        localProject.updatedAt,
        validatedSshProjectWrite()
      )
    ).toThrow('仅支持更新已有远程项目')
    const [channelProject] = database.ensureChannelProjects(
      'C:\\Channel',
      channelDefaultProfileId
    )
    expect(() =>
      database.updateSshProject(
        channelProject!.id,
        channelProject!.updatedAt,
        validatedSshProjectWrite()
      )
    ).toThrow('系统通道项目不支持远程执行空间')
    database.close()
  })

  it('rolls back SSH writes when strict project mapping fails before commit', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-ssh-mapping-rollback-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const database = new AssistantDatabase(databasePath)
    database.initialize('C:\\Workspace')
    const raw = new DatabaseSync(databasePath)
    raw.exec(`
      CREATE TRIGGER corrupt_created_execution_space
      AFTER INSERT ON project_execution_spaces
      WHEN NEW.kind = 'ssh'
      BEGIN
        DELETE FROM project_execution_spaces
        WHERE project_id = NEW.project_id;
      END;
    `)
    raw.close()
    const projectsBefore = database.listProjects().length

    expect(() =>
      database.createSshProject(validatedSshProjectWrite())
    ).toThrow('缺少执行空间配置')
    expect(database.listProjects()).toHaveLength(projectsBefore)

    const setup = new DatabaseSync(databasePath)
    setup.exec('DROP TRIGGER corrupt_created_execution_space')
    setup.close()
    const created = database.createSshProject(
      validatedSshProjectWrite()
    )
    const persistedBeforeUpdate = database.getProject(created.id)
    const updateTrigger = new DatabaseSync(databasePath)
    updateTrigger.exec(`
      CREATE TRIGGER corrupt_updated_execution_space
      AFTER UPDATE ON project_execution_spaces
      WHEN NEW.kind = 'ssh'
      BEGIN
        DELETE FROM project_execution_spaces
        WHERE project_id = NEW.project_id;
      END;
    `)
    updateTrigger.close()
    const write = validatedSshProjectWrite()
    write.project.name = '不应提交的项目名'

    expect(() =>
      database.updateSshProject(
        created.id,
        created.updatedAt,
        write
      )
    ).toThrow('缺少执行空间配置')
    expect(database.getProject(created.id)).toEqual(
      persistedBeforeUpdate
    )

    database.close()
  })

  it('rolls back every SSH project table when a trigger rejects the write', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-ssh-atomic-rollback-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const database = new AssistantDatabase(databasePath)
    database.initialize('C:\\Workspace')
    const raw = new DatabaseSync(databasePath)
    raw.exec(`
      CREATE TRIGGER reject_ssh_execution_space
      BEFORE INSERT ON project_execution_spaces
      WHEN NEW.kind = 'ssh'
      BEGIN
        SELECT RAISE(ABORT, 'test SSH rejection');
      END;
    `)
    raw.close()
    const projectsBefore = database.listProjects().length

    expect(() =>
      database.createSshProject(validatedSshProjectWrite())
    ).toThrow('test SSH rejection')

    const inspected = new DatabaseSync(databasePath)
    expect(
      inspected.prepare('SELECT COUNT(*) AS count FROM projects').get()
    ).toEqual({ count: projectsBefore })
    expect(
      inspected
        .prepare(
          `SELECT COUNT(*) AS count
           FROM project_execution_spaces
           WHERE kind = 'ssh'`
        )
        .get()
    ).toEqual({ count: 0 })
    inspected.close()
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
        executionSpace: {
          kind: 'local',
          rootPath: 'C:\\Users\\test'
        },
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
      executionSpace: {
        kind: 'local',
        rootPath: 'C:\\Remote'
      },
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

  it('returns the latest 500 remote messages in chronological order', async () => {
    const database = await createDatabase()
    const project = database.ensureChannelProjects(
      'C:\\Users\\test',
      channelDefaultProfileId
    )[0]!
    const conversation = database.getOrCreateRemoteConversation({
      projectId: project.id,
      channel: 'weixin',
      accountId: 'default',
      externalConversationId: 'long-remote-history',
      conversationType: 'direct',
      title: '微信 ClawBot · 长对话',
      accountDisplay: '发送者 ****0002',
      runtimeSelection: { provider: 'continue' }
    })
    for (let index = 0; index < 502; index += 1) {
      database.appendRemoteConversationMessage({
        conversationId: conversation.id,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `消息 ${index}`
      })
    }

    const messages = database.getConversation(conversation.id).messages
    expect(messages).toHaveLength(500)
    expect(messages[0]?.content).toBe('消息 2')
    expect(messages.at(-1)?.content).toBe('消息 501')
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
    expect(
      database.claimChannelEvent('weixin', 'account-1', 'event-1')
    ).toBe(true)
    expect(
      database.claimChannelEvent('weixin', 'account-1', 'event-1')
    ).toBe(false)
    expect(
      database.claimChannelEvent('weixin', 'account-2', 'event-1')
    ).toBe(true)
    expect(
      database.claimChannelEvent('dingtalk', 'account-1', 'event-1')
    ).toBe(true)

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
    expect(
      reopened.claimChannelEvent('weixin', 'account-1', 'event-1')
    ).toBe(false)
    reopened.close()
  })

  it('keeps exhausted channel results terminal and observable', async () => {
    const database = await createDatabase()
    const entry = database.enqueueChannelResult({
      channel: 'weixin',
      eventId: 'terminal-event',
      conversationId: 'conversation-1',
      recipientId: 'sender-1',
      status: 'completed',
      output: '已完成',
      attachments: [
        {
          name: 'result.txt',
          mimeType: 'text/plain',
          size: 1,
          kind: 'file',
          dataBase64: 'eA=='
        }
      ]
    })
    for (let attempt = 0; attempt < 5; attempt += 1) {
      database.markChannelResult(entry.id, 'failed')
    }

    const terminal = database.listUndeliveredChannelResults()
    expect(terminal).toEqual([
      expect.objectContaining({
        id: entry.id,
        state: 'terminal',
        attempts: 5,
        message: expect.objectContaining({
          eventId: 'terminal-event',
          output: '已完成'
        })
      })
    ])
    expect(terminal[0]?.message).not.toHaveProperty('attachments')
    database.close()
  })

  it('migrates exhausted legacy outbox failures to terminal state', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-channel-terminal-migration-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const initial = new AssistantDatabase(databasePath)
    initial.initialize('C:\\Workspace')
    const entry = initial.enqueueChannelResult({
      channel: 'weixin',
      eventId: 'legacy-terminal-event',
      conversationId: 'conversation-1',
      recipientId: 'sender-1',
      status: 'completed',
      output: '已完成',
      attachments: [
        {
          name: 'legacy.txt',
          mimeType: 'text/plain',
          size: 1,
          kind: 'file',
          dataBase64: 'eA=='
        }
      ]
    })
    initial.close()

    const legacy = new DatabaseSync(databasePath)
    legacy
      .prepare(
        `UPDATE channel_outbox
         SET state = 'failed', attempts = 5
         WHERE id = ?`
      )
      .run(entry.id)
    legacy.exec('PRAGMA user_version = 23')
    legacy.close()

    const migrated = new AssistantDatabase(databasePath)
    migrated.initialize('C:\\Workspace')
    const terminal = migrated.listUndeliveredChannelResults()
    expect(terminal).toEqual([
      expect.objectContaining({
        id: entry.id,
        state: 'terminal',
        attempts: 5
      })
    ])
    expect(terminal[0]?.message).not.toHaveProperty('attachments')
    migrated.close()
  })

  it('rolls back both heartbeat failure updates atomically', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-heartbeat-rollback-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const database = new AssistantDatabase(databasePath)
    database.initialize('C:\\Workspace')
    const config = database.createHeartbeatConfig(
      {
        scope: { kind: 'global' },
        name: '事务心跳',
        timezone: 'UTC',
        recurrence: { type: 'daily', localTime: '09:00' },
        enabled: true,
        lookbackHours: 24,
        retentionDays: 30
      },
      new Date('2026-08-16T00:00:00.000Z')
    )
    const claim = database.claimHeartbeatNow(
      config.id,
      'heartbeat-rollback',
      'test-owner',
      new Date('2026-08-16T01:00:00.000Z')
    )
    const raw = new DatabaseSync(databasePath)
    raw.exec(`
      CREATE TRIGGER reject_heartbeat_config_failure
      BEFORE UPDATE OF last_status ON heartbeat_configs
      BEGIN
        SELECT RAISE(ABORT, 'forced config update failure');
      END;
    `)
    raw.close()

    expect(() =>
      database.failHeartbeatRun(
        claim,
        'runtime failed',
        new Date('2026-08-16T01:01:00.000Z')
      )
    ).toThrow('forced config update failure')
    expect(database.getHeartbeatRun(claim.run.id)).toMatchObject({
      status: 'claimed',
      attemptCount: 1,
      completedAt: undefined,
      error: undefined
    })
    expect(database.getHeartbeatConfig(config.id).lastStatus).toBe(
      'claimed'
    )
    database.close()
  })

  it('rejects heartbeat failure after its lease expires', async () => {
    const database = await createDatabase()
    const config = database.createHeartbeatConfig(
      {
        scope: { kind: 'global' },
        name: '租约过期心跳',
        timezone: 'UTC',
        recurrence: { type: 'daily', localTime: '09:00' },
        enabled: true,
        lookbackHours: 24,
        retentionDays: 30
      },
      new Date('2026-08-16T00:00:00.000Z')
    )
    const claim = database.claimHeartbeatNow(
      config.id,
      'expired-heartbeat',
      'expired-owner',
      new Date('2026-08-16T01:00:00.000Z'),
      60_000
    )

    expect(() =>
      database.failHeartbeatRun(
        claim,
        'late worker failure',
        new Date('2026-08-16T01:01:00.001Z')
      )
    ).toThrow('Heartbeat lease is no longer active')
    expect(database.getHeartbeatRun(claim.run.id)).toMatchObject({
      status: 'claimed',
      completedAt: undefined,
      error: undefined
    })
    expect(database.getHeartbeatConfig(config.id).lastStatus).toBe(
      'claimed'
    )
    database.close()
  })

  it('preserves legacy channel event claims while adding account identity', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-channel-event-migration-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const initial = new AssistantDatabase(databasePath)
    initial.initialize('C:\\Workspace')
    initial.close()

    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      DROP TABLE channel_events;
      CREATE TABLE channel_events (
        channel TEXT NOT NULL,
        event_id TEXT NOT NULL,
        claimed_at INTEGER NOT NULL,
        PRIMARY KEY(channel, event_id)
      );
      CREATE INDEX channel_events_claimed_at
        ON channel_events(claimed_at);
      INSERT INTO channel_events(channel, event_id, claimed_at)
        VALUES ('weixin', 'legacy-event', 1);
      PRAGMA user_version = 18;
    `)
    legacy.close()

    const migrated = new AssistantDatabase(databasePath)
    migrated.initialize('C:\\Workspace')
    expect(
      migrated.claimChannelEvent(
        'weixin',
        'default',
        'legacy-event'
      )
    ).toBe(false)
    expect(
      migrated.claimChannelEvent(
        'weixin',
        'new-account',
        'legacy-event'
      )
    ).toBe(true)
    migrated.close()
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
    expect(schedule).toMatchObject({
      projectId: project.id,
      workMode: 'ask',
      taskId: expect.any(String),
      conversationId: expect.any(String)
    })
    expect(
      database.listTasks().find((task) => task.id === schedule.taskId)
    ).toMatchObject({
      conversationId: schedule.conversationId,
      scheduleId: schedule.id,
      origin: 'schedule',
      status: 'idle'
    })
    expect(database.getConversation(schedule.conversationId)).toMatchObject({
      id: schedule.conversationId,
      projectId: project.id,
      title: '每日摘要',
      messages: []
    })
    const [claim] = claimQueuedSchedules(
      database,
      new Date('2026-07-31T00:01:00.000Z')
    )
    expect(claim?.schedule).toEqual(
      expect.objectContaining({ id: schedule.id })
    )
    expect(database.listSchedules(project.id)[0]).toMatchObject({
      id: schedule.id,
      nextRunAt: '2026-07-31T00:00:00.000Z',
      lastRunAt: undefined
    })
    database.completeScheduleRun(
      claim!.runId,
      'completed',
      new Date('2026-07-31T00:01:00.000Z')
    )
    expect(database.listSchedules(project.id)[0]).toMatchObject({
      id: schedule.id,
      nextRunAt: '2026-08-01T00:00:00.000Z',
      lastRunAt: '2026-07-31T00:01:00.000Z'
    })
    expect(
      database.listTasks().find((task) => task.id === schedule.taskId)
    ).toMatchObject({
      status: 'idle',
      completedAt: undefined
    })
    const manualClaim = claimManualScheduleQueueItem(
      database,
      schedule.id
    )
    expect(manualClaim.schedule).toMatchObject({
      taskId: schedule.taskId,
      conversationId: schedule.conversationId
    })
    expect(() =>
      claimManualScheduleQueueItem(database, schedule.id)
    ).toThrow(
      '已有一次运行正在进行'
    )
    database.completeScheduleRun(
      manualClaim.runId,
      'completed',
      new Date('2026-07-31T00:02:00.000Z')
    )
    database.appendConversationMessage({
      conversationId: schedule.conversationId,
      role: 'assistant',
      content: '今日任务状态正常',
      status: '定时任务',
      task: {
        id: schedule.taskId,
        title: schedule.title
      }
    })
    expect(
      database.getConversation(schedule.conversationId).messages
    ).toEqual([
      expect.objectContaining({
        content: '今日任务状态正常',
        task: {
          id: schedule.taskId,
          title: schedule.title
        }
      })
    ])
    const sharedConversationSchedule = database.createSchedule({
      projectId: project.id,
      conversationId: schedule.conversationId,
      title: '每周复盘',
      prompt: '复盘本周任务',
      workMode: 'execute',
      recurrence: 'weekly',
      nextRunAt: '2027-01-01T00:00:00.000Z'
    })
    expect(sharedConversationSchedule.conversationId).toBe(
      schedule.conversationId
    )
    expect(
      database
        .listTasks()
        .filter(
          (task) =>
            task.conversationId === schedule.conversationId &&
            task.origin === 'schedule'
        )
    ).toHaveLength(2)
    const countsBeforeFailedCreate = {
      schedules: database.listSchedules().length,
      tasks: database.listTasks().length,
      conversations: database.listConversations().length
    }
    expect(() =>
      database.createSchedule({
        projectId: project.id,
        conversationId:
          '00000000-0000-4000-8000-000000000299',
        title: '不应创建',
        prompt: '无效对话',
        workMode: 'execute',
        recurrence: 'once',
        nextRunAt: '2027-01-02T00:00:00.000Z'
      })
    ).toThrow('所选对话不存在或不可用于任务')
    expect({
      schedules: database.listSchedules().length,
      tasks: database.listTasks().length,
      conversations: database.listConversations().length
    }).toEqual(countsBeforeFailedCreate)
    const overdue = database.createSchedule({
      projectId: project.id,
      title: '过期摘要',
      prompt: '总结任务状态',
      workMode: 'ask',
      recurrence: 'daily',
      nextRunAt: '2025-07-31T00:00:00.000Z'
    })
    const [overdueClaim] = claimQueuedSchedules(
      database,
      new Date('2026-07-31T00:01:00.000Z')
    )
    database.completeScheduleRun(
      overdueClaim!.runId,
      'completed',
      new Date('2026-07-31T00:01:00.000Z')
    )
    expect(
      database
        .listSchedules(project.id)
        .find((item) => item.id === overdue.id)
    ).toMatchObject({
      nextRunAt: '2026-08-01T00:00:00.000Z'
    })
    database.removeSchedule(sharedConversationSchedule.id)
    expect(
      database
        .listSchedules(project.id)
        .some((item) => item.id === sharedConversationSchedule.id)
    ).toBe(false)
    expect(
      database
        .listTasks()
        .find((task) => task.id === sharedConversationSchedule.taskId)
    ).toMatchObject({
      conversationId: schedule.conversationId,
      scheduleId: undefined,
      status: 'completed',
      workMode: 'execute'
    })
    database.close()
  })

  it('migrates task event provenance without changing ordinary events', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-task-event-migration-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const taskId = '00000000-0000-4000-8000-000000000205'
    const initial = new AssistantDatabase(databasePath)
    initial.initialize('C:\\Workspace')
    initial.createTask({
      id: taskId,
      title: '迁移任务事件',
      instructions: '保留普通事件',
      workMode: 'ask',
      status: 'completed'
    })
    initial.appendTaskEvent(taskId, 'output', { text: '原有事件' })
    initial.close()

    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      DROP INDEX tasks_remote_recovery_idx;
      ALTER TABLE tasks DROP COLUMN current_assistant_message_id;
      ALTER TABLE tasks DROP COLUMN current_user_message_id;
      ALTER TABLE tasks DROP COLUMN remote_recoverable;
      DROP INDEX task_events_remote_provenance_unique;
      ALTER TABLE task_events DROP COLUMN remote_event_index;
      ALTER TABLE task_events DROP COLUMN remote_semantic_sequence;
      ALTER TABLE task_events DROP COLUMN remote_operation_id;
      ALTER TABLE task_events DROP COLUMN remote_binding_id;
      PRAGMA user_version = 31;
    `)
    legacy.close()

    const migrated = new AssistantDatabase(databasePath)
    migrated.initialize('C:\\Workspace')
    migrated.close()

    const inspected = new DatabaseSync(databasePath)
    expect(inspected.prepare('PRAGMA user_version').get()).toEqual({
      user_version: 32
    })
    expect(
      inspected.prepare('PRAGMA table_info(task_events)').all()
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'remote_binding_id' }),
        expect.objectContaining({ name: 'remote_operation_id' }),
        expect.objectContaining({ name: 'remote_semantic_sequence' }),
        expect.objectContaining({ name: 'remote_event_index' })
      ])
    )
    expect(
      inspected.prepare('PRAGMA table_info(tasks)').all()
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'remote_recoverable',
          notnull: 1,
          dflt_value: '0'
        }),
        expect.objectContaining({ name: 'current_user_message_id' }),
        expect.objectContaining({
          name: 'current_assistant_message_id'
        })
      ])
    )
    expect(
      inspected
        .prepare(
          `SELECT kind, payload_json, remote_binding_id,
                  remote_operation_id, remote_semantic_sequence,
                  remote_event_index
           FROM task_events
           WHERE task_id = ? AND kind = 'output'`
        )
        .get(taskId)
    ).toEqual({
      kind: 'output',
      payload_json: '{"text":"原有事件"}',
      remote_binding_id: null,
      remote_operation_id: null,
      remote_semantic_sequence: null,
      remote_event_index: null
    })
    expect(
      inspected
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index'
             AND name = 'task_events_remote_provenance_unique'`
        )
        .get()
    ).toEqual({ name: 'task_events_remote_provenance_unique' })
    inspected.close()
  })

  it('persists remote task events idempotently across reopen', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-remote-task-event-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const taskId = '00000000-0000-4000-8000-000000000206'
    const event = {
      taskId,
      bindingId: 'binding-remote-events',
      operationId: 'operation-remote-events',
      semanticSequence: '1',
      eventIndex: 0,
      kind: 'output',
      payload: { text: '只保存一次' }
    }
    const initial = new AssistantDatabase(databasePath)
    initial.initialize('C:\\Workspace')
    initial.createTask({
      id: taskId,
      title: '远程事件任务',
      instructions: '验证幂等落库',
      workMode: 'execute',
      status: 'completed'
    })

    expect(initial.appendRemoteTaskEventOnce(event)).toBe(true)
    expect(initial.appendRemoteTaskEventOnce(event)).toBe(false)
    expect(
      initial.getHighestCommittedRemoteTaskEventSequence(
        event.bindingId,
        event.operationId
      )
    ).toBe('1')
    expect(() =>
      initial.appendRemoteTaskEventOnce({
        ...event,
        payload: { text: '冲突内容' }
      })
    ).toThrow('provenance conflicts')
    initial.close()

    const reopened = new AssistantDatabase(databasePath)
    reopened.initialize('C:\\Workspace')
    expect(reopened.appendRemoteTaskEventOnce(event)).toBe(false)
    expect(
      reopened.getHighestCommittedRemoteTaskEventSequence(
        event.bindingId,
        event.operationId
      )
    ).toBe('1')
    reopened.appendTaskEvent(taskId, 'ordinary', { local: true })
    reopened.close()

    const inspected = new DatabaseSync(databasePath)
    expect(
      inspected
        .prepare(
          `SELECT COUNT(*) AS count
           FROM task_events
           WHERE remote_binding_id = ? AND remote_operation_id = ?`
        )
        .get(event.bindingId, event.operationId)
    ).toEqual({ count: 1 })
    expect(
      inspected
        .prepare(
          `SELECT remote_binding_id, remote_operation_id,
                  remote_semantic_sequence, remote_event_index
           FROM task_events
           WHERE task_id = ? AND kind = 'ordinary'`
        )
        .get(taskId)
    ).toEqual({
      remote_binding_id: null,
      remote_operation_id: null,
      remote_semantic_sequence: null,
      remote_event_index: null
    })
    inspected.close()

    const cleaned = new AssistantDatabase(databasePath)
    cleaned.initialize('C:\\Workspace')
    cleaned.clearAssistantData()
    expect(
      cleaned.getHighestCommittedRemoteTaskEventSequence(
        event.bindingId,
        event.operationId
      )
    ).toBe('0')
    cleaned.close()
  })

  it('atomically commits ordered remote task event batches', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-remote-task-event-batch-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const taskId = '00000000-0000-4000-8000-000000000207'
    const database = new AssistantDatabase(databasePath)
    database.initialize('C:\\Workspace')
    database.createTask({
      id: taskId,
      title: '远程事件批次',
      instructions: '验证批次事务',
      workMode: 'execute',
      status: 'completed'
    })
    const provenance = {
      taskId,
      bindingId: 'binding-event-batch',
      operationId: 'operation-event-batch'
    }
    const batch = [
      {
        ...provenance,
        semanticSequence: '1',
        eventIndex: 0,
        kind: 'reasoning',
        payload: { text: '分析' }
      },
      {
        ...provenance,
        semanticSequence: '1',
        eventIndex: 1,
        kind: 'output',
        payload: { text: '第一段' }
      },
      {
        ...provenance,
        semanticSequence: '2',
        eventIndex: 0,
        kind: 'output',
        payload: { text: '第二段' }
      }
    ]

    expect(database.appendRemoteTaskEventsBatch(batch)).toBe('2')
    expect(database.appendRemoteTaskEventsBatch(batch)).toBe('2')
    expect(
      database.getHighestCommittedRemoteTaskEventSequence(
        provenance.bindingId,
        provenance.operationId
      )
    ).toBe('2')
    database.appendRemoteTaskEventOnce({
      ...provenance,
      semanticSequence: '4',
      eventIndex: 0,
      kind: 'output',
      payload: { text: '已保存的第四段' }
    })
    expect(() =>
      database.appendRemoteTaskEventsBatch([
        {
          ...provenance,
          semanticSequence: '3',
          eventIndex: 0,
          kind: 'output',
          payload: { text: '必须回滚的第三段' }
        },
        {
          ...provenance,
          semanticSequence: '4',
          eventIndex: 0,
          kind: 'output',
          payload: { text: '冲突的第四段' }
        }
      ])
    ).toThrow('provenance conflicts')
    expect(() =>
      database.appendRemoteTaskEventOnce({
        ...provenance,
        semanticSequence: '01',
        eventIndex: 0,
        kind: 'output',
        payload: {}
      })
    ).toThrow()
    database.close()

    const inspected = new DatabaseSync(databasePath)
    expect(
      inspected
        .prepare(
          `SELECT remote_semantic_sequence, remote_event_index
           FROM task_events
           WHERE remote_binding_id = ?
             AND remote_operation_id = ?
           ORDER BY CAST(remote_semantic_sequence AS INTEGER),
                    remote_event_index`
        )
        .all(provenance.bindingId, provenance.operationId)
    ).toEqual([
      { remote_semantic_sequence: '1', remote_event_index: 0 },
      { remote_semantic_sequence: '1', remote_event_index: 1 },
      { remote_semantic_sequence: '2', remote_event_index: 0 },
      { remote_semantic_sequence: '4', remote_event_index: 0 }
    ])
    inspected.close()
  })

  it('creates and recovers a remote-authoritative conversation task', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-remote-conversation-recovery-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const database = new AssistantDatabase(databasePath)
    database.initialize('C:\\Workspace')
    const project = database.createSshProject(
      validatedSshProjectWrite()
    )
    const conversationId =
      '00000000-0000-4000-8000-000000000701'
    const taskId = '00000000-0000-4000-8000-000000000702'
    const userMessageId =
      '00000000-0000-4000-8000-000000000703'
    const assistantMessageId =
      '00000000-0000-4000-8000-000000000704'
    database.saveLocalConversations([
      {
        header: {
          id: conversationId,
          projectId: project.id,
          runtimeSelection: { provider: 'opencode' },
          title: '远程恢复对话',
          updatedAt: Date.now()
        },
        messages: []
      }
    ])

    database.createTask({
      id: taskId,
      projectId: project.id,
      conversationId,
      title: '远程恢复',
      instructions: '恢复这次回答',
      workMode: 'execute',
      remoteRecovery: {
        recoverable: true,
        currentUserMessageId: userMessageId,
        currentAssistantMessageId: assistantMessageId
      }
    })

    expect(database.getConversation(conversationId).messages).toEqual([
      expect.objectContaining({
        id: userMessageId,
        role: 'user',
        content: '恢复这次回答',
        state: 'complete'
      }),
      expect.objectContaining({
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        blocks: [],
        state: 'streaming'
      })
    ])
    expect(database.listRecoverableRemoteTasks()).toEqual([
      {
        taskId,
        projectId: project.id,
        conversationId,
        currentUserMessageId: userMessageId,
        currentAssistantMessageId: assistantMessageId,
        instructions: '恢复这次回答',
        workMode: 'execute',
        status: 'running'
      }
    ])
    const provenance = {
      taskId,
      bindingId: 'binding-conversation-recovery',
      operationId: 'operation-conversation-recovery',
      conversationId,
      assistantMessageId
    }
    const append = (
      semanticSequence: string,
      eventIndex: number,
      event: Parameters<
        AssistantDatabase['appendRemoteConversationTaskEventOnce']
      >[0]['event']
    ): boolean =>
      database.appendRemoteConversationTaskEventOnce({
        ...provenance,
        semanticSequence,
        eventIndex,
        event
      })
    const textEvent = {
      requestId: taskId,
      type: 'text' as const,
      delta: '已恢复'
    }
    expect(append('1', 0, textEvent)).toBe(true)
    expect(append('1', 0, textEvent)).toBe(false)
    expect(
      database.getConversation(conversationId).messages[1]?.content
    ).toBe('已恢复')
    expect(() =>
      append('1', 0, {
        requestId: taskId,
        type: 'text',
        delta: '冲突'
      })
    ).toThrow('provenance conflicts')
    expect(
      database.getConversation(conversationId).messages[1]?.content
    ).toBe('已恢复')

    append('2', 0, {
      requestId: taskId,
      type: 'reasoning',
      delta: '先验证状态'
    })
    append('3', 0, {
      requestId: taskId,
      type: 'tool',
      callId: 'call-1',
      name: 'read',
      state: 'running',
      summary: '读取状态'
    })
    append('4', 0, {
      requestId: taskId,
      type: 'subagent',
      childTaskId: '00000000-0000-4000-8000-000000000705',
      expertId: '00000000-0000-4000-8000-000000000706',
      expertName: '恢复专家',
      routingMode: 'native',
      runtimeCallId: 'call-1',
      state: 'completed',
      output: '已检查'
    })
    append('5', 0, {
      requestId: taskId,
      type: 'artifact',
      artifactId: '00000000-0000-4000-8000-000000000707',
      kind: 'image',
      title: '恢复图片'
    })
    append('6', 0, {
      requestId: taskId,
      type: 'knowledge-retrieval',
      mode: 'always',
      state: 'succeeded',
      libraryCount: 1,
      resultCount: 1,
      usedChannels: ['fts'],
      warnings: []
    })
    append('7', 0, {
      requestId: taskId,
      type: 'source-references',
      references: [
        {
          libraryId: '00000000-0000-4000-8000-000000000708',
          libraryName: '恢复知识',
          documentId: '00000000-0000-4000-8000-000000000709',
          documentName: '恢复说明.md',
          sourceName: '恢复目录',
          snippet: '可以继续恢复。',
          rank: 1,
          retrievalChannels: ['fts']
        }
      ]
    })
    append('8', 0, {
      requestId: taskId,
      type: 'done'
    })
    append('8', 1, {
      requestId: taskId,
      type: 'remote-semantic-checkpoint'
    })
    const recoveredMessage =
      database.getConversation(conversationId).messages[1]
    expect(
      database.listTasks().find((task) => task.id === taskId)?.status
    ).toBe('completed')
    expect(database.listRecoverableRemoteTasks()).toEqual([])
    expect(recoveredMessage).toMatchObject({
      content: '已恢复',
      reasoning: '先验证状态',
      state: 'complete',
      artifactIds: [
        '00000000-0000-4000-8000-000000000707'
      ],
      knowledgeRetrieval: {
        state: 'succeeded',
        resultCount: 1
      },
      sourceReferences: [
        expect.objectContaining({ documentName: '恢复说明.md' })
      ],
      subagents: [
        expect.objectContaining({
          childTaskId: '00000000-0000-4000-8000-000000000705',
          state: 'completed'
        })
      ],
      blocks: [
        expect.objectContaining({
          type: 'text',
          content: '已恢复'
        }),
        expect.objectContaining({
          type: 'reasoning',
          content: '先验证状态'
        }),
        expect.objectContaining({
          type: 'subagent',
          childTaskId: '00000000-0000-4000-8000-000000000705'
        })
      ]
    })

    database.saveLocalConversations([
      {
        header: {
          id: conversationId,
          projectId: project.id,
          runtimeSelection: { provider: 'opencode' },
          title: '远程恢复对话',
          updatedAt: Date.now() + 1
        },
        messages: [
          {
            id: userMessageId,
            role: 'user',
            content: '恢复这次回答',
            createdAt: Date.now(),
            state: 'complete',
            attachments: [
              {
                id: '00000000-0000-4000-8000-000000000710',
                name: '补充.txt',
                size: 2,
                preview: '补充',
                kind: 'text'
              }
            ]
          },
          {
            id: assistantMessageId,
            role: 'assistant',
            content: '过期的渲染进程内容',
            createdAt: Date.now(),
            state: 'streaming'
          }
        ]
      }
    ])
    expect(database.getConversation(conversationId).messages).toEqual([
      expect.objectContaining({
        id: userMessageId,
        attachments: [
          expect.objectContaining({ name: '补充.txt' })
        ]
      }),
      expect.objectContaining({
        id: assistantMessageId,
        content: '已恢复',
        state: 'complete'
      })
    ])
    database.updateTaskStatus(taskId, 'running')
    database.close()

    const reopened = new AssistantDatabase(databasePath)
    reopened.initialize('C:\\Workspace')
    expect(reopened.listRecoverableRemoteTasks()).toEqual([
      expect.objectContaining({ taskId, status: 'running' })
    ])
    expect(
      reopened.getConversation(conversationId).messages[1]
    ).toMatchObject({
      id: assistantMessageId,
      content: '已恢复',
      state: 'complete'
    })
    reopened.failRecoverableRemoteTask(
      taskId,
      '远端请求已不存在'
    )
    expect(
      reopened.listTasks().find((task) => task.id === taskId)
    ).toMatchObject({
      status: 'failed',
      error: '远端请求已不存在'
    })
    expect(
      reopened.getConversation(conversationId).messages[1]
    ).toMatchObject({
      id: assistantMessageId,
      content: '已恢复',
      state: 'error',
      status: '远端请求已不存在'
    })
    expect(reopened.listRecoverableRemoteTasks()).toEqual([])
    reopened.close()
  })

  it('returns every recoverable remote task beyond one hundred', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-many-remote-recoveries-')
    )
    temporaryDirectories.push(directory)
    const database = new AssistantDatabase(
      join(directory, 'assistant.sqlite')
    )
    database.initialize('C:\\Workspace')
    const project = database.createSshProject(
      validatedSshProjectWrite()
    )
    const conversationId =
      '00000000-0000-4000-8000-000000000801'
    database.saveLocalConversations([
      {
        header: {
          id: conversationId,
          projectId: project.id,
          runtimeSelection: { provider: 'opencode' },
          title: '批量远程恢复',
          updatedAt: Date.now()
        },
        messages: []
      }
    ])
    const id = (value: number): string =>
      `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
    for (let index = 1; index <= 101; index += 1) {
      database.createTask({
        id: id(index),
        projectId: project.id,
        conversationId,
        title: `远程恢复 ${index}`,
        instructions: `恢复回答 ${index}`,
        workMode: 'execute',
        remoteRecovery: {
          recoverable: true,
          currentUserMessageId: id(index + 200),
          currentAssistantMessageId: id(index + 400)
        }
      })
    }

    const tasks = database.listRecoverableRemoteTasks()
    expect(tasks).toHaveLength(101)
    expect(tasks[0]?.taskId).toBe(id(1))
    expect(tasks.at(-1)?.taskId).toBe(id(101))
    database.close()
  })

  it('rolls back a recovered event when its message update fails', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-remote-event-atomic-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const database = new AssistantDatabase(databasePath)
    database.initialize('C:\\Workspace')
    const project = database.createSshProject(
      validatedSshProjectWrite()
    )
    const conversationId =
      '00000000-0000-4000-8000-000000000711'
    const taskId = '00000000-0000-4000-8000-000000000712'
    const assistantMessageId =
      '00000000-0000-4000-8000-000000000714'
    database.saveLocalConversations([
      {
        header: {
          id: conversationId,
          projectId: project.id,
          runtimeSelection: { provider: 'opencode' },
          title: '原子恢复',
          updatedAt: Date.now()
        },
        messages: []
      }
    ])
    database.createTask({
      id: taskId,
      projectId: project.id,
      conversationId,
      title: '原子恢复',
      instructions: '不能半写入',
      workMode: 'execute',
      remoteRecovery: {
        recoverable: true,
        currentUserMessageId:
          '00000000-0000-4000-8000-000000000713',
        currentAssistantMessageId: assistantMessageId
      }
    })
    const raw = new DatabaseSync(databasePath)
    raw.exec(`
      CREATE TRIGGER reject_recovered_message_update
      BEFORE UPDATE ON messages
      WHEN NEW.id = '${assistantMessageId}'
      BEGIN
        SELECT RAISE(ABORT, 'forced recovered message failure');
      END;
    `)
    raw.close()
    expect(() =>
      database.appendRemoteConversationTaskEventOnce({
        taskId,
        bindingId: 'binding-atomic-recovery',
        operationId: 'operation-atomic-recovery',
        semanticSequence: '1',
        eventIndex: 0,
        conversationId,
        assistantMessageId,
        event: {
          requestId: taskId,
          type: 'error',
          status: 'failed',
          message: '远程失败'
        }
      })
    ).toThrow('forced recovered message failure')
    database.close()

    const inspected = new DatabaseSync(databasePath)
    expect(
      inspected
        .prepare(
          `SELECT COUNT(*) AS count FROM task_events
           WHERE remote_binding_id = 'binding-atomic-recovery'`
        )
        .get()
    ).toEqual({ count: 0 })
    expect(
      inspected
        .prepare(
          'SELECT content, state FROM messages WHERE id = ?'
        )
        .get(assistantMessageId)
    ).toEqual({ content: '', state: 'streaming' })
    inspected.exec('DROP TRIGGER reject_recovered_message_update')
    inspected.close()

    const recovered = new AssistantDatabase(databasePath)
    recovered.initialize('C:\\Workspace')
    expect(
      recovered.getConversation(conversationId).messages[1]
    ).toMatchObject({
      id: assistantMessageId,
      content: '',
      state: 'streaming'
    })
    expect(
      recovered.appendRemoteConversationTaskEventOnce({
        taskId,
        bindingId: 'binding-atomic-recovery',
        operationId: 'operation-atomic-recovery',
        semanticSequence: '1',
        eventIndex: 0,
        conversationId,
        assistantMessageId,
        event: {
          requestId: taskId,
          type: 'error',
          status: 'failed',
          message: '远程失败'
        }
      })
    ).toBe(true)
    expect(
      recovered.appendRemoteConversationTaskEventOnce({
        taskId,
        bindingId: 'binding-atomic-recovery',
        operationId: 'operation-atomic-recovery',
        semanticSequence: '1',
        eventIndex: 1,
        conversationId,
        assistantMessageId,
        event: {
          requestId: taskId,
          type: 'remote-semantic-checkpoint'
        }
      })
    ).toBe(true)
    expect(
      recovered.getConversation(conversationId).messages[1]
    ).toMatchObject({
      content: '远程失败',
      state: 'error',
      status: '远程失败'
    })
    expect(
      recovered.listTasks().find((task) => task.id === taskId)
    ).toMatchObject({
      status: 'failed',
      error: '远程失败'
    })
    recovered.close()
  })

  it('persists and arbitrates a FIFO conversation input queue', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-conversation-queue-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const initial = new AssistantDatabase(databasePath)
    initial.initialize('C:\\Workspace')
    const project = initial.listProjects()[0]!
    const conversationId =
      '00000000-0000-4000-8000-000000000901'
    initial.replaceConversations([
      {
        id: conversationId,
        projectId: project.id,
        title: '排队对话',
        updatedAt: Date.now(),
        messages: []
      }
    ])

    const first = initial.enqueueConversationUserInput({
      conversationId,
      label: '第一条消息',
      payloadJson: JSON.stringify({ prompt: '第一条消息' })
    })
    const second = initial.enqueueConversationUserInput({
      conversationId,
      label: '第二条消息',
      payloadJson: JSON.stringify({ prompt: '第二条消息' })
    })
    expect(
      initial
        .listConversationQueueItems(conversationId)
        .map((item) => item.id)
    ).toEqual([first.id, second.id])

    const preferred = initial.claimConversationQueueItem(
      conversationId,
      second.id
    )
    expect(preferred).toMatchObject({
      source: 'user',
      item: { id: second.id, source: 'user' },
      payloadJson: JSON.stringify({ prompt: '第二条消息' })
    })
    expect(initial.listConversationQueueItems(conversationId)).toEqual([
      expect.objectContaining({ id: first.id })
    ])
    initial.completeConversationUserQueueItem(second.id)

    const firstClaim =
      initial.claimConversationQueueItem(conversationId)
    expect(firstClaim).toMatchObject({
      source: 'user',
      item: { id: first.id }
    })
    initial.close()

    const recovered = new AssistantDatabase(databasePath)
    recovered.initialize('C:\\Workspace')
    expect(
      recovered.listConversationQueueItems(conversationId)
    ).toEqual([
      expect.objectContaining({
        id: first.id,
        source: 'user',
        label: '第一条消息'
      })
    ])
    recovered.cancelConversationQueueItem(first.id)
    expect(
      recovered.listConversationQueueItems(conversationId)
    ).toEqual([])
    recovered.close()
  })

  it('does not replay a dispatched user queue item whose message was already persisted', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-conversation-queue-recovery-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const initial = new AssistantDatabase(databasePath)
    initial.initialize('C:\\Workspace')
    const project = initial.listProjects()[0]!
    const conversationId =
      '00000000-0000-4000-8000-000000000911'
    const userMessageId =
      '00000000-0000-4000-8000-000000000912'
    const assistantMessageId =
      '00000000-0000-4000-8000-000000000913'
    initial.replaceConversations([
      {
        id: conversationId,
        projectId: project.id,
        title: '崩溃恢复对话',
        updatedAt: 1,
        messages: []
      }
    ])
    const queued = initial.enqueueConversationUserInput({
      conversationId,
      label: '只发送一次',
      payloadJson: JSON.stringify({ prompt: '只发送一次' })
    })
    expect(
      initial.claimConversationQueueItem(conversationId, queued.id)
    ).toMatchObject({
      source: 'user',
      item: { id: queued.id }
    })
    initial.saveLocalConversations([
      {
        header: {
          id: conversationId,
          projectId: project.id,
          title: '崩溃恢复对话',
          updatedAt: 2
        },
        messages: [
          {
            id: userMessageId,
            queueItemId: queued.id,
            role: 'user',
            content: '只发送一次',
            createdAt: 2,
            state: 'complete'
          },
          {
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            createdAt: 3,
            state: 'streaming'
          }
        ]
      }
    ])
    initial.close()

    const recovered = new AssistantDatabase(databasePath)
    recovered.initialize('C:\\Workspace')
    expect(
      recovered.listConversationQueueItems(conversationId)
    ).toEqual([])
    expect(recovered.getConversation(conversationId).messages).toEqual([
      expect.objectContaining({
        id: userMessageId,
        queueItemId: queued.id,
        role: 'user',
        content: '只发送一次'
      }),
      expect.objectContaining({
        id: assistantMessageId,
        role: 'assistant',
        state: 'error',
        status: '上次运行意外中断，可以重新发送问题'
      })
    ])
    recovered.close()
  })

  it('materializes due and manual schedule runs in the conversation queue', async () => {
    const database = await createDatabase()
    const schedule = database.createSchedule({
      title: '排队提醒',
      prompt: '检查排队结果',
      workMode: 'execute',
      recurrence: 'daily',
      nextRunAt: '2026-08-20T09:00:00.000Z'
    })

    const [dueItem] = database.queueDueSchedules(
      new Date('2026-08-20T09:01:00.000Z')
    )
    expect(dueItem).toMatchObject({
      conversationId: schedule.conversationId,
      source: 'schedule',
      scheduleId: schedule.id,
      taskId: schedule.taskId
    })
    expect(database.listConversationQueueItems()).toEqual([
      expect.objectContaining({ id: dueItem!.id })
    ])
    expect(
      database.listPendingScheduleQueueConversationIds()
    ).toEqual([schedule.conversationId])
    expect(database.listPendingConversationQueueIds()).toEqual([
      schedule.conversationId
    ])

    const claimed = database.claimConversationQueueItem(
      schedule.conversationId
    )
    expect(claimed).toMatchObject({
      source: 'schedule',
      item: { id: dueItem!.id },
      schedule: { id: schedule.id },
      runId: dueItem!.id
    })
    database.completeScheduleRun(
      dueItem!.id,
      'completed',
      new Date('2026-08-20T09:02:00.000Z')
    )

    const manualItem = database.queueScheduleNow(schedule.id)
    expect(manualItem).toMatchObject({
      source: 'schedule',
      scheduleId: schedule.id
    })
    database.cancelConversationQueueItem(manualItem.id)
    expect(database.listConversationQueueItems()).toEqual([])
    database.close()
  })

  it('recovers a claimed schedule without swallowing its occurrence', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-schedule-recovery-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const initial = new AssistantDatabase(databasePath)
    initial.initialize('C:\\Workspace')
    const schedule = initial.createSchedule({
      title: '一次提醒',
      prompt: '提醒我检查结果',
      workMode: 'ask',
      recurrence: 'once',
      nextRunAt: '2026-08-13T00:00:00.000Z'
    })
    const [claimed] = claimQueuedSchedules(
      initial,
      new Date('2026-08-13T00:01:00.000Z')
    )
    expect(claimed?.schedule.id).toBe(schedule.id)
    initial.close()

    const recovered = new AssistantDatabase(databasePath)
    recovered.initialize('C:\\Workspace')
    const [reclaimed] = claimQueuedSchedules(
      recovered,
      new Date('2026-08-13T00:02:00.000Z')
    )
    expect(reclaimed).toMatchObject({
      runId: claimed!.runId,
      schedule: {
        id: schedule.id,
        enabled: true,
        nextRunAt: '2026-08-13T00:00:00.000Z'
      }
    })
    recovered.completeScheduleRun(
      reclaimed!.runId,
      'completed',
      new Date('2026-08-13T00:02:00.000Z')
    )
    expect(recovered.listSchedules()[0]).toMatchObject({
      id: schedule.id,
      enabled: false,
      lastRunAt: '2026-08-13T00:02:00.000Z'
    })
    expect(() =>
      recovered.setScheduleEnabled(schedule.id, true)
    ).toThrow('已执行的一次性计划不能恢复自动运行')
    recovered.close()
  })

  it('claims a bounded batch of independent due schedules', async () => {
    const database = await createDatabase()
    const scheduleIds = Array.from({ length: 3 }, (_, index) =>
      database.createSchedule({
        title: `批量任务 ${index + 1}`,
        prompt: `执行批量任务 ${index + 1}`,
        workMode: 'execute',
        recurrence: 'once',
        nextRunAt: '2026-08-13T00:00:00.000Z'
      }).id
    )

    const firstBatch = claimQueuedSchedules(
      database,
      new Date('2026-08-13T00:01:00.000Z'),
      2
    )
    expect(firstBatch).toHaveLength(2)
    expect(
      new Set(firstBatch.map((claim) => claim.schedule.id)).size
    ).toBe(2)

    const secondBatch = claimQueuedSchedules(
      database,
      new Date('2026-08-13T00:01:00.000Z'),
      2
    )
    expect(secondBatch).toHaveLength(1)
    expect(scheduleIds).toContain(secondBatch[0]?.schedule.id)
    for (const claim of [...firstBatch, ...secondBatch]) {
      database.completeScheduleRun(claim.runId, 'completed')
    }
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
        knowledgeRetrievalMode: 'always',
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
            contextCompression: {
              state: 'completed',
              scope: 'conversation',
              estimatedBeforeTokens: 22_000,
              estimatedAfterTokens: 9_000
            },
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
            ],
            knowledgeRetrieval: {
              mode: 'always',
              state: 'succeeded',
              libraryCount: 1,
              resultCount: 1,
              durationMs: 42,
              usedChannels: ['fts', 'vector'],
              warnings: []
            }
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
        knowledgeRetrievalMode: 'always',
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
            contextCompression: {
              state: 'completed',
              scope: 'conversation',
              estimatedBeforeTokens: 22_000,
              estimatedAfterTokens: 9_000
            },
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
            ],
            knowledgeRetrieval: {
              mode: 'always',
              state: 'succeeded',
              libraryCount: 1,
              resultCount: 1,
              durationMs: 42,
              usedChannels: ['fts', 'vector'],
              warnings: []
            }
          })
        ]
      })
    ])
    database.replaceConversations([])
    expect(database.listConversations()).toEqual([])
    database.close()
  })

  it('incrementally saves local changes without replacing unrelated or remote data', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-incremental-conversations-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const database = new AssistantDatabase(databasePath)
    database.initialize('C:\\Workspace')
    const project = database.listProjects()[0]!
    const conversationId =
      '00000000-0000-4000-8000-000000000501'
    const unrelatedId =
      '00000000-0000-4000-8000-000000000502'
    const streamingMessageId =
      '00000000-0000-4000-8000-000000000503'
    const newMessageId =
      '00000000-0000-4000-8000-000000000504'
    database.replaceConversations([
      {
        id: conversationId,
        projectId: project.id,
        title: '增量对话',
        updatedAt: 1_775_000_000_000,
        messages: [
          {
            id: streamingMessageId,
            role: 'assistant',
            content: '生成中',
            createdAt: 1_775_000_000_001,
            state: 'streaming',
            status: '正在生成'
          }
        ]
      },
      {
        id: unrelatedId,
        title: '不相关本地对话',
        updatedAt: 1_775_000_000_002,
        messages: []
      }
    ])
    const channelProject = database.ensureChannelProjects(
      'C:\\Users\\test',
      channelDefaultProfileId
    )[0]!
    const remote = database.getOrCreateRemoteConversation({
      projectId: channelProject.id,
      channel: 'weixin',
      accountId: 'default',
      externalConversationId: 'incremental-preserved',
      conversationType: 'direct',
      title: '保留的远程对话',
      accountDisplay: '发送者 ****0501'
    })
    const raw = new DatabaseSync(databasePath)
    raw
      .prepare('UPDATE messages SET request_id = ? WHERE id = ?')
      .run('preserved-request-id', streamingMessageId)
    raw.close()

    const save = [
      {
        header: {
          id: conversationId,
          projectId: project.id,
          contextMetrics: {
            runtimeSelectionKey: `model:${channelDefaultProfileId}`,
            contextTokens: 9_000,
            source: 'estimated' as const,
            basis: 'conversation' as const
          },
          contextCompressionState: {
            coveredHistoryDigest: 'a'.repeat(64),
            coveredMessageCount: 2,
            coveredFromMessageId:
              '00000000-0000-4000-8000-000000000503',
            coveredThroughMessageId:
              '00000000-0000-4000-8000-000000000504',
            summary: '持久化摘要'
          },
          title: '增量对话（已完成）',
          updatedAt: 1_775_000_001_000
        },
        messages: [
          {
            id: streamingMessageId,
            role: 'assistant' as const,
            content: '生成完成',
            createdAt: 1_775_000_000_001,
            state: 'complete' as const,
            status: '已完成',
            tools: [
              {
                callId: 'remote-tool-call',
                name: '远程工具',
                state: 'completed' as const,
                summary: '完整远程工具结果',
                output: '远程输出'.repeat(10_000)
              }
            ],
            subagents: [
              {
                childTaskId:
                  '00000000-0000-4000-8000-000000000513',
                expertId:
                  '00000000-0000-4000-8000-000000000514',
                expertName: 'explorer',
                routingMode: 'native' as const,
                runtimeCallId: 'call-task-1',
                state: 'completed' as const,
                reason: 'Review application architecture',
                output: 'Architecture review complete.'
              }
            ],
            contextCompressions: [
              {
                state: 'completed' as const,
                scope: 'agent-run' as const,
                estimatedBeforeTokens: 24_000,
                estimatedAfterTokens: 11_000,
                compressionCount: 2
              },
              {
                state: 'completed' as const,
                scope: 'conversation' as const,
                estimatedBeforeTokens: 22_000,
                estimatedAfterTokens: 9_000
              }
            ]
          },
          {
            id: newMessageId,
            role: 'user' as const,
            content: '继续',
            createdAt: 1_775_000_001_000,
            state: 'complete' as const
          }
        ]
      }
    ]
    database.saveLocalConversations(save)
    database.saveLocalConversations(save)

    expect(database.getConversation(conversationId)).toMatchObject({
      title: '增量对话（已完成）',
      contextMetrics: {
        contextTokens: 9_000,
        source: 'estimated',
        basis: 'conversation'
      },
      contextCompressionState: {
        coveredHistoryDigest: 'a'.repeat(64),
        coveredMessageCount: 2,
        coveredFromMessageId:
          '00000000-0000-4000-8000-000000000503',
        coveredThroughMessageId:
          '00000000-0000-4000-8000-000000000504',
        summary: '持久化摘要'
      },
      messages: [
        {
          id: streamingMessageId,
          content: '生成完成',
          state: 'complete',
          status: '已完成',
          tools: [
            {
              callId: 'remote-tool-call',
              name: '远程工具',
              state: 'completed',
              summary: '完整远程工具结果',
              output: '远程输出'.repeat(10_000)
            }
          ],
          subagents: [
            {
              childTaskId:
                '00000000-0000-4000-8000-000000000513',
              expertId:
                '00000000-0000-4000-8000-000000000514',
              expertName: 'explorer',
              routingMode: 'native',
              runtimeCallId: 'call-task-1',
              state: 'completed',
              reason: 'Review application architecture',
              output: 'Architecture review complete.'
            }
          ],
          contextCompressions: [
            {
              state: 'completed',
              scope: 'agent-run',
              estimatedBeforeTokens: 24_000,
              estimatedAfterTokens: 11_000,
              compressionCount: 2
            },
            {
              state: 'completed',
              scope: 'conversation',
              estimatedBeforeTokens: 22_000,
              estimatedAfterTokens: 9_000
            }
          ]
        },
        {
          id: newMessageId,
          content: '继续',
          state: 'complete'
        }
      ]
    })
    expect(database.getConversation(unrelatedId).title).toBe(
      '不相关本地对话'
    )
    expect(database.getConversation(remote.id).remote?.channel).toBe(
      'weixin'
    )

    const durable = new DatabaseSync(databasePath)
    const contextStateRow = durable
      .prepare(
        `SELECT context_state_json
         FROM conversations
         WHERE id = ?`
      )
      .get(conversationId) as {
      context_state_json: string
    }
    const contextState = JSON.parse(
      contextStateRow.context_state_json
    ) as {
      contextMetrics?: unknown
    }
    expect(contextState.contextMetrics).toEqual({
      runtimeSelectionKey: `model:${channelDefaultProfileId}`,
      contextTokens: 9_000,
      source: 'estimated',
      basis: 'conversation'
    })
    expect(
      durable
        .prepare(
          `SELECT id, sequence, request_id
           FROM messages
           WHERE conversation_id = ?
           ORDER BY sequence`
        )
        .all(conversationId)
    ).toEqual([
      {
        id: streamingMessageId,
        sequence: 0,
        request_id: 'preserved-request-id'
      },
      {
        id: newMessageId,
        sequence: 1,
        request_id: null
      }
    ])
    durable
      .prepare(
        `UPDATE conversations
         SET context_state_json = ?
         WHERE id = ?`
      )
      .run(
        JSON.stringify({
          contextMetrics: {
            runtimeSelectionKey: `model:${channelDefaultProfileId}`,
            contextTokens: 9_000,
            effectiveTriggerTokens: 20_000,
            contextWindowTokens: 32_000,
            compressionEnabled: true,
            source: 'estimated',
            basis: 'conversation'
          }
        }),
        conversationId
      )
    expect(database.getConversation(conversationId).contextMetrics).toEqual({
      runtimeSelectionKey: `model:${channelDefaultProfileId}`,
      contextTokens: 9_000,
      source: 'estimated',
      basis: 'conversation'
    })
    durable.close()
    database.close()
  })

  it('atomically branches a stable local conversation without cloning owned work', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-branched-conversation-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const database = new AssistantDatabase(databasePath)
    database.initialize('C:\\Workspace')
    const project = database.listProjects()[0]!
    const sourceConversationId =
      '00000000-0000-4000-8000-000000000541'
    const sourceMessageIds = [
      '00000000-0000-4000-8000-000000000542',
      '00000000-0000-4000-8000-000000000543'
    ]
    database.replaceConversations([
      {
        id: sourceConversationId,
        projectId: project.id,
        runtimeSelection: {
          provider: 'model',
          profileId: channelDefaultProfileId
        },
        knowledgeRetrievalMode: 'always',
        contextMetrics: {
          runtimeSelectionKey: `model:${channelDefaultProfileId}`,
          contextTokens: 4_096,
          source: 'estimated',
          basis: 'conversation'
        },
        contextCompressionState: {
          coveredHistoryDigest: 'b'.repeat(64),
          coveredMessageCount: 2,
          coveredFromMessageId: sourceMessageIds[0],
          coveredThroughMessageId: sourceMessageIds[1],
          summary: '来源会话摘要'
        },
        title: '发布方案讨论',
        updatedAt: 1_775_000_000_000,
        messages: [
          {
            id: sourceMessageIds[0]!,
            queueItemId:
              '00000000-0000-4000-8000-000000000551',
            role: 'user',
            content: '比较两个发布方案',
            createdAt: 1_775_000_000_000,
            state: 'complete',
            attachments: [
              {
                id: '00000000-0000-4000-8000-000000000544',
                name: '发布清单.md',
                size: 128,
                preview: '发布步骤',
                kind: 'text'
              }
            ]
          },
          {
            id: sourceMessageIds[1]!,
            role: 'assistant',
            content: '可以从风险和成本两个方向比较。',
            createdAt: 1_775_000_001_000,
            state: 'complete',
            task: {
              id: '00000000-0000-4000-8000-000000000545',
              title: '来源任务'
            },
            artifactIds: [
              '00000000-0000-4000-8000-000000000546'
            ]
          }
        ]
      }
    ])
    const raw = new DatabaseSync(databasePath)
    raw
      .prepare(
        `UPDATE messages
         SET request_id = ?
         WHERE id = ?`
      )
      .run(
        '00000000-0000-4000-8000-000000000547',
        sourceMessageIds[1]!
      )
    const sourceMetadataRow = raw
      .prepare(
        `SELECT metadata_json
         FROM messages
         WHERE id = ?`
      )
      .get(sourceMessageIds[1]!) as { metadata_json: string }
    raw
      .prepare(
        `UPDATE messages
         SET metadata_json = ?
         WHERE id = ?`
      )
      .run(
        JSON.stringify({
          ...(JSON.parse(sourceMetadataRow.metadata_json) as object),
          subagents: [
            {
              childTaskId:
                '00000000-0000-4000-8000-000000000549',
              expertId:
                '00000000-0000-4000-8000-000000000550',
              expertName: '来源专家',
              routingMode: 'manual',
              state: 'completed'
            }
          ]
        }),
        sourceMessageIds[1]!
      )
    raw.close()

    const sourceBefore = database.getConversation(sourceConversationId)
    const branch = database.branchLocalConversation({
      sourceConversationId,
      title: '发布方案讨论 · 分支'
    })

    expect(conversationSnapshotSchema.safeParse(branch).success).toBe(true)
    expect(branch).toMatchObject({
      projectId: project.id,
      runtimeSelection: {
        provider: 'model',
        profileId: channelDefaultProfileId
      },
      knowledgeRetrievalMode: 'always',
      branch: {
        sourceConversationId,
        sourceTitle: '发布方案讨论'
      },
      title: '发布方案讨论 · 分支'
    })
    expect(branch).not.toHaveProperty('contextMetrics')
    expect(branch).not.toHaveProperty('contextCompressionState')
    expect(branch.id).not.toBe(sourceConversationId)
    expect(branch.messages.map((message) => message.content)).toEqual(
      sourceBefore.messages.map((message) => message.content)
    )
    expect(
      branch.messages.every(
        (message) => !sourceMessageIds.includes(message.id)
      )
    ).toBe(true)
    expect(branch.messages[0]?.attachments).toEqual(
      sourceBefore.messages[0]?.attachments
    )
    expect(branch.messages[0]?.queueItemId).toBeUndefined()
    expect(branch.messages[1]?.task).toBeUndefined()
    expect(branch.messages[1]?.artifactIds).toBeUndefined()
    expect(database.getConversation(sourceConversationId)).toEqual(
      sourceBefore
    )

    const durable = new DatabaseSync(databasePath)
    expect(
      durable
        .prepare(
          `SELECT sequence, request_id
           FROM messages
           WHERE conversation_id = ?
           ORDER BY sequence`
        )
        .all(branch.id)
    ).toEqual([
      { sequence: 0, request_id: null },
      { sequence: 1, request_id: null }
    ])
    const branchMetadataRow = durable
      .prepare(
        `SELECT metadata_json
         FROM messages
         WHERE conversation_id = ? AND sequence = 1`
      )
      .get(branch.id) as { metadata_json: string }
    const branchMetadata = JSON.parse(
      branchMetadataRow.metadata_json
    ) as Record<string, unknown>
    expect(branchMetadata).not.toHaveProperty('artifactIds')
    expect(branchMetadata).not.toHaveProperty('subagents')
    expect(branchMetadata).not.toHaveProperty('task')
    const branchUserMetadataRow = durable
      .prepare(
        `SELECT metadata_json
         FROM messages
         WHERE conversation_id = ? AND sequence = 0`
      )
      .get(branch.id) as { metadata_json: string }
    expect(
      JSON.parse(branchUserMetadataRow.metadata_json)
    ).not.toHaveProperty('queueItemId')
    durable.close()

    database.saveLocalConversations([
      {
        header: {
          id: branch.id,
          projectId: branch.projectId,
          runtimeSelection: branch.runtimeSelection,
          knowledgeRetrievalMode: branch.knowledgeRetrievalMode,
          branch: branch.branch,
          title: '发布方案讨论 · 分支（独立更新）',
          updatedAt: 1_775_000_003_000
        },
        messages: [
          {
            id: '00000000-0000-4000-8000-000000000548',
            role: 'user',
            content: '只在分支中继续',
            createdAt: 1_775_000_003_000,
            state: 'complete'
          }
        ]
      }
    ])
    expect(database.getConversation(sourceConversationId)).toEqual(
      sourceBefore
    )
    expect(database.getConversation(branch.id)).toMatchObject({
      title: '发布方案讨论 · 分支（独立更新）',
      messages: [
        { content: '比较两个发布方案' },
        { content: '可以从风险和成本两个方向比较。' },
        { content: '只在分支中继续' }
      ]
    })

    expect(database.deleteLocalConversation(sourceConversationId)).toBe(
      true
    )
    expect(database.getConversation(branch.id)).toMatchObject({
      branch: {
        sourceConversationId,
        sourceTitle: '发布方案讨论'
      },
      messages: [
        { content: '比较两个发布方案' },
        { content: '可以从风险和成本两个方向比较。' },
        { content: '只在分支中继续' }
      ]
    })
    database.close()
  })

  it('rejects unstable or remote branch sources and rolls back copy failures', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-conversation-branch-guards-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const database = new AssistantDatabase(databasePath)
    database.initialize('C:\\Workspace')
    const sourceConversationId =
      '00000000-0000-4000-8000-000000000551'
    const sourceMessageId =
      '00000000-0000-4000-8000-000000000552'
    database.replaceConversations([
      {
        id: sourceConversationId,
        title: '必须稳定后分支',
        updatedAt: 1,
        messages: [
          {
            id: sourceMessageId,
            role: 'user',
            content: '稳定内容',
            createdAt: 1,
            state: 'complete'
          }
        ]
      }
    ])
    const queued = database.enqueueConversationUserInput({
      conversationId: sourceConversationId,
      label: '待发送内容',
      payloadJson: '{}'
    })
    expect(() =>
      database.branchLocalConversation({
        sourceConversationId,
        title: '不应创建的队列分支'
      })
    ).toThrow('仍有待发送内容')
    database.removeConversationUserQueueItem(queued.id)

    const taskId = '00000000-0000-4000-8000-000000000553'
    database.createTask({
      id: taskId,
      conversationId: sourceConversationId,
      title: '运行中的任务',
      instructions: '保持运行',
      workMode: 'ask'
    })
    database.updateTaskStatus(taskId, 'running')
    expect(() =>
      database.branchLocalConversation({
        sourceConversationId,
        title: '不应创建的运行分支'
      })
    ).toThrow('仍有正在运行的任务')
    database.updateTaskStatus(taskId, 'completed')

    const channelProject = database.ensureChannelProjects(
      'C:\\Users\\test',
      channelDefaultProfileId
    )[0]!
    const remote = database.getOrCreateRemoteConversation({
      projectId: channelProject.id,
      channel: 'weixin',
      accountId: 'default',
      externalConversationId: 'branch-protected',
      conversationType: 'direct',
      title: '远程来源',
      accountDisplay: '发送者 ****0551'
    })
    expect(() =>
      database.branchLocalConversation({
        sourceConversationId: remote.id,
        title: '不应创建的远程分支'
      })
    ).toThrow('只能从现有的本地会话创建分支')

    const countBeforeFailure = database.listConversations().length
    const raw = new DatabaseSync(databasePath)
    raw.exec(`
      CREATE TRIGGER reject_branched_message
      BEFORE INSERT ON messages
      WHEN NEW.conversation_id != '${sourceConversationId}'
      BEGIN
        SELECT RAISE(ABORT, 'forced branch copy failure');
      END;
    `)
    raw.close()
    expect(() =>
      database.branchLocalConversation({
        sourceConversationId,
        title: '必须完整回滚'
      })
    ).toThrow('forced branch copy failure')
    expect(database.listConversations()).toHaveLength(countBeforeFailure)
    database.close()
  })

  it('keeps incremental local conversation storage bounded to 500 messages', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'goodbuddy-bounded-local-conversation-')
    )
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'assistant.sqlite')
    const database = new AssistantDatabase(databasePath)
    database.initialize('C:\\Workspace')
    const project = database.listProjects()[0]!
    const conversationId =
      '00000000-0000-4000-8000-000000000521'
    const messageId = (index: number): string =>
      `00000000-0000-4000-8001-${String(index).padStart(12, '0')}`
    database.replaceConversations([
      {
        id: conversationId,
        projectId: project.id,
        title: '有界增量对话',
        updatedAt: 1_775_000_000_000,
        messages: Array.from({ length: 500 }, (_, index) => ({
          id: messageId(index),
          role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
          content: `消息 ${index}`,
          createdAt: 1_775_000_000_000 + index,
          state: 'complete' as const
        }))
      }
    ])

    const newestMessageId = messageId(500)
    database.saveLocalConversations([
      {
        header: {
          id: conversationId,
          projectId: project.id,
          title: '有界增量对话',
          updatedAt: 1_775_000_001_000
        },
        messages: [
          {
            id: newestMessageId,
            role: 'user',
            content: '最新消息',
            createdAt: 1_775_000_001_000,
            state: 'complete'
          }
        ]
      }
    ])

    const restored = database.getConversation(conversationId)
    expect(restored.messages).toHaveLength(500)
    expect(restored.messages[0]?.id).toBe(messageId(1))
    expect(restored.messages.at(-1)?.id).toBe(newestMessageId)
    const raw = new DatabaseSync(databasePath)
    expect(
      raw
        .prepare(
          `SELECT COUNT(*) AS count, MIN(sequence) AS minimum,
                  MAX(sequence) AS maximum
           FROM messages
           WHERE conversation_id = ?`
        )
        .get(conversationId)
    ).toEqual({
      count: 500,
      minimum: 1,
      maximum: 500
    })
    raw.close()
    database.close()
  })

  it('rolls back incremental saves when message ownership or role changes', async () => {
    const database = await createDatabase()
    const firstConversationId =
      '00000000-0000-4000-8000-000000000511'
    const secondConversationId =
      '00000000-0000-4000-8000-000000000512'
    const firstMessageId =
      '00000000-0000-4000-8000-000000000513'
    const secondMessageId =
      '00000000-0000-4000-8000-000000000514'
    const rolledBackMessageId =
      '00000000-0000-4000-8000-000000000515'
    database.replaceConversations([
      {
        id: firstConversationId,
        title: '第一对话',
        updatedAt: 1,
        messages: [
          {
            id: firstMessageId,
            role: 'user',
            content: '第一条',
            createdAt: 1,
            state: 'complete'
          }
        ]
      },
      {
        id: secondConversationId,
        title: '第二对话',
        updatedAt: 2,
        messages: [
          {
            id: secondMessageId,
            role: 'assistant',
            content: '第二条',
            createdAt: 2,
            state: 'complete'
          }
        ]
      }
    ])

    expect(() =>
      database.saveLocalConversations([
        {
          header: {
            id: firstConversationId,
            title: '不应提交的标题',
            updatedAt: 3
          },
          messages: [
            {
              id: rolledBackMessageId,
              role: 'user',
              content: '不应提交',
              createdAt: 3,
              state: 'complete'
            },
            {
              id: secondMessageId,
              role: 'assistant',
              content: '错误归属',
              createdAt: 2,
              state: 'complete'
            }
          ]
        }
      ])
    ).toThrow('消息 ID 已属于其他对话')
    expect(database.getConversation(firstConversationId)).toMatchObject({
      title: '第一对话',
      messages: [{ id: firstMessageId }]
    })

    expect(() =>
      database.saveLocalConversations([
        {
          header: {
            id: firstConversationId,
            title: '仍不应提交的标题',
            updatedAt: 4
          },
          messages: [
            {
              id: firstMessageId,
              role: 'assistant',
              content: '错误角色',
              createdAt: 1,
              state: 'complete'
            }
          ]
        }
      ])
    ).toThrow('消息角色不能更改')
    expect(database.getConversation(firstConversationId)).toMatchObject({
      title: '第一对话',
      messages: [
        {
          id: firstMessageId,
          role: 'user',
          content: '第一条'
        }
      ]
    })
    database.close()
  })

  it('explicitly deletes only local conversations and cascades messages', async () => {
    const database = await createDatabase()
    const localId = '00000000-0000-4000-8000-000000000521'
    const localTaskId = '00000000-0000-4000-8000-000000000523'
    database.replaceConversations([
      {
        id: localId,
        title: '待删除本地对话',
        updatedAt: 1,
        messages: [
          {
            id: '00000000-0000-4000-8000-000000000522',
            role: 'user',
            content: '待删除消息',
            createdAt: 1,
            state: 'complete'
          }
        ]
      }
    ])
    const channelProject = database.ensureChannelProjects(
      'C:\\Users\\test',
      channelDefaultProfileId
    )[0]!
    const remote = database.getOrCreateRemoteConversation({
      projectId: channelProject.id,
      channel: 'weixin',
      accountId: 'default',
      externalConversationId: 'protected-delete',
      conversationType: 'direct',
      title: '受保护远程对话',
      accountDisplay: '发送者 ****0521'
    })
    database.appendRemoteConversationMessage({
      conversationId: remote.id,
      role: 'user',
      content: '远程消息'
    })
    const linkedSchedule = database.createSchedule({
      conversationId: localId,
      title: '随会话删除的任务',
      prompt: '整理会话',
      workMode: 'execute',
      recurrence: 'daily',
      nextRunAt: '2027-01-01T00:00:00.000Z'
    })
    database.createTask({
      id: localTaskId,
      conversationId: localId,
      title: '本地对话任务',
      instructions: '生成仅属于对话的回复',
      workMode: 'ask'
    })
    database.updateTaskStatus(localTaskId, 'completed')
    const hiddenReply = database.createTextArtifact({
      taskId: localTaskId,
      title: '本地对话回复',
      content: '删除对话后不得进入成果列表'
    })
    database.saveDelegationResult(localTaskId, {
      status: 'completed',
      output: '不应残留'
    })
    expect(
      database
        .listArtifacts()
        .some((artifact) => artifact.id === hiddenReply.id)
    ).toBe(false)

    expect(database.deleteLocalConversation(localId)).toBe(true)
    expect(database.deleteLocalConversation(localId)).toBe(false)
    expect(
      database
        .listSchedules()
        .some((schedule) => schedule.id === linkedSchedule.id)
    ).toBe(false)
    expect(
      database
        .listTasks()
        .some((task) => task.id === linkedSchedule.taskId)
    ).toBe(false)
    expect(() =>
      database.getConversation(localId)
    ).toThrow('对话不存在')
    expect(() => database.getArtifact(hiddenReply.id)).toThrow(
      '成果不存在'
    )
    expect(database.listPendingDelegationResults()).toEqual([])
    expect(() =>
      database.deleteLocalConversation(remote.id)
    ).toThrow('远程对话不能作为本地对话删除')
    expect(() =>
      database.saveLocalConversations([
        {
          header: {
            id: remote.id,
            title: '冲突本地标题',
            updatedAt: 2
          },
          messages: []
        }
      ])
    ).toThrow('本地对话 ID 与远程对话冲突')
    expect(database.getConversation(remote.id)).toMatchObject({
      title: '受保护远程对话',
      messages: [{ content: '远程消息' }]
    })
    database.close()
  })

  it('gets a targeted conversation outside the latest 100', async () => {
    const database = await createDatabase()
    database.saveLocalConversations(
      Array.from({ length: 100 }, (_, index) => ({
        header: {
          id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          title: `较新对话 ${index}`,
          updatedAt: index + 2
        },
        messages: []
      }))
    )
    const oldestId = '00000000-0000-4000-8000-000000000999'
    database.saveLocalConversations([
      {
        header: {
          id: oldestId,
          title: '第 101 个对话',
          updatedAt: 1
        },
        messages: []
      }
    ])

    expect(database.listConversations()).toHaveLength(100)
    expect(
      database.listConversations().some(
        (conversation) => conversation.id === oldestId
      )
    ).toBe(false)
    expect(database.getConversation(oldestId)).toMatchObject({
      id: oldestId,
      title: '第 101 个对话',
      messages: []
    })
    database.close()
  })

  it('repairs unattended channel selections without rebinding ordinary conversations', async () => {
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
    ).toBe(4)
    expect(
      database
        .listConversations()
        .filter((conversation) => !conversation.remote)
        .sort((left, right) => left.title.localeCompare(right.title))
        .map((conversation) => conversation.runtimeSelection)
    ).toEqual([
      { provider: 'model', profileId: removedProfileId },
      { provider: 'opencode', profileId: removedProfileId },
      { provider: 'continue', profileId: removedProfileId },
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

  it('durably interrupts active tool and subagent metadata during startup recovery', async () => {
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
    const subagentMessageId =
      '00000000-0000-4000-8000-000000000220'
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
          },
          {
            id: subagentMessageId,
            role: 'assistant',
            content: '父请求已完成',
            createdAt: 1_775_000_003_000,
            state: 'complete',
            status: '已完成',
            subagents: [
              {
                childTaskId:
                  '00000000-0000-4000-8000-000000000221',
                expertId:
                  '00000000-0000-4000-8000-000000000222',
                expertName: 'explorer',
                routingMode: 'native',
                runtimeCallId: 'task-1',
                state: 'running',
                reason: '检查项目'
              },
              {
                childTaskId:
                  '00000000-0000-4000-8000-000000000223',
                expertId:
                  '00000000-0000-4000-8000-000000000224',
                expertName: 'worker',
                routingMode: 'native',
                runtimeCallId: 'task-2',
                state: 'completed',
                output: '已完成'
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
    expect(recovered.listConversations()[0]?.messages[2]).toMatchObject({
      id: subagentMessageId,
      state: 'complete',
      status: '已完成',
      subagents: [
        expect.objectContaining({
          runtimeCallId: 'task-1',
          state: 'cancelled'
        }),
        expect.objectContaining({
          runtimeCallId: 'task-2',
          state: 'completed'
        })
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

  it('keeps duplicate chat replies out of artifact listings', async () => {
    const database = await createDatabase()
    const project = database.listProjects()[0]!
    const chatTaskId = '00000000-0000-4000-8000-000000000231'
    const channelTaskId = '00000000-0000-4000-8000-000000000232'
    const scheduleTaskId = '00000000-0000-4000-8000-000000000233'
    const delegationTaskId = '00000000-0000-4000-8000-000000000234'
    database.createTask({
      id: chatTaskId,
      projectId: project.id,
      conversationId: 'conversation-chat',
      title: '普通对话',
      instructions: '回答问题',
      workMode: 'ask'
    })
    database.createTask({
      id: channelTaskId,
      projectId: project.id,
      conversationId: 'conversation-channel',
      title: '远程对话',
      instructions: '回答远程消息',
      workMode: 'ask',
      origin: 'delegation'
    })
    database.createTask({
      id: scheduleTaskId,
      projectId: project.id,
      conversationId: 'schedule:daily',
      title: '每日报告',
      instructions: '生成报告',
      workMode: 'ask',
      origin: 'schedule'
    })
    database.createTask({
      id: delegationTaskId,
      projectId: project.id,
      conversationId: 'delegation:weekly-report',
      title: '委派报告',
      instructions: '生成远程委派报告',
      workMode: 'ask',
      origin: 'delegation'
    })
    const chatReply = database.createTextArtifact({
      projectId: project.id,
      taskId: chatTaskId,
      title: '普通对话',
      content: '普通回复'
    })
    const channelReply = database.createTextArtifact({
      projectId: project.id,
      taskId: channelTaskId,
      title: '远程对话',
      content: '远程回复'
    })
    const scheduledReport = database.createTextArtifact({
      projectId: project.id,
      taskId: scheduleTaskId,
      title: '每日报告',
      content: '# 每日报告'
    })
    const delegatedReport = database.createTextArtifact({
      projectId: project.id,
      taskId: delegationTaskId,
      title: '委派报告',
      content: '# 委派报告'
    })
    const generatedImage = database.createImageArtifact({
      projectId: project.id,
      taskId: chatTaskId,
      title: '生成图片',
      mimeType: 'image/png',
      base64: 'iVBORw0KGgo='
    })

    const visibleArtifactIds = database
      .listArtifacts(project.id)
      .map((artifact) => artifact.id)
    expect(visibleArtifactIds).toEqual(
      expect.arrayContaining([
        scheduledReport.id,
        delegatedReport.id,
        generatedImage.id
      ])
    )
    expect(visibleArtifactIds).not.toContain(chatReply.id)
    expect(visibleArtifactIds).not.toContain(channelReply.id)
    expect(database.getArtifact(chatReply.id)).toMatchObject({
      id: chatReply.id,
      content: '普通回复'
    })
    database.close()
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
        cacheInput: 177,
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
          cacheInput: 177,
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
      cacheInput: 312,
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
          cacheInput: 197,
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
    expect(database.searchMagicNotes('全局', 5)).toEqual([
      expect.objectContaining({
        noteId: globalNote.id,
        noteTitle: '全局笔记',
        content: ''
      })
    ])
    expect(database.searchMagicNotes('全局', 5)[0]?.entryId).toBeUndefined()

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

  it('counts incomplete todos and publishes todo-changing writes', async () => {
    const onMagicTodosChanged = vi.fn()
    const database = await createDatabase({ onMagicTodosChanged })
    const note = database.createMagicNote({ title: '发布笔记' })

    expect(database.getMagicTodoStatus()).toEqual({
      incompleteCount: 0
    })
    expect(onMagicTodosChanged).not.toHaveBeenCalled()

    database.createMagicNoteEntry({
      noteId: note.id,
      content: {
        version: 1,
        ops: [
          { insert: '核对发布材料' },
          { insert: '\n', attributes: { list: 'unchecked' } },
          { insert: '上传构建产物' },
          { insert: '\n', attributes: { list: 'unchecked' } },
          { insert: '通知负责人' },
          { insert: '\n', attributes: { list: 'checked' } }
        ]
      },
      plainText: '核对发布材料\n上传构建产物\n通知负责人'
    })

    expect(database.getMagicTodoStatus()).toEqual({
      incompleteCount: 2
    })
    expect(onMagicTodosChanged).toHaveBeenCalledTimes(1)

    const todo = database
      .listMagicTodos()
      .find((candidate) => !candidate.completed)!
    database.updateMagicTodo({
      todoId: todo.id,
      completed: true,
      expectedRevision: todo.revision
    })

    expect(database.getMagicTodoStatus()).toEqual({
      incompleteCount: 1
    })
    expect(onMagicTodosChanged).toHaveBeenCalledTimes(2)

    database.deleteMagicNote(note.id)
    expect(database.getMagicTodoStatus()).toEqual({
      incompleteCount: 0
    })
    expect(onMagicTodosChanged).toHaveBeenCalledTimes(3)

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
        scope: { kind: 'projects', projectIds: [project.id] },
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
        cacheInput: 0,
        totalTokens: 0
      },
      records: []
    })
    database.close()
  })
})
