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

- Version consistency, bilingual note validation and diff checks: passed.
- Candidate CI and exact commit approval: pending.
- Immutable paired tags, six Desktop / three Agent native builds and public
  GitHub/OSS verification: pending.
