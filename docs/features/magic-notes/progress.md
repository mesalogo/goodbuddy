# Magic Notes Progress

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
