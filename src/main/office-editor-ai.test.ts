// @vitest-environment node
import { expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { ConversationSnapshot } from '../shared/assistant-contracts'
vi.mock('electron', () => ({ dialog: {}, ipcMain: {}, WebContentsView: class {} }))
import { OfficeService } from './office-service'

it('binds the editor modal to its opening conversation and rejects foreign frames and request IDs', async () => {
  const instanceId = '10000000-0000-4000-8000-000000000001'
  const original = '10000000-0000-4000-8000-000000000002'
  const other = '10000000-0000-4000-8000-000000000003'
  const documentId = 'a'.repeat(32), serverUrl = 'http://192.168.0.23:8088'
  const mainFrame = { url: `${serverUrl}/office/editor?document=${documentId}` }
  const executeJavaScript = vi.fn(async (script: string) => script.includes('.replace(') ? true : { text: '[["old","=1+2"]]', epoch: 1 })
  const sender = { mainFrame, executeJavaScript }
  const snapshot = { id: original, title: 'original chat', updatedAt: 1, messages: [] } as ConversationSnapshot
  const reader = vi.fn(async () => snapshot)
  const service = new OfficeService({} as never, '/tmp/worker.js', undefined, reader)
  const sessions = Reflect.get(service, 'sessions') as Map<string, unknown>
  sessions.set(instanceId, { instanceId, serverUrl, document: { id: documentId, name: 'table.xlsx' }, view: { webContents: sender }, busy: false })
  const event = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  const enqueue = vi.fn(async () => 'queue-1')
  service.context({ instanceId, conversationId: original })
  await expect(service.editorRequest({ sender, senderFrame: { ...mainFrame } } as unknown as IpcMainInvokeEvent, { action: 'context' }, enqueue)).rejects.toThrow('来源')
  expect(await service.editorRequest(event, { action: 'context' }, enqueue)).toEqual({ conversationTitle: 'original chat' })
  service.context({ instanceId, conversationId: other })
  const result = await service.editorRequest(event, { action: 'ask', instruction: '修改文字' }, enqueue)
  expect(result).toMatchObject({ requestId: 'queue-1' })
  expect(enqueue).toHaveBeenCalledWith(original, expect.stringContaining('所有以 = 开头的公式必须原样保留'))
  await expect(service.editorRequest(event, { action: 'apply', requestId: 'different', text: 'wrong' }, enqueue)).rejects.toThrow('失效')
  await service.editorRequest(event, { action: 'apply', requestId: 'queue-1', text: '[["new","=1+2"]]' }, enqueue)
  expect(executeJavaScript).toHaveBeenLastCalledWith(expect.stringContaining('"allowFormulas":false'))
})
