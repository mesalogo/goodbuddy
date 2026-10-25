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
