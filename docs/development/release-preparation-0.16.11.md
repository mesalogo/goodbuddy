# Desktop 0.16.11 / Agent 0.15.10

Date: 2026-10-26.

## Scope and authorization

- Published baseline: `v0.16.10` / `agent-v0.15.9`.
- Product source endpoint: `5d1e01889b01d0e6035abf34283ec02f9495704f`;
  both remote main refs matched and worktree was clean before preparation.
- User approved the exact bilingual Desktop and Agent notes and paired candidate
  preparation. No LoongArch build or publication. Exact final commit approval
  remains required before tags.
- Office tabs, six-format entries/conversion, Word selection AI, reusable
  ShareServer connections, device credentials/approval states, remote direct
  models and recovery, chat dates/minimap markers and appearance fixes.
- Agent changes include direct tools, bundled ripgrep, runtime binding retirement
  and workspace write support. Updated Desktop and Agent are required.
- Schema 65 and Runtime versions remain unchanged: OpenCode 1.19.3,
  Continue 1.5.47, Desktop DeepSeek Harness 0.2.1-rc.2.
- Both FEATURES lists reviewed and corrected: Office is no longer design-only,
  device sharing is no longer described as unauthenticated, and candidate
  versions and incomplete acceptance are explicit.
- Workbench UI demos, local Office preview demos and OpenCode v2/Droid
  marketplace plans are not shipped product capabilities.

## Development evidence and boundaries

- [Remote direct model evidence](../agent-runtime/providers/direct-model/progress.md):
  shared Linux x64 current-source tools, subtask workspace ownership, 120 KB
  output, cancellation and connection reuse; three real text-model requests.
  Desktop owns model execution, not autonomous ACP execution after exit.
- [Remote lifecycle evidence](../features/unified-execution/progress.md):
  real cumulative channel-budget exhaustion, reconnect to the original lease,
  active OpenCode recovery with one prompt start, readiness before terminal;
  final 426 focused tests plus two real-Host direct model tests. Loopback model
  responses for the recovery probes, zero external model requests.
- [Office evidence](../features/office-document-editing/progress.md):
  Linux Electron keyboard writeback, conflicts, Save As and DOC preservation;
  Host protocol and server-side six-format tests. Word AI used deterministic
  model endpoints; external-provider quality, complex fidelity, remote Save As
  UI and complete three-platform installed acceptance remain outstanding.
- [Device sharing evidence](../features/device-sharing/progress.md):
  real IP-based service registration/approval and restart, plus Electron
  registration/publication/revocation. No content synchronization or remote
  execution claim.
- Prior full-suite and lint failures remain historical evidence, not passes.
  Exact candidate full validation and production build must pass in CI.
  No new local production build or packaging is requested.

## Release checks

Initial candidate `774fce43` failed Desktop run `40215520250` on a stale
project-menu divider-color assertion; Pages `40215520240` passed.
Agent run `40215520272` failed all three targets because the new executable
`rg` was still classified as a 0644 data file. The correction must cover both
bundle manifests and the production control-plane installer, not just packaging.
Approved user-facing notes remain unchanged. Tags have not been created.

Subsequently the user requested inclusion and pushing of commits `915adf7d`,
`2f66f4fb`, and `c4cbd704`: transcript batching, prepared Continue cache reuse,
and WeCom authorized-human identity parsing. Notes now add those changes and
require renewed approval with the final exact SHA. Uncommitted PR-article edits
are excluded. Cache validation includes three alternating Linux Host rounds,
cancellation/sibling isolation and one real model request, recorded in
`docs/architecture/runtime-storage.md`; no overall hardware performance claim.

CI corrections: 17 Agent manifest tests and 31 compound/build/Electron tests
passed, with one opt-in skip. Agent compound fixtures now also contain executable
`rg` to exercise production installer permission validation. Shared Host SSH
responded, but Node was not on PATH and subsequent discovery was cancelled by
the user; no new remote installer check is claimed.

The executable compound fixture exposed the third copy of the permission rule
in shared Agent installation contracts. All three readers now accept root `rg`
as 0755; other data files retain 0644. Final manifest/compound regression:
41 passed, one opt-in skip; changed-file ESLint, notes and diff checks passed.
Production packaging already declares the current Desktop version as its minimum,
so Agent 0.15.10 requires Desktop 0.16.11 for the updated reader.

- Version consistency, bilingual note validation and diff checks: passed.
- Candidate CI and exact commit approval: pending.
- Immutable paired tags, six Desktop / three Agent native builds and public
  GitHub/OSS verification: pending.
