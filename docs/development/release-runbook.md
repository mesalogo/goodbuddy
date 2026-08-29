# GoodBuddy Release Runbook

Read this runbook only when preparing, publishing, recovering, or verifying a
desktop or GoodBuddy Agent release.

This is an operator and CI procedure. It does not authorize adding application
persistence, snapshots, journals, rollback engines, recovery protocols, or
compatibility layers to automate release operations. Determine release recovery
from the authoritative GitHub, OSS, workflow, and Git state, then use the
smallest existing idempotent rerun or a new immutable version as specified
below.

## Release Packaging

- Unless the user explicitly requests a local Windows package, never run local
  Windows packaging or launch probes as part of release preparation. In
  particular, do not run `npm run portable`, Windows
  `npm run release:package`, direct `electron-builder` packaging, or launch a
  locally packaged Windows app before publishing a release. Source validation
  and the native GitHub Actions jobs are the release authorities.
- After a release is published, confirm only that the expected Windows assets
  exist in the public release metadata. Do not locally rebuild or launch the
  Windows package, download or hash published installers, attach browser
  automation to a packaged app, or perform exhaustive per-asset network probes
  unless the user explicitly asks for that additional validation.
- `.github/workflows/packages.yml` is the canonical cross-platform packaging
  workflow. It validates and builds `out` once, then packages on six native
  runners: Windows, macOS, and Linux, each for x64 and arm64.
- The experimental Linux LoongArch (`loong64`) preview is built separately
  through `build/loongarch-cross` by following
  `docs/development/loongarch-preview-build.md`. It is not part of
  `.github/workflows/packages.yml`, the six-runner GitHub Actions matrix,
  standard release manifests, GitHub Release asset expectations, or the
  production update index. Do not add it to those paths unless the user
  explicitly requests a future production-support migration.
- Run the unified packager with
  `npm run release:package -- --platform <platform> --arch <arch>`. It only
  packages for the native host and writes to
  `dist/release/<platform>-<arch>`.
- Default deliverables are NSIS and portable ZIP for Windows, DMG and ZIP for
  macOS, and AppImage, DEB, and RPM for Linux. Every target includes
  `release-manifest.json` with SHA-256 hashes.
- `build/build-release.cjs` verifies the unpacked application, `app.asar`,
  bundled Continue and OpenCode runtimes, executable architecture, and package
  signatures before atomically replacing a release directory.
- All desktop build paths, including local `portable`, package the Agent and
  remote Runtime version locks plus the public signing-key registry without
  embedding installable Linux Agent or remote Runtime payloads. Managed SSH is
  optional: users explicitly download a compatible compound `.gbagent` package
  from Settings or import one offline before GoodBuddy can install or update a
  Host.
- Each independently published Linux x64 or arm64 `.gbagent` contains the
  Agent daemon, pinned Node, and the desktop-maintained compatible OpenCode
  Runtime. Build both architectures on native GitHub Actions runners from one
  immutable `agent-v<agentVersion>` tag.
- Keep the GoodBuddy Agent source, shared protocol/contracts, runtime lock,
  bundle tooling, and tests in this repository so a desktop commit identifies
  the exact Agent source it expects. Do not create a separate Agent repository
  or long-lived Agent release branch unless the Agent becomes an independently
  released product serving multiple clients.
- `.github/workflows/agents.yml` is the branch and pull-request build
  verification workflow for GoodBuddy Agent. It must build Linux x64 and
  arm64 on native runners from the checked-out commit, acquire the locked
  official Node archive and locked OpenCode npm archive, verify every locked
  digest, use only an ephemeral in-memory test signing identity, and verify the
  resulting compound package and deterministic archive. It must not read
  production signing secrets, publish installable release artifacts, or modify
  the checked-in public key registry.
- `.github/workflows/agent-release.yml` is the only production compound Agent
  publication path. It requires an annotated immutable Agent tag, the protected
  `agent-signing` Environment, native x64/arm64 builds, one production
  GoodBuddy signing identity for every layer of the compound package and
  catalog, a non-Latest GitHub Agent Release, and synchronized immutable
  Beijing OSS objects plus the final signed latest-catalog pointer.
- `.github/workflows/packages.yml` and `release:package` build only desktop
  products. Missing Agent packages, remote Runtime inputs, or GoodBuddy signing
  credentials must never block an ordinary desktop package or release.
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

### Agent Release Process

- Agent releases use annotated `agent-v${agent-runtime-lock.agentVersion}` tags
  and are separate from desktop `v${package.version}` releases. Confirm the
  exact Agent release commit and tag with the user before creating or pushing
  either.
- The tagged commit must be reachable from protected `main`. The two native
  jobs build the compound x64/arm64 packages from the same source and locks;
  the catalog job rejects missing architectures, changed bytes for an existing
  version/architecture identity, invalid prior signatures, and incompatible
  matrix metadata.
- Agent GitHub Releases are ordinary non-draft, non-prerelease releases but
  must use `--latest=false`; they must never replace the desktop release marked
  Latest. Publish immutable packages and the versioned catalog to
  `agent-releases/v<agentVersion>/` in Beijing OSS, publish the GitHub Agent
  Release, then atomically update the single `agent-releases/latest.json`
  pointer to that version's immutable catalog and signature.
- Do not report an Agent release complete until both public package
  architectures match the signed catalog by size and SHA-256, the GitHub and
  OSS catalog bytes/signatures are identical, the application can read the
  selected source, and GitHub's repository Latest tag remains the desktop tag.

### Tagged Release Process

Every version-tag release must follow this sequence. A branch-only push does
not require release notes.

1. Confirm that the user wants a release tag and identify the exact release
   commit and the new `package.json` version. Separately ask whether this
   release should also receive an experimental LoongArch preview build; never
   infer that choice from an earlier release.
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
   production build. The six native CI jobs remain the cross-platform
   authority; do not add local packaging or packaged-app launch probes unless
   the user explicitly requests them.
   If the user requested a LoongArch preview in step 1, build it separately
   from this exact candidate by following the LoongArch build document, record
   its size and SHA-256, and keep it outside the standard GitHub/OSS release
   asset set unless the user separately authorizes publishing it.
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
  `releases/<tag>/` prefix first. Verify all 14 installer URLs publicly before
  creating or publishing the GitHub Release. Update
  `releases/latest.json` only after the GitHub Release is public and all prior
  checks succeeded.
- The expected GitHub Release contains 22 assets: 14 installers (two formats
  for each Windows/macOS target and three formats for each Linux target), six
  renamed target manifests, one aggregate `release-manifest.json`, and one `SHA256SUMS`.
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
3. GitHub release metadata contains exactly the expected 22 uploaded asset
   names, including the expected Windows x64 and arm64 assets. Do not download,
   hash, launch, or send individual network probes to published installers
   unless the user explicitly requests that additional validation.
4. The Beijing `releases/latest.json` returns HTTP 200, has the expected stable
   version, exact six targets and 14 installer entries, the trusted Beijing
   URLs, and the GitHub fallback URL. It must match the immutable
   `releases/<tag>/site-release.json`. Fetching and comparing these small JSON
   metadata files is sufficient; rely on the successful publication job for
   its per-asset public checks.
5. The live website successfully fetches the index and produces the 14 correct
   platform/architecture/format links from that metadata.
6. Both remote `main` refs and both peeled tag refs still equal the approved
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
