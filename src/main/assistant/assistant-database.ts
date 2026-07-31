import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  AssistantArtifact,
  AssistantExpert,
  AssistantMemory,
  AssistantProject,
  AssistantSchedule,
  AssistantTask,
  ConversationSnapshot,
  ExpertCreateInput,
  MemoryCreateInput,
  ProjectCreateInput,
  ScheduleCreateInput
} from '../../shared/assistant-contracts'

type ProjectRow = {
  id: string
  name: string
  description: string
  root_path: string
  default_work_mode: ProjectCreateInput['defaultWorkMode']
  status: AssistantProject['status']
  created_at: string
  updated_at: string
}

type TaskRow = {
  id: string
  project_id: string | null
  conversation_id: string | null
  title: string
  instructions: string
  origin: AssistantTask['origin']
  status: AssistantTask['status']
  progress: number | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  error: string | null
}

type ConversationRow = {
  id: string
  project_id: string | null
  title: string
  updated_at: string
}

type MessageRow = {
  id: string
  conversation_id: string
  role: ConversationSnapshot['messages'][number]['role']
  content: string
  state: ConversationSnapshot['messages'][number]['state']
  metadata_json: string
  created_at: string
}

type ArtifactRow = {
  id: string
  project_id: string | null
  task_id: string | null
  kind: AssistantArtifact['kind']
  title: string
  mime_type: string
  inline_content: string | null
  byte_size: number
  created_at: string
  updated_at: string
}

type MemoryRow = {
  id: string
  scope: AssistantMemory['scope']
  scope_id: string | null
  type: AssistantMemory['type']
  content: string
  confidence: number
  salience: number
  status: AssistantMemory['status']
  created_at: string
  updated_at: string
}

type ScheduleRow = {
  id: string
  project_id: string | null
  task_template_json: string
  recurrence_json: string
  next_run_at: string
  enabled: number
  last_run_at: string | null
  created_at: string
  updated_at: string
}

type ExpertRow = {
  id: string
  name: string
  description: string
  system_instructions: string
  enabled: number
  created_at: string
  updated_at: string
}

function toProject(row: ProjectRow): AssistantProject {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rootPath: row.root_path,
    defaultWorkMode: row.default_work_mode,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toTask(row: TaskRow): AssistantTask {
  return {
    id: row.id,
    projectId: row.project_id ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    title: row.title,
    instructions: row.instructions,
    origin: row.origin,
    status: row.status,
    progress: row.progress ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    error: row.error ?? undefined
  }
}

function toArtifact(row: ArtifactRow): AssistantArtifact {
  return {
    id: row.id,
    projectId: row.project_id ?? undefined,
    taskId: row.task_id ?? undefined,
    kind: row.kind,
    title: row.title,
    mimeType: row.mime_type,
    content: row.inline_content ?? undefined,
    byteSize: row.byte_size,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toMemory(row: MemoryRow): AssistantMemory {
  return {
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id ?? undefined,
    type: row.type,
    content: row.content,
    confidence: row.confidence,
    salience: row.salience,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toSchedule(row: ScheduleRow): AssistantSchedule {
  const template = JSON.parse(row.task_template_json) as {
    title: string
    prompt: string
    workMode: AssistantSchedule['workMode']
  }
  const recurrence = JSON.parse(row.recurrence_json) as {
    type: AssistantSchedule['recurrence']
  }
  return {
    id: row.id,
    projectId: row.project_id ?? undefined,
    title: template.title,
    prompt: template.prompt,
    workMode: template.workMode,
    recurrence: recurrence.type,
    nextRunAt: row.next_run_at,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toExpert(row: ExpertRow): AssistantExpert {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    systemInstructions: row.system_instructions,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class AssistantDatabase {
  private database?: DatabaseSync

  constructor(private readonly databasePath: string) {}

  initialize(defaultRootPath: string): void {
    if (this.database) {
      return
    }
    const database = new DatabaseSync(this.databasePath, {
      enableForeignKeyConstraints: true,
      timeout: 5_000
    })
    try {
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
      `)
      this.migrate(database)
      this.database = database
      const count = database
        .prepare('SELECT COUNT(*) AS count FROM projects')
        .get() as { count: number }
      if (count.count === 0) {
        this.createProject({
          name: '默认项目',
          description: 'GoodBuddy 默认工作区',
          rootPath: defaultRootPath,
          defaultWorkMode: 'ask'
        })
      }
      const expertCount = database
        .prepare('SELECT COUNT(*) AS count FROM experts')
        .get() as { count: number }
      if (expertCount.count === 0) {
        this.createExpert({
          name: '研究分析专家',
          description: '负责资料分析、证据整理和结论验证',
          systemInstructions:
            'Act as a rigorous research analyst. Separate evidence, assumptions, and conclusions. Cite provided sources and identify uncertainty.'
        })
        this.createExpert({
          name: '文档写作专家',
          description: '负责结构化写作、编辑和内容润色',
          systemInstructions:
            'Act as a professional document editor. Produce clear structure, concise language, and actionable content appropriate to the user context.'
        })
        this.createExpert({
          name: '项目规划专家',
          description: '负责目标拆解、风险分析和执行计划',
          systemInstructions:
            'Act as a project planning specialist. Decompose goals into verifiable steps, dependencies, risks, owners, and acceptance criteria.'
        })
      }
      database
        .prepare(
          `UPDATE tasks
           SET status = 'interrupted',
               error = COALESCE(error, '应用退出时任务仍在运行')
           WHERE status IN ('running', 'waiting_approval')`
        )
        .run()
    } catch (error) {
      database.close()
      throw error
    }
  }

  close(): void {
    this.database?.close()
    this.database = undefined
  }

  listProjects(includeArchived = false): AssistantProject[] {
    const database = this.requireDatabase()
    const rows = database
      .prepare(
        includeArchived
          ? 'SELECT * FROM projects ORDER BY updated_at DESC'
          : `SELECT * FROM projects
             WHERE status = 'active'
             ORDER BY updated_at DESC`
      )
      .all() as ProjectRow[]
    return rows.map(toProject)
  }

  createProject(input: ProjectCreateInput): AssistantProject {
    const database = this.requireDatabase()
    const id = randomUUID()
    const now = new Date().toISOString()
    database
      .prepare(
        `INSERT INTO projects
          (id, name, description, root_path, default_work_mode, status,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
      )
      .run(
        id,
        input.name,
        input.description,
        input.rootPath,
        input.defaultWorkMode,
        now,
        now
      )
    return this.getProject(id)
  }

  updateProject(
    projectId: string,
    input: ProjectCreateInput
  ): AssistantProject {
    const database = this.requireDatabase()
    const result = database
      .prepare(
        `UPDATE projects
         SET name = ?, description = ?, root_path = ?,
             default_work_mode = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.name,
        input.description,
        input.rootPath,
        input.defaultWorkMode,
        new Date().toISOString(),
        projectId
      )
    if (result.changes !== 1) {
      throw new Error('项目不存在')
    }
    return this.getProject(projectId)
  }

  setProjectArchived(projectId: string, archived: boolean): void {
    const database = this.requireDatabase()
    const result = database
      .prepare(
        `UPDATE projects
         SET status = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        archived ? 'archived' : 'active',
        new Date().toISOString(),
        projectId
      )
    if (result.changes !== 1) {
      throw new Error('项目不存在')
    }
  }

  listConversations(): ConversationSnapshot[] {
    const database = this.requireDatabase()
    const conversations = database
      .prepare(
        `SELECT id, project_id, title, updated_at
         FROM conversations
         WHERE status = 'active'
         ORDER BY updated_at DESC
         LIMIT 100`
      )
      .all() as ConversationRow[]
    const messageStatement = database.prepare(
      `SELECT id, conversation_id, role, content, state, metadata_json,
              created_at
       FROM messages
       WHERE conversation_id = ?
       ORDER BY sequence ASC
       LIMIT 500`
    )
    return conversations.map((conversation) => ({
      id: conversation.id,
      projectId: conversation.project_id ?? undefined,
      title: conversation.title,
      updatedAt: Date.parse(conversation.updated_at),
      messages: (
        messageStatement.all(conversation.id) as MessageRow[]
      ).map((message) => {
        const metadata = JSON.parse(message.metadata_json) as {
          createdAt?: number
          status?: string
          tools?: ConversationSnapshot['messages'][number]['tools']
          sources?: string[]
        }
        const interrupted = message.state === 'streaming'
        return {
          id: message.id,
          role: message.role,
          content: message.content,
          createdAt:
            metadata.createdAt ?? Date.parse(message.created_at),
          state: interrupted ? ('error' as const) : message.state,
          status: interrupted
            ? '上次运行意外中断，可以重新发送问题'
            : metadata.status,
          tools: metadata.tools,
          sources: metadata.sources
        }
      })
    }))
  }

  replaceConversations(
    conversations: ConversationSnapshot[]
  ): void {
    const database = this.requireDatabase()
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec('DELETE FROM messages; DELETE FROM conversations;')
      const insertConversation = database.prepare(
        `INSERT INTO conversations
          (id, project_id, work_mode, title, status, created_at, updated_at)
         VALUES (?, ?, 'ask', ?, 'active', ?, ?)`
      )
      const insertMessage = database.prepare(
        `INSERT INTO messages
          (id, conversation_id, request_id, role, content, state, sequence,
           metadata_json, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`
      )
      for (const conversation of conversations.slice(0, 100)) {
        const updatedAt = new Date(conversation.updatedAt).toISOString()
        insertConversation.run(
          conversation.id,
          conversation.projectId ?? null,
          conversation.title,
          updatedAt,
          updatedAt
        )
        for (const [sequence, message] of conversation.messages
          .slice(-500)
          .entries()) {
          insertMessage.run(
            message.id,
            conversation.id,
            message.role,
            message.content,
            message.state,
            sequence,
            JSON.stringify({
              createdAt: message.createdAt,
              status: message.status,
              tools: message.tools,
              sources: message.sources
            }),
            new Date(message.createdAt).toISOString()
          )
        }
      }
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  listPendingDelegationResults(): Array<{
    taskId: string
    result: {
      status: 'completed' | 'failed'
      output?: string
      error?: string
    }
  }> {
    const rows = this.requireDatabase()
      .prepare(
        `SELECT task_id, result_json
         FROM delegation_outbox
         WHERE status = 'pending'
         ORDER BY created_at
         LIMIT 100`
      )
      .all() as Array<{ task_id: string; result_json: string }>
    return rows.map((row) => ({
      taskId: row.task_id,
      result: JSON.parse(row.result_json) as {
        status: 'completed' | 'failed'
        output?: string
        error?: string
      }
    }))
  }

  getDelegationDeliveryStatus(
    taskId: string
  ): 'pending' | 'delivered' | undefined {
    const row = this.requireDatabase()
      .prepare(
        `SELECT status FROM delegation_outbox WHERE task_id = ?`
      )
      .get(taskId) as { status: 'pending' | 'delivered' } | undefined
    return row?.status
  }

  saveDelegationResult(
    taskId: string,
    result: {
      status: 'completed' | 'failed'
      output?: string
      error?: string
    }
  ): void {
    const now = new Date().toISOString()
    this.requireDatabase()
      .prepare(
        `INSERT INTO delegation_outbox
          (task_id, result_json, status, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           result_json = excluded.result_json,
           status = 'pending',
           updated_at = excluded.updated_at`
      )
      .run(taskId, JSON.stringify(result), now, now)
  }

  markDelegationDelivered(taskId: string): void {
    const database = this.requireDatabase()
    database
      .prepare(
        `UPDATE delegation_outbox
         SET status = 'delivered', result_json = '{}', updated_at = ?
         WHERE task_id = ?`
      )
      .run(new Date().toISOString(), taskId)
    database
      .prepare(
        `DELETE FROM delegation_outbox
         WHERE task_id IN (
           SELECT task_id FROM delegation_outbox
           WHERE status = 'delivered'
           ORDER BY updated_at DESC
           LIMIT -1 OFFSET 1000
         )`
      )
      .run()
  }

  listTasks(limit = 100): AssistantTask[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
    const rows = this.requireDatabase()
      .prepare(
        `SELECT * FROM tasks
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(safeLimit) as TaskRow[]
    return rows.map(toTask)
  }

  createTask(input: {
    id: string
    projectId?: string
    conversationId?: string
    title: string
    instructions: string
    workMode: 'ask' | 'plan' | 'execute'
    origin?: AssistantTask['origin']
  }): AssistantTask {
    const now = new Date().toISOString()
    this.requireDatabase()
      .prepare(
        `INSERT INTO tasks
          (id, project_id, conversation_id, title, instructions, origin,
           status, priority, work_mode, progress, created_at, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', 0, ?, NULL, ?, ?)`
      )
      .run(
        input.id,
        input.projectId ?? null,
        input.conversationId ?? null,
        input.title,
        input.instructions,
        input.origin ?? 'user',
        input.workMode,
        now,
        now
      )
    this.appendTaskEvent(input.id, 'started', {
      workMode: input.workMode
    })
    return this.getTask(input.id)
  }

  updateTaskStatus(
    taskId: string,
    status: AssistantTask['status'],
    error?: string
  ): void {
    const terminal = [
      'completed',
      'failed',
      'cancelled',
      'interrupted'
    ].includes(status)
    const result = this.requireDatabase()
      .prepare(
        `UPDATE tasks
         SET status = ?, error = ?,
             completed_at = CASE WHEN ? THEN ? ELSE completed_at END
         WHERE id = ?`
      )
      .run(
        status,
        error ?? null,
        terminal ? 1 : 0,
        new Date().toISOString(),
        taskId
      )
    if (result.changes !== 1) {
      throw new Error('任务不存在')
    }
    this.appendTaskEvent(taskId, 'status', { status, error })
  }

  appendTaskEvent(
    taskId: string,
    kind: string,
    payload: unknown
  ): void {
    this.requireDatabase()
      .prepare(
        `INSERT INTO task_events
          (task_id, run_id, kind, payload_json, created_at)
         VALUES (?, NULL, ?, ?, ?)`
      )
      .run(
        taskId,
        kind.slice(0, 64),
        JSON.stringify(payload),
        new Date().toISOString()
      )
  }

  listArtifacts(projectId?: string, limit = 100): AssistantArtifact[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
    const rows = projectId
      ? this.requireDatabase()
          .prepare(
            `SELECT * FROM artifacts
             WHERE project_id = ?
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(projectId, safeLimit)
      : this.requireDatabase()
          .prepare(
            `SELECT * FROM artifacts
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(safeLimit)
    return (rows as ArtifactRow[]).map(toArtifact)
  }

  createTextArtifact(input: {
    projectId?: string
    taskId?: string
    title: string
    content: string
  }): AssistantArtifact {
    return this.createInlineArtifact({
      ...input,
      kind: 'markdown',
      mimeType: 'text/markdown'
    })
  }

  createInlineArtifact(input: {
    projectId?: string
    taskId?: string
    kind: AssistantArtifact['kind']
    title: string
    mimeType: string
    content: string
  }): AssistantArtifact {
    const id = randomUUID()
    const now = new Date().toISOString()
    const byteSize = Buffer.byteLength(input.content)
    if (byteSize > 5 * 1024 * 1024) {
      throw new Error('成果内容超过 5MB 限制')
    }
    this.requireDatabase()
      .prepare(
        `INSERT INTO artifacts
          (id, project_id, task_id, run_id, kind, title, mime_type,
           storage_kind, storage_path, inline_content, checksum, byte_size,
           preview_json, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?,
           'inline', NULL, ?, NULL, ?, '{}', ?, ?)`
      )
      .run(
        id,
        input.projectId ?? null,
        input.taskId ?? null,
        input.kind,
        input.title.slice(0, 240),
        input.mimeType.slice(0, 128),
        input.content,
        byteSize,
        now,
        now
      )
    const row = this.requireDatabase()
      .prepare('SELECT * FROM artifacts WHERE id = ?')
      .get(id) as ArtifactRow
    return toArtifact(row)
  }

  listMemories(scopeId?: string): AssistantMemory[] {
    const rows = scopeId
      ? this.requireDatabase()
          .prepare(
            `SELECT * FROM memory_items
             WHERE scope = 'global' OR scope_id = ?
             ORDER BY status = 'confirmed' DESC, updated_at DESC
             LIMIT 500`
          )
          .all(scopeId)
      : this.requireDatabase()
          .prepare(
            `SELECT * FROM memory_items
             ORDER BY status = 'confirmed' DESC, updated_at DESC
             LIMIT 500`
          )
          .all()
    return (rows as MemoryRow[]).map(toMemory)
  }

  createMemory(input: MemoryCreateInput): AssistantMemory {
    if (input.scope !== 'global' && !input.scopeId) {
      throw new Error('项目或会话记忆必须指定作用域')
    }
    const id = randomUUID()
    const now = new Date().toISOString()
    this.requireDatabase()
      .prepare(
        `INSERT INTO memory_items
          (id, scope, scope_id, type, content, source_conversation_id,
           source_message_id, confidence, salience, status, expires_at,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, 1, 'confirmed', NULL, ?, ?)`
      )
      .run(
        id,
        input.scope,
        input.scopeId ?? null,
        input.type,
        input.content,
        now,
        now
      )
    return this.getMemory(id)
  }

  setMemoryStatus(
    memoryId: string,
    status: AssistantMemory['status']
  ): void {
    const result = this.requireDatabase()
      .prepare(
        `UPDATE memory_items
         SET status = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(status, new Date().toISOString(), memoryId)
    if (result.changes !== 1) {
      throw new Error('记忆不存在')
    }
  }

  removeMemory(memoryId: string): void {
    const result = this.requireDatabase()
      .prepare('DELETE FROM memory_items WHERE id = ?')
      .run(memoryId)
    if (result.changes !== 1) {
      throw new Error('记忆不存在')
    }
  }

  listSchedules(projectId?: string): AssistantSchedule[] {
    const rows = projectId
      ? this.requireDatabase()
          .prepare(
            `SELECT * FROM schedules
             WHERE project_id = ?
             ORDER BY next_run_at`
          )
          .all(projectId)
      : this.requireDatabase()
          .prepare('SELECT * FROM schedules ORDER BY next_run_at')
          .all()
    return (rows as ScheduleRow[]).map(toSchedule)
  }

  createSchedule(input: ScheduleCreateInput): AssistantSchedule {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.requireDatabase()
      .prepare(
        `INSERT INTO schedules
          (id, project_id, task_template_json, timezone, recurrence_json,
           next_run_at, missed_run_policy, enabled, last_run_at,
           created_at, updated_at)
         VALUES (?, ?, ?, 'UTC', ?, ?, 'run_once', 1, NULL, ?, ?)`
      )
      .run(
        id,
        input.projectId ?? null,
        JSON.stringify({
          title: input.title,
          prompt: input.prompt,
          workMode: input.workMode
        }),
        JSON.stringify({ type: input.recurrence }),
        input.nextRunAt,
        now,
        now
      )
    return this.getSchedule(id)
  }

  setScheduleEnabled(scheduleId: string, enabled: boolean): void {
    const result = this.requireDatabase()
      .prepare(
        `UPDATE schedules
         SET enabled = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(enabled ? 1 : 0, new Date().toISOString(), scheduleId)
    if (result.changes !== 1) {
      throw new Error('定时任务不存在')
    }
  }

  removeSchedule(scheduleId: string): void {
    const result = this.requireDatabase()
      .prepare('DELETE FROM schedules WHERE id = ?')
      .run(scheduleId)
    if (result.changes !== 1) {
      throw new Error('定时任务不存在')
    }
  }

  claimDueSchedules(now = new Date()): AssistantSchedule[] {
    const database = this.requireDatabase()
    const due = (
      database
        .prepare(
          `SELECT * FROM schedules
           WHERE enabled = 1 AND next_run_at <= ?
           ORDER BY next_run_at
           LIMIT 20`
        )
        .all(now.toISOString()) as ScheduleRow[]
    ).map(toSchedule)
    for (const schedule of due) {
      const next = new Date(schedule.nextRunAt)
      if (schedule.recurrence === 'daily') {
        const intervals =
          Math.floor(
            (now.getTime() - next.getTime()) / (24 * 60 * 60 * 1_000)
          ) + 1
        next.setUTCDate(next.getUTCDate() + intervals)
      } else if (schedule.recurrence === 'weekly') {
        const intervals =
          Math.floor(
            (now.getTime() - next.getTime()) /
              (7 * 24 * 60 * 60 * 1_000)
          ) + 1
        next.setUTCDate(next.getUTCDate() + intervals * 7)
      }
      database
        .prepare(
          `UPDATE schedules
           SET enabled = ?, next_run_at = ?, last_run_at = ?, updated_at = ?
           WHERE id = ? AND next_run_at = ?`
        )
        .run(
          schedule.recurrence === 'once' ? 0 : 1,
          schedule.recurrence === 'once'
            ? schedule.nextRunAt
            : next.toISOString(),
          now.toISOString(),
          now.toISOString(),
          schedule.id,
          schedule.nextRunAt
        )
    }
    return due
  }

  claimScheduleNow(scheduleId: string): AssistantSchedule {
    const schedule = this.getSchedule(scheduleId)
    const now = new Date()
    this.requireDatabase()
      .prepare(
        `UPDATE schedules
         SET last_run_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(now.toISOString(), now.toISOString(), scheduleId)
    return schedule
  }

  listExperts(): AssistantExpert[] {
    return (
      this.requireDatabase()
        .prepare(
          `SELECT * FROM experts
           WHERE enabled = 1
           ORDER BY name`
        )
        .all() as ExpertRow[]
    ).map(toExpert)
  }

  createExpert(input: ExpertCreateInput): AssistantExpert {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.requireDatabase()
      .prepare(
        `INSERT INTO experts
          (id, name, description, system_instructions,
           capability_policy_json, model_policy_json, enabled,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, '{}', '{}', 1, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.description,
        input.systemInstructions,
        now,
        now
      )
    return this.getExpert(id)
  }

  getExpert(expertId: string): AssistantExpert {
    const row = this.requireDatabase()
      .prepare('SELECT * FROM experts WHERE id = ? AND enabled = 1')
      .get(expertId) as ExpertRow | undefined
    if (!row) {
      throw new Error('专家不存在或已停用')
    }
    return toExpert(row)
  }

  getProject(projectId: string): AssistantProject {
    const row = this.requireDatabase()
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(projectId) as ProjectRow | undefined
    if (!row) {
      throw new Error('项目不存在')
    }
    return toProject(row)
  }

  private getTask(taskId: string): AssistantTask {
    const row = this.requireDatabase()
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .get(taskId) as TaskRow | undefined
    if (!row) {
      throw new Error('任务不存在')
    }
    return toTask(row)
  }

  private getMemory(memoryId: string): AssistantMemory {
    const row = this.requireDatabase()
      .prepare('SELECT * FROM memory_items WHERE id = ?')
      .get(memoryId) as MemoryRow | undefined
    if (!row) {
      throw new Error('记忆不存在')
    }
    return toMemory(row)
  }

  private getSchedule(scheduleId: string): AssistantSchedule {
    const row = this.requireDatabase()
      .prepare('SELECT * FROM schedules WHERE id = ?')
      .get(scheduleId) as ScheduleRow | undefined
    if (!row) {
      throw new Error('定时任务不存在')
    }
    return toSchedule(row)
  }

  private migrate(database: DatabaseSync): void {
    const version = database
      .prepare('PRAGMA user_version')
      .get() as { user_version: number }
    if (version.user_version >= 2) {
      return
    }
    if (version.user_version < 1) {
      database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        root_path TEXT NOT NULL DEFAULT '',
        default_work_mode TEXT NOT NULL
          CHECK(default_work_mode IN ('ask', 'plan', 'execute')),
        status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        work_mode TEXT NOT NULL DEFAULT 'ask'
          CHECK(work_mode IN ('ask', 'plan', 'execute')),
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active', 'archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL
          REFERENCES conversations(id) ON DELETE CASCADE,
        request_id TEXT,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
        content TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('streaming', 'complete', 'error')),
        sequence INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE(conversation_id, sequence)
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        conversation_id TEXT,
        schedule_id TEXT,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL,
        origin TEXT NOT NULL
          CHECK(origin IN ('user', 'assistant', 'schedule', 'delegation', 'subagent')),
        status TEXT NOT NULL
          CHECK(status IN ('queued', 'running', 'waiting_approval', 'paused',
            'completed', 'failed', 'cancelled', 'interrupted')),
        priority INTEGER NOT NULL DEFAULT 0,
        work_mode TEXT NOT NULL DEFAULT 'execute'
          CHECK(work_mode IN ('ask', 'plan', 'execute')),
        progress REAL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        error TEXT
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        parent_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL
          CHECK(kind IN ('interactive', 'background', 'scheduled', 'delegated', 'subagent')),
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        execution_snapshot_json TEXT NOT NULL,
        checkpoint_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        error TEXT
      );
      CREATE TABLE task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX task_events_task_idx ON task_events(task_id, id);
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        storage_kind TEXT NOT NULL
          CHECK(storage_kind IN ('inline', 'managed_file', 'reference')),
        storage_path TEXT,
        inline_content TEXT,
        checksum TEXT,
        byte_size INTEGER NOT NULL,
        preview_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE memory_items (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('global', 'project', 'conversation')),
        scope_id TEXT,
        type TEXT NOT NULL CHECK(type IN ('preference', 'fact', 'summary', 'procedure')),
        content TEXT NOT NULL,
        source_conversation_id TEXT,
        source_message_id TEXT,
        confidence REAL NOT NULL,
        salience REAL NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('proposed', 'confirmed', 'rejected')),
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        task_template_json TEXT NOT NULL,
        timezone TEXT NOT NULL,
        recurrence_json TEXT NOT NULL,
        next_run_at TEXT NOT NULL,
        missed_run_policy TEXT NOT NULL
          CHECK(missed_run_policy IN ('skip', 'run_once', 'catch_up')),
        enabled INTEGER NOT NULL,
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE schedule_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        scheduled_for TEXT NOT NULL,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        UNIQUE(schedule_id, scheduled_for)
      );
      CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        schedule_id TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'shown', 'dismissed', 'opened')),
        created_at TEXT NOT NULL,
        shown_at TEXT
      );
      CREATE TABLE experts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        system_instructions TEXT NOT NULL,
        capability_policy_json TEXT NOT NULL,
        model_policy_json TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE delegations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        endpoint_id TEXT NOT NULL,
        remote_job_id TEXT,
        status TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
      COMMIT;
    `)
    }
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS delegation_outbox (
        task_id TEXT PRIMARY KEY,
        result_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'delivered')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS delegation_outbox_status_idx
        ON delegation_outbox(status, updated_at);
      PRAGMA user_version = 2;
      COMMIT;
    `)
  }

  private requireDatabase(): DatabaseSync {
    if (!this.database) {
      throw new Error('助手数据库尚未初始化')
    }
    return this.database
  }
}
