# Desktop File Storage Integration (S04)

Implemented domain operations, async consumers and production composition on
2026-10-05. The storage owner is registered by the foundation and the current Main
composition passes its file facades to ContextManager, document parsing and model
output. This does not claim that the full application has passed concurrent or
packaged acceptance.
The governing constraints are [performance principles](./performance-principles.md)
and [storage ownership](./desktop-storage-direction.md).

## Foundation API

`src/main/desktop-storage-files.ts` exports the complete integration surface:

- `DesktopFileStorageDomains`: intersect into `DesktopStorageDomains`. The domains
  are `attachments` and `documentResults`.
- `attachmentStorageMethods` and `documentResultStorageMethods`: explicit allowed
  operations. `attachments.reconcile` is an additional owner composite, with
  arguments `[startup?, protectedIds?]`; its callback never crosses IPC.
- `openDesktopStorageFiles(userDataRoot, hasOwner, persistentResultLookup?)`:
  construct once inside the existing utility process, after assistant and knowledge
  databases open. Pass the existing userData root, not the assistant DB directory.
  Add that root to foundation options and forward it in the client's open message.
- `DesktopStorageFilesOwner.dispatch(domain, method, args, signal)`: dispatch the
  two domains here from the existing owner's dispatcher. It normalizes transported
  original bytes, checks operation allowlists, and supplies cancellation to result
  saves. Keep the existing transport admission and result limits.
- Before readiness, run `files.attachments.reconcile(hasOwner, true)`. The callback
  uses the already-open assistant owner. It checks released references, marks
  interrupted parsing, removes stale call-only output refs, and reclaims owned
  orphan UUID directories. Do not run it concurrently with file producers.
- After draining admitted requests, `await files.close()` before closing assistant
  and knowledge. Close drops call-only output refs, preserves history refs, removes
  temporary document results, and closes the existing attachment database.

No new database, RPC transport, SQL endpoint, or process is introduced. Existing
attachment reference transactions and schema 1 remain in place. New relative paths
use slash separators; reads and reconciliation also accept released Windows paths.

## Main And Knowledge

After `storage.ready`, production composition uses `createDesktopStorageFiles(storage)` to obtain
`{ attachments, results, backingStore }`. Pass attachments to `ContextManager` and
results to `DocumentParsingService` and Knowledge's result-access dependency.
Do not also construct `ConversationAttachmentStorage` or `DocumentResultStorage`
in Main. Facades only call the existing storage client; importing them does not open
SQLite. Their result `close()` is intentionally inert: shared result shutdown belongs
to `DesktopStorageFilesOwner.close()`, after all producers drain.

Context operations that now require await: `storePastedImage`, `enrichRequest`,
`remove`, `serializeForQueue`, `restoreFromQueue`, `getDraft`, `hasImageInputs`,
`validateForSend`, `saveDraft`, `sendOriginal`, and `cancelUnavailableImport`.
Previously async import/reparse/image operations now await every storage operation.
Conversation/target validators may return Promises. Memory-only `clear` and
`activeContextIds` remain synchronous. `ContextManager.dispose()` cancels and drains
the active import before collecting unreferenced assets. Stop other context producers
and await their operations before disposing. Parsing-service disposal drains all
diagnostics, including those without an operation ID.

IPC must await attachment/result calls, including `results.original(id)` before
`shell.openPath`, and array predicates/maps after `get`, `draft`, `pendingParsing`,
and `getDraft`. Replace callback-based Main reconciliation with
`await attachments.reconcile(false, contextManager.activeContextIds())`.

Knowledge must accept `DocumentResultStorageAccess`, await `detach`, `original`,
and `isTemporaryResult`, and remove Main `setPersistentLookup` registration. Supply
that lookup to `openDesktopStorageFiles` instead: use owner-local
`knowledge.getDocumentByParsedResultId(id)` and the existing
`knowledge-assets/<libraryId>/<documentId>/<resultId>` directory and source location.
Keep Knowledge's publish/move/detach/release order. Result release never deletes an
external source original. No user-data directory migration is needed.

Project deletion supplies the project's conversation IDs captured before assistant
deletion to `attachments.deleteProject(conversationIds, protectedIds?)`. It removes
their refs in one attachment transaction, then collects only unreferenced assets.
Shared assets remain available to other conversations. Call this after the assistant
deletion commits; startup reconciliation covers an interrupted cleanup. Use
`deleteConversation` for single conversations and reconciliation for full clearing.

## Full Output

Pass the returned `backingStore` to each existing `PagedOutputStore`. It implements
`create/append/finish/read/release` directly in the existing attachment owner.
An output handle's UUID identifies its attachment row throughout capture, promotion,
history retention, restart, and deletion. Capture writes `original.txt` directly in
the owned attachment directory. Promotion renames that directory; no temporary full
copy or second backing is created. `request.json` contains only the descriptor.
Appends are bounded to 64 KiB; backing reads allow 32 KiB plus UTF-8 lookahead.
Small outputs remain in the existing bounded in-memory capture.

For history retention, await
`attachments.outputAdopt(callOwnerId, handle, conversationId, kind, referenceId)`
before the runtime releases its call reference. It returns the resource ID and adds
the reference without replacing the owner's existing attachments. Persist the
complete-output handle/reference in the owning event/message path; a preview alone
is not full output. Retain the call until required history adoption/persistence has
settled. Failed history publication uses existing release/reconciliation, not a
second durable operation log. Incomplete captures cannot be adopted.

`release` drops only the matching `output-call` ref. Persisted history can page after
call disposal or restart with
`attachments.outputRead(conversationId, handle, cursor, length)`, reading the same
bytes; it must use the owning conversation ID. History deletion uses the existing
message/queue/conversation reference cleanup. Runtime cancellation must await writer
abort/release. Startup removes stale call refs while retaining valid history refs.
The remote Agent path does not use this desktop backing and is unchanged.

## Validation Boundary

The focused suites exercise real SQLite/files through owner operations and async
facades, using structured-cloned arguments/results to cover Buffer-to-Uint8Array
conversion. They cover complete UTF-8 paging, one backing file, adoption, release,
abort, restart, project deletion with shared history, existing path separators,
temporary-result cleanup, failed adoption retry, async restore, and shutdown drain.
New result writes and copies omit `parsed.md`; old manifests and directories remain
readable. Result image writes settle sequentially before failure cleanup.

Local Windows validation: six focused suites passed (83 tests), covering this owner,
attachment references, ContextManager, parsing service, paged output, and HTTP OCR
integration. Scoped ESLint and diff whitespace checks passed. Node type checking
reported no diagnostics in S04 source/tests; the complete checkout still has pending
integration errors in Main/IPC and concurrent domain migrations.

These tests do not replace the foundation's utility-process tests or UI acceptance.
The real utility-process coverage for these domains is present in the focused
storage fixtures. Concurrent desktop acceptance and packaged validation remain
outstanding. No latency or throughput improvement is claimed from these focused
tests. Test resources live under `temp/goodbuddy-files-upgrade` and individual
fixtures remove their files.
