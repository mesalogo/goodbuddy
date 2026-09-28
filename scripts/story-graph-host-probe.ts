// Deterministic SSH validation. Desktop owns SQLite; only tool messages cross SSH.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { AgentImageToolMcp } from '../src/agent-daemon/image-tool-mcp'
import { AgentOwnedAcpPrompt } from '../src/agent-daemon/agent-owned-acp-prompt'
import { SemanticPromptStore } from '../src/agent-daemon/semantic-prompt-store'
import { createOpenCodeModelBridgeProviderConfig } from '../src/agent-daemon/model-bridge-helper'
import type { RuntimeAcpProcessOwner } from '../src/agent-daemon/runtime-acp-backend'
import { ContinueHostAdapter } from '../src/main/agent/continue-host-adapter'
import { AssistantDatabase } from '../src/main/assistant/assistant-database'
import { KnowledgeMcpGateway } from '../src/main/agent/knowledge-mcp-gateway'
import type { KnowledgeService } from '../src/main/knowledge/knowledge-service'
import { MainImageToolSession } from '../src/main/remote-agent/main-image-tool-session'
import type { RuntimeProtocolBinaryChannel, RuntimeProtocolBinaryFrame } from '../src/main/remote-agent/protocol-remote-runtime-channel'
import { isStoryGraphTool, storyGraphToolNames } from '../src/shared/story-graph-tools'

const emit = (value: object) => process.stdout.write(`${JSON.stringify(value)}\n`)

async function hostProbe() {
  const [, , , opencode, continueEntry] = process.argv
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-graph-'))
  const adapter = new AgentImageToolMcp({ channelId: 'graph-probe', channelEpoch: '1', storyGraph: true }, async payload => { emit({ frame: Buffer.from(payload).toString('base64') }) })
  let disabled!: () => void
  const disabling = new Promise<void>(resolve => { disabled = resolve })
  const lines = createInterface({ input: process.stdin })
  lines.on('line', line => { const value = JSON.parse(line); if (value.frame) adapter.onReply(Buffer.from(value.frame, 'base64')); if (value.disabled) disabled() })
  const client = new Client({ name: 'story-graph-host-probe', version: '1' })
  let inferenceRequests = 0
  let backgroundRequests = 0
  const failures: unknown[] = []
  const inference = createServer((req, res) => { void (async () => {
    let text = ''; for await (const part of req) text += part
    const body = JSON.parse(text)
    if (++inferenceRequests > 20) throw new Error('Unexpected inference loop')
    const tools = body.tools as Array<{ function: { name: string } }> | undefined
    const tool = tools?.find(tool => tool.function.name.endsWith('story_graph_search'))
    if (tools?.length) assert.ok(tool, 'Runtime must expose Story Graph in Ask and Execute')
    else backgroundRequests++
    const result = body.messages.findLast((message: { role: string }) => message.role === 'tool')
    if (result) assert.match(JSON.stringify(result), /Decision B/)
    const delta = !tool ? { role: 'assistant', content: 'Graph probe title' } : result ? { role: 'assistant', content: 'GRAPH_RUNTIME_OK' } : { role: 'assistant', tool_calls: [{ index: 0, id: 'graph-call', type: 'function', function: {
      name: tool.function.name, arguments: JSON.stringify({ query: 'Decision B', page_size: 1 })
    } }] }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ id: 'graph-response', object: 'chat.completion.chunk', created: 1, model: 'graph-probe', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'graph-response', object: 'chat.completion.chunk', created: 1, model: 'graph-probe', choices: [{ index: 0, delta: {}, finish_reason: result || !tool ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
  })().catch(error => { failures.push(error); res.writeHead(500).end(String(error)) }) })
  try {
    await adapter.start()
    await client.connect(new StreamableHTTPClientTransport(new URL(adapter.url!)))
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), storyGraphToolNames)
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args }); assert.notEqual(result.isError, true)
      return JSON.parse((result.content as { text: string }[])[0]!.text)
    }
    const search = await call('story_graph_search', { query: 'Decision', page_size: 1 })
    assert.equal(search.page.has_more, true)
    await call('story_graph_search', { query: 'Decision', page_size: 1, cursor: search.page.next_cursor })
    const context = await call('story_graph_get_context', { object_ref: search.items[0].object_ref, mode: 'timeline' })
    assert.ok(context.items.length)
    const sourceId = context.items.flatMap((item: { source_reference_ids: string[] }) => item.source_reference_ids)[0]
    assert.ok(sourceId)
    const source = await call('story_graph_read_source', { source_reference_id: sourceId, page_size: 7 })
    assert.equal(source.page.has_more, true)
    await call('story_graph_read_source', { source_reference_id: sourceId, page_size: 7, cursor: source.page.next_cursor })
    const unsupported = await client.callTool({ name: 'story_graph_get_context', arguments: { object_ref: search.items[0].object_ref, mode: 'as_of' } })
    assert.equal(unsupported.isError, true)
    await new Promise<void>(resolve => inference.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(inference.address() as { port: number }).port}/${randomBytes(32).toString('base64url')}`
    for (const workMode of ['ask', 'execute'] as const) {
      const config = createOpenCodeModelBridgeProviderConfig({ protocol: 'openai-chat-completions', model: 'graph-probe', loopbackOrigin: origin, workMode })
      const permission = workMode === 'execute' ? 'allow' : { '*': 'deny', 'graph_story_graph_*': 'allow' }
      const child = spawn(opencode!, ['acp'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
        HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
        OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, permission, agent: { build: { permission } } })
      } })
      child.stderr.resume()
      const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
      const processOwner = {
        writeStdin: (payload: Uint8Array) => new Promise<void>((resolve, reject) => child.stdin.write(payload, error => error ? reject(error) : resolve())),
        subscribeOutput: (listener: Parameters<RuntimeAcpProcessOwner['subscribeOutput']>[0]) => { const data = (data: Buffer) => { void listener({ stream: 'stdout', data }) }; child.stdout.on('data', data); return () => { child.stdout.off('data', data) } },
        subscribeExit: (listener: () => void) => { child.on('close', listener); return () => { child.off('close', listener) } }
      } as RuntimeAcpProcessOwner
      const transcript = new SemanticPromptStore(join(root, `${workMode}.sqlite`))
      let done!: () => void
      const completed = new Promise<void>(resolve => { done = resolve })
      const owner = new AgentOwnedAcpPrompt({ bindingId: 'graph', controllerId: 'probe', workspaceDirectory: root, process: processOwner, transcript,
        mcpServers: () => [{ type: 'http', name: 'graph', url: adapter.url!, headers: [] }],
        completePrompt: async (_operation, _status, _response, commit) => { commit(); done() } })
      try {
        transcript.prepare({ bindingId: 'graph', controllerId: 'probe', operationId: workMode, requestId: workMode, preparationDigest: `sha256:${'a'.repeat(64)}`, promptSequence: 0 })
        await owner.start({ bindingId: 'graph', operationId: workMode, requestId: workMode, prompt: [{ type: 'text', text: 'Search the graph.' }] }, workMode)
        await completed
        const page = transcript.page({ bindingId: 'graph', operationId: workMode, controllerId: 'probe', afterSequence: '0', limit: 128 })
        assert.equal(page.state, 'completed'); assert.match(JSON.stringify(page), /GRAPH_RUNTIME_OK/)
      } finally { owner.close(); child.kill(); await exited; transcript.close() }
      const continueAdapter = new ContinueHostAdapter({ binaryPath: continueEntry!, configPath: '', workspace: root, cacheRoot: join(root, 'continue'), mode: 'chat',
        modelProfile: { id: 'probe', name: 'Probe', modelName: 'graph-probe', baseUrl: `${origin}/v1`, protocol: 'openai-chat-completions', authentication: 'none' },
        launchHost: (entry, args, options) => {
          const process = spawn(globalThis.process.execPath, [join(dirname(entry), 'utility-bootstrap.mjs'), entry, ...args], { ...options, env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
          process.stderr.on('data', data => globalThis.process.stderr.write(data))
          return process
        } })
      try {
        const result = await continueAdapter.run('Search the graph.', AbortSignal.timeout(40_000), async approval => workMode === 'execute' || isStoryGraphTool(approval.toolName ?? '') ? 'once' : 'deny', {
          workMode, sessionMcpServers: [{ name: 'graph', type: 'streamable-http', url: adapter.url!, requestOptions: { headers: {} } }]
        })
        assert.match(result.text, /GRAPH_RUNTIME_OK/)
      } finally { await continueAdapter.dispose() }
    }
    emit({ disable: true }); await disabling
    assert.deepEqual((await client.listTools()).tools, [])
    assert.equal((await client.callTool({ name: 'story_graph_search', arguments: { query: 'Decision' } })).isError, true)
    assert.deepEqual(failures, [])
    emit({ passed: true, inferenceRequests, backgroundRequests, paidCalls: 0, runtimes: ['OpenCode Ask', 'OpenCode Execute', 'Continue Ask', 'Continue Execute'] })
  } finally { lines.close(); await client.close(); adapter.close(); inference.closeAllConnections(); inference.close(); await rm(root, { recursive: true, force: true }) }
}

async function desktopProbe() {
  const [, , host, remoteScript, opencode, continueEntry] = process.argv
  assert.ok(host && remoteScript && opencode && continueEntry, 'Expected host, remote bundle, OpenCode and Continue paths')
  const db = new AssistantDatabase(':memory:'); db.initialize(process.cwd())
  const projectId = db.listProjects()[0]!.id
  db.saveSupervisionResult({ request: { trigger: 'manual', scope: { kind: 'projects', projectIds: [projectId] }, timeRange: { from: '2026-09-01T00:00:00Z', to: '2026-09-30T00:00:00Z' } },
    evidence: [{ id: 'quote', sourceType: 'conversation', sourceId: 'probe', title: 'Decision evidence', occurredAt: '2026-09-01T00:00:00Z', content: 'Decision A explicitly revised to Decision B; implementation remains pending.' }],
    output: { summary: 'Decision B', changeDigest: 'Revision A to B', openItems: ['Implementation pending'], events: [], entityChanges: [], relations: [],
      entities: [{ id: 'decision', label: 'Decision B', description: 'Explicit revision with evidence', sourceReferenceIds: ['quote'] }] } })
  let enabled = true, reads = 0, passed = false
  const gateway = new KnowledgeMcpGateway({} as KnowledgeService, { storyGraphService: { available: async () => enabled,
    read: (...args) => { assert.ok(enabled); reads++; return db.readStoryGraph(...args) } } })
  const signal = AbortSignal.timeout(150_000)
  const token = gateway.grant('probe', [], signal, 'none', undefined, undefined, undefined, undefined, undefined, { projectId, runtimeTarget: 'opencode' })!
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', host!,
    `TMPDIR=/root/tmp ELECTRON_RUN_AS_NODE=1 /opt/GoodBuddy/goodbuddy ${quote(remoteScript!)} --host ${quote(opencode!)} ${quote(continueEntry!)}`], { stdio: ['pipe', 'pipe', 'inherit'], signal })
  const exited = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
  const queue: RuntimeProtocolBinaryFrame[] = []
  let receive: ((frame: RuntimeProtocolBinaryFrame) => void) | undefined
  let reject: ((error: Error) => void) | undefined
  const channel: RuntimeProtocolBinaryChannel = { channelId: 'graph-probe', channelEpoch: '1',
    send: async payload => { child.stdin.write(`${JSON.stringify({ frame: Buffer.from(payload).toString('base64') })}\n`) },
    receive: async () => queue.shift() ?? await new Promise((resolve, fail) => { receive = resolve; reject = fail }),
    close: () => reject?.(new Error('closed')), onClose: () => () => {} }
  const main = new MainImageToolSession(channel, undefined, signal, gateway.bindRemoteStoryGraph(token))
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    const value = JSON.parse(line)
    if (value.frame) {
      const frame = { payload: Buffer.from(value.frame, 'base64'), sequence: '1', consume: async () => {} }
      if (receive) { const resolve = receive; receive = undefined; resolve(frame) } else queue.push(frame)
    } else if (value.disable) { enabled = false; child.stdin.write('{"disabled":true}\n') }
    else if (value.passed) { passed = true; emit({ ...value, desktopReads: reads, desktopOwnsDatabase: true }) }
  })
  try { assert.equal(await exited, 0); assert.ok(passed) }
  finally { lines.close(); main.close(); child.kill(); await gateway.dispose(); db.close() }
}

void (process.argv[2] === '--host' ? hostProbe() : desktopProbe()).catch(error => { console.error(error); process.exitCode = 1 })
