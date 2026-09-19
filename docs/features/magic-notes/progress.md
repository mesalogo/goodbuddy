# Magic Notes Progress

## 2026-09-19: Canvas Image Import Size

- Raised the canvas image file limit to 20 MiB inclusive and updated its error
  message and derived restoration bound. The authoritative limit is in the
  [canvas integration reference](../../../src/renderer/src/magic-canvas/README.md#editor-limits).
- Real Electron exercised File input, FileReader, Fabric insertion, flush, model
  conversion and remount: 2 MiB + 1 byte and exactly 20 MiB were retained;
  20 MiB + 1 byte was rejected with the updated message. Fixtures use a valid
  one-pixel PNG padded to each byte boundary, not a large decoded pixel image.
- Production preload/registered IPC handlers with mocked Electron transport and
  real SQLite/files passed 20 MiB create, update and database reopen checks.
  Shared canvas validation and file persistence impose no smaller byte budget.
  Rich-text attachment budgets and the PDF import limit are unchanged.
- Validation: `npx vitest run tests/canvas-core.electron.test.ts src/main/magic-notes/canvas-ipc.integration.test.ts src/main/magic-notes/magic-note-storage.test.ts src/main/magic-notes/rich-content.test.ts src/renderer/src/magic-canvas`
  passed 66 tests in 8 files. `npm run typecheck` and `npm run lint` passed.
  The full suite and a combined native Electron IPC save scenario were not run.

## 2026-09-19: Resizable Record Index

- The record index defaults to 168px and supports pointer resizing from its right
  edge and keyboard resizing between 140px and 320px. Index and AI separators share
  event handlers, styles and accessibility semantics. The existing layout storage
  key now includes `indexPaneWidth`; constrained window sizes do not overwrite the
  saved desktop width. Layout behavior is defined in the
  [technical design](./technical-design.md).
- Collapsing removes both the column and its 9px separator while retaining the
  header toggle. At widths up to 800px the existing fixed 168px drawer remains,
  without an index separator. Thumbnail images retain contain sizing.
- Focused verification: 147 tests passed across `MagicNotesWorkspace.test.tsx`,
  `MagicCanvasThumbnail.test.tsx` and `WorkspacePrimitives.test.tsx`. Coverage includes
  pointer bounds/cancel, unrelated pointer IDs, keyboard limits, persistence,
  independent collapse and narrow layouts. `npm run typecheck`, `npm run lint`
  and `git diff --check` passed. No full test suite was run for this change.
- `npx vitest run tests/magic-notes-layout.electron.test.ts` passed with current
  production Workspace/CSS/i18n in Electron and fixture note IPC. Native mouse and
  keyboard input verified default/min/max widths, both pane handles, resizing with
  AI open and closed, a 329px stream increase when a 320px index is hidden, and
  actual localStorage restoration after page reload. Content sizes were 1280x800,
  820x720 and 720x640; the constrained desktop stream remained at least 300px,
  narrow drawer width was 168px, and no document horizontal overflow occurred.
  This verifies renderer geometry and browser layout preferences, not the full App
  shell or note database persistence. No model calls were made.

## 2026-09-19: Final Full-Suite Verification of Six Fixes

- Ran `npm test` with a 1,200,000 ms command timeout: **4,756 passed,
  11 failed, 67 skipped**; files: **395 passed, 1 failed, 9 skipped**.
  Started at 12:59:14 and completed in 754.02 seconds. This was a shared,
  concurrently changing worktree, not a frozen source snapshot.
- All full-run failures were in `src/main/magic-notes/canvas-ipc.integration.test.ts`.
  `TypeError: contextManager.cancelImport is not a function` occurred during
  disposal at test line 91 and reopen at line 77 (cases at 198, 238 and 265).
  Evidence: the concurrent attachment-import diff adds `ContextManager.cancelImport`
  and calls it unconditionally from the IPC disposer; the notes fixture supplied
  only `clear`. The output mapped the IPC frame to line 8942; the inspected current
  source had the actual call at line 8967.
- Added only the missing no-op `cancelImport` to the notes IPC fixture and the
  equivalent environment fixture in `tests/support/magic-notes-analysis-main.ts`.
  The latter was exposed by the first focused rerun: **397 passed, 1 failed,
  0 skipped**, with the same disposal error reported at
  `tests/magic-notes-analysis.electron.test.ts:56`. No production code was changed
  in this verification pass.
- Final five-file focused command: `npx vitest run
  src/main/magic-notes/canvas-ipc.integration.test.ts
  src/renderer/src/MagicNotesWorkspace.test.tsx src/renderer/src/App.test.tsx
  tests/magic-notes-analysis.electron.test.ts tests/magic-notes-navigation.electron.test.ts`.
  Result: **396 passed, 2 failed, 0 skipped** in 121.12 seconds; files:
  **4 passed, 1 failed**. Notes Workspace (108), IPC (11) and both Electron probes
  (2) all passed, totaling **121 notes tests**.
- The remaining failures are App project-activity cases acknowledging foreground
  and background local success from persisted messages, at
  `src/renderer/src/App.test.tsx:1430` (missing completion text) and `:1418`
  (still running instead of completed). Standalone `npx vitest run
  src/renderer/src/App.test.tsx` reproduced **275 passed, 2 failed, 0 skipped**
  in 58.44 seconds. Evidence of the unrelated attachment interaction: test line
  1394 takes `saveLocal.mock.calls.at(-1)` and lines 1408-1411 build completion
  messages from that call; the concurrent App diff adds an attachment-save queue
  calling `saveLocal` with `messages: []` at line 2741, including when send clears
  attachments at line 7620. These tests do not enter notes. App and attachment
  files were left unchanged by this verification pass.
- Focused ESLint passed for both adjusted fixtures. The previously reported full
  typecheck/lint results were not rerun. `git diff --check` passed after the
  documentation update (only LF-to-CRLF warnings). The full suite
  was not repeated after fixture fixes; this is not an all-green full-suite claim.
  Live model calls in this pass: 0. No commits. Earlier progress sections retained.

## 2026-09-19: App Leave Guard and Title Drafts

- App navigation registers the workspace's existing canvas-flush and dirty-draft
  confirmation through `onBeforeLeave`. Sidebar, launcher and conversation jumps
  share the gate. Settings closes after its own leave approval before notes asks
  for confirmation. Cache limits and continuous-record/index behavior are unchanged.
- Non-title responses preserve dirty titles; title-save responses acknowledge only
  the submitted input and retain later edits.
- Focused suites passed: `MagicNotesWorkspace.test.tsx` (99 tests) and `App.test.tsx`
  (277 tests). The expanded settings-to-notes confirmation cases also passed.
  `npm run typecheck`, `npm run lint` and `git diff --check` passed.
- `tests/magic-notes-navigation.electron.test.ts` passed with actual Windows Electron,
  Workspace, Quill and canvas components. It checks AI-time title input, pending
  canvas flow input, Continue editing and confirmed discard. API responses are
  controlled fixtures; this is not a packaged full-App/persistent-IPC probe.
  Model calls: 0. Full repository test suite was not run.

## 2026-09-19: Analysis Source Revisions

- Main/shared/DB implement the source revision and comment invalidation rules in
  [Canvas Analysis and Comments](./technical-design.md#canvas-analysis-and-comments).
  Canvas todo writeback rejects stale sources even without pre-existing comments;
  affected saved todo comments are cleared with a revision increment and stable ID.
- Shared `magicNoteCanvasAnalysisText` preserves analyzer page-number semantics.
  Regression coverage includes blank-page insertion with unchanged plain text,
  geometry changes, missing/stale capture revisions and source edits during runs.
- Focused Vitest: 5 files, 162 tests passed (database, storage, rich content,
  analyzer and production preload/IPC integration). `npm run typecheck` and focused
  ESLint passed for the initial Main/shared changes.
- Workspace now passes capture revisions, save-response revisions selected by the
  exact created/edited entry ID, and selected todo source revisions. It uses the
  shared page-numbered analysis text for automatic text-comment analysis decisions.
  Draft analysis is unchanged. Regression coverage includes an external refresh
  completing during capture without pairing the old image with a newer revision.
- UI adaptation validation: Workspace (108 tests), production IPC integration
  (11 tests), both Electron probes (2 tests), and App (277 tests) passed, 398 total.
  Workspace fixtures validate every analysis request with the production schemas.
  `npm run typecheck`, `npm run lint` and `git diff --check` passed.
- `tests/magic-notes-analysis.electron.test.ts` runs actual Workspace/Quill/Fabric
  captures through production preload, registered Electron IPC, source revision
  checks, analyzer and SQLite. Saved-entry analysis, edit/create automatic analysis
  and source-canvas todo analysis all persist `canvas-images` comments. Only model
  output and unrelated environment services are substituted; live model calls: 0.
  The earlier navigation/title Electron regression also passes. No full suite run.

## 2026-09-19: Default Composer

- Opening a note now shows a blank text/canvas composer below its title and above
  the continuous history. Removed the New record button, locale keys and creation
  visibility state. A successful create resets the editor key and content while
  retaining its type; automatic analysis does not enter editing. Existing records
  still require explicit Edit and retain normalized dirty baselines and revision keys.
- The index toggle stands directly before the title. Header height now explicitly
  supplies the narrow drawer offset without relying on the removed button.
  This supersedes the explicit-create and post-create-edit behavior recorded below.
- Focused validation: 5 files, 149 tests passed (`MagicNotesWorkspace`, both editors,
  `MagicCanvasThumbnail`, `WorkspacePrimitives`). `npm run typecheck`, `npm run lint`
  and `git diff --check` passed. No full test suite was run.
- Temp Electron validation rebuilt current Workspace/PageShell, Quill, Fabric, CSS,
  production preload and registered IPC, backed by AssistantDatabase and note files.
  Text/canvas create-save-reopen, blank composer return without confirmation, real
  editor changes requiring confirmation, thumbnail scroll preserving the top draft,
  explicit text/canvas edit-save and database close/reopen all passed. Automatic
  analysis capture-before-reset is covered by the focused regression; model calls: 0.
- Light/dark checks at actual content widths 1287, 947, 547 and 362px passed document
  overflow, continuous history, narrow drawer width, placement below the title and
  close-on-navigation assertions. Reviewed wide light and narrow dark drawer PNGs.
  Evidence: `C:/Users/jiang/AppData/Local/Temp/opencode/composer-default-Tq8Ui8/`;
  runner: `node C:/Users/jiang/AppData/Local/Temp/opencode/run-composer-default.mjs`.
- Probe boundaries: isolated feature window, not the full App shell; Quill API input
  and DOM button clicks, not native keyboard coverage. Early probe failures came
  from inactive canvas text-tool input, an unconstrained fixture parent, and measuring
  the inner navigation width instead of the drawer border box. Corrected probes
  passed without further production changes. No commits or real user-data writes.

## 2026-09-19: Independent Layout Review

- Rechecked the action-placement changes in Electron using production PageShell,
  Workspace, Fabric, Quill and CSS. The earlier bare-workspace screenshots omitted
  PageShell gutters; no extra stream padding was added to compensate for that fixture.
- Fixed narrow record headers forcing each action onto a separate full-width row,
  touching canvas inner/outer borders in create/read mode, and missing spacing below
  the Records / AI tabs. Canvas create/edit/read inner frames now share 12px insets.
- Fixed Quill percentage heights stretching an empty text composer beyond the
  visible area. The text save footer and validation now belong to the same composer
  card. Save handlers, analysis rules and draft-switch semantics are unchanged.
- Text toolbar SVGs and picker menus use theme colors; native scrollbars in the
  notes workspace follow light/dark mode.
- Final Temp probe: `canvas-layout-review.mjs final`, with captures prefixed
  `canvas-layout-final-` and measurements in `canvas-layout-final-metrics.json`.
  Checked create/edit/read for canvas and text at 1300x950, 960x800, 560x800 and
  375x720 content sizes in both themes (48 combinations), plus AI-pane captures.
  Assertions passed for document/main horizontal overflow, canvas action bounds
  and equal heights, independent side scrolling, reachable text Save, and side
  collapse/reopen. Inspected final wide, medium, narrow and deep-narrow dark images.
- Focused validation: `npx vitest run src/renderer/src/MagicNotesWorkspace.test.tsx
  src/renderer/src/MagicNoteEditor.test.tsx src/renderer/src/MagicCanvasEditor.test.tsx`
  passed 102 tests. `npm run typecheck` and `npm run lint` passed. No full suite run.
- Scope: actual Windows Electron renderer with an in-memory DesktopApi fixture,
  not a packaged full-App or persistent-IPC validation. No model calls, runtime or
  remote changes, commits, or user-data writes.

## 2026-09-19: Canvas Action Placement

- Canvas creation places Analyze and Save at the right of the type selector;
  editing places Analyze, Cancel and Save in the record header. Save remains the
  primary action. Canvas hints and footer actions were removed, including unused
  English/Chinese locale keys. Text actions and existing handlers are unchanged.
- Focused workspace/editor tests: 2 files, 93 passed. Typecheck and lint passed.
  Coverage includes all three comment modes, top placement, order, no duplicate
  footer, cancellation, saving and manual/automatic analysis. No full suite run.
- A Temp Electron/Vite probe uses production Workspace, Fabric, Quill and CSS
  with an in-memory DesktopApi fixture. Creation and editing were checked at
  1300px and 560px window widths for top placement, visible Save and no horizontal
  document overflow. Screenshots are `canvas-actions-{create,edit}-{wide,narrow}.png`
  in the Temp opencode directory. No real model calls were made.

## 2026-09-19: Review Corrections

- Fixed local creation selecting an Agent's concurrent append. The database
  returns the exact `createdEntryId` alongside detail, typed through shared API
  and preload. The workspace uses that ID for selection, analysis and subsequent
  edits. Existing Agent/MCP note projections retain their public shape.
- Text-edit save/cancel now use the shared analysis cleanup: pending timers and
  queued content are removed, late comments are ignored, and abandoned settings
  preparation cannot dispatch a draft request. The composer content is independent.
- Local and external deletion reconcile the actual selected ID when no dirty
  editor must be retained. A later append no longer changes the fallback selection.
- Thumbnail abort immediately invokes core destruction, whose synchronous phase
  cancels PDF/Fabric work. Final cleanup awaits the same promise and removes the
  temporary surface. Regression tests cover both unmount and content replacement
  while capture is pending, and verify the next queued thumbnail completes.
- Post-fix focused run: **13 files, 257 passed, 0 failed**. Coverage includes
  `MagicNotesWorkspace`, `MagicCanvasThumbnail`, editor/content/core/model tests,
  production canvas IPC integration, note storage, assistant database, MCP gateway
  and preload note events. `npm run typecheck` and `npm run lint` passed.
- The user reported a full-suite result of **4,713 passed, 0 failed before these
  review corrections**. That result does not validate the fixes above. No full
  suite or Electron probe was rerun in this correction pass. Model calls: 0.

## 2026-09-19: Record Index Header Toggle Correction

- Moved the record index toggle immediately before New record in the detail
  header, retaining its accessible name, title, controls and expanded state.
  Collapsing hides the whole index and removes its grid column and border width.
  Narrow layouts use the same toggle for a 168px overlay below the header, with
  no reserved rail. This supersedes the 40px rail described in the earlier run.
- Focused validation: `npx vitest run src/renderer/src/MagicNotesWorkspace.test.tsx
  src/renderer/src/WorkspacePrimitives.test.tsx` passed 130/130 tests.
  `npm run typecheck` and `npm run lint` passed. No full suite was run.
- Actual Electron geometry checks compiled the current Workspace and production
  CSS with fixture note data, covering window widths 1300, 960, 700 and 375px with
  AI both open and closed. Wide stream widths increased by exactly 168px on
  collapse; narrow stream widths stayed at 687.43 and 362.29px. Hidden index
  geometry was zero, closed streams began at the layout's left edge, and no
  horizontal overflow occurred. The header toggle remained hit-testable directly
  before New record. Native Tab skipped hidden records, programmatic focus on
  hidden records failed, Enter reopened the index, and narrow Escape restored
  toggle focus. AI widths were unchanged by index toggling.
- Evidence: `C:/Users/jiang/AppData/Local/Temp/opencode/record-index-results-Xvgnsw/results.json`.
  Reproduce with `node C:/Users/jiang/AppData/Local/Temp/opencode/run-record-index-geometry.mjs`.
  This checks an isolated Electron renderer, not the full App shell or storage
  path. Model calls: 0.

## 2026-09-19: Continuous Stream and Save Baseline Correction

- Restored all entries to the continuous stream, including while composing. The
  168px left index and independent right AI pane collapse separately. Index and
  AI source clicks scroll without discarding drafts or remounting the editor.
  At widths up to 800px the index uses a 40px rail with a 168px drawer; AI retains
  its bounded bottom layout. This supersedes the single-record interaction below.
- Dirty checks now compare against the editor's initialized content. Canvas waits
  for its initial flush before enabling input or reporting readiness; text reports
  Quill's initialized Delta. Save/analysis revisions remount with a fresh baseline,
  while unchanged background revisions retain it. Failed writes do not advance it.
- The actual saved formatted-text callback had the same values but a different
  Delta field order (`insert, attributes` in storage; `attributes, insert` from
  Quill), reproducing the old false dirty comparison. Saved PDF content matched
  both the readiness callback and subsequent flush in the final probe.
- Final focused validation: 15 files / 222 tests passed, covering Workspace, both
  editors, thumbnail/content, shared primitives, canvas core/model, analyzer, file
  storage, production canvas IPC and canvas text. `npm run typecheck` and
  `npm run lint` passed.
- The full suite completed with 4,730 passed, 1 failed and 67 skipped (713.99s).
  Its sole failure was the shared contrast test finding the first dark descendant
  rule instead of the root token block. The test now matches the exact root
  selector; all 36 shared primitive tests passed afterward, also included in the
  final 222-test run. The full suite was not repeated after that test fix and the
  final editor initialization regression additions.
- Actual Electron 43.2.0 validation used built renderer assets over `file://`, the
  production preload, IPC handlers, AssistantDatabase and note files. It verified
  three simultaneous entries, real thumbnail pixels, scroll-only draft retention,
  independent collapse, text/canvas create and update followed by a clean return,
  a new post-save edit requiring confirmation, and a real revision conflict keeping
  the failed draft. A two-page PDF survived database reopen and three consecutive
  saves in the same editing context, with unchanged PDF bytes, advancing revisions
  and no prompt on return. Six entries remained mounted through the layout checks.
- Layout captures covered light/dark at content widths 1287, 947, 547 and 362px,
  with no document horizontal overflow. Narrow drawer opening, 168px geometry,
  record navigation and automatic closing passed. Temporary evidence is under
  `C:/Users/jiang/AppData/Local/Temp/opencode/canvas-sqlite-N9japl/`; reproduction:
  `node C:/Users/jiang/AppData/Local/Temp/opencode/run-canvas-sqlite.mjs continuous-notes.html`.
  The earlier development-server attempt hit Vite PDF dependency optimization;
  the built-asset run passed. This validates the production feature path in an
  isolated Electron window, not the full App shell or a packaged distribution.
- `node tests/magic-canvas-wheel.electron.mjs` passed all 34 wheel and full-page
  height checks. No storage/core wheel changes or model calls were needed.

## 2026-09-19: Single-Record Workspace (Superseded)

- Note detail mounts one selected record or an explicitly opened new-entry editor.
  Saving a new entry selects it; further saves update the same ID and use revisions
  returned by saves and automatic comments. Record/AI source switches share draft
  confirmation, and clean external changes refresh without replacing dirty drafts.
- A collapsible Records / AI comments region defaults to Records. Each canvas
  record has one real first-page thumbnail with total page count; text records show
  summaries. Visible thumbnails render serially and capture only page zero at 240px.
  The main editor and side region scroll independently; narrow layouts retain the
  bounded bottom region. UI contract: [design system](../../../UI-DESIGN.md#137-魔法笔记).
- Focused validation: 9 files / 142 tests passed across workspace, canvas editor,
  content, shared primitives, canvas core/model and canvas IPC integration.
  `npm run typecheck` and `npm run lint` passed. No full `npm test` run in this task.
- Actual Electron renderer probe used production Workspace, Quill, Fabric and CSS
  with an in-memory DesktopApi fixture. It verified one main entry, real thumbnail
  pixels, one thumbnail for a two-page entry, record switching, independent scroll,
  collapse/reopen, AI switching, discard/cancel, AI and todo source selection,
  returning to todo context, and preserving canvas drafts through external updates
  and deletion. One create followed by three updates included two
  canvas updates and continuing to edit a newly created record. At 547px content
  width the document scroll width remained 547px. This is renderer validation,
  not a complete App-shell or persistent-IPC end-to-end run.
- Reproducible local probe: `C:/Users/jiang/AppData/Local/Temp/opencode/run-single-entry-probe.mjs`;
  screenshot: `single-entry-narrow.png` in the same temporary directory.
- Existing `node tests/magic-canvas-wheel.electron.mjs` passed all 34 Electron
  checks for wheel behavior and full-page editor/viewer height at 900px and 360px.
  Storage, wheel and page-height behavior were retained. Model calls: 0.

## 2026-09-19: Full-Page Canvas Height

- Removed fixed saved-viewer and composer heights. Natural layout includes the
  current paper, toolbar and padding, with outer vertical scrolling and inner
  horizontal scrolling. Different page sizes still paginate within one entry.
- `node tests/magic-canvas-wheel.electron.mjs`: 34 checks passed in Electron
  43.2.0, including editor/saved-viewer geometry at 900px and 360px, portrait to
  landscape pagination, no inner vertical or outer horizontal overflow, and
  native outer vertical scrolling. This mounts the production core with product
  CSS and representative wrappers, not the complete App shell. The original
  wheel fixture has an explicit test-only height constraint to retain both-axis
  coverage; edge tests wait for the compositor after programmatic scrolling.
- Focused canvas/editor/content/workspace tests: 7 files, 95 tests passed.
  Full typecheck and lint passed; the final probe edit also passed focused lint.
  The full test suite was not rerun for this height-only change. Model calls: 0.

## 2026-09-19: File Storage and Schema 38

- Replaced SQLite body payloads with file-backed rich-text and canvas entries.
  SQLite retains metadata, membership, indexes, revisions, todos and comments;
  hydrated API content stays compatible. File layout, write/repair semantics,
  migration and backup requirements are defined in the
  [storage contract](./technical-design.md#file-storage-and-writes).
- The startup worker converts one entry per transaction and verifies hydrated
  readback before clearing the legacy payload. Reclamation checks the freelist
  on every attempt, including retries after conversion has finished. Committed
  saves/deletes/resets remain successful when manifest or GC cleanup fails;
  failures are logged and cleanup is retried on later access or reopen.
- Storage implementation handoff reports 135/135 focused tests passed across
  `magic-note-storage`, `assistant-database`, `assistant-storage-upgrade` and
  `canvas-ipc.integration`, with full `npm run typecheck` and `npm run lint`
  passing after the review fixes. Filesystem rename/rm failure injection uses
  real SQLite and files. A 1 MiB PDF retained its binary mtime across 20 updates
  while SQLite growth stayed below 2 MiB; the migration regression verified
  more than 2 MiB of physical shrink and restored SQLite plus the notes tree.
- Session validation reports the real Electron -> IPC -> SQLite/files path
  successfully created text, image and canvas/PDF entries, completed three
  consecutive updates and reopened persisted data after process restart.
  Migration also passed with an on-disk schema 37 fixture. This was a constructed
  fixture, not a user's historical database; no real user database was migrated.
  Actual model calls for this storage validation: 0.
- Backups require coordinated SQLite and `notes/` copies while writes are paused
  or the app is closed. No product one-click backup was added.
- Final full test run: 4,705 passed, 3 failed, 67 skipped (760.91 seconds).
  All three failures were in `acp-remote-runtime.test.ts`, which was being changed
  concurrently: a launch-response schema mismatch and two channel-close recovery
  assertions. That file subsequently passed all 100 tests on a targeted rerun.
  No note-storage test failed; this does not claim a second all-green full run.

## 2026-09-19: Canvas Wheel Navigation

- The shared canvas viewport explicitly handles horizontal and vertical wheel
  input in annotation, flow-text and read-only modes. Shift with vertical-only
  input scrolls horizontally. Ctrl input was initially left to the browser;
  the View Zoom update below assigns Ctrl/Command + wheel to canvas zoom.
  Default scrolling is prevented only when the viewport actually moves; page
  scrolling remains available at boundaries or without canvas overflow.
- Removed scroll-chain containment. The Electron baseline reproduced boundary
  trapping, but not a universal failure of native horizontal input. The new
  Electron regression passed 30 scenarios; focused unit tests passed 13 tests.
  Run `node tests/magic-canvas-wheel.electron.mjs` to repeat the native-input
  fixture. It does not validate a physical mouse or the complete App shell.
- Typecheck and lint passed. The full test run during this fix reported 4,682
  passed, 67 skipped and one unrelated Agent package inventory timeout.

## 2026-09-19: Canvas View Zoom

- Implemented editor/read-only zoom using the shared core. Controls and view-only
  invariants are documented in the
  [canvas reference](../../../src/renderer/src/magic-canvas/README.md#view-zoom)
  and root UI design. The persisted model and export dimensions are unchanged.
- Real PDF plus flow validation reproduced an existing cleared-background defect:
  automatic pagination reassigned an unchanged canvas width/height, erasing its
  bitmap. Layout now retains the bitmap when dimensions are unchanged.
- Focused validation passed 9 files / 140 tests: `canvas-wheel`, `canvas-flow`,
  `canvas-note`, canvas `model`, `MagicCanvasEditor`, `MagicCanvasThumbnail`,
  `MagicNoteContent`, `MagicNotesWorkspace`, and `tests/canvas-core.electron.test.ts`.
- `node tests/magic-canvas-wheel.electron.mjs`: 41 checks passed in Electron 43.2.0.
  Native input covered pen coordinates and object move/scale at 50% and 200%,
  second-page Quill click/typing, Ctrl wheel, ordinary/Shift/diagonal wheel and
  boundary propagation. Real PDF background pixels, unchanged PNG captures and
  794-by-1123 output dimensions, stable flow pagination, zero view-only changes,
  readonly controls, displayed page heights and fit-width resize all passed.
  Dark narrow layout included a real 560px window resize across the responsive
  padding breakpoint while the host width remained 360px.
- `npm run typecheck` and focused ESLint on all six changed JavaScript/test files
  passed. Final `npm run lint` encountered two `react-hooks/immutability` errors
  at lines 18/27 of concurrently added `src/renderer/src/FloatingPortal.tsx`;
  those parallel changes were left intact. `git diff --check` passed.
- No full test suite, production build, physical-device test or macOS session was
  run in this change. Meta-wheel is covered by focused tests. The Electron fixture
  uses production canvas modules/styles with real Fabric, Quill and PDF.js; it
  does not claim complete App-shell or release-package validation. No model calls
  or commits were made. Deployed Agent paths are unaffected.

## 2026-09-19: Single Navigation Button and Unframed Note Detail

- Replaced the two header tabs with one destination-labelled button and icon,
  immediately before New note. Switching retains the same button and restores
  focus to it. The list section keeps its localized accessible name; tab roles
  and references are removed. Navigation still uses the existing draft guard.
- Note detail removes the surrounding layout border/radius and stream padding.
  Composer and entry borders, page margins and the AI divider remain. Overview
  cards and the independent todo layout retain their frame and spacing.
- Focused workspace, editor, shared-primitives and i18n suites passed 122 tests.
  `npm run typecheck`, `npm run lint` and `git diff --check` passed. The full suite
  was not rerun for this change, as requested.
- Updated the existing `magic-notes-render-electron.cjs` probe in the session's
  `opencode` temporary directory and ran `magic-notes-render-run.cjs` against the
  current workspace component and real Quill in Electron. At 1280x820, 600x760,
  600x520 dark and 420x640, the switch measures 104x36px and precedes New note.
  Pointer and Space activation restore switch focus; no tab semantics remain.
- Computed detail border/radius and stream padding are all zero. Composer and
  entry borders and the AI divider remain 1px. At 1280px, closing AI expands the
  stream from 927px to the full 1216px layout width. Narrow layouts keep only the
  native scrollbar width between layout and content, with no horizontal overflow.
  AI moves below the editor and closing it increases editor height.
- The same probe passed card/scroll return, actual Quill draft cancellation and
  discard, todo split/narrow layouts, source-note return, creation and completion
  filters. Screenshots were reviewed; results are in
  `magic-notes-render-results.json`. Console errors: 0; model calls: 0. Data and
  AI output use fixtures. The esbuild probe emits an existing IIFE/import.meta
  warning for the canvas PDF module; this run does not exercise PDF import.

## 2026-09-18: Integrated Canvas and Validation

Historical snapshot before file storage: the embedded payload and schema 37
statements below describe this stage only. Current persistence and its validation
are recorded in the schema 38 entry above.

- Implementation is complete across the workspace, PeopleLib Fabric + Quill
  editor/viewer, shared v1/v2 contract, preload/IPC, SQLite and AI analysis.
  Available operations include paged flow text, pen/highlighter, selection and
  transforms, floating text, images, PDF import/native text extraction and raster
  PDF export. Saving is manual; undo/redo is local to the page or Quill mode.
  The toolbar has no PNG download action; PNG capture is an API used for analysis.
- Assets are embedded in SQLite `content_json`, not a separate resource table.
  Schema 37 is a compatibility marker without conversion of existing records.
  Flow checklist identity survives object moves and completion writes back to
  flow. MCP exposes readable canvas metadata/text and rejects plain-text
  replacement. See the [technical contract](./technical-design.md).
- Entry, draft and canvas-source todo analysis use the default model's
  `supportsImageInput`: complete page captures plus extracted text, or labelled
  text-only fallback. Purely visual entries/drafts fail clearly with a text-only
  model. Canvas `immediate` mode explicitly offers manual analysis;
  `after-save-auto` catches capture/settings errors without blocking storage.
  Text-only entry comments survive equal `plainText`; layout changes invalidate
  visual comments and trigger renewed analysis in after-save-auto mode.
- Confirmed interactive validation used the real workspace, preload, registered
  IPC and SQLite to save an image and a two-page PDF, reopen them, and complete
  three consecutive saves successfully. This covers persistence beyond the
  earlier renderer-only fixtures. The temporary probe uses
  `canvas-sqlite.tsx`, `canvas-sqlite-main.ts` and `run-canvas-sqlite.mjs` under
  the session's `opencode` temporary directory.
- The isolated canvas core probe passed with a Vite production build loaded via
  `file://` and the unchanged application CSP, including PDF import, PNG capture
  and raster PDF download. The export review also verified the 20,000-character
  flow boundary and list markers in captured pages and re-rendered exported PDF.
  These are core rendering/export results, distinct from workspace persistence.
- Regression coverage includes storage reopening, checklist writeback, comment
  retention/invalidation, revision conflicts, MCP protection, renderer integration
  and analysis input selection. The preload/IPC integration suite uses real
  SQLite but mocked Electron transport and model output; it is not evidence of
  a live model request.
- Final `npm run typecheck`, `npm run lint` and `npm run build` passed. The full
  test rerun completed with 4,665 passed, 7 failed and 67 skipped. Failures were
  in Agent packaging (missing compound-package fixture and an inventory timeout)
  and activity record/DOM reuse assertions. Those files were under concurrent
  modification; this is not a fixed-snapshot all-green result. No Magic Notes or
  App regression failed in that run. The earlier two App failures from eager
  PDF.js loading were fixed with on-demand PDF imports and passed their targeted
  rerun; core/editor/workspace focused coverage passed 87 tests.
- Live provider validation was blocked before any request: an isolated Electron
  process could not decrypt the configured default model credential
  (`runtime-model-credential-unreadable`). Settings were only read and remained
  unchanged. Actual model calls: 0. Runtime request tests verify image input and
  text fallback, but do not establish successful live provider generation.
- This canvas change does not alter the deployed Agent runtime or the
  desktop-to-Agent production path, so it requires no separate remote Linux
  validation. Concurrent runtime work has its own validation scope.

## 2026-09-18: Stable Todo Split View and Header Navigation

- Supersedes the inline task expansion described in the earlier entry below.
  Wide containers now keep the grouped task list on the left and instructions,
  source and AI in one right detail pane. Narrow containers retain the mounted
  list and offer on-demand detail with an explicit return. Source-note return
  preserves task context. Header tabs precede New note; filters follow search.
- Focused workspace, editor and shared-primitives suites passed all 93 tests.
  `npm run typecheck` and targeted ESLint passed. No full `npm test` was run.
- Reused the temporary Electron renderer probe at 1280x820, 600x760,
  600x520 dark and 420x640. The 134x36 header switch precedes New note at all
  four sizes. Search/filter share a row at 1280 and 600; filters wrap at 420.
  The wide list's width, top, scroll and adjacent row coordinates remain equal
  before and after task selection/switching. Narrow returns preserve nonzero
  list scroll and restore focus. No horizontal overflow or console errors.
- Also verified source-note round trips at all sizes, actual Quill draft
  confirmation, note-card return, AI visibility, task completion/status filters,
  AI fixture results, creation and Chromium keyboard activation.
- Visible-window capture initially failed with Electron `UnknownVizError`.
  Final probe uses Electron offscreen rendering at scale 1, pointer input and
  Chromium DevTools keyboard input. It runs production React/Quill/CSS with
  in-memory API fixtures, not the full App/Main/SQLite/model path. Model calls: 0.
  Evidence remains under the temporary `opencode` directory in
  `magic-notes-render-results.json` and `magic-todos-*-expanded.png`.

## 2026-09-18: Independent Todo Task View

- Replaced todo full-page navigation with a grouped task list and one inline
  expansion for instructions, source content and AI comments. Completion works
  directly in each row. Search/status controls stay above the scrolling list;
  source-note navigation retains expansion, filters and initiating focus.
- Kept the note-card overview and note editor/AI layout. Notes/To-dos PageTabs
  now size to their contents at desktop and narrow widths. Source failures offer
  an inline retry alongside the existing notification.
- Focused command: `npx vitest run src/renderer/src/MagicNotesWorkspace.test.tsx src/renderer/src/MagicNoteEditor.test.tsx src/renderer/src/WorkspacePrimitives.test.tsx`:
  93 tests passed. `npm run typecheck` and ESLint on the workspace, its tests and
  both changed locale modules passed. Full `npm test` was not rerun, as requested.
- Reused the isolated Electron renderer probe at requested content sizes
  1280x820, 600x760, 600x520 (dark) and 420x640. All four todo views retained
  18 tasks, inline expansion, independently scrolling lists and no horizontal
  overflow or detail/AI sidebar. Tabs measured approximately 133x35 CSS pixels.
  Note-card navigation, actual Quill draft confirmation, AI visibility, source
  navigation, direct completion, status filters and inline AI fixture output passed;
  the renderer reported no console errors.
- The probe uses production React, Quill and CSS with in-memory API fixtures and
  isolated Electron sessions; it does not validate Main/SQLite or a live model.
  Model calls: 0. Scripts, screenshots and JSON results remain in the existing
  temporary `opencode/magic-notes-render-*` probe location.

## 2026-09-18: Card Overview and Detail Navigation

- Replaced the persistent inner list with a responsive card overview and explicit
  detail navigation. Search, todo filters, overview scroll and initiating focus
  survive a round trip. Creation opens the new note; todo source navigation returns
  to the todo overview. Back navigation protects entry and title drafts.
- Kept AI visibility and resizing preferences, removed obsolete list resizing,
  and capped stacked AI height so short windows retain usable editor space.
- Focused workspace, editor and shared UI suites passed 90 tests. Typecheck and
  full lint passed. The first full test invocation exceeded its 200-second limit.
- Isolated Electron rendering exercised the actual workspace, Quill and CSS at
  1280x820, 600x760, 600x520 (dark), and 420x640. Navigation, creation, todo-source
  jumps, draft confirmation, AI visibility, scroll and focus restoration passed.
  These checks used in-memory API fixtures, not Main/SQLite integration; no real
  model calls were made. Canvas functionality is outside this layout change.

## 2026-09-17: Note List Action Menu

- Moved pin/unpin and whole-note deletion from the editor header to each note's
  action menu, following the [UI design system](../../../UI-DESIGN.md#137-魔法笔记).
  The menu uses existing update/delete IPC and shared destructive confirmation.
- Added regression coverage for menu keyboard behavior, portal placement,
  dismissal, pin ordering, revision failures, deletion and retained drafts.
- The focused Magic Notes suite passed 42 tests. The combined Magic Notes,
  conversation and shared-primitives suites passed 332 tests. Typecheck and
  targeted ESLint passed.
- Full `npm test`: 370 files and 4,440 tests passed, 2 files and 3 tests failed,
  9 files and 67 tests skipped. Two heartbeat migration fixtures relabel a current
  database as an old version and fail on the existing `pinned` column. One
  OpenCode runtime-reuse request timed out; its two tests passed on isolated rerun.
- Full lint reported 22 `document` no-undef errors in the unrelated, untracked
  `docs/features/story-graph/demo.js`. No unrelated files were changed to resolve
  these validation failures. Interactive Electron and touch verification remain
  unperformed.

## 2026-09-15: Automatic External Refresh

- Implemented the shared-database notification and Main/preload subscription
  described in [technical design](./technical-design.md).
- The open workbench reloads external changes while retaining current selection
  and unsaved drafts. Deleted notes and edited entries retain drafts with an
  explicit explanation. The cancelled manual-refresh proposal is not implemented.
- An initial completed `npm test` run passed 357 files and 4,201 tests, with
  9 files and 67 tests skipped (680.45 seconds). The first invocation had exceeded
  the command tool's 120-second limit.
- After three additional renderer race/retry tests, the final `npm test` run
  reported 355 files and 4,202 tests passed, 9 files and 67 tests skipped, and two
  unrelated timeout failures: the large offline dependency inventory test in
  `tests/agent-package.test.ts` (60 seconds), and the two-project OpenCode case in
  `src/main/agent/local-runtime-reuse.test.ts` (40-second request timeout).
- Rerunning those two files together passed 24 tests with one skipped in
  103.71 seconds, without source or timeout changes. The final renderer/preload
  focused run also passed all 38 tests. No Magic Notes regression failed.
- `npm run typecheck` and `npm run lint`: passed. The new required subscription
  method is also present in the application test API fixture.
- Validation uses production SQLite and Agent/MCP gateway code, the production
  preload with mocked Electron transport, and renderer interaction tests. An
  interactive Electron window was not exercised. No deployed Agent code or
  desktop-to-Agent protocol changed, so no separate Linux Host scenario applies.
