# AX-04 `pnpm gate` in the repo

| Field       | Value                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | AX: Agent experience: READMEs, llms files, skills, a CLI machines can drive and an eval harness (docs/research/2026-10-08-llm-audit/) (LLM audit (2026-10-08)) |
| Size        | 0.4–0.6 engineer-weeks                                                                                                                                         |
| Depends on  | [P0-43](P0-43-ci-consolidation.md)                                                                                                                             |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                                         |
| Role        | `pkey-implementer`                                                                                                                                             |
| Plan mode   | no                                                                                                                                                             |
| Gates       | none                                                                                                                                                           |
| Human input | none                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                      |

## Goal

`pnpm gate` runs the green gate scoped to the branch's changes, with `--full`, `--only <n>`, `--from <n>` and one retry per step, so the gate no longer lives only in the lead's scripts.

## Why

The scoped gate with retry-once and step rerun exists only in `_lead/gate.sh`, outside the repo. A builder in another checkout, or a non-Claude agent, cannot run it. Decision 13 moves the gate into the repo; `merge.sh` and `stall-watch.sh` stay outside. Registered from [the LLM audit plan](../../../2026-10-08-llm-audit/README.md) (§4.4, §8.3, §10 decision 13).

## Read first

- `AGENTS.md` (always).
- [The LLM audit plan](../../../2026-10-08-llm-audit/README.md): §4.4, §8.3, §10 decision 13, and §2 (principles), §9 (how it fits the other plans), §10 (decisions).
- The docs [style guide](../../../2026-10-08-docs/style-guide.md) governs READMEs and skills.

## Scope

**In:**

- `pnpm gate` carrying `_lead/gate.sh`'s steps and behaviour, scoped by P0-43's scope file, with `--full`, `--only <n>`, `--from <n>` and one retry per step.
- The step list generated into `AGENTS.md`.

**Out** (and where it belongs instead):

- `merge.sh` and `stall-watch.sh` (stay outside the repo; named only in the program skill through `$PKEY_LEAD`).
- The scope file itself (→ P0-43).

## Design notes

- Tier: must (required; gates 1.0 on its deterministic checks only). Wave 2 in the plan's order (§8.4). Model routing (§8.5): Sonnet 5.5; set the model on every agent call, never inherit.
- The lead's script becomes a wrapper around `pnpm gate`, or goes.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A docs-only branch runs only the docs steps.
- [ ] The gate reads `tools/ci-scope.mjs` for which lanes a change runs (taken over from P0-43, 2026-10-22; the lead's `gate.sh` still uses its own `touches` regexes).
- [ ] The lead's `gate.sh` is a wrapper or removed.
- [ ] The step list in `AGENTS.md` is generated and `pnpm gen --check` covers it.
- [ ] Its eval report (plan §7.4) is attached to the hand-off: the suite and arms it should move, and the measured difference with its interval. It never blocks the merge.
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

AX-03b's router names `pnpm gate` as the one gate command.

The role agent sets `--set AX-04 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set AX-04 done`.

## Consolidation 2026-10-22 (triage)

P0-43 was set done. Its "gate.sh reads `ci-scope.mjs`" item moves here: this package replaces gate.sh, so the wrapper reads the scope file (acceptance above).

## Corrections (2026-10-24)

Verified against the code; the code is the fact (plan: `AX-03b-AX-04-P0-46-slices.md` §0 G1–G10).

- G1: gate.sh has 17 local steps (install, build, docs build, gen, typecheck, test, prettier, admin build, assemble, check:links, workerd typecheck and test, Python, Swift, Godot, format, admin e2e). `pnpm gate` keeps those numbers; new steps are appended.
- G2: gate.sh's `touches` regexes map to `ci-scope.json` lanes: docs build and check:links to `docs`, admin build, assemble and workerd to `workerd`, Python to `python`, Swift to `swift-floor`, Godot to `godot`, admin e2e to `console`.
- G3: `ci-scope.mjs` already exports `loadScope`, `selectLanes` and `changedFiles`; six comments still say gate.sh reads it (AX-04.2 fixes them).
- G4: there is no JS lane; install, build, gen, typecheck, test and lint always run, narrowed by turbo's merge-base filter.
- G5: a `docs/` change turns on the `docs` lane only; a `packages/docs/` change also turns on `workerd`, as CI assembles the site into the Worker. "Docs-only" means the first.
- G6: `pnpm gen --changed` diffed from `main` only; it now takes `--base <rev>`.
- G7: machine-specific parts (default directory, staging base, `/tmp` slots, `heavy.sh`) are env hooks: `PKEY_GATE_BASE`, `PKEY_GATE_HEAVY`, `PKEY_GATE_SLOTS`.
- G9: the root `package.json` is a `readme-work` input, so the new `gate` script regenerates the "Work on it" blocks.
- G10: `tools/` and `package.json` are `shared` inputs, so a slice editing them turns every lane on; hand-off gates use `--only`.
- Open items for AX-04.2: the generated `AGENTS.md` step list, the docs, and the lead's wrapper.
