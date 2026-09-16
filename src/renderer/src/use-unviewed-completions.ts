import { useCallback, useEffect, useState } from 'react'

type Task = { id: string; conversationId?: string; parentTaskId?: string; status: string }

// Session-only notifications: initial task history is a baseline, not unread work.
export function useUnviewedCompletions(tasks: readonly Task[], viewedConversationId?: string): {
  completedConversationIds: ReadonlySet<string>
  markConversationCompleted: (id: string) => void
  clearConversationCompleted: (id: string) => void
} {
  const [completed, setCompleted] = useState<Set<string>>(() => new Set())
  const [previousTasks, setPreviousTasks] = useState(tasks)
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const update = (): void => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  let next = completed
  if (previousTasks !== tasks) {
    const previous = new Map(previousTasks.map(task => [task.id, task.status]))
    next = new Set(completed)
    for (const task of tasks) {
      if (!task.conversationId || task.parentTaskId || previous.get(task.id) === task.status) continue
      if (task.status === 'completed' && previous.has(task.id)) next.add(task.conversationId)
      else if (task.status === 'running' || task.status === 'waiting_approval') next.delete(task.conversationId)
    }
    setPreviousTasks(tasks)
  }
  if (visible && viewedConversationId && next.has(viewedConversationId)) {
    next = new Set(next)
    next.delete(viewedConversationId)
  }
  if (next !== completed) setCompleted(next)
  const markConversationCompleted = useCallback((id: string) => {
    setCompleted(current => current.has(id) ? current : new Set(current).add(id))
  }, [])
  const clearConversationCompleted = useCallback((id: string) => {
    setCompleted(current => {
      if (!current.has(id)) return current
      const remaining = new Set(current)
      remaining.delete(id)
      return remaining
    })
  }, [])
  return { completedConversationIds: next, markConversationCompleted, clearConversationCompleted }
}
