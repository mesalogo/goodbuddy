import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  expertCreateSchema,
  normalizeInteractiveWorkMode
} from '../../shared/assistant-contracts'
import type {
  AssistantArtifact,
  AssistantExpert,
  AssistantHeartbeatConfig,
  AssistantHeartbeatEntry,
  AssistantHeartbeatRun,
  AssistantMemory,
  AssistantProject,
  AssistantSchedule,
  AssistantTask,
  ConversationSnapshot,
  ExpertCreateInput,
  ExpertUpdateInput,
  HeartbeatCreateInput,
  HeartbeatSummaryOutput,
  HeartbeatUpdateInput,
  LegacyWorkMode,
  MemoryCreateInput,
  ModelUsageCallInput,
  ProjectChannel,
  ProjectCreateInput,
  ScheduleCreateInput,
  TokenUsageRecord,
  TokenUsageSummary
} from '../../shared/assistant-contracts'
import {
  computerControlErrorCodeSchema,
  computerControlRiskSchema,
  type ComputerControlErrorCode,
  type ComputerControlRisk
} from '../../shared/computer-control-contracts'
import {
  channelResultMessageSchema,
  type ChannelResultMessage
} from '../../shared/channel-contracts'
import {
  agentRuntimeSelectionKey,
  agentRuntimeSelectionSchema,
  repairAgentRuntimeSelection,
  repairChannelRuntimeSelection,
  type AgentRuntimeSelection,
  type RuntimeSelectionRepairSettings
} from '../../shared/runtime-selection-contracts'
import {
  MAGIC_NOTE_MAX_NOTE_EMBED_BYTES,
  type MagicNoteComment,
  type MagicNoteDetail,
  type MagicNoteEntry,
  type MagicNoteRichContent,
  type MagicNoteSearchResult,
  type MagicNoteSummary,
  type MagicTodoItem,
  type MagicTodoUpdateInput
} from '../../shared/magic-notes-contracts'
import type { ComputerControlAuditEvent } from '../computer-control/audit'
import {
  magicNoteChecklistItems,
  magicNoteEmbeddedBytes,
  magicNoteImageBytes,
  magicNotePlainText,
  magicNotePreview,
  setMagicNoteChecklistCompletion
} from '../magic-notes/rich-content'
import { computeNextHeartbeatRun } from './heartbeat-recurrence'

type ProjectRow = {
  id: string
  name: string
  description: string
  root_path: string
  default_work_mode: LegacyWorkMode
  runtime_selection_json: string | null
  kind: AssistantProject['kind']
  channel: ProjectChannel | null
  status: AssistantProject['status']
  created_at: string
  updated_at: string
}

type TaskRow = {
  id: string
  project_id: string | null
  conversation_id: string | null
  parent_task_id: string | null
  expert_id: string | null
  routing_mode: AssistantTask['routingMode'] | null
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
  runtime_selection_json: string | null
  knowledge_retrieval_mode: 'auto' | 'always' | null
  title: string
  channel: ProjectChannel | null
  external_account_id: string | null
  external_conversation_id: string | null
  conversation_type: 'direct' | 'group' | null
  account_display: string | null
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

type MagicNoteRow = {
  id: string
  project_id: string | null
  title: string
  pinned: number
  revision: number
  created_at: string
  updated_at: string
  entry_count: number
  latest_plain_text: string | null
}

type MagicNoteEntryRow = {
  id: string
  note_id: string
  content_json: string
  plain_text: string
  comments_json: string
  analyzed_at: string | null
  revision: number
  created_at: string
  updated_at: string
}

type MagicTodoRow = {
  id: string
  project_id: string | null
  note_id: string | null
  entry_id: string | null
  note_title: string | null
  source_index: number | null
  source: MagicTodoItem['source']
  title: string
  instructions: string
  completed: number
  comments_json: string
  analyzed_at: string | null
  revision: number
  created_at: string
  updated_at: string
}

type MessageMetadata = {
  createdAt?: number
  status?: string
  reasoning?: ConversationSnapshot['messages'][number]['reasoning']
  blocks?: ConversationSnapshot['messages'][number]['blocks']
  tools?: ConversationSnapshot['messages'][number]['tools']
  sources?: string[]
  sourceReferences?: ConversationSnapshot['messages'][number]['sourceReferences']
  knowledgeRetrieval?: ConversationSnapshot['messages'][number]['knowledgeRetrieval']
  artifactIds?: string[]
  attachments?: ConversationSnapshot['messages'][number]['attachments']
}

const MAX_CHANNEL_OUTBOX_RETRY_BYTES = 20 * 1024 * 1024
const MAX_CHANNEL_OUTBOX_MEDIA_ENTRIES = 8

function parseRuntimeSelection(value: string | null):
  | ConversationSnapshot['runtimeSelection']
  | undefined {
  if (!value) {
    return undefined
  }
  try {
    const parsed = agentRuntimeSelectionSchema.safeParse(
      JSON.parse(value)
    )
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
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
  capability_policy_json: string
  model_policy_json: string
  enabled: number
  created_at: string
  updated_at: string
}

type HeartbeatConfigRow = {
  id: string
  project_id: string | null
  name: string
  timezone: string
  recurrence_json: string
  lookback_hours: number
  retention_days: number
  enabled: number
  next_run_at: string
  last_run_at: string | null
  last_status: AssistantHeartbeatRun['status'] | null
  created_at: string
  updated_at: string
}

type HeartbeatRunRow = {
  id: string
  config_id: string
  trigger: AssistantHeartbeatRun['trigger']
  scheduled_for: string
  idempotency_key: string
  status: AssistantHeartbeatRun['status']
  attempt_count: number
  next_attempt_at: string | null
  lease_owner: string | null
  lease_expires_at: string | null
  started_at: string | null
  completed_at: string | null
  error: string | null
  entry_id: string | null
  created_at: string
  updated_at: string
}

type HeartbeatEntryRow = {
  id: string
  config_id: string
  run_id: string
  scheduled_for: string
  summary: string
  highlights_json: string
  artifact_id: string | null
  proposed_memory_ids_json: string
  follow_up_task_ids_json: string
  created_at: string
}

type TokenUsageRecordRow = {
  request_id: string
  project_id: string | null
  project_name: string | null
  conversation_id: string | null
  conversation_title: string | null
  runtime: string
  provider: string
  model: string
  call_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
}

type ComputerControlActionRow = {
  command_id: string
  task_id: string
  conversation_id: string
  lease_id: string
  action: ComputerControlAuditEvent['action']
  risk: ComputerControlRisk
  outcome: ComputerControlAuditEvent['outcome']
  error_code: ComputerControlErrorCode | null
  occurred_at: number
  text_length: number | null
  text_digest: string | null
}

export type PersistedComputerControlAuditEvent =
  ComputerControlAuditEvent

export type ClaimedHeartbeatRun = {
  config: AssistantHeartbeatConfig
  run: AssistantHeartbeatRun
  leaseOwner: string
  acquired: boolean
}

export type HeartbeatInputSnapshot = {
  conversations: Array<{
    id: string
    title: string
    updatedAt: string
    messages: Array<{
      role: 'user' | 'assistant'
      content: string
      createdAt: string
    }>
  }>
  tasks: Array<{
    id: string
    title: string
    status: AssistantTask['status']
    createdAt: string
    completedAt?: string
  }>
  confirmedMemories: Array<{
    id: string
    type: AssistantMemory['type']
    content: string
    scope: AssistantMemory['scope']
  }>
}

function toProject(row: ProjectRow): AssistantProject {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rootPath: row.root_path,
    defaultWorkMode: normalizeInteractiveWorkMode(
      row.default_work_mode
    ),
    runtimeSelection:
      row.kind === 'channel'
        ? parseRuntimeSelection(row.runtime_selection_json) ?? {
            provider: 'auto'
          }
        : parseRuntimeSelection(row.runtime_selection_json),
    kind: row.kind,
    channel: row.channel ?? undefined,
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
    parentTaskId: row.parent_task_id ?? undefined,
    expertId: row.expert_id ?? undefined,
    routingMode: row.routing_mode ?? undefined,
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

function toMagicNoteEntry(row: MagicNoteEntryRow): MagicNoteEntry {
  return {
    id: row.id,
    noteId: row.note_id,
    content: JSON.parse(row.content_json) as MagicNoteRichContent,
    plainText: row.plain_text,
    comments: JSON.parse(row.comments_json) as MagicNoteComment[],
    analyzedAt: row.analyzed_at ?? undefined,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toMagicTodo(row: MagicTodoRow): MagicTodoItem {
  if (
    row.source !== 'note' ||
    !row.note_id ||
    !row.entry_id ||
    row.source_index === null ||
    !row.note_title
  ) {
    throw new Error('待办来源数据无效')
  }
  return {
    id: row.id,
    noteId: row.note_id,
    entryId: row.entry_id,
    noteTitle: row.note_title,
    sourceIndex: row.source_index,
    source: 'note',
    title: row.title,
    instructions: row.instructions,
    completed: row.completed === 1,
    comments: JSON.parse(row.comments_json) as MagicNoteComment[],
    analyzedAt: row.analyzed_at ?? undefined,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toMagicNoteSummary(row: MagicNoteRow): MagicNoteSummary {
  return {
    id: row.id,
    title: row.title,
    preview: magicNotePreview(row.latest_plain_text ?? ''),
    entryCount: row.entry_count,
    pinned: row.pinned === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
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
    workMode: LegacyWorkMode
  }
  const recurrence = JSON.parse(row.recurrence_json) as {
    type: AssistantSchedule['recurrence']
  }
  return {
    id: row.id,
    projectId: row.project_id ?? undefined,
    title: template.title,
    prompt: template.prompt,
    workMode: 'ask',
    recurrence: recurrence.type,
    nextRunAt: row.next_run_at,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toExpert(row: ExpertRow): AssistantExpert {
  let routingKeywords: string[]
  let modelProfileId: string | undefined
  try {
    const policy = JSON.parse(row.capability_policy_json) as {
      routingKeywords?: unknown
    }
    routingKeywords = expertCreateSchema.parse({
      name: row.name,
      description: row.description,
      systemInstructions: row.system_instructions,
      routingKeywords: Array.isArray(policy.routingKeywords)
        ? policy.routingKeywords
        : []
    }).routingKeywords
  } catch {
    routingKeywords = []
  }
  try {
    const policy = JSON.parse(row.model_policy_json) as {
      modelProfileId?: unknown
    }
    modelProfileId = expertCreateSchema
      .pick({ modelProfileId: true })
      .parse({
        modelProfileId: policy.modelProfileId
      }).modelProfileId
  } catch {
    modelProfileId = undefined
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    systemInstructions: row.system_instructions,
    ...(modelProfileId ? { modelProfileId } : {}),
    routingKeywords,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toHeartbeatConfig(
  row: HeartbeatConfigRow
): AssistantHeartbeatConfig {
  return {
    id: row.id,
    projectId: row.project_id ?? undefined,
    name: row.name,
    timezone: row.timezone,
    recurrence: JSON.parse(
      row.recurrence_json
    ) as AssistantHeartbeatConfig['recurrence'],
    enabled: row.enabled === 1,
    lookbackHours: row.lookback_hours,
    retentionDays: row.retention_days,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at ?? undefined,
    lastStatus: row.last_status ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toHeartbeatRun(row: HeartbeatRunRow): AssistantHeartbeatRun {
  return {
    id: row.id,
    configId: row.config_id,
    trigger: row.trigger,
    scheduledFor: row.scheduled_for,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at ?? undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    error: row.error ?? undefined,
    entryId: row.entry_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toHeartbeatEntry(
  row: HeartbeatEntryRow
): AssistantHeartbeatEntry {
  return {
    id: row.id,
    configId: row.config_id,
    runId: row.run_id,
    scheduledFor: row.scheduled_for,
    summary: row.summary,
    highlights: JSON.parse(row.highlights_json) as string[],
    artifactId: row.artifact_id ?? undefined,
    proposedMemoryIds: JSON.parse(
      row.proposed_memory_ids_json
    ) as string[],
    followUpTaskIds: JSON.parse(
      row.follow_up_task_ids_json
    ) as string[],
    createdAt: row.created_at
  }
}

function validateUsageText(
  value: string,
  label: string,
  maximumLength: number
): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`)
  }
  const normalized = value.trim()
  if (
    normalized.length === 0 ||
    normalized.length > maximumLength
  ) {
    throw new RangeError(
      `${label} must contain between 1 and ${maximumLength} characters`
    )
  }
  return normalized
}

function validateTokenCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `${label} must be a nonnegative safe integer`
    )
  }
  return value
}

const computerControlActions = [
  'observe',
  'activate',
  'replace_text',
  'select_option',
  'scroll'
] as const
const computerControlOutcomes = [
  'completed',
  'denied',
  'failed',
  'outcome_unknown'
] as const
function validateComputerControlId(
  value: string,
  label: string,
  maximumLength: number,
  opaque = false
): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`)
  }
  if (
    value.length < (opaque ? 16 : 1) ||
    value.length > maximumLength ||
    (opaque
      ? !/^[A-Za-z0-9_-]+$/.test(value)
      : [...value].some((character) => {
          const code = character.charCodeAt(0)
          return code <= 31 || code === 127
        }))
  ) {
    throw new RangeError(`Invalid ${label}`)
  }
  return value
}

function validateComputerControlEnum<T extends string>(
  value: string,
  label: string,
  allowed: readonly T[]
): T {
  if (!allowed.includes(value as T)) {
    throw new RangeError(`Invalid ${label}`)
  }
  return value as T
}

function toComputerControlAuditEvent(
  row: ComputerControlActionRow
): PersistedComputerControlAuditEvent {
  return {
    timestamp: row.occurred_at,
    taskId: row.task_id,
    conversationId: row.conversation_id,
    leaseId: row.lease_id,
    commandId: row.command_id,
    action: row.action,
    risk: row.risk,
    outcome: row.outcome,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.text_length === null
      ? {}
      : { textLength: row.text_length }),
    ...(row.text_digest === null
      ? {}
      : { textDigest: row.text_digest })
  }
}

const interruptedTaskError = '应用退出时任务仍在运行'
const interruptedMessageStatus = '上次运行意外中断，可以重新发送问题'

function interruptActiveTools(
  tools: MessageMetadata['tools']
): MessageMetadata['tools'] {
  return tools?.map((tool) =>
    tool.state === 'pending' || tool.state === 'running'
      ? { ...tool, state: 'interrupted' as const }
      : tool
  )
}

function interruptActiveToolBlocks(
  blocks: MessageMetadata['blocks']
): MessageMetadata['blocks'] {
  return blocks?.map((block) =>
    block.type === 'tool' &&
    (block.tool.state === 'pending' || block.tool.state === 'running')
      ? {
          ...block,
          tool: { ...block.tool, state: 'interrupted' as const }
        }
      : block
  )
}

export class AssistantDatabase {
  private database?: DatabaseSync
  private channelEventWrites = 0
  private channelOutboxWrites = 0

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
      this.channelEventWrites = (
        database
          .prepare('SELECT COUNT(*) AS count FROM channel_events')
          .get() as { count: number }
      ).count % 128
      this.channelOutboxWrites = (
        database
          .prepare('SELECT COUNT(*) AS count FROM channel_outbox')
          .get() as { count: number }
      ).count % 128
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
            'Act as a rigorous research analyst. Separate evidence, assumptions, and conclusions. Cite provided sources and identify uncertainty.',
          routingKeywords: [
            '研究',
            '调研',
            '分析证据',
            '资料分析',
            'research',
            'evidence',
            'investigate'
          ]
        })
        this.createExpert({
          name: '文档写作专家',
          description: '负责结构化写作、编辑和内容润色',
          systemInstructions:
            'Act as a professional document editor. Produce clear structure, concise language, and actionable content appropriate to the user context.',
          routingKeywords: [
            '写作',
            '撰写',
            '润色',
            '文档',
            'write',
            'draft',
            'edit'
          ]
        })
        this.createExpert({
          name: '项目规划专家',
          description: '负责目标拆解、风险分析和执行计划',
          systemInstructions:
            'Act as a project planning specialist. Decompose goals into verifiable steps, dependencies, risks, owners, and acceptance criteria.',
          routingKeywords: [
            '规划',
            '计划',
            '拆解',
            '里程碑',
            'plan',
            'roadmap',
            'milestone'
          ]
        })
      }
      const recoveredAt = new Date().toISOString()
      database.exec('BEGIN IMMEDIATE')
      try {
        const interruptedTasks = database
          .prepare(
            `SELECT id, error
             FROM tasks
             WHERE status IN ('running', 'waiting_approval')`
          )
          .all() as Array<{ id: string; error: string | null }>
        const updateTask = database.prepare(
          `UPDATE tasks
           SET status = 'interrupted', completed_at = ?, error = ?
           WHERE id = ?`
        )
        const insertTaskEvent = database.prepare(
          `INSERT INTO task_events
            (task_id, run_id, kind, payload_json, created_at)
           VALUES (?, NULL, 'status', ?, ?)`
        )
        for (const task of interruptedTasks) {
          const error = task.error ?? interruptedTaskError
          updateTask.run(recoveredAt, error, task.id)
          insertTaskEvent.run(
            task.id,
            JSON.stringify({ status: 'interrupted', error }),
            recoveredAt
          )
        }

        const recoverableMessages = database
          .prepare(
            `SELECT id, state, metadata_json
             FROM messages`
          )
          .all() as Array<{
          id: string
          state: MessageRow['state']
          metadata_json: string
        }>
        const updateMessage = database.prepare(
          `UPDATE messages
           SET state = ?, metadata_json = ?
           WHERE id = ?`
        )
        for (const message of recoverableMessages) {
          const metadata = JSON.parse(
            message.metadata_json
          ) as MessageMetadata
          const hasActiveTool = Boolean(
            metadata.tools?.some(
              (tool) =>
                tool.state === 'pending' || tool.state === 'running'
            ) ||
              metadata.blocks?.some(
                (block) =>
                  block.type === 'tool' &&
                  (block.tool.state === 'pending' ||
                    block.tool.state === 'running')
              )
          )
          if (message.state !== 'streaming' && !hasActiveTool) {
            continue
          }
          updateMessage.run(
            message.state === 'streaming' ? 'error' : message.state,
            JSON.stringify({
              ...metadata,
              status:
                message.state === 'streaming'
                  ? interruptedMessageStatus
                  : metadata.status,
              tools: interruptActiveTools(metadata.tools),
              blocks: interruptActiveToolBlocks(metadata.blocks)
            }),
            message.id
          )
        }
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    } catch (error) {
      database.close()
      throw error
    }
  }

  close(): void {
    this.database?.close()
    this.database = undefined
  }

  clearAssistantData(): void {
    const database = this.requireDatabase()
    database.exec('BEGIN IMMEDIATE')
    try {
      for (const table of [
        'magic_todos',
        'magic_note_entries',
        'magic_notes',
        'heartbeat_configs',
        'delegation_outbox',
        'delegations',
        'notifications',
        'schedule_runs',
        'schedules',
        'memory_items',
        'artifacts',
        'computer_control_actions',
        'task_events',
        'runs',
        'model_usage_calls',
        'channel_outbox',
        'channel_events',
        'tasks',
        'messages',
        'conversations'
      ]) {
        database.exec(`DELETE FROM ${table}`)
      }
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  listProjects(includeArchived = false): AssistantProject[] {
    const database = this.requireDatabase()
    const rows = database
      .prepare(
        includeArchived
          ? `SELECT * FROM projects
             ORDER BY created_at ASC, rowid ASC`
          : `SELECT * FROM projects
             WHERE status = 'active'
             ORDER BY created_at ASC, rowid ASC`
      )
      .all() as ProjectRow[]
    return rows.map(toProject)
  }

  ensureChannelProjects(
    defaultRootPath: string,
    defaultModelProfileId: string
  ): AssistantProject[] {
    const database = this.requireDatabase()
    const definitions: ReadonlyArray<{
      channel: ProjectChannel
      name: string
      description: string
    }> = [
      {
        channel: 'weixin',
        name: '微信 ClawBot',
        description: '个人微信远程消息与受控任务'
      },
      {
        channel: 'wecom',
        name: '企业微信',
        description: '企业微信远程消息与受控任务'
      },
      {
        channel: 'dingtalk',
        name: '钉钉',
        description: '钉钉远程消息与受控任务'
      }
    ]
    const find = database.prepare(
      'SELECT * FROM projects WHERE channel = ?'
    )
    const insert = database.prepare(
      `INSERT INTO projects
        (id, name, description, root_path, default_work_mode,
         runtime_selection_json, kind, channel, status, created_at,
         updated_at)
       VALUES (?, ?, ?, ?, 'ask', ?, 'channel', ?, 'active', ?, ?)`
    )

    database.exec('BEGIN IMMEDIATE')
    try {
      for (const definition of definitions) {
        if (find.get(definition.channel)) {
          continue
        }
        const now = new Date().toISOString()
        insert.run(
          randomUUID(),
          definition.name,
          definition.description,
          defaultRootPath,
          JSON.stringify({
            provider: 'model',
            profileId: defaultModelProfileId
          }),
          definition.channel,
          now,
          now
        )
      }
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }

    return definitions.map((definition) => {
      const row = find.get(definition.channel) as ProjectRow | undefined
      if (!row) {
        throw new Error(`未能创建${definition.name}通道项目`)
      }
      return toProject(row)
    })
  }

  createProject(input: ProjectCreateInput): AssistantProject {
    const database = this.requireDatabase()
    const id = randomUUID()
    const now = new Date().toISOString()
    database
      .prepare(
        `INSERT INTO projects
          (id, name, description, root_path, default_work_mode,
           runtime_selection_json, kind, channel, status, created_at,
           updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'user', NULL, 'active', ?, ?)`
      )
      .run(
        id,
        input.name,
        input.description,
        input.rootPath,
        input.defaultWorkMode,
        input.runtimeSelection
          ? JSON.stringify(input.runtimeSelection)
          : null,
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
    const current = this.getProject(projectId)
    if (
      current.kind === 'channel' &&
      input.rootPath.trim().length === 0
    ) {
      throw new Error('通道项目必须设置默认工作目录')
    }
    const result = database
      .prepare(
        `UPDATE projects
         SET name = ?, description = ?, root_path = ?,
             default_work_mode = ?, runtime_selection_json = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        current.kind === 'channel' ? current.name : input.name,
        input.description,
        input.rootPath,
        input.defaultWorkMode,
        input.runtimeSelection || current.runtimeSelection
          ? JSON.stringify(
              input.runtimeSelection ?? current.runtimeSelection
            )
          : null,
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
    if (this.getProject(projectId).kind === 'channel') {
      throw new Error('系统通道项目不能归档')
    }
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

  deleteProject(projectId: string, confirmation: string): void {
    const database = this.requireDatabase()
    database.exec('BEGIN IMMEDIATE')
    try {
      const project = database
        .prepare('SELECT name, kind, status FROM projects WHERE id = ?')
        .get(projectId) as
        | {
            name: string
            kind: AssistantProject['kind']
            status: AssistantProject['status']
          }
        | undefined
      if (!project) {
        throw new Error('项目不存在')
      }
      if (project.kind === 'channel') {
        throw new Error('系统通道项目不能删除')
      }
      if (confirmation !== project.name) {
        throw new Error('项目名称确认不匹配')
      }
      const activeProjectCount = database
        .prepare(
          `SELECT COUNT(*) AS count FROM projects
           WHERE kind = 'user' AND status = 'active'`
        )
        .get() as { count: number }
      if (project.status === 'active' && activeProjectCount.count <= 1) {
        throw new Error('至少需要保留一个可用项目')
      }
      const activeTaskCount = database
        .prepare(
          `SELECT COUNT(*) AS count FROM tasks
           WHERE project_id = ?
             AND visible = 1
             AND status IN ('queued', 'running', 'waiting_approval', 'paused')`
        )
        .get(projectId) as { count: number }
      if (activeTaskCount.count > 0) {
        throw new Error('项目仍有进行中的任务，请先停止任务')
      }

      database
        .prepare(
          `DELETE FROM notifications
           WHERE task_id IN (
             SELECT id FROM tasks WHERE project_id = ?
           ) OR schedule_id IN (
             SELECT id FROM schedules WHERE project_id = ?
           )`
        )
        .run(projectId, projectId)
      database
        .prepare(
          `DELETE FROM delegation_outbox
           WHERE task_id IN (
             SELECT id FROM tasks WHERE project_id = ?
           )`
        )
        .run(projectId)
      database
        .prepare(
          `DELETE FROM memory_items
           WHERE (scope = 'project' AND scope_id = ?)
              OR (scope = 'conversation' AND scope_id IN (
                SELECT id FROM conversations WHERE project_id = ?
              ))`
        )
        .run(projectId, projectId)
      database
        .prepare('DELETE FROM heartbeat_configs WHERE project_id = ?')
        .run(projectId)
      database
        .prepare('DELETE FROM artifacts WHERE project_id = ?')
        .run(projectId)
      database
        .prepare('DELETE FROM tasks WHERE project_id = ?')
        .run(projectId)
      database
        .prepare('DELETE FROM conversations WHERE project_id = ?')
        .run(projectId)
      database
        .prepare('DELETE FROM schedules WHERE project_id = ?')
        .run(projectId)
      const result = database
        .prepare('DELETE FROM projects WHERE id = ?')
        .run(projectId)
      if (result.changes !== 1) {
        throw new Error('项目不存在')
      }
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  listConversations(): ConversationSnapshot[] {
    const database = this.requireDatabase()
    const conversations = database
      .prepare(
        `SELECT id, project_id, runtime_selection_json,
                knowledge_retrieval_mode, title, channel,
                external_account_id, external_conversation_id,
                conversation_type, account_display, updated_at
         FROM conversations
         WHERE status = 'active'
         ORDER BY updated_at DESC
         LIMIT 100`
      )
      .all() as ConversationRow[]
    const messageStatement = database.prepare(
      `SELECT id, conversation_id, role, content, state, metadata_json,
              created_at
       FROM (
         SELECT id, conversation_id, role, content, state, metadata_json,
                created_at, sequence
         FROM messages
         WHERE conversation_id = ?
         ORDER BY sequence DESC
         LIMIT 500
       )
       ORDER BY sequence ASC`
    )
    return conversations.map((conversation) => ({
      id: conversation.id,
      projectId: conversation.project_id ?? undefined,
      runtimeSelection: parseRuntimeSelection(
        conversation.runtime_selection_json
      ),
      knowledgeRetrievalMode:
        conversation.knowledge_retrieval_mode ?? undefined,
      ...(conversation.channel &&
      conversation.conversation_type &&
      conversation.account_display
        ? {
            remote: {
              channel: conversation.channel,
              accountDisplay: conversation.account_display,
              conversationType: conversation.conversation_type
            }
          }
        : {}),
      title: conversation.title,
      updatedAt: Date.parse(conversation.updated_at),
      messages: (
        messageStatement.all(conversation.id) as MessageRow[]
      ).map((message) => {
        const metadata = JSON.parse(
          message.metadata_json
        ) as MessageMetadata
        const interrupted = message.state === 'streaming'
        return {
          id: message.id,
          role: message.role,
          content: message.content,
          reasoning: metadata.reasoning,
          blocks: interrupted
            ? interruptActiveToolBlocks(metadata.blocks)
            : metadata.blocks,
          createdAt:
            metadata.createdAt ?? Date.parse(message.created_at),
          state: interrupted ? ('error' as const) : message.state,
          status: interrupted
            ? interruptedMessageStatus
            : metadata.status,
          tools: interrupted
            ? interruptActiveTools(metadata.tools)
            : metadata.tools,
          sources: metadata.sources,
          sourceReferences: metadata.sourceReferences,
          knowledgeRetrieval: metadata.knowledgeRetrieval,
          artifactIds: metadata.artifactIds,
          attachments: metadata.attachments
        }
      })
    }))
  }

  getConversation(conversationId: string): ConversationSnapshot {
    const conversation = this.listConversations().find(
      (candidate) => candidate.id === conversationId
    )
    if (!conversation) {
      throw new Error('对话不存在')
    }
    return conversation
  }

  repairConversationRuntimeSelections(
    settings: RuntimeSelectionRepairSettings
  ): number {
    const database = this.requireDatabase()
    const projects = database
      .prepare(
        `SELECT id, runtime_selection_json
         FROM projects
         WHERE kind = 'channel'`
      )
      .all() as Array<{
        id: string
        runtime_selection_json: string | null
      }>
    const conversations = database
      .prepare(
        `SELECT id, runtime_selection_json, channel
         FROM conversations
         WHERE runtime_selection_json IS NOT NULL`
      )
      .all() as Array<{
        id: string
        runtime_selection_json: string
        channel: ProjectChannel | null
      }>
    const update = database.prepare(
      `UPDATE conversations
       SET runtime_selection_json = ?
       WHERE id = ?`
    )
    const updateProject = database.prepare(
      `UPDATE projects
       SET runtime_selection_json = ?, updated_at = ?
       WHERE id = ?`
    )
    let repaired = 0
    database.exec('BEGIN IMMEDIATE')
    try {
      for (const project of projects) {
        const stored = parseRuntimeSelection(
          project.runtime_selection_json
        )
        const current = stored ?? { provider: 'auto' as const }
        const next = repairChannelRuntimeSelection(current, settings)
        if (
          stored &&
          agentRuntimeSelectionKey(next) ===
            agentRuntimeSelectionKey(current)
        ) {
          continue
        }
        updateProject.run(
          JSON.stringify(next),
          new Date().toISOString(),
          project.id
        )
        repaired += 1
      }
      for (const conversation of conversations) {
        const current = parseRuntimeSelection(
          conversation.runtime_selection_json
        )
        if (!current) {
          continue
        }
        const next = conversation.channel
          ? repairChannelRuntimeSelection(current, settings)
          : repairAgentRuntimeSelection(current, settings)
        if (
          agentRuntimeSelectionKey(next) ===
          agentRuntimeSelectionKey(current)
        ) {
          continue
        }
        update.run(JSON.stringify(next), conversation.id)
        repaired += 1
      }
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    return repaired
  }

  replaceConversations(
    conversations: ConversationSnapshot[]
  ): void {
    const database = this.requireDatabase()
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(`
        DELETE FROM messages
        WHERE conversation_id IN (
          SELECT id FROM conversations WHERE channel IS NULL
        );
        DELETE FROM conversations WHERE channel IS NULL;
      `)
      const insertConversation = database.prepare(
        `INSERT INTO conversations
          (id, project_id, runtime_selection_json, knowledge_retrieval_mode,
           work_mode, title, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'ask', ?, 'active', ?, ?)`
      )
      const insertMessage = database.prepare(
        `INSERT INTO messages
          (id, conversation_id, request_id, role, content, state, sequence,
           metadata_json, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`
      )
      for (const conversation of conversations.slice(0, 100)) {
        if (conversation.remote) {
          continue
        }
        const updatedAt = new Date(conversation.updatedAt).toISOString()
        insertConversation.run(
          conversation.id,
          conversation.projectId ?? null,
          conversation.runtimeSelection
            ? JSON.stringify(conversation.runtimeSelection)
            : null,
          conversation.knowledgeRetrievalMode ?? null,
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
              reasoning: message.reasoning,
              blocks: message.blocks,
              tools: message.tools,
              sources: message.sources,
              sourceReferences: message.sourceReferences,
              knowledgeRetrieval: message.knowledgeRetrieval,
              artifactIds: message.artifactIds,
              attachments: message.attachments
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

  getOrCreateRemoteConversation(input: {
    projectId: string
    channel: ProjectChannel
    accountId: string
    externalConversationId: string
    conversationType: 'direct' | 'group'
    title: string
    accountDisplay: string
    runtimeSelection?: AgentRuntimeSelection
  }): ConversationSnapshot {
    const database = this.requireDatabase()
    const existing = database
      .prepare(
        `SELECT id
         FROM conversations
         WHERE channel = ?
           AND external_account_id = ?
           AND external_conversation_id = ?`
      )
      .get(
        input.channel,
        input.accountId,
        input.externalConversationId
      ) as { id: string } | undefined
    if (existing) {
      database
        .prepare(
          `UPDATE conversations
           SET project_id = ?, title = ?, conversation_type = ?,
               account_display = ?,
               runtime_selection_json = COALESCE(?, runtime_selection_json),
               status = 'active', updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.projectId,
          input.title,
          input.conversationType,
          input.accountDisplay,
          input.runtimeSelection
            ? JSON.stringify(input.runtimeSelection)
            : null,
          new Date().toISOString(),
          existing.id
        )
      return this.getConversation(existing.id)
    }

    const id = randomUUID()
    const now = new Date().toISOString()
    database
      .prepare(
        `INSERT INTO conversations
          (id, project_id, runtime_selection_json, work_mode, title, status,
           channel, external_account_id, external_conversation_id,
           conversation_type, account_display, created_at, updated_at)
         VALUES (?, ?, ?, 'ask', ?, 'active', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.projectId,
        input.runtimeSelection
          ? JSON.stringify(input.runtimeSelection)
          : null,
        input.title,
        input.channel,
        input.accountId,
        input.externalConversationId,
        input.conversationType,
        input.accountDisplay,
        now,
        now
      )
    return this.getConversation(id)
  }

  appendRemoteConversationMessage(input: {
    conversationId: string
    role: 'user' | 'assistant'
    content: string
    status?: string
    attachments?: ConversationSnapshot['messages'][number]['attachments']
    artifactIds?: string[]
  }): void {
    const database = this.requireDatabase()
    const now = Date.now()
    const sequence = database
      .prepare(
        `SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence
         FROM messages
         WHERE conversation_id = ?`
      )
      .get(input.conversationId) as { sequence: number }
    database.exec('BEGIN IMMEDIATE')
    try {
      database
        .prepare(
          `INSERT INTO messages
            (id, conversation_id, request_id, role, content, state,
             sequence, metadata_json, created_at)
           VALUES (?, ?, NULL, ?, ?, 'complete', ?, ?, ?)`
        )
        .run(
          randomUUID(),
          input.conversationId,
          input.role,
          input.content,
          sequence.sequence,
          JSON.stringify({
            createdAt: now,
            ...(input.status ? { status: input.status } : {}),
            ...(input.attachments?.length
              ? { attachments: input.attachments }
              : {}),
            ...(input.artifactIds?.length
              ? { artifactIds: input.artifactIds }
              : {})
          }),
          new Date(now).toISOString()
        )
      database
        .prepare(
          'UPDATE conversations SET updated_at = ? WHERE id = ?'
        )
        .run(new Date(now).toISOString(), input.conversationId)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  claimChannelEvent(channel: string, eventId: string): boolean {
    const database = this.requireDatabase()
    const result = database
      .prepare(
        `INSERT OR IGNORE INTO channel_events
          (channel, event_id, claimed_at)
         VALUES (?, ?, ?)`
      )
      .run(channel, eventId, Date.now())
    if (result.changes === 1) {
      this.channelEventWrites += 1
      if (this.channelEventWrites % 128 === 0) {
        database.exec(`
        DELETE FROM channel_events
        WHERE rowid IN (
          SELECT rowid FROM channel_events
          ORDER BY claimed_at ASC, rowid ASC
          LIMIT MAX(
            (SELECT COUNT(*) FROM channel_events) - 10000,
            0
          )
        );
      `)
      }
    }
    return result.changes === 1
  }

  releaseChannelEvent(channel: string, eventId: string): void {
    this.requireDatabase()
      .prepare(
        'DELETE FROM channel_events WHERE channel = ? AND event_id = ?'
      )
      .run(channel, eventId)
  }

  enqueueChannelResult(message: ChannelResultMessage): {
    id: string
    message: ChannelResultMessage
    state: 'pending'
    attempts: number
    createdAt: number
  } {
    const parsed = channelResultMessageSchema.parse(message)
    if (parsed.attachments?.length) {
      const pendingMedia = (
        this.requireDatabase()
          .prepare(
            `SELECT COUNT(*) AS count
             FROM channel_outbox
             WHERE state != 'delivered'
               AND attempts < 5
               AND json_type(message_json, '$.attachments') = 'array'`
          )
          .get() as { count: number }
      ).count
      if (pendingMedia >= MAX_CHANNEL_OUTBOX_MEDIA_ENTRIES) {
        throw new Error('媒体结果等待发送过多，请恢复通道连接后重试')
      }
    }
    const entry = {
      id: randomUUID(),
      message: parsed,
      state: 'pending' as const,
      attempts: 0,
      createdAt: Date.now()
    }
    this.requireDatabase()
      .prepare(
        `INSERT INTO channel_outbox
          (id, channel, event_id, message_json, state, attempts, created_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?)`
      )
      .run(
        entry.id,
        parsed.channel,
        parsed.eventId,
        JSON.stringify(parsed),
        entry.createdAt
      )
    this.channelOutboxWrites += 1
    if (this.channelOutboxWrites % 128 === 0) {
      this.requireDatabase().exec(`
      DELETE FROM channel_outbox
      WHERE rowid IN (
        SELECT rowid FROM channel_outbox
        ORDER BY
          CASE state WHEN 'delivered' THEN 0 ELSE 1 END,
          created_at ASC,
          rowid ASC
        LIMIT MAX(
          (SELECT COUNT(*) FROM channel_outbox) - 10000,
          0
        )
      );
    `)
    }
    return structuredClone(entry)
  }

  markChannelResult(
    id: string,
    state: 'delivered' | 'failed'
  ): void {
    this.requireDatabase()
      .prepare(
        `UPDATE channel_outbox
         SET state = ?,
             attempts = attempts + 1,
             message_json = CASE
               WHEN ? = 'delivered' OR attempts + 1 >= 5
               THEN json_remove(message_json, '$.attachments')
               ELSE message_json
             END
         WHERE id = ?`
      )
      .run(state, state, id)
  }

  listUndeliveredChannelResults(
    channel?: string,
    limit = 100
  ): Array<{
    id: string
    message: ChannelResultMessage
    state: 'pending' | 'failed'
    attempts: number
    createdAt: number
  }> {
    const safeLimit = Math.min(
      Math.max(Number.isSafeInteger(limit) ? limit : 100, 1),
      1_000
    )
    const rows = this.requireDatabase()
      .prepare(
        `WITH pending AS (
           SELECT id, message_json, state, attempts, created_at,
                  ROW_NUMBER() OVER (
                    ORDER BY attempts ASC, created_at ASC
                  ) AS position,
                  SUM(LENGTH(CAST(message_json AS BLOB))) OVER (
                    ORDER BY attempts ASC, created_at ASC
                  ) AS cumulative_bytes
           FROM channel_outbox
           WHERE state != 'delivered'
             AND attempts < 5
             ${channel === undefined ? '' : 'AND channel = ?'}
         )
         SELECT id, message_json, state, attempts, created_at
         FROM pending
         WHERE position = 1 OR cumulative_bytes <= ?
         ORDER BY attempts ASC, created_at ASC
         LIMIT ?`
      )
      .all(
        ...(channel === undefined
          ? [MAX_CHANNEL_OUTBOX_RETRY_BYTES, safeLimit]
          : [
              channel,
              MAX_CHANNEL_OUTBOX_RETRY_BYTES,
              safeLimit
            ])
      ) as Array<{
      id: string
      message_json: string
      state: 'pending' | 'failed'
      attempts: number
      created_at: number
    }>
    return rows.map((row) => ({
      id: row.id,
      message: channelResultMessageSchema.parse(
        JSON.parse(row.message_json)
      ),
      state: row.state,
      attempts: row.attempts,
      createdAt: row.created_at
    }))
  }

  listMagicNotes(): MagicNoteSummary[] {
    const database = this.requireDatabase()
    const rows = database
      .prepare(
        `SELECT n.*,
           (SELECT COUNT(*) FROM magic_note_entries e
            WHERE e.note_id = n.id) AS entry_count,
           (SELECT plain_text FROM magic_note_entries e
            WHERE e.note_id = n.id
            ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1)
             AS latest_plain_text
         FROM magic_notes n
         ORDER BY n.pinned DESC, n.updated_at DESC, n.rowid DESC
         LIMIT 200`
      )
      .all() as MagicNoteRow[]
    return rows.map(toMagicNoteSummary)
  }

  getMagicNote(noteId: string): MagicNoteDetail {
    const database = this.requireDatabase()
    const row = database
      .prepare(
        `SELECT n.*,
           (SELECT COUNT(*) FROM magic_note_entries e
            WHERE e.note_id = n.id) AS entry_count,
           (SELECT plain_text FROM magic_note_entries e
            WHERE e.note_id = n.id
            ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1)
             AS latest_plain_text
         FROM magic_notes n
         WHERE n.id = ?`
      )
      .get(noteId) as MagicNoteRow | undefined
    if (!row) {
      throw new Error('笔记不存在')
    }
    const entryRows = database
      .prepare(
        `SELECT * FROM magic_note_entries
         WHERE note_id = ?
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(noteId) as MagicNoteEntryRow[]
    return {
      ...toMagicNoteSummary(row),
      entries: entryRows.map(toMagicNoteEntry)
    }
  }

  getMagicNoteContext(noteId: string): {
    id: string
    title: string
  } {
    const row = this.requireDatabase()
      .prepare(
        `SELECT id, project_id, title
         FROM magic_notes
         WHERE id = ?`
      )
      .get(noteId) as
      | { id: string; project_id: string | null; title: string }
      | undefined
    if (!row) {
      throw new Error('笔记不存在')
    }
    return {
      id: row.id,
      title: row.title
    }
  }

  createMagicNote(input: {
    title: string
    content?: MagicNoteRichContent
  }): MagicNoteDetail {
    const id = randomUUID()
    const now = new Date().toISOString()
    const database = this.requireDatabase()
    const embeddedBytes = input.content
      ? magicNoteEmbeddedBytes(input.content)
      : 0
    if (embeddedBytes > MAGIC_NOTE_MAX_NOTE_EMBED_BYTES) {
      throw new Error('一篇笔记中的图片、视频和附件总大小不能超过 64 MB')
    }
    database.exec('BEGIN IMMEDIATE')
    try {
      database
        .prepare(
          `INSERT INTO magic_notes
            (id, project_id, title, pinned, revision, created_at, updated_at)
           VALUES (?, ?, ?, 0, ?, ?, ?)`
        )
        .run(id, null, input.title, input.content ? 1 : 0, now, now)
      if (input.content) {
        const entryId = randomUUID()
        database
          .prepare(
            `INSERT INTO magic_note_entries
              (id, note_id, content_json, plain_text, comments_json,
               actions_json, analyzed_at, revision, created_at, updated_at,
               image_bytes)
             VALUES (?, ?, ?, ?, '[]', '[]', NULL, 0, ?, ?, ?)`
          )
          .run(
            entryId,
            id,
            JSON.stringify(input.content),
            magicNotePlainText(input.content),
            now,
            now,
            embeddedBytes
          )
        this.syncMagicNoteTodos(
          database,
          id,
          entryId,
          input.content,
          now
        )
      }
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    return this.getMagicNote(id)
  }

  updateMagicNote(input: {
    noteId: string
    title?: string
    pinned?: boolean
    expectedRevision: number
  }): MagicNoteDetail {
    const now = new Date().toISOString()
    const result = this.requireDatabase()
      .prepare(
        `UPDATE magic_notes
         SET title = COALESCE(?, title),
             pinned = COALESCE(?, pinned),
             revision = revision + 1,
             updated_at = ?
         WHERE id = ? AND revision = ?`
      )
      .run(
        input.title ?? null,
        input.pinned === undefined ? null : input.pinned ? 1 : 0,
        now,
        input.noteId,
        input.expectedRevision
      )
    if (result.changes !== 1) {
      throw new Error('笔记已被更新，请刷新后重试')
    }
    return this.getMagicNote(input.noteId)
  }

  deleteMagicNote(noteId: string): void {
    const result = this.requireDatabase()
      .prepare('DELETE FROM magic_notes WHERE id = ?')
      .run(noteId)
    if (result.changes !== 1) {
      throw new Error('笔记不存在')
    }
  }

  createMagicNoteEntry(input: {
    noteId: string
    content: MagicNoteRichContent
    plainText: string
  }): MagicNoteDetail {
    const database = this.requireDatabase()
    const entryId = randomUUID()
    const now = new Date().toISOString()
    database.exec('BEGIN IMMEDIATE')
    try {
      this.assertMagicNoteEmbedBudget(input.noteId, input.content)
      const noteResult = database
        .prepare(
          `UPDATE magic_notes
           SET revision = revision + 1, updated_at = ?
           WHERE id = ?`
        )
        .run(now, input.noteId)
      if (noteResult.changes !== 1) {
        throw new Error('笔记不存在')
      }
      database
        .prepare(
          `INSERT INTO magic_note_entries
            (id, note_id, content_json, plain_text, comments_json,
             actions_json, analyzed_at, revision, created_at, updated_at,
             image_bytes)
           VALUES (?, ?, ?, ?, '[]', '[]', NULL, 0, ?, ?, ?)`
        )
        .run(
          entryId,
          input.noteId,
          JSON.stringify(input.content),
          input.plainText,
          now,
          now,
          magicNoteEmbeddedBytes(input.content)
        )
      this.syncMagicNoteTodos(
        database,
        input.noteId,
        entryId,
        input.content,
        now
      )
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    return this.getMagicNote(input.noteId)
  }

  updateMagicNoteEntry(input: {
    entryId: string
    content: MagicNoteRichContent
    plainText: string
    expectedRevision: number
  }): MagicNoteDetail {
    const database = this.requireDatabase()
    const existing = database
      .prepare('SELECT note_id FROM magic_note_entries WHERE id = ?')
      .get(input.entryId) as { note_id: string } | undefined
    if (!existing) {
      throw new Error('记录不存在')
    }
    const now = new Date().toISOString()
    database.exec('BEGIN IMMEDIATE')
    try {
      this.assertMagicNoteEmbedBudget(
        existing.note_id,
        input.content,
        input.entryId
      )
      const result = database
        .prepare(
          `UPDATE magic_note_entries
           SET content_json = ?, plain_text = ?, comments_json = '[]',
               analyzed_at = NULL, revision = revision + 1, updated_at = ?,
               image_bytes = ?
           WHERE id = ? AND revision = ?`
        )
        .run(
          JSON.stringify(input.content),
          input.plainText,
          now,
          magicNoteEmbeddedBytes(input.content),
          input.entryId,
          input.expectedRevision
        )
      if (result.changes !== 1) {
        throw new Error('记录已被更新，请刷新后重试')
      }
      database
        .prepare(
          `UPDATE magic_notes
           SET revision = revision + 1, updated_at = ?
           WHERE id = ?`
        )
        .run(now, existing.note_id)
      this.syncMagicNoteTodos(
        database,
        existing.note_id,
        input.entryId,
        input.content,
        now
      )
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    return this.getMagicNote(existing.note_id)
  }

  deleteMagicNoteEntry(entryId: string): MagicNoteDetail {
    const database = this.requireDatabase()
    const existing = database
      .prepare('SELECT note_id FROM magic_note_entries WHERE id = ?')
      .get(entryId) as { note_id: string } | undefined
    if (!existing) {
      throw new Error('记录不存在')
    }
    const now = new Date().toISOString()
    database.exec('BEGIN IMMEDIATE')
    try {
      database
        .prepare('DELETE FROM magic_note_entries WHERE id = ?')
        .run(entryId)
      database
        .prepare(
          `UPDATE magic_notes
           SET revision = revision + 1, updated_at = ?
           WHERE id = ?`
        )
        .run(now, existing.note_id)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    return this.getMagicNote(existing.note_id)
  }

  getMagicNoteEntry(entryId: string): MagicNoteEntry {
    const row = this.requireDatabase()
      .prepare('SELECT * FROM magic_note_entries WHERE id = ?')
      .get(entryId) as MagicNoteEntryRow | undefined
    if (!row) {
      throw new Error('记录不存在')
    }
    return toMagicNoteEntry(row)
  }

  saveMagicNoteAnalysis(input: {
    entryId: string
    expectedRevision: number
    comments: MagicNoteComment[]
  }): MagicNoteDetail {
    const database = this.requireDatabase()
    const existing = database
      .prepare(
        `SELECT note_id, comments_json
         FROM magic_note_entries
         WHERE id = ?`
      )
      .get(input.entryId) as
      | { note_id: string; comments_json: string }
      | undefined
    if (!existing) {
      throw new Error('记录不存在')
    }
    const now = new Date().toISOString()
    const comments = [
      ...(JSON.parse(existing.comments_json) as MagicNoteComment[]),
      ...input.comments.map((comment) => ({
        ...comment,
        analyzedAt: now
      }))
    ]
    const result = database
      .prepare(
        `UPDATE magic_note_entries
         SET comments_json = ?, analyzed_at = ?, revision = revision + 1,
             updated_at = ?
         WHERE id = ? AND revision = ?`
      )
      .run(
        JSON.stringify(comments),
        now,
        now,
        input.entryId,
        input.expectedRevision
      )
    if (result.changes !== 1) {
      throw new Error('记录已被更新，请重新分析')
    }
    return this.getMagicNote(existing.note_id)
  }

  listMagicTodos(): MagicTodoItem[] {
    return (
      this.requireDatabase()
        .prepare(
          `SELECT t.*, n.title AS note_title
           FROM magic_todos t
           LEFT JOIN magic_notes n ON n.id = t.note_id
           WHERE t.source = 'note'
           ORDER BY t.completed ASC, t.updated_at DESC, t.rowid DESC
           LIMIT 500`
        )
        .all() as MagicTodoRow[]
    ).map(toMagicTodo)
  }

  searchMagicNotes(query: string, limit: number): MagicNoteSearchResult[] {
    const pattern = `%${query.replace(/[\\%_]/gu, '\\$&')}%`
    return (
      this.requireDatabase()
        .prepare(
          `SELECT n.id AS note_id, n.title AS note_title,
                  e.id AS entry_id, COALESCE(e.plain_text, '') AS plain_text,
                  COALESCE(e.updated_at, n.updated_at) AS updated_at
           FROM magic_notes n
           LEFT JOIN magic_note_entries e ON e.note_id = n.id
           WHERE n.title LIKE ? ESCAPE '\\'
              OR e.plain_text LIKE ? ESCAPE '\\'
           ORDER BY COALESCE(e.updated_at, n.updated_at) DESC,
                    COALESCE(e.rowid, n.rowid) DESC
           LIMIT ?`
        )
        .all(pattern, pattern, limit) as Array<{
        note_id: string
        note_title: string
        entry_id: string | null
        plain_text: string
        updated_at: string
      }>
    ).map((row) => ({
      noteId: row.note_id,
      noteTitle: row.note_title.slice(0, 100),
      entryId: row.entry_id ?? undefined,
      content: row.plain_text.slice(0, 12_000),
      updatedAt: row.updated_at
    }))
  }

  getMagicTodo(todoId: string): MagicTodoItem {
    const row = this.requireDatabase()
      .prepare(
        `SELECT t.*, n.title AS note_title
         FROM magic_todos t
         LEFT JOIN magic_notes n ON n.id = t.note_id
         WHERE t.id = ?`
      )
      .get(todoId) as MagicTodoRow | undefined
    if (!row) {
      throw new Error('待办不存在')
    }
    return toMagicTodo(row)
  }

  updateMagicTodo(input: MagicTodoUpdateInput): MagicTodoItem {
    const database = this.requireDatabase()
    const now = new Date().toISOString()
    database.exec('BEGIN IMMEDIATE')
    try {
      const existing = database
        .prepare(
          `SELECT t.note_id, t.entry_id, t.source_index, t.completed,
                  t.revision AS todo_revision,
                  e.content_json, e.revision AS entry_revision
           FROM magic_todos t
           INNER JOIN magic_note_entries e ON e.id = t.entry_id
           WHERE t.id = ? AND t.source = 'note'`
        )
        .get(input.todoId) as
        | {
            note_id: string
            entry_id: string
            source_index: number
            completed: number
            todo_revision: number
            content_json: string
            entry_revision: number
          }
        | undefined
      if (!existing) {
        throw new Error('待办不存在')
      }
      if (existing.todo_revision !== input.expectedRevision) {
        throw new Error('待办已被更新，请刷新后重试')
      }
      if (Boolean(existing.completed) === input.completed) {
        database.exec('COMMIT')
        return this.getMagicTodo(input.todoId)
      }

      const content = setMagicNoteChecklistCompletion(
        JSON.parse(existing.content_json) as MagicNoteRichContent,
        existing.source_index,
        input.completed
      )
      const result = database
        .prepare(
          `UPDATE magic_note_entries
           SET content_json = ?, plain_text = ?, comments_json = '[]',
               analyzed_at = NULL, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`
        )
        .run(
          JSON.stringify(content),
          magicNotePlainText(content),
          now,
          existing.entry_id,
          existing.entry_revision
        )
      if (result.changes !== 1) {
        throw new Error('记录已被更新，请刷新后重试')
      }
      database
        .prepare(
          `UPDATE magic_notes
           SET revision = revision + 1, updated_at = ?
           WHERE id = ?`
        )
        .run(now, existing.note_id)
      this.syncMagicNoteTodos(
        database,
        existing.note_id,
        existing.entry_id,
        content,
        now
      )
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    return this.getMagicTodo(input.todoId)
  }

  saveMagicTodoAnalysis(input: {
    todoId: string
    expectedRevision: number
    comments: MagicNoteComment[]
  }): MagicTodoItem {
    const database = this.requireDatabase()
    const existing = database
      .prepare('SELECT comments_json FROM magic_todos WHERE id = ?')
      .get(input.todoId) as { comments_json: string } | undefined
    if (!existing) {
      throw new Error('待办不存在')
    }
    const now = new Date().toISOString()
    const comments = [
      ...(JSON.parse(existing.comments_json) as MagicNoteComment[]),
      ...input.comments.map((comment) => ({
        ...comment,
        analyzedAt: now
      }))
    ]
    const result = database
      .prepare(
        `UPDATE magic_todos
         SET comments_json = ?, analyzed_at = ?,
             revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?`
      )
      .run(
        JSON.stringify(comments),
        now,
        now,
        input.todoId,
        input.expectedRevision
      )
    if (result.changes !== 1) {
      throw new Error('待办已被更新，请刷新后重试')
    }
    return this.getMagicTodo(input.todoId)
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
         WHERE visible = 1
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
    parentTaskId?: string
    expertId?: string
    routingMode?: AssistantTask['routingMode']
    title: string
    instructions: string
    workMode: 'ask' | 'execute'
    origin?: AssistantTask['origin']
    status?: 'queued' | 'running'
    visible?: boolean
  }): AssistantTask {
    const now = new Date().toISOString()
    const status = input.status ?? 'running'
    this.requireDatabase()
      .prepare(
        `INSERT INTO tasks
          (id, project_id, conversation_id, parent_task_id, expert_id,
           routing_mode, title, instructions, origin, status, priority,
           work_mode, progress, created_at, started_at, visible)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, ?)`
      )
      .run(
        input.id,
        input.projectId ?? null,
        input.conversationId ?? null,
        input.parentTaskId ?? null,
        input.expertId ?? null,
        input.routingMode ?? null,
        input.title,
        input.instructions,
        input.origin ?? 'user',
        status,
        input.workMode,
        now,
        status === 'running' ? now : null,
        Number(input.visible ?? true)
      )
    this.appendTaskEvent(input.id, status, {
      workMode: input.workMode
    })
    return this.getTask(input.id)
  }

  upsertModelUsageCall(input: ModelUsageCallInput): void {
    const requestId = validateUsageText(
      input.requestId,
      'requestId',
      256
    )
    const callId = validateUsageText(input.callId, 'callId', 256)
    const runtime = validateUsageText(input.runtime, 'runtime', 100)
    const provider = validateUsageText(
      input.provider,
      'provider',
      100
    )
    const model = validateUsageText(input.model, 'model', 500)
    const inputTokens = validateTokenCount(input.input, 'input')
    const outputTokens = validateTokenCount(input.output, 'output')
    const cacheReadTokens = validateTokenCount(
      input.cacheRead,
      'cacheRead'
    )
    const cacheWriteTokens = validateTokenCount(
      input.cacheWrite,
      'cacheWrite'
    )
    const now = new Date().toISOString()
    this.requireDatabase()
      .prepare(
        `INSERT INTO model_usage_calls
          (request_id, call_id, runtime, provider, model, input_tokens,
           output_tokens, cache_read_tokens, cache_write_tokens,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(request_id, call_id) DO UPDATE SET
           runtime = excluded.runtime,
           provider = excluded.provider,
           model = excluded.model,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           cache_read_tokens = excluded.cache_read_tokens,
           cache_write_tokens = excluded.cache_write_tokens,
           updated_at = excluded.updated_at`
      )
      .run(
        requestId,
        callId,
        runtime,
        provider,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        now,
        now
      )
  }

  getTokenUsageSummary(): TokenUsageSummary {
    const rows = this.requireDatabase()
      .prepare(
        `SELECT
           usage.request_id,
           tasks.project_id,
           projects.name AS project_name,
           tasks.conversation_id,
           conversations.title AS conversation_title,
           usage.runtime,
           usage.provider,
           usage.model,
           COUNT(*) AS call_count,
           SUM(usage.input_tokens) AS input_tokens,
           SUM(usage.output_tokens) AS output_tokens,
           SUM(usage.cache_read_tokens) AS cache_read_tokens,
           SUM(usage.cache_write_tokens) AS cache_write_tokens
         FROM model_usage_calls usage
         JOIN tasks ON tasks.id = usage.request_id
         LEFT JOIN projects ON projects.id = tasks.project_id
         LEFT JOIN conversations
           ON conversations.id = tasks.conversation_id
         GROUP BY
           usage.request_id,
           tasks.project_id,
           projects.name,
           tasks.conversation_id,
           conversations.title,
           usage.runtime,
           usage.provider,
           usage.model
         ORDER BY MAX(usage.updated_at) DESC
         LIMIT 500`
      )
      .all() as TokenUsageRecordRow[]
    const records: TokenUsageRecord[] = rows.map((row) => ({
      requestId: row.request_id,
      projectId: row.project_id ?? undefined,
      projectName: row.project_name ?? undefined,
      conversationId: row.conversation_id ?? undefined,
      conversationTitle: row.conversation_title ?? undefined,
      runtime: row.runtime,
      provider: row.provider,
      model: row.model,
      callCount: row.call_count,
      input: row.input_tokens,
      output: row.output_tokens,
      cacheRead: row.cache_read_tokens,
      cacheWrite: row.cache_write_tokens,
      totalTokens: row.input_tokens + row.output_tokens
    }))
    const totalRow = this.requireDatabase()
      .prepare(
        `SELECT
           COUNT(*) AS call_count,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
           COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens
         FROM model_usage_calls`
      )
      .get() as {
      call_count: number
      input_tokens: number
      output_tokens: number
      cache_read_tokens: number
      cache_write_tokens: number
    }
    const totals = {
      callCount: totalRow.call_count,
      input: totalRow.input_tokens,
      output: totalRow.output_tokens,
      cacheRead: totalRow.cache_read_tokens,
      cacheWrite: totalRow.cache_write_tokens,
      totalTokens: totalRow.input_tokens + totalRow.output_tokens
    }
    return { totals, records }
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
             started_at = CASE
               WHEN ? = 'running' AND started_at IS NULL THEN ?
               ELSE started_at
             END,
             completed_at = CASE WHEN ? THEN ? ELSE completed_at END
         WHERE id = ?`
      )
      .run(
        status,
        error ?? null,
        status,
        new Date().toISOString(),
        terminal ? 1 : 0,
        new Date().toISOString(),
        taskId
      )
    if (result.changes !== 1) {
      throw new Error('任务不存在')
    }
    this.appendTaskEvent(taskId, 'status', { status, error })
  }

  resolveAssistantSuggestionTask(
    taskId: string,
    status: 'completed' | 'cancelled'
  ): void {
    const completedAt = new Date().toISOString()
    const result = this.requireDatabase()
      .prepare(
        `UPDATE tasks
         SET status = ?, error = NULL, completed_at = ?
         WHERE id = ? AND origin = 'assistant' AND status = 'paused'`
      )
      .run(status, completedAt, taskId)
    if (result.changes !== 1) {
      throw new Error('待处理的智能心跳建议不存在或状态已变化')
    }
    this.appendTaskEvent(taskId, 'status', { status })
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

  persistComputerControlAudit(
    event: ComputerControlAuditEvent
  ): void {
    if (!event || typeof event !== 'object') {
      throw new TypeError('Computer control audit event is required')
    }
    const taskId = validateComputerControlId(
      event.taskId,
      'taskId',
      128
    )
    const conversationId = validateComputerControlId(
      event.conversationId,
      'conversationId',
      128
    )
    const leaseId = validateComputerControlId(
      event.leaseId,
      'leaseId',
      160,
      true
    )
    const commandId = validateComputerControlId(
      event.commandId,
      'commandId',
      160,
      true
    )
    const action = validateComputerControlEnum(
      event.action,
      'action',
      computerControlActions
    )
    const risk = computerControlRiskSchema.parse(event.risk)
    const outcome = validateComputerControlEnum(
      event.outcome,
      'outcome',
      computerControlOutcomes
    )
    if (
      !Number.isSafeInteger(event.timestamp) ||
      event.timestamp < 0
    ) {
      throw new RangeError('Invalid timestamp')
    }
    const errorCode =
      event.errorCode === undefined
        ? undefined
        : computerControlErrorCodeSchema.parse(event.errorCode)
    if (
      (outcome === 'completed' && errorCode !== undefined) ||
      (outcome !== 'completed' && errorCode === undefined)
    ) {
      throw new RangeError('Invalid outcome and errorCode combination')
    }
    const hasTextMetadata =
      event.textLength !== undefined ||
      event.textDigest !== undefined
    if (
      (action === 'replace_text') !== hasTextMetadata ||
      (hasTextMetadata &&
        (!Number.isInteger(event.textLength) ||
          event.textLength! < 0 ||
          event.textLength! > 4_096 ||
          typeof event.textDigest !== 'string' ||
          !/^[0-9a-f]{64}$/.test(event.textDigest)))
    ) {
      throw new RangeError('Invalid redacted text metadata')
    }

    const database = this.requireDatabase()
    const createdAt = new Date().toISOString()
    database.exec('BEGIN IMMEDIATE')
    try {
      const inserted = database
        .prepare(
          `INSERT OR IGNORE INTO computer_control_actions
            (command_id, task_id, conversation_id, lease_id, action, risk,
             outcome, error_code, occurred_at, text_length, text_digest,
             created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          commandId,
          taskId,
          conversationId,
          leaseId,
          action,
          risk,
          outcome,
          errorCode ?? null,
          event.timestamp,
          event.textLength ?? null,
          event.textDigest ?? null,
          createdAt
        )
      if (inserted.changes === 1) {
        database
          .prepare(
            `INSERT INTO task_events
              (task_id, run_id, kind, payload_json, created_at)
             VALUES (?, NULL, 'computer_control', ?, ?)`
          )
          .run(
            taskId,
            JSON.stringify({
              commandId,
              action,
              risk,
              outcome,
              ...(errorCode ? { errorCode } : {}),
              ...(event.textLength === undefined
                ? {}
                : { textLength: event.textLength }),
              ...(event.textDigest === undefined
                ? {}
                : { textDigest: event.textDigest })
            }),
            createdAt
          )
        database
          .prepare(
            `DELETE FROM computer_control_actions
             WHERE command_id IN (
               SELECT command_id FROM computer_control_actions
               ORDER BY occurred_at DESC, created_at DESC
               LIMIT -1 OFFSET 10000
             )`
          )
          .run()
      }
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  listRecentComputerControlAudit(
    limit = 100
  ): PersistedComputerControlAuditEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError(
        'Computer control audit limit must be between 1 and 500'
      )
    }
    const rows = this.requireDatabase()
      .prepare(
        `SELECT command_id, task_id, conversation_id, lease_id, action,
                risk, outcome, error_code, occurred_at, text_length,
                text_digest
         FROM computer_control_actions
         ORDER BY occurred_at DESC, created_at DESC
         LIMIT ?`
      )
      .all(limit) as ComputerControlActionRow[]
    return rows.map(toComputerControlAuditEvent)
  }

  listArtifacts(projectId?: string, limit = 100): AssistantArtifact[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
    const columns = `id, project_id, task_id, kind, title, mime_type,
                     CASE WHEN kind = 'image' THEN NULL
                          ELSE inline_content END AS inline_content,
                     byte_size, created_at, updated_at`
    const rows = projectId
      ? this.requireDatabase()
          .prepare(
            `SELECT ${columns} FROM artifacts
             WHERE project_id = ?
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(projectId, safeLimit)
      : this.requireDatabase()
          .prepare(
            `SELECT ${columns} FROM artifacts
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(safeLimit)
    return (rows as ArtifactRow[]).map(toArtifact)
  }

  getArtifact(artifactId: string): AssistantArtifact {
    const row = this.requireDatabase()
      .prepare(
        `SELECT id, project_id, task_id, kind, title, mime_type,
                inline_content, byte_size, created_at, updated_at
         FROM artifacts
         WHERE id = ?`
      )
      .get(artifactId) as ArtifactRow | undefined
    if (!row) {
      throw new Error('成果不存在')
    }
    return toArtifact(row)
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

  createImageArtifact(input: {
    projectId?: string
    taskId?: string
    title: string
    mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
    base64: string
  }): AssistantArtifact {
    return this.createInlineArtifact({
      projectId: input.projectId,
      taskId: input.taskId,
      kind: 'image',
      title: input.title,
      mimeType: input.mimeType,
      content: `data:${input.mimeType};base64,${input.base64}`
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
           LIMIT 1`
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

  listHeartbeatConfigs(projectId?: string): AssistantHeartbeatConfig[] {
    const rows = projectId
      ? this.requireDatabase()
          .prepare(
            `SELECT * FROM heartbeat_configs
             WHERE project_id = ?
             ORDER BY created_at DESC
             LIMIT 100`
          )
          .all(projectId)
      : this.requireDatabase()
          .prepare(
            `SELECT * FROM heartbeat_configs
             ORDER BY created_at DESC
             LIMIT 100`
          )
          .all()
    return (rows as HeartbeatConfigRow[]).map(toHeartbeatConfig)
  }

  getHeartbeatConfig(configId: string): AssistantHeartbeatConfig {
    const row = this.requireDatabase()
      .prepare('SELECT * FROM heartbeat_configs WHERE id = ?')
      .get(configId) as HeartbeatConfigRow | undefined
    if (!row) {
      throw new Error('Heartbeat configuration not found')
    }
    return toHeartbeatConfig(row)
  }

  createHeartbeatConfig(
    input: HeartbeatCreateInput,
    now = new Date()
  ): AssistantHeartbeatConfig {
    const id = randomUUID()
    const timestamp = now.toISOString()
    const nextRunAt = computeNextHeartbeatRun(
      input.recurrence,
      input.timezone,
      now
    ).toISOString()
    this.requireDatabase()
      .prepare(
        `INSERT INTO heartbeat_configs
          (id, project_id, name, timezone, recurrence_json,
           lookback_hours, retention_days, enabled, next_run_at,
           last_run_at, last_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
      )
      .run(
        id,
        input.projectId ?? null,
        input.name,
        input.timezone,
        JSON.stringify(input.recurrence),
        input.lookbackHours,
        input.retentionDays,
        input.enabled ? 1 : 0,
        nextRunAt,
        timestamp,
        timestamp
      )
    return this.getHeartbeatConfig(id)
  }

  updateHeartbeatConfig(
    configId: string,
    input: HeartbeatUpdateInput,
    now = new Date()
  ): AssistantHeartbeatConfig {
    const timestamp = now.toISOString()
    const nextRunAt = computeNextHeartbeatRun(
      input.recurrence,
      input.timezone,
      now
    ).toISOString()
    const result = this.requireDatabase()
      .prepare(
        `UPDATE heartbeat_configs
         SET project_id = ?, name = ?, timezone = ?,
             recurrence_json = ?, lookback_hours = ?,
             retention_days = ?, enabled = ?, next_run_at = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.projectId ?? null,
        input.name,
        input.timezone,
        JSON.stringify(input.recurrence),
        input.lookbackHours,
        input.retentionDays,
        input.enabled ? 1 : 0,
        nextRunAt,
        timestamp,
        configId
      )
    if (result.changes !== 1) {
      throw new Error('Heartbeat configuration not found')
    }
    return this.getHeartbeatConfig(configId)
  }

  setHeartbeatPaused(configId: string, paused: boolean): void {
    const result = this.requireDatabase()
      .prepare(
        `UPDATE heartbeat_configs
         SET enabled = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(paused ? 0 : 1, new Date().toISOString(), configId)
    if (result.changes !== 1) {
      throw new Error('Heartbeat configuration not found')
    }
  }

  removeHeartbeatConfig(configId: string): void {
    const database = this.requireDatabase()
    database.exec('BEGIN IMMEDIATE')
    try {
      const artifactRows = database
        .prepare(
          `SELECT artifact_id FROM heartbeat_entries
           WHERE config_id = ? AND artifact_id IS NOT NULL`
        )
        .all(configId) as Array<{ artifact_id: string }>
      const result = database
        .prepare('DELETE FROM heartbeat_configs WHERE id = ?')
        .run(configId)
      if (result.changes !== 1) {
        throw new Error('Heartbeat configuration not found')
      }
      const deleteArtifact = database.prepare(
        'DELETE FROM artifacts WHERE id = ?'
      )
      for (const row of artifactRows) {
        deleteArtifact.run(row.artifact_id)
      }
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  listHeartbeatRuns(
    configId?: string,
    limit = 50
  ): AssistantHeartbeatRun[] {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)))
    const rows = configId
      ? this.requireDatabase()
          .prepare(
            `SELECT * FROM heartbeat_runs
             WHERE config_id = ?
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(configId, safeLimit)
      : this.requireDatabase()
          .prepare(
            `SELECT * FROM heartbeat_runs
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(safeLimit)
    return (rows as HeartbeatRunRow[]).map(toHeartbeatRun)
  }

  getHeartbeatRun(runId: string): AssistantHeartbeatRun {
    const row = this.requireDatabase()
      .prepare('SELECT * FROM heartbeat_runs WHERE id = ?')
      .get(runId) as HeartbeatRunRow | undefined
    if (!row) {
      throw new Error('Heartbeat run not found')
    }
    return toHeartbeatRun(row)
  }

  listHeartbeatEntries(
    configId?: string,
    limit = 50
  ): AssistantHeartbeatEntry[] {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)))
    const rows = configId
      ? this.requireDatabase()
          .prepare(
            `SELECT * FROM heartbeat_entries
             WHERE config_id = ?
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(configId, safeLimit)
      : this.requireDatabase()
          .prepare(
            `SELECT * FROM heartbeat_entries
             ORDER BY created_at DESC
             LIMIT ?`
          )
          .all(safeLimit)
    return (rows as HeartbeatEntryRow[]).map(toHeartbeatEntry)
  }

  claimDueHeartbeats(
    leaseOwner: string,
    now = new Date(),
    leaseMilliseconds = 5 * 60_000
  ): ClaimedHeartbeatRun[] {
    const database = this.requireDatabase()
    const nowIso = now.toISOString()
    const leaseExpiresAt = new Date(
      now.getTime() + leaseMilliseconds
    ).toISOString()
    const claimed: ClaimedHeartbeatRun[] = []
    database.exec('BEGIN IMMEDIATE')
    try {
      const retryRows = database
        .prepare(
          `SELECT r.id AS run_id, r.config_id, r.attempt_count
           FROM heartbeat_runs r
           JOIN heartbeat_configs c ON c.id = r.config_id
           WHERE c.enabled = 1
             AND r.attempt_count < 3
             AND (
               (r.status = 'failed' AND r.next_attempt_at <= ?)
               OR
               (r.status = 'claimed' AND r.lease_expires_at <= ?)
             )
           ORDER BY COALESCE(r.next_attempt_at, r.lease_expires_at)
           LIMIT 1`
        )
        .all(nowIso, nowIso) as Array<{
        run_id: string
        config_id: string
        attempt_count: number
      }>
      for (const joined of retryRows) {
        const result = database
          .prepare(
            `UPDATE heartbeat_runs
             SET status = 'claimed', attempt_count = attempt_count + 1,
                 next_attempt_at = NULL, lease_owner = ?,
                 lease_expires_at = ?, started_at = ?,
                 completed_at = NULL, error = NULL, updated_at = ?
             WHERE id = ? AND attempt_count = ?`
          )
          .run(
            leaseOwner,
            leaseExpiresAt,
            nowIso,
            nowIso,
            joined.run_id,
            joined.attempt_count
          )
        if (result.changes === 1) {
          const run = database
            .prepare('SELECT * FROM heartbeat_runs WHERE id = ?')
            .get(joined.run_id) as HeartbeatRunRow
          const config = database
            .prepare('SELECT * FROM heartbeat_configs WHERE id = ?')
            .get(joined.config_id) as HeartbeatConfigRow
          claimed.push({
            run: toHeartbeatRun(run),
            config: toHeartbeatConfig(config),
            leaseOwner,
            acquired: true
          })
        }
      }

      const remaining = Math.max(0, 1 - claimed.length)
      const configRows = database
        .prepare(
          `SELECT * FROM heartbeat_configs
           WHERE enabled = 1 AND next_run_at <= ?
           ORDER BY next_run_at
           LIMIT ?`
        )
        .all(nowIso, remaining) as HeartbeatConfigRow[]
      for (const row of configRows) {
        const scheduledFor = row.next_run_at
        const lag = now.getTime() - Date.parse(scheduledFor)
        const nextRunAt = computeNextHeartbeatRun(
          JSON.parse(
            row.recurrence_json
          ) as AssistantHeartbeatConfig['recurrence'],
          row.timezone,
          now
        ).toISOString()
        if (lag > 2 * 60 * 60_000) {
          database
            .prepare(
              `INSERT OR IGNORE INTO heartbeat_runs
                (id, config_id, trigger, scheduled_for,
                 idempotency_key, status, attempt_count,
                 next_attempt_at, lease_owner, lease_expires_at,
                 started_at, completed_at, error, entry_id,
                 created_at, updated_at)
               VALUES (?, ?, 'scheduled', ?, ?, 'skipped', 0,
                 NULL, NULL, NULL, NULL, ?, ?, NULL, ?, ?)`
            )
            .run(
              randomUUID(),
              row.id,
              scheduledFor,
              `scheduled:${row.id}:${scheduledFor}`,
              nowIso,
              'Missed by more than 2 hours',
              nowIso,
              nowIso
            )
          database
            .prepare(
              `UPDATE heartbeat_configs
               SET next_run_at = ?, last_run_at = ?,
                   last_status = 'skipped', updated_at = ?
               WHERE id = ? AND next_run_at = ?`
            )
            .run(nextRunAt, nowIso, nowIso, row.id, scheduledFor)
          continue
        }
        const runId = randomUUID()
        const insert = database
          .prepare(
            `INSERT OR IGNORE INTO heartbeat_runs
              (id, config_id, trigger, scheduled_for,
               idempotency_key, status, attempt_count,
               next_attempt_at, lease_owner, lease_expires_at,
               started_at, completed_at, error, entry_id,
               created_at, updated_at)
             VALUES (?, ?, 'scheduled', ?, ?, 'claimed', 1,
               NULL, ?, ?, ?, NULL, NULL, NULL, ?, ?)`
          )
          .run(
            runId,
            row.id,
            scheduledFor,
            `scheduled:${row.id}:${scheduledFor}`,
            leaseOwner,
            leaseExpiresAt,
            nowIso,
            nowIso,
            nowIso
          )
        database
          .prepare(
            `UPDATE heartbeat_configs
             SET next_run_at = ?, last_run_at = ?,
                 last_status = 'claimed', updated_at = ?
             WHERE id = ? AND next_run_at = ?`
          )
          .run(nextRunAt, nowIso, nowIso, row.id, scheduledFor)
        if (insert.changes === 1) {
          const run = database
            .prepare('SELECT * FROM heartbeat_runs WHERE id = ?')
            .get(runId) as HeartbeatRunRow
          claimed.push({
            run: toHeartbeatRun(run),
            config: toHeartbeatConfig({
              ...row,
              next_run_at: nextRunAt,
              last_run_at: nowIso,
              last_status: 'claimed',
              updated_at: nowIso
            }),
            leaseOwner,
            acquired: true
          })
        }
      }
      database.exec('COMMIT')
      return claimed
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  claimHeartbeatNow(
    configId: string,
    idempotencyKey: string,
    leaseOwner: string,
    now = new Date(),
    leaseMilliseconds = 5 * 60_000
  ): ClaimedHeartbeatRun {
    const database = this.requireDatabase()
    const config = this.getHeartbeatConfig(configId)
    const nowIso = now.toISOString()
    const runId = randomUUID()
    const scopedIdempotencyKey = `manual:${configId}:${idempotencyKey}`
    database.exec('BEGIN IMMEDIATE')
    try {
      const duplicate = database
        .prepare(
          `SELECT * FROM heartbeat_runs
           WHERE config_id = ? AND idempotency_key = ?`
        )
        .get(configId, scopedIdempotencyKey) as
        | HeartbeatRunRow
        | undefined
      if (duplicate) {
        database.exec('COMMIT')
        return {
          config,
          run: toHeartbeatRun(duplicate),
          leaseOwner,
          acquired: false
        }
      }
      database
        .prepare(
          `UPDATE heartbeat_runs
           SET status = 'failed', next_attempt_at = NULL,
               lease_owner = NULL, lease_expires_at = NULL,
               completed_at = ?, error = ?, updated_at = ?
           WHERE config_id = ? AND status = 'claimed'
             AND lease_expires_at <= ?`
        )
        .run(
          nowIso,
          'Expired run superseded by a new manual heartbeat',
          nowIso,
          configId,
          nowIso
        )
      const active = database
        .prepare(
          `SELECT * FROM heartbeat_runs
           WHERE config_id = ? AND status = 'claimed'
             AND lease_expires_at > ?
           ORDER BY created_at DESC LIMIT 1`
        )
        .get(configId, nowIso) as HeartbeatRunRow | undefined
      if (active) {
        database.exec('COMMIT')
        return {
          config,
          run: toHeartbeatRun(active),
          leaseOwner,
          acquired: false
        }
      }
      database
        .prepare(
          `INSERT INTO heartbeat_runs
            (id, config_id, trigger, scheduled_for, idempotency_key,
             status, attempt_count, next_attempt_at, lease_owner,
             lease_expires_at, started_at, completed_at, error,
             entry_id, created_at, updated_at)
           VALUES (?, ?, 'manual', ?, ?, 'claimed', 1, NULL, ?, ?,
             ?, NULL, NULL, NULL, ?, ?)`
        )
        .run(
          runId,
          configId,
          nowIso,
          scopedIdempotencyKey,
          leaseOwner,
          new Date(
            now.getTime() + leaseMilliseconds
          ).toISOString(),
          nowIso,
          nowIso,
          nowIso
        )
      database
        .prepare(
          `UPDATE heartbeat_configs
           SET last_run_at = ?, last_status = 'claimed', updated_at = ?
           WHERE id = ?`
        )
        .run(nowIso, nowIso, configId)
      const run = database
        .prepare('SELECT * FROM heartbeat_runs WHERE id = ?')
        .get(runId) as HeartbeatRunRow
      database.exec('COMMIT')
      return {
        config,
        run: toHeartbeatRun(run),
        leaseOwner,
        acquired: true
      }
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  buildHeartbeatInput(
    config: AssistantHeartbeatConfig,
    now = new Date()
  ): HeartbeatInputSnapshot {
    const database = this.requireDatabase()
    const since = new Date(
      now.getTime() - config.lookbackHours * 60 * 60_000
    ).toISOString()
    const conversations = (
      config.projectId
        ? database
            .prepare(
              `SELECT id, title, updated_at FROM conversations
               WHERE status = 'active' AND project_id = ?
                 AND updated_at >= ?
               ORDER BY updated_at DESC LIMIT 20`
            )
            .all(config.projectId, since)
        : database
            .prepare(
              `SELECT id, title, updated_at FROM conversations
               WHERE status = 'active' AND updated_at >= ?
               ORDER BY updated_at DESC LIMIT 20`
            )
            .all(since)
    ) as Array<{ id: string; title: string; updated_at: string }>
    const messageStatement = database.prepare(
      `SELECT role, content, created_at FROM (
         SELECT role, content, created_at, sequence
         FROM messages
         WHERE conversation_id = ? AND created_at >= ?
           AND role IN ('user', 'assistant')
         ORDER BY sequence DESC LIMIT 20
       ) ORDER BY sequence`
    )
    const tasks = (
      config.projectId
        ? database
            .prepare(
              `SELECT id, title, status, created_at, completed_at
               FROM tasks
               WHERE project_id = ? AND visible = 1 AND created_at >= ?
               ORDER BY created_at DESC LIMIT 100`
            )
            .all(config.projectId, since)
        : database
            .prepare(
              `SELECT id, title, status, created_at, completed_at
               FROM tasks
               WHERE visible = 1 AND created_at >= ?
               ORDER BY created_at DESC LIMIT 100`
            )
            .all(since)
    ) as Array<{
      id: string
      title: string
      status: AssistantTask['status']
      created_at: string
      completed_at: string | null
    }>
    const memories = (
      config.projectId
        ? database
            .prepare(
              `SELECT id, type, content, scope FROM memory_items
               WHERE status = 'confirmed'
                 AND (scope = 'global' OR
                   (scope = 'project' AND scope_id = ?))
               ORDER BY updated_at DESC LIMIT 100`
            )
            .all(config.projectId)
        : database
            .prepare(
              `SELECT id, type, content, scope FROM memory_items
               WHERE status = 'confirmed' AND scope = 'global'
               ORDER BY updated_at DESC LIMIT 100`
            )
            .all()
    ) as Array<{
      id: string
      type: AssistantMemory['type']
      content: string
      scope: AssistantMemory['scope']
    }>
    return {
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updated_at,
        messages: (
          messageStatement.all(conversation.id, since) as Array<{
            role: 'user' | 'assistant'
            content: string
            created_at: string
          }>
        ).map((message) => ({
          role: message.role,
          content: message.content,
          createdAt: message.created_at
        }))
      })),
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        createdAt: task.created_at,
        completedAt: task.completed_at ?? undefined
      })),
      confirmedMemories: memories
    }
  }

  completeHeartbeatRun(
    claim: ClaimedHeartbeatRun,
    output: HeartbeatSummaryOutput,
    now = new Date()
  ): AssistantHeartbeatRun {
    const database = this.requireDatabase()
    const timestamp = now.toISOString()
    database.exec('BEGIN IMMEDIATE')
    try {
      const active = database
        .prepare(
          `SELECT id FROM heartbeat_runs
           WHERE id = ? AND status = 'claimed' AND lease_owner = ?
             AND lease_expires_at > ?`
        )
        .get(
          claim.run.id,
          claim.leaseOwner,
          timestamp
        ) as { id: string } | undefined
      if (!active) {
        throw new Error('Heartbeat lease is no longer active')
      }
      const artifactId = randomUUID()
      const entryId = randomUUID()
      const summaryContent = [
        `# ${claim.config.name}`,
        '',
        output.summary,
        ...(output.highlights.length
          ? ['', '## Highlights', ...output.highlights.map((item) => `- ${item}`)]
          : [])
      ].join('\n')
      database
        .prepare(
          `INSERT INTO artifacts
            (id, project_id, task_id, run_id, kind, title, mime_type,
             storage_kind, storage_path, inline_content, checksum,
             byte_size, preview_json, created_at, updated_at)
           VALUES (?, ?, NULL, NULL, 'markdown', ?, 'text/markdown',
             'inline', NULL, ?, NULL, ?, '{}', ?, ?)`
        )
        .run(
          artifactId,
          claim.config.projectId ?? null,
          `Heartbeat: ${claim.config.name}`.slice(0, 240),
          summaryContent,
          Buffer.byteLength(summaryContent),
          timestamp,
          timestamp
        )
      const proposedMemoryIds: string[] = []
      const insertMemory = database.prepare(
        `INSERT INTO memory_items
          (id, scope, scope_id, type, content, source_conversation_id,
           source_message_id, confidence, salience, status, expires_at,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'proposed',
           NULL, ?, ?)`
      )
      const findExistingMemory = database.prepare(
        `SELECT id FROM memory_items
         WHERE scope = ?
           AND ((? IS NULL AND scope_id IS NULL) OR scope_id = ?)
           AND content = ? COLLATE NOCASE
           AND status IN ('proposed', 'confirmed')
         LIMIT 1`
      )
      for (const memory of output.proposedMemories) {
        const scopeId =
          memory.scope === 'project'
            ? (claim.config.projectId ?? null)
            : null
        const existing = findExistingMemory.get(
          memory.scope,
          scopeId,
          scopeId,
          memory.content
        ) as { id: string } | undefined
        if (existing) {
          continue
        }
        const memoryId = randomUUID()
        insertMemory.run(
          memoryId,
          memory.scope,
          scopeId,
          memory.type,
          memory.content,
          memory.confidence,
          memory.salience,
          timestamp,
          timestamp
        )
        proposedMemoryIds.push(memoryId)
      }
      const followUpTaskIds: string[] = []
      const insertTask = database.prepare(
        `INSERT INTO tasks
          (id, project_id, conversation_id, schedule_id, title,
           instructions, origin, status, priority, work_mode,
           progress, created_at, started_at, completed_at, error)
         VALUES (?, ?, NULL, NULL, ?, ?, 'assistant', 'paused', 0,
           'ask', NULL, ?, NULL, NULL, NULL)`
      )
      for (const task of output.followUpTasks) {
        const taskId = randomUUID()
        insertTask.run(
          taskId,
          claim.config.projectId ?? null,
          task.title,
          task.instructions,
          timestamp
        )
        followUpTaskIds.push(taskId)
      }
      database
        .prepare(
          `INSERT INTO heartbeat_entries
            (id, config_id, run_id, scheduled_for, summary,
             highlights_json, artifact_id, proposed_memory_ids_json,
             follow_up_task_ids_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          entryId,
          claim.config.id,
          claim.run.id,
          claim.run.scheduledFor,
          output.summary,
          JSON.stringify(output.highlights),
          artifactId,
          JSON.stringify(proposedMemoryIds),
          JSON.stringify(followUpTaskIds),
          timestamp
        )
      database
        .prepare(
          `UPDATE heartbeat_runs
           SET status = 'completed', completed_at = ?, error = NULL,
               entry_id = ?, lease_owner = NULL,
               lease_expires_at = NULL, updated_at = ?
           WHERE id = ?`
        )
        .run(timestamp, entryId, timestamp, claim.run.id)
      database
        .prepare(
          `UPDATE heartbeat_configs
           SET last_status = 'completed', updated_at = ?
           WHERE id = ?`
        )
        .run(timestamp, claim.config.id)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    this.pruneHeartbeatHistory(claim.config.id, now)
    return this.getHeartbeatRun(claim.run.id)
  }

  failHeartbeatRun(
    claim: ClaimedHeartbeatRun,
    error: string,
    now = new Date()
  ): AssistantHeartbeatRun {
    const database = this.requireDatabase()
    const timestamp = now.toISOString()
    const retryDelays = [60_000, 5 * 60_000]
    const nextAttemptAt =
      claim.run.attemptCount < 3
        ? new Date(
            now.getTime() +
              retryDelays[
                Math.min(
                  claim.run.attemptCount - 1,
                  retryDelays.length - 1
                )
              ]!
          ).toISOString()
        : null
    const result = database
      .prepare(
        `UPDATE heartbeat_runs
         SET status = 'failed', next_attempt_at = ?,
             completed_at = ?, error = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'claimed' AND lease_owner = ?`
      )
      .run(
        nextAttemptAt,
        timestamp,
        error.slice(0, 2_000),
        timestamp,
        claim.run.id,
        claim.leaseOwner
      )
    if (result.changes !== 1) {
      throw new Error('Heartbeat lease is no longer active')
    }
    database
      .prepare(
        `UPDATE heartbeat_configs
         SET last_status = 'failed', updated_at = ?
         WHERE id = ?`
      )
      .run(timestamp, claim.config.id)
    return this.getHeartbeatRun(claim.run.id)
  }

  pruneHeartbeatHistory(configId: string, now = new Date()): void {
    const database = this.requireDatabase()
    const config = this.getHeartbeatConfig(configId)
    const cutoff = new Date(
      now.getTime() - config.retentionDays * 24 * 60 * 60_000
    ).toISOString()
    database.exec('BEGIN IMMEDIATE')
    try {
      const artifacts = database
        .prepare(
          `SELECT artifact_id FROM heartbeat_entries
           WHERE config_id = ? AND created_at < ?
             AND artifact_id IS NOT NULL`
        )
        .all(configId, cutoff) as Array<{ artifact_id: string }>
      database
        .prepare(
          `DELETE FROM heartbeat_entries
           WHERE config_id = ? AND created_at < ?`
        )
        .run(configId, cutoff)
      database
        .prepare(
          `DELETE FROM heartbeat_runs
           WHERE config_id = ? AND created_at < ?
             AND status IN ('completed', 'failed', 'skipped')`
        )
        .run(configId, cutoff)
      const deleteArtifact = database.prepare(
        'DELETE FROM artifacts WHERE id = ?'
      )
      for (const artifact of artifacts) {
        deleteArtifact.run(artifact.artifact_id)
      }
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
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
    const normalized = expertCreateSchema.parse(input)
    const id = randomUUID()
    const now = new Date().toISOString()
    this.requireDatabase()
      .prepare(
        `INSERT INTO experts
          (id, name, description, system_instructions,
           capability_policy_json, model_policy_json, enabled,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(
        id,
        normalized.name,
        normalized.description,
        normalized.systemInstructions,
        JSON.stringify({
          routingKeywords: normalized.routingKeywords
        }),
        JSON.stringify({
          modelProfileId: normalized.modelProfileId
        }),
        now,
        now
      )
    return this.getExpert(id)
  }

  updateExpert(
    expertId: string,
    input: ExpertUpdateInput
  ): AssistantExpert {
    const normalized = expertCreateSchema.parse(input)
    const result = this.requireDatabase()
      .prepare(
        `UPDATE experts
         SET name = ?, description = ?, system_instructions = ?,
             capability_policy_json = ?,
             model_policy_json = ?,
             updated_at = ?
         WHERE id = ? AND enabled = 1`
      )
      .run(
        normalized.name,
        normalized.description,
        normalized.systemInstructions,
        JSON.stringify({
          routingKeywords: normalized.routingKeywords
        }),
        JSON.stringify({
          modelProfileId: normalized.modelProfileId
        }),
        new Date().toISOString(),
        expertId
      )
    if (result.changes === 0) {
      throw new Error('专家不存在或已停用')
    }
    return this.getExpert(expertId)
  }

  removeExpert(expertId: string): void {
    const result = this.requireDatabase()
      .prepare(
        `UPDATE experts
         SET enabled = 0, updated_at = ?
         WHERE id = ? AND enabled = 1`
      )
      .run(new Date().toISOString(), expertId)
    if (result.changes === 0) {
      throw new Error('专家不存在或已停用')
    }
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

  private syncMagicNoteTodos(
    database: DatabaseSync,
    noteId: string,
    entryId: string,
    content: MagicNoteRichContent,
    now: string
  ): void {
    const note = database
      .prepare('SELECT id FROM magic_notes WHERE id = ?')
      .get(noteId) as { id: string } | undefined
    if (!note) {
      throw new Error('笔记不存在')
    }
    const items = magicNoteChecklistItems(content)
    const existing = database
      .prepare(
        `SELECT id, project_id, note_id, source_index, title, completed
         FROM magic_todos
         WHERE entry_id = ? AND source = 'note'`
      )
      .all(entryId) as Array<{
      id: string
      project_id: string | null
      note_id: string | null
      source_index: number
      title: string
      completed: number
    }>
    const unmatched = new Set(existing)
    const byExactPosition = new Map(
      existing.map((todo) => [
        `${todo.source_index}\u0000${todo.title}`,
        todo
      ])
    )
    const byPosition = new Map(
      existing.map((todo) => [todo.source_index, todo])
    )
    const byTitle = new Map<string, typeof existing>()
    const unmatchedTitleCounts = new Map<string, number>()
    for (const todo of existing) {
      const titleMatches = byTitle.get(todo.title) ?? []
      titleMatches.push(todo)
      byTitle.set(todo.title, titleMatches)
      unmatchedTitleCounts.set(
        todo.title,
        (unmatchedTitleCounts.get(todo.title) ?? 0) + 1
      )
    }
    const matches: Array<{
      item: (typeof items)[number]
      matched?: (typeof existing)[number]
    }> = items.map((item) => ({ item }))
    const assign = (
      match: (typeof matches)[number],
      todo: (typeof existing)[number] | undefined
    ): void => {
      if (!todo || !unmatched.delete(todo)) {
        return
      }
      match.matched = todo
      unmatchedTitleCounts.set(
        todo.title,
        (unmatchedTitleCounts.get(todo.title) ?? 1) - 1
      )
    }
    for (const match of matches) {
      assign(
        match,
        byExactPosition.get(
          `${match.item.sourceIndex}\u0000${match.item.title}`
        )
      )
    }
    for (const match of matches.filter((candidate) => !candidate.matched)) {
      if (unmatchedTitleCounts.get(match.item.title) === 1) {
        assign(
          match,
          byTitle
            .get(match.item.title)
            ?.find((todo) => unmatched.has(todo))
        )
      }
    }
    for (const match of matches.filter((candidate) => !candidate.matched)) {
      assign(match, byPosition.get(match.item.sourceIndex))
    }
    const deleteTodo = database.prepare(
      'DELETE FROM magic_todos WHERE id = ?'
    )
    for (const todo of unmatched) {
      deleteTodo.run(todo.id)
    }
    const parkSourceIndex = database.prepare(
      `UPDATE magic_todos
       SET source_index = -source_index - 1
       WHERE id = ?`
    )
    for (const { item, matched } of matches) {
      if (matched && matched.source_index !== item.sourceIndex) {
        parkSourceIndex.run(matched.id)
      }
    }
    const insertTodo = database.prepare(
      `INSERT INTO magic_todos
        (id, project_id, note_id, entry_id, source_index, source,
         title, instructions, completed, comments_json, analyzed_at,
         revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'note', ?, '', ?, '[]', NULL, 0, ?, ?)`
    )
    const updateTodo = database.prepare(
      `UPDATE magic_todos
       SET project_id = ?, note_id = ?, source_index = ?, title = ?,
           completed = ?,
           comments_json = CASE WHEN ? THEN '[]' ELSE comments_json END,
           analyzed_at = CASE WHEN ? THEN NULL ELSE analyzed_at END,
           revision = revision + 1, updated_at = ?
       WHERE id = ?`
    )
    for (const { item, matched } of matches) {
      if (!matched) {
        insertTodo.run(
          randomUUID(),
          null,
          noteId,
          entryId,
          item.sourceIndex,
          item.title,
          Number(item.completed),
          now,
          now
        )
        continue
      }
      const titleChanged = matched.title !== item.title
      const completionChanged =
        Boolean(matched.completed) !== item.completed
      const positionChanged =
        matched.source_index !== item.sourceIndex
      const scopeChanged =
        matched.project_id !== null ||
        matched.note_id !== noteId
      if (
        !titleChanged &&
        !completionChanged &&
        !positionChanged &&
        !scopeChanged
      ) {
        continue
      }
      updateTodo.run(
        null,
        noteId,
        item.sourceIndex,
        item.title,
        Number(item.completed),
        Number(titleChanged),
        Number(titleChanged),
        now,
        matched.id
      )
    }
  }

  private assertMagicNoteEmbedBudget(
    noteId: string,
    content: MagicNoteRichContent,
    excludedEntryId?: string
  ): void {
    const existing = this.requireDatabase()
      .prepare(
        `SELECT COALESCE(SUM(image_bytes), 0) AS image_bytes
         FROM magic_note_entries
         WHERE note_id = ? AND id <> ?`
      )
      .get(noteId, excludedEntryId ?? '') as { image_bytes: number }
    if (
      existing.image_bytes + magicNoteEmbeddedBytes(content) >
      MAGIC_NOTE_MAX_NOTE_EMBED_BYTES
    ) {
      throw new Error('一篇笔记中的图片、视频和附件总大小不能超过 64 MB')
    }
  }

  private migrate(database: DatabaseSync): void {
    const version = database
      .prepare('PRAGMA user_version')
      .get() as { user_version: number }
    if (version.user_version > 18) {
      throw new Error(
        `当前 GoodBuddy 不支持助理数据库版本 ${version.user_version}，请升级应用后重试`
      )
    }
    if (version.user_version === 18) {
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
          CHECK(default_work_mode IN ('ask', 'execute')),
        runtime_selection_json TEXT,
        status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        runtime_selection_json TEXT,
        knowledge_retrieval_mode TEXT
          CHECK(
            knowledge_retrieval_mode IS NULL OR
            knowledge_retrieval_mode IN ('auto', 'always')
          ),
        work_mode TEXT NOT NULL DEFAULT 'ask'
          CHECK(work_mode IN ('ask', 'execute')),
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
          CHECK(work_mode IN ('ask', 'execute')),
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
    if (version.user_version < 2) {
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
    if (version.user_version < 3) {
      database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS heartbeat_configs (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        timezone TEXT NOT NULL,
        recurrence_json TEXT NOT NULL,
        lookback_hours INTEGER NOT NULL
          CHECK(lookback_hours BETWEEN 1 AND 720),
        retention_days INTEGER NOT NULL
          CHECK(retention_days BETWEEN 1 AND 365),
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        next_run_at TEXT NOT NULL,
        last_run_at TEXT,
        last_status TEXT
          CHECK(last_status IN ('claimed', 'completed', 'failed', 'skipped')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS heartbeat_configs_due_idx
        ON heartbeat_configs(enabled, next_run_at);
      CREATE TABLE IF NOT EXISTS heartbeat_runs (
        id TEXT PRIMARY KEY,
        config_id TEXT NOT NULL
          REFERENCES heartbeat_configs(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL CHECK(trigger IN ('scheduled', 'manual')),
        scheduled_for TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK(status IN ('claimed', 'completed', 'failed', 'skipped')),
        attempt_count INTEGER NOT NULL
          CHECK(attempt_count BETWEEN 0 AND 3),
        next_attempt_at TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        error TEXT,
        entry_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(config_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS heartbeat_runs_claim_idx
        ON heartbeat_runs(status, next_attempt_at, lease_expires_at);
      CREATE INDEX IF NOT EXISTS heartbeat_runs_history_idx
        ON heartbeat_runs(config_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS heartbeat_entries (
        id TEXT PRIMARY KEY,
        config_id TEXT NOT NULL
          REFERENCES heartbeat_configs(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL UNIQUE
          REFERENCES heartbeat_runs(id) ON DELETE CASCADE,
        scheduled_for TEXT NOT NULL,
        summary TEXT NOT NULL,
        highlights_json TEXT NOT NULL,
        artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        proposed_memory_ids_json TEXT NOT NULL,
        follow_up_task_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS heartbeat_entries_history_idx
        ON heartbeat_entries(config_id, created_at DESC);
      PRAGMA user_version = 3;
      COMMIT;
    `)
    }
    if (version.user_version < 4) {
      database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS model_usage_calls (
        request_id TEXT NOT NULL
          REFERENCES tasks(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL,
        runtime TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
        cache_read_tokens INTEGER NOT NULL CHECK(cache_read_tokens >= 0),
        cache_write_tokens INTEGER NOT NULL CHECK(cache_write_tokens >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(request_id, call_id)
      );
      CREATE INDEX IF NOT EXISTS model_usage_calls_request_idx
        ON model_usage_calls(request_id);
      CREATE INDEX IF NOT EXISTS model_usage_calls_dimensions_idx
        ON model_usage_calls(runtime, provider, model);
      PRAGMA user_version = 4;
        COMMIT;
      `)
    }
    if (version.user_version < 5) {
      database.exec(`
        BEGIN IMMEDIATE;
        CREATE INDEX IF NOT EXISTS tasks_status_idx
        ON tasks(status);
      CREATE INDEX IF NOT EXISTS messages_state_idx
        ON messages(state);
      PRAGMA user_version = 5;
        COMMIT;
      `)
    }
    if (version.user_version < 6) {
      database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS computer_control_actions (
          command_id TEXT PRIMARY KEY
            CHECK(length(command_id) BETWEEN 16 AND 160),
          task_id TEXT NOT NULL
            REFERENCES tasks(id) ON DELETE CASCADE
            CHECK(length(task_id) BETWEEN 1 AND 128),
          conversation_id TEXT NOT NULL
            CHECK(length(conversation_id) BETWEEN 1 AND 128),
          lease_id TEXT NOT NULL
            CHECK(length(lease_id) BETWEEN 16 AND 160),
          action TEXT NOT NULL
            CHECK(action IN ('observe', 'activate', 'replace_text',
              'select_option', 'scroll')),
          risk TEXT NOT NULL
            CHECK(risk IN ('observe', 'navigate', 'input', 'commit',
              'forbidden')),
          outcome TEXT NOT NULL
            CHECK(outcome IN ('completed', 'denied', 'failed',
              'outcome_unknown')),
          error_code TEXT
            CHECK(error_code IS NULL OR error_code IN (
              'invalid_request', 'driver_unavailable', 'driver_timeout',
              'lease_not_found', 'lease_expired', 'lease_mismatch',
              'observation_not_found', 'observation_stale',
              'observation_consumed', 'element_not_found',
              'window_not_foreground', 'element_identity_changed',
              'focus_failed', 'forbidden', 'approval_denied',
              'approval_timeout', 'cancelled', 'command_id_conflict',
              'outcome_unknown', 'internal_error')),
          occurred_at INTEGER NOT NULL
            CHECK(occurred_at BETWEEN 0 AND 9007199254740991),
          text_length INTEGER
            CHECK(text_length IS NULL OR
              text_length BETWEEN 0 AND 4096),
          text_digest TEXT
            CHECK(text_digest IS NULL OR (
              length(text_digest) = 64 AND
              text_digest NOT GLOB '*[^0-9a-f]*')),
          created_at TEXT NOT NULL,
          CHECK(
            (outcome = 'completed' AND error_code IS NULL) OR
            (outcome <> 'completed' AND error_code IS NOT NULL)
          ),
          CHECK(
            (action = 'replace_text' AND text_length IS NOT NULL AND
              text_digest IS NOT NULL) OR
            (action <> 'replace_text' AND text_length IS NULL AND
              text_digest IS NULL)
          )
        );
        CREATE INDEX IF NOT EXISTS computer_control_actions_recent_idx
          ON computer_control_actions(occurred_at DESC, created_at DESC);
        CREATE INDEX IF NOT EXISTS computer_control_actions_task_idx
          ON computer_control_actions(task_id, occurred_at DESC);
        PRAGMA user_version = 6;
        COMMIT;
      `)
    }
    if (version.user_version < 7) {
      const taskColumns = new Set(
        (database.prepare('PRAGMA table_info(tasks)').all() as Array<{
          name: string
        }>).map((column) => column.name)
      )
      database.exec('BEGIN IMMEDIATE')
      try {
        if (!taskColumns.has('parent_task_id')) {
          database.exec(`ALTER TABLE tasks ADD COLUMN parent_task_id TEXT
            REFERENCES tasks(id) ON DELETE CASCADE`)
        }
        if (!taskColumns.has('expert_id')) {
          database.exec(`ALTER TABLE tasks ADD COLUMN expert_id TEXT
            REFERENCES experts(id) ON DELETE SET NULL`)
        }
        if (!taskColumns.has('routing_mode')) {
          database.exec(`ALTER TABLE tasks ADD COLUMN routing_mode TEXT
            CHECK(routing_mode IS NULL OR routing_mode IN ('manual', 'smart'))`)
        }
        database.exec(`
          CREATE INDEX IF NOT EXISTS tasks_parent_task_idx
            ON tasks(parent_task_id, created_at);
          CREATE INDEX IF NOT EXISTS tasks_expert_idx
            ON tasks(expert_id, created_at);
          PRAGMA user_version = 7;
          COMMIT;
        `)
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    }
    if (version.user_version < 8) {
      const conversationColumns = new Set(
        (
          database.prepare('PRAGMA table_info(conversations)').all() as Array<{
            name: string
          }>
        ).map((column) => column.name)
      )
      database.exec('BEGIN IMMEDIATE')
      try {
        if (!conversationColumns.has('runtime_selection_json')) {
          database.exec(
            'ALTER TABLE conversations ADD COLUMN runtime_selection_json TEXT'
          )
        }
        database.exec('PRAGMA user_version = 8; COMMIT;')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    }
    if (version.user_version < 9) {
      database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS magic_notes (
          id TEXT PRIMARY KEY,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0, 1)),
          revision INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS magic_note_entries (
          id TEXT PRIMARY KEY,
          note_id TEXT NOT NULL REFERENCES magic_notes(id) ON DELETE CASCADE,
          content_json TEXT NOT NULL,
          plain_text TEXT NOT NULL,
          comments_json TEXT NOT NULL DEFAULT '[]',
          actions_json TEXT NOT NULL DEFAULT '[]',
          analyzed_at TEXT,
          revision INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS magic_notes_scope_updated_idx
          ON magic_notes(project_id, pinned DESC, updated_at DESC);
        CREATE INDEX IF NOT EXISTS magic_note_entries_note_created_idx
          ON magic_note_entries(note_id, created_at ASC);
        PRAGMA user_version = 9;
        COMMIT;
      `)
    }
    if (version.user_version < 10) {
      database.exec('BEGIN IMMEDIATE')
      try {
        database.exec(`
          CREATE TABLE IF NOT EXISTS magic_todos (
            id TEXT PRIMARY KEY,
            project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
            note_id TEXT REFERENCES magic_notes(id) ON DELETE CASCADE,
            entry_id TEXT REFERENCES magic_note_entries(id) ON DELETE CASCADE,
            source_index INTEGER,
            source TEXT NOT NULL CHECK(source IN ('note', 'manual')),
            title TEXT NOT NULL,
            instructions TEXT NOT NULL DEFAULT '',
            completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)),
            comments_json TEXT NOT NULL DEFAULT '[]',
            analyzed_at TEXT,
            revision INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK(
              (source = 'note' AND note_id IS NOT NULL AND
               entry_id IS NOT NULL AND source_index IS NOT NULL) OR
              (source = 'manual' AND note_id IS NULL AND
               entry_id IS NULL AND source_index IS NULL)
            ),
            UNIQUE(entry_id, source_index)
          );
          CREATE INDEX IF NOT EXISTS magic_todos_scope_status_idx
            ON magic_todos(project_id, completed, updated_at DESC);
          CREATE INDEX IF NOT EXISTS magic_todos_note_idx
            ON magic_todos(note_id, entry_id, source_index);
        `)
        const entries = database
          .prepare(
            `SELECT id, note_id, content_json, updated_at
             FROM magic_note_entries`
          )
          .iterate() as Iterable<{
          id: string
          note_id: string
          content_json: string
          updated_at: string
        }>
        for (const entry of entries) {
          this.syncMagicNoteTodos(
            database,
            entry.note_id,
            entry.id,
            JSON.parse(entry.content_json) as MagicNoteRichContent,
            entry.updated_at
          )
        }
        database.exec('PRAGMA user_version = 10')
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    }
    if (version.user_version < 11) {
      const hasVisibilityColumn = (
        database.prepare('PRAGMA table_info(tasks)').all() as Array<{
          name: string
        }>
      ).some((column) => column.name === 'visible')
      database.exec('BEGIN IMMEDIATE')
      try {
        if (!hasVisibilityColumn) {
          database.exec(`
            ALTER TABLE tasks
              ADD COLUMN visible INTEGER NOT NULL DEFAULT 1
                CHECK(visible IN (0, 1));
          `)
        }
        database.exec('PRAGMA user_version = 11')
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    }
    if (version.user_version < 12) {
      const hasImageBytesColumn = (
        database
          .prepare('PRAGMA table_info(magic_note_entries)')
          .all() as Array<{ name: string }>
      ).some((column) => column.name === 'image_bytes')
      database.exec('BEGIN IMMEDIATE')
      try {
        if (!hasImageBytesColumn) {
          database.exec(`
            ALTER TABLE magic_note_entries
              ADD COLUMN image_bytes INTEGER NOT NULL DEFAULT 0
                CHECK(image_bytes >= 0);
          `)
        }
        const entries = database
          .prepare('SELECT id, content_json FROM magic_note_entries')
          .iterate() as Iterable<{
          id: string
          content_json: string
        }>
        const updateImageBytes = database.prepare(
          `UPDATE magic_note_entries
           SET image_bytes = ?
           WHERE id = ?`
        )
        for (const entry of entries) {
          updateImageBytes.run(
            magicNoteImageBytes(
              JSON.parse(entry.content_json) as MagicNoteRichContent
            ),
            entry.id
          )
        }
        database.exec('PRAGMA user_version = 12')
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    }
    if (version.user_version < 13) {
      const projectColumns = new Set(
        (
          database.prepare('PRAGMA table_info(projects)').all() as Array<{
            name: string
          }>
        ).map((column) => column.name)
      )
      database.exec('BEGIN IMMEDIATE')
      try {
        if (!projectColumns.has('kind')) {
          database.exec(`
            ALTER TABLE projects
              ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'
                CHECK(kind IN ('user', 'channel'));
          `)
        }
        if (!projectColumns.has('channel')) {
          database.exec(`
            ALTER TABLE projects
              ADD COLUMN channel TEXT
                CHECK(
                  channel IS NULL OR
                  channel IN ('weixin', 'wecom', 'dingtalk')
                );
          `)
        }
        database.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS projects_channel_unique
            ON projects(channel)
            WHERE channel IS NOT NULL;
          PRAGMA user_version = 13;
          COMMIT;
        `)
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    }
    if (version.user_version < 14) {
      const conversationColumns = new Set(
        (
          database
            .prepare('PRAGMA table_info(conversations)')
            .all() as Array<{ name: string }>
        ).map((column) => column.name)
      )
      database.exec('BEGIN IMMEDIATE')
      try {
        if (!conversationColumns.has('channel')) {
          database.exec(`
            ALTER TABLE conversations ADD COLUMN channel TEXT
              CHECK(
                channel IS NULL OR
                channel IN ('weixin', 'wecom', 'dingtalk')
              );
          `)
        }
        if (!conversationColumns.has('external_account_id')) {
          database.exec(`
            ALTER TABLE conversations
              ADD COLUMN external_account_id TEXT;
          `)
        }
        if (!conversationColumns.has('external_conversation_id')) {
          database.exec(`
            ALTER TABLE conversations
              ADD COLUMN external_conversation_id TEXT;
          `)
        }
        if (!conversationColumns.has('conversation_type')) {
          database.exec(`
            ALTER TABLE conversations ADD COLUMN conversation_type TEXT
              CHECK(
                conversation_type IS NULL OR
                conversation_type IN ('direct', 'group')
              );
          `)
        }
        if (!conversationColumns.has('account_display')) {
          database.exec(`
            ALTER TABLE conversations ADD COLUMN account_display TEXT;
          `)
        }
        database.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS
            conversations_remote_identity_unique
          ON conversations(
            channel,
            external_account_id,
            external_conversation_id
          )
          WHERE channel IS NOT NULL;
          PRAGMA user_version = 14;
          COMMIT;
        `)
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    }
    if (version.user_version < 15) {
      database.exec('BEGIN IMMEDIATE')
      try {
        database.exec(`
          CREATE TABLE IF NOT EXISTS channel_events (
            channel TEXT NOT NULL,
            event_id TEXT NOT NULL,
            claimed_at INTEGER NOT NULL,
            PRIMARY KEY(channel, event_id)
          );
          CREATE INDEX IF NOT EXISTS channel_events_claimed_at
            ON channel_events(claimed_at);
          CREATE TABLE IF NOT EXISTS channel_outbox (
            id TEXT PRIMARY KEY,
            channel TEXT NOT NULL,
            event_id TEXT NOT NULL,
            message_json TEXT NOT NULL,
            state TEXT NOT NULL
              CHECK(state IN ('pending', 'delivered', 'failed')),
            attempts INTEGER NOT NULL,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS channel_outbox_state_created
            ON channel_outbox(state, created_at);
          PRAGMA user_version = 15;
          COMMIT;
        `)
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    }
    if (version.user_version < 16) {
      database.exec('BEGIN IMMEDIATE')
      try {
        const projectColumns = new Set(
          (
            database.prepare('PRAGMA table_info(projects)').all() as Array<{
              name: string
            }>
          ).map((column) => column.name)
        )
        if (!projectColumns.has('runtime_selection_json')) {
          database.exec(`
            ALTER TABLE projects ADD COLUMN runtime_selection_json TEXT;
          `)
        }
        database.exec(`
          UPDATE projects
          SET runtime_selection_json = '{"provider":"auto"}'
          WHERE kind = 'channel' AND runtime_selection_json IS NULL;
          PRAGMA user_version = 16;
          COMMIT;
        `)
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    }
    if (version.user_version < 17) {
      database.exec('BEGIN IMMEDIATE')
      try {
        database.exec(`
          UPDATE magic_notes SET project_id = NULL
          WHERE project_id IS NOT NULL;
          UPDATE magic_todos SET project_id = NULL
          WHERE source = 'note' AND project_id IS NOT NULL;
        `)
        const manualTodos = database
          .prepare(
            `SELECT id, title, instructions, completed, comments_json,
                    analyzed_at, revision, created_at, updated_at
             FROM magic_todos
             WHERE source = 'manual'
             ORDER BY created_at ASC, rowid ASC`
          )
          .all() as Array<{
          id: string
          title: string
          instructions: string
          completed: number
          comments_json: string
          analyzed_at: string | null
          revision: number
          created_at: string
          updated_at: string
        }>
        if (manualTodos.length > 0) {
          const noteId = randomUUID()
          const createdAt = manualTodos[0]!.created_at
          const updatedAt = manualTodos.at(-1)!.updated_at
          database
            .prepare(
              `INSERT INTO magic_notes
                (id, project_id, title, pinned, revision,
                 created_at, updated_at)
               VALUES (?, NULL, '迁入的待办', 0, 0, ?, ?)`
            )
            .run(noteId, createdAt, updatedAt)
          const insertEntry = database.prepare(
            `INSERT INTO magic_note_entries
              (id, note_id, content_json, plain_text, comments_json,
               actions_json, analyzed_at, revision, created_at, updated_at,
               image_bytes)
             VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, 0)`
          )
          const updateMigratedTodo = database.prepare(
            `UPDATE magic_todos
             SET instructions = ?, comments_json = ?, analyzed_at = ?,
                 revision = ?
             WHERE entry_id = ? AND source = 'note'`
          )
          const deleteManualTodo = database.prepare(
            `DELETE FROM magic_todos
             WHERE id = ? AND source = 'manual'`
          )
          for (const todo of manualTodos) {
            const entryId = randomUUID()
            const content: MagicNoteRichContent = {
              version: 1,
              ops: [
                { insert: todo.title },
                {
                  insert: '\n',
                  attributes: {
                    list: todo.completed ? 'checked' : 'unchecked'
                  }
                },
                ...(todo.instructions
                  ? [
                      { insert: todo.instructions },
                      { insert: '\n' }
                    ]
                  : [])
              ]
            }
            insertEntry.run(
              entryId,
              noteId,
              JSON.stringify(content),
              [todo.title, todo.instructions].filter(Boolean).join('\n'),
              todo.comments_json,
              todo.analyzed_at,
              todo.revision,
              todo.created_at,
              todo.updated_at
            )
            this.syncMagicNoteTodos(
              database,
              noteId,
              entryId,
              content,
              todo.updated_at
            )
            updateMigratedTodo.run(
              todo.instructions,
              todo.comments_json,
              todo.analyzed_at,
              todo.revision,
              entryId
            )
            deleteManualTodo.run(todo.id)
          }
        }
        database.exec('PRAGMA user_version = 17')
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    }
    if (version.user_version < 18) {
      database.exec('BEGIN IMMEDIATE')
      try {
        const conversationColumns = new Set(
          (
            database
              .prepare('PRAGMA table_info(conversations)')
              .all() as Array<{ name: string }>
          ).map((column) => column.name)
        )
        if (!conversationColumns.has('knowledge_retrieval_mode')) {
          database.exec(`
            ALTER TABLE conversations
              ADD COLUMN knowledge_retrieval_mode TEXT
              CHECK(
                knowledge_retrieval_mode IS NULL OR
                knowledge_retrieval_mode IN ('auto', 'always')
              );
          `)
        }
        database.exec('PRAGMA user_version = 18; COMMIT;')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    }
  }

  private requireDatabase(): DatabaseSync {
    if (!this.database) {
      throw new Error('助手数据库尚未初始化')
    }
    return this.database
  }
}
