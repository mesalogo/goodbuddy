import { createContext, useContext, useEffect, useId } from 'react'

/**
 * Reports unsaved edits from inside a kept-alive workspace route. The route
 * cache pins any route with unsaved edits so eviction never discards them
 * silently.
 */
export type ReportWorkspaceUnsavedChanges = (
  sourceId: string,
  dirty: boolean
) => void

export const WorkspaceUnsavedChangesContext = createContext<
  ReportWorkspaceUnsavedChanges | undefined
>(undefined)

export function useWorkspaceUnsavedChanges(dirty: boolean): void {
  const report = useContext(WorkspaceUnsavedChangesContext)
  const sourceId = useId()
  useEffect(() => {
    if (!report) return
    report(sourceId, dirty)
    return () => report(sourceId, false)
  }, [dirty, report, sourceId])
}
