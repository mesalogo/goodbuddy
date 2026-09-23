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
