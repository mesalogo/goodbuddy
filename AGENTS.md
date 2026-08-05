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
- `src/renderer`: React UI. It must not receive secrets or direct Node access.
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
- Never log or return credentials, authorization headers, private documents, or
  unredacted provider payloads.

## Runtime Behavior

- Ask and Plan modes must remain read-only at the runtime boundary.
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
  context. Bound and redact any surfaced error details.
- Keep UI accessible with labels, keyboard behavior, semantic roles, and visible
  focus states.

## Release Packaging

- `.github/workflows/packages.yml` is the canonical cross-platform packaging
  workflow. It validates and builds `out` once, then packages on six native
  runners: Windows, macOS, and Linux, each for x64 and arm64.
- Run the unified packager with
  `npm run release:package -- --platform <platform> --arch <arch>`. It only
  packages for the native host and writes to
  `dist/release/<platform>-<arch>`.
- Default deliverables are NSIS and portable EXE for Windows, DMG and ZIP for
  macOS, and AppImage and DEB for Linux. Every target includes
  `release-manifest.json` with SHA-256 hashes.
- `build/build-release.cjs` verifies the unpacked application, `app.asar`,
  bundled Continue and OpenCode runtimes, executable architecture, and package
  signatures before atomically replacing a release directory.
- Keep electron-builder invocations on `--publish never`. Current CI uploads
  30-day GitHub Actions artifacts and does not create GitHub Release assets.
  Signing and macOS notarization are not configured.
- Keep `ELECTRON_CACHE` and `ELECTRON_BUILDER_CACHE` under
  `${{ runner.temp }}` in step-level workflow contexts. A cache beneath the
  repository inherits the root `"type": "module"` and breaks electron-builder's
  CommonJS macOS icon tool.
- Tag builds must use `v${package.version}`. The workflow also supports manual
  dispatch and main-branch changes to release tooling.
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
