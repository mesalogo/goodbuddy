// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentImageToolMcp } from './image-tool-mcp'
import { imageOperationSchema } from '../shared/image-generation-contracts'
import { AssistantDatabase } from '../main/assistant/assistant-database'
import { ImageGenerationService } from '../main/agent/image-generation-service'
import { MainImageToolSession } from '../main/remote-agent/main-image-tool-session'
import type { RuntimeProtocolBinaryChannel, RuntimeProtocolBinaryFrame } from '../main/remote-agent/protocol-remote-runtime-channel'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, toPNG: () => Buffer.from(png, 'base64') }) } }))
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function setup() {
  const received: { path: string; body: string; authorization?: string }[] = []
  let release: (() => void) | undefined
  let hold = false
  const provider = createServer((req, res) => {
    void (async () => {
      let body = ''
      for await (const chunk of req) body += chunk
      received.push({ path: req.url!, body, authorization: req.headers.authorization })
      if (hold) await new Promise<void>(resolve => { release = resolve })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ b64_json: png }] }))
    })()
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => { release?.(); provider.closeAllConnections(); provider.close() })
  const address = provider.address() as { port: number }
  const database = new AssistantDatabase(':memory:')
  database.initialize(process.cwd())
  cleanup.push(() => database.close())
  const context = { conversationId: randomUUID(), messageId: randomUUID(), requestId: randomUUID(), workMode: 'execute' as 'ask' | 'execute' }
  database.saveLocalConversations([{ header: { id: context.conversationId, title: 'Remote images', updatedAt: 1 },
    messages: [{ id: context.messageId, role: 'assistant', content: '', createdAt: 1, state: 'complete' }] }])
  const profile = { id: randomUUID(), name: 'Controlled image provider', modelName: 'controlled-image',
    protocol: 'openai-images-generations', allowConversationInvocation: true,
    baseUrl: `http://127.0.0.1:${address.port}/v1`, authentication: 'api-key' as const, apiKey: 'controlled-main-only' }
  const service = new ImageGenerationService({ database, getSettings: async () => ({ modelProfiles: [profile], defaultImageModelProfileId: profile.id }) })
  service.initialize()
  cleanup.push(() => service.dispose())
  const frames: Uint8Array[] = []
  const connect = async (mode: 'ask' | 'execute' = 'execute') => {
    const binding = service.bind({ ...context, requestId: randomUUID(), workMode: mode })
    const queue: RuntimeProtocolBinaryFrame[] = []
    let receiver: ((frame: RuntimeProtocolBinaryFrame) => void) | undefined
    let rejectReceive: ((error: unknown) => void) | undefined
    const listeners = new Set<() => void>()
    let closed = false
    const channel: RuntimeProtocolBinaryChannel = {
      channelId: randomUUID(), channelEpoch: '1',
      send: async payload => { frames.push(payload); adapter.onReply(payload) },
      receive: async () => queue.shift() ?? await new Promise((resolve, reject) => { receiver = resolve; rejectReceive = reject }),
      close: () => { if (closed) return; closed = true; rejectReceive?.(new Error('closed')); for (const fn of listeners) fn() },
      onClose: fn => { listeners.add(fn); return () => { listeners.delete(fn) } }
    }
    const wait = new AbortController()
    const main = new MainImageToolSession(channel, binding, wait.signal)
    const adapter = new AgentImageToolMcp({ channelId: channel.channelId, channelEpoch: '1', description: await binding.describe() ?? 'Not available' }, async payload => {
      if (closed) throw new Error('disconnected')
      frames.push(payload)
      const frame = { payload, sequence: '1', consume: async () => {} }
      if (receiver) { const resolve = receiver; receiver = undefined; resolve(frame) } else queue.push(frame)
    })
    await adapter.start()
    const client = new Client({ name: 'remote-image-test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(adapter.url!)))
    cleanup.push(async () => { main.close(); adapter.close(); await client.close() })
    return { client, adapter, wait, main, binding }
  }
  return { received, context, profile, service, database, connect, frames,
    hold: () => { hold = true }, release: () => release?.() }
}

describe('remote image MCP to Main service', () => {
  it('generates, edits persisted uploads and history through a controlled HTTP provider', async () => {
    const h = await setup()
    const remote = await h.connect()
    expect((await remote.client.listTools()).tools[0]!.description).toContain(h.profile.id)
    const call = async (args: Record<string, unknown>) => {
      const result = await remote.client.callTool({ name: 'generate_image', arguments: args })
      expect(result.isError).not.toBe(true)
      return imageOperationSchema.parse(JSON.parse((result.content as { text: string }[])[0]!.text))
    }
    const first = await call({ intent: 'create', prompt: 'A blue square' })
    const uploaded = h.service.persistUploads(h.context, [{ name: 'source.png', mediaType: 'image/png', data: png }])
    const uploadEdit = await call({ intent: 'edit', prompt: 'Make the uploaded square red', sourceArtifactIds: uploaded })
    const historyEdit = await call({ intent: 'edit', prompt: 'Make the previous result green', sourceArtifactIds: first.artifactIds })
    expect([first, uploadEdit, historyEdit].map(op => op.state)).toEqual(['completed', 'completed', 'completed'])
    expect(h.received.map(call => call.path)).toEqual(['/v1/images/generations', '/v1/images/edits', '/v1/images/edits'])
    expect(h.received.every(call => call.authorization === 'Bearer controlled-main-only')).toBe(true)
    expect(h.received[1]!.body).toContain('name="image"')
    expect(h.database.getArtifact(historyEdit.artifactIds[0]!).content).toContain(png)
    expect(h.database.getConversation(h.context.conversationId).messages[0]!.imageOperations).toHaveLength(3)
    const wire = Buffer.concat(h.frames).toString()
    expect(wire).not.toContain(png)
    expect(wire).not.toContain('controlled-main-only')
    expect(wire).not.toContain(h.profile.baseUrl)
  })

  it.each(['chat cancellation', 'disconnect'])('preserves Main operation after %s without replay', async reason => {
    const h = await setup()
    h.hold()
    const remote = await h.connect()
    const waiting = remote.client.callTool({ name: 'generate_image', arguments: { intent: 'create', prompt: 'Blue' } }).catch(() => undefined)
    await vi.waitFor(() => expect(h.received).toHaveLength(1))
    if (reason === 'chat cancellation') remote.wait.abort()
    else remote.main.close()
    remote.adapter.close()
    h.release()
    await vi.waitFor(() => expect(h.database.getConversation(h.context.conversationId).messages[0]!.imageOperations?.[0]?.state).toBe('completed'))
    await waiting
    expect(h.received).toHaveLength(1)
  })

  it('rejects Ask calls at the desktop binding and refreshes a new prompt description', async () => {
    const h = await setup()
    const ask = await h.connect('ask')
    const denied = await ask.client.callTool({ name: 'generate_image', arguments: { intent: 'create', prompt: 'Blue' } })
    expect(denied.isError).toBe(true)
    expect(h.received).toHaveLength(0)
    h.profile.name = 'Changed next prompt'
    const execute = await h.connect()
    expect((await execute.client.listTools()).tools[0]!.description).toContain('Changed next prompt')
  })

  it('returns unknown delivery without sending a second request for the same MCP call', async () => {
    const send = vi.fn(async () => { throw new Error('connection lost after send') })
    const adapter = new AgentImageToolMcp({ channelId: randomUUID(), channelEpoch: '1', description: 'Images' }, send)
    await adapter.start()
    cleanup.push(() => adapter.close())
    const request = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'generate_image', arguments: { intent: 'create', prompt: 'Blue' } } }
    for (let i = 0; i < 2; i++) {
      const response = await fetch(adapter.url!, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(request) })
      const result = await response.json()
      expect(JSON.stringify(result)).toContain('unknown')
    }
    expect(send).toHaveBeenCalledOnce()
  })
})
