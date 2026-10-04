import { expect, it, vi } from 'vitest'
import type { DesktopApi } from '../shared/contracts'
import { ipcChannels } from '../shared/ipc-channels'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  webUtils: {}
}))
vi.mock('electron', () => electron)

it('reads execution statistics through the explicit typed bridge', async () => {
  await import('./index')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls[0]![1] as DesktopApi
  const summary = { durationMs: 1000, runningCount: 0, incomplete: false, asOf: 2000, taskDurations: [{ id: 'task', durationMs: 1000, runningCount: 0, incomplete: false }] }
  electron.ipcRenderer.invoke.mockResolvedValue(summary)
  for (const scope of [{ conversationId: 'conversation' }, { projectId: 'project' }]) {
    expect(await api.tasks.getExecutionStats(scope)).toBe(summary)
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(ipcChannels.tasksExecutionStats, scope)
  }
  const listener = vi.fn()
  const unsubscribe = api.tasks.onExecutionStatsChanged(listener)
  const handler = electron.ipcRenderer.on.mock.calls.find(([channel]) => channel === ipcChannels.tasksExecutionStatsChanged)![1]
  handler()
  expect(listener).toHaveBeenCalledOnce()
  unsubscribe()
  expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(ipcChannels.tasksExecutionStatsChanged, handler)
})
