import { randomUUID } from 'node:crypto'
import {
  heartbeatCreateSchema,
  heartbeatHistorySchema,
  heartbeatIdSchema,
  heartbeatListSchema,
  heartbeatPauseSchema,
  heartbeatRunNowSchema,
  heartbeatUpdateRequestSchema,
  type AssistantHeartbeatConfig,
  type AssistantHeartbeatEntry,
  type AssistantHeartbeatRun
} from '../../shared/assistant-contracts'
import {
  AssistantDatabase,
  type ClaimedHeartbeatRun
} from './assistant-database'

export type HeartbeatHistory = {
  runs: AssistantHeartbeatRun[]
  entries: AssistantHeartbeatEntry[]
}

/** Result of the shared incremental review triggered by one heartbeat. */
export type HeartbeatReviewOutcome = {
  status: 'completed' | 'no_change' | 'paused' | 'cancelled'
  /** Supervision run that produced the published result, if any. */
  runId?: string
}

export type HeartbeatTrigger = {
  config: AssistantHeartbeatConfig
  run: AssistantHeartbeatRun
}

/**
 * The heartbeat no longer reads sources or writes a report of its own. It
 * triggers the shared incremental supervisor review; the plan's intervention
 * then works only from what that review published.
 */
export interface HeartbeatActions {
  review(trigger: HeartbeatTrigger): Promise<HeartbeatReviewOutcome>
  suggest?(trigger: HeartbeatTrigger & { supervisionRunId: string }): Promise<number>
}

// A trigger only holds its lease while it hands work to the supervisor.
const triggerLeaseMilliseconds = 5 * 60_000

export class HeartbeatService {
  private readonly workerId = `heartbeat:${randomUUID()}`
  private readonly pendingManualRuns = new Map<string, Promise<AssistantHeartbeatRun>>()

  constructor(
    private readonly database: AssistantDatabase,
    private readonly actions: HeartbeatActions
  ) {}

  list(input: unknown = {}): AssistantHeartbeatConfig[] {
    const parsed = heartbeatListSchema.parse(input)
    return this.database.listHeartbeatConfigs(parsed.projectId)
  }

  create(input: unknown, now = new Date()): AssistantHeartbeatConfig {
    const parsed = heartbeatCreateSchema.parse(input)
    return this.database.createHeartbeatConfig(parsed, now)
  }

  update(input: unknown, now = new Date()): AssistantHeartbeatConfig {
    const parsed = heartbeatUpdateRequestSchema.parse(input)
    return this.database.updateHeartbeatConfig(parsed.id, parsed.config, now)
  }

  pause(input: unknown): void {
    const parsed = heartbeatPauseSchema.parse(input)
    this.database.setHeartbeatPaused(parsed.id, parsed.paused)
  }

  remove(input: unknown): void {
    const parsed = heartbeatIdSchema.parse(input)
    this.database.removeHeartbeatConfig(parsed.id)
  }

  history(input: unknown = {}): HeartbeatHistory {
    const parsed = heartbeatHistorySchema.parse(input)
    return {
      runs: this.database.listHeartbeatRuns(parsed.configId, parsed.limit),
      entries: this.database.listHeartbeatEntries(parsed.configId, parsed.limit)
    }
  }

  async runNow(input: unknown, now?: Date): Promise<AssistantHeartbeatRun> {
    const parsed = heartbeatRunNowSchema.parse(input)
    const pending = this.pendingManualRuns.get(parsed.id)
    if (pending) return pending
    const operation = (async () => {
      const startedAt = now ?? new Date()
      const claim = this.database.claimHeartbeatNow(
        parsed.id, parsed.idempotencyKey, this.workerId, startedAt, triggerLeaseMilliseconds
      )
      if (!claim.acquired) return claim.run
      return this.executeClaim(claim, now)
    })()
    this.pendingManualRuns.set(parsed.id, operation)
    try {
      return await operation
    } finally {
      this.pendingManualRuns.delete(parsed.id)
    }
  }

  async processDue(now?: Date): Promise<AssistantHeartbeatRun[]> {
    // The database claims at most one due heartbeat per tick; repeated missed
    // times collapse into that one check.
    const claims = this.database.claimDueHeartbeats(this.workerId, now ?? new Date(), triggerLeaseMilliseconds)
    const results: AssistantHeartbeatRun[] = []
    for (const claim of claims) results.push(await this.executeClaim(claim, now))
    return results
  }

  /** Re-derive suggestions for a completed heartbeat whose intervention failed. */
  async retrySuggestions(heartbeatRunId: string): Promise<number> {
    const run = this.database.getHeartbeatRun(heartbeatRunId)
    const config = this.database.getHeartbeatConfig(run.configId)
    const supervisionRunId = this.database.supervisionRunForHeartbeat(heartbeatRunId)
    if (!supervisionRunId || !this.actions.suggest) throw new Error('此次自动监督没有可生成建议的回顾结果')
    return this.intervene({ config, run }, supervisionRunId)
  }

  private async executeClaim(claim: ClaimedHeartbeatRun, now?: Date): Promise<AssistantHeartbeatRun> {
    let run: AssistantHeartbeatRun
    try {
      run = this.database.completeHeartbeatTrigger(claim, now ?? new Date())
    } catch (error) {
      return this.database.failHeartbeatRun(claim, error instanceof Error ? error.message : 'Heartbeat failed', now ?? new Date())
    }
    const trigger = { config: claim.config, run }
    this.database.setHeartbeatProjection(run.id, 'running', claim.config.scope)
    let outcome: HeartbeatReviewOutcome
    try {
      outcome = await this.actions.review(trigger)
    } catch (error) {
      this.database.setHeartbeatProjection(run.id, 'failed', undefined,
        error instanceof Error ? error.message : 'Supervision failed')
      return this.database.getHeartbeatRun(run.id)
    }
    if (outcome.status === 'no_change') this.database.markHeartbeatNoChange(run.id, claim.config.id)
    this.database.setHeartbeatProjection(run.id, 'completed')
    if (outcome.status === 'completed' && outcome.runId && (claim.config.intervention ?? 'suggest') === 'suggest' && this.actions.suggest) {
      await this.intervene(trigger, outcome.runId).catch(() => undefined)
    }
    return this.database.getHeartbeatRun(run.id)
  }

  private async intervene(trigger: HeartbeatTrigger, supervisionRunId: string): Promise<number> {
    this.database.setHeartbeatSuggestionStatus(trigger.run.id, 'running')
    try {
      const count = await this.actions.suggest!({ ...trigger, supervisionRunId })
      this.database.setHeartbeatSuggestionStatus(trigger.run.id, count ? 'completed' : 'skipped')
      return count
    } catch (error) {
      // The published graph and incremental progress stay committed.
      this.database.setHeartbeatSuggestionStatus(trigger.run.id, 'failed',
        error instanceof Error ? error.message : 'Suggestion failed')
      throw error
    }
  }
}
