# P0-42 Generator registry and pnpm gen

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on))                                                                                                                                                                                                                                                                                                 |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                  |
| Depends on  | [HA-12](HA-12-presentation-discovery.md), [UK-14](UK-14-node-terminal.md)                                                                                                                                                                                                                                                                                                                                             |
| Unblocks    | [P0-43](P0-43-ci-consolidation.md), [P0-51](P0-51-1-0-readiness-review.md), [SP-33a](SP-33a-one-integration-content-generator-on.md), [SP-35](SP-35-sdk-api-registry-api-json-0-9.md), [SP-39](SP-39-one-copy-pipeline.md), [AX-02](AX-02-readmes-for-every-directory-without-one.md), [AX-03b](AX-03b-agents-md-router-repo-map-nested-files.md), [AX-07](AX-07-the-agent-kit-layout-release-zip-references-lint.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                                                                                    |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Gates       | none beyond the green gate                                                                                                                                                                                                                                                                                                                                                                                            |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                             |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQT-01** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [docs plan](../../../2026-10-08-docs/README.md) §10 amendment 8: it registers the docs generators: help messages, install steps, CLI, Action, console tour, integration docs, changelog and the upgrade table.

## LLM audit (2026-10-08)

The [LLM audit plan](../../../2026-10-08-llm-audit/README.md) §9 changes this package. Where it differs from the text below, it wins.

- Registers the `skills` generator family (AX-07 writes its generators; `pnpm gen --check` covers it).

## Goal

Generator registry and pnpm gen, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQT-01** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, §4.3, for **CQT-01**.
- [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md), for file and line evidence.

## Scope

**In:**

- tools/generators.ts declaring the 13 generator families (inputs, outputs, order, check); pnpm gen, --check, --changed, named runs; CI, gate.sh and pre-commit read it; generated reference/generators.mdx and the AGENTS.md rule-3 table; a test that every GENERATED banner maps to a registered output. The old root scripts (gen brand, gen constants, gen corpus, gen mirrors, gen platform-inventory, gen services, gen settings, gen storefront-ci, gen transcripts) are removed in P0-42's release, with no alias: pnpm gen <family> replaces each, and CI, .husky/pre-commit, AGENTS.md, CLAUDE.md, the skills, the docs and the program's briefs and plans move to it in the same change (the lead's gate.sh, outside the repo, moves with it).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQT-01**; DX consolidation B: Foundations (code quality the feature tracks build on).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Corrections found while building (code is the fact)

- The registry declares 19 entries, not 13: the runnable families (corpus, services, transcripts, constants, platform-inventory, storefront-ci, settings, brand, action-bundle, docs-reference, registry-docs, parity, graph-index), ui-matrix as an alias of corpus, and named-run-only entries so every GENERATED banner has an owner (mirrors, sdk-samples, docs-csp, design-mockups, ux-coverage).
- `parity:check` stays a script: it is not a `gen:` name and many briefs cite it; the registry runs it as a check-only family.
- The reference page and the AGENTS.md table come from `tools/gen-generators-doc.ts`, because the docs emitter is plain `.mjs` and cannot import the TypeScript registry.
- The command named in generated banners changed (`pnpm gen:x` became `pnpm gen x`), so generated outputs differ from before in that line only; no other byte moved.

## Acceptance criteria

- [x] One pnpm gen --check replaces per-family checks in CI and gate.sh (CI and the hook are done here; the lead's gate.sh is outside the repo)
- [x] Every GENERATED banner maps to a registry entry (test)
- [x] No removed gen:\* script name remains in the repo (git grep)
- [x] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-42 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-42 done`.
