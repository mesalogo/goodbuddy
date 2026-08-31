import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  Client,
  ClientSideConnection,
  PromptResponse
} from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeAcpProcessOutput,
  RuntimeAcpProcessOwner
} from './runtime-acp-backend'
import { AgentOwnedAcpPrompt } from './agent-owned-acp-prompt'
import { SemanticPromptStore } from './semantic-prompt-store'

const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('AgentOwnedAcpPrompt', () => {
  it('keeps the original prompt promise through Desktop detach and recovers the final response', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodbuddy-owned-acp-'))
    temporary.push(root)
    mkdirSync(join(root, 'state'), { mode: 0o700 })
    const transcript = new SemanticPromptStore(
      join(root, 'state', 'prompts.sqlite')
    )
    transcript.prepare({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1',
      controllerId: 'controller-1',
      preparationDigest: `sha256:${'a'.repeat(64)}`,
      promptSequence: 0
    })
    let client: Client | undefined
    let resolvePrompt!: (response: PromptResponse) => void
    const prompt = vi.fn(
      async () =>
        await new Promise<PromptResponse>((resolve) => {
          resolvePrompt = resolve
        })
    )
    const newSession = vi.fn(async () => ({ sessionId: 'session-1' }))
    const expectedModel = 'goodbuddy-openai-chat/model-1'
    const setSessionConfigOption = vi.fn(async () => ({
      configOptions: [
        {
          type: 'select',
          id: 'model',
          name: 'Model',
          currentValue: expectedModel,
          options: [
            {
              name: 'Model 1',
              value: expectedModel
            }
          ]
        }
      ]
    }))
    const initialize = vi.fn(async () => ({
      protocolVersion: 1,
      agentCapabilities: {}
    }))
    const process = new MemoryProcess()
    const complete = vi.fn(async () => {
      await process.completePrompt()
    })
    const owner = new AgentOwnedAcpPrompt({
      bindingId: 'binding-1',
      controllerId: 'controller-1',
      workspaceDirectory: '/workspace',
      workMode: 'execute',
      expectedModel,
      process,
      transcript,
      completePrompt: async (_operationId, status) => {
        expect(status).toBe('completed')
        await complete()
      },
      createConnection: (factory) => {
        client = factory()
        return {
          initialize,
          newSession,
          setSessionConfigOption,
          prompt,
          cancel: vi.fn(async () => undefined)
        } as unknown as ClientSideConnection
      }
    })
    const request = {
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1',
      prompt: [{ type: 'text' as const, text: 'finish independently' }]
    }
    await expect(owner.start(request)).resolves.toMatchObject({
      state: 'running',
      sessionId: 'session-1'
    })

    // The controller transport can disappear; it is intentionally absent from
    // the owner lifetime and therefore cannot cancel this Promise.
    const detachedDesktop = new AbortController()
    detachedDesktop.abort()
    await client!.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'done' }
      }
    })
    resolvePrompt({ stopReason: 'end_turn' })
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce())

    expect(initialize).toHaveBeenCalledOnce()
    expect(newSession).toHaveBeenCalledOnce()
    expect(setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-1',
      configId: 'model',
      value: expectedModel
    })
    expect(prompt).toHaveBeenCalledOnce()
    expect(process.completions).toBe(1)
    expect(
      transcript.attach('binding-1', 'operation-1', 'controller-1')
    ).toMatchObject({ state: 'completed' })
    expect(
      transcript.page({
        bindingId: 'binding-1',
        operationId: 'operation-1',
        controllerId: 'controller-1',
        afterSequence: '0',
        limit: 10
      }).events.map((event) => event.kind)
    ).toEqual(['session-update', 'prompt-terminal'])
    await expect(owner.start(request)).resolves.toMatchObject({
      state: 'completed'
    })
    expect(prompt).toHaveBeenCalledOnce()
    transcript.close()
  })

  it('records one outcome-unknown terminal when Runtime completion fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodbuddy-owned-acp-'))
    temporary.push(root)
    mkdirSync(join(root, 'state'), { mode: 0o700 })
    const transcript = new SemanticPromptStore(
      join(root, 'state', 'prompts.sqlite')
    )
    transcript.prepare({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1',
      controllerId: 'controller-1',
      preparationDigest: `sha256:${'a'.repeat(64)}`,
      promptSequence: 0
    })
    const completePrompt = vi.fn(async () => {
      throw new Error('Runtime completion failed')
    })
    const owner = new AgentOwnedAcpPrompt({
      bindingId: 'binding-1',
      controllerId: 'controller-1',
      workspaceDirectory: '/workspace',
      workMode: 'execute',
      process: new MemoryProcess(),
      transcript,
      completePrompt,
      createConnection: () =>
        ({
          initialize: async () => ({
            protocolVersion: 1,
            agentCapabilities: {}
          }),
          newSession: async () => ({ sessionId: 'session-1' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: vi.fn(async () => undefined)
        }) as unknown as ClientSideConnection
    })

    await owner.start({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1',
      prompt: [{ type: 'text', text: 'finish independently' }]
    })
    await vi.waitFor(() =>
      expect(
        transcript.attach('binding-1', 'operation-1', 'controller-1')
      ).toMatchObject({ state: 'outcome-unknown' })
    )

    const terminalEvents = transcript
      .page({
        bindingId: 'binding-1',
        operationId: 'operation-1',
        controllerId: 'controller-1',
        afterSequence: '0',
        limit: 10
      })
      .events.filter((event) => event.kind === 'prompt-terminal')
    expect(completePrompt).toHaveBeenCalledOnce()
    expect(terminalEvents).toHaveLength(1)
    expect(terminalEvents[0]?.payload).toMatchObject({
      status: 'outcome-unknown',
      completionError: {
        message: 'Runtime completion failed'
      }
    })
    transcript.close()
  })

  it('terminalizes an active prompt when its Runtime process exits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodbuddy-owned-acp-'))
    temporary.push(root)
    mkdirSync(join(root, 'state'), { mode: 0o700 })
    const transcript = new SemanticPromptStore(
      join(root, 'state', 'prompts.sqlite')
    )
    transcript.prepare({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1',
      controllerId: 'controller-1',
      preparationDigest: `sha256:${'a'.repeat(64)}`,
      promptSequence: 0
    })
    const process = new MemoryProcess()
    const completePrompt = vi.fn(async () => undefined)
    const owner = new AgentOwnedAcpPrompt({
      bindingId: 'binding-1',
      controllerId: 'controller-1',
      workspaceDirectory: '/workspace',
      workMode: 'execute',
      process,
      transcript,
      completePrompt,
      createConnection: () =>
        ({
          initialize: async () => ({
            protocolVersion: 1,
            agentCapabilities: {}
          }),
          newSession: async () => ({ sessionId: 'session-1' }),
          prompt: async () =>
            await new Promise<PromptResponse>(() => undefined),
          cancel: vi.fn(async () => undefined)
        }) as unknown as ClientSideConnection
    })

    await owner.start({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1',
      prompt: [{ type: 'text', text: 'wait for Runtime exit' }]
    })
    await process.emitExit()

    await vi.waitFor(() =>
      expect(
        transcript.attach('binding-1', 'operation-1', 'controller-1')
      ).toMatchObject({ state: 'failed' })
    )
    expect(completePrompt).toHaveBeenCalledWith(
      'operation-1',
      'failed'
    )
    expect(
      transcript.page({
        bindingId: 'binding-1',
        operationId: 'operation-1',
        controllerId: 'controller-1',
        afterSequence: '0',
        limit: 10
      }).events
    ).toEqual([
      expect.objectContaining({
        kind: 'prompt-terminal',
        payload: expect.objectContaining({
          status: 'failed',
          error: expect.objectContaining({
            message: 'ACP Runtime process exited'
          })
        })
      })
    ])
    transcript.close()
  })

  it('answers permission requests autonomously from the accepted work mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodbuddy-owned-acp-'))
    temporary.push(root)
    mkdirSync(join(root, 'state'), { mode: 0o700 })
    const transcript = new SemanticPromptStore(
      join(root, 'state', 'prompts.sqlite')
    )
    transcript.prepare({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1',
      controllerId: 'controller-1',
      preparationDigest: `sha256:${'a'.repeat(64)}`,
      promptSequence: 0
    })
    let client!: Client
    const owner = new AgentOwnedAcpPrompt({
      bindingId: 'binding-1',
      controllerId: 'controller-1',
      workspaceDirectory: '/workspace',
      workMode: 'execute',
      process: new MemoryProcess(),
      transcript,
      completePrompt: async () => undefined,
      createConnection: (factory) => {
        client = factory()
        return {
          initialize: async () => ({
            protocolVersion: 1,
            agentCapabilities: {}
          }),
          newSession: async () => ({ sessionId: 'session-1' }),
          prompt: async () =>
            await new Promise<PromptResponse>(() => undefined),
          cancel: async () => undefined
        } as unknown as ClientSideConnection
      }
    })
    await owner.start({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1',
      prompt: [{ type: 'text', text: 'run one tool' }]
    })
    await expect(
      client.requestPermission({
        sessionId: 'session-1',
        toolCall: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: 'write',
          kind: 'edit',
          status: 'pending'
        },
        options: [
          {
            optionId: 'reject',
            name: 'Reject',
            kind: 'reject_once'
          },
          {
            optionId: 'allow',
            name: 'Allow',
            kind: 'allow_once'
          }
        ]
      })
    ).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' }
    })
    transcript.close()
  })

  it('allows only one-shot reads while Ask is detached', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodbuddy-owned-acp-'))
    temporary.push(root)
    mkdirSync(join(root, 'state'), { mode: 0o700 })
    const transcript = new SemanticPromptStore(
      join(root, 'state', 'prompts.sqlite')
    )
    transcript.prepare({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1',
      controllerId: 'controller-1',
      preparationDigest: `sha256:${'a'.repeat(64)}`,
      promptSequence: 0
    })
    let client!: Client
    const owner = new AgentOwnedAcpPrompt({
      bindingId: 'binding-1',
      controllerId: 'controller-1',
      workspaceDirectory: '/workspace',
      workMode: 'ask',
      process: new MemoryProcess(),
      transcript,
      completePrompt: async () => undefined,
      createConnection: (factory) => {
        client = factory()
        return {
          initialize: async () => ({
            protocolVersion: 1,
            agentCapabilities: {}
          }),
          newSession: async () => ({ sessionId: 'session-1' }),
          prompt: async () =>
            await new Promise<PromptResponse>(() => undefined),
          cancel: async () => undefined
        } as unknown as ClientSideConnection
      }
    })
    await owner.start({
      bindingId: 'binding-1',
      operationId: 'operation-1',
      requestId: 'operation-1',
      prompt: [{ type: 'text', text: 'inspect one file' }]
    })
    const permission = (
      kind: 'read' | 'edit'
    ): Parameters<Client['requestPermission']>[0] => ({
      sessionId: 'session-1',
      toolCall: {
        sessionUpdate: 'tool_call',
        toolCallId: `tool-${kind}`,
        title: kind,
        kind,
        status: 'pending'
      },
      options: [
        {
          optionId: `${kind}-reject`,
          name: 'Reject',
          kind: 'reject_once'
        },
        {
          optionId: `${kind}-allow`,
          name: 'Allow',
          kind: 'allow_once'
        }
      ]
    })

    await expect(client.requestPermission(permission('read'))).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'read-allow' }
    })
    await expect(client.requestPermission(permission('edit'))).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'edit-reject' }
    })
    transcript.close()
  })
})

class MemoryProcess implements RuntimeAcpProcessOwner {
  readonly identity = {
    launchId: 'launch-1',
    processId: 'process-1',
    supervisorIdentityDigest: `sha256:${'a'.repeat(64)}`
  }
  completions = 0
  readonly #listeners = new Set<
    (output: RuntimeAcpProcessOutput) => void | Promise<void>
  >()
  readonly #exitListeners = new Set<
    () => void | Promise<void>
  >()

  beginPrompt(): void {}
  completePrompt(): void {
    this.completions += 1
  }
  writeStdin(): void {}
  stop(): void {}
  reconcile() {
    return {
      identity: this.identity,
      state: 'running' as const,
      processTree: 'running' as const
    }
  }
  subscribeOutput(
    listener: (output: RuntimeAcpProcessOutput) => void | Promise<void>
  ): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  subscribeExit(listener: () => void | Promise<void>): () => void {
    this.#exitListeners.add(listener)
    return () => this.#exitListeners.delete(listener)
  }

  async emitExit(): Promise<void> {
    for (const listener of [...this.#exitListeners]) {
      await listener()
    }
  }
}
