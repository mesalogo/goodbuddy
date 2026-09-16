# Magic Notes Technical Design

## Change Notifications

`AssistantDatabase` accepts `onMagicNotesChanged: () => void`. Every successful
note/entry create, update or delete emits once after the write commits, including
empty-note creation, initial content, title/pin updates and cascading deletion.
Saved note analysis, todo completion, saved todo analysis and assistant-data
clearing also emit. Revision conflicts, missing rows, rolled-back writes and
unchanged todo completion do not emit. Startup schema migrations run before the
workbench loads and do not publish notifications.

Desktop IPC and `KnowledgeMcpGateway` use this same database instance. The latter
also serves Agent tools; no tool-specific notification or daemon protocol change
is needed. Raw SQL writes from an unrelated process are outside this callback
contract.

Main queues notification delivery to the live window on `magic-notes:changed`.
The typed preload method `magicNotes.onChanged(listener)` exposes no Electron
objects and returns a function removing that listener. The existing
`onTodoStatusChanged` event remains the separate sidebar-count signal.

## Refresh Lifecycle

`MagicNotesWorkspace` subscribes on mount and coalesces notifications with a
100 ms debounce. Pending notifications wait for an active local save or analysis
to finish. Cleanup removes the listener, clears its timer and invalidates pending
refresh results. This does not introduce periodic database polling.

The existing list/detail loader reloads notes and todos, then the preferred note.
Request counters reject superseded results and preserve newer user selections.
Todo selection survives list reordering while the item exists; replacing the todo
snapshot also reloads the selected todo's source entry. Search, filters and layout
state are not reset.

Background application of a detail reads the current draft state after the
asynchronous fetch. A dirty title is retained, and the composer is not remounted.
An entry editor uses its original editing content and revision for both its React
key and save request; external revisions cannot remount it or bypass optimistic
concurrency checks. Deleted entries remain displayed only while their editor is
open. If an externally deleted note has a draft, its editor remains available
with a deletion explanation instead of moving the draft to another note.

Read failures use the existing retryable refresh error and retain successful
data and drafts. Retry uses the same draft-preserving loader. Interaction rules
are owned by [the UI design system](../../../UI-DESIGN.md#137-魔法笔记).

## Note List Actions

Each note row has a selection button and a sibling action-menu button. The menu
uses the conversation action styles and shared `DestructiveConfirmActions`, and
is portalled to `document.body`. Its position follows the trigger on scrolling,
window resizing and confirmation-size changes. Hiding the list, filtering out the
target or leaving the notes panel closes the menu.

Pinning uses the target summary's ID and revision through the existing update
IPC. It updates the sorted summary and matching selected detail without resetting
title, composer or entry-edit drafts. Deleting uses the explicitly confirmed
target ID; deleting another note uses the draft-preserving refresh path. Deleting
the selected note clears its entry drafts only after the write succeeds, then
selects a remaining note. These are renderer changes; database and Agent contracts
are unchanged.

## Agent Search Contract

`note_search` accepts an integer `limit` from 1 to 100, defaulting to 8.
The shared schema supplies both model tool definitions and MCP validation;
the existing 128 KiB output budget can reduce the returned result count.
The built-in MCP gateway returns invalid scoped-tool arguments as an
`isError: true` tool result with the field and validation message, allowing
the model to correct its arguments without an MCP internal-error response.
Validation failures do not execute the tool.

These note tools run in the desktop gateway. Remote gbagent ACP sessions
currently inject only the image MCP server, so this change requires no
daemon implementation update.

## Validation

- `assistant-database.test.ts` checks committed writes with a second SQLite
  connection, successful mutation coverage, failures, no-op completion and reset.
- `knowledge-mcp-gateway.test.ts` exercises real database CRUD through Agent/MCP
  access, including revision failure without an extra notification. A real HTTP
  MCP client also checks searches above ten results, the published limit schema,
  invalid arguments and successful retry against SQLite.
- `magic-notes-events.test.ts` executes the production preload, checking the
  channel, payload-free callback and listener removal.
- `MagicNotesWorkspace.test.tsx` covers external updates and deletion, selection,
  source reload, editor identity and draft saves, coalescing, deferred writes,
  asynchronous selection races, error retry and unmount cleanup. List-action
  coverage includes portal placement, keyboard navigation, dismissal, delete
  confirmation, target selection, revision failures and draft preservation.

No schema migration, dependency, refresh control or network service is added.
