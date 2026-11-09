import type { DingTalkRegistrationBridge, DingTalkRegistrationSnapshot } from '../../shared/dingtalk-registration-contracts'

/** Local subscription owner for the mounted connection page. */
export function createDingTalkRegistrationStore(api: DingTalkRegistrationBridge) {
  let snapshot: DingTalkRegistrationSnapshot = { revision: -1, state: 'idle' }
  let error: string | undefined
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of listeners) listener() }
  const accept = (next: DingTalkRegistrationSnapshot): void => {
    if (next.revision < snapshot.revision) return
    snapshot = next
    error = undefined
    notify()
  }
  const fail = (reason: unknown): void => {
    error = reason instanceof Error ? reason.message : String(reason)
    notify()
  }
  return {
    getSnapshot: () => snapshot,
    getError: () => error,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    connect: () => {
      let active = true
      const remove = api.onChanged(next => { if (active) accept(next) })
      void api.getSnapshot().then(next => { if (active) accept(next) }, reason => { if (active) fail(reason) })
      return () => { active = false; remove() }
    },
    start: async () => { try { accept(await api.start()) } catch (reason) { fail(reason) } },
    cancel: async () => { try { accept(await api.cancel()) } catch (reason) { fail(reason) } }
  }
}
