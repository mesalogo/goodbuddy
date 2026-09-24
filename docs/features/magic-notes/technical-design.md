# Magic Notes Technical Design

## Continuous Record Workspace

The detail mounts every entry in a continuous newest-first stream. The left index
and AI source buttons scroll to an entry ID without changing the active editor,
clearing a composer, flushing content or invoking the draft-switch guard. Opening
a note shows a blank composer below the title and above the stream, without a New
record button. Editing another entry or
leaving the note still checks unsaved content after flushing canvas changes.
`MagicNotesWorkspace.onBeforeLeave` registers this same check with the App navigation
gate, including sidebar, application launcher and conversation jumps. The gate waits
for canvas flush, then offers Continue editing or Discard draft and switch for dirty
body or title content. Workspace cache eviction does not serve as draft protection.
Non-title detail responses retain a dirty title. A title-save response acknowledges
only the submitted input; text entered while that request runs remains a draft.
The shared store returns `MagicNoteEntryCreateResult`, the existing detail shape
plus a required `createdEntryId`. Production IPC and preload preserve that ID.
Creating an entry selects this exact ID and resets the composer through its key;
it does not enter editing, including after automatic analysis. Text/canvas selection
is retained. Canvas capture for automatic analysis completes before the reset.
the renderer never infers it from a list difference or timestamp. Agent/MCP
creation delegates to the same store; its existing public note projection is
unchanged.
Explicit Edit opens a saved record. Update and automatic-analysis responses advance its revision, so subsequent
saves use `updateEntry` and the returned revision. Failed writes retain the draft.

The dirty baseline belongs to the mounted editor. `MagicNoteEditor.onReady` reports
Quill's normalized contents after loading; `MagicCanvasEditor.onReady` reports the
first completed core flush, after Fabric restoration and flow pagination. Canvas
input stays disabled until this baseline exists, and imperative flush waits for
the same initialization promise. Raw stored JSON is not a valid comparison baseline
for an initialized editor: Quill can add its terminal newline, and Fabric/flow
serialization can add defaults or change field order. Later changes and navigation
flushes compare with the initialized baseline without resetting it. A successful
save remounts at the returned revision and establishes a new baseline; an unchanged
background revision retains the existing editor and baseline. Aborted canvas
initialization and file reads for an unmounted text editor cannot write back.

The real saved formatted-text probe reproduced identical values with different
Delta key order: storage returned `{insert, attributes}` and Quill emitted
`{attributes, insert}`. The old `JSON.stringify` comparison therefore reported
dirty after a successful save. The saved PDF probe's initialized content and
subsequent flush were byte-for-byte equal; readiness is still awaited for canvas
restoration rather than assumed from the save response.

Saving or leaving an editing context clears the immediate-analysis timer, queued
content and streamed draft comments through the shared draft-analysis cleanup.
The context counter rejects late results and prevents dispatch after abandoned
settings preparation. This cleanup does not clear the new-entry composer's content.

The left index defaults to 168px and resizes from its right edge between 140px
and 320px. It shares the AI pane's pointer-capture handlers, separator styling
and keyboard semantics (16px arrow steps, Home/End limits). Both widths are
stored in `goodbuddy.magic-notes-layout.v1`; missing index width defaults to
168px. Displayed widths clamp together to reserve at least 300px for the stream,
without overwriting saved widths when the window shrinks. The page header places
the index toggle immediately after the back button, followed by the AI toggle.
All three use icons and visible localized text; pane toggle labels reflect their
current show/hide action. Collapsing hides the entire index and removes its grid column,
border, resize separator and occupied width. AI has a separate
right pane with its existing resize separator and header toggle. Both panes scroll
independently and persist independent desktop visibility. At container widths of
800px or less, the index defaults to hidden and the same header toggle opens or
closes a fixed 168px drawer below the header, without reserving a rail or showing
an index resize separator; choosing
an item or pressing Escape closes it. AI moves below the stream, limited to 40%
of layout height and 280px. Overview search, scroll, task selection and return
focus stay mounted.

`MagicCanvasThumbnail` lazily queues visible records through a temporary core
renderer and caches results by content identity in a WeakMap. Core `capturePages`
accepts `firstPageOnly` and `thumbnailWidth`; thumbnails capture page zero at 240px
width, including paper/PDF background, Quill flow, images and Fabric objects.
They do not capture all pages or leave an editor mounted for every record.
An abort listener calls core `destroy()` immediately: PDF render cancellation and
the Fabric abort happen synchronously, before waiting for capture to settle.
The `finally` path awaits the same destruction promise and removes the temporary
surface, without destroying twice or waiting for capture before cancellation.
AI capture uses the configured page prefix described under Canvas Analysis and
Comments. Main canvas page height, wheel handling and file storage are unchanged.

Background refresh preserves dirty editing content and its original optimistic
revision, including externally deleted entries. Clean editors adopt refreshed
entries; deleting a clean selection updates `selectedEntryId` to a remaining
entry or the empty state. Later appends preserve that actual selection, rather
than recalculating a render-only fallback. Dirty deleted entries remain open
until explicitly discarded. No background refresh saves a draft.

## Canvas Storage Contract

`MagicNoteContent` is the union of unchanged v1 Quill rich content and v2
`paged-canvas`. The shared schema is authoritative. Canvas pages carry dimensions,
template/PDF backgrounds, opaque Fabric object records and optional `flowAuto`.
The optional Quill flow accepts native PeopleLib `version: 1` and page-break
embeds. Template names are `blank`, `ruled`, `grid`, `dot`; PDF backgrounds use
one-based `pageNumber` and optional extracted `text`.

API assets are document-local `{id,name,mimeType,dataUrl}` records. Backgrounds and
image objects reference stable asset IDs; image objects can also embed raster
data directly. Main validates data encoding, image/PDF signatures and references.
Canvas has no v1 resource-size budget. `image_bytes` counts decoded embedded
resource bytes for new entries. Bodies and binary assets use the file storage
contract below; there is no separate resource table, resource staging or extra
resource IPC. Renderer, preload and IPC continue to exchange hydrated v1/v2
content with data URLs.

Schema 38 replaces SQLite body payloads with file markers. Schema 37 was the
earlier canvas compatibility marker; its embedded-payload layout is historical.
Plain text combines flow text, PDF extracted text and object text for search.
Checklist indexes depend only on flow checklist lines; moving objects does not
change todo identity. Completion updates flow without replacing pages or assets.
Entry edits retain optimistic revisions. Canvas comment retention depends on the
actual analysis input, as described below.

`note_get` reports content kind/version and `plainTextEditable`. The text update
tool rejects canvas entries before mutation. These tools execute in the desktop
gateway; remote gbagent's injected image MCP server is unaffected. Browser page
renders can be sent as `analysisOptions.canvasImages`; analysis comments and draft
results can retain the actual `inputMode` used.

## File Storage and Writes

`MagicNoteStorage` owns files under `dirname(assistantDatabasePath)/notes`:

```text
notes/<noteId>/
  note.json                  # Derived {id, entries} membership manifest
  entries/<entryId>.json      # Authoritative body envelope
  assets/<sha256>.<ext>       # Binary assets deduplicated within this note
```

Each body envelope contains `id`, `noteId`, `revision`, `updatedAt` and `content`.
SQLite owns note metadata, entry membership, search/plain-text and byte indexes,
optimistic revisions, todos and comments. Entry `content_json` contains only
`{storage: "file", version: <content version>, revision: <body revision>}`.
Comment-only revision increments do not change the indexed body revision.

Known media fields become `{$asset: "assets/<sha256>.<ext>", mimeType: "..."}`
on disk and hydrate back to data URLs on API reads. These fields are v1
`insert.image`, `localVideo.dataUrl` and `attachment.dataUrl`; canvas
`assets[].dataUrl`, `preview`, flow embeds and image-object `src`, including
nested objects. Ordinary text, insert strings, names and arbitrary `$asset`
objects remain unchanged. Canvas asset IDs and PDF references are preserved.
Write, read and garbage collection use the same scoped field traversal.

Revision checks run under `BEGIN IMMEDIATE` before file writes. Assets are
written before the temporary body file is atomically renamed over the entry
file; the database then commits its marker and indexes. This is not a single
atomic transaction spanning SQLite and the filesystem. If a replacement body
was renamed but indexing failed, the next database access or reopen reads it
back, repairs plain text, byte counts and todos, advances revisions and
invalidates old analysis. Missing bodies raise an error instead of becoming
empty content. Failed creates leave no accepted database membership; their
unaccepted files are removed on the next access or reopen.

After commit, reconciliation derives `note.json` from database membership and
scans all retained entry files before removing unreferenced assets. Manifest or
GC failures log `console.warn` with the note ID and error and remain in an
in-memory retry set. Later database access retries; reopening derives cleanup
again from membership. These cleanup failures do not turn a committed save,
delete or reset into a failed operation or suppress its notifications. Body
persistence and index-repair failures still propagate. Entry deletion, note
deletion and assistant-data reset share this cleanup path; deferred whole-tree
cleanup checks current membership so it preserves notes created after reset.
There is no persistent retry journal, and renderer-only drafts create no files.

## Schema 38 Migration

The existing startup storage worker runs before the business connection opens.
It upgrades the schema and converts legacy payloads one entry per SQLite
transaction: write assets and body, read back hydrated content, compare JSON
equality, then replace the old `content_json` payload with its file marker.
Already converted entries are reconciled on retry. Matching body revisions do
not require rehydrating binary payloads. Direct `AssistantDatabase.initialize`
callers and tests also run storage repair.

Space reclamation is separate from conversion. Every worker attempt checks
`PRAGMA freelist_count` and runs checkpoint/VACUUM when free pages remain.
Cancellation after the last converted entry or a VACUUM failure therefore
allows reclamation to retry on the next startup, even with no legacy rows left.
The schema marker alone does not establish that conversion and reclamation
finished. General migration requirements are in the
[database migration guide](../../development/database-migrations.md).

## Backup and Restore

A restorable backup must pair a consistent SQLite backup with the adjacent
`notes/` tree from the same period with note writes paused, or with the app
closed. Handle active WAL through SQLite's consistent backup mechanism; copying
only the database main file while it is active is insufficient. Restore both
parts together. SQLite-only backups of file-backed entries cannot recover
bodies or assets, and `note.json` alone cannot recover database metadata,
revisions, todos or comments.

The product has no one-click assistant backup action. This is an operational
backup boundary, not a new UI capability. The tested backup/restore and migration
scope, including the lack of a real user historical database run, is recorded
in [progress](./progress.md).

## Canvas Editor and Export

`MagicNotesWorkspace` selects rich-text or canvas content for new entries and
opens saved canvases in `MagicCanvasEditor`; `MagicNoteContent` delegates saved
canvas rendering to the paginated `MagicCanvasContent` viewer. The React adapter
wraps the retained PeopleLib Fabric + Quill core. Fabric owns page annotations;
Quill owns the continuous body flow. Saving awaits `flush()` so queued imports,
text edits and pagination reach the existing preload/IPC create/update handlers.
There is no autosave or separate canvas persistence path.

Editor and viewer heights follow the current paper element's displayed height
through natural CSS layout, including wrapped toolbars and viewport padding.
No fixed preview height or viewport-height cap clips the page. The outer note
stream scrolls vertically; the paper viewport retains horizontal scrolling.
View zoom is local to each mounted core instance. A displayed-size outer box and
one transformed logical-size surface keep PDF, flow and Fabric aligned; Quill
screen measurements are converted back to logical coordinates. Neither zoom nor
fit-width resize calls `onChange`, changes the persisted model, invalidates AI
comments or alters PNG/PDF export dimensions. See the
[view zoom implementation](../../../src/renderer/src/magic-canvas/README.md#view-zoom)
for controls, bounds, page-switch policy and observer cleanup.

Paper templates, pen, highlighter, whole-object eraser, selection/transforms,
floating text, images and PDF page backgrounds are integrated. Native PDF text
is stored on its background for search and analysis; scanned pages remain visual
without automatic OCR. The toolbar exports a raster PDF through jsPDF, composing
background, flow text and annotations per page. It does not retain a searchable
PDF text layer. `capturePages()` provides PNG data URLs for AI input, not a PNG
download button. Undo/redo is per annotation page or Quill mode; page operations
and PDF imports are not global undo steps.

Flow page-break removal and rejected-input history handling follow the
[canvas editing and limit rules](../../../src/renderer/src/magic-canvas/README.md#editing-and-assets).
`canvas-core.electron.test.ts` feeds the real Electron flow's before/after content
into production `AssistantDatabase` create/update and reopen, checking that the
derived checklist todo and its identity survive page-break removal. History
coverage exercises accepted typing, rejected overflow, selection and redo.

The [canvas integration reference](../../../src/renderer/src/magic-canvas/README.md)
owns core limits, import behavior and lifecycle details. Vite bundles Fabric,
Quill, jsPDF, PDF.js workers and binary assets; PDF workers use explicit module
Workers and local assets under the production `file://` CSP. The renderer does
not need Node integration or remote asset services.

## Canvas Analysis and Comments

Draft, saved-entry and todo analysis use the existing typed preload/IPC methods
and `createDefaultModelRuntime`. Each canvas request reads the current default
model profile's `supportsImageInput` (or the resolved default setting when no
profile is selected). Main resolves settings again for the actual request. This
does not change an Agent runtime or desktop-to-Agent protocol.

`magicNoteCanvasPageCount` is an application preference: an integer from 1 to 8,
defaulting to 1 when absent in historical settings. The application center and
`goodbuddy_config` application.update/get share the settings schema, store and
change event. It counts pages within the canvas being analyzed, never entries.
The first N pages follow the current `content.pages` array order, independent of
the viewed page, page IDs or PDF source page numbers. Fewer than N pages selects
the whole canvas. Saving and PDF export retain the 50-page canvas limit.

Renderer and Main share `selectMagicNotePages`. The core selects the prefix before
compositing, so it never captures 50 pages just to discard 49. Analysis capture
returns the selected pages' Quill text measured from the actual CSS columns;
binary searches locate the character boundaries for explicit and automatic page
breaks. Text-only requests skip image compositing but still read page text.
The transient `canvasPageText` IPC field carries these page IDs and text, without
changing saved canvas content. Main reads the persisted page count for all three
handlers, selects page text, PDF text, objects and images in the same order, and
ignores captures outside the prefix. A partial canvas with flow requires matching
page text; missing data fails instead of including the full cross-page flow.
Prompts state the selected and total page counts. A changed setting applies to
the next analysis; existing comments are not automatically regenerated.

| Default model capability | Analysis input and result |
| --- | --- |
| Image input supported | Renderer captures the selected prefix; Main requires each selected page's PNG/JPEG capture and sends it alongside that page's flow, PDF and object text. Comments carry `inputMode: canvas-images`. |
| No image input | Only text from the selected prefix is sent, with an explicit instruction that handwriting, images and layout were not seen. Comments carry `inputMode: text-fallback`. |
| No image input and no extracted text in the selected entry/draft pages | Analysis fails with guidance to switch to an image-capable default model; no visual understanding is claimed. |

Todo analysis includes its title and instructions plus the source canvas context,
and uses the same capability and capture rules. Non-canvas content keeps the text
analysis path. All analysis remains read-only with no tool calls.

Saved-entry requests accept `expectedRevision`; todo requests accept
`sourceEntryRevision`. Nonempty `canvasImages` or `canvasPageText` requires the corresponding revision,
even when the resolved model uses text fallback. Main loads the source after
resolving settings and checks the supplied revision before model invocation.
Existing rich-text callers may omit these fields. Entry writeback retains its
revision check; canvas todo writeback also requires the source entry revision,
including when no comments existed at request time. No additional stored snapshot
or schema migration is needed.

Canvas `immediate` mode provides an Analyze canvas draft action without a persistent
instruction banner; pen strokes do not trigger automatic requests. `after-save-auto`
prepares analysis input and then saves manually submitted content. Settings or
capture errors are caught so storage still proceeds; after a successful save,
the UI reports that automatic analysis failed. A later model error likewise
does not roll back the save. Failure to flush the document itself still prevents
saving incomplete content.

For v2-to-v2 entry updates, identical content retains saved comments. If all
comments have `text` or `text-fallback` input mode, equal analysis text from shared
`magicNoteCanvasAnalysisText(content)` (including page numbers)
also retains comments across layout-only changes. Other changed canvas content,
including layout changes with `canvas-images` comments, clears saved entry
comments and `analyzed_at`. Source canvas changes apply the same rule to saved
todo comments and increment the affected todo revision without replacing its ID.
In `after-save-auto`, visual comments trigger renewed
analysis when content changes, while existing text-only comments trigger it when
analysis text changes. A changed draft clears its prior canvas draft analysis.
The UI labels the actual input mode so a text fallback is visible to the user.

Workspace captures the saved entry and its revision before awaiting image capture;
an external refresh cannot pair an old capture with a newer revision. Automatic
post-save analysis takes the revision from the save response using `createdEntryId`
or the edited entry ID. Todo capture uses the selected source entry's actual page
IDs and revision. Renderer text-only change detection uses the same shared
analysis-text helper as persistence, so inserting a blank page before text triggers
renewed analysis when its cited page number changes. Draft analysis remains unversioned.

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

The overview's `libraryView` and the optional note-only `detailView` are independent:
opening a todo's source note does not lose the originating task view.
The overview remains mounted but hidden while detail is open, retaining scroll
position and filters. Returning restores the initiating control's focus and
invalidates outstanding detail requests. Initial loading fetches summaries and
todos without selecting the first note or task. Navigation away from unsaved content or
an unsaved title uses the existing draft confirmation; active writes finish
before navigation. No new persistence or IPC contract is required.

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
A dirty entry editor uses its original editing content and revision for both its
React key and save request; external revisions cannot remount that draft or bypass
optimistic concurrency checks. Clean editors adopt newer revisions. Deleted entries
remain displayed only while their editor has a draft. If an externally deleted note has a draft, its editor remains available
with a deletion explanation instead of moving the draft to another note.

Read failures use the existing retryable refresh error and retain successful
data and drafts. Retry uses the same draft-preserving loader. Interaction rules
are owned by [the UI design system](../../../UI-DESIGN.md#137-魔法笔记).

## Todo Task View

The To-dos panel has its own search/status toolbar and independently scrolling
task list, grouped by source note. `selectedTodoId` controls one sibling detail pane;
the selected item is derived from the filtered list. Completion updates the
existing item and source cache without selecting or opening another task. Items
that no longer match the status filter leave the list. A removed focused control
returns focus to an available list/filter control.

Detail content includes instructions, the source entry, its existing note
navigation action, and AI controls/comments. AI requests still use the existing
analysis options and streaming subscription; failed analysis retains saved
comments. Source reads are guarded against superseded selections, report failures
through notifications and offer inline retry. The grid reserves both columns even
without a selection, so selecting or switching tasks cannot move list rows. The
detail is keyed by task ID to start each newly selected task at its top.
At a page container width of 700px or less, CSS hides the mounted list while a
task is selected and shows an explicit return button in the detail area. Returning
clears selection and restores row focus without scrolling; source-note return
retains selection and focuses this visible return button on narrow layouts.
There is no todo detail route or separate AI sidebar. A shared accessible resize
separator displays a 1px line with a transparent 9px hit area and 8px adjacent
content padding. It adjusts the list width, initially 320px, with a 240px minimum and at
least 300px reserved for detail. Pointer dragging and 16px arrow steps/Home/End
persist `todoPaneWidth` in `goodbuddy.magic-notes-layout.v1`. Narrow layouts hide
the separator; window constraints do not overwrite the saved desktop width.
Each source-note heading is a disclosure button with its matching task count.
Groups start expanded and can independently hide their mounted rows without
clearing the selected detail. Collapse state lasts while the group is mounted.
Note detail retains its existing AI pane preferences.

A single secondary button lives in `PageHeader.actions` before New note. Its
label and icon describe the destination, and `requestDraftSwitch` retains the
existing draft guard. Focus returns to the same `magic-library-switch` button
after switching. The overview section keeps its localized list `aria-label`;
there are no tab, tablist or tabpanel roles or tab-label references. The button
follows content width at all sizes. The shared status `SegmentedControl` follows
search in one wrapping toolbar.

Only note detail applies `magic-notes-layout--detail` to remove the layout frame
and corner radius. Its stream pane has no extra padding; editor borders and the
AI divider remain. Overview cards and the independent todo layout keep their
existing frame and spacing. These changes do not affect Main, preload or storage.

## Note List Actions

Each overview card has an open-detail button and a sibling action-menu button. The menu
uses the conversation action styles and shared `DestructiveConfirmActions`, and
is portalled to `document.body`. Its position follows the trigger on scrolling,
window resizing and confirmation-size changes. Entering detail, filtering out the
target or leaving the notes panel closes the menu.

Pinning uses the target summary's ID and revision through the existing update
IPC. It updates the sorted summary and matching selected detail without resetting
title, composer or entry-edit drafts. Deleting uses the explicitly confirmed
target ID and refreshes the overview after success, without opening another note.
These actions are available only in the overview. Database and Agent contracts
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

- `magic-note-storage.test.ts` uses real files and SQLite for migration equality,
  reopen/repair, binary deduplication, coordinated backup/restore and physical
  database shrink. Failure injection covers body rename, manifest/GC cleanup,
  delete/reset retries, post-conversion cancellation and VACUUM retry.
- Canvas integration coverage includes `MagicCanvasEditor.test.tsx`,
  `MagicNoteContent.test.tsx`, `rich-content.test.ts`,
  `magic-note-analyzer.test.ts` and `tests/magic-note-canvas-text.test.ts`.
  `canvas-ipc.integration.test.ts` runs production preload and registered IPC
  handlers against real SQLite with mocked Electron transport and model output.
  Interactive workspace/SQLite and production core export evidence is recorded
  separately in [progress](./progress.md).
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

Schema 38 and the file layout above govern current persistence; refresh
notifications need no separate storage or network service. Dated validation
results and remaining repository checks are owned by [progress](./progress.md).
