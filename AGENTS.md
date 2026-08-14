# GoodBuddy Agent Guide

## Scope

These instructions apply to the entire repository.

GoodBuddy is a secure, cross-platform Electron desktop assistant. It uses
Electron, React, TypeScript, Vite, Vitest, and SQLite. User-facing copy is
primarily Simplified Chinese.

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
- Execute mode may use tools only through the existing approval controls.
- Preserve cancellation, timeout, bounded-output, and shutdown behavior.
- Treat OpenCode and Continue as untrusted child runtimes. Preserve environment
  allowlists, sandbox checks, and per-tool approval enforcement.
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
- Add or update focused tests for behavioral changes and regressions.
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
- Keep electron-builder invocations on `--publish never`. Main-branch builds
  run validation and build the production bundle without running the native
  package matrix. Manual builds upload 30-day GitHub Actions artifacts.
  Version-tag builds verify and aggregate packages before publishing GitHub
  Release assets. Signing and macOS notarization are not configured.
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
5. Only after approval, verify that `package.json` and `package-lock.json`
   contain the same release version, verify the candidate tag does not already
   point elsewhere, create `v${package.version}` at the exact approved commit,
   and push the branch and tag according to the synchronized-remote rules.
6. Keep both approved language versions as the single source for the GitHub
   Release body and the packaged first-open release-notes modal. The modal
   displays the release notes matching the current interface language and
   contains no button linking to a full release page.

When recovering from a version tag whose workflow never published a GitHub
Release and its assets:

- If the approved source and release metadata do not need to change, rerun the
  failed jobs for the same immutable tag instead of creating another tag.
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
- Verified baseline on 2026-08-04: commit `2f54938`, GitHub Actions run
  `30893805567` succeeded for validation and all six package targets, producing
  six release artifacts plus the shared production bundle.

## Validation

Run all validators after source changes:

```text
npm test
npm run typecheck
npm run lint
```

Run `npm run build` for production build changes. Use `npm run portable` only
when a current Windows portable package is requested. Gated runtime tests may
make paid or external calls, so run them only with explicit authorization.

Before committing or pushing, inspect `git status`, `git diff`, and
`git diff --cached`. Do not commit secrets, local databases, logs, generated
credentials, or private user artifacts.

This repository has two synchronized remotes, `origin` and `github`. Unless the
user explicitly names a remote, every requested push must update the current
branch on both remotes. When the user requests a release tag, push the new tag
to every remote receiving the branch update. Verify all updated branch refs and
any applicable tag refs after pushing.
