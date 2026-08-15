import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  type CapabilityCipher
} from '../capabilities/capability-service'
import {
  goodbuddyConfigToolByName,
  goodbuddyConfigTools
} from '../../shared/goodbuddy-config-tools'

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
const portableRoot = join(
  process.cwd(),
  'dist',
  'GoodBuddy-0.1.0-win-x64-portable'
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
            enabled: true,
            triggerTokens: 8_000,
            recentRawTokens: 4_000
          }
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
                  'alpha '.repeat(1_200)
                ].join('\n')
              },
              {
                role: 'assistant',
                content: [
                  'I will remember the project codename.',
                  'Acknowledgement notes:',
                  'gamma '.repeat(1_000)
                ].join('\n')
              },
              {
                role: 'user',
                content: [
                  'The deploy region is AP-SOUTH-7.',
                  'Recent notes:',
                  'beta '.repeat(900)
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
          type: 'status',
          message: '较早的对话已压缩，正在生成回答'
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
        authentication: 'api-key'
      })
      const abortController = new AbortController()

      try {
        const result = collectText(
          runtime.run(
            {
              requestId: crypto.randomUUID(),
              conversationId: crypto.randomUUID(),
              workMode: 'ask',
              prompt:
                'Write a detailed technical essay of at least 3000 words.'
            },
            abortController.signal
          )
        )
        setTimeout(() => abortController.abort(), 50)
        await expect(result).rejects.toMatchObject({
          name: 'AbortError'
        })
      } finally {
        await runtime.dispose()
      }
    },
    120_000
  )

  it(
    'completes an approved file task through bundled OpenCode',
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
        expect(approvals).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/^opencode:/u)
          ])
        )
        await expect(
          readFile(join(workspace, 'opencode-output.txt'), 'utf8')
        ).resolves.toBe('OPENCODE_E2E_OK')
      } finally {
        await runtime.dispose()
      }
    },
    180_000
  )

  it(
    'completes an approved file task through bundled Continue',
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
        const output = await collectText(
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
        if (approvals.length === 0) {
          throw new Error(
            `Continue did not request tool approval: ${output.slice(0, 500)}`
          )
        }
        await expect(
          readFile(join(workspace, 'continue-output.txt'), 'utf8')
        ).resolves.toBe('CONTINUE_E2E_OK')
      } finally {
        await runtime.dispose()
      }
    },
    180_000
  )
})
