# Desktop 0.13.13 Preparation

Prepared on 2026-09-23 from `b16fc90`, relative to published Desktop `v0.13.12`.
This is a Desktop-only release; Agent remains at published `0.13.3`.
No LoongArch preview is requested.

## Scope and isolation

- `bf8ff7f` reduces repeated activity-history reads during streaming saves.
- `b16fc90` restores compact supervision feedback controls and target names.
- The candidate is prepared in a separate worktree. The user's uncommitted
  supervision timeout tests in the original worktree are explicitly excluded.
- Desktop and both root lockfile versions are `0.13.13`. Both feature matrices
  and bilingual release notes were reviewed against this range.
- Database schema and Agent/Runtime contracts are unchanged. The activity
  comparison cache belongs to Desktop persistence; it does not modify the
  deployed Agent, model bridge, or remote Runtime lifecycle.

## Validation

- Six focused files passed 192 tests: activity-history I/O, AssistantDatabase,
  storage upgrades, sidebar interactions, SupervisionCard, and the Supervisor
  Electron layout fixture.
- Re-running `tests/supervisor-layout.electron.test.ts` with
  `GOODBUDDY_SUPERVISOR_SIDEBAR=1` passed its additional sidebar scenario:
  480, 300, and 200 pixel widths in both themes, no horizontal overflow,
  compact 34px buttons, visible keyboard focus, and no raw target ID in body text.
- `npm run release:notes:verify`, `npm run typecheck`, and `npm run lint` passed.
- Ten consecutive activity saves performed one full-history scan. WAL and SQL
  counters are not installed-application physical disk throughput measurements.
- No real model requests, local full-suite rerun, production build, packaging,
  or packaged-app probe were performed. UI validation uses production
  components with isolated fixtures, not a real user database.

The candidate must pass complete main-branch CI and its production build before
an unused annotated `v0.13.13` tag is pushed to both remotes. Native six-platform
packaging and public GitHub/OSS verification remain subsequent release steps.
