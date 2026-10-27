// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { connectDirectModelTestHost } from './support/remote-direct-model-connection'
import { AssistantDatabase } from '../src/main/assistant/assistant-database'
import { RemoteModelTools } from '../src/main/remote-agent/remote-model-tools'
import { createAgentRuntime } from '../src/main/agent/create-runtime'
import { defaultRuntimeSettings } from '../src/shared/contracts'
import type { ResolvedRuntimeSettings } from '../src/main/runtime-settings-store'

it.skipIf(!process.env.GB_DIRECT_MODEL_HOST || !process.env.GB_DIRECT_MODEL_HOST_NODE)('uses the edited prefix and a fresh conversation identity with current-source tools on the SSH Host', async () => {
  const connection = await connectDirectModelTestHost(process.env.GB_DIRECT_MODEL_HOST!, process.env.GB_DIRECT_MODEL_HOST_NODE!)
  const db = new AssistantDatabase(join(connection.local, 'assistant.sqlite'))
  await db.initialize(connection.local)
  const sourceId = randomUUID(), boundaryId = randomUUID()
  db.saveLocalConversations([{ header: { id: sourceId, title: 'Remote source', updatedAt: 1 }, messages: [
    { id: randomUUID(), role: 'user', content: 'PREFIX', state: 'complete', createdAt: 1 },
    { id: randomUUID(), role: 'assistant', content: 'ACK', state: 'complete', createdAt: 2 },
    { id: boundaryId, role: 'user', content: 'OLD QUESTION', state: 'complete', createdAt: 3 },
    { id: randomUUID(), role: 'assistant', content: 'OLD SUFFIX', state: 'complete', createdAt: 4 },
  ] }])
  const branch = db.branchLocalConversation({ sourceConversationId: sourceId, beforeMessageId: boundaryId, title: 'Remote edit' })
  const profile = { id: randomUUID(), name: 'Fixture', baseUrl: 'https://fixture.invalid/v1', modelName: 'fixture', protocol: 'openai-chat-completions' as const, authentication: 'none' as const, apiKey: '' }
  const tools = new RemoteModelTools(connection.workspace, {})
  const seen: string[] = []
  const ownedConversations: string[] = []
  const callTool = tools.callTool.bind(tools)
  tools.callTool = async (name, args, signal, context) => {
    if (context?.conversationId) ownedConversations.push(context.conversationId)
    return callTool(name, args, signal, context)
  }
  const runtime = createAgentRuntime(connection.local, { ...defaultRuntimeSettings, provider: 'model', contextCompression: { ...defaultRuntimeSettings.contextCompression, enabled: false }, modelProfiles: [profile], defaultModelProfileId: profile.id } as ResolvedRuntimeSettings, {
    executionSpace: { kind: 'ssh', hostId: 'host-test', remoteRootPath: `${connection.remote}/workspace`, cacheIdentity: connection.remote, routeIdentity: connection.remote, workspaceAccess: connection.workspace },
    remoteModelTools: tools, modelFetcher: async (_url, init) => {
      seen.push(String(init?.body))
      return Response.json(seen.length === 1 ? { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name: 'process_execute', arguments: JSON.stringify({ command: 'printf edited-branch-host' }) } }] } }] } : { choices: [{ message: { role: 'assistant', content: 'verified' } }] })
    },
  })
  try {
    const events = []
    for await (const event of runtime.run({ requestId: randomUUID(), conversationId: branch.id, prompt: 'EDITED QUESTION', history: branch.messages.map(({ role, content }) => ({ role, content })), historyMessageIds: branch.messages.map(message => message.id) }, AbortSignal.timeout(30000))) events.push(event)
    expect(events.filter(event => event.type === 'error')).toEqual([])
    expect(seen).toHaveLength(2)
    expect(seen[0]).toContain('PREFIX')
    expect(seen[0]).toContain('EDITED QUESTION')
    expect(seen.join('')).not.toMatch(/OLD QUESTION|OLD SUFFIX/u)
    expect(seen[1]).toContain('edited-branch-host')
    expect(ownedConversations).toEqual([branch.id])
    expect(branch.id).not.toBe(sourceId)
    expect(db.getConversation(sourceId).messages).toHaveLength(4)
    console.log(JSON.stringify({ sshBranchVerified: true, modelFixtureCalls: seen.length, externalModelCalls: 0, currentSourceHostTools: true }))
  } finally { await runtime.dispose(); db.close(); await connection.close() }
}, 90000)
