# Desktop 0.16.12 / Agent 0.15.11

Date: 2026-10-30.

## Scope

- Published baseline: Desktop `v0.16.11`, Agent `agent-v0.15.10`.
- Product range: `816be29b` through `4b5b3b54` after the published baseline.
- Main areas: Playwright-managed browser automation, local message editing and
  branching, Office selection AI and safe writeback, Windows Desktop update
  download/install handoff, workspace file icons and Windows file links, message
  actions and dates, WeCom/device-sharing polish, and remote initialization
  recovery.
- Agent `0.15.11` is required for remote ACP initialization and recovery
  changes, tool-failure terminal handling, and Agent lifecycle behavior.
- Database schema and Runtime pins are unchanged: OpenCode `1.19.3`,
  Continue `1.5.47`, Desktop DeepSeek Harness `0.2.1-rc.2`.
- Workbench demos, release article edits, and other uncommitted user work are
  excluded. No LoongArch build or publication.

## Validation boundaries

- Existing commit evidence includes focused tests, typechecks, scoped lint,
  Linux Host probes, Office Electron/ShareServer checks, and isolated Windows
  NSIS update probes as recorded in the owning feature progress documents.
- Full package acceptance remains subject to candidate CI and native matrix.
  Automatic update installation currently targets Windows NSIS only.
- Exact candidate CI, release-note validation, and public release checks remain
  pending. Do not create tags before the final exact commit and notes are
  approved.
