# Execution Statistics Query

## Contract

`window.goodbuddy.tasks.getExecutionStats(input)` invokes `tasks:execution-stats`.
`ExecutionStatsInput` accepts exactly one UUID scope: `{ conversationId }` or
`{ projectId }`. Main validates the scope and trusted sender. The database returns:

```ts
interface ExecutionStats {
  durationMs: number
  requestCount: number
  incompleteRequestCount: number
  activeRequestCount: number
  asOf: number // epoch milliseconds at query time
  taskDurations: Array<{
    id: string
    durationMs: number
    incompleteRequestCount: number
  }>
}
```

The project scope sums request evidence across its conversations and returns card
totals in `taskDurations`. A scheduled execution uses `requestId = schedule_runs.id`;
join its `schedule_id` to the stable task's `schedule_id` to aggregate repeated runs.
Request creation also saves that proven relation in `parent_task_id`. Before plan
deletion cascades its run records, bind older requests that still lack this link.
Statistics can then use the retained link to a visible `origin = schedule` parent,
even after the parent's `schedule_id` has been cleared. A shared conversation alone
does not establish ownership. Other
identified requests retain their own task ID. Visible tasks with no executions
have a zero entry. Conversation queries return an empty `taskDurations` array.
Message counts used to detect missing history stay in Main; no bodies are returned.

## Evidence And Boundaries

- Query all retained scoped task records, including hidden chat requests, without
  the visible-task list's pagination. Require a persisted message `request_id`
  link, a reply event (`text`, `reasoning`, `tool`, `done`, `error`, `subagent`,
  `generated-image`, or `question`) associated by `task_events.task_id`, a schedule
  run association, or a current reply lease. Local message snapshots do not persist
  request links, so local replies normally use event membership and kind. Do not
  parse each stream/tool payload merely to repeat its owning request ID.
- Runtime status events also prove a reply when `requestId` matches the owning
  task, `type` is `status`, and `message` is a string. Maintenance status events
  such as `{ status: 'running' }` do not. Status-only interrupted replies retain
  their last evidenced interval just like text/tool replies.
- Exclude stable schedule parents (`schedule_id` is set) and expert tasks
  (`origin = subagent`). Scheduled reply requests remain eligible. Nested expert
  execution is already inside the parent's elapsed interval and is not added again.
- Maintenance-only records do not establish reply identity. This excludes manual
  context compression, heartbeat summaries, and unexecuted suggestions. A record
  with no reply identity evidence cannot be classified; it is not counted.
- Sum intervals from `started_at` or later `running` status events to terminal
  events/statuses. Pause/queue closes an interval; a later run starts another.
  Repeated approval/running transitions do not reset the start. Tools and approval
  waits inside a reply are included; idle gaps between replies/runs are excluded.
- `interrupted` may be written at application restart. Count only through the
  preceding evidence, mark the request incomplete, and never use its recovery
  `completed_at` as an execution endpoint. Missing or invalid timing also marks
  the request incomplete; unknown time is not replaced with zero-length certainty.
- A non-aborted reply lease confirms current execution: an open local interval
  with a reliable start contributes through `asOf` and is not marked incomplete
  just because it is active. Manual context compression leases are excluded.
  Without a live lease, stop at the latest evidence and mark an open interval
  incomplete. Renderer must requery rather than extrapolate beyond `asOf`.
- Remote-recoverable records, tasks in persisted SSH project execution spaces,
  and events with remote operation provenance are
  incomplete and contribute no duration: their receipt timestamps cannot establish
  remote execution intervals, particularly after replay. No Runtime, Agent, or
  remote persistence behavior changes are required by this read-only query.
  The SSH project check applies before the first provenance event, including
  channel/delegation requests with `remote_recoverable = false`, so an unknown
  remote duration is not first reported as complete local execution time.
- Completed, failed, or running schedule runs with no request history count as
  incomplete, including in their stable task card. Pending runs do not count.
- Former schedule parents are never execution clocks, including after deletion.
  A removed plan without retained execution ownership is reported as incomplete,
  not a complete zero; its former lifetime cannot reconstruct missing runs.
- Retained top-level assistant messages establish missing-history evidence.
  Explicit missing request links count as incomplete; unlinked snapshots use a
  count comparison within each conversation/task, after covering linked replies.
  Missing schedule runs already counted above cover their messages, avoiding a
  second missing count. Expert-task messages and nested subagent content are not
  counted again. A wholly missing reply contributes zero known duration and one
  incomplete request, not a complete zero.
- Exclude the first local assistant message only when it has no request/task link
  and exactly matches a shipped Chinese/English default greeting. Persisted
  greetings have no separate marker. Other assistant-only history and identical
  text later in the conversation remain eligible; do not discard all messages
  before the first user turn.
- These counts are a lower bound when local snapshots have no request links;
  fully deleted history cannot be reconstructed. `requestCount` includes replies
  inferred from missing-history evidence. Concurrent top-level requests may
  overlap in wall-clock time; their durations are summed independently.

The query materializes scoped task evidence once, then returns only status and
terminal events. Only status payloads use JSON extraction. Request membership and
remote provenance inspect scalar event columns; last-event and pre-interruption
timestamps use `(task_id, id)` index seeks. This preserves a tool/delta event as
the last reliable boundary without loading its body. Grouped assistant-message
counts still read task metadata from message rows rather than from every event.
It adds no tables, columns, migration, or persisted timing totals. Stable task
lifecycle timestamps are never duration endpoints.

## Validation Coverage

The focused execution-statistics tests cover hidden requests, scope isolation,
approval waits, repeated intervals, restart interruption, remote replay, missing
start times, and history beyond visible-task pagination. IPC tests cover sender
and scope validation; preload tests cover typed forwarding. Renderer integration
must supply `getExecutionStats` in its `DesktopApi.tasks` mocks.

The large-payload regression inspects the production query plan, measures paired
conversation/project polling on 3,000 events with approximately 94 MiB of payload,
and replaces stream/tool bodies with invalid JSON to prove they are not parsed.
Run it with `npx vitest run src/main/assistant/assistant-execution-stats.test.ts -t seeks --reporter=verbose --disableConsoleIntercept`
to print timings. These are synthetic warm-query measurements, not a guarantee
for arbitrarily large histories. Scalar event filtering and per-message metadata
work still grow with retained history; if that becomes measurable in deployment,
prefer polling only during active execution and refreshing on history/task changes.

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
to retry creation. No schema migration or preload changes are required.

`schedule-creation.test.ts` verifies transaction rollback and timer non-duplication
with real SQLite. IPC tests exercise that database through the production queue
and ordinary run handler with a controlled runtime, including failed execution.
App creation tests cover destination selection, time validation, and failure handling.
