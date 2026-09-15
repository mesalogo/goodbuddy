/**
 * OpenCode's ACP adapter omits native questions and child sessions. Native
 * events use ACP metadata; question replies use a process-local capability.
 */
export function openCodeSubagentPluginSource(modelBridgeOrigin?: string): string {
  return `import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
export default (input) => (${plugin.toString()})(input, { createServer, randomBytes, modelBridgeOrigin: ${JSON.stringify(modelBridgeOrigin)} })`
}

async function plugin(input?: {
  client: {
    _client: {
      get(input: { url: string; throwOnError: true }): Promise<{ data: unknown }>
      post(input: { url: string; body?: unknown; throwOnError: true }): Promise<unknown>
      patch(input: { url: string; body: unknown; throwOnError: true }): Promise<unknown>
    }
    session: { get(input: { path: { id: string }; throwOnError: true }): Promise<{
      data: { id: string; parentID?: string; permission?: Array<{ permission: string; pattern: string; action: string }> }
    }> }
  }
}, modules?: {
  createServer: typeof import('node:http').createServer
  randomBytes: typeof import('node:crypto').randomBytes
  modelBridgeOrigin?: string
}) {
  const tasks = new Map<string, { sessionId: string; callId: string }>()
  const pending = new Map<string, { sessionId: string; root: string }>()
  const modelMessages = new Map<string, { sessionId: string; operationId: string; workMode: 'ask' | 'execute'; imageToolName?: string }>()
  const modelRoute = async (sessionId: string, messageId: string) => {
    const key = `${sessionId}\0${messageId}`
    const previous = modelMessages.get(key)
    if (previous) return previous
    if (!input || !modules?.modelBridgeOrigin) return undefined
    let root = sessionId
    const seen = new Set<string>()
    for (;;) {
      if (seen.has(root)) throw new Error('OpenCode Session parent cycle')
      seen.add(root)
      const session = await input.client.session.get({ path: { id: root }, throwOnError: true })
      if (!session.data.parentID) break
      root = session.data.parentID
    }
    const response = await fetch(`${modules.modelBridgeOrigin}/session?sessionId=${encodeURIComponent(root)}`)
    if (!response.ok) throw new Error('GoodBuddy model operation is no longer active')
    const { operationId, workMode, imageToolName } = await response.json() as { operationId: string; workMode: 'ask' | 'execute'; imageToolName?: string }
    const route = { sessionId: root, operationId, workMode, imageToolName }
    modelMessages.set(key, route)
    return route
  }
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
      modelMessages.clear()
      closeServer?.()
    },
    'chat.message': async (
      request: { sessionID: string },
      output: { message: { id: string } }
    ) => {
      const route = await modelRoute(request.sessionID, output.message.id)
      if (!route) return
      // Native ACP only forwards permissions for its registered root Sessions.
      // Use native Session rules so child tools use Execute and Ask's
      // unavailable tools are omitted instead of interrupting the prompt.
      const permission = route.workMode === 'execute'
        ? [{ permission: '*', pattern: '*', action: 'allow' }]
        : [
            { permission: '*', pattern: '*', action: 'deny' },
            ...['read', 'glob', 'grep', 'list', 'lsp', 'webfetch', 'websearch', 'codesearch', 'question', 'external_directory']
              .map(permission => ({ permission, pattern: '*', action: 'allow' }))
          ]
      if (route.sessionId !== request.sessionID) {
        const child = await input!.client.session.get({ path: { id: request.sessionID }, throwOnError: true })
        // OpenCode copies parent denies, not parent allows, into children.
        // Keep its explicit subagent restrictions after the request rules.
        permission.push(...(child.data.permission ?? []).filter(rule => rule.permission !== '*'))
      }
      permission.push({ permission: 'goodbuddy_image_*', pattern: '*', action: 'deny' })
      if (route.workMode === 'execute' && route.imageToolName) {
        permission.push({ permission: `${route.imageToolName}_*`, pattern: '*', action: 'allow' })
      }
      await input!.client._client.patch({
        url: `/session/${encodeURIComponent(request.sessionID)}`, body: { permission }, throwOnError: true
      })
    },
    'chat.headers': async (
      request: { sessionID: string; message: { id: string } },
      output: { headers: Record<string, string> }
    ) => {
      const route = await modelRoute(request.sessionID, request.message.id)
      if (!route) return
      output.headers['x-goodbuddy-session'] = route.sessionId
      output.headers['x-goodbuddy-operation'] = route.operationId
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
        for (const [key, route] of modelMessages) {
          if (route.sessionId === properties.sessionID) modelMessages.delete(key)
        }
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
