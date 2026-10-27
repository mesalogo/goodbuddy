import { officeOriginSchema, type OfficeCapabilities } from '../../shared/office-contracts'

type State = { serverUrl: string; checking: boolean; capabilities?: OfficeCapabilities; error?: string }
// Device sharing owns the connection. Never reuse the obsolete Office-only override.
let state: State = { serverUrl: '', checking: false }
const listeners = new Set<() => void>()
function update(patch: Partial<State>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}
export const shareServerConnection = {
  getState: (): State => state,
  subscribe: (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  async load(): Promise<string> {
    try {
      const serverUrl = (await window.goodbuddy.sharing?.getSettings())?.serverUrl ?? ''
      update({ serverUrl, capabilities: undefined, error: undefined })
      return serverUrl
    } catch (error) {
      update({ error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  },
  async resolve(): Promise<string> {
    const value = await shareServerConnection.load()
    if (!value) throw new Error('请先在设置中连接具备 Office 能力的 ShareServer。')
    const origin = new URL(officeOriginSchema.parse(value)).origin
    const capabilities = await window.goodbuddy.office!.capabilities({ serverUrl: origin })
    const serverUrl = capabilities.webUrl ?? origin
    update({ serverUrl: origin, capabilities, error: undefined })
    return serverUrl
  },
  async connect(value: string): Promise<boolean> {
    if (state.checking) return false
    update({ checking: true, error: undefined, capabilities: undefined })
    try {
      const serverUrl = new URL(officeOriginSchema.parse(value.trim())).origin
      const capabilities = await window.goodbuddy.office!.capabilities({ serverUrl })
      const sharing = window.goodbuddy.sharing
      if (!sharing) throw new Error('请更新 GoodBuddy 后配置 ShareServer 连接')
      const settings = await sharing.getSettings()
      await sharing.saveSettings({ serverUrl, name: settings.name })
      update({ serverUrl, capabilities })
      return true
    } catch (error) {
      update({ error: error instanceof Error ? error.message : String(error) })
      return false
    } finally { update({ checking: false }) }
  }
}
