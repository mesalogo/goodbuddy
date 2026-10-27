import type { ConversationAttachment, ConversationSnapshot } from '../../shared/assistant-contracts'
import type { ConversationQueueUserInput } from '../../shared/contracts'
import type { Conversation } from './chat-conversation'
import type { ConversationStore } from './conversation-store'
import type { ConversationPersistence } from './conversation-persistence'
import { maximumAttachmentsPerMessage } from '../../shared/attachment-limits'

export type MessageEditState = {
  conversationId: string
  messageId: string
  content: string
  attachments: ConversationAttachment[]
  submitting: boolean
  addingFiles: boolean
  error?: string
  branch?: ConversationSnapshot
}

export type MessageEditHost = {
  conversations: ConversationStore
  persistence: ConversationPersistence
  flush: () => void
  unavailable: (conversationId: string) => string | undefined
  queueDefaults: () => Pick<ConversationQueueUserInput, 'runtimeSelection' | 'runtimeControl' | 'expertId' | 'teamMode' | 'knowledgeLibraryIds' | 'smartRouting'>
  openConversation: (id: string) => void
  setDraft: (id: string, content: string) => void
  branchTitle: (source: Conversation) => string
  fallbackError: () => string
  attachmentLimitError: () => string
}

export function createMessageEditStore(getHost: () => MessageEditHost) {
  let state: MessageEditState | undefined
  const listeners = new Set<() => void>()
  const ownedAttachments = new Set<string>()
  const publish = (next: MessageEditState | undefined): void => {
    state = next
    for (const listener of listeners) listener()
  }
  const errorText = (error: unknown): string => error instanceof Error ? error.message : getHost().fallbackError()
  const cleanAttachments = async (): Promise<void> => {
    const ids = [...ownedAttachments]
    ownedAttachments.clear()
    for (const id of ids) await window.goodbuddy.context.remove(id)
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    open: (conversationId: string, messageId: string): void => {
      if (state) return
      const source = getHost().conversations.getConversation(conversationId)
      const message = source?.messages.find(item => item.id === messageId)
      if (!source || source.remote || message?.role !== 'user') return
      publish({ conversationId, messageId, content: message.content, attachments: [...(message.attachments ?? [])], submitting: false, addingFiles: false })
    },
    setContent(content: string): void { if (state && !state.submitting) publish({ ...state, content }) },
    removeAttachment(id: string): void {
      if (state && !state.submitting && !state.addingFiles) publish({ ...state, attachments: state.attachments.filter(item => item.id !== id) })
    },
    async addFiles(): Promise<void> {
      if (!state || state.submitting || state.addingFiles) return
      publish({ ...state, addingFiles: true, error: undefined })
      try {
        const added = await window.goodbuddy.context.selectFiles()
        for (const item of added) ownedAttachments.add(item.id)
        if (state.attachments.length + added.length > maximumAttachmentsPerMessage) {
          for (const item of added) {
            await window.goodbuddy.context.remove(item.id)
            ownedAttachments.delete(item.id)
          }
          throw new Error(getHost().attachmentLimitError())
        }
        publish({ ...state, attachments: [...state.attachments, ...added], addingFiles: false })
      } catch (error) { publish({ ...state, addingFiles: false, error: errorText(error) }) }
    },
    async cancel(): Promise<void> {
      if (!state || state.submitting || state.addingFiles) return
      const current = state
      try {
        if (current.branch) {
          getHost().setDraft(current.branch.id, current.content)
          await window.goodbuddy.context.saveDraft(current.branch.id, current.attachments.map(item => item.id))
        }
        await cleanAttachments()
        publish(undefined)
      } catch (error) { publish({ ...current, error: errorText(error) }) }
    },
    async submit(): Promise<void> {
      if (!state || state.submitting || state.addingFiles || !state.content.trim() || state.content.trim().length > 100_000) return
      const host = getHost()
      const blocked = host.unavailable(state.branch?.id ?? state.conversationId)
      if (blocked) { publish({ ...state, error: blocked }); return }
      publish({ ...state, submitting: true, error: undefined })
      try {
        if (!state.branch) {
          host.flush()
          await host.persistence.idle()
          const source = host.conversations.getConversation(state.conversationId)
          if (!source || host.persistence.acknowledged().get(source.id) !== source) throw new Error(host.fallbackError())
          const branch = await window.goodbuddy.conversations.branchLocal({
            sourceConversationId: source.id, beforeMessageId: state.messageId, title: host.branchTitle(source),
          })
          host.persistence.acknowledged().set(branch.id, branch)
          host.conversations.set(current => [branch, ...current.filter(item => item.id !== branch.id)])
          publish({ ...state, branch })
        }
        const branch = state.branch!
        const defaults = host.queueDefaults()
        await window.goodbuddy.conversationQueue.enqueueUser({
          ...defaults,
          conversationId: branch.id, projectId: branch.projectId,
          prompt: state.content.trim(), attachments: state.attachments,
          knowledgeRetrievalMode: branch.knowledgeRetrievalMode ?? 'auto',
          includeMemoryContext: true,
        })
        // Queue acceptance is the send boundary. Never turn cleanup into a retryable send failure.
        // Accepted attachments now belong to the queue/run; removing their live contexts
        // here could race the dispatch that enqueueUser already delivered.
        for (const attachment of state.attachments) ownedAttachments.delete(attachment.id)
        publish(undefined)
        host.openConversation(branch.id)
        void cleanAttachments().catch(() => undefined)
      } catch (error) {
        if (state) publish({ ...state, submitting: false, error: errorText(error) })
      }
    },
  }
}

export type MessageEditStore = ReturnType<typeof createMessageEditStore>
