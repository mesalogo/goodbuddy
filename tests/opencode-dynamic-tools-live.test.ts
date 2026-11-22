// @vitest-environment node
// Live acceptance: real OpenCode binary + GoodBuddy gateway + real CRM MCP + real model.
// Skipped unless GOODBUDDY_LIVE_CRM_TOKEN, GOODBUDDY_LIVE_MODEL_API_KEY and
// GOODBUDDY_LIVE_MODEL_BASE_URL are set. Only read-only CRM tools are requested.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { it, expect, vi } from 'vitest'
import { KnowledgeMcpGateway } from '../src/main/agent/knowledge-mcp-gateway'
import { OpenCodeRuntime } from '../src/main/agent/opencode-runtime'

vi.mock('electron', () => ({ nativeImage: {} }))

const binaryPath = process.env.GOODBUDDY_TEST_OPENCODE_BINARY ?? join(process.cwd(), '.runtime-resources', process.arch, process.platform === 'win32' ? 'opencode.exe' : 'opencode')
const crmToken = process.env.GOODBUDDY_LIVE_CRM_TOKEN?.trim()
const crmUrl = process.env.GOODBUDDY_LIVE_CRM_URL?.trim() || 'https://crm.digiman.live/mcp'
const apiKey = process.env.GOODBUDDY_LIVE_MODEL_API_KEY?.trim()
const baseUrl = process.env.GOODBUDDY_LIVE_MODEL_BASE_URL?.trim()
const modelName = process.env.GOODBUDDY_LIVE_MODEL_NAME?.trim() || 'claude-sonnet-5-5'
const protocol = (process.env.GOODBUDDY_LIVE_MODEL_PROTOCOL?.trim() || 'anthropic-messages') as 'anthropic-messages'
const enabled = Boolean(crmToken && apiKey && baseUrl && existsSync(binaryPath))

it.skipIf(!enabled)('loads a CRM group and calls a newly exposed tool in real OpenCode', { timeout: 300_000 }, async () => {
  const parent = join(process.cwd(), 'temp', 'crm-live-runtime')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'opencode-'))
  const gateway = new KnowledgeMcpGateway({} as never)
  await gateway.start()
  const runtime = new OpenCodeRuntime({
    embedded: true, binaryPath, sharedCacheRoot: join(root, 'cache'), defaultWorkspace: root,
    knowledgeGateway: gateway, configPath: '',
    mcpServers: [{ id: randomUUID(), name: 'crm', description: '', enabled: true, allowDynamicTools: true, assignments: ['opencode'],
      secretConfigured: true, secret: crmToken!, transport: 'http' as const, url: crmUrl }],
    modelProfile: { id: randomUUID(), name: 'live', modelName, protocol, authentication: 'api-key' as const, apiKey: apiKey!, baseUrl: baseUrl! },
  })
  const tools: { name: string; state: string; error?: string }[] = []
  const errors: string[] = []
  let output = ''
  try {
    const prompt = [
      '这是一次只读的工具加载验证，禁止调用任何创建、修改、删除类工具。',
      '第一步：调用 crmtools_load_tools，参数 groups 为 ["customer_tag"]。',
      '第二步：load 返回后，从新增的工具里选一个名称含 list 的只读工具，调用一次（参数尽量留空或只传分页上限 1）。',
      '第三步：用一句话说明第二步调用的工具名和是否成功。',
    ].join('\n')
    for await (const event of runtime.run({ requestId: randomUUID(), conversationId: randomUUID(), prompt }, AbortSignal.timeout(240_000))) {
      if (event.type === 'text') output += event.delta
      if (event.type === 'error') errors.push(JSON.stringify(event).slice(0, 400))
      if (event.type === 'tool') tools.push({ name: event.name, state: event.state, ...(event.error ? { error: event.error.slice(0, 200) } : {}) })
    }
    const completed = tools.filter(tool => tool.state === 'completed').map(tool => tool.name)
    console.log('LIVE tools:', JSON.stringify(tools))
    console.log('LIVE output:', output.slice(0, 300))
    expect(errors).toEqual([])
    expect(completed.some(name => name.endsWith('crmtools_load_tools'))).toBe(true)
    const dynamic = completed.filter(name => /crmtools_/.test(name) && !name.endsWith('crmtools_load_tools'))
    expect(dynamic.length).toBeGreaterThan(0)
    expect(dynamic.every(name => /list|get|search|query/i.test(name))).toBe(true)
  } finally {
    await runtime.dispose(); await gateway.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
