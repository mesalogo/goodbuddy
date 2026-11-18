# Desktop 0.18.1 recovery preparation

## Scope and approval

- Carry forward the complete product scope and bilingual notes from
  [0.18.0 preparation](./release-preparation-0.18.0.md), based on published
  `v0.17.5` through `219a2182a402e927154415a4620c9671553f6bd3`.
- The user approved Desktop `0.18.1`, the exact unchanged bilingual note body
  under the new version, date `2026-11-17`, and removal of the unpublished
  `0.18.0` packaged entry. Published older release history remains unchanged.
- GitHub-only candidate commit/push is approved. Six standard Desktop targets,
  no LoongArch. Pi exploration remains excluded and untouched in the original
  checkout. Final recovery SHA and `v0.18.1` still need separate approval.
- Keep immutable `v0.18.0` and published `agent-v0.15.15`. No Agent source,
  lock, package, notes, protocol, Runtime or catalog changes are included.
  Agent minimum Desktop `0.18.0` also permits the recovery Desktop `0.18.1`.

## Failure and bounded repair

The Desktop tag workflow failed twice at the same eighth file-layout scenario:
non-Git, dark theme, 640×420. The first seven geometry/input/retention scenarios
completed and no renderer errors were captured. The exact source's earlier
main CI had passed all 16 scenarios. This is not proof of a product layout bug
or a confirmed runner-only cause.

The driver now re-establishes window/page focus and waits for the requested
dimensions after each navigation, following the existing
[asynchronous UI test rule](../quality/recurring-defects.md#异步界面测试只等待部分状态).
Timeout diagnostics include page URL parameters, readiness, visibility, focus,
dimensions, row count and bounded synthetic fixture text. Product code, all
16 scenarios, native input, sandboxing, geometry/retention assertions and
existing timeout limits remain unchanged.

## Validation and remaining gates

- User authorized targeted local source Electron tests only; ordinary full
  validators remain CI-only. No local production build or packaging ran.
- Windows x64 / Electron `44.5.1`: initial isolated-worktree setup lacked the
  relative icon-asset path and failed the icon check. Linking the existing
  dependency fixed the setup without changing source or that assertion.
- Baseline then passed all 16 scenarios in 23.947 s. The synchronized driver
  passed all 16 in 29.384 s. These are functional checks, not performance claims.
  The Linux timeout was not reproduced on Windows; local WSL is unavailable.
- Linux root cause and repair effectiveness remain subject to the recovery
  candidate's full CI. Do not claim the two failed tag attempts are resolved
  until the new candidate passes the affected scenario.
- No additional model calls. Earlier current-source Host evidence remains
  applicable because no deployed Agent or Runtime code changed.
- Require exact-candidate validators and production bundle before final tag
  approval, then six native packages, macOS signing checks, publication steps,
  20 GitHub assets, OSS metadata and live website link verification.

## Outcome

[Main CI](https://github.com/mesalogo/goodbuddy/actions/runs/44124972507)
passed all 16 file-layout scenarios, the full test suite (7,097 passed, 78
skipped), typecheck, lint and the production build at `75be3dd852159b848faa718153e57abd01ad7fc4`.
The user then approved the immutable `v0.18.1` tag at that commit.
[Tag validation](https://github.com/mesalogo/goodbuddy/actions/runs/44130984423/job/134207655757)
still timed out on the non-Git, dark, 640×420 scenario: the window had the
requested dimensions and focus, but `#root` had no children. Packaging and
publication were skipped. The tag is unchanged; see [0.18.2 recovery](./release-preparation-0.18.2.md).
