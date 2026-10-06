# Desktop Storage Foundation Integration

Implemented 2026-10-05. This is the storage foundation for
[the desktop storage direction](./desktop-storage-direction.md). The production Main
composition now opens one `DesktopStorageClient` and supplies its typed facades to
the migrated domains. Full application acceptance is still incomplete. Do not open
the existing Main databases alongside the owner.

## Client API

Import `DesktopStorageClient` from `src/main/desktop-storage-client.ts` in Main.
Construct it after Electron readiness and the application's single-instance check.
The existing database directories must exist. Preserve the current database paths.

```ts
const storage = new DesktopStorageClient({
  assistantPath,
  knowledgePath,
  defaultRootPath,
  userDataPath,
  onProgress: progress => publishExistingUpgradeProgress(progress),
  onChanged: domain => publishExistingDomainNotification(domain),
  onFailure: error => reportStorageFailure(error)
})
await storage.ready

await storage.call('assistant', 'saveLocalConversations', [changes])
const conversation = await storage.call(
  'assistant', 'getConversation', [conversationId], { signal }
)
const results = await storage.call('knowledge', 'search', [searchOptions], { signal })

// After stopping producers and awaiting their persistence flushes:
await storage.close()
```

`call(domain, method, argumentTuple, { signal? })` infers argument and result types
from the explicit allowlists in `desktop-storage-contracts.ts`. All results are
Promises. Pass cancellation as the transport option, not inside a DTO. Functions,
signals and live class instances are rejected before posting. Maps and Uint8Arrays
are supported; Node Buffers arrive as Uint8Arrays across Electron IPC.

`userDataPath` is the existing application user-data root, not a database directory
inferred from a filename. `ready` means upgrade worker exit, database initialization,
attachment startup reconciliation and runtime-binding owner initialization completed.
Calls before readiness fail without queueing. `retry()` retains the same public
client and facades. A live failed startup retries in that process; a failed/exited
utility is replaced only after exit confirmation and old-request settlement. The
replacement gets fresh request correlation, never the old writes. The confirmed
upgrade decision is acknowledged into Main memory before upgrade execution, retained
across startup loss, and cleared when that upgrade completes. Wire `retry()` to the
existing retry UI. There is no automatic restart or replay of unconfirmed writes.

The defaults locate `desktop-storage-entry.js`, `readonly-query-worker.js` and
`assistant-storage-worker.js` as packaged siblings. `entryPath`, `readerWorkerPath`
and `upgradeWorkerPath` overrides support isolated tests and explicit composition.
The new entry is included in `electron.vite.config.ts`.

## Owner-Side Operations

| Existing call shape | Storage operation |
| --- | --- |
| Assistant/Knowledge ordinary database methods | `call('assistant' / 'knowledge', method, args)` using the explicit allowlists |
| SSH project create/update | `assistant.createSshProject` / `assistant.updateSshProject` accept `Omit<SshProjectWrite, 'assertCurrent'>`; Main checks the live host/runtime before dispatch, and the owner retains cancellation and project-revision checks inside the existing transaction |
| `activityHistory()` live repository | Existing `getActivityHistoryPage`, `getActivityHistorySummary`, `updateActivityHistory`, `replaceActivityHistory`, `clearActivityHistory`, `reconcileActivityHistory` operations |
| `supervisionReviewStore()` | `call('review', method, args)`; initialization/resume execute on the write owner, not the old independent writer |
| `supervisionStories()` | `call('stories', method, args)` |
| `supervisionExperiences()` | `call('experiences', method, args)` |
| `supervisionSuggestions()` | `call('suggestions', method, args)`; resolution uses `assistant.resolveSupervisionSuggestion` |
| Knowledge `externalStore` | `call('external', method, args)` |
| `readSnapshot(callback)` for review context | `call('assistant', 'supervisionContext', [request])`; summary/background share one reader snapshot |
| Knowledge `publishDocument(..., { afterChunksInserted })` | `call('knowledge', 'publishDocument', [input, chunks, { graph, embeddingReplacement, embeddingError }])` |
| Knowledge graph-only replacement | `call('knowledge', 'replaceDocumentGraph', [library, document, graph])`; reuses the existing evidence replacement transaction |
| Attachment references and full-output backing | `call('attachments', method, args)`; includes owner-local `reconcile(startup?, protectedIds?)` |
| Temporary and persisted document results | `call('documentResults', method, args)` |
| Runtime bindings and native model-call ledgers | `call('runtime', method, args)` |

Repository instances never leave the owner. The publication graph DTO is the
existing `GraphExtractionResult`. The owner creates the graph callback and performs
entity identity resolution, evidence insertion, chunk/embedding publication and
pruning within `KnowledgeDatabase.publishDocument`'s existing transaction. Replace
the consumer's publication callback with this DTO; remove its duplicate graph
publication path when migrating that consumer. Extraction/model work remains outside
storage. Publication and replacement share `storeExtractedGraph` from
`desktop-storage-knowledge-operations.ts`. Callback-bearing `replaceEvidenceForDocument`
is excluded from the transport allowlist. File adoption/release and task-status
orchestration remain outside this SQLite transaction.

After readiness, `createDesktopStorageFiles(storage)` supplies attachments, results
and output backing; `createDesktopRuntimeStorageAdapters((domain, method, args) =>
storage.call(domain, method, args))` supplies runtime bindings and ledger access.
The facade caller types now share the core DTO types, so these calls need no casts.
`StorageData` preserves the existing recursive `JsonValue` as-is rather than
recursively rebuilding it; runtime validation still rejects callbacks and handles.

The owner supplies both file callbacks. Attachment reconciliation checks
`assistant.hasAttachmentOwner`. Persistent document lookup reads
`knowledge.getDocumentByParsedResultId` and resolves the existing
`<userDataPath>/knowledge-assets/<libraryId>/<documentId>/<resultId>` directory and
source location. Main must not register another persistent lookup on the results
facade. The existing `onProgress`, `onChanged` and `onFailure` APIs are unchanged,
including `createAssistantStorageOnChanged`'s four notification mappings.

Keep these composites intact during integration:

- Remote task/conversation batches use the existing `appendRemote*Batch` or
  `appendRemote*Once` methods. Await commit before forwarding or ACK. Never translate
  a batch into independently acknowledged per-event writes.
- Review publication uses `assistant.saveSupervisionResult`, which owns result facts
  and checkpoint commits. `commitCheckpoints` is deliberately not an external review
  operation. No callback-based transaction API is exposed.
- Story/experience apply and review batch save retain their existing repository
  transactions. A model request must finish before calling these operations.
- Additional multi-statement snapshots need a named owner/reader handler; do not
  recreate `readSnapshot` as several awaited Main calls.

## Bounds And Lifecycle

The utility adapter retains `ReadonlyQueryReader` request correlation, errors and
admission. Its existing request limit is 32, with 32 MiB of argument admission
credit. This is no longer a content-size restriction: one oversized complete input
uses the entire credit budget exclusively. Smaller concurrent inputs still share
the budget; saturation returns `STORAGE_CAPACITY` without dropping work.

`desktop-storage-wire.ts` transfers complete values on the same channel in frames
of at most 256 KiB accounted data. Each direction sends one frame and waits for its
acknowledgement before constructing the next. Strings are split without assembling
a whole JSON/serialized copy; binary frames copy only their slice and fill the
receiver's final buffer. The receiver exposes a value only after its last frame.
These frame acknowledgements provide transport backpressure, not durable write ACKs.
Cancellation bypasses the frame queue and is retained for an incompletely received
request until dispatch can reject it safely.

Known complete-note/history/result reads share one materialization/transfer slot,
so queued requests do not build many huge reply objects while another reply drains.
Writes and bounded queries retain ordinary admission. A complete user value itself
still needs memory proportional to its size; the frame budget is not a claim that
total process memory or every supported history fits in 32 MiB. There is no result
size rejection or truncation, and no `STORAGE_RESULT_CAPACITY` outcome after a commit.

Renderer conversation persistence now targets 8 MiB batches as well as the existing
100-conversation bound. A single oversized conversation stays complete and uses the
framed transport. Quit flushing drains all remaining batches and propagates a failed
write. Oversized single histories no longer fail solely because of the transport cap.
`STORAGE_UNCONFIRMED` means the process exited without confirming a pending operation;
reconcile using existing domain identities, not blind retries.

Queued cancellation is checked before dispatch. In-flight reader cancellation uses
the existing thread SharedArrayBuffer inside the owner; that buffer is never sent
over utility-process IPC. Synchronous commits cannot be interrupted by an incoming
message, so a completed commit returns success even when cancellation was requested
too late. Request capacity remains occupied until settlement.

`close()` stops client admission, drains admitted requests, awaits file-owner cleanup,
closes runtime ledgers/bindings and read workers, awaits the existing PASSIVE
checkpoint worker's exit, closes both database owners
and observes utility-process exit. An exit without the close acknowledgement rejects
close. Apply the application's existing shutdown deadline to the whole operation;
the transport separately reports an unconfirmed exit after its 10-second exit wait.
Startup failure follows the same release barriers. A failed close attempts the
remaining independent closes, reports `STORAGE_CLOSE_FAILED`, and exits unsuccessfully;
it does not acknowledge a clean drain or permit a second owner to open in that host.

## Remaining Integration And Acceptance

### Supervision And Heartbeat Callers

`createSupervisionDomainPorts(storage)` in
`src/main/assistant/supervision-domain-ports.ts` supplies Main-side RPC facades:

```ts
const ports = createSupervisionDomainPorts(storage)
const supervisor = createProductionSupervisorService(ports.supervision, getSettings, resolveRuntime, pool, persistUsage)
const phrase = createProductionSuggestionPhraser(ports.supervision, getSettings, resolveRuntime, pool, persistUsage)
const heartbeat = new HeartbeatService(ports.heartbeat, actions)
await deriveSuggestions(ports.suggestions, phrase, input)
```

The production factory's other arguments are unchanged. If provided, `persistUsage`
must return the persistence Promise. All heartbeat methods, including configuration
CRUD and history, now return Promises. Review repository factories may return a
Promise of the typed facade. The facades contain closures only; no database or live
repository is transported. `initializeSupervisionReview` and `resumeSupervisionReview`
route to `review.initialize` / `review.resume`, with signals in transport options.
The caller does not invoke the old independent supervision writer.

`story-assignment-service.ts` and `experience-extraction-service.ts` are the sole
story/experience model orchestrators, including their prompts, output schemas and
model-facing types. Production, tests and live scripts import those services.
The repository files retain their SQL methods and transactions, with type-only
imports for validated model output. `supervision-suggester.ts` awaits candidate
selection and suggestion publication. The heartbeat live script also awaits plan
creation before using its ID.

Callers await leaf/navigation writes, final publication, task usage/status,
heartbeat projections, story/experience results and error bookkeeping. Cancellation
aborts model work immediately, but review admission remains occupied until the
cancel write and active execution settle. A late rejected cancel does not overturn
a confirmed publication. Failure to persist a suggestion failure is propagated;
a model phrasing failure whose status was saved preserves the completed review.

Validation includes unchanged behavioral assertions in the existing review/story/
experience suites, delayed-commit tests, and `supervision-storage.test.ts`: a real
Electron storage utility process runs heartbeat, two review leaves, navigation,
stories, experiences, suggestion publication, usage, a no-change heartbeat and
cancellation using a local deterministic Runtime. This does not validate final
Main/IPC composition or concurrent latency budgets.

On 2026-10-05, after removing the duplicate orchestrators, the targeted supervision/
heartbeat run passed 215 tests across 21 files, including the real utility-process
test. Scoped ESLint and Node type checking passed.

The bounded `scripts/supervision-storage-live.cjs <runtime-settings.json>` probe
used the current supervisor profile (`gpt-6-astra`, OpenAI Responses) and production
utility storage with three synthetic calibration messages. Exactly four actual
HTTP requests completed, all HTTP 200: review, story assignment, experience
extraction and suggestion phrasing. It committed one leaf covering all three
sources (589 characters), assigned three events to one story, created one experience
and published two suggestions. The unchanged review made zero additional requests.
Persisted usage was four calls, 3,495 input and 1,251 output tokens. Two initial
preflight attempts sent zero requests; the probe was corrected to install the
isolated Electron encryption state before readiness. Current settings remained
byte-identical; credentials were not logged, and isolated databases, encryption
state and bundles were removed. This is functional evidence, not concurrent
performance acceptance.

### Integrated Owner

The foundation registers assistant, knowledge, external metadata, supervision,
attachments, document results and runtime operations without Main SQL fallback. The
production composition in `src/main/index.ts` constructs the Assistant, Knowledge,
file and Runtime facades after storage readiness and passes them to the relevant
Main services. Remote Agent database ownership is unchanged.

The remaining work is product-level acceptance: complete C01-C07/A01-A10 coverage,
packaged cross-platform checks, and removal or verification of any caller that is
outside the migrated desktop domains. Focused domain tests do not establish those
results.

The S05 runtime-domain owner, Main adapters, required composition wiring and focused
validation are documented in [Runtime Storage Integration](./desktop-storage-runtime-integration.md).

Supervision now uses `ReadonlyQueryReader.reviewManifest(runId)`. The existing
read-only assistant worker scans once under a read snapshot into connection-local
temporary metadata, ends the snapshot, and returns at most 200 metadata rows per
page. It holds at most one live scan manifest, rejects a competing scan explicitly,
and releases that temporary data in the operation's settlement path. It never
opens a business-write connection.

The sole write owner clears/rebuilds disposable manifest rows in bounded batches,
commits each insertion batch atomically, and yields between commits. Cancellation
and persisted pause/cancel status are checked between batches. `initializing`
remains set after interruption; clearing it and deleted-source cleanup share the
final transaction. Resume rebuilds partial manifests, or validates existing frozen
revisions in read-worker pages of at most 200 rows, yielding between pages. A failed
scan never falls back to synchronous owner scanning. Final result/checkpoint
publication remains the existing atomic operation.

The old writable `supervision` worker mode, connection opener and separate reader
field were removed. `AssistantDatabase`'s direct initialization/resume methods use
the same bounded implementation; in-memory owner-local use retains its synchronous
algorithm because a separate read connection cannot share that database. Other
non-worker operations still execute synchronously inside storage; no latency
improvement or full concurrent performance acceptance is claimed.

The current focused validation passes 70 tests across eleven suites: core storage,
file/runtime domains, assistant facade, read workers, bounded review-store algorithms,
existing supervision worker regressions, startup, wire backpressure, renderer batching
and real supervision/storage orchestration.
Real Electron coverage includes graph replacement rollback, SSH revision conflicts,
owner-side persistent document lookup after reopen, full-output retention and crash
reconciliation, ledger recovery, runtime startup failure/retry and pending file-save
drain before cleanup. Review tests cover 200-row bounds, concurrent owner writes,
frozen scan revisions, cancellation, failed-batch rollback, reader loss, marker
recovery, deleted sources and final marker/cleanup atomicity.

Real Electron large-value tests save an explicitly typed 16 MiB MP4 payload, read a
complete two-entry note, and round-trip all 25,600,230 characters of an 80-message
history. Hashes verify complete video and message bodies. The measured accounted
frame high-water marks were 248,332 bytes in Main and 252,578 bytes in storage, below
262,144 bytes; argument credit peaked at 33,554,432 bytes. Main RSS peaked at
426,049,536 bytes including fixture inputs, complete results and application memory.
This is queue-bound evidence, not a whole-process memory or latency budget claim.
The real process tests also kill an in-progress write transfer and confirm no replay
after retry, and verify startup decision retention/clearing across process loss.

Full Node, Agent and renderer typechecking passes, as does scoped ESLint. Temporary checks and databases use
`temp/goodbuddy-storage-foundation`; tests remove their generated bundles/data.
The earlier foundation production-build check predates this domain integration.
Packaged cross-platform and full UI-to-storage concurrent acceptance remain outstanding.

### Reader Ownership Cleanup

The obsolete `readWithFallback` export, database-owned readonly-reader fields and
checkpoint lifecycle methods, and the database async wrappers were removed. Heavy
reads are dispatched by `DesktopStorageOwner`; owner-local synchronous reads remain
available inside transactions and focused database tests. Read-worker and checkpoint
tests now create explicit `ReadonlyQueryReader`/`Worker` owners and await their close.
The three perf harnesses create explicit owner-local reader/checkpoint resources under
the repository temporary root, report `executionBoundary: owner-local`, and close
those resources before deleting their copies. No production or test source reference
remains to the removed compatibility APIs.

The cleanup validation adds termination barriers and failed-frame poisoning: a reader
cannot reopen capacity while its prior worker termination is pending, a transport
posting failure cannot feed later values into a partial decoder, and close waits for
wire drain and owner settlement. The focused cleanup run passes 122 tests; Node and
renderer type checks and scoped lint pass.
