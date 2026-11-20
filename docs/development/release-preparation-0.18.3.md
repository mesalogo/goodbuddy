# Desktop 0.18.3 and Agent 0.15.16 candidates

The baseline is published [Desktop 0.18.2](https://github.com/mesalogo/goodbuddy/releases/tag/v0.18.2)
(`11ef164062b6f53a0bfec230666592d7ce562629`) and [Agent 0.15.15](https://github.com/mesalogo/goodbuddy/releases/tag/agent-v0.15.15).
The eight product commits through `172a93bef873210793db8e09ed599773e75fefa2`
were integrated on top of the released tree in a separate checkout. The
public 0.18.2 notes and the earlier release test fixes are retained. Local Pi
exploration and PR article changes are excluded.

The user approved the [Desktop notes](../../resources/release-notes.json)
dated `2026-11-20` and the separate [Agent notes](../../resources/agent-release-notes/0.15.16.md).
Both feature lists were updated. The Office missing-address hint also points
to Device Sharing rather than the removed Platform Features form.

The database remains at schema 66. Dependency and Runtime pins are unchanged;
only the Desktop package and root lock versions and the Agent source version
advance. The workflow derives the Agent minimum Desktop version from the
tagged `package.json`, so the new catalog entries require `0.18.3`.

Desktop: six standard native targets, no experimental LoongArch. Agent: Linux
x64, Linux arm64 and macOS arm64, published separately and never GitHub Latest.
Candidate preparation does not authorize a push. Exact-source main CI,
separate immutable tag approvals, native packaging and public verification
are outstanding.

## Candidate checks

- `npm run release:notes:verify` passed. All earlier entries equal `v0.18.2`;
  the package and both locks differ only at the intended version fields.
  GitHub Markdown uses the existing notice headings `使用前请留意` and
  `Before You Start`; these correspond to the draft's “升级说明” / “Upgrade
  Notes” and do not change its approved text.
- [Linux x64 evidence](../features/unified-execution/progress.md#2026-11-20-agent-model-connection-resets):
  three attempts on repeated dispatch resets, one on a body reset, a recovered
  first model round followed by an actual OpenCode fixture read and one paid
  text response. A final controlled repeat used no additional external model
  calls. The installed Agent was not replaced.
- Full tests (including real Electron), typecheck, lint and production bundle
  are reserved for the exact candidate's main-branch CI. No local product
  build, installer probe, actual image generation or other architecture test
  was run during this preparation.
