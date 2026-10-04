import { expect, it, vi } from 'vitest'
import type { DesktopApi } from '../shared/contracts'
import { ipcChannels } from '../shared/ipc-channels'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  webUtils: {}
}))
vi.mock('electron', () => electron)

it('exposes Runtime question responses without the removed approval endpoint', async () => {
  await import('./index')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls[0]![1] as DesktopApi
  expect(api.agent).not.toHaveProperty('respondApproval')
  expect(ipcChannels).not.toHaveProperty('agentApprovalRespond')
  await api.agent.respondQuestion('question-id', [])
  expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(
    ipcChannels.agentQuestionRespond, { questionId: 'question-id', answers: [] }
  )
})
