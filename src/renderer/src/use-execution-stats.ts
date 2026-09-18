import { useEffect, useState } from 'react'
import type { ExecutionStats } from '../../shared/assistant-contracts'

// Keep timing evidence in Main; never extrapolate a stopped or disconnected run.
export function useExecutionStats(
  conversationId: string | undefined,
  projectId: string | undefined,
  revision: string,
  enabled: boolean
): { conversation?: ExecutionStats; project?: ExecutionStats } {
  const [snapshot, setSnapshot] = useState<{
    conversationId?: string; projectId?: string
    conversation?: ExecutionStats; project?: ExecutionStats
  }>({})
  useEffect(() => {
    if (!enabled || !projectId) return
    let cancelled = false
    let pending = false
    const refresh = async (): Promise<void> => {
      if (pending || document.visibilityState === 'hidden') return
      pending = true
      const [conversation, project] = await Promise.allSettled([
        conversationId
          ? window.goodbuddy.tasks.getExecutionStats({ conversationId })
          : Promise.resolve(undefined),
        window.goodbuddy.tasks.getExecutionStats({ projectId })
      ])
      pending = false
      if (!cancelled) setSnapshot({
        conversationId, projectId,
        conversation: conversation.status === 'fulfilled' ? conversation.value : undefined,
        project: project.status === 'fulfilled' ? project.value : undefined
      })
    }
    void refresh()
    const interval = window.setInterval(() => { void refresh() }, 5_000)
    const onFocus = (): void => { void refresh() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [conversationId, projectId, revision, enabled])
  return {
    conversation: enabled && snapshot.projectId === projectId && snapshot.conversationId === conversationId
      ? snapshot.conversation : undefined,
    project: enabled && snapshot.projectId === projectId ? snapshot.project : undefined
  }
}
