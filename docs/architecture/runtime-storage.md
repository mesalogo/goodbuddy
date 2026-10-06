# Runtime Storage And Background Reads

## Current Implementation

This file records current runtime timing, reader behavior and temporary-resource
ownership. The production runtime receives the storage-owned output backing store and
output adoption function during Main startup. Main also computes one per-version,
per-run temporary root and passes it to the local runtime cache paths and native
client coordinator.

SQLite owns persisted task, event and conversation evidence. The desktop business
connection is long-lived. WAL permits readers alongside a writer; synchronous SQL
still blocks the thread that executes it. Memory caches are disposable derived data.
Persisted evidence is not necessarily full tool output; the inventory below records
the current distinction. The target ownership rules are in the architecture document.

Startup storage upgrades run in `assistant-storage-worker` before the business
connection opens. Runtime readers must not invoke initialization, migrations or
recovery. `SubagentProgressStorage` caches event encoding state, not task statistics.

## Runtime Read Design

Execution duration is persisted on running-state transitions in Main. Snapshots
read small indexed timing rows; they require no historical evidence query, worker
or result cache. Main owns current segments independently of renderer visibility.
The [duration design](../features/task-and-job/technical-design.md) defines the
state boundaries, restart handling and incomplete history.

## Planned Architecture

The [complete desktop architecture](./desktop-storage-direction.md) defines the
remaining target, including desktop binding databases and native-client model ledgers.
Its migration and [concurrent acceptance](../quality/concurrent-desktop-acceptance.md)
are one delivery; remote Agent database ownership remains unchanged. Main will still
observe runtime transitions while the storage service persists them in order; the
indexed timing representation and semantics remain.

## Runtime Read Lifecycle

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

## Output And Temporary File Investigation

Source review on 2026-10-05. The inventory records the current production flow. No
user Temp directory was scanned or deleted.

| Producer | Current content flow | Retention and consequence |
| --- | --- | --- |
| Local process and ripgrep | [Process capture](../../src/main/agent/direct-model-process-service.ts) writes stdout/stderr through [PagedOutputStore](../../src/main/agent/paged-output-store.ts); model receives a JSON-bounded preview, up to 96 KiB per stream, and a reference when truncated | Every stream opens a file, including empty stderr. Small files are deleted on finish; retained files and their in-memory handles belong to the conversation/service |
| Direct-model subagent | [Subagent service](../../src/main/assistant/direct-model-subagent-service.ts) captures child text through the same store, returning up to 192 KiB and an optional reference | [Provider event bridge](../../src/main/agent/model-tool-provider.ts) forwards preview/status but drops the output reference from the subagent event; child text is not an independent full parent-history record |
| Tool events and conversation history | [Model runtime](../../src/main/agent/model-runtime.ts) emits at most 16,000 characters of serialized tool result as the event preview; [IPC](../../src/main/ipc.ts) and [database](../../src/main/assistant/assistant-database.ts) persist the supplied event | Tool events still carry bounded previews, while output history adopts finished handles through attachment storage. Even `output_read` responses are previewed in tool events. Persisted event history does not by itself guarantee a complete stdout/stderr copy |
| Remote ACP | [Agent transcript](../../src/agent-daemon/semantic-prompt-store.ts) retains received notifications pending ACK; [desktop adapter](../../src/main/agent/acp-remote-runtime.ts) bounds mapped events before persistence | ACK prunes Agent transcript rows. Notifications themselves may already be bounded by the Runtime. Do not treat this journal as a permanent full-output source or remove commit-before-ACK |
| MCP calls | [MCP transport](../../src/main/capabilities/mcp-client-transport.ts), provider and [gateway](../../src/main/agent/knowledge-mcp-gateway.ts) pass objects through stdio/HTTP/SSE | No per-call request/response scratch-file creation was found in these paths. Calling a tool over MCP does not itself require a payload file; third-party server internals are outside this inventory |

`PagedOutputStore` keeps short and empty output in memory and delegates larger
or JSON-preview-truncated content to an injected `PagedOutputBackingStore`. Capture
has a shared 8 MiB budget, at most 1,024 pending chunks per writer and 4,096 active or
retained handles per store; backing writes are at most 64 KiB. Producers must await
append, or receive an explicit capacity error. Local process pipes pause until each
append settles. The store does not create a temporary file backend or another DB.
UTF-8 byte cursors, JSON-escaped preview bounds, owner checks and failed/cancelled
output remain covered by focused tests using real async files and local children.

The production owner exposes output create, append, finish, read, adopt and release
through the existing storage transport. Main passes its `backingStore` to the runtime
and passes `outputAdopt` to the tool provider. When output history is enabled, finished
stdout/stderr references are adopted into the conversation attachment reference for
the target message; the bounded preview and output reference are returned together.
Missing backing configuration still explicitly fails capture that requires full
storage. A model's final answer is not an equivalent copy of its tool output.

### Planned Architecture And Remaining Acceptance

The planned architecture still requires full end-to-end history and restart coverage,
resource reconciliation and the remaining storage-owner migration. The file-backed
test fixture alone does not establish that architecture or its acceptance.

Tool previews can also appear in both conversation `tools` and `blocks`. This is a
separate persisted-preview duplication issue, not evidence that full paged output is
already stored. Existing [subagent progress compaction](../../src/main/assistant/subagent-progress-storage.ts)
already handles repeated progress snapshots; retain that implementation.

### Other Owned Files

| Existing owner | Source finding | Disposition for the upgrade |
| --- | --- | --- |
| [DocumentResultStorage](../../src/main/document-result-storage.ts) and [attachment storage](../../src/main/conversation-attachment-storage.ts) | `parsed.md` duplicates `manifest.json.content`; normal reads use the manifest and `copyResult` copies the extra file | Remove the redundant new write/copy. Preserve original files, extracted images, manifests and ownership transfer; old directories follow existing reference cleanup |
| [OpenCode runtime](../../src/main/agent/opencode-runtime.ts) | Configuration already uses `OPENCODE_CONFIG_CONTENT`; scratch supplies isolated XDG state and skill registration | Keep required isolation, reuse immutable skill caches. Do not invent a config-file optimization for a path already using memory/environment |
| [Continue adapter](../../src/main/agent/continue-host-adapter.ts) | CLI uses `--config` plus an isolated global directory; creation can fail before the outer owner receives the path | Retain the external-file interface and clean partial creation at the creating function, including skill-staging failure; preserve pre-existing files on `EEXIST` |
| [Continue helper](../../src/agent-daemon/continue-acp-helper.ts) and [model bridge helper](../../src/agent-daemon/model-bridge-helper.ts) | Temporary config/plugin resources use helper finalization; setup before the protected scope and termination need lifecycle coverage | Extend existing ownership and shutdown, verify child exit before deletion. Plugin file URLs and Unix sockets remain necessary interfaces under current contracts |
| [Managed Python](../../src/main/local-tool-environment/managed-python-install.ts), [model packages](../../src/main/model-package-utils.ts), [Agent packages](../../src/main/remote-agent/agent-package-manager.ts) | Install staging, partial downloads and backups support validation/publication; existing cleanup has owner-specific patterns | Extend those cleanup functions for demonstrated leftovers; preserve active staging and verified reusable installations. No global installer sweep |
| [Magic note storage](../../src/main/magic-notes/magic-note-storage.ts) | Sibling atomic-write `.tmp` files protect replacement; memory-database fixtures have a separate temporary root | Keep atomic replacement and normal failure cleanup. Test scratch follows repository rules; persistent note directories are user data |

Document results may move from temporary ownership into attachment references, including
shared branch references. A directory under `temp/document-parsing` can still be owned
by persisted data. Its location alone does not authorize deletion. Native client history,
model caches, database WAL/SHM and exported user files are likewise not disposable scratch.

Some tests/build helpers share production-looking prefixes, including `goodbuddy-process-*`
and `goodbuddy-opencode-*`. Prefix and age alone cannot establish who owns a legacy directory.
The [architecture rules](./desktop-storage-direction.md#output-and-temporary-resource-ownership)
define the replacement and cleanup scope; the [acceptance matrix](../quality/concurrent-desktop-acceptance.md#输出与临时资源验收)
defines evidence required before claiming improvement.

### Creator Cleanup Validation (2026-10-05)

Continue now removes its partially written config and failed skill-staging directory
at the creator, before returning ownership to the run. Exclusive creation failures
leave existing files/directories intact. Run finalization preserves prepared caches
and external configuration. Both Agent helpers protect setup with finalization and
handle SIGTERM/SIGINT; Continue stops prompt admission, aborts and drains active
runs, while the OpenCode helper waits for child exit before deleting its plugin.
Managed Python's existing pre-install cleanup also removes regular download files
with the exact UUID layout, preserving directories, unknown names, caches and history.

Validation in the concurrent working tree:

- Five focused suites (`continue-host-adapter`, `continue-acp-helper`, `model-bridge`,
  `managed-python-install`, `local-tool-environment-service`): 81 passed, 10 Unix-only
  cases skipped on Windows. Failure injection covers partial creation, EEXIST,
  failed skill staging, setup-time signals and shutdown cleanup.
- Final `npm run typecheck` passed; ESLint passed for all eight owned source/test files.
  Repository lint passed with `npm run lint -- --ignore-pattern temp`; unfiltered
  lint encountered generated validation bundles in ignored task/release directories.
  Task-owned `temp/goodbuddy-scratch-upgrade` was subsequently removed and its absence
  verified; unrelated release scratch was preserved.
- Full Vitest run: 517 suites passed, 7 failed, 15 skipped; 6,244 tests passed,
  6 failed, 94 skipped. Failures outside this cleanup scope included OpenCode config
  preparation (`spawnSync npm.cmd EINVAL`), the MCPVault Electron fixture, and
  message-expansion and workspace-import Electron assertions. These results do not
  establish full architecture acceptance.
- Reused the existing `a01-runtime-host-build.cjs`/`a01-runtime-host-run.cjs` harness
  logic, rebuilding Agent, daemon and Desktop driver from current source under
  `temp/goodbuddy-scratch-upgrade`. Connected to Linux x64 over the LAN using
  GoodBuddy encrypted credentials and the pinned Host identity. Both routes were
  reachable; only the LAN route was used for execution.
- Both OpenCode and Continue passed real tool execution, startup cancellation,
  disconnect/reconnect during execution, checkpoint persistence/replay deduplication,
  and retirement. Final-source cancellation took 217 ms and 233 ms respectively;
  each run reported zero owned processes after retirement and shutdown. There were
  eight real model requests across the initial and final runs, four per runtime.
  Remote artifacts stayed in dedicated `/root/tmp/gb-lifecycle-*` directories and
  followed the harness cleanup. These timings are scenario observations, not a
  comparative performance claim.

### Version And Run Scratch Follow-up (2026-10-05)

`runtimeTemporaryRoot(userDataPath, appVersion)` computes the lazy
`temp/goodbuddy-runtime/<version>/<runId>/goodbuddy-runtime-launch` path.
Main passes that same value through existing `continueHostCacheRoot` and
`opencodeSharedCacheRoot` options. The native client coordinator receives it as
`temporaryRoot` and passes it to both native clients. The existing constructors need
no new parameter.
OpenCode creates its isolated launch directory beneath the supplied shared root;
Continue puts generated configuration and isolated globals in one per-call directory.
Prepared bundles and immutable Skill/config caches remain reusable within the run.
The helpers on a remote Host use `goodbuddy-runtime-launch` beside their existing
model-bridge socket, under that process owner's scratch directory. Global `TEMP`
is unchanged.

Each local launch has a sibling owner file containing creator and child PIDs. Keeping
metadata outside the deleted tree preserves retry evidence after partial deletion.
The launch root also records its creator for cache-only reclamation. After the
single-instance check and first screen, call `cleanupRuntimeTemporaryDirectories`
in the existing delayed background startup work. It examines at most 256 directory
entries per invocation, sequentially, and accepts the startup shutdown signal.
Service disposal still stops children before deleting its own launch material;
an unconfirmed child exit retains the material. Startup preserves live/reused PIDs,
permission-denied process checks, malformed ownership and the ambiguous spawn-to-PID
recording window. Empty version/run parents are removed after owned material.
This is not a new process owner or an installer collector.

Legacy candidates are limited to the known OS-Temp layouts `goodbuddy-opencode-*`
(desktop isolated state), `goodbuddy-continue-*` (Continue helper), and
`goodbuddy-opencode-plugin-*` (model-bridge plugin). Deletion requires valid owner
metadata and confirmed inactive creator/child PIDs. Releases that wrote no such
metadata cannot be identified as obsolete from their names, contents or age alone;
those directories are retained and reported. A bounded pass can leave candidates
unvisited. Native-client histories, existing version-only caches and unrelated
OS-Temp files are outside this reclamation contract. The old version/layout-only
cache sweep is not evidence that a surviving child has exited.

Remote environment preparation now retains its existing pending-operation record
when connection acquisition or staging cleanup fails. Because that store has one
record per Host, a replacement prepare retries cleanup before overwriting it;
confirmed cleanup or `operation-unavailable` clears it. Already adopted environments
remain usable. Agent package delayed removals retain their pending entry until
deletion succeeds, retry on inventory access, and rediscover verified obsolete
versions through the existing package scan after restart. Active archive leases
still prevent deletion.

Continue bundle staging now waits for all parallel writes to settle before failure
cleanup. Existing settings atomic replacement and selected-runtime diagnostic
teardown already use `finally`; no global `.tmp` sweep or new diagnostic owner was
added. Native clients now accept an optional `temporaryRoot` for the same application
version/run launch root. `NativeTerminalClient` keeps histories and reusable caches
under its existing `rootDirectory`; only per-launch material moves to scratch.
DS Web keeps `DSH_HOME`, sessions and user preferences in place and supplies its
generated configuration through `web --patch <scratch-file>`. Its ledger also lives
in scratch. Both reuse the existing sibling PID metadata and await ledger close
before releasing material; unconfirmed child exit retains it. ConPTY registration
waits for the actual child PID, which can be unavailable immediately after spawn.
The collector recognizes `goodbuddy-native-dsh-*` alongside the existing prefixes.
The production wiring propagates `temporaryRoot` through the native coordinator to
both constructors without relocating the retained-history root.
Focused verification passed 60 tests, including a real Windows PTY, official DS Web
session persistence across restart, and delayed ledger-close cleanup. Typechecking
and scoped lint passed; this native follow-up made zero real model calls.

Final-source verification for this follow-up is separate from the earlier eight
real requests above: two real provider requests total, one per runtime. Current-source
Continue/OpenCode helpers ran on Linux x64 over pinned SSH, each executed its native
command tool, returned the real model answer, and removed launch files after exit.
A separate active-request shutdown probe passed for both helpers with zero real
provider requests. Four successful scenarios used deterministic command responses;
probe setup retries before these results did not reach a provider. A previous-process
version/run directory was reclaimed using actual dead PIDs. After the final
enumeration-error guard, a separate Host probe confirmed that the current collector
retains a real live child and reclaims that same run after its exit, with zero model
requests. The timed-out probe's ledger was audited and contained zero calls; all
task probe artifacts were removed locally and remotely. These probes cover the
changed helper and scratch lifecycle, not full Desktop UI or installation acceptance.

The seven primary suites passed 267 tests with 10 platform skips; related runtime,
native-terminal and diagnostic-owner suites also passed. Agent and web typechecks
passed. Full desktop typecheck and repository lint remain blocked by concurrent
`portable-storage-upgrade-fixture.ts` typing and `portable-storage-upgrade.mjs` lint
errors; unfiltered lint also visits generated files under `temp`. Focused lint for
the edited source/tests passed. The C01-C07 concurrent acceptance matrix remains
incomplete; these results do not establish full storage-architecture acceptance.
