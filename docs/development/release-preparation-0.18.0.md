# Desktop 0.18.0 / Agent 0.15.15 release preparation

Approved release-note date: 2026-11-17.

## Scope and authorization

- Baseline: published `v0.17.5` and `agent-v0.15.14`, both at
  `85fdeac7d5f19e63c67770a4ec24a1068cfb2323`. See the
  [publication record](./release-preparation-0.17.5.md#publication-result).
- Reviewed source endpoint: `2822e7faefa4093675be427366bf3bf1c2491000`.
  The range contains nine non-merge commits plus merge `af3b5dd6`, changing
  233 files. It includes Application Center tabs (`b8be2a22`), a documentation-only
  workbench demo (`f9184a77`), Office caching (`28d6c39d`), production workbench
  and previously pending non-UI work (`65b275c1`), page insets (`8fec44e5`),
  chrome/notes/branch links (`5419ea81`), composer corners (`7a09934a`),
  knowledge settings (`ad30f170`) and the workbench default (`2822e7fa`).
- The user approved exact bilingual Desktop and Agent notes, Desktop `0.18.0`,
  Agent `0.15.15`, the date above, necessary CI repair and candidate push.
  GitHub only: origin is explicitly excluded. Six standard Desktop targets,
  three separate native Agent targets, no LoongArch. Agent remains non-Latest.
- The original checkout contains uncommitted Pi Runtime documentation and
  validation scripts. They are user work, excluded without stashing or editing.
  Preparation uses an isolated worktree; the source range contains no Pi
  production integration. The final SHA and tags require separate approval.
- Normal tests, lint, typecheck and production build remain CI-only. The user
  separately authorized a current-source Linux x64 probe through VPN, with
  minimal real text-model requests. No local app build, package or installer
  launch is authorized; the probe's source-only bundle is not an app build.

## Behavior, data and Agent compatibility

- Workbench is the production default only when no explicit layout is stored.
  Classic remains selectable. Unit tests intentionally default to Classic;
  their success alone is not proof of fresh-install workbench acceptance.
  Six page apps share layout rules, and Local Inference Monitor remains a
  dialog without a left-navigation pin.
- Application Center owns Applications, Connectors, Skills and MCP. Obsidian
  is a connector; visited capability tabs retain drafts during the dialog.
  Tool Environment remains a separate Settings category.
- Schema 65 advances to 66 by relaxing the existing heartbeat retention CHECK
  to 36,500 days. Existing rows/indexes and retention choices remain; this is
  not a whole-database compaction or a restoration of previously deleted data.
  Back up complete user data, adjacent notes and settings before upgrade.
  Downgrades require the pre-upgrade backup, not a forced schema-number reset.
- Task Center loads older task pages. Artifact paging APIs also exist, but no
  new artifact-history UI is claimed. Note/todo lists and several settings,
  attachment, Runtime inventory and workbar counts no longer truncate or
  reject solely at the former fixed count. Byte/content/provider constraints
  remain. Continue's static prompt inventory still uses a 200-row display
  window; accepted runtime configuration counts are a different path.
- A failed conversation save no longer prevents healthy peers from saving;
  valid context fields survive one invalid field. Queue recovery retains the
  complete attachment-bearing input. Latest unresolved knowledge task failures
  survive the normal retained-history window while their target exists.
- Desktop remote recovery state removes count ceilings and isolates corrupt
  JSON/schema files. A fresh controller identity is not equivalent to restoring
  the previous identity or guaranteeing reattachment to a live old task.
- Office shares a persistent editor-resource cache and 30-second successful
  capability results per origin; explicit Settings checks refresh. This does
  not avoid uploads/conversion or promise a universal latency reduction.
- Agent daemon files and protocol versions do not change directly, but its
  `continue-acp-helper` bundles the changed shared `ContinueHostAdapter`, and
  `AgentImageToolMcp` consumes the changed image-source schema. A new compound
  Agent version is therefore required. The production catalog derives minimum
  Desktop `0.18.0` from package.json.
- Runtime locks remain OpenCode `1.19.3`, Continue `1.5.47`, Desktop DSH
  `0.2.2-rc.1`, Node `24.19.0`; DSH remains an upstream RC.

## Evidence and limits

- [Application navigation evidence](../features/application-tool-navigation/progress.md):
  author-reported final test split had 582 fast-test files passing with 16
  skipped, and 31 Electron files passing with 5 skipped for external services;
  typecheck/lint passed at that stage. Earlier full-run failures and isolated
  reruns remain recorded, not rewritten as all-green final-source evidence.
  Isolated development UI screenshots covered wide/narrow and light/dark pages.
- [Office evidence](../features/office-document-editing/progress.md#2026-11-14-打开速度优化):
  real Linux Electron/VPN editor opens reduced repeated Docs iframe transfer
  from 10.4 MB to 1.3 KB, with 245/249 cache hits, and config requests from
  three to one. Native-save/conflict/Save As/close passed. These are author's
  scoped measurements, not a new release run or Windows/macOS measurement.
- Source CI [43700509906](https://github.com/mesalogo/goodbuddy/actions/runs/43700509906)
  at `2822e7fa`, attempt 1: 7,096 tests passed, 78 skipped, one App test failed
  to find the device-registration button during its first lazy route load.
  Production build was skipped. This is a test failure, not a CI job timeout.
- Candidate test repair awaits the real DeviceSharingPage import inside async
  `act` after navigation, retaining registration, disable and re-enable
  assertions. It changes no product behavior, global timeout or test selection.
  Elimination of the failure remains subject to the exact candidate's CI.
- [Current-source Host evidence](../features/unified-execution/progress.md#2026-11-17-release-count-limits-host-validation):
  VPN Linux x64, 201 Continue rules, 201 prompts, 101 static MCP entries,
  nine image references, one real-model-directed fixture image save.
  Two text-provider requests returned HTTP 200; no image-provider requests.
  Earlier fixture/setup attempts made zero provider calls.
- This Host probe covers the actual shared Continue adapter, installed pinned
  Continue runtime, HTTP MCP and Agent image adapter. SSH carries synthetic
  relay traffic; the image-data responder is controlled. It is not installed
  Desktop UI, full Agent daemon task recovery, actual image generation, 101
  connected MCP servers, or all-platform acceptance.
- No real-user database migration rehearsal or current-source corrupt-controller
  full-Host recovery scenario was added during preparation. Existing source
  regression tests and candidate CI must not be described as those checks.

## Remaining release gates

Both feature lists and release metadata are updated; published notes stay
unchanged. Require exact-candidate main CI validators and production build,
Agent native branch builds, then separate final SHA/tag authorization.
Native signed release workflows, public assets/catalogs, OSS indexes and live
website links are checked only after authorized publication. Existing feature
Preview and installed-acceptance limitations remain.
