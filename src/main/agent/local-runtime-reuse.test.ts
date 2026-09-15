// @vitest-environment node
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { defaultRuntimeSettings } from '../../shared/contracts'
import type { ResolvedRuntimeSettings } from '../runtime-settings-store'
import { ExecutionSpaceResolver } from '../execution-space/execution-space-resolver'
import { createAgentRuntime } from './create-runtime'
import { LocalRuntimeRegistry } from './local-runtime-registry'
import { OpenCodeRuntime } from './opencode-runtime'
import { SelectedRuntimeManager } from './selected-runtime-manager'
import { KnowledgeMcpGateway } from './knowledge-mcp-gateway'
import { KnowledgeService } from '../knowledge/knowledge-service'

const binaryPath = join(
  process.cwd(), '.runtime-resources', process.arch,
  process.platform === 'win32' ? 'opencode.exe' : 'opencode'
)

it.skipIf(!existsSync(binaryPath)).each([2, 10])('uses one real OpenCode server across %i projects for tools, continuation and compaction', async (projectCount) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'goodbuddy-opencode-reuse-')))
  const directories = Array.from(
    { length: projectCount }, (_, index) => join(root, `project-${index}`)
  )
  await Promise.all(directories.map(async (directory, index) => {
    await mkdir(directory)
    await writeFile(join(directory, 'marker.txt'), `PROJECT_${index}`)
  }))
  let modelCalls = 0
  const toolResults: unknown[] = []
  const capabilityResults: string[] = []
  const observedImages = new Set<string>()
  const requestImages = new Map<string, string>()
  const observedRequestImages = new Map<string, Set<string>>()
  const images = directories.slice(0, 2).map((_, index) =>
    createCanvas(index + 1, 1).toBuffer('image/png').toString('base64'))
  const knowledge = projectCount === 2 ? new KnowledgeService({
    databasePath: join(root, 'knowledge.sqlite'), managedRoot: join(root, 'knowledge')
  }) : undefined
  const gateway = knowledge ? new KnowledgeMcpGateway(knowledge) : undefined
  await knowledge?.initialize()
  await gateway?.start()
  const grants = gateway ? vi.spyOn(gateway, 'grantCustomMcp') : undefined
  const mcpCalls = gateway ? vi.spyOn(gateway as unknown as {
    callCustomMcpTool(token: string, binding: unknown, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  }, 'callCustomMcpTool') : undefined
  const model = createServer((request, response) => {
    void (async () => {
      let content = ''
      for await (const chunk of request) content += String(chunk)
      const body = JSON.parse(content) as {
        messages: Array<{ role: string; content: unknown }>
        tools?: Array<{ function: { name: string } }>
      }
      modelCalls++
      let userIndex = -1
      body.messages.forEach((message, index) => { if (message.role === 'user') userIndex = index })
      const results = body.messages.slice(userIndex + 1).filter((message) => message.role === 'tool')
      const result = results.at(-1)
      if (result) toolResults.push(result.content)
      const resultText = JSON.stringify(results.map(message => message.content))
      const marker = resultText.match(/PROJECT_\d+/u)?.[0]
      const read = body.tools?.some((tool) => tool.function.name === 'read')
      let tool: { name: string; arguments: Record<string, unknown> } | undefined =
        read && !result ? { name: 'read', arguments: { filePath: 'marker.txt' } } : undefined
      if (projectCount === 2 && read) {
        const requestId = JSON.stringify(body.messages[userIndex]?.content).match(/REQUEST_([a-f0-9-]{36})/u)?.[1]
        for (const image of images) {
          if (JSON.stringify(body.messages).includes(image)) {
            observedImages.add(image)
            if (requestId) {
              const seen = observedRequestImages.get(requestId) ?? new Set<string>()
              seen.add(image)
              observedRequestImages.set(requestId, seen)
            }
          }
        }
        if (results.length === 1) {
          tool = { name: 'skill', arguments: { name: 'web-3d-game' } }
        } else if (results.length === 2) {
          const name = body.tools?.find(item => item.function.name.endsWith('_create_game_blueprint'))?.function.name
          if (!name) throw new Error('Shared OpenCode MCP fixture is not exposed')
          tool = {
            name, arguments: {
              theme: 'neon-ruins',
              seed: JSON.stringify(body.messages[userIndex]?.content).match(/REQUEST_([a-f0-9-]{36})/u)?.[1],
              targetCount: 5
            }
          }
        } else if (results.length === 3) {
          capabilityResults.push(resultText)
        }
      }
      const callTool = tool !== undefined
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const delta = callTool
        ? {
            role: 'assistant',
            tool_calls: [{
              index: 0, id: `read-${modelCalls}`, type: 'function',
              function: { name: tool!.name, arguments: JSON.stringify(tool!.arguments) }
            }]
          }
        : { role: 'assistant', content: marker ?? 'CONTEXT_SUMMARY' }
      for (const [value, finish] of [[delta, null], [{}, callTool ? 'tool_calls' : 'stop']]) {
        response.write(`data: ${JSON.stringify({
          id: `reuse-${modelCalls}`, object: 'chat.completion.chunk', created: 1,
          model: 'reuse', choices: [{ index: 0, delta: value, finish_reason: finish }]
        })}\n\n`)
      }
      response.end('data: [DONE]\n\n')
    })().catch(() => response.destroy())
  })
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
  const port = (model.address() as { port: number }).port
  const profile = {
    id: '00000000-0000-4000-8000-000000000008',
    name: 'Reuse fixture', modelName: 'reuse', baseUrl: `http://127.0.0.1:${port}/v1`,
    protocol: 'openai-chat-completions' as const, authentication: 'none' as const,
    supportsImageInput: projectCount === 2
  }
  const settings = {
    ...defaultRuntimeSettings, provider: 'opencode', opencodeBinaryPath: binaryPath,
    modelProfiles: [profile], opencodeModelProfile: profile
  } as ResolvedRuntimeSettings
  const registry = new LocalRuntimeRegistry()
  const resolver = new ExecutionSpaceResolver()
  const create = vi.fn(async (_selection, executionSpace) => createAgentRuntime(root, settings, {
    executionSpace, localRuntimeRegistry: registry, knowledgeGateway: gateway,
    ...(projectCount === 2 ? {
      skillPackages: [{ id: 'web-3d-game', directory: resolve('tests/fixtures/web-3d-game-skill') }],
      mcpServers: [{
        id: 'fbf42200-4e60-48d0-b5f2-e816db38ac54', name: 'Shared blueprint', description: '',
        enabled: true, allowDynamicTools: false, assignments: ['opencode' as const],
        secretConfigured: false, transport: 'stdio' as const,
        command: process.versions.electron ? 'node' : process.execPath,
        args: [resolve('tests/fixtures/web-3d-game-mcp.mjs')]
      }]
    } : {})
  }))
  const manager = new SelectedRuntimeManager(create, 1, 1, undefined, undefined, (id) => registry.releaseConversation(id))
  const connections = vi.spyOn(OpenCodeRuntime.prototype, 'testConnection')
  const launches = vi.spyOn(
    OpenCodeRuntime.prototype as unknown as { launchEmbedded(): Promise<unknown> },
    'launchEmbedded'
  )
  const nativeSessions = new Set<string>()
  try {
    const selection = { provider: 'opencode' as const }
    const facades = await Promise.all(directories.map((directory) =>
      manager.getRuntime(selection, resolver.resolveLocal(directory))
    ))
    for (let wave = 0; wave < 2; wave++) {
      await Promise.all(facades.flatMap((runtime, project) => [0, 1].map(async (conversation) => {
        let output = ''
        const requestId = crypto.randomUUID()
        if (projectCount === 2 && wave === 0) requestImages.set(requestId, images[project]!)
        for await (const event of runtime.run({
          requestId, conversationId: `project-${project}-${conversation}`,
          prompt: `Read marker.txt for wave ${wave}. REQUEST_${requestId}`, workMode: 'execute',
          ...(projectCount === 2 && wave === 0 ? { images: [{
            name: `project-${project}.png`, mediaType: 'image/png', data: images[project]!
          }] } : {})
        }, AbortSignal.timeout(40_000))) {
          if (event.type === 'text') output += event.delta
          if (event.type === 'done' && event.sessionId) nativeSessions.add(event.sessionId)
        }
        expect(output, JSON.stringify(toolResults)).toBe(`PROJECT_${project}`)
      })))
    }
    expect(nativeSessions.size).toBe(projectCount * 2)
    if (projectCount === 2) {
      expect(observedImages.size).toBe(2)
      for (const [requestId, image] of requestImages) {
        expect(observedRequestImages.get(requestId)).toEqual(new Set([image]))
      }
      expect(capabilityResults).toHaveLength(8)
      for (const result of capabilityResults) {
        expect(result).toContain('window.__GOODBUDDY_GAME__')
        expect(result).toContain('Prism Relay')
      }
      expect(mcpCalls).toHaveBeenCalledTimes(8)
      for (const [token, , args] of mcpCalls!.mock.calls) {
        const grantIndex = grants!.mock.results.findIndex(result => result.value === token)
        expect(grantIndex).toBeGreaterThanOrEqual(0)
        expect(args.seed).toBe(grants!.mock.calls[grantIndex]![0])
      }
    }
    for (let index = 0; index < facades.length; index++) {
      await expect(facades[index]!.compactConversation({
        requestId: crypto.randomUUID(), conversationId: `project-${index}-0`,
        runtimeSelection: selection, history: [], historyMessageIds: []
      }, AbortSignal.timeout(30_000))).resolves.toMatchObject({ result: { compacted: true } })
    }
    await Promise.all(facades.map((runtime) => runtime.testConnection()))
    // Every facade invokes the same process-owning Runtime, even beyond capacity 1.
    expect(new Set(connections.mock.instances).size).toBe(1)
    expect(launches).toHaveBeenCalledOnce()
    for (const [index, directory] of directories.entries()) {
      expect(await readFile(join(directory, 'marker.txt'), 'utf8')).toBe(`PROJECT_${index}`)
    }
    await manager.releaseConversation('project-0-0')
  } finally {
    connections.mockRestore()
    launches.mockRestore()
    mcpCalls?.mockRestore()
    grants?.mockRestore()
    await manager.dispose()
    await registry.dispose()
    await gateway?.dispose()
    await knowledge?.dispose()
    model.closeAllConnections()
    await new Promise<void>((resolve) => model.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
