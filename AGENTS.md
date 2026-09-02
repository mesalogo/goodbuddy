# GoodBuddy Agent Guide

## Scope

These instructions apply to the entire repository.

GoodBuddy is a cross-platform Electron desktop assistant for internal
organizational networks. It uses Electron, React, TypeScript, Vite, Vitest, and
SQLite. User-facing copy is primarily Simplified Chinese.

## Product Priorities

GoodBuddy is primarily an internal-network product. Unless the user states
otherwise, assume a trusted organizational environment, not a hostile public,
multi-tenant, or zero-trust deployment.

Use this order when requirements or implementation choices compete:

1. Complete, working product functionality.
2. Measured performance and responsiveness.
3. Clear, low-friction user experience.
4. Simple, conventional, maintainable implementation.
5. Security controls only for a concrete risk in the actual deployment model.

Functionality and performance are the primary acceptance criteria. Do not
disable, delay, restrict, or complicate a working product path for speculative
security hardening. Preserve the existing Electron, credential, user-data, and
release-signing boundaries, but do not expand them without a concrete current
risk or an explicit user requirement.

## Design Simplicity

Follow KISS and YAGNI. Use the smallest conventional design that completes the
real user workflow.

- A demonstrated failure authorizes only the smallest proportional fix, not a
  general recovery, compatibility, or security framework.
- Prefer deleting bounded staging and retrying, idempotent operations, and
  reconciliation from one authoritative source of truth. Do not persist copies
  of state that can be derived or safely retried.
- Do not add durable snapshots, journals, versioned internal receipts, rollback
  engines, compatibility readers, multi-phase state machines, protocol phases,
  cryptographic identities, trust tiers, consent ceremonies, or quotas when
  cleanup, retry, or reconciliation is safe.
- Before introducing any of that machinery, stop before coding. Explain the
  reproducible current failure, why the simple alternative is insufficient,
  and obtain the user's explicit approval for the added complexity. A reviewer
  suggestion, test-only scenario, hypothetical crash, or possible future need
  is not sufficient evidence.
- Performance outranks simplicity only for a measured bottleneck. Security
  complexity requires a concrete threat at an actual trust boundary.
- Ignore hypothetical threats that require a hostile public network,
  untrusted tenants, or zero-trust deployment unless that environment is an
  explicit product requirement. Do not turn such findings into implementation
  work.
- A complete workflow means the normal production path plus demonstrated
  failure cases. It does not require exhaustive recovery from every
  hypothetical interruption point.
- Test Hosts are test environments. Do not turn their workflows into production
  compliance exercises.

When the user asks to implement a feature, deliver the complete usable user
workflow unless the user explicitly requests a prototype, scaffold, staged
landing, or partial implementation. Internal contracts, managers, protocols,
disabled UI, unavailable catalog entries, placeholders, and tests around
injected fakes do not count as completion when the real product path still
cannot be used. If required metadata, dependencies, or integration details are
missing, investigate and resolve them as part of the implementation. Do not
turn missing implementation work into a product "security gate", permanent
unavailable state, or acceptance criterion. If a genuine external blocker
cannot be resolved, stop and ask the user rather than presenting the partial
work as the implemented feature.

## Architecture

- `src/main`: privileged Electron main process, runtimes, persistence, IPC,
  knowledge, automation, and OS integration.
- `src/preload`: the narrow, typed bridge exposed to the renderer.
- `src/shared`: schemas, contracts, presets, and IPC channel definitions shared
  across process boundaries.
- `resources/skills`: bundled skills.
- `build`: packaging scripts and icons.
- `out` and `dist`: generated output. Change source files instead.

Keep these existing Electron security boundaries intact. They do not authorize
additional hardening beyond the actual internal-network threat model:

- Preserve context isolation and sandboxing.
- Never enable renderer Node integration.
- Validate IPC input with shared Zod schemas and verify trusted senders.
- Expose only explicit preload methods. Do not pass raw Electron APIs.
- Keep API keys in the main process and encrypted settings store.

## Runtime Behavior

- Ask mode must remain read-only at the runtime boundary.
- Execute mode is the user's full authorization for the selected SSH account.
  It may use all tools, processes, network access, and writable paths available
  to that account. Do not add T2/T3 trust tiers, separate consent checklists,
  per-tool approvals, or a second "controlled execution" concept.
- Preserve cancellation, timeout, bounded-output, and shutdown behavior.
- Keep model/provider credentials in Main, but do not otherwise reduce Execute
  permissions with extra product policy gates. Keep child-process cleanup
  straightforward and reliable.
- On test Hosts, GoodBuddy may install and start its own test resources and
  create dedicated work directories. Never delete or overwrite unrelated Host
  files.
- A successful image-model configuration check does not prove generation works.
  Only an actual generation request verifies the provider path.
- Do not fetch provider-returned image URLs. Accept and validate bounded inline
  image data, then persist it as an artifact in the main process.

## Data and Compatibility

- Preserve released user-owned data, migrations required by released data, and
  supported external contracts.
- Compatibility does not apply to unshipped, branch-local, or safely disposable
  internal operation records. Replace or discard those records instead of
  adding migrations, legacy readers, versioned receipts, or recovery machinery.
- Do not weaken SQLite transaction, lifecycle, deduplication, or cleanup logic.
- Treat user workspaces and untracked files as user-owned.
- Keep Windows, macOS, Linux x64, and Linux arm64 behavior in mind.
- Do not hard-code machine-specific paths, credentials, or provider endpoints.

## Implementation Conventions

- Follow surrounding TypeScript and React patterns.
- Reuse installed libraries and shared contracts before adding dependencies.
- Keep changes focused. Do not add unrelated refactors or documentation.
- Reviewer findings do not expand task scope. Implement a finding only when it
  identifies a reachable current failure, a released compatibility contract,
  or reproducible user-visible harm. Record speculative concerns without
  building machinery around them.
- Validate the real end-to-end path, not only schemas, mocks, injected test
  doubles, or isolated infrastructure. A feature is not complete until its
  normal UI action reaches the production implementation and produces the
  intended result.
- Security work must remain proportional to a concrete risk and must not
  replace missing product functionality. Use established platform and
  repository mechanisms instead of inventing extra gates, ceremonies, or
  disabled states.
- Add or update focused tests for behavioral changes and regressions.
- After completing any functional change, inspect the affected product,
  architecture, design, feature, setup, and operational documentation and
  update every relevant document to match the implemented behavior. Treat the
  final code and validated runtime behavior as the source of truth: correct
  stale documentation rather than preserving outdated intent. Avoid
  documentation churn only when the change has no documented impact.
- Avoid broad catches that erase HTTP status, cancellation, or provider error
  context.
- Keep UI accessible with labels, keyboard behavior, semantic roles, and visible
  focus states.

## Product Design Documentation

- Organize feature documentation by product feature under
  `docs/features/<feature-name>/`, not by document type.
- Treat each feature directory's `README.md` as its documentation entry point.
- Follow `docs/features/AGENTS.md` for required document responsibilities,
  naming, traceability, progress evidence, and migration rules.
- Keep cross-feature architecture, quality protocols, development procedures,
  and product-wide roadmaps outside feature directories only when they cannot
  be owned by one feature.
- Maintain one authoritative definition for each requirement, state rule, UI
  behavior, technical contract, and implementation fact. Link to it instead of
  duplicating it across documents.
- Update the affected feature documents after functional changes. The
  implemented and validated production behavior is the final source of truth.

## UI Consistency

- Treat `UI-DESIGN.md` as the canonical UI design system. Read and follow it
  before changing renderer layout, shared controls, interaction feedback,
  themes, responsive behavior, or accessibility semantics.
- Reuse the shared `PageTabs` and `SegmentedControl` primitives instead of
  creating page-specific tab or toggle styles. A semantic tab set may use the
  shared segmented visual variant, but it must retain `tablist`, `tab`,
  `tabpanel`, `aria-selected`, roving focus, and arrow-key behavior.
- Use the shared sliding Switch pattern for persistent binary states and expose
  `role="switch"` even when it is implemented with a checkbox input. Keep
  Checkbox visuals and semantics for multi-select, assignment, and explicit
  confirmation. Do not create page-specific Switch styling.
- Use the bundled `Inter Variable` and `Noto Sans SC Variable` UI fonts through
  the shared typography tokens. Do not add remote font requests or page-local
  font stacks. Keep redistributed font licenses in packaged resources and
  retain system fallbacks for startup and unsupported glyphs.
- Route transient success and informational feedback, plus asynchronous errors
  that are not tied to one field, through the application notification
  viewport. Do not render page-local copies of the same notification pattern.
- Keep inline feedback only when it must remain attached to its context, such
  as field validation, destructive confirmation, operation progress, a
  blocking page state, or an error with an immediate local recovery action.
- Do not show the same event both inline and as an application notification.
  Preserve user input and actionable error context when an operation fails.

## Commit Messages and Release Notes

Release notes are derived in part from commit history, so commits for
user-visible changes must record product intent rather than only the
implementation mechanism.

- Classify the commit by the user-visible behavior. Use `feat` only for a
  capability users did not previously have. Use `fix` when restoring intended
  behavior, removing inconsistency, or making two existing entry points reflect
  the same underlying setting, even if the implementation adds new
  synchronization logic.
- Keep the subject concise, then add a commit body for non-trivial user-visible
  changes. State the previous user-facing problem, the resulting behavior, and
  the affected surface or workflow. Include permissions, migration,
  compatibility, cost, data, preview-status, or other usage caveats when
  relevant.
- Describe the user outcome precisely. Do not promote an internal refactor,
  synchronization mechanism, schema change, or newly added implementation code
  to a product feature unless it creates a genuinely new user capability.
- When a change is release-note worthy, include a short `Release note:` line in
  the commit body written in user-facing language. Prefer a concrete usage
  scenario and benefit over technical implementation terminology.
- Treat commit messages as evidence, not as the sole source of truth. Before
  drafting release notes, verify the diff and resulting behavior, correct any
  inaccurate `feat` or `fix` classification, and include actionable usage
  notes where the change affects defaults, synchronized settings, permissions,
  resource usage, compatibility, or user data.

Example:

```text
fix: unify project settings across channel entry points

The top-left project settings and the project settings shown under messaging
channels could present or save inconsistent values. They now edit the same
project configuration for the project name, description, Runtime, and work
mode.

Release note: 修复左上角项目设置与消息通道项目设置不一致的问题；现在从任一入口修改后，另一处会同步显示相同配置。
```

## Releases

Detailed release operations are governed by
[`docs/development/release-runbook.md`](./docs/development/release-runbook.md).
Read that runbook only when preparing, publishing, recovering, or verifying a
desktop or GoodBuddy Agent release. It is an operator and CI procedure, not an
authorization to add product persistence or recovery machinery.

Repository-wide release invariants:

- Write each release-note feature item as two or three clear sentences that
  identify the user situation, the available action, and the resulting
  behavior or important boundary. Do not impose an arbitrary per-item
  character limit; use the detail needed to make the user scenario clear.
- Before approving the exact release commit and bilingual release notes,
  inspect the English `FEATURES.md` and Simplified Chinese
  `FEATURES.zh-CN.md` against the verified changes since the previous stable
  release. Keep both versions aligned, and update their provided capabilities,
  roadmap status, current versions, limitations, and remaining release
  acceptance work as needed. Include any required update in the release
  candidate; if no change is needed, explicitly confirm that both feature lists
  were reviewed and remain accurate.
- Never create or push a release tag before the user approves the exact release
  commit and bilingual release notes.
- Never move, delete, recreate, or reuse a release tag.
- Keep desktop and Agent release paths, tags, artifacts, and Latest status
  separate.
- GitHub Actions is the release build and cross-platform packaging authority.
  During release preparation, run local tests, type checks, and lint, but do
  not run `npm run build`, `npm run build:bundle`, local packaging, or
  packaged-app probes. Push the approved candidate commit first and require its
  main-branch CI validation and production build to pass before tagging it,
  unless the user explicitly requests an additional local build.
- LoongArch is a separate experimental preview. Build or publish it only when
  the user explicitly requests it for that release.
- Never commit or publish credentials. Production publication uses the existing
  protected environments and short-lived credentials described in the runbook.

## Validation

Run all validators after source changes:

```text
npm test
npm run typecheck
npm run lint
```

Run `npm run build` for production build changes during development, but not
solely as a release-preparation step; release candidates use the main-branch CI
production build before tagging. Use `npm run portable` only when a current
Windows portable package is requested. The user has granted standing
authorization in this repository for bounded real text-model calls needed to
validate changed product paths; do not ask again for each such call. Keep each
validation call minimal, disable tools and attachments where possible, and
report the exact call count. This standing authorization does not cover bulk,
high-cost, destructive, publishing, messaging, purchasing, or other
consequential external actions.

### GoodBuddy Agent development validation

Every source change that can alter the deployed GoodBuddy Agent or the
desktop-to-Agent production path must be validated on the shared Linux x64 test
Host while the change is being developed. This includes Agent daemon and
protocol changes, packaging and installation, attach/update behavior, Runtime
launch and process ownership, workspaces, model bridges, and lifecycle or
recovery behavior. Unit tests, mocks, fixtures, CI, and waiting for release
validation are not substitutes for this development-time check.

- Reach the shared Host at `192.168.0.23` on the LAN when available, otherwise
  use `10.7.0.23` over VPN. These are two routes to the same physical machine,
  not two independent test targets or architecture results.
- Exercise the current source or package under development, not only the
  previously published Agent. Run the affected production path as soon as it is
  runnable and repeat the relevant scenario after the final change.
- Select the real-Host scenario from the changed surface: attach/bootstrap or
  update for installation changes; Ask/Execute and a bounded real model request
  for Runtime or model-bridge changes; and the applicable disconnect, restart,
  cancellation, or reconnection sequence for lifecycle and recovery changes.
- Use the existing pinned Host identity and GoodBuddy credential storage. Never
  add credentials to source, documentation, commands, logs, or test output, and
  never hard-code these test addresses into product behavior or defaults.
- Keep all artifacts in GoodBuddy-owned test directories. Before stopping or
  changing a remote process, verify that it belongs to the test run; never
  modify unrelated Host files or processes.
- If neither route is reachable, report the real-Host validation as blocked and
  do not present the Agent work as complete or defer its first real validation
  to release time.

The detailed scenario rules are documented in
[`docs/features/remote-host/technical-design.md`](./docs/features/remote-host/technical-design.md).

Before committing or pushing, inspect `git status`, `git diff`, and
`git diff --cached`. Do not commit secrets, local databases, logs, generated
credentials, or private user artifacts.

Before a push that updates the `github` remote, ask whether the user wants a
release tag unless they already specified that choice. A branch-only push does
not require a version bump or tag.

This repository has two synchronized remotes, `origin` and `github`. Unless the
user explicitly names a remote, every requested push must update the current
branch on both remotes. When the user requests a release tag, push the new tag
to every remote receiving the branch update. Verify all updated branch refs and
any applicable tag refs after pushing.
