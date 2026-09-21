# Runtime Storage And Background Reads

SQLite owns persisted task, event and conversation evidence. The desktop business
connection is long-lived. WAL permits readers alongside a writer; synchronous SQL
still blocks the thread that executes it. Memory caches are disposable derived data.

Startup storage upgrades run in `assistant-storage-worker` before the business
connection opens. Runtime readers must not invoke initialization, migrations or
recovery. `SubagentProgressStorage` caches event encoding state, not task statistics.

## Runtime Read Design

Execution statistics use one lazily started worker with a read-only connection.
The worker performs the existing evidence query inside a short read transaction.
Main supplies the current reply lease IDs and receives only scalar summaries.
There is no worker pool or duplicate persisted summary. The worker is terminated
when its owning database closes; errors reject reads, without a synchronous Main
fallback. In-memory test databases use the synchronous query because independent
connections cannot access the same private in-memory database.

Derived caches must specify scope, capacity, lifetime and invalidation. Statistics
keep at most eight scopes for 30 seconds. SQLite `data_version` detects other
connections' commits; `total_changes()` detects writes on the owning connection.
Reads inside an existing transaction clear and bypass the cache, so rolled-back
values cannot escape. Closing the connection clears its cache. Live leases bypass
the cache because elapsed time changes without a database write.

Read transactions end before replies are posted. Long-lived read transactions
would prevent WAL checkpoints from reclaiming old pages. Each reader has its own
SQLite page cache; adding workers increases memory usage and requires evidence of
parallel query demand. New consumers should reuse the same lifecycle and read-only
rules, without introducing a general query protocol before a second use case exists.

## Renderer Scheduling

Hidden task panels use React `Activity` to preserve state while scheduling hidden
render work below visible updates. Panel factories run inside that boundary.
Terminal and browser panels retain their existing mounted effects and sessions.
Statistics refresh only when the task center and document are visible. Results
must remain scoped and late responses from a previous selection must be discarded.

The [task statistics design](../features/task-and-job/technical-design.md) owns the
query contract and evidence rules. Tests and timings demonstrate only their fixture
conditions; they do not establish a latency guarantee for arbitrary retained history.
