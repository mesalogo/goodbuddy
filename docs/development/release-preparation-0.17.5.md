# Desktop 0.17.5 release preparation

Date: 2026-11-10.

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
  LoongArch declined. Keep published Agent `0.15.13`, no new Agent release.
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

## Agent and data compatibility

- Daemon source, Agent package tooling, protocol and Runtime locks have no
  changes since `agent-v0.15.13`. The remote fix is in Desktop managed/protocol
  channel composition; existing Agent task APIs already support it.
- New shared schemas concern Desktop IPC/settings and optional note save DTOs.
  Note storage remains Desktop-owned, including remote MCP callers; no separate
  Agent save implementation is deployed. ASR and ShareServer calls run from
  Desktop, not through the Agent. Hosts already on `0.15.13` need no reinstall.
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
- [Device sharing](../features/device-sharing/progress.md): 112 focused tests,
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
- Release preparation adds no model/ASR calls and does not repeat local checks.
  Both feature lists are aligned with shipped scope, Preview status, compatible
  server requirements and remaining acceptance. Published notes are preserved.
  Candidate CI, six-target native release and public verification remain pending.
