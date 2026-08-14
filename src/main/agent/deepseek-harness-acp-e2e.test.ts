import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  CallId,
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
import { GOODBUDDY_HARNESS_MAX_STEP_TOKENS } from './goodbuddy-harness-control-plane'

const MAX_FRAME_BYTES = 1024 * 1024
const CREDENTIAL_REF = 'GOODBUDDY_DEEPSEEK_API_KEY'
const SKILL_CALL_ID = 'e2e-skill-call'
const MCP_CALL_ID = 'e2e-mcp-call'
const ASK_MCP_CALL_ID = 'e2e-ask-mcp-call'
const MICRO_DELTA_COUNT = 30_000

function expectedSandbox() {
  return process.platform === 'win32'
    ? { provider: 'windows-acl', enforcement: 'partial' as const }
    : process.platform === 'darwin'
      ? { provider: 'seatbelt', enforcement: 'full' as const }
      : { provider: 'local-linux', enforcement: 'full' as const }
}

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
    for (const block of message.content) {
      if (
        block.type !== 'tool-result' ||
        block.toolCallId !== callId
      ) {
        continue
      }
      return block.content
        .filter(
          (
            content
          ): content is Extract<
            (typeof block.content)[number],
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
        message.source.kind === 'user'
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
  const id = CallId(callId)
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
  askToolResult?: string
  executeToolNames: string[] = []
  askToolNames: string[] = []

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const prompt = latestUserText(options)
    const toolNames = options.tools?.map((tool) => tool.name) ?? []

    if (prompt.includes('ASK_BOUNDARY_PROBE')) {
      this.askToolNames = toolNames
      const result = toolResultText(options, ASK_MCP_CALL_ID)
      if (!result) {
        if (!this.mcpToolName) {
          throw new Error('Fake model has no prior MCP tool identity')
        }
        return toolCall(ASK_MCP_CALL_ID, this.mcpToolName, {
          theme: 'neon-ruins',
          seed: 'ask-must-not-execute',
          targetCount: 5
        })
      }
      this.askToolResult = result
      return textResponse('Ask mode MCP proxy unavailable as required.')
    }

    this.executeToolNames = toolNames
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
  model: HarnessModel
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
        harnessVersion: '0.1.0-rc.6',
        sandbox: expectedSandbox(),
        credentialRefs: options.credentialRefs,
        skillPackages: options.skillPackages,
        stream: createBoundedNdJsonStream(
          hostToClient.writable,
          clientToHost.readable,
          MAX_FRAME_BYTES
        )
      })
      hosts.push(host)
      host.context.on(
        'llm/stream',
        (request) => model.stream(request),
        { global: true, prepend: true }
      )
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
  it(
    'coalesces micro reasoning deltas without losing content and caps each model step',
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
              workMode: 'execute'
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

        expect(observedRequest?.maxTokens).toBe(
          GOODBUDDY_HARNESS_MAX_STEP_TOKENS
        )
        expect(observedRequest?.system).toContain(
          'act through the available tools'
        )
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
                workMode: 'ask'
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
    'loads a native Skill, calls an approved real MCP, forwards events, and removes MCP in Ask',
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
          command: process.execPath,
          args: [
            resolve(
              'tests',
              'fixtures',
              'web-3d-game-mcp.mjs'
            )
          ]
        } satisfies ResolvedMcpServer
      ])
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
              'resources',
              'skills',
              'web-3d-game'
            )
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
        const executeEvents = await collect(
          runtime.run(
            {
              requestId: 'request-acp-execute',
              conversationId: 'acp-e2e',
              prompt:
                'Use the Web 3D Game Skill and assigned blueprint MCP.',
              workMode: 'execute'
            },
            new AbortController().signal,
            authorize
          )
        )

        expect(fakeModel.executeToolNames).toContain('skill')
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
        expect(authorize).toHaveBeenCalledOnce()
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
            workMode: 'execute',
            knowledgeCapabilityToken: undefined
          } satisfies ModelToolCallContext
        )
        expect(executeEvents).toEqual(
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
          executeEvents.filter(
            (event) =>
              event.type === 'tool' &&
              event.state === 'running'
          )
        ).toHaveLength(0)

        const callsBeforeAsk = callTool.mock.calls.length
        const listsBeforeAsk = listTools.mock.calls.length
        const approvalsBeforeAsk = authorize.mock.calls.length
        const askEvents = await collect(
          runtime.run(
            {
              requestId: 'request-acp-ask',
              conversationId: 'acp-e2e',
              prompt:
                'ASK_BOUNDARY_PROBE: attempt the previous MCP tool.',
              workMode: 'ask'
            },
            new AbortController().signal,
            authorize
          )
        )

        expect(fakeModel.askToolNames).not.toContain(
          fakeModel.mcpToolName
        )
        expect(fakeModel.askToolResult).toContain('unknown tool')
        expect(callTool).toHaveBeenCalledTimes(callsBeforeAsk)
        expect(listTools).toHaveBeenCalledTimes(listsBeforeAsk)
        expect(authorize).toHaveBeenCalledTimes(approvalsBeforeAsk)
        expect(askEvents).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'tool',
              callId: ASK_MCP_CALL_ID,
              name: fakeModel.mcpToolName,
              state: 'pending'
            }),
            expect.objectContaining({
              type: 'tool',
              callId: ASK_MCP_CALL_ID,
              state: 'failed'
            }),
            expect.objectContaining({
              type: 'text',
              delta: expect.stringContaining(
                'MCP proxy unavailable'
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
})
