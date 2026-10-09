# AX-13 Product skills, should tier

| Field       | Value                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | AX: Agent experience: READMEs, llms files, skills, a CLI machines can drive and an eval harness (docs/research/2026-10-08-llm-audit/) (LLM audit (2026-10-08)) |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                                         |
| Depends on  | [AX-12](AX-12-product-skills-must-tier.md)                                                                                                                     |
| Unblocks    | none                                                                                                                                                           |
| Role        | `pkey-implementer`                                                                                                                                             |
| Plan mode   | no                                                                                                                                                             |
| Gates       | `docs-links`                                                                                                                                                   |
| Human input | none                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                      |

## Goal

`authoring-content-packs`, `setting-up-store-distribution` and `planning-a-key-rotation` ship.

## Why

Packs, store outlets and key rotation each have their own side (`.pkey/`, CI, the console) and words. Registered from [the LLM audit plan](../../../2026-10-08-llm-audit/README.md) (§5.3, §8.3).

## Read first

- `AGENTS.md` (always).
- [The LLM audit plan](../../../2026-10-08-llm-audit/README.md): §5.3, §8.3, and §2 (principles), §9 (how it fits the other plans), §10 (decisions).
- The docs [style guide](../../../2026-10-08-docs/style-guide.md) governs READMEs and skills.

## Scope

**In:**

- `authoring-content-packs`; `setting-up-store-distribution` (separating what `.pkey/distribution` declares from what an operator enters in the console); `planning-a-key-rotation` (a person starts it: drafts the pin-update PR for each app and the overlap, and hands the person a checklist to generate, store and revoke the keys).

**Out** (and where it belongs instead):

- Must-tier product skills (→ AX-12).

## Design notes

- Tier: should (optional). Wave 3 in the plan's order (§8.4). Model routing (§8.5): Opus 5.5 for procedure; Sonnet 5.5 for references; set the model on every agent call, never inherit.
- The rotation skill is person-started, so 16 descriptions load per turn, not 17.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] As AX-09.
- [ ] Its eval report (plan §7.4) is attached to the hand-off: the suite and arms it should move, and the measured difference with its interval. It never blocks the merge.
- [ ] Any skill or README it writes or changes is reviewed against the plan's principle 9 (terse: each fact once, in the reader's words).
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

None downstream.

The role agent sets `--set AX-13 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set AX-13 done`.
