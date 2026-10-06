# Desktop Runtime Storage Integration

S05 domain implementation and production composition, 2026-10-05. This supplies
the runtime domain for the [desktop storage foundation](./desktop-storage-foundation.md).
The current composition passes the storage-owned binding store and model-call
ledger factory to Main runtime services. Full desktop migration and performance
acceptance remain incomplete.

## Integration API

`src/main/desktop-storage-runtime-operations.ts` exports:

- `DesktopStorageRuntimeOperations`: the existing `RuntimeSessionBindingStore`
  interface plus named ledger lifecycle and transition operations.
- `runtimeStorageMethods`: the explicit host dispatch allowlist.
- `DesktopStorageRuntimeOwner.open(userDataPath)`: creates the sole binding owner
  at `remote-runtime-bindings.sqlite`. Await it before publishing storage readiness.
  Native ledgers open lazily at their existing paths through `openLedger(id, path)`.
- `createDesktopRuntimeStorageAdapters(call)`: Main adapters returning
  `bindingStore` and `openModelCallLedger`. `call` has the same domain/method/tuple
  shape as `DesktopStorageClient.call`, restricted to the `runtime` domain.
- `DesktopStorageRuntimeOwner.close()`: closes remaining native ledgers and the
  binding database. The outer storage owner must first drain admitted operations.
  This method is not part of the external domain allowlist.

The storage-core integration adds `runtime: DesktopStorageRuntimeOperations` to
`DesktopStorageDomains`, initializes one runtime owner from the existing user-data
directory, and dispatches allowed runtime methods against that owner. Include its
close in the storage owner's release path, including startup failure. No new RPC
client, SQL endpoint, admission queue or process is needed.

After registering the domain, Main composition is:

```ts
await storage.ready
const runtimeStorage = createDesktopRuntimeStorageAdapters(
  (domain, method, args) => storage.call(domain, method, args)
)

// ManagedRemoteExecutionServices options:
// bindingStore: runtimeStorage.bindingStore
// The former userDataPath option is removed; the host owns that path.

// NativeClientCoordinator, NativeTerminalClient and NativeDshWebClientService options:
// openModelCallLedger: runtimeStorage.openModelCallLedger
```

`ManagedRemoteExecutionServices` borrows the binding interface and does not close
it on disposal. Native clients stop their producers and proxy, await their ledger
close, then delete launch material. DS Web retains native history. A failed or
unconfirmed close retains files and propagates the error. A lost open reply also
retains files because the host may still own the connection. Shutdown must stop
native/remote producers before closing the shared storage client.

## Ordering And Ownership

The shared `ModelCallLedger` type allows synchronous or Promise-returning methods;
the concrete `AgentModelCallLedger` stays synchronous and remains the remote
Agent's owner. Schema, database names, call identities, retention and transaction
algorithms are unchanged.

`AgentModelGateway` awaits claim before provider dispatch, complete before returning
the response, delivered before resolving the delivery acknowledgement, and
outcome-unknown before reporting provider failure. Cancellation while claim is
pending does not dispatch after claim completes. Persistence rejection propagates;
the gateway does not replay a provider request after an unconfirmed write.

## Validation

The final focused run passed 113 tests across eight files, with 11 existing opt-in
cases skipped. It included the official DS Web process using standard Node,
binding uniqueness/rotation/cursor persistence, concrete ledger reopen and uncertain
outcomes, delayed/rejected persistence, and both native clients' close ordering.

`desktop-storage-runtime-operations.test.ts` also builds real Electron fixtures.
The production native terminal loopback gateway uses Main adapters and the real
`DesktopStorageClient`/transport to reach a utility-process runtime owner, then
closes its ledger before removing launch files. Production core registration is
covered by `src/main/index.ts`; the fixture remains focused on the runtime domain.
Its model response is local and deterministic, with no external provider call.

The shared gateway was separately validated on the pinned Linux x64 test Host via
the existing lifecycle harness rebuilt from current source. OpenCode ran a bounded
tool command in a dedicated `/root/tmp/gb-lifecycle-*` workspace. Desktop detached,
the test Agent was promoted, the controller resumed, and the prompt completed.
There were exactly **2 real text-provider calls**, both HTTP 200, **0 image calls**,
33 persisted event entries, 17 checkpoints, and successful replay deduplication.
The old test daemon retired; final owned process count was zero. The harness removed
its remote directories. Local artifacts were isolated in
`temp/goodbuddy-ledger-upgrade` and cleaned after validation.

Scoped ESLint and `git diff --check` passed. The current composition supplies
`bindingStore` to `ManagedRemoteExecutionServices` and `openModelCallLedger` to
the native coordinator. Whole-application acceptance, packaged cross-platform
checks and concurrent performance measurements are not established by these
focused tests.
