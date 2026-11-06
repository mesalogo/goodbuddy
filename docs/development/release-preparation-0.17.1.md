# Desktop 0.17.1 release preparation

Date: 2026-11-05.

## Publication status checked on 2026-11-06

- Final approved commit: `8474737b0f310950cf8c65ca843b961ed3c2c89a`.
  Desktop main CI `42029331862`, Agent validation `42029331747` and website
  deployment `42029331771` all succeeded.
- The user approved the exact commit and `v0.17.1`. A clean detached checkout
  preserved unrelated PR article edits. Both remote annotated tags were
  verified against the approved commit; the tag was not moved or recreated.
- Tag workflow `42033747326` succeeded on attempt 1. GitHub reports a public
  stable Latest release published at `2026-11-05T14:16:27Z`.
- These are workflow and GitHub publication facts, not independent
  OSS/website or installed-package acceptance. Earlier candidate checkpoints
  below are preserved as history. Agent remains `0.15.12`.

## Scope and approval

- Published baseline: `v0.17.0`, commit
  `de1ade225cad522039d391f70deaff4f130ef31f`. Tag workflow `41785513936`
  succeeded on attempt 3; GitHub lists it as stable Latest.
- Product range reviewed through `f2bf8d688de5b6ff7ae457d9e02e993035adcd4f`:
  note content-column editing (`c9ac1e0e`), five-second error notifications
  (`fb7c8562`), and standalone canvas attachment coverage (`f2bf8d68`).
- The subsequent `18224b3faf12c121cb6073fe458935dac6ff44cc` changes only PR
  article documentation, not product behavior. It is already on both remotes.
  The approved release notes remain unchanged.
- The user approved the exact bilingual notes, date `2026-11-05`, version and
  documentation updates, and committing/pushing the candidate to both
  `origin/main` and `github/main`.
- Six standard Desktop targets only; LoongArch explicitly declined. Continue
  using published Agent `0.15.12`, without a new Agent release.
- Preserve and exclude unrelated uncommitted PR article edits. The formerly
  untracked canvas attachment script is now intentionally tracked in the user's
  `f2bf8d68` commit.
- No local tests, typecheck, lint, builds, packaging or packaged-app probes,
  following the user's CI-only instruction. Exact new-candidate main CI and
  production build are required before separate exact-SHA/tag approval.

## Verified scope and boundaries

- New and saved text/canvas entries use the middle content column for editing.
  Adjacent navigation remains usable; new-entry controls share a header row.
  Editor identity survives expansion, long content scrolls internally, and
  successful save or confirmed discard restores reading position.
- Existing draft/save/revision safeguards remain; failed saves retain drafts.
  Draft-confirmation cards use shared styling. Error notifications dismiss
  after five seconds; success/information notifications retain three seconds.
- Canvas file attachments are already released. The new standalone Electron
  script is regression coverage, not another user-facing attachment feature.
- No Main, preload, Agent daemon, bridge, protocol, Runtime or remote lifecycle
  change is present in this range. No separate Agent fix or new Host validation
  is required for these renderer-only behaviors.
- Agent `0.15.12`, schema 65, OpenCode `1.19.3`, Continue `1.5.47`, Desktop
  DeepSeek Harness `0.2.1-rc.2` and the Node lock remain unchanged.
- Both feature lists are reviewed and aligned with the implemented behavior,
  current candidate, previous publication facts and remaining acceptance.
  The published `0.17.0` notes are retained.

## Evidence and remaining gates

- The [Magic Notes progress record](../features/magic-notes/progress.md#2026-11-05-new-entry-focus-layout)
  reports 192 focused tests, four Electron scenarios, typecheck and lint passing.
  It distinguishes earlier full-suite failures from final focused evidence.
  The scenarios cover content-column bounds, native focus/keyboard, narrow and
  themed layouts, scrolling, draft confirmation, restoration, and production
  UI/preload/IPC persistence using a deterministic model.
- The error-notification regression checks the 4,999/5,000 ms boundary and
  retained input. The standalone canvas attachment script was inspected but
  not executed in release preparation; its presence is not a validation pass.
- No local validation or external model requests were run in this preparation.
  Main CI for the versioned candidate, six native packages and public release
  checks remain pending. Earlier source-commit CI is not a substitute.
