import { officeOriginSchema, type OfficeCapabilities } from '../../shared/office-contracts'

type State = { serverUrl: string; checking: boolean; capabilities?: OfficeCapabilities; error?: string }
// Reuse the existing desktop connection preference; capabilities are refreshed on demand.
const key = 'goodbuddy.office.serverUrl'
let state: State = { serverUrl: localStorage.getItem(key) ?? '', checking: false }
const listeners = new Set<() => void>()
function update(patch: Partial<State>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}
export const shareServerConnection = {
  getState: (): State => state,
  subscribe: (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  async resolve(): Promise<string> {
    // A configured Office override is retained; otherwise reuse the device service connection.
    const configured = localStorage.getItem(key)
    const value = configured || (await window.goodbuddy.sharing?.getSettings())?.serverUrl
    if (!value) throw new Error('请先在设置中连接具备 Office 能力的 ShareServer。')
    const origin = new URL(officeOriginSchema.parse(value)).origin
    const capabilities = await window.goodbuddy.office!.capabilities({ serverUrl: origin })
    const serverUrl = capabilities.webUrl ?? origin
    update({ serverUrl, capabilities, error: undefined })
    return serverUrl
  },
  async connect(value: string): Promise<boolean> {
    if (state.checking) return false
    update({ checking: true, error: undefined, capabilities: undefined })
    try {
      const serverUrl = new URL(officeOriginSchema.parse(value.trim())).origin
      const capabilities = await window.goodbuddy.office!.capabilities({ serverUrl })
      localStorage.setItem(key, serverUrl)
      update({ serverUrl, capabilities })
      return true
    } catch (error) {
      update({ error: error instanceof Error ? error.message : String(error) })
      return false
    } finally { update({ checking: false }) }
  }
}
