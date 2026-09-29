import type { ConversationMessage } from './assistant-contracts'

export const cancelledResponseMarker =
  '[This response was interrupted by the user before it finished.]'
export const failedResponseMarker =
  '[This response failed before it finished.]'

type HistorySourceMessage = Pick<
  ConversationMessage,
  'id' | 'role' | 'content' | 'state' | 'terminalStatus' | 'status'
>

export type RuntimeHistoryMessage = {
  id: string
  role: ConversationMessage['role']
  content: string
}

export function isCancelledMessage(
  message: Pick<ConversationMessage, 'state' | 'terminalStatus' | 'status'>
): boolean {
  if (message.state !== 'error') return false
  if (message.terminalStatus !== undefined) return message.terminalStatus === 'cancelled'
  // Released snapshots lack terminalStatus. Only recognize exact old labels;
  // every new terminal event supplies the structured value above.
  return message.status === '请求已取消' || message.status === '已取消' ||
    message.status === '远端 Runtime 请求已取消'
}

/**
 * Builds the model-visible history from stored messages. A cancelled or failed
 * reply stays in place with its partial text and an explicit marker, so its
 * user message is never left unanswered and merged into the next turn.
 */
export function buildRuntimeHistory(
  messages: readonly HistorySourceMessage[]
): RuntimeHistoryMessage[] {
  const history: RuntimeHistoryMessage[] = []
  for (const message of messages) {
    if (message.state === 'complete') {
      if (message.content.trim()) {
        history.push({ id: message.id, role: message.role, content: message.content })
      }
      continue
    }
    if (message.state !== 'error' || message.role !== 'assistant') continue
    // Only a reply to a retained user turn needs a marker.
    if (history.at(-1)?.role !== 'user') continue
    const marker = isCancelledMessage(message)
      ? cancelledResponseMarker
      : failedResponseMarker
    history.push({
      id: message.id,
      role: 'assistant',
      content: message.content.trim()
        ? `${message.content.trimEnd()}\n\n${marker}`
        : marker
    })
  }
  return history
}
