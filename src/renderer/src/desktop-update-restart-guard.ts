import { hasUnsavedWorkspaceChanges } from './workspace-unsaved-changes'
import i18n from './i18n'

type RestartReadiness = {
  ready: boolean
  activeRequests: number
  taskStatuses: readonly string[]
  hasComposerDrafts: boolean
  knowledgeBusy: boolean
}

export function assertDesktopUpdateRestartReady(input: RestartReadiness): void {
  if (!input.ready) throw new Error(i18n.t('settingsSections:updates.errors.restartNotReady'))
  if (input.activeRequests || input.knowledgeBusy || input.taskStatuses.some(status => ['queued', 'running', 'waiting_approval'].includes(status))) {
    throw new Error(i18n.t('settingsSections:updates.errors.restartBusy'))
  }
  if (input.hasComposerDrafts || hasUnsavedWorkspaceChanges() || !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))) {
    throw new Error(i18n.t('settingsSections:updates.errors.restartUnsaved'))
  }
}

export async function persistForDesktopQuit(
  reason: 'update' | undefined,
  readState: () => RestartReadiness,
  persist: () => Promise<void>
): Promise<void> {
  if (reason === 'update') assertDesktopUpdateRestartReady(readState())
  await persist()
  if (reason === 'update') assertDesktopUpdateRestartReady(readState())
}
