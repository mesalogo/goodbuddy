// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, expect, it, vi } from 'vitest'
import { AssistantDatabase } from '../main/assistant/assistant-database'
import type { KnowledgeService } from '../main/knowledge/knowledge-service'
import { KnowledgeMcpGateway, type StoryGraphBinding } from '../main/agent/knowledge-mcp-gateway'
import { ModelToolProvider } from '../main/agent/model-tool-provider'
import { AgentImageToolMcp } from './image-tool-mcp'
import { MainImageToolSession } from '../main/remote-agent/main-image-tool-session'
import type { RuntimeProtocolBinaryChannel, RuntimeProtocolBinaryFrame } from '../main/remote-agent/protocol-remote-runtime-channel'
import { storyGraphToolNames } from '../shared/story-graph-tools'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function fixture() {
  const db = new AssistantDatabase(':memory:'); db.initialize(process.cwd())
  cleanups.push(() => db.close())
  const projectId = db.listProjects()[0]!.id
  const conversationId = randomUUID()
  db.saveLocalConversations([{ header: { id: conversationId, projectId, title: 'Graph', updatedAt: Date.now() }, messages: [] }])
  db.saveSupervisionResult({ request: { trigger: 'manual', scope: { kind: 'projects', projectIds: [projectId] }, timeRange: { from: '2026-09-01T00:00:00Z', to: '2026-09-30T00:00:00Z' } },
    evidence: [{ id: 'quote', sourceType: 'conversation', sourceId: 'original', title: 'Evidence', occurredAt: '2026-09-01T00:00:00Z', content: 'Decision A is revised to B, C remains only an option.' }],
    output: { summary: 'Decision history', changeDigest: '', openItems: ['Not yet executed'], entities: [{ id: 'decision', label: 'Decision', description: 'Decision A revised to B', sourceReferenceIds: ['quote'] }],
      events: [], relations: [], entityChanges: [] } })
  let enabled = true, assigned = true
  const read = vi.fn(db.readStoryGraph.bind(db))
  const available = vi.fn(async (binding: StoryGraphBinding) => enabled && assigned && db.isConversationStoryGraphEnabled(binding.conversationId!))
  const gateway = new KnowledgeMcpGateway({} as KnowledgeService, { storyGraphService: { available, read } })
  cleanups.push(() => gateway.dispose())
  const wait = new AbortController()
  const token = gateway.grant('graph', [], wait.signal, 'none', undefined, undefined, undefined, undefined, undefined, { projectId, conversationId, runtimeTarget: 'model' })!
  return { db, projectId, conversationId, gateway, token, wait, read, available,
    disable: () => { enabled = false }, unassign: () => { assigned = false } }
}

async function client(url: string, token?: string) {
  const connection = new Client({ name: 'graph-test', version: '1' })
  await connection.connect(new StreamableHTTPClientTransport(new URL(url), token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined))
  cleanups.push(() => connection.close())
  return connection
}

it.each(['local', 'remote'] as const)('%s HTTP MCP reads SQLite through Main and revokes discovery and old calls when conversation is disabled', async transport => {
  const f = fixture()
  let connection: Client
  if (transport === 'local') {
    await f.gateway.start()
    connection = await client(f.gateway.getEndpoint()!, f.token)
  } else {
    // Real Agent HTTP adapter, binary messages and Main dispatcher; only the wire carrier is in-process.
    const queue: RuntimeProtocolBinaryFrame[] = []
    let receive: ((frame: RuntimeProtocolBinaryFrame) => void) | undefined
    let reject: ((error: Error) => void) | undefined
    const channel: RuntimeProtocolBinaryChannel = {
      channelId: randomUUID(), channelEpoch: '1',
      send: async payload => adapter.onReply(payload),
      receive: async () => queue.shift() ?? await new Promise((resolve, fail) => { receive = resolve; reject = fail }),
      close: () => reject?.(new Error('closed')), onClose: () => () => {}
    }
    const adapter = new AgentImageToolMcp({ channelId: channel.channelId, channelEpoch: '1', storyGraph: true }, async payload => {
      const frame = { payload, sequence: '1', consume: async () => {} }
      if (receive) { const resolve = receive; receive = undefined; resolve(frame) } else queue.push(frame)
    })
    const main = new MainImageToolSession(channel, undefined, f.wait.signal, f.gateway.bindRemoteStoryGraph(f.token))
    await adapter.start()
    cleanups.push(() => { main.close(); adapter.close() })
    connection = await client(adapter.url!)
  }
  const tools = (await connection.listTools()).tools
  expect(tools.map(tool => tool.name)).toEqual(storyGraphToolNames)
  expect(tools.every(tool => tool.annotations?.readOnlyHint)).toBe(true)
  const search = await connection.callTool({ name: 'story_graph_search', arguments: { query: 'Decision', page_size: 1 } })
  expect(search.isError).not.toBe(true)
  const result = JSON.parse((search.content as { text: string }[])[0]!.text)
  expect(result.resolved_scope).toEqual({ kind: 'projects', projectIds: [f.projectId] })
  expect(result.page.has_more).toBe(true)
  const context = await connection.callTool({ name: 'story_graph_get_context', arguments: { object_ref: result.items[0].object_ref, mode: 'timeline' } })
  expect(context.isError).not.toBe(true)
  const reference = (f.db.getSupervisionGraph({}).sources as { id: string }[])[0]!.id
  const source = await connection.callTool({ name: 'story_graph_read_source', arguments: { source_reference_id: reference } })
  expect(JSON.stringify(source)).toContain('revised to B')
  const unsupported = await connection.callTool({ name: 'story_graph_get_context', arguments: { object_ref: result.items[0].object_ref, mode: 'as_of' } })
  expect(unsupported.isError).toBe(true)
  expect(JSON.stringify(unsupported)).toContain('unsupported_mode')
  const before = f.read.mock.calls.length
  f.db.setConversationStoryGraphEnabled(f.conversationId, false)
  expect((await connection.listTools()).tools).toEqual([])
  const blocked = await connection.callTool({ name: 'story_graph_search', arguments: { query: 'Decision', cursor: result.page.next_cursor, page_size: 1 } })
  expect(blocked.isError).toBe(true)
  expect(f.read).toHaveBeenCalledTimes(before)
  f.db.setConversationStoryGraphEnabled(f.conversationId, true)
  expect((await connection.listTools()).tools.map(tool => tool.name)).toEqual(storyGraphToolNames)
  f.disable()
  expect((await connection.listTools()).tools).toEqual([])
})

it('direct Model uses the same reader and runtime assignment gate', async () => {
  const f = fixture()
  const provider = new ModelToolProvider(process.cwd(), [], undefined, f.gateway)
  cleanups.push(() => provider.dispose())
  const context = { conversationId: 'graph', knowledgeCapabilityToken: f.token }
  expect((await provider.listTools(context, f.wait.signal)).filter(tool => tool.name.startsWith('story_graph_')).map(tool => tool.name)).toEqual(storyGraphToolNames)
  const result = await provider.callTool('story_graph_search', { query: 'Decision' }, f.wait.signal, context)
  expect(JSON.stringify(result)).toContain(f.projectId)
  f.db.setConversationStoryGraphEnabled(f.conversationId, false)
  expect((await provider.listTools(context, f.wait.signal)).some(tool => tool.name.startsWith('story_graph_'))).toBe(false)
  await expect(provider.callTool('story_graph_search', { query: 'Decision' }, f.wait.signal, context)).rejects.toThrow('story_graph_unavailable')
  f.db.setConversationStoryGraphEnabled(f.conversationId, true)
  f.unassign()
  expect((await provider.listTools(context, f.wait.signal)).some(tool => tool.name.startsWith('story_graph_'))).toBe(false)
  await expect(provider.callTool('story_graph_search', { query: 'Decision' }, f.wait.signal, context)).rejects.toThrow('story_graph_unavailable')
})

it('rejects disabled in-flight delivery and cancellation before the synchronous read', async () => {
  const f = fixture()
  f.available.mockImplementationOnce(async () => { f.wait.abort(); return true })
  await expect(f.gateway.callStoryGraphTool(f.token, 'story_graph_search', { query: 'Decision' })).rejects.toThrow()
  expect(f.read).not.toHaveBeenCalled()
  const other = fixture()
  other.read.mockImplementationOnce((...args) => { const result = other.db.readStoryGraph(...args); other.db.setConversationStoryGraphEnabled(other.conversationId, false); return result })
  await expect(other.gateway.callStoryGraphTool(other.token, 'story_graph_search', { query: 'Decision' })).rejects.toThrow('story_graph_unavailable')
})
