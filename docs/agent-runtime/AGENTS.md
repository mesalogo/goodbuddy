# Agent Runtime Documentation

This directory owns the unified Runtime onboarding standard and Runtime-specific
documentation. The user explicitly selected this taxonomy instead of keeping
Runtime contracts scattered across feature directories.

- `README.md` is the normative entry point for onboarding, capability declarations,
  and acceptance. Do not create a competing general integration specification.
- `capability-matrix.md` records current integration scope by provider and execution
  path. Separate implemented source paths, upstream probes, and product acceptance.
- `contracts/` owns shared selection and interaction semantics.
- `design/` owns process reuse, native clients, and checklist adaptation.
- `providers/<provider>/README.md` is each provider's entry point. Keep requirements,
  scenarios, logic, UI, design, and progress in the smallest useful subset of the
  filenames defined in `docs/features/AGENTS.md`.
- `validation/` holds standalone validation evidence. Preserve dated historical
  facts; do not treat a later review or library probe as product completion.
- Shared storage, Host deployment, workbar UI, and task scheduling remain in their
  existing owner documents. Link to them rather than duplicate contracts.
- Before a migration, inspect inbound and outbound links. Move authoritative files,
  update references including website GitHub URLs, and remove old copies rather
  than leaving competing stubs. Preserve uncommitted edits and historical evidence.
- Skills/MCP enablement is global with Runtime assignments. Do not introduce a
  project-level dynamic toggle requirement from upstream API capabilities.
- Documentation work does not authorize product changes, commits, or releases.
