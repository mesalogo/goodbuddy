# GoodBuddy Agent Guide

## Scope

These instructions apply to the entire repository.

GoodBuddy is a secure, cross-platform Electron desktop assistant. It uses
Electron, React, TypeScript, Vite, Vitest, and SQLite. User-facing copy is
primarily Simplified Chinese.

## Product Priorities

Use this order when requirements or implementation choices compete:

1. Working product functionality.
2. Performance and responsiveness.
3. Clear, low-friction user experience.
4. Simple, conventional, maintainable implementation.
5. Security controls proportional to a concrete, realistic risk.

Follow KISS and YAGNI. Do not add trust tiers, consent ceremonies, durable
state machines, protocol phases, cryptographic identities, quotas, recovery
machinery, or compatibility layers unless they are needed for an actual user
workflow or a demonstrated failure mode. Prefer the normal platform mechanism
and the smallest design that works. Test Hosts are test environments; do not
turn their workflows into production compliance exercises.

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

Keep Electron security boundaries intact:

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

- Preserve existing user data and migrations.
- Do not weaken SQLite transaction, lifecycle, deduplication, or cleanup logic.
- Treat user workspaces and untracked files as user-owned.
- Keep Windows, macOS, Linux x64, and Linux arm64 behavior in mind.
- Do not hard-code machine-specific paths, credentials, or provider endpoints.

## Implementation Conventions

- Follow surrounding TypeScript and React patterns.
- Reuse installed libraries and shared contracts before adding dependencies.
- Keep changes focused. Do not add unrelated refactors or documentation.
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
- Treat renderer bundle budgets as regression guardrails, not UX targets. Do
  not lazy-load one lightweight peer tab solely to satisfy a byte ceiling.
  When a genuinely heavy view needs deferred loading, preserve peer
  interaction semantics, render a non-empty layout-stable local fallback,
  and test its first interaction rather than only its eventual appearance.

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

## Release Packaging

- `.github/workflows/packages.yml` is the canonical cross-platform packaging
  workflow. It validates and builds `out` once, then packages on six native
  runners: Windows, macOS, and Linux, each for x64 and arm64.
- Run the unified packager with
  `npm run release:package -- --platform <platform> --arch <arch>`. It only
  packages for the native host and writes to
  `dist/release/<platform>-<arch>`.
- Default deliverables are NSIS and portable ZIP for Windows, DMG and ZIP for
  macOS, and AppImage and DEB for Linux. Every target includes
  `release-manifest.json` with SHA-256 hashes.
- `build/build-release.cjs` verifies the unpacked application, `app.asar`,
  bundled Continue and OpenCode runtimes, executable architecture, and package
  signatures before atomically replacing a release directory.
- Ordinary `build` and `dist*` commands package the Agent and remote Runtime
  version locks plus the public signing-key registry without embedding
  installable Linux bundles. Local `portable` builds also discover and strictly
  verify any existing `.agent-resources/linux-{x64,arm64}` bundles before
  embedding them; `GOODBUDDY_PORTABLE_REQUIRE_AGENT_ARCHS` can require an exact
  local architecture set. A metadata-only package may reuse an
  already-installed Host Agent/Runtime only after the installed signed
  manifests, locked identities, managed ownership and modes, critical Agent
  payload, Host-side full payload verification, and lifecycle health all pass;
  it cannot install a missing or mismatched Host component. Manage Agent
  artifacts only through `agent:build`, `agent:import`, and `agent:verify`.
- Build Linux x64 and arm64 Agent artifacts on native GitHub Actions runners
  from the exact desktop source commit/tag. Prefer dedicated jobs or a
  reusable/manual workflow over a long-lived divergent Agent source branch.
- `release:package` is the only release path that requires the complete Agent
  matrix. It must verify both signed Linux x64 and arm64 bundles before
  Electron Builder, then verify the embedded copies in the unpacked
  application. A missing or invalid architecture must fail the release rather
  than producing a partial package.
- Keep electron-builder invocations on `--publish never`. Main-branch builds
  run validation and build the production bundle without running the native
  package matrix. Manual builds upload 30-day GitHub Actions artifacts.
  Version-tag builds verify and aggregate packages before publishing GitHub
  Release assets. The macOS jobs sign, notarize, and verify packages when all
  five Apple credentials are configured. With no Apple credentials they must
  use the explicit `--unsigned` path, warn that Gatekeeper may block the
  packages, and still complete; a partial credential set must fail rather than
  silently downgrade.
- Keep `ELECTRON_CACHE` and `ELECTRON_BUILDER_CACHE` under
  `${{ runner.temp }}` in step-level workflow contexts. A cache beneath the
  repository inherits the root `"type": "module"` and breaks electron-builder's
  CommonJS macOS icon tool.
- Tag builds must use `v${package.version}`. The workflow also supports manual
  dispatch and main-branch changes to release tooling.

### Tagged Release Process

Every version-tag release must follow this sequence. A branch-only push does
not require release notes.

1. Confirm that the user wants a release tag and identify the exact release
   commit and the new `package.json` version.
2. Find the latest stable version tag reachable before the release commit and
   inspect the complete commit and file diff from that tag to the release
   commit. For the first tagged release, inspect the relevant repository
   history instead.
3. Draft concise, user-facing release notes in both Simplified Chinese and
   English based only on verified changes in that range. Use the titles
   `GoodBuddy <version> 更新内容` and
   `What's New in GoodBuddy <version>`, with corresponding `功能更新` /
   `Features` and `问题修复` / `Bug Fixes` sections when applicable. The two
   language versions must describe the same changes. Do not expose
   internal-only details, credentials, private content, or unverified claims.
4. Show the exact bilingual release-note draft to the user and wait for
   explicit approval. If the release commit or either language version changes
   after approval, inspect the updated tag range and request approval again.
5. Write the approved notes to the single entry for the release version in
   `resources/release-notes.json`. A failed unpublished candidate whose content
   is carried forward must not retain a duplicate packaged entry.
6. Verify that `package.json`, the root `package-lock.json` version, and
   `package-lock.json.packages[""].version` all equal the release version. Run
   `npm run release:notes:verify`, the required source validators, the
   production build, and any native candidate launch probe available on the
   current host. The six native CI jobs remain the cross-platform authority.
7. Fetch both remotes immediately before tagging. Inspect any remote branch
   movement instead of overwriting or silently merging it. Confirm the working
   tree is clean, the candidate tag is unused locally and remotely, and the
   exact approved commit has not changed.
8. Only after all previous steps pass, create an annotated
   `v${package.version}` tag at the exact approved commit. Push `main` to
   `origin` and `github`, verify both branch SHAs, then push the tag to both
   remotes and verify each peeled tag SHA (`refs/tags/<tag>^{}`) equals the
   release commit.
9. Keep both approved language versions as the single source for the GitHub
   Release body and the packaged first-open release-notes modal. The modal
   displays the release notes matching the current interface language and
   contains no button linking to a full release page.
10. Observe the tag workflow through publication and complete the public
    verification checklist below. A successful push is not a completed
    release.

### OSS Publication Contract

The tagged release job publishes through the GitHub Environment selected by
`.github/workflows/packages.yml` (`aliyun-oss-release`) and reads the following
effective GitHub Actions variables. Before a release or same-tag rerun can
publish, verify that repository-, organization-, or environment-level
resolution exposes:

- `ALIYUN_OSS_BUCKET=goodbuddy`
- `ALIYUN_OSS_ENDPOINT=https://oss-cn-beijing.aliyuncs.com`
- a non-empty `ALIYUN_OIDC_PROVIDER_ARN` matching
  `acs:ram::*:oidc-provider/*`
- a non-empty `ALIYUN_ROLE_ARN` matching `acs:ram::*:role/*`

For environment-scoped values, use the exact Environment name from the
workflow; do not assume a similarly named UI environment such as `Production`
contains the active variables.

The Bucket and Endpoint are a deployment contract, not interchangeable
examples. They must stay aligned with the trusted URL checks in
`src/main/version-checker.ts`, `sites/app.js`, website validation, and related
tests. A host, Bucket, Region, or CDN migration must update and validate every
surface together before a new release.

- Use GitHub OIDC and the RAM Role to obtain short-lived STS credentials.
  Never add long-lived AccessKeys to repository or environment secrets.
- Keep `ossutil` pinned. Its V4 signing requires the Region; derive it from the
  canonical Endpoint, verify that the production value resolves to
  `cn-beijing`, and pass `--region` to every `ossutil cp`, including the final
  `latest.json` update.
- Grant the RAM Role only the actions and prefixes required by the workflow.
  It must be able to write immutable version objects and the final latest
  pointer without granting unrelated administration privileges.
- Upload release assets and `site-release.json` under the immutable
  `releases/<tag>/` prefix first. Verify all 12 installer URLs publicly before
  creating or publishing the GitHub Release. Update
  `releases/latest.json` only after the GitHub Release is public and all prior
  checks succeeded.
- The expected GitHub Release contains 20 assets: 12 installers (two formats
  for each of six platform/architecture targets), six renamed target
  manifests, one aggregate `release-manifest.json`, and one `SHA256SUMS`.
  `site-release.json` is an OSS publication artifact, not a GitHub Release
  asset.

### Failed Tag Recovery

Classify a failed tag by the external side effects that completed before
choosing a recovery:

- If no source or release metadata must change, correct only the external
  configuration and use **Re-run failed jobs** for the same immutable tag. Do
  not change, move, delete, or recreate the tag.
- If immutable OSS objects were partially uploaded but their source bytes are
  unchanged, a same-tag rerun may idempotently re-upload or verify them. Never
  point `latest.json` at a partially verified prefix.
- If the GitHub Release is already public but the final latest-pointer step
  failed, it is a published version. Keep its packaged notes and rerun the
  failed release job for the same tag; do not classify it as an unpublished
  candidate.
- If code or release metadata must change, keep the failed tag immutable,
  increment the patch version, obtain approval for the revised exact release
  commit and notes, and create a new tag. Do not reuse the failed version.

When recovering from a version tag whose workflow never published a public
GitHub Release:

- If a code or metadata change requires a higher version and a new tag, carry
  the failed candidate's approved user-facing notes forward into the recovery
  version, then remove the superseded failed version's entry from
  `resources/release-notes.json`.
- The packaged first-open modal must show that carried-forward content only
  once under the recovery version. Never retain both the failed version and
  its cumulative recovery copy, because users upgrading across them would see
  duplicate content.
- Never remove the packaged history for a version that successfully published
  a GitHub Release. Verify the failed release state before treating an entry as
  superseded.

### Post-Publication Verification

Do not report a release complete until all of the following are verified:

1. The tag workflow and all six native package jobs succeeded. Verify the
   recorded macOS signing mode: signed builds must pass `codesign`, `spctl`,
   and `stapler`; unsigned builds must record the Gatekeeper caveat in the
   Actions log and job summary. In the final release job, explicitly verify
   the OSS configuration, OIDC authentication, release-index generation,
   immutable upload, public asset check, GitHub Release publication, and
   latest-pointer steps.
2. The public GitHub Release is non-draft, non-prerelease, marked Latest, and
   uses the expected tag and title. Its body must exactly match the Markdown
   generated from the approved packaged bilingual notes.
3. The GitHub asset set has exactly the expected 20 names and every asset is
   uploaded. Compare installer sizes and SHA-256 digests with the aggregate
   manifest and `SHA256SUMS`.
4. The Beijing `releases/latest.json` returns HTTP 200, has the expected stable
   version, exact six targets and 12 installer entries, the trusted Beijing
   URLs, and the GitHub fallback URL. It must match the immutable
   `releases/<tag>/site-release.json`.
5. All 12 public installer URLs accept `HEAD` without redirects and report the
   declared size. For small JSON/checksum metadata, prefer a `GET` byte and
   digest comparison; OSS may gzip JSON responses and omit an uncompressed
   `Content-Length` on `HEAD`.
6. The live website successfully fetches the index and produces the 12 correct
   platform/architecture/format links. Exercise the application's actual
   mirror checker against the public index for all six targets.
7. Both remote `main` refs and both peeled tag refs still equal the approved
   release commit, and the local working tree is clean.

Never create or push a release tag, and never push a previously created
release tag, before the release-note draft has received explicit approval.

- Before a push that updates the `github` remote, ask whether the user wants a
  release tag unless they already specified that choice. A branch-only push
  does not require a version bump or tag. When the user requests a release,
  verify that `package.json` and `package-lock.json` contain the same release
  version, create `v${package.version}` at the exact commit being pushed, and
  push that tag so the native package matrix and GitHub Release run.
- Never move or reuse an existing release tag. If `v${package.version}` already
  exists locally or on a remote at another commit, increment the package
  version and create a new matching tag before the release push.
- Verified release baseline on 2026-08-18: commit
  `60119a4317118fa3f077db0382664f15266a6682`, annotated tag `v0.10.4`, and
  GitHub Actions run `32038633609` attempt 2 succeeded through all six native
  packages, GitHub Release publication, Beijing OSS publication, and the final
  `latest.json` switch.

## Validation

Run all validators after source changes:

```text
npm test
npm run typecheck
npm run lint
```

Run `npm run build` for production build changes. Use `npm run portable` only
when a current Windows portable package is requested. The user has granted
standing authorization in this repository for bounded real text-model calls
needed to validate changed product paths; do not ask again for each such call.
Keep each validation call minimal, disable tools and attachments where
possible, and report the exact call count. This standing authorization does
not cover bulk, high-cost, destructive, publishing, messaging, purchasing, or
other consequential external actions.

Before committing or pushing, inspect `git status`, `git diff`, and
`git diff --cached`. Do not commit secrets, local databases, logs, generated
credentials, or private user artifacts.

This repository has two synchronized remotes, `origin` and `github`. Unless the
user explicitly names a remote, every requested push must update the current
branch on both remotes. When the user requests a release tag, push the new tag
to every remote receiving the branch update. Verify all updated branch refs and
any applicable tag refs after pushing.
