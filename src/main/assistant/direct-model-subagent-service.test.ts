import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeModelUsageEvent } from '../agent/runtime'
import {
  DIRECT_MODEL_SUBAGENT_ERROR_MAX_BYTES,
  DIRECT_MODEL_SUBAGENT_OUTPUT_MAX_BYTES,
  DIRECT_MODEL_SUBAGENT_TASK_MAX_LENGTH,
  DirectModelSubagentService,
  type DirectModelSubagentEvent,
  type DirectModelSubagentParent,
  type DirectModelSubagentServiceDependencies
} from './direct-model-subagent-service'
import { SubagentScheduler } from './subagent-scheduler'

type RequestContext = {
  authorizationSnapshot: string
}

const parent: DirectModelSubagentParent<RequestContext> = {
  requestId: 'parent-request',
  projectId: 'project',
  workMode: 'execute',
  requestContext: {
    authorizationSnapshot: 'snapshot'
  }
}

function createHarness(
  runChild: DirectModelSubagentServiceDependencies<RequestContext>['runChild'],
  scheduler = new SubagentScheduler({
    concurrency: 2,
    queueLimit: 4,
    timeoutMs: 1_000
  })
) {
  const events: DirectModelSubagentEvent[] = []
  const usageEvents: unknown[] = []
  const releaseConversation = vi.fn(async () => undefined)
  const service = new DirectModelSubagentService<RequestContext>({
    scheduler,
    runChild,
    releaseConversation
  })
  const run = (
    overrides: Partial<Parameters<typeof service.run>[0]> = {}
  ) =>
    service.run({
      ownerId: 'owner',
      task: 'Inspect and test the focused change.',
      parent,
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
      onModelUsage: (event) => usageEvents.push(event),
      ...overrides
    })
  return {
    service,
    scheduler,
    events,
    usageEvents,
    releaseConversation,
    run
  }
}

describe('DirectModelSubagentService', () => {
  it('completes with inherited context, child attribution, and no persistence dependency', async () => {
    let childInput:
      | Parameters<
          DirectModelSubagentServiceDependencies<RequestContext>['runChild']
        >[0]
      | undefined
    const usage: RuntimeModelUsageEvent = {
      requestId: 'child-model-request',
      type: 'model-usage',
      callId: 'call',
      runtime: 'model',
      provider: 'openai',
      model: 'model',
      inputTokens: 12,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    }
    const harness = createHarness(async (input) => {
      childInput = input
      input.onOutput('completed output')
      input.onModelUsage(usage)
    })

    const result = await harness.run()

    expect(result).toMatchObject({
      status: 'completed',
      output: 'completed output',
      outputTruncated: false,
      modelUsage: {
        inputTokens: 12,
        outputTokens: 7
      }
    })
    expect(result.childRunId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(childInput).toMatchObject({
      task: 'Inspect and test the focused change.',
      context: {
        parentRequestId: parent.requestId,
        childRunId: result.childRunId,
        projectId: parent.projectId,
        conversationId: result.conversationId,
        workMode: parent.workMode
      },
      requestContext: parent.requestContext
    })
    expect(result.conversationId).toBe(
      `direct-model-subagent:${parent.requestId}:${result.childRunId}`
    )
    expect(harness.events.map((event) => event.state)).toEqual([
      'queued',
      'running',
      'completed'
    ])
    expect(harness.usageEvents).toEqual([
      expect.objectContaining({
        parentRequestId: parent.requestId,
        childRunId: result.childRunId,
        conversationId: result.conversationId,
        usage
      })
    ])
    expect(harness.releaseConversation).toHaveBeenCalledOnce()
    expect(harness.releaseConversation).toHaveBeenCalledWith(
      result.conversationId,
      childInput?.context
    )
    harness.scheduler.dispose()
  })

  it('returns failed state with partial output and bounded errors', async () => {
    const harness = createHarness(async (input) => {
      input.onOutput('partial output')
      throw new Error('错'.repeat(3_000))
    })

    const result = await harness.run()

    expect(result).toMatchObject({
      status: 'failed',
      output: 'partial output',
      errorTruncated: true
    })
    expect(Buffer.byteLength(result.error ?? '')).toBeLessThanOrEqual(
      DIRECT_MODEL_SUBAGENT_ERROR_MAX_BYTES
    )
    expect(harness.events.at(-1)).toMatchObject({
      state: 'failed',
      output: 'partial output',
      error: result.error
    })
    expect(harness.releaseConversation).toHaveBeenCalledOnce()
    harness.scheduler.dispose()
  })

  it('bounds UTF-8 output by bytes and marks partial output explicitly', async () => {
    const harness = createHarness(async (input) => {
      input.onOutput('你'.repeat(100_000))
      input.onOutput('late output')
    })

    const result = await harness.run()

    expect(result.status).toBe('completed')
    expect(result.outputTruncated).toBe(true)
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(
      DIRECT_MODEL_SUBAGENT_OUTPUT_MAX_BYTES
    )
    expect(harness.events.at(-1)?.outputTruncated).toBe(true)
    harness.scheduler.dispose()
  })

  it('returns cancelled state with partial output on parent cancellation', async () => {
    const controller = new AbortController()
    const harness = createHarness(async (input) => {
      input.onOutput('partial before cancel')
      await new Promise<void>((resolve) => {
        input.signal.addEventListener('abort', () => resolve(), {
          once: true
        })
      })
      input.signal.throwIfAborted()
    })

    const resultPromise = harness.run({ signal: controller.signal })
    await vi.waitFor(() =>
      expect(harness.events.map((event) => event.state)).toContain(
        'running'
      )
    )
    controller.abort(new Error('parent cancelled'))
    const result = await resultPromise

    expect(result).toMatchObject({
      status: 'cancelled',
      output: 'partial before cancel',
      error: 'parent cancelled'
    })
    expect(harness.events.at(-1)?.state).toBe('cancelled')
    expect(harness.releaseConversation).toHaveBeenCalledOnce()
    harness.scheduler.dispose()
  })

  it('emits queued before the shared scheduler admits a run', async () => {
    const scheduler = new SubagentScheduler({
      concurrency: 1,
      queueLimit: 2,
      timeoutMs: 1_000
    })
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const started: string[] = []
    const harness = createHarness(async (input) => {
      started.push(input.task)
      if (input.task === 'first') {
        await firstGate
      }
      input.onOutput(input.task)
    }, scheduler)

    const first = harness.run({ task: 'first', ownerId: 'first-owner' })
    const second = harness.run({
      task: 'second',
      ownerId: 'second-owner'
    })
    await vi.waitFor(() => expect(started).toEqual(['first']))

    expect(harness.events.map((event) => event.state)).toEqual([
      'queued',
      'queued',
      'running'
    ])

    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'completed', output: 'first' }),
      expect.objectContaining({ status: 'completed', output: 'second' })
    ])
    expect(started).toEqual(['first', 'second'])
    scheduler.dispose()
  })

  it('cancels only runs belonging to the released owner', async () => {
    const harness = createHarness(async (input) => {
      if (input.task === 'other') {
        input.onOutput('other completed')
        return
      }
      input.onOutput('owned partial')
      await new Promise<void>((resolve) => {
        input.signal.addEventListener('abort', () => resolve(), {
          once: true
        })
      })
      input.signal.throwIfAborted()
    })
    const owned = harness.run({
      ownerId: 'released-owner',
      task: 'owned'
    })
    const other = harness.run({
      ownerId: 'other-owner',
      task: 'other'
    })
    await vi.waitFor(() =>
      expect(harness.events.filter(
        (event) => event.state === 'running'
      )).toHaveLength(2)
    )

    await harness.service.releaseOwner(
      'released-owner',
      'owner released'
    )

    await expect(owned).resolves.toMatchObject({
      status: 'cancelled',
      output: 'owned partial',
      error: 'owner released'
    })
    await expect(other).resolves.toMatchObject({
      status: 'completed',
      output: 'other completed'
    })
    expect(harness.releaseConversation).toHaveBeenCalledTimes(2)
    harness.scheduler.dispose()
  })

  it('releases synthetic conversations after queue rejection', async () => {
    const scheduler = new SubagentScheduler({
      concurrency: 1,
      queueLimit: 0,
      timeoutMs: 1_000
    })
    let releaseBlocker!: () => void
    const blocker = scheduler.schedule(
      () => new Promise<void>((resolve) => {
        releaseBlocker = resolve
      })
    )
    const harness = createHarness(async () => undefined, scheduler)

    const result = await harness.run()

    expect(result.status).toBe('failed')
    expect(result.error).toContain('队列已满')
    expect(harness.events.map((event) => event.state)).toEqual([
      'queued',
      'failed'
    ])
    expect(harness.releaseConversation).toHaveBeenCalledOnce()
    releaseBlocker()
    await blocker
    scheduler.dispose()
  })

  it('validates trimmed task bounds before scheduling', async () => {
    const runChild = vi.fn(async () => undefined)
    const harness = createHarness(runChild)

    await expect(harness.run({ task: '   ' })).rejects.toThrow(
      '任务不能为空'
    )
    await expect(harness.run({
      task: ` ${'x'.repeat(DIRECT_MODEL_SUBAGENT_TASK_MAX_LENGTH)} `
    })).resolves.toMatchObject({ status: 'completed' })
    await expect(harness.run({
      task: 'x'.repeat(DIRECT_MODEL_SUBAGENT_TASK_MAX_LENGTH + 1)
    })).rejects.toThrow('不能超过')
    expect(runChild).toHaveBeenCalledTimes(1)
    expect(harness.releaseConversation).toHaveBeenCalledOnce()
    harness.scheduler.dispose()
  })

  it('uses distinct UUID identities for concurrent child runs', async () => {
    const harness = createHarness(async () => undefined)

    const results = await Promise.all([
      harness.run({ ownerId: randomUUID() }),
      harness.run({ ownerId: randomUUID() })
    ])

    expect(results[0].childRunId).not.toBe(results[1].childRunId)
    expect(results[0].conversationId).not.toBe(
      results[1].conversationId
    )
    harness.scheduler.dispose()
  })
})
