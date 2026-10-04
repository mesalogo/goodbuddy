// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ModelAgentRuntime } from '../src/main/agent/model-runtime'
import { OpenCodeRuntime } from '../src/main/agent/opencode-runtime'
import type { AgentRuntime, RuntimeEvent } from '../src/main/agent/runtime'
import { buildRuntimeHistory } from '../src/shared/runtime-history'

// Opt-in: GB_CANCEL_LIVE_ENV=.env.deepseek.local npx vitest run tests/cancelled-turn-live.test.ts
const envPath = process.env.GB_CANCEL_LIVE_ENV
const opencodePath = resolve('.runtime-resources', process.arch, process.platform === 'win32' ? 'opencode.exe' : 'opencode')

const firstPrompt = 'List 40 European capital cities, one per line, each with a one-sentence description.'
const secondPrompt = 'What is 17 + 25? Reply with only the number and nothing else.'

type Env = { apiKey: string; baseUrl: string; model: string }

async function loadEnv(): Promise<Env> {
  const env = parseEnv(await readFile(resolve(envPath!), 'utf8'))
  return { apiKey: env.DEEPSEEK_API_KEY!, baseUrl: env.DEEPSEEK_BASE_URL!, model: env.DEEPSEEK_MODEL! }
}

/** Runs until some answer text streams, then cancels like the Stop button. */
async function runAndCancel(runtime: AgentRuntime, conversationId: string): Promise<string> {
  const controller = new AbortController()
  let partial = ''
  try {
    for await (const event of runtime.run({
      requestId: crypto.randomUUID(), conversationId, prompt: firstPrompt
    }, controller.signal)) {
      if (event.type === 'text') partial += event.delta
      if (partial.length >= 60 && !controller.signal.aborted) controller.abort(new Error('用户取消了请求'))
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error
  }
  expect(controller.signal.aborted).toBe(true)
  return partial
}

async function runText(
  runtime: AgentRuntime,
  request: Parameters<AgentRuntime['run']>[0]
): Promise<string> {
  let output = ''
  for await (const event of runtime.run(request, new AbortController().signal) as AsyncGenerator<RuntimeEvent>) {
    if (event.type === 'text') output += event.delta
  }
  return output.trim()
}

function expectOnlyNewAnswer(output: string): void {
  console.info(`SECOND_TURN_OUTPUT=${JSON.stringify(output)}`)
  expect(output).toMatch(/\b42\b/u)
  // Merging the cancelled turn would resume the capital list.
  expect(output).not.toMatch(/Paris|Berlin|Madrid|Vienna|Rome|London/u)
  expect(output.length).toBeLessThan(40)
}

describe.skipIf(!envPath)('cancelled turn handling with a real model', () => {
  let env: Env
  let workspace: string
  beforeAll(async () => {
    env = await loadEnv()
    workspace = await mkdtemp(join(tmpdir(), 'gb-cancel-live-'))
  })
  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('direct model answers only the new message after a cancelled turn', async () => {
    const runtime = new ModelAgentRuntime({
      apiKey: env.apiKey, baseUrl: env.baseUrl, model: env.model,
      protocol: 'openai-chat-completions', authentication: 'api-key'
    })
    try {
      const conversationId = crypto.randomUUID()
      const partial = await runAndCancel(runtime, conversationId)
      console.info(`DIRECT_PARTIAL_CHARS=${partial.length}`)
      // Same stored shape the renderer keeps after Stop.
      const history = buildRuntimeHistory([
        { id: crypto.randomUUID(), role: 'user', content: firstPrompt, state: 'complete' },
        { id: crypto.randomUUID(), role: 'assistant', content: partial, state: 'error', terminalStatus: 'cancelled' }
      ])
      expect(history).toHaveLength(2)
      expectOnlyNewAnswer(await runText(runtime, {
        requestId: crypto.randomUUID(), conversationId, prompt: secondPrompt,
        history: history.map(({ role, content }) => ({ role, content })),
        historyMessageIds: history.map(({ id }) => id)
      }))
    } finally {
      await runtime.dispose()
    }
  }, 180_000)

  it('direct model answers only the new message when the cancelled turn had no output', async () => {
    const runtime = new ModelAgentRuntime({
      apiKey: env.apiKey, baseUrl: env.baseUrl, model: env.model,
      protocol: 'openai-chat-completions', authentication: 'api-key'
    })
    try {
      const history = buildRuntimeHistory([
        { id: crypto.randomUUID(), role: 'user', content: firstPrompt, state: 'complete' },
        { id: crypto.randomUUID(), role: 'assistant', content: '', state: 'error', terminalStatus: 'cancelled' }
      ])
      expectOnlyNewAnswer(await runText(runtime, {
        requestId: crypto.randomUUID(), conversationId: crypto.randomUUID(), prompt: secondPrompt,
        history: history.map(({ role, content }) => ({ role, content })),
        historyMessageIds: history.map(({ id }) => id)
      }))
    } finally {
      await runtime.dispose()
    }
  }, 180_000)

  it('OpenCode reused session answers only the new message after a cancelled turn', async () => {
    const runtime = new OpenCodeRuntime({
      embedded: true, binaryPath: '', bundledBinaryPath: opencodePath, configPath: '',
      defaultWorkspace: workspace,
      modelProfile: {
        id: crypto.randomUUID(), name: 'DeepSeek live', baseUrl: env.baseUrl, modelName: env.model,
        apiKey: env.apiKey, protocol: 'openai-chat-completions', authentication: 'api-key'
      }
    })
    try {
      const conversationId = crypto.randomUUID()
      const partial = await runAndCancel(runtime, conversationId)
      console.info(`OPENCODE_PARTIAL_CHARS=${partial.length}`)
      expectOnlyNewAnswer(await runText(runtime, {
        requestId: crypto.randomUUID(), conversationId, prompt: secondPrompt
      }))
      // The cancelled request stays in the native transcript, so the model
      // still knows what was asked before.
      const recall = await runText(runtime, {
        requestId: crypto.randomUUID(), conversationId,
        prompt: 'In one short phrase, what did I ask for in my very first message of this conversation? Do not list anything.'
      })
      console.info(`OPENCODE_RECALL=${JSON.stringify(recall)}`)
      expect(recall).toMatch(/capital/iu)
    } finally {
      await runtime.dispose()
    }
  }, 300_000)
})
