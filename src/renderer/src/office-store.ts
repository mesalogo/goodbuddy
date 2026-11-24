import type { OfficeCloseChoice, OfficeInteraction, OfficeSession, OfficeSource } from '../../shared/office-contracts'
import { shareServerConnection } from './shareserver-connection-store'
import i18n from './i18n'

type State = { interaction?: OfficeInteraction; session?: OfficeSession; source?: OfficeSource; name?: string; busy: boolean; error?: string; message?: string; selectedText?: string; reply?: string; aiPending?: boolean }
const empty: State = { busy: false }
const states = new Map<string, State>()
const listeners = new Set<() => void>()
let requested: { instanceId: string; name: string } | null = null
let unsubscribe: (() => void) | undefined
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
    if (!previous?.[1].session && !previous?.[1].busy) void officeStore.open(instanceId)
  },
  get: (id: string): State => states.get(id) ?? empty,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    unsubscribe ??= window.goodbuddy.office?.onInteraction?.(interaction => {
      update(interaction.instanceId, { interaction: interaction.kind === 'clear' ? undefined : interaction, error: undefined, message: undefined })
    })
    return () => { listeners.delete(listener); if (!listeners.size) { unsubscribe?.(); unsubscribe = undefined } }
  },
  async resolveClose(instanceId: string, choice: OfficeCloseChoice): Promise<void> {
    try { await window.goodbuddy.office!.resolveClose({ instanceId, choice }) }
    catch (error) { update(instanceId, { error: String(error) }) }
  },
  dismissInteraction(instanceId: string): void { update(instanceId, { interaction: undefined, error: undefined }) },
  async open(instanceId: string, serverUrl?: string): Promise<OfficeSession | null> {
    if (officeStore.get(instanceId).busy) return null
    if (officeStore.get(instanceId).session) return officeStore.get(instanceId).session!
    update(instanceId, { busy: true, error: undefined, message: undefined })
    try {
      if (!window.goodbuddy.office) throw new Error(i18n.t('workspace:office.updateRequired'))
      serverUrl ??= await shareServerConnection.resolve()
      const session = await window.goodbuddy.office.open({ instanceId, serverUrl, source: officeStore.get(instanceId).source })
      if (session?.instanceId === instanceId) update(instanceId, { session, message: undefined })
      else if (session) {
        requested = { instanceId: session.instanceId, name: session.document.name }
        update(session.instanceId, { session })
        update(instanceId, { message: i18n.t('workspace:office.switchedTab') })
      }
      else update(instanceId, { message: undefined })
      return session
    } catch (error) { update(instanceId, { error: String(error), message: undefined }); return null }
    finally { update(instanceId, { busy: false }) }
  },
  async save(instanceId: string, saveAs: boolean): Promise<void> {
    update(instanceId, { busy: true, error: undefined, message: i18n.t('workspace:office.saving') })
    try {
      const session = await window.goodbuddy.office!.save({ instanceId, saveAs })
      update(instanceId, { ...(session ? { session } : {}), message: session ? i18n.t('workspace:office.saved', { revision: session.document.revision }) : i18n.t('workspace:office.saveAsCancelled') })
      if (session) update(instanceId, { interaction: undefined })
    } catch (error) { update(instanceId, { error: String(error), message: undefined }) }
    finally { update(instanceId, { busy: false }) }
  },
  async ask(instanceId: string, conversationId: string, instruction: string): Promise<void> {
    update(instanceId, { busy: true, error: undefined })
    try {
      const result = await window.goodbuddy.office!.ask({ instanceId, conversationId, instruction })
      update(instanceId, { selectedText: result.selectedText, reply: undefined, aiPending: true,
        message: i18n.t('workspace:office.sent') })
    } catch (error) { update(instanceId, { error: String(error) }) }
    finally { update(instanceId, { busy: false }) }
  },
  async result(instanceId: string): Promise<void> {
    update(instanceId, { busy: true, error: undefined })
    try {
      const result = await window.goodbuddy.office!.result({ instanceId })
      if (result.state === 'error') throw new Error(result.text)
      update(instanceId, result.state === 'complete' ? { reply: result.text, aiPending: false, message: i18n.t('workspace:office.reviewReply') }
        : { message: i18n.t('workspace:office.stillWaiting') })
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
      update(instanceId, { reply: undefined, selectedText: undefined, message: i18n.t('workspace:office.applied') })
    } catch (error) { update(instanceId, { error: String(error) }) }
    finally { update(instanceId, { busy: false }) }
  },
  async close(instanceId: string): Promise<boolean> {
    if (officeStore.get(instanceId).busy || officeStore.get(instanceId).interaction?.closing) return false
    try {
      const accepted = await window.goodbuddy.office?.close({ instanceId }) ?? true
      if (accepted) { states.delete(instanceId); for (const listener of listeners) listener() }
      return accepted
    } catch (error) { update(instanceId, { error: String(error) }); return false }
  }
}
