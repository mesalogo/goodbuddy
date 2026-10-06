import { startTransition, useEffect, useState } from 'react'
import type { ExecutionStats } from '../../shared/assistant-contracts'

export function useExecutionStats(
  conversationId: string | undefined,
  projectId: string | undefined,
  enabled: boolean
): { conversation?: ExecutionStats; project?: ExecutionStats } {
  const key = JSON.stringify([projectId, conversationId])
  const [snapshot, setSnapshot] = useState<{
    key: string; conversation?: ExecutionStats; project?: ExecutionStats
  }>()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!enabled || !projectId) return
    let cancelled = false
    let revision = 0
    let inFlight = false
    let queued = false
    const refresh = async (): Promise<void> => {
      revision++
      if (inFlight) { queued = true; return }
      inFlight = true
      queued = false
      const current = revision
      const [conversation, project] = await Promise.allSettled([
        conversationId
          ? window.goodbuddy.tasks.getExecutionStats({ conversationId })
          : Promise.resolve(undefined),
        window.goodbuddy.tasks.getExecutionStats({ projectId })
      ])
      inFlight = false
      if (!cancelled && queued) { void refresh(); return }
      if (cancelled || current !== revision) return
      startTransition(() => {
        if (cancelled || current !== revision) return
        setNow(Date.now())
        setSnapshot({ key,
          conversation: conversation.status === 'fulfilled' ? conversation.value : undefined,
          project: project.status === 'fulfilled' ? project.value : undefined })
      })
    }
    const unsubscribe = window.goodbuddy.tasks.onExecutionStatsChanged(() => { void refresh() })
    void refresh()
    return () => { cancelled = true; unsubscribe() }
  }, [conversationId, projectId, key, enabled])

  const current = enabled && snapshot?.key === key ? snapshot : undefined
  const running = Boolean(current?.conversation?.runningCount || current?.project?.runningCount)
  useEffect(() => {
    if (!running) return
    // Display only: no IPC or persistence on ticks, including in background tabs.
    const interval = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [running])
  const display = (value: ExecutionStats | undefined): ExecutionStats | undefined => {
    if (!value?.runningCount) return value
    const elapsed = Math.max(0, now - value.asOf)
    return { ...value, durationMs: value.durationMs + elapsed * value.runningCount,
      taskDurations: value.taskDurations.map((task) => ({ ...task,
        durationMs: task.durationMs + elapsed * task.runningCount })) }
  }
  return { conversation: display(current?.conversation), project: display(current?.project) }
}
