# Desktop 0.16.13 / Agent 0.15.12

Date: 2026-11-04.

## Publication status checked on 2026-11-04

- Final release commit: `c634092bcf7ec25569606bf08edea028cbe16654`.
  The user approved tagging after its main CI run `41676361714` passed
  source validation and the production bundle. Both annotated tags were pushed
  to `origin` and `github`; neither tag was moved or reused.
- Desktop tag workflow `41682983745` and Agent tag workflow `41682983641`
  succeeded. GitHub lists Desktop `v0.16.13` as public stable Latest, published
  `2026-11-04T04:02:57Z`, and Agent `agent-v0.15.12` as public stable non-Latest,
  published `2026-11-03T17:29:28Z`.
- These are verified GitHub workflow/publication facts, not new installed-package
  or independent OSS/website acceptance results. The preparation and CI records
  below describe their respective earlier checkpoints, not the current tag state.

## Scope and approval

- Published baseline: Desktop `v0.16.12`, Agent `agent-v0.15.11`.
  GitHub reports Desktop published 2026-10-31 and Agent published 2026-10-30.
- Reviewed source range: `v0.16.12..17587e553b6018450b65388f9ee79da7710ed362`,
  plus the attachment and message-navigation fixes in this release preparation.
- User approved preparing both versions, fixing the attachment blockers first,
  six standard Desktop and three Agent targets, and no LoongArch preview.
- User approved the exact bilingual Desktop and Agent notes and preparing the
  candidate commit after checks pass. After CI passed, the user also approved
  the exact bilingual Desktop navigation-fix addition, keeping all other
  Desktop and Agent notes unchanged, and committing/pushing the final candidate
  to both `origin/main` and `github/main` for CI. Exact release SHA/tag approval
  is still separate.
- User subsequently stopped local validation and explicitly requested a push
  to GitHub to inspect CI. Prepare a branch-only commit/push for that purpose;
  this is not release authorization or a claim that local validation is green.
  Exact release SHA approval, synchronized remotes and green CI remain tag gates.
  No new release tag has been created or pushed.
- Both remote main refs were `3337bd9dc5f1d802a65f6c3962b964b5173983ac`
  at initial inspection. Source feature commits are local only at that point.
- Preserve and exclude the user's untracked
  `tests/magic-canvas-attachment.electron.mjs`. The previously excluded article
  work is now committed in `3337bd9d`; do not rewrite it.

## Verified changes

- System One decision-model connection and automatic role selection before the
  selected Runtime, with manual precedence, master-switch behavior, ten-second
  timeout, keyword fallback and persistent reply role metadata.
- Canvas file attachments, paste handling, draggable/downloadable cards and
  retained canvas mode; note/Supervisor content alignment and three-second
  success/info notifications.
- Raw attachments for local and SSH direct models. Fix local preparation to use
  a workspace copy and keep Base64 transfer data out of model prompts.
- Message navigation now focuses the committed target before a queued scroll
  frame can replace its virtualized row. Evidence and boundaries are recorded in
  [chat history progress](../features/chat-history-navigation/progress.md#2026-11-03-来源消息定位竞态).
- Agent Runtime launch errors include a bounded cause, with Desktop displaying
  allowed remote error detail. This requires Agent 0.15.12 for the daemon-side
  change, not for System One selection itself.
- Schema 65, OpenCode 1.19.3, Continue 1.5.47, Desktop DeepSeek Harness
  0.2.1-rc.2 and protocol versions are unchanged.
- Both feature lists have been reviewed and aligned; source implementation does not establish
  full installed-package acceptance. No performance-speedup claim.

## Validation

- Before the attachment fixes: both new regression tests fail for the exact
  reported defects. After the fixes: 36 focused tests pass.
- Shared Linux x64 Host: three checks pass against current source, including
  700,000-byte upload hash equality and actual model reading/history retention.
  Exactly three real text-model requests. Scope and cleanup are recorded in
  [document-processing progress](../features/document-processing/progress.md#2026-11-03-通用附件与直连模型修复).
- Typecheck and lint passed. Release-note verification
  and Desktop/Agent version consistency passed after writing the approved notes.
  No local production build, packaging, installer
  download or packaged-app probe.
- The full run exposed an Obsidian fixture assertion that required temporary
  files outside the repository, contradicting the current temp-directory rule.
  The fixture now lives under repo `temp/` and rejects dependency resolution
  outside its isolated tree. Its offline Electron check passes independently.
  The Markdown micro-benchmark also failed when run alone. It now uses three
  alternating cold/warm pairs and median timing, while retaining identical HTML,
  cache-hit/no-reparse checks and the warm-faster-than-cold criterion; all 16
  tests pass. This is a test methodology correction, not a product speedup.
- First full run: 6,922 passed, 6 failed, 91 skipped. In addition to the two
  cases above, the terminal fixture lacked the policy-settings method now used
  by automatic routing; adding it restores the production IPC/HTTP test.
  Initial isolated reruns of message expansion, workspace import and two-project/
  ten-project OpenCode reuse passed, but did not establish full-suite stability.
- Second full run: 6,926 passed, 2 failed, 91 skipped. Message expansion still
  timed out and workspace import still waited indefinitely for image decoding.
  Focus diagnostics reproduced navigation to a detached message element.
  The Renderer fix completes navigation in its layout effect. Electron fixtures
  also disable native Windows occlusion, independently poll DOM state, and
  reveal lazy-loaded images before checking decoding. Workload, native input,
  frame measurements, assertions, sandbox and timeout limits remain intact.
- Final focused run: 18 tests pass, including the 2,000/10,000-message Electron
  scenarios and production App/preload/IPC workspace import. Changed-file lint
  passes. The subsequent full local run was interrupted at the user's request;
  it is not a full pass. No further local tests will be run for this CI handoff.
- Exact-candidate main CI/production build, native release workflows and public
  GitHub/OSS/website checks remain required. A prepared candidate is not a release.

## GitHub CI handoff

- Pushed `f37a3b03d5c464bb3dda022423e63ad91ecc158f` to GitHub `main` only.
  Agent run `41626584725` and website run `41626584760` succeeded.
- Desktop run `41626584722` failed with 6,945 passed, 1 failed and 74 skipped.
  Message expansion, workspace import and Markdown cache regressions passed.
  The sole failure was `canvas-core.electron.test.ts`: the child reached its
  60-second deadline, returned zero after termination, and had not written
  `result.json`. Desktop typecheck, lint and production build did not run.
- The canvas fixture now shows and focuses its window for frame-based pixel
  checks, reports its execution phases, and checks the deadline independently
  of the process exit code. All content assertions, sandboxing and original
  timeouts remain unchanged. The exact stalled phase was not available in the
  first CI log; this change targeted the hidden-window rendering path.
- The user requested fixing and continuing through GitHub CI. No local tests
  were rerun for this follow-up, and no release tag is authorized by this step.
- Follow-up `a85d35fa53ae224fe7184f72a543f6970b8b7ff0` passed Desktop run
  `41632710745`: 6,946 tests passed, 74 skipped; typecheck, lint and production
  bundle succeeded. The canvas regression passed in 10.162 seconds with its
  original assertions and deadlines. Agent/website were not retriggered by the
  test-only follow-up; their earlier successful runs remain scoped to `f37a3b03`.
- The final notes/evidence-only commit must receive its own main-branch CI
  result before exact-SHA/tag approval. Six Desktop and three Agent native
  release targets, immutable tags and public verification remain pending.
- Notes/evidence commit `e98eb12380aae10393ee633feafcfbfe3a754ee8` was
  synchronized to both remotes. Desktop run `41655382509` failed with 6,945
  passed, 1 failed and 74 skipped: supervisor layout timed out waiting for its
  graph tab after scenario navigation. The log also showed unrelated demo
  dependency scanning and optimized-dependency reloads.
- The supervisor fixture now uses a visible window, reacquires focus after
  page loads, limits Vite discovery to its actual entry, and excludes generated
  dependency caches from React transforms. Timeout diagnostics include the
  synthetic scenario and page readiness, and an outer timeout cannot pass just
  because Electron returned zero. Scenarios, assertions, sandbox and deadlines
  are unchanged. Root-cause isolation is incomplete; the next CI result must
  verify this fixture correction. No local tests were run.
- Run `41660766955` at `4788c35535ae0cdb50c3e57c052cf1dd108d24fd`
  still failed only supervisor layout (6,945 passed, 1 failed, 74 skipped).
  The new diagnostic identified `?state=error`, a complete/visible/focused page,
  and an empty React root. Visibility and dependency scanning were therefore
  not a sufficient fix. Add explicit module/React initialization stages and
  uncaught-page/rejection diagnostics to distinguish import startup from a
  failed render before changing production code; the root cause remains open.
- Run `41667353256` at `284d39092e21358f4485b647f7c6a22627509033`
  again failed only supervisor layout. It stopped at `loading-module`, before
  fixture API setup or React scheduling, following the deliberately unresolved
  loading scenario. Each layout/state scenario now gets a fresh renderer with
  the same viewport; all scenario/error assertions and deadlines remain.
  The previous renderer is destroyed rather than carrying pending fixture work
  into the next module startup. This isolation change still needs CI.
- On 2026-11-04 the user requested including new commit
  `68bb0045de714800bc3be6c92d4bfd124227601b`. It opens canvas editors/viewers
  in Fit width, follows container resizing until manual zoom, and returns to
  Fit width when remounted. Both feature lists were reviewed and aligned.
  Validation and release tags must use the latest candidate containing it,
  not a previously successful ancestor.
- The user approved the exact bilingual Fit width note, date `2026-11-04`,
  and committing/pushing the combined latest candidate (including scenario
  isolation) to both remotes. Versions and the other Desktop/Agent notes are
  unchanged. CI success and exact release SHA/tag approval remain required.
