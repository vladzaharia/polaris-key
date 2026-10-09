# AX-03b The `AGENTS.md` router, repo map, short rules, nested files

| Field       | Value                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | AX: Agent experience: READMEs, llms files, skills, a CLI machines can drive and an eval harness (docs/research/2026-10-08-llm-audit/) (LLM audit (2026-10-08)) |
| Size        | 0.6–0.9 engineer-weeks                                                                                                                                         |
| Depends on  | [AX-03a](AX-03a-claude-md-split-move-table-role-agents.md), [P0-42](P0-42-generator-registry-pnpm-gen.md), [DOC-03a](DOC-03a-skeleton-and-contracts.md)        |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                                         |
| Role        | `pkey-implementer`                                                                                                                                             |
| Plan mode   | no                                                                                                                                                             |
| Gates       | `docs-generated`                                                                                                                                               |
| Human input | none                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                      |

## Goal

`AGENTS.md` opens with a task router (task, skill, files, scoped check), has short rules each linking its test under a stable anchor, a generated repo map and command lists, and stays under 24 KB; four directories have a nested `AGENTS.md` and a one-line `CLAUDE.md`.

## Why

`AGENTS.md` is 29.5 KB with rule 1 as a 300-word paragraph and rule 3 as a ten-row table, and has no task-to-command map. Registered from [the LLM audit plan](../../../2026-10-08-llm-audit/README.md) (§4.4, §8.3).

## Read first

- `AGENTS.md` (always).
- [The LLM audit plan](../../../2026-10-08-llm-audit/README.md): §4.4, §8.3, and §2 (principles), §9 (how it fits the other plans), §10 (decisions).
- The docs [style guide](../../../2026-10-08-docs/style-guide.md) governs READMEs and skills.

## Scope

**In:**

- A task router at the top: task, skill, files, scoped check (for example add a route: `adding-a-worker-route`, `router.ts`, the spec, `routeCoverage.test.ts`).
- One gate command, `pnpm gate` (AX-04), and one test per toolchain.
- Short rules: each is the rule, the test that enforces it, and a link, under a stable anchor. Rule 1's detail moves to `conformance/README.md`. No rule count in prose.
- The repo map lists every workspace package and `docs/` subdirectory and links each README. Command lists are generated from `tools/generators.ts`, never typed.
- Rule 11 as DOC-03b leaves it, plus one line for `llms.txt` once AX-06 ships.
- The same-PR rule: a change to behaviour that a skill or README describes updates it in that PR.
- Nested `AGENTS.md` only where traps are local: `packages/worker`, `packages/docs`, `conformance`, `sdks/godot`. Each under 40 lines, pointing to its README; each directory also gets a one-line `CLAUDE.md` (`@AGENTS.md`), because with a root `CLAUDE.md` Claude Code reads only `CLAUDE.md` files.
- `agents-md.test.ts` also checks that every path, script and skill `AGENTS.md` names exists, and caps `AGENTS.md` at 24 KB.
- No `.cursor/`, `.github/copilot-instructions.md` or similar files: those tools read `AGENTS.md`.

**Out** (and where it belongs instead):

- Rule 3 and the `gen:*` commands (→ P0-42), rule 4 and "Where docs live" (→ DOC-03a), rule 11 text and the public switch (→ DOC-03b), `CLAUDE.md`'s plan-mode list (→ SP-34).
- The move table (→ AX-03a).

## Design notes

- Tier: must (required; gates 1.0 on its deterministic checks only). Wave 2 in the plan's order (§8.4). Model routing (§8.5): Opus 5.5 for the restructure, Sonnet 5.5 for the tests; set the model on every agent call, never inherit.
- Hotspot: AX-03b, P0-42, DOC-03a, DOC-03b and SP-34 all edit `AGENTS.md` or `CLAUDE.md`; the plan's §4.4 names the owner of each part. The lead merges with `merge.sh`.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] `agents-md.test.ts` passes: every path, script and skill named exists; `AGENTS.md` is under 24 KB.
- [ ] A session started in `packages/worker` loads its `AGENTS.md` through the one-line `CLAUDE.md`.
- [ ] The router, repo map and command lists are generated or checked, not typed.
- [ ] Its eval report (plan §7.4) is attached to the hand-off: the suite and arms it should move, and the measured difference with its interval. It never blocks the merge.
- [ ] Any skill or README it writes or changes is reviewed against the plan's principle 9 (terse: each fact once, in the reader's words).
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

AX-04 writes the gate step list into `AGENTS.md`; AX-14's skills get router rows here.

The role agent sets `--set AX-03b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set AX-03b done`.
