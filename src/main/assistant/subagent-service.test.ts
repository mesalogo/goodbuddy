import { describe, expect, it, vi } from 'vitest'
import type { AssistantExpert } from '../../shared/assistant-contracts'
import type { SubagentEvent } from '../../shared/contracts'
import type {
  AgentExecutionRequest,
  AgentRuntime
} from '../agent/runtime'
import { SubagentService } from './subagent-service'
import { SubagentScheduler } from './subagent-scheduler'

const expert: AssistantExpert = {
  id: '00000000-0000-4000-8000-000000000001',
  name: '研究专家',
  description: '',
  systemInstructions: 'Separate evidence from assumptions.',
  routingKeywords: ['研究'],
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

const parentRequest: AgentExecutionRequest = {
  requestId: '00000000-0000-4000-8000-000000000010',
  conversationId: 'conversation',
  workMode: 'ask',
  prompt: '研究这份材料'
}

function database() {
  return {
    createTask: vi.fn(() => ({})),
    updateTaskStatus: vi.fn(),
    appendTaskEvent: vi.fn()
  }
}

describe('SubagentService', () => {
  it('creates a linked child task and puts expert instructions in system context', async () => {
    let executionRequest: AgentExecutionRequest | undefined
    const expertOutput = '结果'.repeat(35_001)
    const runtime = {
      run: async function* (request: AgentExecutionRequest) {
        executionRequest = request
        yield {
          requestId: request.requestId,
          type: 'text',
          delta: expertOutput
        } as const
        yield { requestId: request.requestId, type: 'done' } as const
      },
      releaseConversation: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined)
    } as unknown as AgentRuntime
    const db = database()
    const service = new SubagentService(
      runtime,
      db as never,
      new SubagentScheduler({ timeoutMs: 1_000 })
    )
    const events: SubagentEvent[] = []
    const result = await service.run({
      parentRequest,
      expert,
      routingMode: 'smart',
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event)
    })

    expect(result.output).toBe(expertOutput)
    expect(result.output.length).toBeGreaterThan(60_000)
    expect(db.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        parentTaskId: parentRequest.requestId,
        expertId: expert.id,
        routingMode: 'smart',
        status: 'queued'
      })
    )
    expect(executionRequest?.prompt).toBe(parentRequest.prompt)
    expect(executionRequest?.trustedInstructions).toContain(
      expert.systemInstructions
    )
    expect(events.map((event) => event.state)).toEqual([
      'queued',
      'running',
      'completed'
    ])
    expect(events.at(-1)).toMatchObject({
      state: 'completed',
      output: expertOutput
    })
    await service.dispose()
  })

  it('fails tool-producing experts and records bounded failure state', async () => {
    const events: SubagentEvent[] = []
    const runtime = {
      run: async function* (request: AgentExecutionRequest) {
        yield {
          requestId: request.requestId,
          type: 'text',
          delta: '部分结果'
        } as const
        yield {
          requestId: request.requestId,
          type: 'tool',
          callId: 'call',
          name: 'unsafe',
          state: 'running',
          summary: 'unsafe'
        } as const
      },
      dispose: vi.fn(async () => undefined)
    } as unknown as AgentRuntime
    const db = database()
    const service = new SubagentService(runtime, db as never)
    await expect(service.run({
      parentRequest,
      expert,
      routingMode: 'manual',
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event)
    })).rejects.toThrow('不允许工具调用')
    expect(db.updateTaskStatus).toHaveBeenLastCalledWith(
      expect.any(String),
      'failed',
      expect.stringContaining('不允许工具调用')
    )
    expect(events.at(-1)).toMatchObject({
      state: 'failed',
      output: '部分结果',
      error: expect.stringContaining('不允许工具调用')
    })
    await service.dispose()
  })

  it('uses an expert model profile and falls back to the default runtime', async () => {
    const calls: string[] = []
    const createRuntime = (label: string): AgentRuntime =>
      ({
        run: async function* (request: AgentExecutionRequest) {
          calls.push(label)
          yield {
            requestId: request.requestId,
            type: 'text',
            delta: label
          } as const
          yield { requestId: request.requestId, type: 'done' } as const
        },
        releaseConversation: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined)
      }) as unknown as AgentRuntime
    const defaultRuntime = createRuntime('default')
    const profileRuntime = createRuntime('profile')
    const profileId = '00000000-0000-4000-8000-000000000002'
    const service = new SubagentService(
      defaultRuntime,
      database() as never,
      new SubagentScheduler({ timeoutMs: 1_000 }),
      new Map([[profileId, profileRuntime]])
    )

    const selected = await service.run({
      parentRequest,
      expert: { ...expert, modelProfileId: profileId },
      routingMode: 'manual',
      signal: new AbortController().signal,
      onEvent: vi.fn()
    })
    const fallback = await service.run({
      parentRequest: {
        ...parentRequest,
        requestId: '00000000-0000-4000-8000-000000000011'
      },
      expert: {
        ...expert,
        modelProfileId: '00000000-0000-4000-8000-000000000099'
      },
      routingMode: 'manual',
      signal: new AbortController().signal,
      onEvent: vi.fn()
    })

    expect(selected.output).toBe('profile')
    expect(fallback.output).toBe('default')
    expect(calls).toEqual(['profile', 'default'])
    await service.dispose()
  })
})
