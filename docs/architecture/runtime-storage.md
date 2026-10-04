# Runtime Storage And Background Reads

SQLite owns persisted task, event and conversation evidence. The desktop business
connection is long-lived. WAL permits readers alongside a writer; synchronous SQL
still blocks the thread that executes it. Memory caches are disposable derived data.

Startup storage upgrades run in `assistant-storage-worker` before the business
connection opens. Runtime readers must not invoke initialization, migrations or
recovery. `SubagentProgressStorage` caches event encoding state, not task statistics.

## Runtime Read Design

Execution duration is persisted on running-state transitions in Main. Snapshots
read small indexed timing rows; they require no historical evidence query, worker
or result cache. Main owns current segments independently of renderer visibility.
The [duration design](../features/task-and-job/technical-design.md) defines the
state boundaries, restart handling and incomplete history.

Read transactions end before replies are posted. Long-lived read transactions
would prevent WAL checkpoints from reclaiming old pages. Each reader has its own
SQLite page cache; adding workers increases memory usage and requires evidence of
parallel query demand. New consumers should reuse the same lifecycle and read-only
rules, without introducing a general query protocol before a second use case exists.

## Renderer Scheduling

Hidden task panels use React `Activity` to preserve state while scheduling hidden
render work below visible updates. Panel factories run inside that boundary.
Terminal and browser panels retain their existing mounted effects and sessions.
Duration snapshots refresh on Main change notifications while the task center is
open. The renderer ticks locally for open segments and fetches fresh snapshots on
reopening. Results remain scoped; superseded responses are discarded.

The [task statistics design](../features/task-and-job/technical-design.md) owns the
snapshot contract and timing rules. Tests and timings demonstrate only their fixture
conditions; they do not establish a latency guarantee for arbitrary retained history.
