# Assistant Storage Consumers

The S02 domain consumers use the typed port in
`src/main/assistant-storage-port.ts`. This implements the consumer side of
[Desktop Storage Foundation](./desktop-storage-foundation.md). Production
composition in `src/main/index.ts` supplies the client after storage readiness;
the consumer services do not construct an Assistant database.

## Main Integration

```ts
const storage = new DesktopStorageClient({
  ...paths,
  onChanged: createAssistantStorageOnChanged({
    onMagicNotesChanged,
    onMagicTodosChanged,
    onModelUsageChanged,
    onExecutionStatsChanged
  })
})
await storage.ready
const assistant = createAssistantStoragePort(storage)
```

`createAssistantStoragePort` binds only the explicit Assistant operation allowlist
and `supervisionContext`. Its return type is `AsyncAssistantStoragePort`: every
operation returns a Promise. There is no SQL, arbitrary property proxy, remote
callback or live repository API. `AssistantStoragePort` uses `Awaitable` results
so existing synchronous database fixtures can be injected into unit tests.
Domain change callbacks run in Main through `DesktopStorageClient.onChanged`.

The subagent service, native client coordinator, terminal manager, computer-control
audit sink, channel dedup/outbox, image service and Magic Notes IPC helpers accept
this port. Notes helpers retain sender validation, schema validation, source-message
checks and revision checks. Note analysis awaits the model-usage callback before
publishing its result. Channel and audit adapters return persistence completion to
their existing asynchronous callers.

Image service `initialize`, `persistUploads`, `getOperation`, `cancel`,
`cancelConversation`, `regenerate` and `dispose` return Promises. Await upload
persistence before submitting generation. Await cancellation and shutdown writes.
`onUsage` may return a Promise and must return the actual persistence operation.
Notification-only `onOperation` errors are reported without changing provider
outcomes; storage and usage-write failures reject instead of reporting durable
success. Shutdown reports retained persistence failures.

Subagent event and model-usage callbacks may return Promises. The service awaits
task creation, events and terminal status writes; shutdown also drains task
creation and queued cancellation writes that have not entered a scheduler slot.
Native client composition additionally forwards the storage-backed
`openModelCallLedger` factory to both browser and terminal clients.

Stop producers and await service disposal before closing `DesktopStorageClient`.
This consumer migration does not establish full desktop performance acceptance or
replace the separate Main/IPC composition and concurrent acceptance work.

## Validation

The 11 focused suites pass with 94 tests, including asynchronous image storage,
commit-before-notification, usage-write rejection, subagent shutdown during task
creation, channel delivery, audit persistence and IPC sender/schema checks.
Repository-wide type checking remains dependent on the concurrent Main/IPC,
Knowledge and runtime-storage integrations. No latency or full concurrent-desktop
acceptance claim is made by these unit and loopback tests.
