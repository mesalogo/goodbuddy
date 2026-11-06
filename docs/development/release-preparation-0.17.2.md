# Desktop 0.17.2 release preparation

Date: 2026-11-06.

## Scope and approval

- Published Desktop baseline: `v0.17.1`, commit
  `8474737b0f310950cf8c65ca843b961ed3c2c89a`. GitHub reports stable publication;
  its tag workflow `42033747326` succeeded.
- Product change: `af953a6817db78603bfd35cacf1ddf7f5266f374` repairs
  Desktop-side remote-task recovery and diagnostic detail. The intervening
  AgentOS/ShareServer announcement is documentation of direction, not a new
  shipped capability.
- Local commit `3c6532ffd89458cfe4c4e0f85a3e690aee319958` already changes
  Desktop and both package-lock root versions to `0.17.2`.
- The user approved the exact bilingual notes, date `2026-11-06`, feature-list
  updates and candidate commit/push to both `origin/main` and `github/main`.
  Six standard Desktop targets only, no LoongArch, no new Agent release.
- Continue CI-only validation: no local tests, typecheck, lint, builds,
  packaging or packaged-app probes. Require the new candidate's main CI and
  production bundle before separate exact-SHA/tag approval.

## Why Agent stays at 0.15.12

- `build/agent-bundle.cjs` bundles the CLI at `src/agent-daemon/cli.ts`.
  The daemon, shared protocols, Agent/Runtime package tooling and locks have
  no change relative to `agent-v0.15.12`.
- The changed `AcpRemoteRuntime` and `remote-task-recovery` are Desktop client
  implementations. Their callers are Desktop IPC and managed remote Runtime
  composition, not the daemon CLI. `desktop-diagnostics` records/export also
  belong to Desktop. The daemon's shared Main helpers do not use these changed
  client recovery implementations.
- Existing Agent-owned operations and transcript APIs already support the
  repaired attach path. This is not a new protocol or Agent runtime behavior;
  Hosts already running `0.15.12` need no reinstall for this fix.
- Schema 65, OpenCode `1.19.3`, Continue `1.5.47`, Desktop DeepSeek Harness
  `0.2.1-rc.2`, Node and Agent locks remain unchanged.

## Behavior and evidence

- A closed or stale cached channel is discarded before reattachment. The
  original accepted operation and committed transcript cursor survive; no new
  Prompt is submitted, including after a lost start response. Existing retry
  bounds, explicit cancellation and terminal identity failures are retained.
- Desktop diagnostic exports retain allowlisted reason/method/RPC-code fields,
  including wrapped causes, without raw messages, response bodies, paths or
  credentials. Old records cannot retrospectively establish incident causes.
- Authoritative development evidence is in
  [unified execution progress](../features/unified-execution/progress.md#2026-11-06-real-provider-recovery-and-direct-model-acceptance):
  current-source Linux x64/OpenCode recovery, controlled closed-channel and
  lost-response scenarios, and four actual provider requests. The real ACP
  recovery used one Prompt start and one attach; three other requests validated
  the ordinary remote direct-model path, not interrupted direct-write resumption.
- Final directly changed suites recorded 152 passing tests; typecheck/lint
  passed. The earlier full run recorded 6,932 passed, 98 skipped, two failed
  tests and one failed suite setup across three files. Those failures are not
  silently reclassified as a full pass. Installed Desktop UI acceptance and a
  physical outage during provider generation remain unverified.
- Release preparation checked JSON metadata and Git differences without local
  source validators or external model calls. Exact-candidate CI, six-target
  native packaging and public checks remain
  pending. Both feature lists were reviewed and aligned; published `0.17.1`
  release notes are preserved.
