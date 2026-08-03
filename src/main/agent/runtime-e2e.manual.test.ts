import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ContinueAgentRuntime } from './continue-runtime'
import { ModelAgentRuntime } from './model-runtime'
import { OpenCodeRuntime } from './opencode-runtime'
import { AgentRuntimeController } from './runtime-controller'
import type { RuntimeEvent } from './runtime'

const enabled = process.env.GOODBUDDY_RUN_RUNTIME_E2E === '1'
const apiKey = process.env.ANTHROPIC_API_KEY ?? ''
const configuredBaseUrl =
  process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'
const baseUrl = new URL(configuredBaseUrl).origin
const modelName =
  process.env.GOODBUDDY_E2E_MODEL ?? 'claude-sonnet-5'
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
        protocol: 'anthropic-messages',
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
    'cancels an in-flight direct model task',
    async () => {
      const runtime = new ModelAgentRuntime({
        apiKey,
        baseUrl,
        model: modelName,
        protocol: 'anthropic-messages',
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
            protocol: 'anthropic-messages',
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
            protocol: 'anthropic-messages',
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
