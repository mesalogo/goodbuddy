import type { ChannelSettingsSnapshot } from './channel-settings-contracts'

export type DingTalkRegistrationState =
  | { state: 'idle' | 'starting' | 'saving' }
  | { state: 'waiting'; url: string; expiresAt: string }
  | { state: 'completed'; channels: ChannelSettingsSnapshot }
  | { state: 'failed'; message: string }

export type DingTalkRegistrationSnapshot = { revision: number } & DingTalkRegistrationState

export type DingTalkRegistrationBridge = {
  getSnapshot(): Promise<DingTalkRegistrationSnapshot>
  start(): Promise<DingTalkRegistrationSnapshot>
  cancel(): Promise<DingTalkRegistrationSnapshot>
  onChanged(listener: (snapshot: DingTalkRegistrationSnapshot) => void): () => void
}
