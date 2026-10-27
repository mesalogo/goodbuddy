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
  const sender = { mainFrame, executeJavaScript: vi.fn().mockResolvedValue(undefined), isDestroyed: () => false }
  const session = { instanceId: 'test', serverUrl: 'http://192.168.0.23:8088', path: '/source.docx', digest: 'c'.repeat(64), document: { ...document, revision: 1 }, view: { webContents: sender, setVisible: vi.fn() }, busy: false, syncedRevision: 1, readOnlySource, visible: true }
  const service = new OfficeService({} as never, '/worker.js')
  Reflect.get(service, 'sessions').set('test', session)
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => document })
  vi.stubGlobal('fetch', fetcher)
  mocks.job.mockResolvedValue({ document, digest: document.digest })
  mocks.message.mockResolvedValue({ response: 0 })
  const notify = (revision = 2) => service.editorRequest({ sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent, { action: 'persisted', revision }, vi.fn())
  return { session, document, notify, fetcher }
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
  const { session, notify } = setup()
  mocks.job.mockRejectedValue(new Error('源文件已被其他程序修改'))
  await notify()
  await notify(3)
  expect(mocks.job).toHaveBeenCalledTimes(1)
  expect(mocks.message).toHaveBeenCalledTimes(1)
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
