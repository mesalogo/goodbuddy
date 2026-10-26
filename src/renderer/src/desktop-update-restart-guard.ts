import { hasUnsavedWorkspaceChanges } from './workspace-unsaved-changes'

type RestartReadiness = {
  ready: boolean
  activeRequests: number
  taskStatuses: readonly string[]
  hasComposerDrafts: boolean
  knowledgeBusy: boolean
}

export function assertDesktopUpdateRestartReady(input: RestartReadiness): void {
  if (!input.ready) throw new Error('会话尚未加载完成，请稍后重启更新')
  if (input.activeRequests || input.knowledgeBusy || input.taskStatuses.some(status => ['queued', 'running', 'waiting_approval'].includes(status))) {
    throw new Error('仍有任务正在进行，请完成后重启更新')
  }
  if (input.hasComposerDrafts || hasUnsavedWorkspaceChanges() || !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))) {
    throw new Error('仍有未保存的编辑或输入草稿，请先保存或处理后再重启更新')
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
