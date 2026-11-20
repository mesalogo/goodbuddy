# Desktop 0.18.2 recovery candidate

## Scope

The product scope since published `v0.17.5` and the schema 66 upgrade notice
remain those of [0.18.0](./release-preparation-0.18.0.md). The user approved
replacing the unpublished `0.18.1` entry with `0.18.2`, dated `2026-11-18`,
without editing either language's note body or any published historical entry.
Both feature lists were reviewed. Published Agent `0.15.15`, its minimum
Desktop `0.18.0`, and both previous Desktop tags remain unchanged.

## Repair and verification

Following the [0.18.1 tag failure](./release-preparation-0.18.1.md#outcome),
the layout test now loads its page once rather than navigating for each
scenario. It waits for rows belonging to a newly mounted panel each time.
The [workbar test record](../features/assistant-workbar/progress.md#2026-11-18工作区文件列表布局测试)
documents the local before/after check and both 16-scenario Windows runs.
There is no production code change, no new model call and no new Agent build.

Only the candidate commit and push to GitHub `main` are approved. Verify
all 16 scenarios, full validators and the production bundle in existing
main-branch CI before seeking approval for the exact SHA and `v0.18.2`.
Six standard Desktop targets only; no LoongArch or uncommitted Pi work.
Native packaging, signing and public release checks follow the approved tag.

## Outcome

The user later approved the immutable `v0.18.2` tag at
`11ef164062b6f53a0bfec230666592d7ce562629` on GitHub only. [Main CI](https://github.com/mesalogo/goodbuddy/actions/runs/44224354920)
passed. After Apple notarization initially rejected the macOS jobs because of
an agreement, the user confirmed it was effective and approved a same-tag retry.
The [release run](https://github.com/mesalogo/goodbuddy/actions/runs/44326964885)
completed including GitHub/OSS publication. [Desktop 0.18.2](https://github.com/mesalogo/goodbuddy/releases/tag/v0.18.2)
became GitHub Latest on November 18 with 20 assets; Agent `0.15.15` was not rebuilt.
