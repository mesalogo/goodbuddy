// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { it, expect, vi } from 'vitest'
import { KnowledgeMcpGateway } from '../src/main/agent/knowledge-mcp-gateway'
import { OpenCodeRuntime } from '../src/main/agent/opencode-runtime'

vi.mock('electron', () => ({ nativeImage: {} }))

const binaryPath = process.env.GOODBUDDY_TEST_OPENCODE_BINARY ?? join(process.cwd(), '.runtime-resources', process.arch, process.platform === 'win32' ? 'opencode.exe' : 'opencode')

it.skipIf(!existsSync(binaryPath)).for([true, false])('calls a newly loaded tool in real OpenCode (notification before result: %s)', { timeout: 120_000 }, async notify => {
  const name = 'opencode' as const
  const parent = join(process.cwd(), 'temp', 'crm-dynamic-runtime')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, `${name}-`))
  const sessions = new Map<string, { protocol: Server; transport: StreamableHTTPServerTransport }>()
  let loaded = false
  let listCalls = 0
  let readCalls = 0
  let loadCalls = 0
  const catalogs: string[][] = []
  const upstream = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) text += chunk
      const body = text ? JSON.parse(text) : undefined
      const id = request.headers['mcp-session-id']
      let session = typeof id === 'string' ? sessions.get(id) : undefined
      if (!session) {
        if (!isInitializeRequest(body)) { response.writeHead(404).end(); return }
        const protocol = new Server({ name: 'crm-protocol-fixture', version: '1' }, { capabilities: { tools: { listChanged: true } } })
        protocol.setRequestHandler(ListToolsRequestSchema, async () => {
          listCalls++
          return { tools: (loaded ? ['crmtools_load_tools', 'crmtools_list_customer_tags'] : ['crmtools_load_tools']).map(tool => ({ name: tool, description: tool, inputSchema: { type: 'object' as const, properties: {} } })) }
        })
        protocol.setRequestHandler(CallToolRequestSchema, async request => {
          if (request.params.name === 'crmtools_load_tools') {
            loadCalls++; loaded = true
            if (notify) await protocol.sendToolListChanged()
          } else if (request.params.name === 'crmtools_list_customer_tags') readCalls++
          else throw new Error('Unexpected tool')
          return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] }
        })
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: (id): void => { sessions.set(id, { protocol, transport }) } })
        session = { protocol, transport }; await protocol.connect(transport)
      }
      await session.transport.handleRequest(request, response, body)
    } catch (error) { if (!response.headersSent) response.writeHead(500).end(String(error)) }
  })
  const model = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) text += chunk
      const body = JSON.parse(text)
      const names = (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name) as string[]
      catalogs.push(names.filter(tool => tool.includes('crmtools')))
      const suffix = !loadCalls ? 'crmtools_load_tools' : !readCalls ? 'crmtools_list_customer_tags' : undefined
      const tool = suffix && names.find(tool => tool.endsWith(suffix))
      const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: tool, arguments: '{}' } }] } : { role: 'assistant', content: readCalls ? 'DYNAMIC_OK' : 'DYNAMIC_MISSING' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const [value, finish] of [[delta, null], [{}, tool ? 'tool_calls' : 'stop']]) response.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    } catch (error) { response.writeHead(500).end(String(error)) }
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  const gateway = new KnowledgeMcpGateway({} as never)
  await gateway.start()
  const common = { defaultWorkspace: root, knowledgeGateway: gateway, configPath: '',
    mcpServers: [{ id: randomUUID(), name: 'crm', description: '', enabled: true, allowDynamicTools: true, assignments: [name], secretConfigured: false, transport: 'http' as const, url: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/mcp` }],
    modelProfile: { id: randomUUID(), name: 'fixture', modelName: 'fixture', protocol: 'openai-chat-completions' as const, authentication: 'none' as const, baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1` } }
  const runtime = new OpenCodeRuntime({ ...common, embedded: true, binaryPath, sharedCacheRoot: join(root, 'cache') })
  let output = ''
  const errors: string[] = []
  try {
    for await (const event of runtime.run({ requestId: randomUUID(), conversationId: randomUUID(), prompt: 'Load CRM tools, then list customer tags.' }, AbortSignal.timeout(90_000))) {
      if (event.type === 'text') output += event.delta
      if (event.type === 'error') errors.push(JSON.stringify(event))
    }
    expect(errors).toEqual([])
    expect(loadCalls).toBe(1)
    expect(readCalls).toBe(1)
    expect(output).toBe('DYNAMIC_OK')
    expect(catalogs).toHaveLength(3)
    expect(catalogs[0]).toHaveLength(1)
    expect(catalogs[1]).toHaveLength(2)
    expect(catalogs[1]?.some(tool => tool.endsWith('crmtools_list_customer_tags'))).toBe(true)
    expect(listCalls).toBeGreaterThanOrEqual(3)
  } finally {
    await runtime.dispose(); await gateway.dispose()
    for (const session of sessions.values()) await session.protocol.close()
    upstream.closeAllConnections(); model.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => upstream.close(() => resolve())), new Promise<void>(resolve => model.close(() => resolve()))])
    await rm(root, { recursive: true, force: true })
  }
})
