/**
 * OpenCode's ACP adapter omits native questions and child sessions. Native
 * events use ACP metadata; question replies use a process-local capability.
 */
export function openCodeSubagentPluginSource(): string {
  return `import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
export default (input) => (${plugin.toString()})(input, { createServer, randomBytes })`
}

async function plugin(input?: {
  client: {
    _client: {
      get(input: { url: string; throwOnError: true }): Promise<{ data: unknown }>
      post(input: { url: string; body?: unknown; throwOnError: true }): Promise<unknown>
    }
    session: { get(input: { path: { id: string }; throwOnError: true }): Promise<{
      data: { id: string; parentID?: string }
    }> }
  }
}, modules?: {
  createServer: typeof import('node:http').createServer
  randomBytes: typeof import('node:crypto').randomBytes
}) {
  const tasks = new Map<string, { sessionId: string; callId: string }>()
  const pending = new Map<string, { sessionId: string; root: string }>()
  let endpoint: string | undefined
  let closed = false
  let closeServer: (() => void) | undefined
  if (input) {
    const { createServer, randomBytes } = modules!
    const token = randomBytes(32).toString('base64url')
    const server = createServer(async (request, response) => {
      try {
        if (request.method !== 'POST' || request.url !== `/${token}`) {
          response.writeHead(404).end()
          return
        }
        let body = ''
        for await (const chunk of request) {
          body += chunk
          if (body.length > 1024 * 1024) throw new Error('Question answer too large')
        }
        const answer = JSON.parse(body) as {
          questionId: string; sessionId: string; answers: string[][]
        }
        const question = pending.get(answer.questionId)
        if (!question || question.root !== answer.sessionId) {
          response.writeHead(409).end()
          return
        }
        const listed = await input.client._client.get({ url: '/question', throwOnError: true })
        if (!Array.isArray(listed.data) || !listed.data.some((item) =>
          item.id === answer.questionId && item.sessionID === question.sessionId
        )) {
          pending.delete(answer.questionId)
          response.writeHead(409).end()
          return
        }
        await input.client._client.post({
          url: `/question/${encodeURIComponent(answer.questionId)}/${answer.answers.length ? 'reply' : 'reject'}`,
          ...(answer.answers.length ? { body: { answers: answer.answers } } : {}),
          throwOnError: true
        })
        pending.delete(answer.questionId)
        response.writeHead(200).end('{}')
      } catch {
        response.writeHead(500).end()
      }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    server.unref()
    closeServer = () => { server.closeAllConnections(); server.close() }
    const address = server.address()
    if (address && typeof address !== 'string') endpoint = `http://127.0.0.1:${address.port}/${token}`
  }
  return Promise.resolve({
    dispose: async () => {
      closed = true
      pending.clear()
      tasks.clear()
      closeServer?.()
    },
    event: async ({ event }: { event: {
      type: string
      properties: {
        id?: string
        requestID?: string
        status?: { type?: string }
        sessionID?: string
        part?: {
          sessionID?: string
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
      if (closed) return
      if (event.type === 'session.status' && properties.status?.type === 'idle' && properties.sessionID) {
        for (const [id, question] of pending) {
          if (question.root !== properties.sessionID && question.sessionId !== properties.sessionID) continue
          pending.delete(id)
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: question.root, update: { sessionUpdate: 'tool_call_update', toolCallId: id,
              _meta: { goodbuddyQuestionResolved: id } }
          } }) + '\n')
        }
        for (const [child, owner] of tasks) {
          if (owner.sessionId === properties.sessionID) tasks.delete(child)
        }
        return
      }
      if (event.type === 'question.replied' || event.type === 'question.rejected') {
        const question = properties.requestID ? pending.get(properties.requestID) : undefined
        if (question) {
          pending.delete(properties.requestID!)
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: question.root, update: { sessionUpdate: 'tool_call_update', toolCallId: properties.requestID,
              _meta: { goodbuddyQuestionResolved: properties.requestID } }
          } }) + '\n')
        }
        return
      }
      if (event.type === 'question.asked' && input && endpoint && properties.id && properties.sessionID) {
        if (pending.has(properties.id)) return
        let root = properties.sessionID
        const seen = new Set<string>()
        for (;;) {
          if (seen.has(root)) return
          seen.add(root)
          const session = await input.client.session.get({ path: { id: root }, throwOnError: true })
          if (session.data.id !== root) return
          if (!session.data.parentID) break
          root = session.data.parentID
        }
        const listed = await input.client._client.get({ url: '/question', throwOnError: true })
        if (closed || pending.has(properties.id) || !Array.isArray(listed.data) || !listed.data.some((item) =>
          item.id === properties.id && item.sessionID === properties.sessionID
        )) return
        pending.set(properties.id, { sessionId: properties.sessionID, root })
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: root, update: {
              sessionUpdate: 'tool_call_update', toolCallId: properties.id,
              _meta: { goodbuddyQuestion: { question: properties, endpoint,
                childCallId: tasks.get(properties.sessionID)?.callId } }
            }
          }
        }) + '\n')
        return
      }
      const part = properties.part
      const sessionId = properties.sessionID ?? part?.sessionID
      let owner = sessionId ? tasks.get(sessionId) : undefined
      if (
        event.type === 'message.part.updated' &&
        part?.type === 'tool' && part.tool === 'task' &&
        part.callID && sessionId
      ) {
        owner ??= { sessionId, callId: part.callID }
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
