# Desktop Storage Direction

## Status and scope

2026-10-05: proposed target for the remaining PERF-15/PERF-16 work. The user has
requested documentation first, followed by bounded local fixes and a commit.
The full storage-service migration remains a separate discussion after those fixes.
Current desktop storage still has Main-owned business writes and selected worker
reads; this document does not describe a completed migration.

## Target responsibilities

- Renderer owns presentation, domain stores and disposable visible-data caches.
  It consumes summaries, pages and incremental notifications, not full database copies.
- Electron Main owns windows, trusted IPC, credentials, OS integration and service
  lifecycle. Heavy SQL, JSON assembly and document processing execute elsewhere.
- A desktop storage utility process would own business database connections and
  complete domain transactions. Retain the existing database files, schemas and
  durability distinctions. One write owner per database does not require merging databases.
- Existing read-only workers can serve heavy queries under the storage service's
  lifecycle. Do not place every read and write behind one long-running global job.
- Parsing, OCR, model inference and Runtime execution remain separate workloads.
  Remote Agent databases remain remote; desktop persistence acknowledges remote
  events only after the required local commit succeeds.

The service boundary consists of domain operations such as publishing a review or
committing an event batch. Do not expose arbitrary SQL, transport transaction
callbacks, or split an atomic transaction across individual IPC calls. Synchronous
SQLite inside its dedicated execution environment can remain appropriate.

## Correctness and lifecycle

Preserve write-before-read ordering, result/checkpoint atomicity, cancellation
settlement, event deduplication and commit-before-ACK. A rejected caller Promise
does not establish that a writer stopped. Reuse existing operation IDs and unique
constraints to resolve uncertain outcomes; do not blindly replay mutations or add
a general recovery journal.

Open business connections after required upgrades. Stop producers before draining
required writes and closing storage. A failed storage process must not silently
fall back to Main SQL or an empty persistent-data replacement. Keep bounded requests
and explicit failure/retry behavior without adding product approval gates.

## VS Code comparison

VS Code is a reference for service separation, asynchronous work, lazy activation,
cached UI state and shutdown coordination, not a requirement to copy its process map.
Its application/profile/workspace state connections are owned by Electron Main;
the backend uses asynchronous `@vscode/sqlite3`, while cached reads are synchronous
and writes are batched. GoodBuddy's relational history, source bodies and durable
remote-event acknowledgements require different payload and persistence boundaries.

Sources reviewed on 2026-10-05 (upstream main, not a pinned performance comparison):

- [Connection ownership](https://github.com/microsoft/vscode/blob/main/src/vs/platform/storage/electron-main/storageMain.ts)
- [SQLite backend](https://github.com/microsoft/vscode/blob/main/src/vs/base/parts/storage/node/storage.ts)
- [Cache and flush lifecycle](https://github.com/microsoft/vscode/blob/main/src/vs/base/parts/storage/common/storage.ts)
- [Extension hosts](https://code.visualstudio.com/api/advanced-topics/extension-host)

## Current implementation boundary

The immediate work reuses existing workers, narrows Supervisor loading and payloads,
optimizes measured queries, virtualizes lists, and removes repeated digest/snapshot
work. It does not add the utility process, convert every storage interface, or claim
exclusive ownership of assistant.sqlite. Read-only workers plus remaining Main writes
are an explicit transition state.

Full migration should proceed through verified domain operations and converge by
database ownership. Do not leave undocumented competing write paths. Completion
requires no Main-owned desktop business SQL, transactions wholly inside the owner,
responsive reads/writes under heavy work, and validated startup/cancellation/shutdown.

The [local implementation record](../review/kiss-local-fixes-2026-10-05.md) owns this
round's scope and measurements. The [performance principles](./performance-principles.md)
remain the acceptance criteria; regression ceilings are not equivalent to those budgets.
