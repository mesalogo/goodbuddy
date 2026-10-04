// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeDshWebClientService, resolveNativeDshCli, type NativeDshWebRequest } from './native-dsh-web-client'
import { nativeDshWebPatch } from './native-dsh-web-policy'

const roots: string[] = []
const services: NativeDshWebClientService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-native-dsh-'))
  roots.push(root)
  return root
}
const profile: NativeDshWebRequest['profile'] = {
  id: 'test', name: 'Test', protocol: 'openai-chat-completions',
  authentication: 'api-key', apiKey: 'provider-secret-must-stay-in-main',
  baseUrl: 'http://127.0.0.1:1', modelName: 'test-model'
}

describe('native DS Web configuration', () => {
  it('uses normal upstream execution settings without a generated tool restriction', () => {
    const patch = nativeDshWebPatch({ model: 'test', api: 'openai-completions', baseURL: 'http://localhost/v1',
      skillDirectories: [], mcpServers: [{ serverName: 'docs', transport: 'streamable-http', url: 'http://localhost/mcp' }] })
    expect(patch).toEqual(expect.arrayContaining([
      { id: 'sandbox-policy', config: { mode: 'danger-full-access' } },
      { id: 'approval', config: { policy: 'never' } }
    ]))
    expect(JSON.stringify(patch)).not.toContain('goodbuddy-native-mode')
    expect(JSON.stringify(patch)).toContain('@deepseek-ai/dsh-mcp-client')
  })
  it('resolves the packaged CLI outside ASAR', () => {
    expect(resolveNativeDshCli('/resources')).toBe(join('/resources', 'runtimes/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'))
  })
})

const standardNode = process.env.NATIVE_DSH_TEST_NODE ?? (!process.versions.electron ? process.execPath : undefined)
describe.skipIf(!standardNode)('official DS Web process', () => {
  it('initializes the workspace, coalesces starts, isolates configuration and preserves history on stop', async () => {
    const root = await temporary()
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const service = new NativeDshWebClientService({
      rootDirectory: join(root, 'homes'),
      cliPath: process.env.NATIVE_DSH_TEST_CLI,
      resolveLaunchEnvironment: async () => ({ nodeExecutablePath: standardNode!, environment: process.env })
    })
    services.push(service)
    const request: NativeDshWebRequest = { projectId: 'one', workspace, profile }
    const [first, repeated] = await Promise.all([service.start(request), service.start(request)])
    expect(first).toEqual(repeated)
    const config = await readFile(join(root, 'homes', first.id, 'cordis.patch.yml'), 'utf8')
    expect(config).toContain('test-model')
    expect(config).not.toContain(profile.apiKey)
    const auth = await fetch(first.url, { redirect: 'manual' })
    const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const page = await fetch(new URL('/', first.url), { headers: { cookie } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<html')
    expect(await service.start(request)).toEqual(first)
    const history = join(root, 'homes', first.id, 'history-marker')
    await writeFile(history, 'retained')
    const changedConfiguration = await service.start({ ...request, configurationKey: 'updated-skill-digest' })
    expect(changedConfiguration.id).not.toBe(first.id)
    expect(await service.start({ ...request, configurationKey: 'updated-skill-digest' })).toEqual(changedConfiguration)
    await service.stop(changedConfiguration.id)
    await service.stop(first.id)
    await expect(fetch(first.url)).rejects.toThrow()
    expect(await readFile(history, 'utf8')).toBe('retained')
    await expect(readFile(join(root, 'homes', first.id, 'cordis.patch.yml'))).rejects.toThrow()
    const restarted = await service.start(request)
    expect(restarted.id).toBe(first.id)
    expect(restarted.url).not.toBe(first.url)
    await service.dispose()
    await expect(service.start(request)).rejects.toThrow('disposed')
  }, 120_000)

  it('routes official Web writes, skills and MCP calls through the model bridge without a mode', async () => {
    const root = await temporary()
    const skills = join(root, 'skills')
    await mkdir(skills)
    await writeFile(join(skills, 'SKILL.md'), '---\nname: native-test\ndescription: Native test skill\n---\nSKILL_LOADED_MARKER')
    const toolResults: string[] = []
    let mcpCalls = 0
    const mcp = createServer(async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405).end(); return }
      let body = ''
      for await (const chunk of request) body += chunk
      const message = JSON.parse(body)
      if (message.id === undefined) { response.writeHead(202).end(); return }
      let result: unknown = {}
      if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } }
      if (message.method === 'tools/list') result = { tools: [
        { name: 'lookup', description: 'Read test data', inputSchema: { type: 'object', properties: {} } },
        { name: 'mutate', description: 'Write test data', inputSchema: { type: 'object', properties: {} } }
      ] }
      if (message.method === 'tools/call') { mcpCalls++; result = { content: [{ type: 'text', text: 'MCP_CALLED_MARKER' }] } }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
    await new Promise<void>(resolve => mcp.listen(0, '127.0.0.1', resolve))
    const address = mcp.address() as { port: number }
    const fetcher: typeof fetch = async (_url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${profile.apiKey}`)
      const body = JSON.parse(String(init?.body))
      expect(body.model).toBe(profile.modelName)
      const toolResult = body.messages.findLast((message: { role: string }) => message.role === 'tool')
      const user = JSON.stringify(body.messages)
      const toolName = user.includes('Load skill') ? 'skill' : user.includes('MCP read') ? 'mcp__test__lookup'
        : user.includes('MCP write') ? 'mcp__test__mutate' : 'write'
      const write = !toolResult && body.tools?.some((tool: { function: { name: string } }) => tool.function.name === toolName)
      if (toolResult) toolResults.push(JSON.stringify(toolResult.content))
      const delta = write ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_write', type: 'function',
        function: { name: toolName, arguments: JSON.stringify(toolName === 'write'
          ? { file_path: join(root, 'written.txt'), content: 'EXECUTED' } : toolName === 'skill' ? { name: 'native-test' } : {}) } }] }
        : { role: 'assistant', content: 'Finished' }
      const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
      return new Response(event({ id: 'test', object: 'chat.completion.chunk', model: profile.modelName,
        choices: [{ index: 0, delta, finish_reason: null }] }) + event({ id: 'test', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: write ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } })
    }
    const service = new NativeDshWebClientService({ rootDirectory: join(root, 'homes'), fetcher,
      cliPath: process.env.NATIVE_DSH_TEST_CLI,
      resolveLaunchEnvironment: async () => ({ nodeExecutablePath: standardNode!, environment: process.env }) })
    services.push(service)
    try {
      const handle = await service.start({ projectId: 'tools', workspace: root, profile,
        skillDirectories: [skills], mcpServers: [{ serverName: 'test', transport: 'streamable-http',
          url: `http://127.0.0.1:${address.port}/mcp` }] })
      const auth = await fetch(handle.url, { redirect: 'manual' })
      const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
      async function rpc(method: string, request: unknown): Promise<Record<string, unknown>> {
        const response = await fetch(new URL(`/api/${method}`, handle.url), { method: 'POST',
          headers: { 'content-type': 'application/json', cookie, origin: new URL(handle.url).origin },
          body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: { request } } }) })
        const payload = await response.json() as { result?: { ok?: boolean; value: Record<string, unknown> } }
        expect(payload.result?.ok, JSON.stringify(payload)).toBe(true)
        return payload.result!.value
      }
      const session = await rpc('session/create', { cwd: root })
      const previous = toolResults.length
      await rpc('session/prompt', { sessionId: session.sessionId, requestId: crypto.randomUUID(), mode: 'queue',
        content: [{ type: 'text', text: 'Write the requested marker file.' }] })
      await vi.waitFor(() => expect(toolResults.length).toBeGreaterThan(previous), { timeout: 15_000 })
      expect(await readFile(join(root, 'written.txt'), 'utf8')).toBe('EXECUTED')
      for (const prompt of ['Load skill', 'MCP read', 'MCP write']) {
        const next = await rpc('session/create', { cwd: root })
        const before = toolResults.length
        const callsBefore = mcpCalls
        await rpc('session/prompt', { sessionId: next.sessionId, requestId: crypto.randomUUID(), mode: 'queue',
          content: [{ type: 'text', text: prompt }] })
        await vi.waitFor(() => expect(toolResults.length).toBeGreaterThan(before), { timeout: 15_000 })
        if (prompt === 'Load skill') await vi.waitFor(() => expect(toolResults.slice(before).join()).toContain('SKILL_LOADED_MARKER'), { timeout: 15_000 })
        else {
          await vi.waitFor(() => expect(toolResults.slice(before).join()).toContain('MCP_CALLED_MARKER'), { timeout: 15_000 })
          expect(mcpCalls).toBe(callsBefore + 1)
        }
      }
    } finally {
      await service.dispose()
      mcp.closeAllConnections()
      await new Promise<void>(resolve => mcp.close(() => resolve()))
    }
  }, 60_000)

  it('cleans failed launches and permits retry', async () => {
    const root = await temporary()
    const service = new NativeDshWebClientService({ rootDirectory: join(root, 'homes'), cliPath: join(root, 'missing.js'),
      resolveLaunchEnvironment: async () => ({ nodeExecutablePath: standardNode!, environment: process.env }) })
    services.push(service)
    const request: NativeDshWebRequest = { projectId: 'one', workspace: root, profile }
    await expect(service.start(request)).rejects.toThrow()
    await expect(service.start(request)).rejects.toThrow()
  })

  it('cancels an in-progress launch when disposed', async () => {
    const root = await temporary()
    const cliPath = join(root, 'waiting.mjs')
    await writeFile(cliPath, 'setInterval(() => {}, 1000)')
    const service = new NativeDshWebClientService({ rootDirectory: join(root, 'homes'), cliPath,
      resolveLaunchEnvironment: async () => ({ nodeExecutablePath: standardNode!, environment: process.env }) })
    services.push(service)
    const starting = service.start({ projectId: 'pending', workspace: root, profile })
    const rejected = expect(starting).rejects.toThrow()
    await new Promise(resolve => setTimeout(resolve, 200))
    await service.dispose()
    await rejected
  })
})
