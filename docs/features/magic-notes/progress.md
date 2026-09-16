# Magic Notes Progress

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
