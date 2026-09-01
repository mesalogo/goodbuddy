import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { RuntimeModelUsageEvent } from '../agent/runtime'
import { safeToolErrorDetail } from '../agent/approval-summary'
import { SubagentScheduler } from './subagent-scheduler'

export const DIRECT_MODEL_SUBAGENT_TASK_MAX_LENGTH = 100_000
export const DIRECT_MODEL_SUBAGENT_OUTPUT_MAX_BYTES = 192 * 1024
export const DIRECT_MODEL_SUBAGENT_ERROR_MAX_BYTES = 2 * 1024
export const directModelSubagentInputSchema = z
  .object({
    task: z
      .string()
      .trim()
      .min(1, '编程 Subagent 任务不能为空')
      .max(
        DIRECT_MODEL_SUBAGENT_TASK_MAX_LENGTH,
        `编程 Subagent 任务不能超过 ${DIRECT_MODEL_SUBAGENT_TASK_MAX_LENGTH} 个字符`
      )
  })
  .strict()

export type DirectModelSubagentContext = {
  parentRequestId: string
  childRunId: string
  projectId?: string
  conversationId: string
  workMode: 'ask' | 'execute'
}

export type DirectModelSubagentParent<TRequestContext = unknown> = {
  requestId: string
  projectId?: string
  workMode: 'ask' | 'execute'
  requestContext: TRequestContext
}

export type DirectModelSubagentState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type DirectModelSubagentEvent = {
  parentRequestId: string
  childRunId: string
  conversationId: string
  workMode: 'ask' | 'execute'
  state: DirectModelSubagentState
  reason: string
  output?: string
  outputTruncated?: boolean
  error?: string
  errorTruncated?: boolean
}

export type DirectModelSubagentUsageEvent = {
  parentRequestId: string
  childRunId: string
  conversationId: string
  usage: RuntimeModelUsageEvent
}

export type DirectModelSubagentResult = {
  status: 'completed' | 'failed' | 'cancelled'
  childRunId: string
  conversationId: string
  output: string
  outputTruncated: boolean
  error?: string
  errorTruncated?: boolean
  modelUsage?: {
    inputTokens: number
    outputTokens: number
  }
}

export type DirectModelSubagentRunInput<TRequestContext = unknown> = {
  ownerId: string
  task: string
  parent: DirectModelSubagentParent<TRequestContext>
  signal: AbortSignal
  onEvent: (event: DirectModelSubagentEvent) => void
  onModelUsage?: (event: DirectModelSubagentUsageEvent) => void
}

export type DirectModelSubagentChildRunInput<TRequestContext = unknown> = {
  task: string
  context: DirectModelSubagentContext
  requestContext: TRequestContext
  signal: AbortSignal
  onOutput: (delta: string) => void
  onModelUsage: (usage: RuntimeModelUsageEvent) => void
}

export type DirectModelSubagentServiceDependencies<TRequestContext = unknown> = {
  scheduler: SubagentScheduler
  runChild: (
    input: DirectModelSubagentChildRunInput<TRequestContext>
  ) => Promise<void>
  releaseConversation: (
    conversationId: string,
    context: DirectModelSubagentContext
  ) => void | Promise<void>
}

type OwnerRun = {
  controller: AbortController
  settled: Promise<void>
}

type MutableOutcome = {
  status: DirectModelSubagentResult['status']
  error?: string
  errorTruncated?: boolean
}

function truncateUtf8(
  value: string,
  maximumBytes: number
): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value)
  if (encoded.byteLength <= maximumBytes) {
    return { value, truncated: false }
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let end = maximumBytes
  while (end > 0) {
    try {
      return {
        value: decoder.decode(encoded.subarray(0, end)),
        truncated: true
      }
    } catch {
      end -= 1
    }
  }
  return { value: '', truncated: true }
}

function errorDetail(error: unknown): {
  error: string
  errorTruncated: boolean
} {
  const detail =
    safeToolErrorDetail(
      error,
      DIRECT_MODEL_SUBAGENT_ERROR_MAX_BYTES
    ) ?? '编程 Subagent 执行失败'
  const bounded = truncateUtf8(
    detail,
    DIRECT_MODEL_SUBAGENT_ERROR_MAX_BYTES
  )
  return {
    error: bounded.value,
    errorTruncated: bounded.truncated
  }
}

function addTokenCount(current: number, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    return current
  }
  return Math.min(Number.MAX_SAFE_INTEGER, current + value)
}

export class DirectModelSubagentService<TRequestContext = unknown> {
  private readonly ownerRuns = new Map<string, Set<OwnerRun>>()
  private disposed = false

  constructor(
    private readonly dependencies:
      DirectModelSubagentServiceDependencies<TRequestContext>
  ) {}

  async run(
    input: DirectModelSubagentRunInput<TRequestContext>
  ): Promise<DirectModelSubagentResult> {
    if (this.disposed) {
      throw new Error('编程 Subagent 服务已关闭')
    }
    const { task } = directModelSubagentInputSchema.parse({
      task: input.task
    })

    const childRunId = randomUUID()
    const context: DirectModelSubagentContext = {
      parentRequestId: input.parent.requestId,
      childRunId,
      ...(input.parent.projectId
        ? { projectId: input.parent.projectId }
        : {}),
      conversationId:
        `direct-model-subagent:${input.parent.requestId}:${childRunId}`,
      workMode: input.parent.workMode
    }
    const controller = new AbortController()
    let settleOwnerRun!: () => void
    const ownerRun: OwnerRun = {
      controller,
      settled: new Promise<void>((resolve) => {
        settleOwnerRun = resolve
      })
    }
    this.addOwnerRun(input.ownerId, ownerRun)
    const forwardParentAbort = (): void => {
      controller.abort(input.signal.reason)
    }
    if (input.signal.aborted) {
      forwardParentAbort()
    } else {
      input.signal.addEventListener('abort', forwardParentAbort, {
        once: true
      })
    }

    try {
      return await this.execute(input, task, context, controller.signal)
    } finally {
      input.signal.removeEventListener('abort', forwardParentAbort)
      this.removeOwnerRun(input.ownerId, ownerRun)
      settleOwnerRun()
    }
  }

  async releaseOwner(
    ownerId: string,
    reason = '编程 Subagent 所属会话已释放'
  ): Promise<void> {
    const runs = [...(this.ownerRuns.get(ownerId) ?? [])]
    if (runs.length === 0) {
      return
    }
    for (const run of runs) {
      run.controller.abort(new Error(reason))
    }
    await Promise.allSettled(runs.map((run) => run.settled))
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return
    }
    this.disposed = true
    await Promise.allSettled(
      [...this.ownerRuns.keys()].map((ownerId) =>
        this.releaseOwner(ownerId, '编程 Subagent 服务已关闭')
      )
    )
  }

  private async execute(
    input: DirectModelSubagentRunInput<TRequestContext>,
    task: string,
    context: DirectModelSubagentContext,
    signal: AbortSignal
  ): Promise<DirectModelSubagentResult> {
    let output = ''
    let outputBytes = 0
    let outputTruncated = false
    let inputTokens = 0
    let outputTokens = 0
    let usageReported = false
    let started = false
    let workOutcome: MutableOutcome | undefined
    let schedulerError: unknown
    let released = false
    let releaseError: unknown
    let finishWork!: () => void
    const workFinished = new Promise<void>((resolve) => {
      finishWork = resolve
    })

    const emit = (
      state: DirectModelSubagentState,
      outcome?: MutableOutcome
    ): void => {
      input.onEvent({
        parentRequestId: context.parentRequestId,
        childRunId: context.childRunId,
        conversationId: context.conversationId,
        workMode: context.workMode,
        state,
        reason: task.slice(0, 240),
        ...((state === 'completed' ||
          state === 'failed' ||
          state === 'cancelled')
          ? {
              output,
              outputTruncated,
              ...(outcome?.error
                ? {
                    error: outcome.error,
                    errorTruncated: outcome.errorTruncated
                  }
                : {})
            }
          : {})
      })
    }

    const release = async (): Promise<void> => {
      if (released) {
        return
      }
      released = true
      try {
        await this.dependencies.releaseConversation(
          context.conversationId,
          context
        )
      } catch (error) {
        releaseError = error
      }
    }

    emit('queued')
    try {
      const scheduled = this.dependencies.scheduler.schedule(
        async (scheduledSignal) => {
          started = true
          emit('running')
          try {
            await this.dependencies.runChild({
              task,
              context,
              requestContext: input.parent.requestContext,
              signal: scheduledSignal,
              onOutput: (delta) => {
                if (typeof delta !== 'string') {
                  throw new TypeError(
                    '编程 Subagent 输出必须是字符串'
                  )
                }
                if (outputTruncated) {
                  return
                }
                const remaining =
                  DIRECT_MODEL_SUBAGENT_OUTPUT_MAX_BYTES -
                  outputBytes
                const bounded = truncateUtf8(delta, remaining)
                output += bounded.value
                outputBytes += Buffer.byteLength(bounded.value)
                outputTruncated = bounded.truncated
              },
              onModelUsage: (usage) => {
                usageReported = true
                inputTokens = addTokenCount(
                  inputTokens,
                  usage.inputTokens
                )
                outputTokens = addTokenCount(
                  outputTokens,
                  usage.outputTokens
                )
                input.onModelUsage?.({
                  parentRequestId: context.parentRequestId,
                  childRunId: context.childRunId,
                  conversationId: context.conversationId,
                  usage
                })
              }
            })
            if (scheduledSignal.aborted) {
              const detail = errorDetail(scheduledSignal.reason)
              workOutcome = {
                status: 'cancelled',
                ...detail
              }
            } else {
              workOutcome = { status: 'completed' }
            }
          } catch (error) {
            const cancelled = scheduledSignal.aborted || signal.aborted
            workOutcome = {
              status: cancelled ? 'cancelled' : 'failed',
              ...errorDetail(
                cancelled
                  ? scheduledSignal.reason ?? signal.reason ?? error
                  : error
              )
            }
          } finally {
            await release()
            if (releaseError && workOutcome?.status === 'completed') {
              workOutcome = {
                status: 'failed',
                ...errorDetail(releaseError)
              }
            }
            finishWork()
          }
          return workOutcome!
        },
        signal
      )
      try {
        workOutcome = await scheduled
      } catch (error) {
        schedulerError = error
      }
    } catch (error) {
      schedulerError = error
    }

    if (started) {
      await workFinished
    } else {
      await release()
    }

    const outcome =
      workOutcome ??
      {
        status: signal.aborted ? 'cancelled' : 'failed',
        ...errorDetail(
          signal.aborted
            ? signal.reason ?? schedulerError
            : schedulerError ?? releaseError
        )
      }
    if (releaseError && !outcome.error) {
      Object.assign(outcome, errorDetail(releaseError))
      outcome.status = 'failed'
    }

    emit(outcome.status, outcome)
    return {
      status: outcome.status,
      childRunId: context.childRunId,
      conversationId: context.conversationId,
      output,
      outputTruncated,
      ...(outcome.error
        ? {
            error: outcome.error,
            errorTruncated: outcome.errorTruncated
          }
        : {}),
      ...(usageReported
        ? {
            modelUsage: {
              inputTokens,
              outputTokens
            }
          }
        : {})
    }
  }

  private addOwnerRun(ownerId: string, run: OwnerRun): void {
    const runs = this.ownerRuns.get(ownerId) ?? new Set<OwnerRun>()
    runs.add(run)
    this.ownerRuns.set(ownerId, runs)
  }

  private removeOwnerRun(ownerId: string, run: OwnerRun): void {
    const runs = this.ownerRuns.get(ownerId)
    if (!runs) {
      return
    }
    runs.delete(run)
    if (runs.size === 0) {
      this.ownerRuns.delete(ownerId)
    }
  }
}
