import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  defaultContextCompressionSettings,
  modelProtocolSchema
} from '../../shared/contracts'
import { ContinueAgentRuntime } from './continue-runtime'
import { ModelAgentRuntime } from './model-runtime'
import { OpenCodeRuntime } from './opencode-runtime'
import { AgentRuntimeController } from './runtime-controller'
import type { RuntimeEvent } from './runtime'
import type {
  ModelToolCallContext,
  ModelToolDefinition,
  ModelToolProviderLike,
  ModelToolResult
} from './model-tool-provider'
import { GoodBuddyConfigService } from '../goodbuddy-config-service'
import { ApplicationSettingsStore } from '../application-settings-store'
import {
  BrowserProfileService,
  MemoryBrowserProfileStore
} from '../capabilities/browser-profile-service'
import {
  CapabilityService,
  type CapabilityCipher,
  type ResolvedMcpServer
} from '../capabilities/capability-service'
import {
  goodbuddyConfigToolByName,
  goodbuddyConfigTools
} from '../../shared/goodbuddy-config-tools'
import { KnowledgeMcpGateway } from './knowledge-mcp-gateway'
import { SubagentScheduler } from '../assistant/subagent-scheduler'

const enabled = process.env.GOODBUDDY_RUN_RUNTIME_E2E === '1'
const apiKey =
  process.env.GOODBUDDY_E2E_API_KEY ??
  process.env.ANTHROPIC_API_KEY ??
  ''
const configuredBaseUrl =
  process.env.GOODBUDDY_E2E_BASE_URL ??
  process.env.ANTHROPIC_BASE_URL ??
  'https://api.anthropic.com'
const configuredUrl = new URL(configuredBaseUrl)
configuredUrl.search = ''
configuredUrl.hash = ''
const baseUrl = configuredUrl.toString().replace(/\/$/u, '')
const modelName =
  process.env.GOODBUDDY_E2E_MODEL ?? 'claude-sonnet-5'
const protocol = modelProtocolSchema
  .exclude(['openai-images-generations'])
  .parse(
    process.env.GOODBUDDY_E2E_PROTOCOL ?? 'anthropic-messages'
  )
const portableRoot = process.env.GOODBUDDY_E2E_PACKAGED_ROOT
  ? resolve(process.env.GOODBUDDY_E2E_PACKAGED_ROOT)
  : join(
      process.cwd(),
      'dist',
      'harness-package-probe',
      'win-unpacked'
    )

async function collectText(
  events: AsyncGenerator<RuntimeEvent, void, void>
): Promise<string> {
  let output = ''
  for await (const event of events) {
    if (event.type === 'text') {
      output += event.delta
    }
  }
  return output
}

async function collectEvents(
  events: AsyncGenerator<RuntimeEvent, void, void>
): Promise<RuntimeEvent[]> {
  const collected: RuntimeEvent[] = []
  for await (const event of events) {
    collected.push(event)
  }
  return collected
}

function customMcpServer(
  assignment: 'opencode' | 'continue'
): ResolvedMcpServer {
  return {
    id:
      assignment === 'opencode'
        ? '00000000-0000-4000-8000-0000000000e1'
        : '00000000-0000-4000-8000-0000000000e2',
    name: 'Live Blueprint MCP',
    description: 'Deterministic local Runtime E2E fixture',
    enabled: true,
    allowDynamicTools: false,
    assignments: [assignment],
    secretConfigured: false,
    transport: 'stdio',
    command: process.execPath,
    args: [
      resolve('tests', 'fixtures', 'web-3d-game-mcp.mjs')
    ]
  }
}

function textResult(value: unknown): ModelToolResult {
  const text = JSON.stringify(value)
  return {
    parts: [{ type: 'text', text }],
    contextBytes: Buffer.byteLength(text)
  }
}

class RealModelConfigToolProvider implements ModelToolProviderLike {
  readonly calls: string[] = []
  private planId?: string

  constructor(
    private readonly service: GoodBuddyConfigService,
    private readonly workspacePath: string,
    private readonly requestId: string
  ) {}

  async listTools(
    context: ModelToolCallContext
  ): Promise<ModelToolDefinition[]> {
    return goodbuddyConfigTools
      .filter(
        (tool) =>
          context.workMode === 'execute' || tool.access === 'read'
      )
      .map((tool) => {
        const schema = z.toJSONSchema(tool.inputSchema, {
          target: 'draft-7'
        }) as Record<string, unknown>
        Reflect.deleteProperty(schema, '$schema')
        return {
          name: tool.name,
          displayName: tool.title,
          description: tool.description,
          inputSchema: schema,
          source: 'builtin'
        }
      })
  }

  getApproval() {
    return {
      scopeKey: 'real-model-config-test',
      title: 'Unexpected config write',
      description: 'Real config discovery test must not apply changes',
      allowPermanent: false
    }
  }

  async callTool(
    name: string,
    argumentsValue: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<ModelToolResult> {
    signal.throwIfAborted()
    this.calls.push(name)
    const tool = goodbuddyConfigToolByName.get(
      name as Parameters<typeof goodbuddyConfigToolByName.get>[0]
    )
    if (!tool) {
      throw new Error(`Unexpected tool: ${name}`)
    }
    switch (name) {
      case 'goodbuddy_config_capabilities':
        return textResult({
          capabilities: this.service.getCapabilities(argumentsValue)
        })
      case 'goodbuddy_config_get':
        return textResult({
          config: await this.service.getSnapshot(argumentsValue)
        })
      case 'goodbuddy_config_plan': {
        const plan = await this.service.plan(
          this.requestId,
          this.workspacePath,
          argumentsValue
        )
        this.planId = plan.planId
        return textResult({ plan })
      }
      default:
        throw new Error('Apply is forbidden in the real discovery test')
    }
  }

  async releaseConversation(): Promise<void> {}
  async dispose(): Promise<void> {}

  getPlannedId(): string | undefined {
    return this.planId
  }
}

class RealLongAgentToolProvider implements ModelToolProviderLike {
  readonly completedSteps: number[] = []

  async listTools(): Promise<ModelToolDefinition[]> {
    if (this.completedSteps.length >= 3) {
      return []
    }
    const expectedStep = this.completedSteps.length + 1
    return [
      {
        name: 'record_progress',
        displayName: 'Record progress',
        description:
          expectedStep <= 3
            ? `Record required progress step ${expectedStep}. Call exactly once with step ${expectedStep} before continuing.`
            : 'All required progress is recorded. Do not call this tool again.',
        inputSchema: {
          type: 'object',
          properties: {
            step: {
              type: 'integer',
              const: expectedStep
            }
          },
          required: ['step'],
          additionalProperties: false
        },
        source: 'builtin'
      }
    ]
  }

  getApproval() {
    return {
      scopeKey: 'real-long-agent-test',
      title: 'Record test progress',
      description: 'Record deterministic E2E progress',
      allowPermanent: false
    }
  }

  async callTool(
    name: string,
    argumentsValue: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<ModelToolResult> {
    signal.throwIfAborted()
    const expectedStep = this.completedSteps.length + 1
    if (
      name !== 'record_progress' ||
      argumentsValue.step !== expectedStep ||
      expectedStep > 3
    ) {
      throw new Error(
        `Unexpected progress call: ${name} ${JSON.stringify(argumentsValue)}`
      )
    }
    this.completedSteps.push(expectedStep)
    const text = [
      `STEP_${expectedStep}_RECORDED`,
      `evidence-${expectedStep} `.repeat(4_000)
    ].join('\n')
    return {
      parts: [{ type: 'text', text }],
      contextBytes: Buffer.byteLength(text)
    }
  }

  async releaseConversation(): Promise<void> {}
  async dispose(): Promise<void> {}
}

describe.runIf(enabled)('runtime end-to-end', () => {
  let workspace = ''

  beforeAll(async () => {
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is required for Runtime E2E')
    }
    workspace = await mkdtemp(join(tmpdir(), 'goodbuddy-runtime-e2e-'))
  })

  afterAll(async () => {
    if (workspace) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it(
    'streams a complete response through the direct model runtime',
    async () => {
      const runtime = new ModelAgentRuntime({
        apiKey,
        baseUrl,
        model: modelName,
        protocol,
        authentication: 'api-key'
      })

      try {
        const output = await collectText(
          runtime.run(
            {
              requestId: crypto.randomUUID(),
              conversationId: crypto.randomUUID(),
              workMode: 'ask',
              prompt:
                'Return exactly this text and nothing else: MODEL_E2E_OK'
            },
            new AbortController().signal
          )
        )
        expect(output).toContain('MODEL_E2E_OK')
      } finally {
        await runtime.dispose()
      }
    },
    120_000
  )

  it(
    'uses real direct-model process execution and a programming Subagent to repair and verify code',
    async () => {
      const scheduler = new SubagentScheduler({
        concurrency: 3,
        queueLimit: 20,
        timeoutMs: 10 * 60_000
      })
      const runtime = new ModelAgentRuntime({
        apiKey,
        baseUrl,
        model: modelName,
        protocol,
        authentication: 'api-key',
        defaultWorkspace: workspace,
        directModelSubagentScheduler: scheduler
      })
      const events: RuntimeEvent[] = []

      try {
        for await (const event of runtime.run(
          {
            requestId: crypto.randomUUID(),
            conversationId: crypto.randomUUID(),
            workMode: 'execute',
            prompt: [
              'Complete this verification entirely with GoodBuddy tools.',
              '1. Use workspace_write_text to create programming-e2e.cjs with an intentional failing Node assertion.',
              '2. Use process_execute to run `node programming-e2e.cjs` and observe a non-zero exit.',
              '3. Use workspace_write_text to replace it with a passing program that prints exactly PROGRAMMING_E2E_OK.',
              '4. Use process_execute again and observe exit code 0 plus PROGRAMMING_E2E_OK.',
              '5. Use subagent_delegate exactly once. Ask the programming Subagent to independently run the final file with process_execute and verify its output. Do not ask it to delegate.',
              '6. After the Subagent completes, reply with exactly REAL_PROGRAMMING_E2E_OK.',
              'Do not skip, reorder, or merely describe any tool step.'
            ].join('\n')
          },
          new AbortController().signal,
          async () => 'once'
        )) {
          events.push(event)
        }

        const processOutputs = events.flatMap((event) =>
          event.type === 'tool' &&
          event.name === '进程执行' &&
          event.state === 'completed' &&
          event.output
            ? [event.output]
            : []
        )
        expect(
          processOutputs.some((output) =>
            /"exitCode"\s*:\s*[1-9]\d*/u.test(output)
          )
        ).toBe(true)
        expect(
          processOutputs.some(
            (output) =>
              /"exitCode"\s*:\s*0/u.test(output) &&
              output.includes('PROGRAMMING_E2E_OK')
          )
        ).toBe(true)
        expect(
          events.some(
            (event) =>
              event.type === 'subagent' &&
              event.state === 'completed' &&
              'actor' in event &&
              event.actor.kind === 'direct-model'
          )
        ).toBe(true)
        expect(
          events
            .filter((event) => event.type === 'text')
            .map((event) => event.delta)
            .join('')
            .trim().length
        ).toBeGreaterThan(0)
        expect(events.at(-1)).toMatchObject({ type: 'done' })
        expect(
          await readFile(
            join(workspace, 'programming-e2e.cjs'),
            'utf8'
          )
        ).toContain('PROGRAMMING_E2E_OK')

        const modelCalls = events.filter(
          (event) => event.type === 'model-usage'
        ).length
        expect(modelCalls).toBeGreaterThanOrEqual(6)
        console.info(`REAL_PROGRAMMING_MODEL_CALLS=${modelCalls}`)
      } finally {
        await runtime.dispose()
        scheduler.dispose()
        await scheduler.waitForIdle()
      }
    },
    10 * 60_000
  )

  it(
    'continues real direct-model history with local message IDs',
    async () => {
      const runtime = new ModelAgentRuntime({
        apiKey,
        baseUrl,
        model: modelName,
        protocol,
        authentication: 'api-key'
      })

      try {
        const output = await collectText(
          runtime.run(
            {
              requestId: crypto.randomUUID(),
              conversationId: crypto.randomUUID(),
              workMode: 'ask',
              prompt:
                'Return exactly this text and nothing else: LOCAL_HISTORY_ID_E2E_OK',
              history: [
                {
                  role: 'user',
                  content:
                    'The required verification text is LOCAL_HISTORY_ID_E2E_OK.'
                },
                {
                  role: 'assistant',
                  content:
                    'I will return that verification text when asked.'
                }
              ],
              historyMessageIds: [
                crypto.randomUUID(),
                crypto.randomUUID()
              ]
            },
            new AbortController().signal
          )
        )
        expect(output).toContain('LOCAL_HISTORY_ID_E2E_OK')
      } finally {
        await runtime.dispose()
      }
    },
    120_000
  )

  it(
    'counts a real image in provider-reported input usage',
    async () => {
      const runtime = new ModelAgentRuntime({
        apiKey,
        baseUrl,
        model: modelName,
        protocol,
        authentication: 'api-key',
        supportsImageInput: true,
        contextCompression: {
          settings: {
            ...defaultContextCompressionSettings,
            enabled: true
          },
          contextWindowTokens: 32_000
        }
      })
      const baselineEvents: RuntimeEvent[] = []
      const imageEvents: RuntimeEvent[] = []
      const prompt =
        'Return exactly this text and nothing else: IMAGE_USAGE_E2E_OK'

      try {
        for await (const event of runtime.run(
          {
            requestId: crypto.randomUUID(),
            conversationId: crypto.randomUUID(),
            workMode: 'ask',
            prompt
          },
          new AbortController().signal
        )) {
          baselineEvents.push(event)
        }
        for await (const event of runtime.run(
          {
            requestId: crypto.randomUUID(),
            conversationId: crypto.randomUUID(),
            workMode: 'ask',
            prompt,
            images: [
              {
                name: 'goodbuddy-icon.png',
                mediaType: 'image/png',
                data: await readFile(
                  join(process.cwd(), 'build', 'icon.png'),
                  'base64'
                )
              }
            ]
          },
          new AbortController().signal
        )) {
          imageEvents.push(event)
        }
      } finally {
        await runtime.dispose()
      }

      const baselineUsage = baselineEvents.find(
        (
          event
        ): event is Extract<RuntimeEvent, { type: 'model-usage' }> =>
          event.type === 'model-usage'
      )
      const imageUsage = imageEvents.find(
        (
          event
        ): event is Extract<RuntimeEvent, { type: 'model-usage' }> =>
          event.type === 'model-usage'
      )
      expect(baselineUsage).toBeDefined()
      expect(imageUsage).toBeDefined()
      expect(imageUsage!.inputTokens).toBeGreaterThan(
        baselineUsage!.inputTokens
      )
      expect(
        imageEvents.filter(
          (event) => event.type === 'context-metrics'
        )
      ).toEqual([
        expect.objectContaining({
          source: 'provider',
          contextTokens:
            imageUsage!.inputTokens +
            imageUsage!.outputTokens +
            (protocol === 'anthropic-messages'
              ? imageUsage!.cacheReadTokens +
                imageUsage!.cacheWriteTokens
              : 0)
        })
      ])
    },
    180_000
  )

  it(
    'compresses real direct-model history and preserves earlier and recent facts',
    async () => {
      const runtime = new ModelAgentRuntime({
        apiKey,
        baseUrl,
        model: modelName,
        protocol,
        authentication: 'api-key',
        contextCompression: {
          settings: {
            ...defaultContextCompressionSettings,
            enabled: true
          },
          contextWindowTokens: 32_000
        }
      })
      const events: RuntimeEvent[] = []

      try {
        for await (const event of runtime.run(
          {
            requestId: crypto.randomUUID(),
            conversationId: crypto.randomUUID(),
            workMode: 'ask',
            prompt:
              'Reply with exactly one line beginning CONTEXT_COMPRESSION_E2E_OK, followed by the project codename and deploy region found in the prior conversation.',
            history: [
              {
                role: 'user',
                content: [
                  'The project codename is ORBIT-739.',
                  'Background notes:',
                  'alpha '.repeat(8_000)
                ].join('\n')
              },
              {
                role: 'assistant',
                content: [
                  'I will remember the project codename.',
                  'Acknowledgement notes:',
                  'gamma '.repeat(6_500)
                ].join('\n')
              },
              {
                role: 'user',
                content: [
                  'The deploy region is AP-SOUTH-7.',
                  'Recent notes:',
                  'beta '.repeat(5_000)
                ].join('\n')
              },
              {
                role: 'assistant',
                content:
                  'I will also remember the deploy region.'
              }
            ]
          },
          new AbortController().signal
        )) {
          events.push(event)
        }
      } finally {
        await runtime.dispose()
      }

      const output = events
        .flatMap((event) =>
          event.type === 'text' ? [event.delta] : []
        )
        .join('')
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'context-compression',
          state: 'started'
        })
      )
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'context-compression',
          state: 'completed',
          estimatedAfterTokens: expect.any(Number)
        })
      )
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'model-usage',
          callId: expect.stringMatching(/^context-summary:/u)
        })
      )
      expect(output).toContain('CONTEXT_COMPRESSION_E2E_OK')
      expect(output).toContain('ORBIT-739')
      expect(output).toContain('AP-SOUTH-7')
    },
    120_000
  )

  it(
    'compresses context after a real completed response reaches the threshold',
    async () => {
      const expectedOutput = [
        'POST_RESPONSE_COMPRESSION_E2E_OK_',
        'SAFE'.repeat(16)
      ].join('')
      const prompt = `Return exactly this text and nothing else: ${expectedOutput}`
      const history = [
        {
          role: 'user' as const,
          content: `baseline\n${'alpha '.repeat(8_500)}`
        },
        {
          role: 'assistant' as const,
          content: 'ack'
        }
      ]

      const runtime = new ModelAgentRuntime({
        apiKey,
        baseUrl,
        model: modelName,
        protocol,
        authentication: 'api-key',
        contextCompression: {
          settings: {
            ...defaultContextCompressionSettings,
            enabled: true,
            triggerTokens: 8_000,
            recentRawTokens: 4_000
          },
          contextWindowTokens: 32_000
        }
      })
      const events: RuntimeEvent[] = []

      try {
        for await (const event of runtime.run(
          {
            requestId: crypto.randomUUID(),
            conversationId: crypto.randomUUID(),
            workMode: 'ask',
            prompt,
            history
          },
          new AbortController().signal
        )) {
          events.push(event)
        }
      } finally {
        await runtime.dispose()
      }

      const output = events
        .flatMap((event) =>
          event.type === 'text' ? [event.delta] : []
        )
        .join('')
      const lastTextIndex = events.reduce(
        (lastIndex, event, index) =>
          event.type === 'text' ? index : lastIndex,
        -1
      )
      const postResponseCompressionIndex = events.findIndex(
        (event) =>
          event.type === 'context-compression' &&
          event.scope === 'conversation' &&
          event.state === 'started'
      )
      expect(output).toContain(expectedOutput)
      expect(lastTextIndex).toBeGreaterThanOrEqual(0)
      expect(postResponseCompressionIndex).toBeGreaterThan(
        lastTextIndex
      )
      expect(
        events
          .filter((event) => event.type === 'context-metrics')
          .at(-1)
      ).toMatchObject({
        type: 'context-metrics',
        source: 'provider'
      })
      expect(events).not.toContainEqual(
        expect.objectContaining({
          type: 'context-metrics',
          source: 'estimated'
        })
      )
      expect(events.at(-1)).toMatchObject({ type: 'done' })
    },
    180_000
  )

  it(
    'compacts a real multi-round Agent run and continues to completion',
    async () => {
      const toolProvider = new RealLongAgentToolProvider()
      const runtime = new ModelAgentRuntime({
        apiKey,
        baseUrl,
        model: modelName,
        protocol,
        authentication: 'api-key',
        toolProvider,
        contextCompression: {
          settings: {
            ...defaultContextCompressionSettings,
            enabled: true,
            triggerTokens: 8_000,
            recentRawTokens: 4_000
          },
          contextWindowTokens: 32_000
        }
      })
      const events: RuntimeEvent[] = []

      try {
        for await (const event of runtime.run(
          {
            requestId: crypto.randomUUID(),
            conversationId: crypto.randomUUID(),
            workMode: 'execute',
            prompt:
              'Call record_progress sequentially for steps 1, 2, and 3. Wait for each result before calling the next step. After all three results, do not call tools again and reply with LONG_AGENT_COMPRESSION_E2E_OK.'
          },
          new AbortController().signal,
          async () => 'once'
        )) {
          events.push(event)
        }
      } finally {
        await runtime.dispose()
      }

      const output = events
        .flatMap((event) =>
          event.type === 'text' ? [event.delta] : []
        )
        .join('')
      expect(toolProvider.completedSteps).toEqual([1, 2, 3])
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'context-compression',
          scope: 'agent-run',
          state: 'completed'
        })
      )
      expect(output).toContain('LONG_AGENT_COMPRESSION_E2E_OK')
      expect(
        events
          .filter((event) => event.type === 'context-metrics')
          .at(-1)
      ).toMatchObject({ source: 'provider' })
      expect(events).not.toContainEqual(
        expect.objectContaining({
          type: 'context-metrics',
          source: 'estimated'
        })
      )
      expect(events.at(-1)).toMatchObject({ type: 'done' })
    },
    240_000
  )

  it(
    'discovers and plans GoodBuddy configuration through a real model',
    async () => {
      const testRoot = await mkdtemp(
        join(tmpdir(), 'goodbuddy-config-model-e2e-')
      )
      const builtinSkillsRoot = join(testRoot, 'builtin-skills')
      const importedSkillsRoot = join(testRoot, 'imported-skills')
      await mkdir(builtinSkillsRoot, { recursive: true })
      const cipher: CapabilityCipher = {
        isAvailable: () => true,
        encrypt: (value) => Buffer.from(value),
        decrypt: (value) => value.toString()
      }
      const configService = new GoodBuddyConfigService(
        new ApplicationSettingsStore(join(testRoot, 'application.json')),
        new CapabilityService(
          join(testRoot, 'capabilities.json'),
          builtinSkillsRoot,
          importedSkillsRoot,
          cipher,
          {
            browserProfiles: new BrowserProfileService(
              new MemoryBrowserProfileStore()
            )
          }
        )
      )
      const requestId = crypto.randomUUID()
      const toolProvider = new RealModelConfigToolProvider(
        configService,
        workspace,
        requestId
      )
      const runtime = new ModelAgentRuntime({
        apiKey,
        baseUrl,
        model: modelName,
        protocol,
        authentication: 'api-key',
        defaultWorkspace: workspace,
        toolProvider
      })

      try {
        const output = await collectText(
          runtime.run(
            {
              requestId,
              conversationId: crypto.randomUUID(),
              workMode: 'execute',
              prompt:
                'Use GoodBuddy configuration tools. First discover capabilities and examples, then read the sanitized current configuration, then create (but do not apply) a plan that sets checkUpdatesOnStartup to false. Finish with CONFIG_PLAN_OK and the plan risk. Never call apply.'
            },
            new AbortController().signal,
            async (event) =>
              event.toolName === 'goodbuddy_config_apply'
                ? 'deny'
                : 'once'
          )
        )
        expect(toolProvider.calls).toEqual(
          expect.arrayContaining([
            'goodbuddy_config_capabilities',
            'goodbuddy_config_get',
            'goodbuddy_config_plan'
          ])
        )
        expect(toolProvider.calls).not.toContain('goodbuddy_config_apply')
        expect(toolProvider.getPlannedId()).toBeDefined()
        expect(output).toContain('CONFIG_PLAN_OK')
      } finally {
        await runtime.dispose()
        await rm(testRoot, { recursive: true, force: true })
      }
    },
    120_000
  )

  it(
    'cancels an in-flight direct model task',
    async () => {
      const runtime = new ModelAgentRuntime({
        apiKey,
        baseUrl,
        model: modelName,
        protocol,
        authentication: 'api-key',
        contextCompression: {
          settings: {
            ...defaultContextCompressionSettings,
            enabled: true
          },
          contextWindowTokens: 32_000
        }
      })
      const abortController = new AbortController()
      const events: RuntimeEvent[] = []

      try {
        const result = (async () => {
          for await (const event of runtime.run(
            {
              requestId: crypto.randomUUID(),
              conversationId: crypto.randomUUID(),
              workMode: 'ask',
              prompt:
                'Write a detailed technical essay of at least 3000 words.'
            },
            abortController.signal
          )) {
            events.push(event)
          }
        })()
        setTimeout(() => abortController.abort(), 50)
        await expect(result).rejects.toMatchObject({
          name: 'AbortError'
        })
        expect(events).not.toContainEqual(
          expect.objectContaining({
            type: 'context-metrics'
          })
        )
      } finally {
        await runtime.dispose()
      }
    },
    120_000
  )

  it(
    'completes an Execute file task through bundled OpenCode',
    async () => {
      const runtime = new AgentRuntimeController(
        new OpenCodeRuntime({
          embedded: true,
          binaryPath: '',
          bundledBinaryPath: join(
            portableRoot,
            'resources',
            'runtimes',
            'opencode',
            'opencode.exe'
          ),
          configPath: '',
          defaultWorkspace: workspace,
          modelProfile: {
            id: crypto.randomUUID(),
            name: 'E2E model',
            baseUrl,
            modelName,
            apiKey,
            protocol,
            authentication: 'api-key'
          }
        })
      )
      const approvals: string[] = []

      try {
        await collectText(
          runtime.run(
            {
              requestId: crypto.randomUUID(),
              conversationId: crypto.randomUUID(),
              workMode: 'execute',
              prompt:
                'Create opencode-output.txt in the current workspace with exactly OPENCODE_E2E_OK. Use the file tools and finish only after verifying the file.'
            },
            new AbortController().signal,
            async (request) => {
              approvals.push(request.scopeKey)
              return 'once'
            }
          )
        )
        expect(approvals).not.toContain('runtime:whole-run')
        expect(approvals).toEqual([])
        await expect(
          readFile(join(workspace, 'opencode-output.txt'), 'utf8')
        ).resolves.toMatch(/^OPENCODE_E2E_OK\r?\n?$/u)
      } finally {
        await runtime.dispose()
      }
    },
    180_000
  )

  it(
    'compacts and continues a real bundled OpenCode session',
    async () => {
      const runtime = new OpenCodeRuntime({
        embedded: true,
        binaryPath: '',
        bundledBinaryPath: join(
          portableRoot,
          'resources',
          'runtimes',
          'opencode',
          'opencode.exe'
        ),
        configPath: '',
        defaultWorkspace: workspace,
        modelProfile: {
          id: crypto.randomUUID(),
          name: 'E2E model',
          baseUrl,
          modelName,
          apiKey,
          protocol,
          authentication: 'api-key'
        }
      })
      const conversationId = crypto.randomUUID()
      const signal = new AbortController().signal

      try {
        await expect(
          collectText(
            runtime.run(
              {
                requestId: crypto.randomUUID(),
                conversationId,
                workMode: 'ask',
                prompt:
                  'Remember that the verification codename is NATIVE-COMPACT-739. Reply with exactly OPENCODE_COMPACT_READY.'
              },
              signal
            )
          )
        ).resolves.toContain('OPENCODE_COMPACT_READY')

        await expect(
          runtime.compactConversation(
            {
              requestId: crypto.randomUUID(),
              conversationId,
              runtimeSelection: { provider: 'opencode' },
              history: [
                {
                  role: 'user',
                  content:
                    'The verification codename is NATIVE-COMPACT-739.'
                },
                {
                  role: 'assistant',
                  content: 'OPENCODE_COMPACT_READY'
                }
              ],
              historyMessageIds: [
                crypto.randomUUID(),
                crypto.randomUUID()
              ]
            },
            signal
          )
        ).resolves.toMatchObject({
          result: {
            provider: 'opencode',
            strategy: 'native',
            compacted: true
          }
        })

        await expect(
          collectText(
            runtime.run(
              {
                requestId: crypto.randomUUID(),
                conversationId,
                workMode: 'ask',
                prompt:
                  'Return exactly the verification codename from before and nothing else.'
              },
              signal
            )
          )
        ).resolves.toContain('NATIVE-COMPACT-739')
      } finally {
        await runtime.dispose()
      }
    },
    180_000
  )

  it(
    'completes an Execute file task through bundled Continue',
    async () => {
      const runtime = new AgentRuntimeController(
        new ContinueAgentRuntime({
          binaryPath: '',
          bundledBinaryPath: join(
            portableRoot,
            'resources',
            'runtimes',
            'continue',
            'dist',
            'cn.js'
          ),
          configPath: '',
          defaultWorkspace: workspace,
          hostCacheRoot: join(workspace, '.continue-host'),
          modelProfile: {
            id: crypto.randomUUID(),
            name: 'E2E model',
            baseUrl,
            modelName,
            apiKey,
            protocol,
            authentication: 'api-key'
          }
        })
      )
      const approvals: string[] = []

      try {
        await collectText(
          runtime.run(
            {
              requestId: crypto.randomUUID(),
              conversationId: crypto.randomUUID(),
              workMode: 'execute',
              prompt:
                'Create continue-output.txt in the current workspace with exactly CONTINUE_E2E_OK. Use tools and finish only after verifying the file.'
            },
            new AbortController().signal,
            async (request) => {
              approvals.push(request.scopeKey)
              return 'once'
            }
          )
        )
        expect(approvals).toEqual([])
        await expect(
          readFile(join(workspace, 'continue-output.txt'), 'utf8')
        ).resolves.toMatch(/^CONTINUE_E2E_OK\r?\n?$/u)
      } finally {
        await runtime.dispose()
      }
    },
    180_000
  )

  it(
    'calls a Main-brokered custom MCP through bundled OpenCode',
    async () => {
      const gateway = new KnowledgeMcpGateway({} as never)
      await gateway.start()
      const runtime = new AgentRuntimeController(
        new OpenCodeRuntime({
          embedded: true,
          binaryPath: '',
          bundledBinaryPath: join(
            portableRoot,
            'resources',
            'runtimes',
            'opencode',
            'opencode.exe'
          ),
          configPath: '',
          defaultWorkspace: workspace,
          modelProfile: {
            id: crypto.randomUUID(),
            name: 'E2E model',
            baseUrl,
            modelName,
            apiKey,
            protocol,
            authentication: 'api-key'
          },
          knowledgeGateway: gateway,
          mcpServers: [customMcpServer('opencode')]
        })
      )

      try {
        const events = await collectEvents(
          runtime.run(
            {
              requestId: crypto.randomUUID(),
              conversationId: crypto.randomUUID(),
              workMode: 'execute',
              prompt:
                'Use the assigned custom MCP tool to create a neon-ruins game blueprint with seed opencode-live and targetCount 5. Then reply with OPENCODE_MCP_E2E_OK and the blueprint title.'
            },
            new AbortController().signal,
            async (request) =>
              [
                request.scopeKey,
                request.title,
                request.description,
                request.toolName ?? ''
              ].some((value) =>
                value.includes('create_game_blueprint')
              )
                ? 'once'
                : 'deny'
          )
        )
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'tool',
              name: expect.stringContaining(
                'create_game_blueprint'
              ),
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
        ).toContain('OPENCODE_MCP_E2E_OK')
        expect(
          events
            .flatMap((event) =>
              event.type === 'text' ? [event.delta] : []
            )
            .join('')
        ).toContain('Prism Relay')
      } finally {
        await runtime.dispose()
        await gateway.dispose()
      }
    },
    180_000
  )

  it(
    'calls a Main-brokered custom MCP through bundled Continue',
    async () => {
      const gateway = new KnowledgeMcpGateway({} as never)
      await gateway.start()
      const runtime = new AgentRuntimeController(
        new ContinueAgentRuntime({
          binaryPath: '',
          bundledBinaryPath: join(
            portableRoot,
            'resources',
            'runtimes',
            'continue',
            'dist',
            'cn.js'
          ),
          configPath: '',
          defaultWorkspace: workspace,
          hostCacheRoot: join(workspace, '.continue-mcp-host'),
          modelProfile: {
            id: crypto.randomUUID(),
            name: 'E2E model',
            baseUrl,
            modelName,
            apiKey,
            protocol,
            authentication: 'api-key'
          },
          knowledgeGateway: gateway,
          mcpServers: [customMcpServer('continue')]
        })
      )

      try {
        const events = await collectEvents(
          runtime.run(
            {
              requestId: crypto.randomUUID(),
              conversationId: crypto.randomUUID(),
              workMode: 'execute',
              prompt:
                'Use the assigned custom MCP tool to create a neon-ruins game blueprint with seed continue-live and targetCount 5. Then reply with CONTINUE_MCP_E2E_OK and the blueprint title.'
            },
            new AbortController().signal,
            async (request) =>
              [
                request.scopeKey,
                request.title,
                request.description,
                request.toolName ?? ''
              ].some((value) =>
                value.includes('create_game_blueprint')
              )
                ? 'once'
                : 'deny'
          )
        )
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'tool',
              name: expect.stringContaining(
                'create_game_blueprint'
              ),
              state: 'completed'
            })
          ])
        )
        const output = events
          .flatMap((event) =>
            event.type === 'text' ? [event.delta] : []
          )
          .join('')
        expect(output).toContain('CONTINUE_MCP_E2E_OK')
        expect(output).toContain('Prism Relay')
      } finally {
        await runtime.dispose()
        await gateway.dispose()
      }
    },
    180_000
  )
})
