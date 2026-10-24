# Desktop 0.16.10 / Agent 0.15.9 release preparation

Date: 2026-10-25.

## Scope

- Published baseline: Desktop `v0.16.9`, Agent `agent-v0.15.8`.
  Desktop run `40074966761` succeeded after a same-tag Apple CloudKit
  network-failure rerun; GitHub reports publication at 2026-10-24T11:25:55Z.
  Retain the published 0.16.9 notes.
- Product range: `704e1df0` through `bfa37895` after `v0.16.9`.
- Interactive conversation HTML previews, unknown direct sender ID hints,
  OCR configuration organization and partial saves, platform workspace saving,
  page-tab and chat/sidebar polish, active-time story spiral, readable story
  graph MCP results, Windows ARM64 native Program Files default, and
  electron-builder 26.18.0.
- File-opening design documents do not mean Office editing is implemented.
  Uncommitted Office preview documentation/demo remains user work and is excluded.
- Database schema stays 65. OpenCode 1.19.3, Continue 1.5.47, and Desktop
  DeepSeek Harness 0.2.1-rc.2 are unchanged. Feishu and WeCom remain Preview.
- Agent 0.15.9 is required because `src/agent-daemon/image-tool-mcp.ts`
  bundles changed shared story graph tool descriptions and context arguments.
  History reading itself stays in Desktop. No protocol version change.
- Both feature lists were reviewed and updated for these changes and boundaries.

## Notes and authorization

Candidate bilingual notes are in `resources/release-notes.json` and
`resources/agent-release-notes/0.15.9.md`.
The user requested preparation without intermediate questions. No LoongArch
build was requested. Exact-commit and bilingual-note approval is still required
by the repository release rules before creating either immutable release tag.
Do not treat unattended preparation as approval of an as-yet unknown commit.

## Validation boundaries

- Existing feature evidence: conversation HTML Electron regression coverage;
  OCR save/layout tests; story graph 123 focused tests and 6 IPC tests,
  Node/Agent type checks and scoped lint in the owning progress documents.
- Historical story graph model comparisons are not new release-time calls and
  do not establish complete answer accuracy or installed-Host acceptance.
- No current-source shared Linux Host acceptance for the new story graph tool
  descriptions is recorded in that progress entry. This remains a release
  validation gap; native CI is not a substitute.
- Use candidate branch CI for full validators and production bundle, following
  the user's prior preference. Do not run local production builds or packaging.
- Candidate CI, native release jobs, and public verification remain pending.
