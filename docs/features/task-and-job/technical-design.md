# Execution Duration

## Running State

Main owns reply timing independently of the visible conversation or task panel.
Acquiring a reply lease starts a segment after the request task has been created.
Manual context compression uses a maintenance lease and creates no clock. Nested
subagents and stable schedule parents are excluded; their work is already inside
the top-level reply interval. Background and channel requests use the same lease.

Task transitions away from `running` close the segment, including `paused`,
`queued`, `waiting_approval`, completion, failure and cancellation. Resuming a
leased request opens another segment. Repeated `running` notifications leave the
original segment intact. Abort closes timing immediately, even when runtime
cleanup is still pending. Releasing a lease prevents subsequent task updates from
restarting its clock. Concurrent replies contribute their durations independently.

Remote requests measure Main's observed running state. The existing committed
terminal checkpoint closes their timing; event persistence, replay deduplication
and Agent ACK order are unchanged. Disconnection/recovery gaps are incomplete.
This duration does not claim to measure autonomous execution while the desktop
is disconnected. Application exit closes observed detached remote intervals
without cancelling the remote operation and marks the remaining duration unknown.

## Storage

Schema 59 adds `execution_timing`: one row per timed request with its project,
conversation, task-card owner, accumulated milliseconds, optional running start,
and incomplete flag. Scope indexes keep snapshots separate from large task and
message payloads. A schedule run copies the stable task association already
stored in `parent_task_id`; repeated runs aggregate under that card. Task deletion
cascades to its timing row.

Only state transitions write timing. Tokens, tools, display ticks and snapshot
reads do not update it. Startup drops any unclosed segment and marks it incomplete,
retaining previously accumulated time. It never counts application downtime or
uses recovery timestamps as execution endpoints.

Migration marks existing conversations and visible task cards incomplete without
reconstructing their past duration. Imported legacy conversation snapshots are
also incomplete. No timing query reads historical messages, tools or task events.
The same migration adds
`messages_summary_idx ON messages(conversation_id, sequence, role, created_at)`
for conversation summaries. It performs no history conversion or `VACUUM`.

## Contract

`window.goodbuddy.tasks.getExecutionStats(input)` invokes `tasks:execution-stats`.
Input accepts exactly one UUID scope: `{ conversationId }` or `{ projectId }`.
Main validates the scope and trusted sender, then reads the small timing rows
synchronously. The old evidence query, cache, reader and statistics worker are
removed.

```ts
interface ExecutionStats {
  durationMs: number // closed segments plus open segments through asOf
  runningCount: number // open segments in this scope
  incomplete: boolean
  asOf: number // Main epoch milliseconds
  taskDurations: Array<{
    id: string
    durationMs: number
    runningCount: number
    incomplete: boolean
  }>
}
```

Conversation snapshots have an empty `taskDurations` array. Historical request
counts are no longer part of this API.

`onExecutionStatsChanged(listener)` returns an unsubscribe function. Main sends
`tasks:execution-stats-changed` after timing transitions or history deletion;
synchronous changes are coalesced into one notification. The renderer subscribes
before fetching its current conversation and project snapshots and refreshes on
notifications. It discards superseded responses and clears failed scopes.

The UI adds `max(0, now - asOf) * runningCount` locally once per second while an
open segment exists, including the corresponding per-card calculation. Hidden
panels unsubscribe and fetch fresh snapshots when reopened. There is no five-second
statistics polling, message-count revision trigger, or tick-time IPC. Main timing
continues while the panel is hidden or another conversation is selected.

## Validation

`assistant-execution-stats.test.ts` exercises real SQLite state transitions,
restart interruption, remote checkpoints/replay, schedule ownership, scope
isolation, deletion, schema migration and read-only snapshots. It verifies that
snapshot SQL never reads messages or task events. IPC tests cover trusted scope
validation and production lease completion, failure and abort; preload tests cover
the subscription bridge. Hook tests verify local ticking without polling, hidden
panels, stale responses, and failed reads.

## Custom Task Creation

The dialog defaults to the current conversation and immediate execution. Content
is required; an empty name uses the first 120 characters of whitespace-normalized
content. App supplies other local conversations in the current project and also
allows creating a new conversation. Scheduled creation retains once/daily/weekly
recurrence and requires a future timestamp, checked by both App and Main IPC.

`ScheduleCreateInput.runImmediately` is an optional creation command, not a stored
schedule field. It is valid only for `recurrence: 'once'`. `createSchedule` creates
the conversation (if needed), task, disabled schedule, pending schedule run and
conversation queue item in one SQLite transaction. Queue insertion failure rolls
back all of them. Disabling automatic scheduling prevents timer ticks from adding
another occurrence; pending/running queue state still determines task status.

The create IPC handler publishes the queue change and wakes the existing
conversation queue pump. App does not follow creation with `runNow`. Execution
uses the existing readiness and conversation serialization rules. A runtime
failure belongs to the created task; it does not reject creation or create another
task. Refresh failures after a successful creation are notifications, not a reason
to retry creation. No schema migration or preload changes are required for this
creation command.

`schedule-creation.test.ts` verifies transaction rollback and timer non-duplication
with real SQLite. IPC tests exercise that database through the production queue
and ordinary run handler with a controlled runtime, including failed execution.
App creation tests cover destination selection, time validation, and failure handling.
