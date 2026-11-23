// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
const mocks = vi.hoisted(() => ({ job: vi.fn(), message: vi.fn(), choose: vi.fn() }))
vi.mock('electron', () => ({ dialog: { showMessageBox: mocks.message, showSaveDialog: mocks.choose }, ipcMain: {}, WebContentsView: class {} }))
vi.mock('node:worker_threads', () => ({ Worker: class extends EventEmitter {
  constructor(_path: string, options: { workerData: unknown }) {
    super()
    queueMicrotask(() => { Promise.resolve().then(() => mocks.job(options.workerData)).then(result => this.emit('message', { result }), error => this.emit('message', { error: error.message })) })
  }
} }))
import { OfficeService } from './office-service'

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })
function setup(readOnlySource = false) {
  const document = { id: 'a'.repeat(32), name: 'test.docx', revision: 2, size: 20, digest: 'b'.repeat(64), state: 'editing', updatedAt: 1 }
  const mainFrame = { url: `http://192.168.0.23:8088/office/editor?document=${document.id}` }
  const sender = { mainFrame, executeJavaScript: vi.fn().mockResolvedValue({ ready: 'true', dirty: 'false' }), isDestroyed: () => false, close: vi.fn() }
  const session = { instanceId: 'test', serverUrl: 'http://192.168.0.23:8088', path: '/source.docx', digest: 'c'.repeat(64), document: { ...document, revision: 1 }, view: { webContents: sender, setVisible: vi.fn(), setBounds: vi.fn() }, busy: false, syncedRevision: 1, readOnlySource, visible: true }
  const send = vi.fn()
  const service = new OfficeService({ webContents: { send }, contentView: { removeChildView: vi.fn() } } as never, '/worker.js')
  Reflect.get(service, 'sessions').set('test', session)
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => document })
  vi.stubGlobal('fetch', fetcher)
  mocks.job.mockResolvedValue({ document, digest: document.digest })
  mocks.message.mockResolvedValue({ response: 0 })
  const notify = (revision = 2) => service.editorRequest({ sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent, { action: 'persisted', revision }, vi.fn())
  return { service, send, session, document, notify, fetcher }
}

it('writes a confirmed revision once without forcing another save or hiding the editor', async () => {
  const { session, notify, fetcher } = setup()
  await notify(1)
  expect(fetcher).not.toHaveBeenCalled()
  await Promise.all([notify(), notify()])
  await notify()
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 'GET' }))
  expect(mocks.job).toHaveBeenCalledTimes(1)
  expect(mocks.job).toHaveBeenCalledWith(expect.objectContaining({ action: 'download', expectedDigest: 'c'.repeat(64), document: expect.objectContaining({ revision: 2 }) }))
  expect(session.syncedRevision).toBe(2)
  expect(session.view.setVisible).not.toHaveBeenCalledWith(false)
})

it('pauses automatic writes after a conflict without advancing the source digest', async () => {
  const { session, notify, send } = setup()
  mocks.job.mockRejectedValue(new Error('源文件已被其他程序修改'))
  await notify()
  await notify(3)
  expect(mocks.job).toHaveBeenCalledTimes(1)
  expect(mocks.message).not.toHaveBeenCalled()
  expect(send).toHaveBeenCalledWith('office:interaction', expect.objectContaining({ kind: 'error', closing: false }))
  expect(session.syncedRevision).toBe(1)
  expect(session.digest).toBe('c'.repeat(64))
})

it('does not repeatedly prompt or write when first save-as is cancelled', async () => {
  const { notify } = setup(true)
  mocks.choose.mockResolvedValue({ canceled: true })
  await notify()
  await notify(3)
  expect(mocks.choose).toHaveBeenCalledTimes(1)
  expect(mocks.job).not.toHaveBeenCalled()
})

it('waits until a manual save or close decision settles', async () => {
  const { session, notify, fetcher } = setup()
  session.busy = true
  await notify()
  session.busy = false
  Object.assign(session, { closing: true })
  await notify()
  expect(fetcher).not.toHaveBeenCalled()
})

it('awaits the remote source commit before advancing the saved revision', async () => {
  const { session, notify, document } = setup()
  const commit = vi.fn().mockRejectedValueOnce(new Error('Host disconnected')).mockResolvedValue(undefined)
  Object.assign(session, { source: { commit } })
  await notify()
  expect(commit).toHaveBeenCalledWith('/source.docx', 'c'.repeat(64), document.digest)
  expect(session.syncedRevision).toBe(1)
  expect(session.digest).toBe('c'.repeat(64))
  expect(mocks.job.mock.calls[0]?.[0]).not.toHaveProperty('expectedDigest')
})

it('closes a synchronized document without asking or rewriting the source', async () => {
  const { service, session, document, send } = setup()
  session.syncedRevision = document.revision
  expect(await service.close('test')).toBe(true)
  expect(session.view.webContents.close).toHaveBeenCalledOnce()
  expect(mocks.job).not.toHaveBeenCalled()
  expect(mocks.message).not.toHaveBeenCalled()
  expect(send.mock.calls.some(([, event]) => event.kind === 'confirm')).toBe(false)
})

it('keeps a close confirmation in the document and restores the same editor on cancel', async () => {
  const { service, session, send } = setup()
  const closing = service.close('test')
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith('office:interaction', expect.objectContaining({ kind: 'confirm', instanceId: 'test' })))
  service.viewport({ instanceId: 'test', visible: true, x: 0, y: 0, width: 100, height: 100 })
  expect(session.view.setVisible).toHaveBeenLastCalledWith(false)
  service.resolveClose('test', 'cancel')
  expect(await closing).toBe(false)
  expect(session.view.webContents.close).not.toHaveBeenCalled()
  expect(session.view.setVisible).toHaveBeenLastCalledWith(true)
  expect(mocks.message).not.toHaveBeenCalled()
})

it('retains a failed close for save-as and closes only after writing succeeds', async () => {
  const { service, session, send } = setup()
  const closing = service.close('test')
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith('office:interaction', expect.objectContaining({ kind: 'confirm' })))
  mocks.job.mockRejectedValueOnce(new Error('源文件冲突'))
  service.resolveClose('test', 'save')
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith('office:interaction', expect.objectContaining({ kind: 'error', detail: '源文件冲突' })))
  expect(session.view.webContents.close).not.toHaveBeenCalled()
  mocks.choose.mockResolvedValue({ canceled: false, filePath: '/copy.docx' })
  service.resolveClose('test', 'saveAs')
  expect(await closing).toBe(true)
  expect(mocks.job).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/copy.docx' }))
  expect(mocks.message).not.toHaveBeenCalled()
})

it('keeps the editor when save-as is cancelled and permits closing without writeback', async () => {
  const { service, session, send } = setup(true)
  const closing = service.close('test')
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith('office:interaction', expect.objectContaining({ kind: 'confirm' })))
  mocks.choose.mockResolvedValue({ canceled: true })
  service.resolveClose('test', 'save')
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith('office:interaction', expect.objectContaining({ detail: expect.stringContaining('已取消另存为') })))
  expect(session.view.webContents.close).not.toHaveBeenCalled()
  service.resolveClose('test', 'discard')
  expect(await closing).toBe(true)
  expect(mocks.job).not.toHaveBeenCalled()
})

it('does not claim the latest content is saved when the server is unavailable', async () => {
  const { service, fetcher, send } = setup()
  fetcher.mockRejectedValue(new Error('network unavailable'))
  const closing = service.close('test')
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith('office:interaction', expect.objectContaining({ kind: 'error', detail: expect.stringContaining('尚不能确认最新内容已保存') })))
  service.resolveClose('test', 'cancel')
  expect(await closing).toBe(false)
})

it('waits for an in-flight automatic write before deciding whether close needs confirmation', async () => {
  const { service, session, document, send } = setup()
  session.busy = true
  const closing = service.close('test')
  expect(send).toHaveBeenCalledWith('office:interaction', expect.objectContaining({ kind: 'progress' }))
  session.syncedRevision = document.revision
  session.busy = false
  expect(await closing).toBe(true)
  expect(send.mock.calls.some(([, event]) => event.kind === 'confirm')).toBe(false)
})

it('retains all editors when the application-level exit decision is cancelled', async () => {
  const { service, session } = setup()
  mocks.message.mockResolvedValue({ response: 2 })
  expect(await service.closeAll()).toBe(false)
  expect(service.hasSessions).toBe(true)
  expect(session.view.webContents.close).not.toHaveBeenCalled()
})
