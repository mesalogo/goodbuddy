# Desktop 0.17.3 release preparation

Date: 2026-11-08.

## Scope and approval

- Published baseline: `v0.17.2`,
  `b37b466a768bf81e3835bfdf41502af20a238688`. Its immutable tag workflow
  `42184693186` succeeded on attempt 3; GitHub lists it as stable Latest.
- Reviewed product range through `21715d381828a0439d09080590615080bc7e376b`:
  local document references and inline presentation (`2ec842f1`), preservation
  of Runtime completion (`56a631a4`), and sending after remote recovery failure
  (`21715d38`). Before preparation, both remote main refs matched that commit
  and the worktree was clean.
- The user approved Desktop `0.17.3`, the exact bilingual notes and date
  `2026-11-08`, feature-list updates, and candidate commit/push to both remotes.
  Six standard Desktop targets only; LoongArch explicitly declined.
- Keep Agent `0.15.12`, schema 65 and existing Runtime pins. No Agent release.
  Follow the user's CI-only instruction: no local tests, typecheck, lint,
  production builds, packaging or packaged-app probes. JSON metadata and Git
  differences are checked locally; final candidate CI and production build
  must pass before separate exact-SHA/tag authorization.

## Verified behavior

- Local `@` search uses the conversation's enabled libraries and disambiguates
  names by library/path. Parsed document text is read by ID through the existing
  Desktop knowledge gateway with scoped pagination, not by copying files to
  the remote Host. Existing knowledge-tool Runtime support still applies.
- Local, Feishu and WeCom references appear inline in the composer, with
  atomic deletion and undo/redo. Sent user messages collapse generated source
  details and copy only the displayed body. Model requests and stored history
  retain the full reference text; no database migration is introduced.
- Runtime `done` remains authoritative for ordinary execution and recovery.
  Existing reducers preserve tool output/errors and mark unfinished tools
  interrupted, rather than failing the entire reply or inventing tool success.
- Failed recovery settles local task metadata as interrupted and releases the
  project send/queue gate. Remote identity, committed cursor, history and
  manual retry remain available. This does not claim remote work stopped.
  Daemon boot changes evict the unusable predecessor connection so a new
  request can acquire a fresh connection without replaying the old task.

## Agent package boundary

- Agent daemon, protocol and Runtime locks are unchanged. Shared Desktop
  contracts and the scoped knowledge-tool catalog gained `knowledge_read`;
  unlike the previous release, this is not a claim that every shared file or
  every possible rebuilt bundle byte is unchanged.
- The daemon imports `ModelToolProvider` for remote workspace tools, but creates
  it without a knowledge gateway. Its unchanged `remoteModelToolNames` and
  request schema allow only workspace read/patch/search and process execution;
  the new knowledge-read branch is not reachable through this Agent RPC.
- Knowledge-enabled remote Runtimes use the existing bridge to the Desktop
  MCP gateway and its dynamic catalog. The new tool is provided by Desktop,
  not a new daemon capability. The other two fixes are Desktop IPC/storage/
  Renderer/connection-manager changes. Hosts on `0.15.12` need no reinstall.

## Development evidence and remaining gates

- [Knowledge progress](../features/knowledge-base/progress.md) records the
  full Electron import/select/send/read/reload path, inline editing and source
  expansion, 444 final focused tests, and four external model requests during
  initial document-read acceptance. Linux Host MCP validation read five
  consecutive pages; it does not cover every third-party Runtime.
- [Unified execution progress](../features/unified-execution/progress.md)
  records 373 focused tests plus a deterministic Linux Host tool-event loss
  test for completion; recovery changes have 404 backend/persistence tests,
  8 App recovery cases, 16 queue cases and an isolated real Agent restart
  probe. The two fixes made zero external model calls and did not repeat
  installed Electron UI acceptance.
- Development typecheck/lint passed. Earlier full-suite runs in the knowledge
  record had failures, including overlay hit testing; later focused reruns
  are not reclassified as a full-suite pass. The new versioned candidate needs
  its own CI validation and production build.
- Both feature lists were reviewed and aligned with these capabilities,
  limitations and remaining gates. Published release-note history is retained.
  Six-target native packaging, public metadata/index/website checks and final
  SHA/tag approval remain outstanding.
