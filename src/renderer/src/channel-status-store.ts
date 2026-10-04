import type {
  ChannelRuntimeStatus,
  ChannelRuntimeStatusChange,
  ChannelSettingsSnapshot,
  ManagedChannel
} from '../../shared/channel-settings-contracts'
import type { DesktopApi } from '../../shared/contracts'
import { projectChannels } from '../../shared/assistant-contracts'

export function createChannelStatusStore() {
  let state: Partial<Record<ManagedChannel, ChannelRuntimeStatus>> = {}
  const eventChannels = new Set<ManagedChannel>()
  const listeners = new Set<() => void>()

  const update = ({ channel, status }: ChannelRuntimeStatusChange): void => {
    const current = state[channel]
    if (current?.state === status.state && current.lastError === status.lastError) return
    state = { ...state, [channel]: status }
    listeners.forEach((listener) => listener())
  }

  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    connect: (api: DesktopApi['channels']) => {
      let active = true
      const unsubscribe = api?.onStatusChanged?.((change: ChannelRuntimeStatusChange) => {
        if (!active) return
        eventChannels.add(change.channel)
        update(change)
      })
      return () => {
        active = false
        unsubscribe?.()
      }
    },
    seed: (snapshot: ChannelSettingsSnapshot) => {
      // A status push received during loading is newer than the snapshot baseline.
      for (const channel of projectChannels) {
        if (!eventChannels.has(channel)) update({ channel, status: snapshot[channel].status })
      }
    }
  }
}

export type ChannelStatusStore = ReturnType<typeof createChannelStatusStore>
