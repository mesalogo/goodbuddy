# GoodBuddy Feature Documentation Guide

## Scope

These instructions apply to all files under `docs/features/`.

Each direct child directory represents one user-visible product feature or one coherent feature family. Organize documentation by feature ownership first, then by document responsibility.

## Standard Structure

Use the smallest applicable subset:

```text
docs/features/<feature-name>/
  README.md
  prd.md
  user-stories.md
  logic-design.md
  ui-design.md
  technical-design.md
  progress.md
```

Additional documents are allowed when one standard file would mix independent responsibilities. List every additional document and its unique responsibility in the feature `README.md`.

Do not create empty placeholders. If a standard document is not needed yet, omit it and state the missing responsibility in `README.md` only when that absence matters to current work.

## Document Responsibilities

### `README.md`

- The sole entry point for the feature.
- Summarizes feature purpose and boundary.
- Lists all feature documents and their authoritative responsibilities.
- Defines feature-specific terminology.
- Points to cross-feature dependencies without copying them.

### `prd.md`

- Defines the user problem, goals, scope, non-goals, functional requirements, and product acceptance.
- Describes what the product must do, not module layout or implementation mechanics.
- Records explicit limitations when a workflow is intentionally unsupported.

### `user-stories.md`

- Defines user roles, scenarios, and Given/When/Then-style acceptance.
- Covers first use, normal use, failure recovery, compatibility, permissions, and boundary cases relevant to real users.
- Keeps implementation details out unless the detail is itself an observable contract.

### `logic-design.md`

- Defines invariants, state dimensions, state transitions, decision tables, priority rules, failure outcomes, and cross-story consistency.
- Resolves overlap between PRD requirements and User Stories before technical implementation.
- Includes a logic completeness assessment and identifies unresolved product decisions separately from technical selection work.

### `ui-design.md`

- Defines feature information architecture, shared component usage, states, copy, feedback, keyboard behavior, accessibility, and responsive behavior.
- Must follow the repository root `UI-DESIGN.md`.
- Does not create feature-local visual systems when shared tokens and primitives already exist.

### `technical-design.md`

- Defines process and module boundaries, shared contracts, persistence, IPC, lifecycle, packaging, compatibility, validation, and implementation order.
- Implements the PRD and logic design rather than redefining their behavior.
- Follows KISS and YAGNI. Do not add recovery or compatibility machinery without a demonstrated requirement.

### `progress.md`

- Records only verified implementation facts, remaining work, blockers, validation commands, and dated evidence.
- Never marks an item complete based only on a design, mock, schema, or injected fake when the production path remains incomplete.
- Does not duplicate future design. Link back to the authoritative document.

## Traceability

For non-trivial features:

1. PRD requirements use stable IDs such as `FR-1`.
2. User Stories use stable IDs such as `US-A1`.
3. Logic design maps rules and state transitions to PRD and User Story IDs.
4. UI and technical design link to the PRD and logic design.
5. Progress items map to implementation stages and record actual validation.

Do not renumber stable IDs merely for presentation after implementation begins.

## Source of Truth

- PRD owns product scope and requirements.
- User Stories own user scenarios and scenario acceptance.
- Logic design owns behavioral decisions and state rules.
- Root `UI-DESIGN.md` owns global UI consistency; feature UI design owns feature-specific application.
- Technical design owns implementation architecture.
- Progress owns current implementation and validation status.
- Final code and validated runtime behavior override stale documentation. Correct all affected documents when they diverge.

## Feature Boundaries

- Keep a document in a feature directory when one feature can own its behavior and acceptance.
- Keep a document in `docs/architecture`, `docs/quality`, `docs/development`, or `docs/roadmap` only when it truly governs multiple features and has no single feature owner.
- Reference cross-feature documents rather than copying their definitions.
- When two features share a global domain model, keep that model in the feature family that owns the domain or in cross-feature architecture if ownership is genuinely global.

## Managed External Artifacts

When a feature downloads external artifacts managed by GoodBuddy:

- Define the exact setting that selects the source and the setting scope.
- Use immutable artifact targets with expected byte size and SHA-256.
- Freeze the selected source when an operation starts.
- Fail explicitly when the selected source is unavailable or invalid. Never silently request another source.
- Keep download URLs and redirect allowlists out of Renderer-controlled input.
- State whether the setting affects models, application updates, Agent packages, managed tool runtimes, package-manager registries, or user-configured URLs. Do not imply a broader scope than implemented.
- When two targets are presented as an upstream/original address and its OSS mirror, require byte-identical content with one shared size and SHA-256. A mirror must not rebuild, recompress, or modify the upstream artifact.

## Migration Rules

When moving existing documentation:

1. Preserve content and Git history where practical.
2. Update every repository link to the new path.
3. Add or update the destination feature `README.md`.
4. Delete the old authoritative path; do not leave a duplicate compatibility copy.
5. Do not rewrite unrelated document content merely because the file moved.
6. Preserve uncommitted user edits while moving files.
7. Verify all relative Markdown links after migration.

## Review Checklist

- The feature has one clear entry point.
- Every document has one declared responsibility.
- Product requirements, stories, logic, UI, technical design, and progress do not contradict each other.
- Normal, failure, cancellation, compatibility, permission, and scope behavior are covered where applicable.
- UI behavior follows `UI-DESIGN.md`.
- Progress claims are backed by dated evidence.
- All relative links resolve.
