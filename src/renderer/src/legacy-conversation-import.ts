/** Remove only application-owned metadata before validating the old localStorage payload. */
export function stripLegacyConversationModes(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const conversation = { ...value } as Record<string, unknown>
  delete conversation.workMode
  if (Array.isArray(conversation.messages)) {
    conversation.messages = conversation.messages.map((value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value
      const message = { ...value } as Record<string, unknown>
      if (Array.isArray(message.subagents)) {
        message.subagents = message.subagents.map((value: unknown) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return value
          const subagent = { ...value } as Record<string, unknown>
          delete subagent.workMode
          return subagent
        })
      }
      return message
    })
  }
  return conversation
}
