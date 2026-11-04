# Desktop 0.17.0 release preparation

Date: 2026-11-04.

## Scope and approval

- Published baseline: Desktop `v0.16.13`, commit
  `c634092bcf7ec25569606bf08edea028cbe16654`. Its main CI and native release
  workflow succeeded; GitHub reports it as stable Latest.
- Reviewed source range: `v0.16.13..dc7b68733e8a5fe2b95ad7a103bc8c679e267f42`.
  The sole new source commit fixes Windows update installation progress.
- The user requested Desktop `0.17.0` and approved the exact bilingual notes,
  date `2026-11-04`, version/feature-list updates, and a candidate commit/push to
  both `origin/main` and `github/main` for CI.
- Six standard Desktop targets only; the user explicitly declined LoongArch.
  Agent remains the published `0.15.12`; no new Agent release or tag.
- Continue the user's CI-only validation instruction: no local tests,
  typecheck, lint, production build, packaging, or packaged-app probes.
  Main-branch CI must validate the exact new candidate and production bundle.
  Exact release SHA/tag approval remains separate; no `v0.17.0` tag yet.
- Preserve and exclude the user's untracked
  `tests/magic-canvas-attachment.electron.mjs`.

## Verified change and compatibility

- Windows NSIS Restart and update now displays native installation progress
  and launches the new version after installation. The installer also restores
  visible progress for released clients using `/S --updated --force-run`.
- A single existing installation keeps its install scope; when user-level and
  all-users installations both exist, the installer retains the scope choice.
  Normal first-install completion behavior is unchanged.
- The change is classified as a fix to the existing Windows update workflow,
  not a new automatic-update capability for other formats or platforms.
- No Agent daemon, bridge, protocol, Runtime or remote installation change.
  The only Main change is local Windows installer launch arguments/window
  visibility; existing shutdown coordination and remote lifecycle are unchanged.
  No new real-Host validation is required for this Desktop-only change.
- Schema 65, OpenCode `1.19.3`, Continue `1.5.47`, Desktop DeepSeek Harness
  `0.2.1-rc.2`, Node and Agent locks remain unchanged.
- Both `FEATURES.md` and `FEATURES.zh-CN.md` were reviewed and aligned with the
  new behavior, current versions, previous publication facts and remaining
  acceptance limits. The published `0.16.13` release-note entry is preserved.

## Validation evidence and remaining gates

- The source commit's [desktop-update progress record](../features/desktop-updates/progress.md#2026-11-04更新安装进度窗口)
  records real isolated small-payload Windows x64 NSIS validation for both the
  production launcher and released-client arguments, two visible-window samples,
  existing-path/data preservation, automatic relaunch and cache cleanup.
  It also records 23 focused tests, typecheck and lint passing, with test
  installation/registry/temp cleanup completed.
- This release-preparation session has not rerun those checks. Full-payload
  upgrade timing, all-users elevation and ARM64 upgrade acceptance remain
  unverified; neither small-payload validation nor native packaging establishes
  those results.
- Exact-candidate main CI, six native release packages and public release/index
  verification remain pending. No external model calls were made in preparation.
