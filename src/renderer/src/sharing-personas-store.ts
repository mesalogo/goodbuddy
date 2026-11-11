import type { PersonaAnswer, PersonaCatalog, PersonaDraft, SharingPersonasApi } from '../../shared/sharing-personas'

type State = { catalog?: PersonaCatalog; busy: boolean; asking: boolean; answer?: PersonaAnswer; error: string }
export function createSharingPersonasStore(api: SharingPersonasApi) {
  let state: State = { busy: false, asking: false, error: '' }
  let generation = 0
  let chatId: string | undefined
  const listeners = new Set<() => void>()
  const update = (patch: Partial<State>): void => { state = { ...state, ...patch }; listeners.forEach(listener => listener()) }
  const load = async (): Promise<void> => {
    const current = ++generation
    update({ busy: true, error: '' })
    try { const catalog = await api.getPersonas(); if (current === generation) update({ catalog }) }
    catch (error) { if (current === generation) update({ error: String(error) }); throw error }
    finally { if (current === generation) update({ busy: false }) }
  }
  const cancel = async (): Promise<void> => {
    const id = chatId; chatId = undefined
    update({ asking: false })
    if (id) await api.cancelPersonaChat(id)
  }
  return {
    getState: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    load,
    save: async (draft: PersonaDraft) => { await api.savePersona(draft); await load() },
    transition: async (id: string, revision: number, action: 'pause' | 'revoke') => { await api.transitionPersona({ id, revision, action }); await load() },
    chat: async (id: string, message: string): Promise<void> => {
      await cancel()
      const requestId = crypto.randomUUID(); chatId = requestId
      update({ asking: true, answer: undefined, error: '' })
      try { const answer = await api.chatPersona({ id, message, requestId }); if (chatId === requestId) update({ answer }) }
      catch (error) { if (chatId === requestId) { update({ error: String(error) }); throw error } }
      finally { if (chatId === requestId) { chatId = undefined; update({ asking: false }) } }
    },
    clearAnswer: () => update({ answer: undefined, error: '' }),
    cancel,
    dispose: () => { generation++; void cancel().catch(() => undefined); listeners.clear() }
  }
}
