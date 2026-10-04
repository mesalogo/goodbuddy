# Execution Timing and Summary I/O

## Decision

Duration means time spent in the running state, including model and tool work.
It is not a reconstruction of historical execution evidence. Main starts a
clock for a reply lease, pauses it when the task stops running, and closes it
when the lease ends. Maintenance requests and nested subagents do not open
another top-level clock. The renderer advances the displayed value locally.

Waiting for an answer or approval does not accrue time. Multiple pending
questions resume the clock only after the last one resolves. Recovered waiting
requests remain paused during reconnection. Startup preserves closed intervals,
discards unclosed intervals, and marks them incomplete; old history is not
backfilled by scanning messages or events.

Schema 59 stores timing rows and adds a covering index for conversation
summaries. The old historical aggregation, its caches, dedicated reader/worker,
worker build entries, and five-second statistics polling have been removed.
The preliminary materialized-CTE fix is superseded by this replacement.

## Summary Reads

Summary-only requests now read counts, first role, and latest message time from
`messages_summary_idx`, without loading message bodies or metadata. Full
histories require explicit detail IDs. IPC still includes recovered requests
whose pending questions must be restored. The renderer's existing retained
history requests and refresh/settlement rules are preserved.

## Measurement

Windows logical process I/O counters, not physical disk throughput. Measurements
used an isolated copy of `dist/GoodBuddy-windows-x64/data`; the source database
was not opened. Its largest message metadata was 4,283,685 characters. A large
message was marked streaming in the copy to exercise the former implicit-detail
path. Initialization, migration, and fixture preparation are outside samples.

| Operation | Before | After |
| --- | --- | --- |
| Project duration | One read: 1,224 MiB read, 740 MiB written, 2.7-4 s | Twenty reads: about 8 KiB read, no measured writes, about 1 ms total |
| Pure conversation summaries | One read: about 423 MiB, about 0.4 s | One read: 0.535 MiB, no measured writes, 9 ms |

These compare the old historical statistic with the intentionally simpler
state-based statistic. They do not establish that all live application I/O
comes from these paths. Requested full histories still incur their normal cost.
The installed running application was not replaced during this work.

Reproduce on Windows with a quiescent source data directory:

```powershell
$env:GB_WPERF_DATA = 'D:\my_git\goodbuddy\dist\GoodBuddy-windows-x64\data'
node build/run-write-io-perf.cjs
```

The script copies the database, upgrades the copy, probes production methods,
checks retained message contents, and deletes the temporary copy.

## Verification

- State-transition, interruption, recovery, question, and notification tests.
- Covering-query-plan and explicit full-history regression tests.
- Assistant database: 120 tests passed.
- Reader, persistence, timing hook, and preload: 22 tests passed.
- Focused App duration/focus/refresh/summary tests: 44 passed.
- Full App: 350 passed, 3 failed in project creation workflows (discard dialog,
  create invocation, and create-error display). These remain unresolved.
- Production bundle passed; removed worker is absent from its entry points.
