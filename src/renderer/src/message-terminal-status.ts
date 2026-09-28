import type { ConversationMessage } from '../../shared/assistant-contracts'

export function isCancelledMessage(message: Pick<ConversationMessage,
  'state' | 'terminalStatus' | 'status'>): boolean {
  if (message.state !== 'error') return false
  if (message.terminalStatus !== undefined) return message.terminalStatus === 'cancelled'
  // Released snapshots lack terminalStatus. Only recognize exact old labels;
  // every new terminal event supplies the structured value above.
  return message.status === '请求已取消' || message.status === '已取消' ||
    message.status === '远端 Runtime 请求已取消'
}
