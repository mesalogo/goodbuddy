/**
 * OpenCode's ACP adapter omits native child sessions. This plugin forwards
 * their SDK events as ACP metadata on the owning Task, using the same stdio
 * stream and prompt lifetime as the built-in adapter.
 */
export function openCodeSubagentPluginSource(): string {
  return `export default ${plugin.toString()}`
}

function plugin() {
  const tasks = new Map<string, { sessionId: string; callId: string }>()
  return Promise.resolve({
    event: async ({ event }: { event: {
      type: string
      properties: {
        sessionID?: string
        part?: {
          type: string
          tool?: string
          callID?: string
          state?: {
            metadata?: { sessionId?: string }
          }
        }
      }
    } }) => {
      const properties = event.properties
      const part = properties.part
      let owner = properties.sessionID ? tasks.get(properties.sessionID) : undefined
      if (
        !owner && event.type === 'message.part.updated' &&
        part?.type === 'tool' && part.tool === 'task' &&
        part.callID && properties.sessionID
      ) {
        owner = { sessionId: properties.sessionID, callId: part.callID }
        const child = part.state?.metadata?.sessionId
        if (child) tasks.set(child, owner)
      }
      if (!owner || ![
        'message.updated', 'message.part.updated', 'message.part.delta'
      ].includes(event.type)) return
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: owner.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: owner.callId,
            _meta: { goodbuddySubagentEvent: event }
          }
        }
      }) + '\n')
    }
  })
}
