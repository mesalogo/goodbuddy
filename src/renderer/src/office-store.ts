import type { OfficeSession, OfficeSource } from '../../shared/office-contracts'
import { shareServerConnection } from './shareserver-connection-store'

type State = { session?: OfficeSession; source?: OfficeSource; name?: string; busy: boolean; error?: string; message?: string; selectedText?: string; reply?: string; aiPending?: boolean }
const empty: State = { busy: false }
const states = new Map<string, State>()
const listeners = new Set<() => void>()
let requested: { instanceId: string; name: string } | null = null
function update(id: string, patch: Partial<State>): void {
  states.set(id, { ...officeStore.get(id), ...patch })
  for (const listener of listeners) listener()
}
export const officeStore = {
  getOpenRequest: () => requested,
  requestOpen(source: OfficeSource, name: string): void {
    const previous = [...states].find(([, state]) => JSON.stringify(state.source) === JSON.stringify(source))
    const instanceId = previous?.[0] ?? crypto.randomUUID()
    requested = { instanceId, name }
    update(instanceId, { source, name })
    const serverUrl = shareServerConnection.getState().serverUrl
    if (serverUrl && !previous?.[1].session && !previous?.[1].busy) void officeStore.open(instanceId, serverUrl)
  },
  get: (id: string): State => states.get(id) ?? empty,
  subscribe: (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  async open(instanceId: string, serverUrl: string): Promise<OfficeSession | null> {
    if (officeStore.get(instanceId).busy) return null
    if (officeStore.get(instanceId).session) return officeStore.get(instanceId).session!
    update(instanceId, { busy: true, error: undefined, message: '正在检查 Office 能力并上传文件…' })
    try {
      if (!window.goodbuddy.office) throw new Error('请更新 GoodBuddy 后重试')
      const session = await window.goodbuddy.office.open({ instanceId, serverUrl, source: officeStore.get(instanceId).source })
      if (session?.instanceId === instanceId) update(instanceId, { session, message: '编辑后点击“保存回文件”；服务器保存与本地保存分别完成。' })
      else if (session) {
        requested = { instanceId: session.instanceId, name: session.document.name }
        update(session.instanceId, { session })
        update(instanceId, { message: '已切换到此文件的现有编辑页签。' })
      }
      else update(instanceId, { message: undefined })
      return session
    } catch (error) { update(instanceId, { error: String(error), message: undefined }); return null }
    finally { update(instanceId, { busy: false }) }
  },
  async save(instanceId: string, saveAs: boolean): Promise<void> {
    update(instanceId, { busy: true, error: undefined, message: '正在等待服务器保存并写入文件…' })
    try {
      const session = await window.goodbuddy.office!.save({ instanceId, saveAs })
      update(instanceId, { ...(session ? { session } : {}), message: session ? `版本 ${session.document.revision} 已保存到文件` : '已取消另存为' })
    } catch (error) { update(instanceId, { error: String(error), message: undefined }) }
    finally { update(instanceId, { busy: false }) }
  },
  async ask(instanceId: string, conversationId: string, instruction: string): Promise<void> {
    update(instanceId, { busy: true, error: undefined })
    try {
      const result = await window.goodbuddy.office!.ask({ instanceId, conversationId, instruction })
      update(instanceId, { selectedText: result.selectedText, reply: undefined, aiPending: true,
        message: '已发送到当前对话。回复完成后获取修改结果；应用前会核对原选区。' })
    } catch (error) { update(instanceId, { error: String(error) }) }
    finally { update(instanceId, { busy: false }) }
  },
  async result(instanceId: string): Promise<void> {
    update(instanceId, { busy: true, error: undefined })
    try {
      const result = await window.goodbuddy.office!.result({ instanceId })
      if (result.state === 'error') throw new Error(result.text)
      update(instanceId, result.state === 'complete' ? { reply: result.text, aiPending: false, message: '请检查修改结果，再应用到原选区。' }
        : { message: '原会话仍在等待或生成回复，可在对话中查看进度或取消。' })
    } catch (error) { update(instanceId, { error: String(error) }) }
    finally { update(instanceId, { busy: false }) }
  },
  setReply(instanceId: string, reply: string): void { update(instanceId, { reply }) },
  async apply(instanceId: string): Promise<void> {
    const text = officeStore.get(instanceId).reply
    if (!text) return
    update(instanceId, { busy: true, error: undefined })
    try {
      await window.goodbuddy.office!.apply({ instanceId, text })
      update(instanceId, { reply: undefined, selectedText: undefined, message: '已替换原选区，可在编辑器中撤销。请保存回文件。' })
    } catch (error) { update(instanceId, { error: String(error) }) }
    finally { update(instanceId, { busy: false }) }
  },
  async close(instanceId: string): Promise<boolean> {
    if (officeStore.get(instanceId).busy) return false
    const accepted = await window.goodbuddy.office?.close({ instanceId }) ?? true
    if (accepted) { states.delete(instanceId); for (const listener of listeners) listener() }
    return accepted
  }
}
