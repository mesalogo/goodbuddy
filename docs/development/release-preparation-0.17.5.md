# Desktop 0.17.5 / Agent 0.15.14 release preparation

Approved release-note date: 2026-11-11.

## Scope and approval

- Published baseline: `v0.17.4`,
  `b092d37c988e6e24d6df4cb00890ecd701cc2a21`. Desktop and Agent `0.15.13`
  tag workflows succeeded and both releases are public; Desktop is Latest.
- Reviewed range through `9c46429278ce5a7cd5e6d2e91eed33f29aef04cd` includes
  seven product commits: DingTalk QR (`db63ba19`), note toolbar (`4be41292`),
  remote follow-up (`5f47968a`), Office authentication (`0b4bde42`),
  ShareServer model imports (`752309b8`), remote ASR (`4925a10f`) and continuous
  canvas/media saves (`9c464292`), plus merge `8c4d6ee5`.
- The user requested a branch push first. GitHub was already at this HEAD;
  origin was synchronized and both remote main refs were verified. Worktree clean.
- The user then approved Desktop `0.17.5`, exact bilingual notes dated
  `2026-11-10`, DingTalk QR Preview wording, version/feature-list updates and
  candidate commit/push to both remotes. Six standard Desktop targets only;
  LoongArch declined. That initial approval kept Agent `0.15.13`; this decision
  is superseded by the expanded scope below, not by a published release.
- Expanded source range: `v0.17.4..bae5152360d26b30c63e3302e02c7280e35df6bd`.
  After preparation commit `8cac9a2e`, three product commits add graph source
  context (`121a7e17`), Agent provider-failure handling (`b66fc07a`) and member
  registration/server-hosted personas (`bae51523`).
- The user approved Desktop `0.17.5` plus Agent `0.15.14`, the exact additional
  bilingual notes and replacement upgrade notice, and the date `2026-11-11`.
  The original four feature and three fix items stay verbatim; published
  release history is preserved. Agent notes are independently approved in
  `resources/agent-release-notes/0.15.14.md`.
- Retain six standard Desktop targets and no LoongArch. Agent has Linux x64,
  Linux arm64 and Darwin arm64 production targets, with a separate non-Latest
  release. Neither final candidate SHA nor either tag has been authorized.
- GitHub main was verified at `bae51523`; origin SSH reads and the requested
  push failed with connection closure. Last verified origin main is `8cac9a2e`,
  not proof of its current ref. The user explicitly approved pushing the new
  candidate to GitHub for CI first, then synchronizing origin after recovery.
  Do not tag until both remote main refs match the approved final candidate.
- CI-only validation remains requested: no local tests, typecheck, lint, build,
  packaging or packaged-app probes. JSON metadata/Git checks are not source
  test passes. Exact candidate main validators and production build must pass
  before separate final SHA/tag approval.

## Verified behavior and boundaries

- Canvas reader/editor switch paged/continuous views without changing content.
  Nearby previews surround one live editor; PDF display uses zoom/screen density
  while annotations/export retain logical coordinates. Note headers keep save/
  cancel visible. Media updates reuse unchanged assets and delta responses;
  analysis starts from committed content after save acknowledgement.
- Remote ASR uses an explicitly configured compatible service, encrypted key,
  language and recording test. Local recognition stays default; result streaming
  is off by default and begins after full audio upload, not while speaking.
  Final text goes to the original draft without sending; audio leaves Desktop
  for that configured service. Cancellation/errors do not append partial results.
- ShareServer model import is an explicit registered-device action. It imports
  endpoint/model configuration, not a key, preserves defaults/duplicate entries
  and has no automatic updates. Office uses device authentication for upload,
  editor API and saving; open views keep their original server/credentials.
  Both require a compatible server; this is not administrator login.
- DingTalk QR registration saves/enables through the existing channel manager,
  with manual credentials retained and sender IDs configured separately.
  Live phone authorization/messaging remain unverified, hence Preview.
- Remote follow-up after Runtime eviction avoids an unused binary registration;
  Agent-owned execution uses existing task RPCs, while direct ACP keeps its
  binary transport. No prior task is replayed.
- Graph source reads default to the current complete message. Optional before/
  after counts select same-conversation messages, with shared body pagination.
  Explicit snapshot mode retains historical excerpts; unavailable current
  content never silently falls back. Existing scope and graph switches apply.
- Device registration supports anonymous and member-account modes. Compatible
  ShareServer owns persona configuration, model/knowledge/access selection,
  editing, pause and withdrawal. Hosted execution works while the publisher
  is offline; publication does not automatically upload local content or keys.
  The current client offers standalone text Q&A, not persisted multi-turn chat.
- Agent retries only confirmed pre-connection errors, at most twice (250 ms
  and 1 s backoff), under the same call identity, cancellation and total
  deadline. Uncertain delivery or interrupted responses are not retried.
  Task termination retains the gateway error; diagnostic phase and allowlisted
  transport codes exclude request content and credentials.

## Agent and data compatibility

- The initial no-Agent-bump assessment was correct only through `9c464292`.
  `b66fc07a` changes the deployed Agent model gateway, ACP backend, diagnostic
  event selection and process stop reason. These fixes require a new compound
  Agent package; the lock advances to `0.15.14`. Its production catalog derives
  minimum Desktop `0.17.5` from package.json. Upgrade Desktop, then the Host.
- There is no new Agent RPC or protocol version. Note storage remains
  Desktop-owned, including remote MCP callers; ASR and ShareServer requests
  run from Desktop. Shared graph-tool definitions accompany the source update.
- Schema 65 and pins remain unchanged: OpenCode `1.19.3`, Continue `1.5.47`,
  DSH `0.2.2-rc.1` (upstream RC), Cordis `4.1.0` and Node `24.19.0`.

## Development evidence, not release reruns

- [Magic Notes](../features/magic-notes/progress.md): 52-page PDF fixture, 1.75
  DPR checks, independent saved-content analysis, bounded mounted pages and
  responsive themes down to 360px. Focused groups include 154, 67 (overlap) and
  31 cases. An earlier full run had workspace failures later fixed and an
  OpenCode setup failure later passing alone; no final green full run is claimed.
  Three alternating storage rounds reduced measured update work and bytes;
  that excludes actual process transport/UI and is not an app-wide speed claim.
- [Speech](../features/full-duplex-voice/progress.md): 399 focused cases plus a
  later 123-case group; four real Qwen3 ASR requests, normal and streaming, using
  file-backed Chromium audio. No physical microphone/macOS/Linux acceptance;
  the interrupted full run and its failures remain documented.
- Device sharing at `752309b8` (historical `docs/features/device-sharing/progress.md`
  in Git, replaced by the persona documentation in `bae51523`): 112 focused tests,
  real authenticated Electron import/persistence, two real provider requests
  using imported fields, not full chat Runtime acceptance. Full typecheck was
  blocked in that environment and the memory-exhausted full run did not finish.
- [Office](../features/office-document-editing/progress.md): 20 focused tests,
  real VPN Electron registration/upload/edit/native-save/conflict/Save As/close.
  Requires the compatible device-auth/VPN callback server fixes; no model calls.
- [DingTalk](../features/external-apps/progress.md): live QR/wait/cancel and
  production Electron plumbing with substituted authorization/Stream transport.
  Focused tests and typecheck/lint passed; no real phone completion or messaging.
- [Remote lifecycle](../features/unified-execution/progress.md): 254 focused
  tests, current-source Linux OpenCode eviction/fault comparisons, and two real
  provider responses. Earlier full run had 15 failures outside remote modules;
  current candidate CI must establish its own result.
- [Provider failures](../features/unified-execution/progress.md), 2026-11-11:
  author reports 140 focused passes and 10 skips, current-source Linux/OpenCode
  accepted-then-socket-close fault with one uncertain dispatch and a successful
  explicit follow-up, plus two real provider responses in disconnect/recovery
  validation. No replay was observed. Typecheck and changed-file lint passed;
  no full-suite or installed-UI acceptance was claimed. The historical incident
  does not establish a 30-minute task limit or identify its original transport
  cause. These are author's development results, not release-assistant reruns.
- [Personas](../features/device-sharing/progress.md), 2026-11-11: author reports
  19 tests in five files, late-response/cancellation checks, and real Electron
  through Preload/Main to ShareServer publish/answer/recreated-client/revoke
  scenarios. Three model calls total include two prior import calls and one
  persona answer. Light/dark and 480px checks passed. Full typecheck in that
  environment was blocked by dependencies/types; not complete platform/package
  acceptance. Historical LAN evidence is not a newly run VPN Host check.
- [Graph context](../features/conversation-supervision/story-graph-source-context.md)
  records defaults, pagination, same-conversation context and unavailable-source
  boundaries; reader and Agent integration regression coverage changed with it.
- Release preparation adds no model/ASR calls and does not repeat local checks.
  Both feature lists are aligned with shipped scope, Preview status, compatible
  server requirements and remaining acceptance. Published notes are preserved.
  Candidate CI, six-target native release and public verification remain pending.

## Candidate CI history and remaining gates

- Initial metadata candidate `8cac9a2ec3af7622e99d43e55f99022449f7109f`:
  Agent `42753734611` and website `42753734321` succeeded. Desktop `42753734330`
  attempt 1 reached the 30-minute job limit after 7,030 passing and 76 skipped
  tests; typecheck completed, lint was interrupted, and production build did not
  run. Full unchanged attempt 2 succeeded. No checks or timeout were weakened.
- Expanded source `bae51523`: Desktop `43019441052` and Agent `43019441043`
  reported success in run metadata. This is not evidence for the subsequent
  version-lock/release-note candidate, nor a claim that every job log was reviewed.
- The revised metadata candidate needs its own main-branch validators and
  production build, plus Agent native branch CI. No manual package dispatch.
  Record the resulting exact SHA and runs before requesting final tag approval.
- origin synchronization is blocked. After recovery, inspect remote movement
  rather than overwriting it; verify both main refs and unused local/remote
  `v0.17.5` and `agent-v0.15.14` tags immediately before any tagging.
- Production tag workflows and public artifact/catalog/index verification remain
  separate gates. No local tests, lint, typecheck, production build, package
  launch, installer download or new model/ASR call is part of this preparation.
