import { startTransition, useEffect, useState } from 'react'
import type { ExecutionStats } from '../../shared/assistant-contracts'

// Keep timing evidence in Main; never extrapolate a stopped or disconnected run.
export function useExecutionStats(
  conversationId: string | undefined,
  projectId: string | undefined,
  revision: string,
  enabled: boolean
): { conversation?: ExecutionStats; project?: ExecutionStats } {
  const [snapshots, setSnapshots] = useState(() => new Map<string, ExecutionStats>())
  const conversationKey = JSON.stringify([projectId, conversationId])
  const projectKey = JSON.stringify([projectId])
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
      if (!cancelled) startTransition(() => setSnapshots((current) => {
        if (cancelled) return current
        const next = new Map(current)
        // IPC clones cached snapshots. Preserve references when their contents are unchanged
        // so idle polling does not rerender App and rebuild task duration maps.
        for (const [key, result] of [[conversationKey, conversation], [projectKey, project]] as const) {
          const value = result.status === 'fulfilled' ? result.value : undefined
          if (JSON.stringify(current.get(key)) === JSON.stringify(value)) continue
          if (value) next.set(key, value)
          else next.delete(key)
        }
        return next.size === current.size &&
          next.get(conversationKey) === current.get(conversationKey) &&
          next.get(projectKey) === current.get(projectKey) ? current : next
      }))
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
  }, [conversationId, projectId, conversationKey, projectKey, revision, enabled])
  return {
    conversation: enabled && projectId && conversationId
      ? snapshots.get(conversationKey) : undefined,
    project: enabled && projectId ? snapshots.get(projectKey) : undefined
  }
}
