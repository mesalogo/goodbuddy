import { useSyncExternalStore } from 'react'
import type { ChannelRuntimeStatus, ManagedChannel } from '../../shared/channel-settings-contracts'
import type { ChannelStatusStore } from './channel-status-store'

export function useChannelStatus(
  store: ChannelStatusStore,
  channel: ManagedChannel,
  fallback: ChannelRuntimeStatus
): ChannelRuntimeStatus {
  return useSyncExternalStore(store.subscribe, () => store.getState()[channel] ?? fallback)
}
