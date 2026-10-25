import { dialog, ipcMain, WebContentsView, type BrowserWindow } from 'electron'
import { Worker } from 'node:worker_threads'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import {
  officeChannels, officeDocumentSchema, officeInstanceSchema, officeOpenSchema, officeInputExtensions,
  officeViewportSchema, officeApplySchema, type OfficeDocument, type OfficeSession, type OfficeSource
} from '../shared/office-contracts'
import type { OfficeFileJob } from './office-file-operations'
import { assertTrustedSender } from './trusted-ipc-sender'
import type { OfficeFileSource } from './office-workspace-source'
import type { ConversationSnapshot } from '../shared/assistant-contracts'
import { readOfficeCapabilities, requireOfficeEditing } from './office-capabilities'

type Session = {
  instanceId: string; serverUrl: string; path: string; digest: string;
  document: OfficeDocument; view: WebContentsView; busy: boolean; savedToSource: boolean;
  visible: boolean
  readOnlySource?: boolean
  source?: OfficeFileSource
  sourceIdentity?: string
  selection?: { text: string; epoch: number }
  conversation?: { id: string; queueItemId: string }
}

function fileJob(workerPath: string, job: OfficeFileJob): Promise<{ document: OfficeDocument; digest: string }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: job })
    let settled = false
    worker.once('message', (message: { result?: { document: OfficeDocument; digest: string }; error?: string }) => {
      settled = true
      if (message.result) resolve(message.result)
      else reject(new Error(message.error ?? '文档传输失败'))
    })
    worker.once('error', reject)
    worker.once('exit', code => { if (!settled) reject(new Error(`文档后台进程退出 (${code})`)) })
  })
}

export class OfficeService {
  private sessions = new Map<string, Session>()
  private opening = new Set<string>()
  constructor(private window: BrowserWindow, private workerPath: string,
    private resolveSource?: (source: OfficeSource) => Promise<OfficeFileSource>,
    private readConversation?: (id: string) => Promise<ConversationSnapshot>) {}

  async captureSelection(instanceId: string): Promise<string> {
    const session = this.sessions.get(instanceId)
    if (!session || session.busy) throw new Error('请先打开文档并等待保存完成')
    if (!/\.docx$/i.test(session.document.name)) throw new Error('当前 AI 选区编辑仅支持 Word 文档')
    const value = await session.view.webContents.executeJavaScript('window.goodbuddyOffice.selection()')
    session.selection = z.object({ text: z.string().min(1).max(32000), epoch: z.number().int().nonnegative() }).parse(value)
    session.conversation = undefined
    return session.selection.text
  }

  bindConversation(instanceId: string, id: string, queueItemId: string): void {
    const session = this.sessions.get(instanceId)
    if (session) session.conversation = { id, queueItemId }
  }

  async result(instanceId: string): Promise<{ state: 'pending' | 'complete' | 'error'; text?: string }> {
    const binding = this.sessions.get(instanceId)?.conversation
    if (!binding || !this.readConversation) throw new Error('请先对当前选区发起 AI 编辑')
    const conversation = await this.readConversation(binding.id)
    const userIndex = conversation.messages.findIndex(message => message.role === 'user' && message.queueItemId === binding.queueItemId)
    if (userIndex < 0) return { state: 'pending' }
    const next = conversation.messages[userIndex + 1]
    if (!next || next.role !== 'assistant' || next.state === 'streaming') return { state: 'pending' }
    if (next.state === 'error' || next.terminalStatus) return { state: 'error', text: next.status ?? '会话请求失败或已取消' }
    return { state: 'complete', text: next.content }
  }

  async apply(instanceId: string, text: string): Promise<void> {
    const session = this.sessions.get(instanceId)
    if (!session?.selection || session.busy) throw new Error('请先读取原选区并等待保存完成')
    const applied = await session.view.webContents.executeJavaScript(
      `window.goodbuddyOffice.replace(${JSON.stringify(session.selection)},${JSON.stringify(text)})`
    )
    if (applied !== true) throw new Error('编辑器未确认替换')
    session.selection = undefined
    session.savedToSource = false
  }

  private summary(session: Session): OfficeSession {
    return { instanceId: session.instanceId, document: session.document, savedToSource: session.savedToSource, readOnlySource: session.readOnlySource }
  }

  private async request(session: Session, suffix = '', method = 'GET'): Promise<unknown> {
    const response = await fetch(`${session.serverUrl}/api/v1/office/documents/${session.document.id}${suffix}`, {
      method, signal: AbortSignal.timeout(60_000), redirect: 'error'
    })
    if (!response.ok) throw new Error(`Office HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
    return response.json()
  }

  async open(input: z.infer<typeof officeOpenSchema>): Promise<OfficeSession | null> {
    const existing = this.sessions.get(input.instanceId)
    if (existing) return this.summary(existing)
    const sourceIdentity = input.source ? JSON.stringify(input.source) : undefined
    const matching = sourceIdentity && [...this.sessions.values()].find(session => session.sourceIdentity === sourceIdentity)
    if (matching) return this.summary(matching)
    if (this.opening.has(input.instanceId)) throw new Error('文档正在打开')
    this.opening.add(input.instanceId)
    let source: OfficeFileSource | undefined
    try {
      requireOfficeEditing(await readOfficeCapabilities(input.serverUrl), input.source?.kind === 'workspace' ? input.source.path : undefined)
      if (input.source) {
        if (!this.resolveSource) throw new Error('文档来源服务未就绪')
        source = await this.resolveSource(input.source)
      } else {
        const selected = await dialog.showOpenDialog(this.window, {
          title: '选择在线编辑的 Office 文件', properties: ['openFile'], filters: [{ name: 'Office 文档', extensions: officeInputExtensions }]
        })
        if (selected.canceled || !selected.filePaths[0]) return null
        source = { path: selected.filePaths[0] }
      }
      const path = resolve(source.path)
      const serverUrl = new URL(input.serverUrl).origin
      const alreadyOpen = [...this.sessions.values()].find(session => session.path === path)
      if (alreadyOpen) { await source.dispose?.(); source = undefined; return this.summary(alreadyOpen) }
      const result = await fileJob(this.workerPath, { action: 'upload', path, serverUrl })
      const view = new WebContentsView({ webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        partition: 'goodbuddy-office'
      } })
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      view.webContents.on('will-navigate', (event, url) => {
        if (new URL(url).origin !== serverUrl) event.preventDefault()
      })
      view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      const downloadSession = view.webContents.session
      const preventDownload = (event: { preventDefault(): void }): void => event.preventDefault()
      downloadSession.on('will-download', preventDownload)
      view.webContents.once('destroyed', () => downloadSession.removeListener('will-download', preventDownload))
      this.window.contentView.addChildView(view)
      view.setVisible(false)
      const session: Session = { ...result, instanceId: input.instanceId, serverUrl, path, view,
        busy: false, savedToSource: false, visible: false, readOnlySource: source.readOnly || result.document.requiresSaveAs, source, sourceIdentity }
      this.sessions.set(input.instanceId, session)
      try {
        await view.webContents.loadURL(`${serverUrl}/office/editor?document=${result.document.id}`)
      } catch (error) {
        await this.destroy(session)
        source = undefined
        throw error
      }
      return this.summary(session)
    } catch (error) {
      if (!this.sessions.has(input.instanceId)) await source?.dispose?.()
      throw error
    } finally {
      this.opening.delete(input.instanceId)
    }
  }

  viewport(input: z.infer<typeof officeViewportSchema>): void {
    const session = this.sessions.get(input.instanceId)
    if (!session) return
    session.visible = input.visible
    session.view.setBounds({ x: Math.round(input.x), y: Math.round(input.y),
      width: Math.max(0, Math.round(input.width)), height: Math.max(0, Math.round(input.height)) })
    session.view.setVisible(input.visible && !session.busy)
  }

  async save(instanceId: string, saveAs = false): Promise<OfficeSession | null> {
    const session = this.sessions.get(instanceId)
    if (!session) throw new Error('请先打开文档')
    if (session.busy) throw new Error('文档正在保存，请稍候')
    session.busy = true
    session.view.setVisible(false)
    try {
      let target = session.path
      if (saveAs || session.readOnlySource) {
        const selected = await dialog.showSaveDialog(this.window, { defaultPath: session.document.name,
          filters: [{ name: 'Office 文档', extensions: [session.document.name.split('.').pop()!.toLowerCase()] }] })
        if (selected.canceled || !selected.filePath) return null
        target = selected.filePath
      }
      const deadline = Date.now() + 60_000
      // Fixed, read-only expression in our editor shell; no remote preload or arbitrary bridge.
      while (true) {
        const status = await session.view.webContents.executeJavaScript(
          '({ready:document.documentElement.dataset.officeReady,dirty:document.documentElement.dataset.officeDirty})'
        ) as { ready?: string; dirty?: string }
        if (status.ready === 'true' && status.dirty === 'false') break
        if (Date.now() > deadline) throw new Error('编辑器尚未将修改交给编辑服务，请等待后重试')
        await delay(250)
      }
      await this.request(session, '/save', 'POST')
      while (true) {
        session.document = officeDocumentSchema.parse(await this.request(session))
        if (session.document.error || session.document.state === 'error') throw new Error(session.document.error ?? '服务器保存失败')
        if (['editing', 'saved', 'closed'].includes(session.document.state)) break
        if (Date.now() > deadline) throw new Error('等待服务器保存超时，请重试；源文件尚未更新')
        await delay(500)
      }
      const result = await fileJob(this.workerPath, { action: 'download', path: target, serverUrl: session.serverUrl,
        document: session.document, ...(target === session.path && !session.source?.commit ? { expectedDigest: session.digest } : {}) })
      if (target === session.path) await session.source?.commit?.(target, session.digest, result.digest)
      else { await session.source?.dispose?.(); session.source = undefined; session.sourceIdentity = undefined }
      session.path = target
      session.readOnlySource = false
      session.digest = result.digest
      session.savedToSource = true
      return this.summary(session)
    } finally {
      session.busy = false
      session.view.setVisible(session.visible)
    }
  }

  private async destroy(session: Session): Promise<void> {
    this.window.contentView.removeChildView(session.view)
    session.view.webContents.close()
    this.sessions.delete(session.instanceId)
    await session.source?.dispose?.()
  }

  async close(instanceId: string, destroy = true): Promise<boolean> {
    if (this.opening.has(instanceId)) return false
    const session = this.sessions.get(instanceId)
    if (!session) return true
    if (session.busy) return false
    session.view.setVisible(false)
    try {
      const answer = await dialog.showMessageBox(this.window, {
        type: 'question', message: `关闭 ${session.document.name}`,
        detail: '保存会将当前服务器版本写回源文件。不回写只保留服务器副本，不会撤销已完成的保存。',
        buttons: ['保存并关闭', '不回写并关闭', '取消'], defaultId: 0, cancelId: 2
      })
      if (answer.response === 2) return false
      if (answer.response === 0 && !await this.save(instanceId)) return false
      if (destroy) await this.destroy(session)
      return true
    } catch (error) {
      await dialog.showMessageBox(this.window, { type: 'error', message: '文档未关闭',
        detail: error instanceof Error ? error.message : String(error) })
      return false
    } finally {
      if (this.sessions.has(instanceId)) session.view.setVisible(session.visible)
    }
  }

  get hasSessions(): boolean { return this.sessions.size > 0 || this.opening.size > 0 }
  async closeAll(): Promise<boolean> {
    if (this.opening.size) return false
    // Keep every editor available if a later document cancels application exit.
    for (const id of this.sessions.keys()) if (!await this.close(id, false)) return false
    for (const session of this.sessions.values()) await this.destroy(session)
    return true
  }
}

export function registerOfficeIpc(window: BrowserWindow, service: OfficeService): () => void {
  const handlers: Record<string, (input: unknown) => unknown> = {
    [officeChannels.capabilities]: input => readOfficeCapabilities(z.object({ serverUrl: z.string() }).strict().parse(input).serverUrl),
    [officeChannels.open]: input => service.open(officeOpenSchema.parse(input)),
    [officeChannels.save]: input => {
      const value = officeInstanceSchema.extend({ saveAs: z.boolean().optional() }).strict().parse(input)
      return service.save(value.instanceId, value.saveAs)
    },
    [officeChannels.close]: input => service.close(officeInstanceSchema.parse(input).instanceId),
    [officeChannels.viewport]: input => service.viewport(officeViewportSchema.parse(input)),
    [officeChannels.result]: input => service.result(officeInstanceSchema.parse(input).instanceId),
    [officeChannels.apply]: input => {
      const value = officeApplySchema.parse(input)
      return service.apply(value.instanceId, value.text)
    }
  }
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, input: unknown) => { assertTrustedSender(event, window); return handler(input) })
  }
  return () => { for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel) }
}
