# Plans for plan-mode work packages

Every work package marked ⚑ in [`../INDEX.md`](../INDEX.md) touches the wire, the conformance
corpus or another all-languages surface. `CLAUDE.md` requires a plan before any such change. The
`pkey-wire-planner` agent writes the plan here as `<ID>.md` and stops. Merging the plan PR is the
human's approval, and the implementer then executes exactly what the plan says.

## Required sections

1. **Summary**: what changes on the wire or in the corpus, in three to five bullets.
2. **Contract**: every change to `docs/security/WIRE-CONTRACT-V3.md` (or its v4 successor),
   `packages/shared-protocol`, `packages/shared-jws` and `packages/client-core`, including any
   `PROTOCOL_VERSION` bump and the compatibility story for clients already in the field.
3. **Catalog and manifests**: `packages/shared-catalog` and `packages/shared-manifest` changes,
   each with its validator rule, mutation-table entry and JSON-schema change (`AGENTS.md` rule 9).
4. **Corpus**: the new or changed sections and files, the generator changes in `tools/`, the
   version constants, every mirror (Swift, Godot) and the drift gate (`pnpm gen corpus --check`).
5. **SDKs, in order**: each SDK that must follow, what it must pass, and which work package does
   it. Name the typed N/As, if any, from the parity registry.
6. **Worker**: routes (rule 10), migrations, tables (`TABLE_OWNERS`) and generated docs pages.
7. **Rollout**: deploy order, feature flags, and what happens to old clients and old workers.
8. **Risks and open questions** that need the human's decision.
9. **Acceptance**: the exact commands that prove the implementation matches the plan.

Keep plans short enough to review in one sitting. A plan that needs more than about two pages is
usually two work packages.
