# AX-20 Evals on a schedule, and the safety bar

| Field       | Value                                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | AX: Agent experience: READMEs, llms files, skills, a CLI machines can drive and an eval harness (docs/research/2026-10-08-llm-audit/) (LLM audit (2026-10-08))                          |
| Size        | 0.3–0.5 engineer-weeks                                                                                                                                                                  |
| Depends on  | [AX-05](AX-05-llm-eval-harness-suites-and-baseline.md), [AX-09](AX-09-sdk-skills-must-tier.md), [AX-12](AX-12-product-skills-must-tier.md), [AX-14](AX-14-platform-skills-must-tier.md) |
| Unblocks    | none                                                                                                                                                                                    |
| Role        | `pkey-implementer`                                                                                                                                                                      |
| Plan mode   | no                                                                                                                                                                                      |
| Gates       | `ci`                                                                                                                                                                                    |
| Human input | An API key with a spending cap for CI eval runs, and the cap (owner step; plan decision 9; the baseline's token counts from AX-05 size the cap)                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                               |

## Goal

Weekly and per-release eval workflows run, summarise to `evals/results/<version>.json`, and the safety suite blocks the agent kit's release on failure.

## Why

Effects are reported, not gated, except safety: a safety failure must stop the kit's release until the artifact that allowed it is fixed. Registered from [the LLM audit plan](../../../2026-10-08-llm-audit/README.md) (§7.4, §8.3).

## Read first

- `AGENTS.md` (always).
- [The LLM audit plan](../../../2026-10-08-llm-audit/README.md): §7.4, §8.3, and §2 (principles), §9 (how it fits the other plans), §10 (decisions).
- The docs [style guide](../../../2026-10-08-docs/style-guide.md) governs READMEs and skills.

## Scope

**In:**

- The weekly workflow on `main`: the X suite (five runs) and one run of each automated S and P task at the highest arm that exists, on Sonnet 5.5 (about 57 runs).
- The release workflow: the v1 matrix (about 735 subject runs plus judge calls), Opus 5.5 on the X suite from A1 up, Haiku on S at the top arm.
- The results summary per release; transcripts stay CI artifacts.
- The safety bar: 100% on the X suite for Sonnet 5.5 and Opus 5.5 from A1 up blocks the agent kit's release; Haiku is reported.

**Out** (and where it belongs instead):

- The harness and baseline (→ AX-05).

## Design notes

- Tier: should (optional). Wave 3 in the plan's order (§8.4). Model routing (§8.5): Sonnet 5.5; set the model on every agent call, never inherit.
- PR CI makes no model calls. A run result never blocks a merge; only the kit's release. The spending cap is the owner's (decision 9); the baseline's token counts size it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] One weekly and one release run recorded.
- [ ] Its eval report (plan §7.4) is attached to the hand-off: the suite and arms it should move, and the measured difference with its interval. It never blocks the merge.
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

P0-51's readiness note cites eval results as evidence, never as a gate.

The role agent sets `--set AX-20 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set AX-20 done`.
