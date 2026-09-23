# Desktop 0.13.12 and Agent 0.13.3 Preparation

Prepared on 2026-09-23 on `main`. This record describes a local candidate, not a
published release. Desktop notes are in `resources/release-notes.json`; Agent
notes are in `resources/agent-release-notes/0.13.3.md`. Both are bilingual drafts
awaiting approval with the exact candidate commit before tagging.

## Scope

- Desktop baseline: `v0.13.11`, including all nine subsequent commits through
  `83a48a4` and the reviewed working-tree changes.
- Agent baseline: `agent-v0.13.2`. The Agent changes reclaim idle Runtimes and
  drain displaced Agents; the Desktop Continue path restores conversation
  history when reopening a Runtime.
- Desktop package and both root lockfile versions are `0.13.12`.
  `agent-runtime-lock.json` is `0.13.3`. Agent package tooling derives the minimum
  Desktop version from `package.json`. Node, OpenCode, and Continue locks are
  unchanged at `24.19.0`, `1.18.29`, and `1.5.47`.
- Both feature matrices were reviewed and updated for versions, Supervisor
  default-off behavior, implemented reviews/graphs/activity/incremental input,
  remaining supervision work, and release acceptance limits.

## Local Validation

`npm run release:notes:verify`, `npm run typecheck`, and `npm run lint` passed
after the final source changes. Focused runs cover 35 distinct test files and
690 passing tests; 403 tests were excluded by the IPC/App name filter.

| Group | Files | Passing Tests |
| --- | ---: | ---: |
| Supervisor, settings, bridge, and release-note suites passing in the initial run | 14 | 157 |
| Database, migration, activity I/O, note storage, menu, and sidebar suites after fixes | 6 | 209 |
| IPC/App filtered by `supervision\|Supervisor\|heartbeat\|application enable\|graph navigation` | 2 | 16 |
| Agent CLI, daemon, Runtime backend, Desktop ACP, transport, and connection manager | 7 | 207 |
| Usage, duration, workspace, Markdown, and Supervisor Electron layout | 6 | 101 |

The initial focused run had 25 failures: 22 synthetic legacy database fixtures
retained schema-46 objects, two menu assertions assumed Supervisor was enabled,
and one browser close retry left its earlier error visible. Fixtures now remove
the new objects before simulating older versions, menu tests follow the saved
enabled preference, and a successful browser close clears its scoped error.
All affected suites passed on rerun. Production migration behavior was not
changed to accommodate synthetic fixtures.

The Electron layout test uses production components with isolated fixtures,
including 1440, 1024, and 390 pixel widths and light/dark themes. It is not a
packaged-app probe or a real-user database acceptance test.

No real model requests were made during this preparation. Existing development
evidence records eight requests on the shared Linux x64 Host for remote lifecycle
checks and three for incremental review. The remote evidence does not repeat
Continue real-Host validation, the complete signed installation flow, or the
native architecture matrix. See
[remote lifecycle evidence](../features/remote-host/technical-design.md#生命周期验证2026-09-23)
and [incremental review evidence](../features/conversation-supervision/progress.md#2026-09-23-自动增量验证).

## Pending Release Work

The user requested no further full local suite. Full main-branch CI validation
and its production build remain required before tagging; native Desktop and
Agent packaging and publication verification remain pending. No local production
build or package was run. No push, tag, remote synchronization, or publication
was performed during preparation. Approval must identify the exact candidate
commit and both bilingual note files before either release tag is created.

## Approved Candidate CI Attempt

The user approved `bf8ece05902509411454b27b742ebfec930005ad` and both bilingual
note files. On 2026-09-23 that exact commit was fast-forwarded to `main` on
`origin` and `github`; both remote refs were verified. GitHub SSH stalled, so
the GitHub push used HTTPS with the existing GitHub CLI keyring credentials.
No persistent Git configuration was changed. GitHub reported the account's
existing pull-request-rule bypass for this requested direct push.

- [Desktop main CI](https://github.com/mesalogo/goodbuddy/actions/runs/35849362694)
  failed in the full suite: 4 files failed, 418 passed, 13 skipped; 10 tests
  failed, 4,997 passed, 43 skipped. Type checks, lint, and the production build
  did not execute after the test failure.
- [Agent main CI](https://github.com/mesalogo/goodbuddy/actions/runs/35849362799)
  passed source validation and native Linux x64, Linux arm64, and Darwin arm64
  deterministic compound-package verification with ephemeral test signatures.
- Neither release tag was created or pushed. No Desktop or Agent publication
  workflow was started, and no production release assets were verified.

The follow-up changes are limited to tests. Two IPC tests clear the startup
settings-read count before measuring interactive request lookups. The settings
failure UI test now expects Supervisor to remain disabled. OpenCode isolation
tests prepare their real configuration dependencies in a dedicated temporary
directory instead of relying on a prior local package preparation; connection
failures now include their diagnostic detail. The large activity-list and
multi-page navigation and external knowledge binding tests have explicit
15-second budgets; the binding test also waits up to five seconds for its
resulting heading.
Its snapshot fixture now selects by library ID, and its instance list remains
available during polling instead of assuming a fixed number of asynchronous
reads. Both mocks reset between tests; the binding test waits for the
selected-library read.
These budgets address timeouts observed in the full CI run without removing
assertions or changing product behavior.

The approved source and bilingual notes remain unchanged. These test changes
need a revised candidate commit and approval before another release attempt;
the failed commit must not be tagged. No local production build, package,
external model request, or LoongArch build was performed.

Follow-up validation: the seven selected IPC/UI regression cases and all seven
OpenCode isolation cases passed locally. Type checks and lint passed. Full
remote CI and the production build still require a new approved commit; these
focused results do not satisfy that release gate.

## Linux Executable Path Follow-up

On 2026-09-23, local `main` was fast-forwarded from `163e245` to
`073aa45a30efe99fab7a92f8aee2a36087db9c2a` after inspecting the four intervening
commits. They update only the community QR codes in the two README files.
The user authorized retaining these changes, fixing CI, pushing both remotes,
and publishing Desktop `v0.13.12` and Agent `agent-v0.13.3` after successful
candidate CI without another approval round. No LoongArch preview is requested.

[Desktop CI 35854792610](https://github.com/mesalogo/goodbuddy/actions/runs/35854792610)
reported 5,004 passing tests, three failures, and 43 skipped tests. All three
failures were in the real OpenCode isolation test. It constructed
`opencode-ai/bin/opencode` on Linux, but OpenCode 1.18.29 installs its npm
executable as `bin/opencode.exe` on every platform. The test now reuses
`resolveBundledRuntimePaths`, the existing production resolver, instead of
constructing a platform-specific filename. Production Runtime code and both
release-note files are unchanged.

Local follow-up validation passed all nine tests in
`opencode-selection-isolation.test.ts` and `bundled-runtimes.test.ts`, including
the existing Linux development-path assertion, plus full type checks and lint.
Release-note and package/lockfile version validation passed. The isolation
tests made two requests to their local mock endpoint and zero real model
requests. No full local suite, production build, package, or real-Host check
was run for this test-only fix; it changes neither deployed Agent code nor
the Desktop-to-Agent production path. Successful Linux main-branch CI and
its production build remain required before tagging.
