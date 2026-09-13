export type ConversationActivity = {
  conversationId: string
  projectId?: string
  title: string
  projectName: string
  status: 'running' | 'approval' | 'question' | 'attention'
}

export type ConversationActivitySummary = {
  activities: ConversationActivity[]
  byProjectId: Record<string, { running: number; attention: number }>
  running: number
  attention: number
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
  fallbackProjectName: string
): ConversationActivitySummary {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]))
  const metadata = new Map(conversations.map((conversation) => [conversation.id, conversation]))
  const rows = new Map<string, ConversationActivity>()
  const priority = { running: 0, attention: 1, approval: 2, question: 3 }

  for (const conversation of conversations) {
    let status: ConversationActivity['status'] | undefined =
      activeConversationIds.has(conversation.id) ? 'running' : undefined
    for (const message of conversation.messages) {
      const candidate = message.pendingQuestions?.length
        ? 'question'
        : message.approval
          ? 'approval'
          : message.state === 'streaming'
            ? 'running'
            : undefined
      if (candidate && (!status || priority[candidate] > priority[status])) {
        status = candidate
      }
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
    if (!task.conversationId || (task.status !== 'running' && task.status !== 'waiting_approval')) {
      continue
    }
    // Tasks use waiting_approval for both approvals and questions.
    const status = task.status === 'waiting_approval' ? 'attention' : 'running'
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
    attention: 0
  }
  const counts = new Map<string, { running: number; attention: number }>()
  for (const activity of summary.activities) {
    const category = activity.status === 'running' ? 'running' : 'attention'
    summary[category] += 1
    if (activity.projectId !== undefined) {
      const project = counts.get(activity.projectId) ?? { running: 0, attention: 0 }
      project[category] += 1
      counts.set(activity.projectId, project)
    }
  }
  summary.byProjectId = Object.fromEntries(counts)
  return summary
}
