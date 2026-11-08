# Desktop 0.17.4 and Agent 0.15.13 release preparation

Date: 2026-11-08.

## Scope and approval

- Published baselines: Desktop `v0.17.3` at
  `ace8e52337a59be84d6aabb6b01b95fb8789ccc7`, and Agent `agent-v0.15.12`.
  Desktop tag workflow `42451154833` succeeded on attempt 1 and GitHub reports
  stable Latest publication at `2026-11-08T06:27:42Z`.
- Reviewed new Desktop range through
  `ff4bbe0eab0fc82719a6c487cea6ea31d2fe381f`: DSH update/startup fix
  `ee5b507c`, task-progress synchronization `ff4bbe0e`. Both commits were local
  at preparation start; both remote main refs still matched `v0.17.3`.
- The user subsequently committed and explicitly included
  `9fb3e23000cf9224f08c8d8538df698d5ca28a4e`, adding real-provider recovery and
  follow-up validation. Its three-file diff changes only probes/evidence,
  not production behavior; the approved bilingual notes remain unchanged.
- The user approved Desktop `0.17.4`, Agent `0.15.13`, their exact bilingual
  notes, date `2026-11-08`, metadata/feature-list updates and pushing the two
  source commits plus preparation to both remotes for CI.
- Desktop: standard six targets only, no LoongArch. Agent: Linux x64/arm64 and
  Darwin arm64, independent signed compound packages and non-Latest release.
  Final exact-SHA/tag approval remains separate for both immutable tags.
- Continue CI-only release preparation: no local tests, typecheck, lint,
  builds, packaging or packaged-app probes. Local JSON and Git difference
  checks do not substitute for candidate CI.

## Product scope and Agent requirement

- Task synchronization uses existing attach/page/ACK RPCs without reopening
  or resuming the old ACP execution channel. Persisted epoch is metadata,
  progress-reader disposal does not close execution, and a new message opens
  an execution channel. No new RPC, schema or recovery state machine.
- Agent attach resolves the durable task before its in-memory binding.
  Terminal results remain readable without that binding; live attachment
  preserves connection ownership/lifetime for questions and cancellation.
  Host/controller identity checks remain. This does not recreate a lost process.
- This release changes deployed `src/agent-daemon/runtime-acp-backend.ts`,
  unlike the two preceding Desktop-only recovery releases. Both Desktop and
  Agent must include the fix for terminal synchronization without a binding.
  Update Host Agent to `0.15.13`; the existing publication workflow derives its
  minimum Desktop version from package.json, therefore `0.17.4`.
- The Agent baseline range also includes Desktop knowledge contracts/catalog
  added for `0.17.3`. Remote workspace tool RPC remains limited to its existing
  workspace/process allowlist; knowledge reading uses the Desktop MCP bridge.
- Controlled Harness and native DS Web use DSH `0.2.2-rc.1` and Cordis `4.1.0`.
  The build bundles `cross-spawn`, mounts the native tool executor and awaits
  core dependencies before accepting sessions. DSH remains an upstream RC
  and desktop-local; managed SSH does not expose DSH.
- Schema 65, OpenCode `1.19.3`, Continue `1.5.47`, Node `24.19.0` and Agent
  protocol versions remain unchanged. Published notes are retained.

## Evidence and remaining acceptance

- [Remote progress](../features/unified-execution/progress.md) records
  250 focused tests and two current-source Linux x64/OpenCode faults
  (closed channel and lost start response). Each had two connections, one
  progress reader, one attach and one Prompt start; external model calls: 0.
  The successful fixture used a dedicated current-source CLI after initial
  helper-layout failures. This is not installed UI or physical outage acceptance.
- That full repository run recorded 6,975 passed, 93 skipped and two failed
  Electron cases: message edit/history focus and local knowledge composer text.
  Later typecheck/lint passed. Do not report the final source full suite green.
- The added real-provider record validates current-source Agent/OpenCode over
  the shared Linux Host: held response delivery, relay loss and task-only
  synchronization completed the original request, then an explicit next message
  completed on an execution channel. Counts: two connections, three channel
  objects including one progress reader, one attach, two explicit Prompt starts,
  two provider HTTP 200 responses. An earlier setup made one additional model
  request attempt without a recorded response and failed before fault injection.
  This is controlled delivery, not physical outage or installed UI acceptance;
  the added scripts passed typecheck/lint, not a new full-suite run.
- [Harness progress](../agent-runtime/providers/deepseek-harness/progress.md)
  records a separate full run with 6,976 passed and 93 skipped, typecheck/lint
  and development build success, actual built Host cold-history/restart smoke,
  two real-model turns and seven staged native Web tests. These do not establish
  full installer/ASAR or all-platform acceptance, nor the cause of every user's
  old-versus-new conversation symptom.
- Preparation makes no new model calls or local source validation runs.
  Both feature lists are aligned with the changed recovery contract, Agent
  requirement and DSH version; previous release facts are recorded separately.
- Require the exact candidate's main validators/production build and three
  native Agent checks before tag approval. Native publication, signing,
  approved bodies, artifact metadata, OSS indexes/catalogs and live website
  verification remain pending.
