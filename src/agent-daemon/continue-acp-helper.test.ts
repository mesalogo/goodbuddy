import { readFile, rm, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Agent } from '@agentclientprotocol/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { ContinueHostAdapter, type ContinueHostRunOptions } from '../main/agent/continue-host-adapter'
import { runContinueAcpHelper } from './continue-acp-helper'

const transport = vi.hoisted(() => ({
  agent: undefined as Agent | undefined,
  close: () => {},
  mode: 'execute' as 'ask' | 'execute'
}))
vi.mock('@agentclientprotocol/sdk', () => ({
  PROTOCOL_VERSION: 1,
  ndJsonStream: vi.fn(),
  AgentSideConnection: class {
    closed = new Promise<void>(resolve => { transport.close = resolve })
    constructor(factory: () => Agent) { transport.agent = factory() }
    sessionUpdate = vi.fn()
    extNotification = vi.fn()
  }
}))
vi.mock('./model-bridge-helper', () => ({
  MODEL_BRIDGE_SDK_AUTH_SENTINEL: 'bridge-test-sentinel',
  openCodeModelBridgeModelId: () => 'bridge-model',
  ModelBridgeLoopbackProxy: class {
    listen = async () => 'http://127.0.0.1:12345'
    close = async () => {}
  }
}))
vi.mock('./model-bridge-broker', () => ({
  createUnixModelBridgeExchange: vi.fn()
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  transport.agent = undefined
})

const server = (name: string) => ({
  name, type: 'http' as const, url: `http://127.0.0.1:12346/${name}`,
  headers: [{ name: 'Authorization', value: 'Bearer session-test-token' }]
})

// Keep the actual helper and adapter config builder together: mocking the
// adapter constructor would miss the model-profile configuration-loss bug.
it('delivers current ACP session MCP capabilities through the bridged model config, but not Ask', async () => {
  const configs: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    operationId: 'operation', workMode: transport.mode
  })))
  vi.spyOn(ContinueHostAdapter.prototype, 'run').mockImplementation(async function (
    this: ContinueHostAdapter, _prompt, _signal, _authorize, options
  ) {
    const path = await (this as unknown as {
      createRunConfig(options: ContinueHostRunOptions): Promise<string>
    }).createRunConfig(options!)
    configs.push(JSON.parse(await readFile(path, 'utf8')))
    await rm(path)
    return { text: 'OK' }
  })
  const running = runContinueAcpHelper({
    socketPath: 'unused', protocol: 'openai-chat-completions', model: 'test-model',
    supportsImageInput: false, workMode: 'execute', sharedSessions: true, entrypoint: 'unused'
  })
  try {
    await vi.waitFor(() => expect(transport.agent).toBeDefined())
    const agent = transport.agent!
    const { sessionId } = await agent.newSession({ cwd: tmpdir(), mcpServers: [server('first')] })
    const prompt = () => agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'OK' }] })
    await prompt()
    await agent.resumeSession!({ sessionId, cwd: tmpdir(), mcpServers: [server('replacement')] })
    await prompt()
    transport.mode = 'ask'
    await prompt()
    transport.mode = 'execute'
    await agent.loadSession!({ sessionId, cwd: tmpdir(), mcpServers: [] })
    await prompt()
    expect(configs.map(config => config.mcpServers ?? [])).toEqual([
      [{ name: 'first', type: 'streamable-http', url: server('first').url,
        requestOptions: { headers: { Authorization: 'Bearer session-test-token' } } }],
      [{ name: 'replacement', type: 'streamable-http', url: server('replacement').url,
        requestOptions: { headers: { Authorization: 'Bearer session-test-token' } } }],
      [], []
    ])
    expect(configs[0].models).toEqual([expect.objectContaining({ model: 'test-model' })])
  } finally {
    transport.close()
    await running
  }
})

it('keeps local profile MCP scoping and filters explicit session servers in Ask at the adapter boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-cn-scope-'))
  try {
    const configPath = join(root, 'native.json')
    await writeFile(configPath, JSON.stringify({ mcpServers: [{ name: 'local-native', command: 'unused' }] }))
    const adapter = new ContinueHostAdapter({
      binaryPath: 'unused', cacheRoot: root, workspace: root, configPath,
      modelProfile: { id: 'test', name: 'test', modelName: 'test',
        protocol: 'openai-chat-completions', authentication: 'none', baseUrl: 'http://127.0.0.1:12345' }
    })
    const create = (options: ContinueHostRunOptions) => (adapter as unknown as {
      createRunConfig(options: ContinueHostRunOptions): Promise<string>
    }).createRunConfig(options)
    for (const workMode of ['ask', 'execute'] as const) {
      const path = await create({ workMode })
      expect(JSON.parse(await readFile(path, 'utf8')).mcpServers ?? []).toEqual([])
    }
    const path = await create({ workMode: 'ask', sessionMcpServers: [{
      name: 'remote', type: 'streamable-http', url: 'http://127.0.0.1:12346', requestOptions: { headers: {} }
    }] })
    expect(JSON.parse(await readFile(path, 'utf8')).mcpServers ?? []).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
