# Knowledge Main Storage Migration (S03)

Knowledge Main now receives `KnowledgeServiceOptions.database`, a
`KnowledgeStoragePort`. Production composition constructs it with
`createKnowledgeStoragePort(storageClient)` after `storageClient.ready`.
`KnowledgeService` no longer opens, initializes, closes, or starts readers for
the business database. The application storage owner retains those duties.

The adapter sends explicit `knowledge` and `external` domain calls. Search
signals travel as transport options, not serialized arguments. The port's
`Awaitable` return type permits synchronous owner-local test implementations;
the production adapter always returns the storage client's promises.

Main awaits source, document, task, graph, embedding and external metadata
operations. IPC mutations await their writes before returning or refreshing a
snapshot. Parsing, models, credentials and source watchers remain in their
existing Main services. Embedding batches retain their existing sizes and
staging/publication sequence.

Publication passes the extracted graph through foundation
`publishDocument(..., { graph })`. Graph-only replacement calls
`replaceDocumentGraph(library, document, result)`. Its implementation in
`src/main/desktop-storage-knowledge-operations.ts` runs the existing synchronous
graph algorithm inside `replaceEvidenceForDocument`'s transaction. No callback
or SQL crosses the storage boundary.

Shutdown aborts producers immediately, drains tracked work and observes the
task-interruption write and embedding status persistence. The service does not
close the shared storage client. Embedding allocation returns its replacement
ID even if cancellation arrives with the reply, allowing cleanup; a committed
finish is not reported as rolled back. Rebuild admission remains occupied
until its final status write settles, and status-write failures reach the
completion barrier.

## Current Production Boundary

The following boundary is implemented in the current production composition:

- `replaceDocumentGraph(library: KnowledgeBase, document: Document,
  result: GraphExtractionResult): void` to the knowledge domain contract and
  dispatch it to the exported owner-local operation, passing the owned database
  as its first argument. It is not part of the concrete database method
  allowlist because it is a composite owner operation.
- Foundation publication reuses the exported `storeExtractedGraph` helper.
- `StorageData` preserves the existing recursive JSON type without rebuilding it
  in the adapter.
- Persistent document lookup is resolved by the storage owner through the
  Knowledge domain; Main does not register a second lookup.
- Application composition injects the port, awaits asynchronous gateway and
  tool-provider calls, and closes shared storage after Knowledge disposal.

## Validation

The focused Knowledge service, external service, embedding coordinator and
embedding repository suites use a Promise-backed adapter over a test-owned
SQLite connection. Coverage includes publication rollback, embedding batch
ordering, late cancellation, replacement cleanup, external request cancellation,
credential persistence and restart. The production gateway now awaits its library
and search operations. Remaining evidence is limited to the focused suites and
does not establish full concurrent desktop acceptance.

Owned production files pass ESLint. The current worktree typecheck and focused
storage validation cover the injected production port and owner dispatch. Global
architecture acceptance, packaged checks and concurrent performance acceptance
remain with the parent delivery; these tests do not establish a new performance
baseline.
