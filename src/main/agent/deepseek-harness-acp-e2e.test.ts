import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import {
  ToolCallId,
  type GenerateOptions,
  type StreamChunk
} from '@deepseek-ai/dsh-llm'
import type { RuntimeEvent } from './runtime'
import {
  ModelToolProvider,
  type ModelToolCallContext
} from './model-tool-provider'
import type { ResolvedMcpServer } from '../capabilities/capability-service'
import {
  createBoundedNdJsonStream,
  startControlledDeepSeekHarnessHost,
  type ControlledHarnessHost
} from '../deepseek-harness-host'
import {
  DeepSeekHarnessRuntime,
  type DeepSeekHarnessChild,
  type DeepSeekHarnessLaunchOptions
} from './deepseek-harness-runtime'
import { DshNpmExtensionInstaller } from './dsh-extension-marketplace'
import { DEEPSEEK_HARNESS_MAX_FRAME_BYTES } from './deepseek-harness-control-protocol'
import { createOpenAIChatCompletionsUrl } from './openai-endpoint'
import { createModelRequestProbe } from '../../../tests/support/model-request-probe'
import { ExecutionSpaceResolver } from '../execution-space/execution-space-resolver'
import { SelectedRuntimeManager } from './selected-runtime-manager'
import { LocalRuntimeRegistry } from './local-runtime-registry'
import { createAgentRuntime } from './create-runtime'
import { defaultRuntimeSettings } from '../../shared/contracts'
import type { ResolvedRuntimeSettings } from '../runtime-settings-store'
import { AssistantDatabase } from '../assistant/assistant-database'
import { ImageGenerationService } from './image-generation-service'
import { KnowledgeMcpGateway } from './knowledge-mcp-gateway'
import type { KnowledgeService } from '../knowledge/knowledge-service'

vi.mock('electron', () => ({ nativeImage: {} }))

it('generates and edits durable images and removes tools when the request has no image binding', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'goodbuddy-dsh-images-')))
  const database = new AssistantDatabase(join(root, 'assistant.sqlite'))
  database.initialize(root)
  const conversationId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: 'iVBORw0KGgo=' }] }))
  const service = new ImageGenerationService({ database, fetcher, getSettings: async () => ({ defaultImageModelProfileId: profileId, modelProfiles: [{
    id: profileId, name: 'Image fixture', modelName: 'fixture', protocol: 'openai-images-generations',
    allowConversationInvocation: true, baseUrl: 'https://image.test/v1', authentication: 'none'
  }] }) })
  let input: Record<string, unknown> = { intent: 'create', prompt: 'Blue circle' }
  const inProcess = createInProcessLaunch(root, {
    stream(options) {
      const prompt = latestUserText(options)
      const tool = options.tools?.find(tool => tool.name === 'generate_image')
      if (prompt === 'no-image-binding') {
        expect(tool).toBeUndefined()
        return textResponse('No image binding')
      }
      expect(tool).toBeDefined()
      expect(tool?.description).toContain(profileId)
      if (!toolResultText(options, prompt)) return toolCall(prompt, 'generate_image', input)
      expect(toolResultText(options, prompt)).toContain('completed')
      return textResponse('IMAGE_SAVED')
    }
  })
  const runtime = new DeepSeekHarnessRuntime({ defaultWorkspace: root, baseUrl: 'https://chat.test/v1', model: 'fixture',
    launch: inProcess.launch, credentialRefs: { [CREDENTIAL_REF]: 'fixture' }, toolProvider: new ModelToolProvider(root, [], undefined, undefined, false, { runtimeTarget: 'deepseek-harness' }),
    initializationTimeoutMs: 20_000, promptTimeoutMs: 20_000, shutdownTimeoutMs: 5_000 })
  try {
    for (const intent of ['create', 'edit'] as const) {
      const messageId = crypto.randomUUID()
      const requestId = crypto.randomUUID()
      database.saveLocalConversations([{ header: { id: conversationId, title: 'Images', updatedAt: Date.now() },
        messages: [{ id: messageId, role: 'assistant', content: '', createdAt: Date.now(), state: 'complete' }] }])
      const events = await collect(runtime.run({ requestId, conversationId, prompt: `${intent}-${requestId}`,
        imageToolBinding: service.bind({ conversationId, messageId, requestId,  }) }, new AbortController().signal, async () => 'once'))
      expect(events.at(-1)?.type).toBe('done')
      const operation = database.getConversation(conversationId).messages.find(message => message.id === messageId)!.imageOperations![0]!
      expect(operation.state).toBe('completed')
      input = { intent: 'edit', prompt: 'Turn red', sourceArtifactIds: operation.artifactIds }
    }
    await collect(runtime.run({ requestId: crypto.randomUUID(), conversationId, prompt: 'no-image-binding',  }, new AbortController().signal))
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(String(fetcher.mock.calls[1]![0])).toMatch(/images\/edits$/u)
  } finally {
    await runtime.dispose()
    await service.dispose()
    database.close()
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

const CREDENTIAL_REF = 'GOODBUDDY_HARNESS_MODEL_API_KEY'

it('reads Story Graph through the controlled Harness ACP Main proxy, then removes it when disabled', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'goodbuddy-dsh-graph-')))
  const db = new AssistantDatabase(':memory:'); db.initialize(root)
  let enabled = true
  const projectId = db.listProjects()[0]!.id
  const conversationId = crypto.randomUUID()
  db.saveLocalConversations([{ header: { id: conversationId, projectId, title: 'Graph', updatedAt: Date.now() }, messages: [] }])
  const gateway = new KnowledgeMcpGateway({} as KnowledgeService, { storyGraphService: {
    available: async binding => db.isConversationStoryGraphEnabled(binding.conversationId!), read: db.readStoryGraph.bind(db)
  } })
  const signal = new AbortController().signal
  const token = gateway.grant('harness-graph', [], signal, 'none', undefined, undefined, undefined, undefined, undefined,
    { projectId, conversationId, runtimeTarget: 'deepseek-harness' })!
  const inProcess = createInProcessLaunch(root, { stream(options) {
    const prompt = latestUserText(options)
    const tool = options.tools?.find(tool => tool.name === 'story_graph_search')
    if (!enabled) { expect(tool).toBeUndefined(); return textResponse('DISABLED') }
    expect(tool).toBeDefined()
    if (!toolResultText(options, prompt)) return toolCall(prompt, 'story_graph_search', { query: 'Decision' })
    expect(toolResultText(options, prompt)).toContain(projectId)
    return textResponse('GRAPH_READ')
  } })
  const provider = new ModelToolProvider(root, [], undefined, gateway, false, { runtimeTarget: 'deepseek-harness' })
  const runtime = new DeepSeekHarnessRuntime({ defaultWorkspace: root, baseUrl: 'https://chat.test/v1', model: 'fixture',
    launch: inProcess.launch, credentialRefs: { [CREDENTIAL_REF]: 'fixture' }, toolProvider: provider,
    initializationTimeoutMs: 20_000, promptTimeoutMs: 20_000, shutdownTimeoutMs: 5_000 })
  try {
    for (const mode of ['first', 'second', 'disabled'] as const) {
      enabled = mode !== 'disabled'
      db.setConversationStoryGraphEnabled(conversationId, enabled)
      const events = await collect(runtime.run({ requestId: crypto.randomUUID(), conversationId, prompt: mode,
         knowledgeCapabilityToken: token }, signal))
      expect(events.at(-1)?.type).toBe('done')
      expect(JSON.stringify(events)).toContain(enabled ? 'GRAPH_READ' : 'DISABLED')
    }
  } finally { await runtime.dispose(); await provider.dispose(); await gateway.dispose(); db.close(); await rm(root, { recursive: true, force: true }) }
}, 60_000)
const SKILL_CALL_ID = 'e2e-skill-call'
const MCP_CALL_ID = 'e2e-mcp-call'
const FOLLOWUP_MCP_CALL_ID = 'e2e-followup-mcp-call'
const MICRO_DELTA_COUNT = 30_000
const liveModelEnabled =
  process.env.GOODBUDDY_DSH_MODEL_E2E === '1'
const liveApiKey = process.env.GOODBUDDY_DSH_API_KEY ?? ''
const liveBaseUrl =
  process.env.GOODBUDDY_DSH_BASE_URL ?? 'https://api.deepseek.com'
const liveModel =
  process.env.GOODBUDDY_DSH_MODEL ?? 'deepseek-chat'

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function toolResultText(
  options: GenerateOptions,
  callId: string
): string | undefined {
  for (const message of options.messages) {
    if (message.role === 'tool' && message.toolCallId === callId) {
      return message.content
        .filter(
          (
            content
          ): content is Extract<
            (typeof message.content)[number],
            { type: 'text' }
          > => content.type === 'text'
        )
        .map((content) => content.text)
        .join('\n')
    }
  }
  return undefined
}

function latestUserText(options: GenerateOptions): string {
  return options.messages
    .filter(
      (message) =>
        message.role === 'user' &&
        message.source?.kind === 'user'
    )
    .flatMap((message) =>
      message.content
        .filter(
          (
            content
          ): content is Extract<
            (typeof message.content)[number],
            { type: 'text' }
          > => content.type === 'text'
        )
        .map((content) => content.text)
    )
    .at(-1) ?? ''
}

async function* toolCall(
  callId: string,
  name: string,
  argumentsValue: Record<string, unknown>
): AsyncGenerator<StreamChunk> {
  const id = ToolCallId(callId)
  const argumentsText = JSON.stringify(argumentsValue)
  yield {
    type: 'block-start',
    index: 0,
    blockType: 'tool-call'
  }
  yield {
    type: 'tool-call-delta',
    index: 0,
    id,
    name,
    argumentsDelta: argumentsText
  }
  yield {
    type: 'block-end',
    index: 0,
    block: {
      type: 'tool-call',
      id,
      name,
      arguments: argumentsText
    }
  }
  yield {
    type: 'usage',
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    }
  }
  yield {
    type: 'finish',
    reason: { kind: 'tool-calls' }
  }
}

async function* textResponse(
  text: string
): AsyncGenerator<StreamChunk> {
  yield {
    type: 'block-start',
    index: 0,
    blockType: 'text'
  }
  yield {
    type: 'text-delta',
    index: 0,
    text
  }
  yield {
    type: 'block-end',
    index: 0,
    block: { type: 'text', text }
  }
  yield {
    type: 'usage',
    usage: {
      inputTokens: 20,
      outputTokens: 8,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    }
  }
  yield {
    type: 'finish',
    reason: { kind: 'stop' }
  }
}

async function* microDeltaResponse(): AsyncGenerator<StreamChunk> {
  yield {
    type: 'block-start',
    index: 0,
    blockType: 'reasoning'
  }
  for (let index = 0; index < MICRO_DELTA_COUNT; index += 1) {
    yield {
      type: 'reasoning-delta',
      index: 0,
      text: String(index % 10)
    }
  }
  yield {
    type: 'block-end',
    index: 0,
    block: {
      type: 'reasoning',
      text: Array.from(
        { length: MICRO_DELTA_COUNT },
        (_value, index) => String(index % 10)
      ).join('')
    }
  }
  yield {
    type: 'usage',
    usage: {
      inputTokens: 20,
      outputTokens: 8_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    }
  }
  yield {
    type: 'finish',
    reason: { kind: 'stop' }
  }
}

class FakeGameModel {
  mcpToolName?: string
  skillResult?: string
  blueprint?: Record<string, unknown>
  followupToolResult?: string
  initialToolNames: string[] = []
  followupToolNames: string[] = []

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const prompt = latestUserText(options)
    const toolNames = options.tools?.map((tool) => tool.name) ?? []

    if (prompt.includes('FOLLOWUP_MCP_PROBE')) {
      this.followupToolNames = toolNames
      const result = toolResultText(options, FOLLOWUP_MCP_CALL_ID)
      if (!result) {
        if (!this.mcpToolName) {
          throw new Error('Fake model has no prior MCP tool identity')
        }
        return toolCall(FOLLOWUP_MCP_CALL_ID, this.mcpToolName, {
          theme: 'neon-ruins',
          seed: 'followup-request',
          targetCount: 5
        })
      }
      this.followupToolResult = result
      return textResponse('MCP proxy remains available.')
    }

    this.initialToolNames = toolNames
    const skillResult = toolResultText(options, SKILL_CALL_ID)
    if (!skillResult) {
      return toolCall(SKILL_CALL_ID, 'skill', {
        name: 'web-3d-game'
      })
    }
    this.skillResult = skillResult

    const blueprintResult = toolResultText(options, MCP_CALL_ID)
    if (!blueprintResult) {
      const mcpTool = options.tools?.find((tool) =>
        tool.name.endsWith('_create_game_blueprint')
      )
      if (!mcpTool) {
        throw new Error(
          'Main-mediated 3D blueprint MCP tool was not exposed'
        )
      }
      this.mcpToolName = mcpTool.name
      return toolCall(MCP_CALL_ID, mcpTool.name, {
        theme: 'neon-ruins',
        seed: 'goodbuddy-0.9.0',
        targetCount: 5
      })
    }
    this.blueprint = JSON.parse(
      blueprintResult
    ) as Record<string, unknown>
    return textResponse(
      'Loaded the Web 3D Game Skill and the approved Prism Relay blueprint.'
    )
  }
}

type HarnessModel = {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

async function collect(
  stream: AsyncGenerator<RuntimeEvent, void, void>
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}

function createInProcessLaunch(
  dshHome: string,
  model?: HarnessModel,
  observeStream?: (options: GenerateOptions) => void
): {
  launch(
    options: DeepSeekHarnessLaunchOptions
  ): Promise<DeepSeekHarnessChild>
  hosts: ControlledHarnessHost[]
} {
  const hosts: ControlledHarnessHost[] = []
  return {
    hosts,
    async launch(options) {
      const clientToHost =
        new TransformStream<Uint8Array, Uint8Array>()
      const hostToClient =
        new TransformStream<Uint8Array, Uint8Array>()
      const exited = deferred<{
        exitCode: number | null
        signal?: string | null
      }>()
      const host = await startControlledDeepSeekHarnessHost({
        workspace: options.cwd,
        dshHome,
        baseUrl: options.baseUrl,
        api: 'openai-completions',
        provider: 'goodbuddy',
        model: options.model,
        supportsImageInput: options.supportsImageInput,
        requestHeaders: options.requestHeaders,
        harnessVersion: '0.1.7-rc.2',
        credentialRefs: options.credentialRefs,
        skillPackages: options.skillPackages,
        extensionPackages: options.extensionPackages,
        stream: createBoundedNdJsonStream(
          hostToClient.writable,
          clientToHost.readable,
          DEEPSEEK_HARNESS_MAX_FRAME_BYTES
        )
      })
      hosts.push(host)
      if (observeStream) {
        host.context.on(
          'llm/stream',
          (request, next) => {
            observeStream(request)
            return next()
          },
          { global: true, prepend: true }
        )
      }
      if (model) {
        host.context.on(
          'llm/stream',
          (request) => model.stream(request),
          { global: true, prepend: true }
        )
      }
      let terminated = false
      return {
        stdin: clientToHost.writable,
        stdout: hostToClient.readable,
        exited: exited.promise,
        async terminate() {
          if (terminated) {
            return
          }
          terminated = true
          await host.dispose().catch(() => undefined)
          await Promise.allSettled([
            clientToHost.writable.close(),
            hostToClient.writable.close()
          ])
          exited.resolve({ exitCode: 0 })
        }
      }
    }
  }
}

describe('DeepSeek Harness real ACP control-plane E2E', () => {
  it.each([2, 10])('shares one production-composed Host across %i projects with independent native file and shell tools', async (projectCount) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'goodbuddy-dsh-reuse-')))
    const directories = Array.from(
      { length: projectCount }, (_, index) => join(root, `project-${index}`)
    )
    await Promise.all(directories.map(async (directory, index) => {
      await mkdir(directory)
      await writeFile(join(directory, 'marker.txt'), `PROJECT_${index}`)
    }))
    const inProcess = createInProcessLaunch(root, {
      stream(options) {
        const id = latestUserText(options)
        const read = toolResultText(options, `${id}-read`)
        if (read === undefined) return toolCall(`${id}-read`, 'read', { file_path: 'marker.txt' })
        const write = toolResultText(options, `${id}-write`)
        if (write === undefined) return toolCall(`${id}-write`, 'write', {
          file_path: `${id}.txt`, content: read
        })
        const shell = toolResultText(options, `${id}-shell`)
        if (shell === undefined) return toolCall(`${id}-shell`, process.platform === 'win32' ? 'pwsh' : 'bash', {
          command: process.platform === 'win32' ? 'Get-Content marker.txt' : 'cat marker.txt',
          description: 'Read the session workspace fixture'
        })
        return textResponse(shell)
      }
    })
    const launch = vi.fn(inProcess.launch)
    const registry = new LocalRuntimeRegistry()
    const resolver = new ExecutionSpaceResolver()
    const profile = {
      id: '00000000-0000-4000-8000-000000000009',
      name: 'Reuse fixture', baseUrl: 'http://127.0.0.1:9',
      modelName: 'reuse', protocol: 'openai-chat-completions' as const,
      authentication: 'api-key' as const, apiKey: 'unused-deterministic-model'
    }
    const settings = {
      ...defaultRuntimeSettings, provider: 'deepseek-harness',
      modelProfiles: [profile], deepseekHarnessModelProfile: profile
    } as ResolvedRuntimeSettings
    const manager = new SelectedRuntimeManager(async (_selection, space) =>
      createAgentRuntime(root, settings, {
        executionSpace: space, localRuntimeRegistry: registry,
        deepseekHarnessLauncher: launch
      }), 1, 1, undefined, undefined, (id) => registry.releaseConversation(id))
    try {
      const selection = { provider: 'deepseek-harness' as const }
      for (let wave = 0; wave < 2; wave++) {
        const outputs = await Promise.all(directories.flatMap((directory, project) =>
          [0, 1].map(async (conversation) => {
            const runtime = await manager.getRuntime(selection, resolver.resolveLocal(directory))
            const id = `p${project}-c${conversation}-w${wave}`
            const events = await collect(runtime.run({
              requestId: id, conversationId: `p${project}-c${conversation}`,
              prompt: id,
            }, AbortSignal.timeout(20_000)))
            expect(events.at(-1)?.type).toBe('done')
            expect(await readFile(join(directory, `${id}.txt`), 'utf8')).toContain(`PROJECT_${project}`)
            expect(events.filter((event) => event.type === 'text').map((event) => event.delta).join(''))
              .toContain(`PROJECT_${project}`)
            return events
          })
        ))
        expect(outputs).toHaveLength(projectCount * 2)
        expect(launch).toHaveBeenCalledOnce()
      }
      await manager.releaseConversation('p0-c0')
      expect(launch).toHaveBeenCalledOnce()
      expect(inProcess.hosts).toHaveLength(1)
    } finally {
      await manager.dispose()
      await registry.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it.skipIf(process.platform !== 'win32')('reuses a working runtime for mixed-separator and canonical Windows paths', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'goodbuddy-dsh-path-')))
    const workspace = join(root, 'workspace')
    const dshHome = join(root, 'home')
    await Promise.all([mkdir(workspace), mkdir(dshHome)])
    const canonical = await realpath(workspace)
    const mixed = `${root.replaceAll('\\', '/')}\\workspace`
    const resolver = new ExecutionSpaceResolver()
    const inProcess = createInProcessLaunch(dshHome, {
      stream: () => textResponse('PATH_OK')
    })
    const launch = vi.fn(inProcess.launch)
    const manager = new SelectedRuntimeManager(async (_selection, space) => {
      if (space?.kind !== 'local') throw new Error('local workspace required')
      return new DeepSeekHarnessRuntime({
        defaultWorkspace: space.rootPath, baseUrl: 'https://api.deepseek.com',
        model: 'path-test', launch,
        credentialRefs: { [CREDENTIAL_REF]: 'unused-in-memory-model-credential' },
        initializationTimeoutMs: 20_000, promptTimeoutMs: 20_000, shutdownTimeoutMs: 5_000
      })
    })
    try {
      expect(mixed).not.toBe(canonical)
      expect(await realpath(mixed)).toBe(canonical)
      const first = await manager.getRuntime({ provider: 'deepseek-harness' }, resolver.resolveLocal(mixed))
      for (const [index, spelling] of [mixed, canonical].entries()) {
        const runtime = await manager.getRuntime({ provider: 'deepseek-harness' }, resolver.resolveLocal(spelling))
        expect(runtime).toBe(first)
        const events = await collect(runtime.run({
          requestId: `path-${index}`, conversationId: `path-${index}`,
           prompt: 'Return PATH_OK.'
        }, AbortSignal.timeout(20_000)))
        expect(events.at(-1)).toMatchObject({ type: 'done' })
        expect(events.filter(event => event.type === 'text').map(event => event.delta).join('')).toBe('PATH_OK')
      }
      expect(launch).toHaveBeenCalledOnce()
      expect(launch.mock.calls[0]?.[0].cwd).toBe(canonical)
    } finally {
      await manager.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps native Skills, plugin inventory, MCP calls and images scoped across shared projects', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'goodbuddy-dsh-shared-capabilities-')))
    const directories = [join(root, 'one'), join(root, 'two')]
    await Promise.all(directories.map(directory => mkdir(directory)))
    const plugin = join(root, 'inventory-plugin.mjs')
    await writeFile(plugin, [
      "export const name = 'shared-inventory'",
      "export const inject = ['skills']",
      'export function apply(ctx) {',
      "ctx.skills.register({ name: 'shared-plugin-skill', description: 'Shared plugin fixture', content: '# Shared plugin', source: 'custom' })",
      '}'
    ].join('\n'))
    const models = [new FakeGameModel(), new FakeGameModel()]
    const images = [createCanvas(1, 1).toBuffer('image/png'), createCanvas(2, 1).toBuffer('image/png')]
    const seenImages = new Map<number, GenerateOptions['messages'][number]['content']>()
    const inProcess = createInProcessLaunch(root, {
      stream(options) {
        const project = latestUserText(options).includes('PROJECT_1') ? 1 : 0
        seenImages.set(project, options.messages.flatMap(message => message.content).filter(block => block.type === 'image'))
        return models[project]!.stream(options)
      }
    })
    const launch = vi.fn(inProcess.launch)
    const calls = vi.spyOn(ModelToolProvider.prototype, 'callTool')
    const registry = new LocalRuntimeRegistry()
    const profile = {
      id: '00000000-0000-4000-8000-000000000010',
      name: 'Capabilities fixture', baseUrl: 'http://127.0.0.1:9',
      modelName: 'capabilities', protocol: 'openai-chat-completions' as const,
      authentication: 'api-key' as const, apiKey: 'unused-deterministic-model',
      supportsImageInput: true
    }
    const resolver = new ExecutionSpaceResolver()
    const runtimes = directories.map(directory => createAgentRuntime(root, {
      ...defaultRuntimeSettings, provider: 'deepseek-harness',
      modelProfiles: [profile], deepseekHarnessModelProfile: profile
    } as ResolvedRuntimeSettings, {
      executionSpace: resolver.resolveLocal(directory), localRuntimeRegistry: registry,
      deepseekHarnessLauncher: launch,
      skillPackages: [{ id: 'web-3d-game', directory: resolve('tests/fixtures/web-3d-game-skill') }],
      deepseekHarnessExtensions: [{ id: 'shared-inventory', entrypoint: plugin, configuration: {} }],
      mcpServers: [{
        id: 'fbf42200-4e60-48d0-b5f2-e816db38ac54', name: 'Shared blueprint', description: '',
        enabled: true, allowDynamicTools: false, assignments: ['deepseek-harness'],
        secretConfigured: false, transport: 'stdio',
        command: process.versions.electron ? 'node' : process.execPath,
        args: [resolve('tests/fixtures/web-3d-game-mcp.mjs')]
      }]
    }))
    try {
      for (const mode of ['first', 'second'] as const) {
        await Promise.all(runtimes.map(async (runtime, project) => {
          const events = await collect(runtime.run({
            requestId: `capabilities-${project}-${mode}`, conversationId: `capabilities-${project}`,
            prompt: `${mode === 'second' ? 'FOLLOWUP_MCP_PROBE' : 'Use Skill and MCP'} PROJECT_${project}`,
            ...(mode === 'first' ? { images: [{
              name: `project-${project}.png`, mediaType: 'image/png', data: images[project]!.toString('base64')
            }] } : {})
          }, AbortSignal.timeout(30_000), async () => 'once'))
          expect(events.at(-1)?.type).toBe('done')
          const model = models[project]!
          if (mode === 'first') {
            expect(model.skillResult).toContain('window.__GOODBUDDY_GAME__')
            expect(model.blueprint).toMatchObject({ title: 'Prism Relay' })
            const seen = seenImages.get(project)!
            expect(seen).toHaveLength(1)
            const image = seen[0]!
            if (image.type !== 'image') throw new Error('Expected image block')
            expect(image.attachment).toMatchObject({ width: project + 1, height: 1 })
            const stored = await inProcess.hosts[0]!.context.attachments.readImage(image.attachment)
            expect(Buffer.from(stored.data).equals(images[project]!)).toBe(true)
          } else {
            expect(model.followupToolNames).toContain(model.mcpToolName)
            expect(model.followupToolResult).toContain('Prism Relay')
          }
          expect(await runtime.getNativeSnapshot?.()).toMatchObject({
            skills: expect.arrayContaining([expect.objectContaining({ id: 'shared-plugin-skill', source: 'plugin' })])
          })
        }))
        expect(launch).toHaveBeenCalledOnce()
        expect(calls).toHaveBeenCalledTimes(mode === 'first' ? 2 : 4)
      }
      expect(new Set(calls.mock.contexts).size).toBe(2)
      expect(calls.mock.calls.map(call => call[3]?.conversationId).sort())
        .toEqual(['capabilities-0', 'capabilities-0', 'capabilities-1', 'capabilities-1'])
      await runtimes[0]!.releaseConversation?.('capabilities-0')
      expect(await runtimes[1]!.getStatus()).toMatchObject({ available: true })
      expect(launch).toHaveBeenCalledOnce()
    } finally {
      calls.mockRestore()
      await Promise.all(runtimes.map(runtime => runtime.dispose()))
      await registry.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('writes outside the Workspace on consecutive requests without generic approval', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'goodbuddy-dsh-directory-')))
    const workspace = join(root, 'workspace')
    const dshHome = join(root, 'home')
    await Promise.all([mkdir(workspace), mkdir(dshHome)])
    const externalFile = join(root, 'external.txt')
    const results: string[] = []
    const inProcess = createInProcessLaunch(dshHome, {
      stream(options) {
        const result = toolResultText(options, 'external-write')
        if (result !== undefined) {
          results.push(result)
          return textResponse('DIRECTORY_TEST_DONE')
        }
        return toolCall('external-write', 'write', {
          file_path: externalFile, content: latestUserText(options)
        })
      }
    })
    const runtime = new DeepSeekHarnessRuntime({
      defaultWorkspace: workspace, baseUrl: 'https://api.deepseek.com',
      model: 'directory-test', launch: options => inProcess.launch(options),
      credentialRefs: { [CREDENTIAL_REF]: 'unused-in-memory-model-credential' },
      initializationTimeoutMs: 20_000, promptTimeoutMs: 20_000, shutdownTimeoutMs: 5_000
    })
    const authorize = vi.fn(async () => 'deny' as const)
    try {
      for (const mode of ['first', 'second'] as const) {
        const events = await collect(runtime.run({
          requestId: `directory-${mode}`, conversationId: `directory-${mode}`,
           prompt: mode
        }, AbortSignal.timeout(20_000), authorize))
        expect(events.at(-1)).toMatchObject({ type: 'done' })
        expect(await readFile(externalFile, 'utf8')).toBe(mode)
      }
      expect(results).toHaveLength(2)
      expect(authorize).not.toHaveBeenCalled()
    } finally {
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('delivers bounded inline images to an image-capable Harness model', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'goodbuddy-harness-acp-image-'))
    )
    const workspace = join(root, 'workspace')
    const dshHome = join(root, 'dsh-home')
    await Promise.all([mkdir(workspace), mkdir(dshHome)])
    let observedRequest: GenerateOptions | undefined
    const inProcess = createInProcessLaunch(dshHome, {
      stream(options) {
        observedRequest = options
        return textResponse('Image received.')
      }
    })
    const runtime = new DeepSeekHarnessRuntime({
      defaultWorkspace: workspace,
      baseUrl: 'https://api.deepseek.com',
      model: 'vision-test',
      supportsImageInput: true,
      launch: (options) => inProcess.launch(options),
      credentialRefs: {
        [CREDENTIAL_REF]: 'unused-in-memory-model-credential'
      },
      initializationTimeoutMs: 20_000,
      promptTimeoutMs: 20_000,
      shutdownTimeoutMs: 5_000
    })
    const png = createCanvas(1, 1).toBuffer('image/png')

    try {
      const events = await collect(
        runtime.run(
          {
            requestId: 'request-acp-image',
            conversationId: 'acp-image',
            prompt: 'Describe this image.',
            images: [
              {
                name: 'reference.png',
                mediaType: 'image/png',
                data: png.toString('base64')
              }
            ]
          },
          new AbortController().signal
        )
      )
      const image = observedRequest?.messages
        .flatMap((message) => message.content)
        .find(
          (
            block
          ): block is Extract<
            GenerateOptions['messages'][number]['content'][number],
            { type: 'image' }
          > => block.type === 'image'
        )

      expect(events).toContainEqual(
        expect.objectContaining({ type: 'done' })
      )
      expect(image?.attachment).toMatchObject({
        mediaType: 'image/png',
        bytes: png.byteLength,
        width: 1,
        height: 1
      })
      const stored =
        await inProcess.hosts[0]!.context.attachments.readImage(
          image!.attachment
        )
      expect(Buffer.from(stored.data).equals(png)).toBe(true)
    } finally {
      await runtime.dispose()
      await Promise.allSettled(
        inProcess.hosts.map((host) => host.dispose())
      )
      await rm(root, { recursive: true, force: true })
    }
  })

  it(
    'coalesces micro reasoning deltas without losing content or overriding model output tokens',
    async () => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), 'goodbuddy-harness-acp-deltas-'))
      )
      const workspace = join(root, 'workspace')
      const dshHome = join(root, 'dsh-home')
      await Promise.all([mkdir(workspace), mkdir(dshHome)])
      let observedRequest: GenerateOptions | undefined
      const inProcess = createInProcessLaunch(dshHome, {
        stream(options) {
          observedRequest = options
          return microDeltaResponse()
        }
      })
      const runtime = new DeepSeekHarnessRuntime({
        defaultWorkspace: workspace,
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-test',
        launch: (options) => inProcess.launch(options),
        credentialRefs: {
          [CREDENTIAL_REF]: 'unused-in-memory-model-credential'
        },
        initializationTimeoutMs: 20_000,
        promptTimeoutMs: 20_000,
        shutdownTimeoutMs: 5_000
      })

      try {
        const events = await collect(
          runtime.run(
            {
              requestId: 'request-acp-deltas',
              conversationId: 'acp-deltas',
              prompt: 'Return the deterministic reasoning stream.',
            },
            new AbortController().signal
          )
        )
        const reasoning = events.filter(
          (
            event
          ): event is Extract<
            RuntimeEvent,
            { type: 'reasoning' }
          > => event.type === 'reasoning'
        )

        expect(observedRequest?.maxTokens).toBeUndefined()
        expect(
          observedRequest?.messages
            .filter((message) => message.role === 'system')
            .flatMap((message) => message.content)
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n')
        ).toContain('Act through the available tools')
        expect(reasoning).toHaveLength(8)
        expect(
          reasoning.map((event) => event.delta).join('')
        ).toBe(
          Array.from(
            { length: MICRO_DELTA_COUNT },
            (_value, index) => String(index % 10)
          ).join('')
        )
        expect(events.at(-1)).toMatchObject({ type: 'done' })
      } finally {
        await runtime.dispose()
        await Promise.allSettled(
          inProcess.hosts.map((host) => host.dispose())
        )
        await rm(root, { recursive: true, force: true })
      }
    },
    30_000
  )

  it(
    'rejects the ACP prompt with a bounded model turn error',
    async () => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), 'goodbuddy-harness-acp-error-'))
      )
      const workspace = join(root, 'workspace')
      const dshHome = join(root, 'dsh-home')
      await Promise.all([mkdir(workspace), mkdir(dshHome)])
      const inProcess = createInProcessLaunch(dshHome, {
        stream() {
          throw new Error('synthetic model turn failed')
        }
      })
      const runtime = new DeepSeekHarnessRuntime({
        defaultWorkspace: workspace,
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-test',
        launch: (options) => inProcess.launch(options),
        credentialRefs: {
          [CREDENTIAL_REF]: 'unused-in-memory-model-credential'
        },
        initializationTimeoutMs: 20_000,
        promptTimeoutMs: 2_000,
        shutdownTimeoutMs: 5_000
      })

      try {
        await expect(
          collect(
            runtime.run(
              {
                requestId: 'request-acp-error',
                conversationId: 'acp-error',
                prompt: 'Trigger the synthetic model failure.',
              },
              new AbortController().signal
            )
          )
        ).rejects.toThrow('synthetic model turn failed')
      } finally {
        await runtime.dispose()
        await Promise.allSettled(
          inProcess.hosts.map((host) => host.dispose())
        )
        await rm(root, { recursive: true, force: true })
      }
    },
    30_000
  )

  it(
    'loads a native Skill, calls a real MCP, and keeps registered tools on the next request',
    async () => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), 'goodbuddy-harness-acp-e2e-'))
      )
      const workspace = join(root, 'workspace')
      const dshHome = join(root, 'dsh-home')
      await Promise.all([
        mkdir(workspace),
        mkdir(dshHome)
      ])
      const inventoryPlugin = join(
        root,
        'native-inventory-plugin.mjs'
      )
      await writeFile(
        inventoryPlugin,
        [
          "export const name = 'native-inventory-plugin'",
          "export const inject = ['skills']",
          'export function apply(ctx) {',
          '  ctx.skills.register({',
          "    name: 'plugin-native-skill',",
          "    description: 'Skill contributed by a Host plugin.',",
          "    content: '# Plugin native skill',",
          "    source: 'custom'",
          '  })',
          '}'
        ].join('\n'),
        'utf8'
      )
      const provider = new ModelToolProvider(workspace, [
        {
          id: 'fbf42200-4e60-48d0-b5f2-e816db38ac54',
          name: 'Local 3D Game Blueprint',
          description: 'Deterministic integration fixture',
          enabled: true,
          allowDynamicTools: false,
          assignments: ['deepseek-harness'],
          secretConfigured: false,
          transport: 'stdio',
          command: process.versions.electron ? 'node' : process.execPath,
          args: [
            resolve(
              'tests',
              'fixtures',
              'web-3d-game-mcp.mjs'
            )
          ]
        } satisfies ResolvedMcpServer
      ], undefined, undefined, false, { runtimeTarget: 'deepseek-harness' })
      const callTool = vi.spyOn(provider, 'callTool')
      const listTools = vi.spyOn(provider, 'listTools')
      const fakeModel = new FakeGameModel()
      const inProcess = createInProcessLaunch(dshHome, fakeModel)
      const runtime = new DeepSeekHarnessRuntime({
        defaultWorkspace: workspace,
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-test',
        launch: (options) => inProcess.launch(options),
        credentialRefs: {
          [CREDENTIAL_REF]: 'unused-in-memory-model-credential'
        },
        skillPackages: [
          {
            id: 'web-3d-game',
            directory: resolve(
              'tests',
              'fixtures',
              'web-3d-game-skill'
            )
          }
        ],
        extensionPackages: [
          {
            id: 'native-inventory-plugin',
            entrypoint: inventoryPlugin,
            configuration: {}
          }
        ],
        toolProvider: provider,
        initializationTimeoutMs: 20_000,
        promptTimeoutMs: 20_000,
        shutdownTimeoutMs: 5_000
      })
      const authorize = vi.fn(
        async (
          request: Parameters<
            NonNullable<
              Parameters<DeepSeekHarnessRuntime['run']>[2]
            >
          >[0]
        ) =>
          request.scopeKey.startsWith('model:mcp:')
            ? ('once' as const)
            : ('deny' as const)
      )

      try {
        await runtime.testConnection()
        expect(inProcess.hosts[0]?.extensionFailures).toEqual([])
        await expect(runtime.getNativeSnapshot()).resolves.toMatchObject({
          provider: 'deepseek-harness',
          available: true,
          inventoryStatus: 'available',
          toolsSupported: true,
          tools: expect.arrayContaining([
            expect.objectContaining({
              id: 'read',
              kind: 'read',
              source: 'runtime',
            }),
            expect.objectContaining({
              id: 'edit',
              kind: 'write',
              source: 'runtime',
            })
          ]),
          skills: [
            {
              id: 'plugin-native-skill',
              name: 'plugin-native-skill',
              description: 'Skill contributed by a Host plugin.',
              source: 'plugin'
            }
          ],
          mcpServers: [],
          agents: [],
          commands: [],
          lsp: [],
          formatters: [],
          prompts: [],
          resources: [],
          resourcesSupported: false,
          context: {
            strategy: 'unsupported',
            manualCompact: false
          }
        })
        const initialEvents = await collect(
          runtime.run(
            {
              requestId: 'request-acp-initial',
              conversationId: 'acp-e2e',
              prompt:
                'Use the Web 3D Game Skill and assigned blueprint MCP.',
            },
            new AbortController().signal,
            authorize
          )
        )

        expect(fakeModel.initialToolNames).toContain('skill')
        expect(fakeModel.mcpToolName).toMatch(
          /_create_game_blueprint$/u
        )
        expect(fakeModel.skillResult).toContain(
          'window.__GOODBUDDY_GAME__'
        )
        expect(fakeModel.blueprint).toMatchObject({
          title: 'Prism Relay',
          objective: { targetCount: 5 },
          acceptance: {
            testSurface: 'window.__GOODBUDDY_GAME__'
          }
        })
        expect(authorize).not.toHaveBeenCalled()
        expect(callTool).toHaveBeenCalledWith(
          fakeModel.mcpToolName,
          {
            theme: 'neon-ruins',
            seed: 'goodbuddy-0.9.0',
            targetCount: 5
          },
          expect.any(AbortSignal),
          {
            conversationId: 'acp-e2e',
            knowledgeCapabilityToken: undefined
          } satisfies ModelToolCallContext
        )
        expect(initialEvents).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'tool',
              callId: SKILL_CALL_ID,
              name: 'skill',
              state: 'pending'
            }),
            expect.objectContaining({
              type: 'tool',
              callId: SKILL_CALL_ID,
              state: 'completed'
            }),
            expect.objectContaining({
              type: 'tool',
              callId: MCP_CALL_ID,
              name: fakeModel.mcpToolName,
              state: 'pending'
            }),
            expect.objectContaining({
              type: 'tool',
              callId: MCP_CALL_ID,
              state: 'completed'
            }),
            expect.objectContaining({
              type: 'text',
              delta: expect.stringContaining('Prism Relay')
            }),
            expect.objectContaining({
              type: 'model-usage',
              runtime: 'deepseek-harness'
            }),
            expect.objectContaining({
              type: 'done',
              sessionId: expect.any(String)
            })
          ])
        )
        expect(
          initialEvents.filter(
            (event) =>
              event.type === 'tool' &&
              event.state === 'running'
          )
        ).toHaveLength(0)

        const callsBeforeFollowup = callTool.mock.calls.length
        const listsBeforeFollowup = listTools.mock.calls.length
        const approvalsBeforeFollowup = authorize.mock.calls.length
        const followupEvents = await collect(
          runtime.run(
            {
              requestId: 'request-acp-followup',
              conversationId: 'acp-e2e',
              prompt:
                'FOLLOWUP_MCP_PROBE: attempt the previous MCP tool.',
            },
            new AbortController().signal,
            authorize
          )
        )

        expect(fakeModel.followupToolNames).toContain(
          fakeModel.mcpToolName
        )
        expect(fakeModel.followupToolResult).toContain(
          'Prism Relay'
        )
        expect(callTool).toHaveBeenCalledTimes(callsBeforeFollowup + 1)
        expect(listTools).toHaveBeenCalledTimes(listsBeforeFollowup + 1)
        expect(listTools).toHaveBeenLastCalledWith(
          {
            conversationId: 'acp-e2e',
            knowledgeCapabilityToken: undefined
          },
          expect.any(AbortSignal)
        )
        expect(authorize).toHaveBeenCalledTimes(approvalsBeforeFollowup)
        expect(followupEvents).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'tool',
              callId: FOLLOWUP_MCP_CALL_ID,
              name: fakeModel.mcpToolName,
              state: 'pending'
            }),
            expect.objectContaining({
              type: 'tool',
              callId: FOLLOWUP_MCP_CALL_ID,
              state: 'completed'
            }),
            expect.objectContaining({
              type: 'text',
              delta: expect.stringContaining(
                'MCP proxy remains available'
              )
            }),
            expect.objectContaining({ type: 'done' })
          ])
        )
      } finally {
        await runtime.dispose()
        await Promise.allSettled(
          inProcess.hosts.map((host) => host.dispose())
        )
        await rm(root, { recursive: true, force: true })
      }
    },
    60_000
  )

  it.runIf(liveModelEnabled)(
    'forwards a custom model header through the real DeepSeek Harness provider',
    async () => {
      if (!liveApiKey) {
        throw new Error(
          'GOODBUDDY_DSH_API_KEY is required for live DSH model E2E'
        )
      }
      const root = await realpath(
        await mkdtemp(join(tmpdir(), 'goodbuddy-harness-header-model-'))
      )
      const workspace = join(root, 'workspace')
      const dshHome = join(root, 'dsh-home')
      await Promise.all([mkdir(workspace), mkdir(dshHome)])
      const probe = await createModelRequestProbe({
        upstreamUrl: createOpenAIChatCompletionsUrl(liveBaseUrl),
        headerName: 'x-goodbuddy-e2e'
      })
      const inProcess = createInProcessLaunch(dshHome)
      const runtime = new DeepSeekHarnessRuntime({
        defaultWorkspace: workspace,
        baseUrl: probe.baseUrl,
        model: liveModel,
        requestHeaders: {
          'x-goodbuddy-e2e': 'harness-header-present'
        },
        launch: (options) => inProcess.launch(options),
        credentialRefs: {
          [CREDENTIAL_REF]: liveApiKey
        },
        initializationTimeoutMs: 20_000,
        promptTimeoutMs: 120_000,
        shutdownTimeoutMs: 5_000
      })

      try {
        const events = await collect(
          runtime.run(
            {
              requestId: 'request-live-custom-header',
              conversationId: 'live-custom-header',
              prompt:
                'Reply with exactly DSH_CUSTOM_HEADER_E2E_OK and nothing else.',
            },
            new AbortController().signal
          )
        )
        expect(
          events
            .flatMap((event) =>
              event.type === 'text' ? [event.delta] : []
            )
            .join('')
        ).toContain('DSH_CUSTOM_HEADER_E2E_OK')
        expect(probe.observations).toEqual([
          {
            headerValue: 'harness-header-present',
            bodyFields: {}
          }
        ])
      } finally {
        await runtime.dispose()
        await Promise.allSettled(
          inProcess.hosts.map((host) => host.dispose())
        )
        await probe.close()
        await rm(root, { recursive: true, force: true })
      }
    },
    180_000
  )

  it.runIf(liveModelEnabled)(
    'lets a real model use Main-brokered Web Search and Fetch without approval',
    async () => {
      if (!liveApiKey) {
        throw new Error(
          'GOODBUDDY_DSH_API_KEY is required for live DSH model E2E'
        )
      }
      const root = await realpath(
        await mkdtemp(join(tmpdir(), 'goodbuddy-harness-web-model-'))
      )
      const workspace = join(root, 'workspace')
      const dshHome = join(root, 'dsh-home')
      await Promise.all([mkdir(workspace), mkdir(dshHome)])
      const observedRequests: GenerateOptions[] = []
      const inProcess = createInProcessLaunch(
        dshHome,
        undefined,
        (options) => observedRequests.push(options)
      )
      const toolProvider = new ModelToolProvider(
        workspace,
        [],
        undefined,
        undefined,
        true,
        { runtimeTarget: 'deepseek-harness' }
      )
      const runtime = new DeepSeekHarnessRuntime({
        defaultWorkspace: workspace,
        baseUrl: liveBaseUrl,
        model: liveModel,
        launch: (options) => inProcess.launch(options),
        credentialRefs: {
          [CREDENTIAL_REF]: liveApiKey
        },
        toolProvider,
        initializationTimeoutMs: 20_000,
        promptTimeoutMs: 120_000,
        shutdownTimeoutMs: 5_000
      })

      try {
        const events = await collect(
          runtime.run(
            {
              requestId: 'request-live-web-search',
              conversationId: 'live-web-search',
              prompt:
                'DSH_WEB_TOOLS_PROBE: First call web_search exactly once with query "GoodBuddy GitHub desktop assistant" and numResults 2. Then call web_fetch exactly once with urls ["https://example.com/"] and maxCharacters 1000. Do not call another tool. After both results, reply with DSH_WEB_TOOLS_E2E_OK.',
            },
            new AbortController().signal
          )
        )
        expect(
          observedRequests.flatMap(
            (options) =>
              options.tools?.map((tool) => tool.name) ?? []
          )
        ).toEqual(
          expect.arrayContaining(['web_search', 'web_fetch'])
        )
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'tool',
              name: 'web_search',
              state: 'completed'
            }),
            expect.objectContaining({
              type: 'tool',
              name: 'web_fetch',
              state: 'completed'
            })
          ])
        )
        expect(
          events
            .flatMap((event) =>
              event.type === 'text' ? [event.delta] : []
            )
            .join('')
        ).toContain('DSH_WEB_TOOLS_E2E_OK')
      } finally {
        await runtime.dispose()
        await toolProvider.dispose()
        await Promise.allSettled(
          inProcess.hosts.map((host) => host.dispose())
        )
        await rm(root, { recursive: true, force: true })
      }
    },
    180_000
  )

  it.runIf(liveModelEnabled)(
    'lets a real model call a registered npm plugin across requests',
    async () => {
      if (!liveApiKey) {
        throw new Error(
          'GOODBUDDY_DSH_API_KEY is required for live DSH model E2E'
        )
      }
      const root = await realpath(
        await mkdtemp(join(tmpdir(), 'goodbuddy-harness-plugin-model-'))
      )
      const workspace = join(root, 'workspace')
      const dshHome = join(root, 'dsh-home')
      const installation = join(root, 'extension')
      await Promise.all([
        mkdir(workspace),
        mkdir(dshHome),
        mkdir(installation)
      ])
      let installer: DshNpmExtensionInstaller | undefined
      try {
        const entry = {
          id: 'dsh-plugin-greet-live',
          package: {
            name: 'dsh-plugin-greet',
            version: '0.2.0'
          },
          displayName: 'dsh-plugin-greet',
          description: 'Reviewed minimal live DSH plugin fixture.'
        }
        const npmCliPath = process.env.GOODBUDDY_DSH_NPM_CLI
          ? resolve(process.env.GOODBUDDY_DSH_NPM_CLI)
          : resolve(
              'node_modules',
              'npm',
              'bin',
              'npm-cli.js'
            )
        const nodeExecutablePath =
          process.env.GOODBUDDY_DSH_NODE_EXECUTABLE
            ? resolve(
                process.env.GOODBUDDY_DSH_NODE_EXECUTABLE
              )
            : undefined
        installer = new DshNpmExtensionInstaller({
          dshHome,
          npmCliPath,
          ...(nodeExecutablePath ? { nodeExecutablePath } : {})
        })
        const installed = await installer.install({
          entry,
          destinationDirectory: installation
        })
        const observedRequests: GenerateOptions[] = []
        const inProcess = createInProcessLaunch(
          dshHome,
          undefined,
          (options) => observedRequests.push(options)
        )
        const runtime = new DeepSeekHarnessRuntime({
          defaultWorkspace: workspace,
          baseUrl: liveBaseUrl,
          model: liveModel,
          launch: (options) => inProcess.launch(options),
          credentialRefs: {
            [CREDENTIAL_REF]: liveApiKey
          },
          extensionPackages: [
            {
              id: entry.id,
              entrypoint: join(
                installation,
                ...installed.entrypoint.split('/')
              ),
              configuration: {}
            }
          ],
          initializationTimeoutMs: 20_000,
          promptTimeoutMs: 120_000,
          shutdownTimeoutMs: 5_000
        })

        try {
          const followupEvents = await collect(
            runtime.run(
              {
                requestId: 'request-live-plugin-first',
                conversationId: 'live-plugin-first',
                prompt:
                  'DSH_FIRST_PLUGIN_PROBE: call greet exactly once with name GoodBuddyFirst. After the tool result, reply with DSH_PLUGIN_OK.',
              },
              new AbortController().signal
            )
          )
          const followupRequests = observedRequests.filter((options) =>
            latestUserText(options).includes(
              'DSH_FIRST_PLUGIN_PROBE'
            )
          )
          expect(followupRequests.length).toBeGreaterThan(0)
          expect(
            followupRequests.flatMap(
              (options) =>
                options.tools?.map((tool) => tool.name) ?? []
            )
          ).toContain('greet')
          expect(followupEvents).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'tool',
                name: 'greet',
                state: 'pending'
              }),
              expect.objectContaining({
                type: 'tool',
                state: 'completed',
                output: expect.stringContaining(
                  'Hello, GoodBuddyFirst!'
                )
              }),
              expect.objectContaining({ type: 'done' })
            ])
          )
          expect(
            followupEvents.some(
              (event) =>
                event.type === 'tool' &&
                event.state === 'completed'
            )
          ).toBe(true)
          expect(
            followupEvents
              .flatMap((event) =>
                event.type === 'text' ? [event.delta] : []
              )
              .join('')
          ).toContain('DSH_PLUGIN_OK')

          const initialEvents = await collect(
            runtime.run(
              {
                requestId: 'request-live-plugin-second',
                conversationId: 'live-plugin-second',
                prompt:
                  'DSH_SECOND_PLUGIN_PROBE: call greet exactly once with name GoodBuddyLive. After its result, reply with DSH_SECOND_PLUGIN_OK and the exact greeting.',
              },
              new AbortController().signal
            )
          )
          const initialRequests = observedRequests.filter((options) =>
            latestUserText(options).includes(
              'DSH_SECOND_PLUGIN_PROBE'
            )
          )
          expect(initialRequests.length).toBeGreaterThan(0)
          expect(
            initialRequests.some((options) =>
              options.tools?.some((tool) => tool.name === 'greet')
            )
          ).toBe(true)
          expect(initialEvents).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'tool',
                name: 'greet',
                state: 'pending'
              }),
              expect.objectContaining({
                type: 'tool',
                state: 'completed',
                output: expect.stringContaining(
                  'Hello, GoodBuddyLive!'
                )
              }),
              expect.objectContaining({ type: 'done' })
            ])
          )
          expect(
            initialEvents
              .flatMap((event) =>
                event.type === 'text' ? [event.delta] : []
              )
              .join('')
          ).toContain('DSH_SECOND_PLUGIN_OK')
        } finally {
          await Promise.allSettled([
            runtime.dispose(),
            ...inProcess.hosts.map((host) => host.dispose())
          ])
        }
      } finally {
        await installer?.dispose().catch(() => undefined)
        await rm(root, { recursive: true, force: true })
      }
    },
    180_000
  )
})
