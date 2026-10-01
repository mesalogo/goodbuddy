export type ConversationActivity = {
  conversationId: string
  projectId?: string
  title: string
  projectName: string
  status: 'running' | 'approval' | 'question' | 'attention' | 'completed'
}

export type ConversationActivitySummary = {
  activities: ConversationActivity[]
  byProjectId: Record<string, { running: number; attention: number; completed: number }>
  running: number
  attention: number
  completed: number
}

type ActivityMessage = { state?: string; approval?: unknown; pendingQuestions?: readonly unknown[] }
type MessageStatus = 'running' | 'approval' | 'question' | undefined
const statusPriority = { completed: -1, running: 0, attention: 1, approval: 2, question: 3 }

// Message arrays are replaced rather than mutated, so unchanged conversations
// reuse their scan while one conversation streams.
const messageStatuses = new WeakMap<readonly ActivityMessage[], MessageStatus>()

function highestMessageStatus(messages: readonly ActivityMessage[]): MessageStatus {
  if (messageStatuses.has(messages)) return messageStatuses.get(messages)
  let status: MessageStatus
  for (const message of messages) {
    const candidate = message.pendingQuestions?.length
      ? 'question'
      : message.approval
        ? 'approval'
        : message.state === 'streaming'
          ? 'running'
          : undefined
    if (candidate && (!status || statusPriority[candidate] > statusPriority[status])) {
      status = candidate
    }
  }
  messageStatuses.set(messages, status)
  return status
}

export function sameActivitySummary(left: ConversationActivitySummary, right: ConversationActivitySummary): boolean {
  if (left.running !== right.running || left.attention !== right.attention ||
    left.completed !== right.completed || left.activities.length !== right.activities.length) return false
  for (let index = 0; index < left.activities.length; index++) {
    const a = left.activities[index]!
    const b = right.activities[index]!
    if (a.conversationId !== b.conversationId || a.projectId !== b.projectId || a.title !== b.title ||
      a.projectName !== b.projectName || a.status !== b.status) return false
  }
  const leftProjects = Object.keys(left.byProjectId)
  if (leftProjects.length !== Object.keys(right.byProjectId).length) return false
  return leftProjects.every((projectId) => {
    const a = left.byProjectId[projectId]!
    const b = right.byProjectId[projectId]
    return b !== undefined && a.running === b.running && a.attention === b.attention && a.completed === b.completed
  })
}

export function deriveConversationActivity(
  conversations: readonly {
    id: string
    title: string
    projectId?: string
    messages: readonly { state?: string; approval?: unknown; pendingQuestions?: readonly unknown[] }[]
  }[],
  tasks: readonly {
    conversationId?: string
    projectId?: string
    title: string
    status: string
  }[],
  activeConversationIds: ReadonlySet<string>,
  projects: readonly { id: string; name: string }[],
  fallbackProjectName: string,
  completedConversationIds: ReadonlySet<string> = new Set()
): ConversationActivitySummary {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]))
  const metadata = new Map(conversations.map((conversation) => [conversation.id, conversation]))
  const rows = new Map<string, ConversationActivity>()
  const priority = statusPriority

  for (const conversation of conversations) {
    let status: ConversationActivity['status'] | undefined =
      activeConversationIds.has(conversation.id) ? 'running'
        : completedConversationIds.has(conversation.id) ? 'completed' : undefined
    const candidate = highestMessageStatus(conversation.messages)
    if (candidate && (!status || priority[candidate] > priority[status])) {
      status = candidate
    }
    if (status) {
      rows.set(conversation.id, {
        conversationId: conversation.id,
        projectId: conversation.projectId,
        title: conversation.title,
        projectName: projectNames.get(conversation.projectId ?? '') ?? fallbackProjectName,
        status
      })
    }
  }

  for (const task of tasks) {
    if (!task.conversationId || (task.status !== 'running' && task.status !== 'waiting_approval'
      && !completedConversationIds.has(task.conversationId))) {
      continue
    }
    // Tasks use waiting_approval for both approvals and questions.
    const status = task.status === 'waiting_approval' ? 'attention'
      : task.status === 'running' ? 'running' : 'completed'
    const existing = rows.get(task.conversationId)
    if (existing) {
      if (priority[status] > priority[existing.status]) existing.status = status
      continue
    }
    const conversation = metadata.get(task.conversationId)
    const projectId = conversation ? conversation.projectId : task.projectId
    rows.set(task.conversationId, {
      conversationId: task.conversationId,
      projectId,
      title: conversation ? conversation.title : task.title,
      projectName: projectNames.get(projectId ?? '') ?? fallbackProjectName,
      status
    })
  }

  const summary: ConversationActivitySummary = {
    activities: [...rows.values()],
    byProjectId: {},
    running: 0,
    attention: 0,
    completed: 0
  }
  const counts = new Map<string, { running: number; attention: number; completed: number }>()
  for (const activity of summary.activities) {
    const category = activity.status === 'running' || activity.status === 'completed' ? activity.status : 'attention'
    summary[category] += 1
    if (activity.projectId !== undefined) {
      const project = counts.get(activity.projectId) ?? { running: 0, attention: 0, completed: 0 }
      project[category] += 1
      counts.set(activity.projectId, project)
    }
  }
  summary.byProjectId = Object.fromEntries(counts)
  return summary
}
