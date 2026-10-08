# AX-05 LLM eval harness, suites and baseline

| Field       | Value                                                                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | AX: Agent experience: READMEs, llms files, skills, a CLI machines can drive and an eval harness (docs/research/2026-10-08-llm-audit/) (LLM audit (2026-10-08))                                                                    |
| Size        | 1.8–2.4 engineer-weeks                                                                                                                                                                                                            |
| Depends on  | none                                                                                                                                                                                                                              |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [AX-09](AX-09-sdk-skills-must-tier.md), [AX-12](AX-12-product-skills-must-tier.md), [AX-14](AX-14-platform-skills-must-tier.md), [AX-20](AX-20-evals-on-a-schedule-and-the-safety-bar.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                |
| Plan mode   | no                                                                                                                                                                                                                                |
| Gates       | `ci`                                                                                                                                                                                                                              |
| Human input | An API key with a spending cap for CI eval runs, and the cap (owner step; plan decision 9; the baseline's token counts from AX-05 size the cap)                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                         |

## Goal

`evals/` runs fresh Claude Code agents on scripted tasks with only a given arm's artifacts, scores them, and commits a baseline on `8cd7e6192`'s artifacts: `pnpm eval:llm --suite <s> --arm <a> --model <m> [--runs <n>]`.

## Why

Every other AX package claims an effect on how well agents use or maintain Polaris Key; nothing measures it. Packages are accepted on tests and lints, so the harness reports effects and gates only safety. Registered from [the LLM audit plan](../../../2026-10-08-llm-audit/README.md) (§7, §8.3).

## Read first

- `AGENTS.md` (always).
- [The LLM audit plan](../../../2026-10-08-llm-audit/README.md): §7, §8.3, and §2 (principles), §9 (how it fits the other plans), §10 (decisions).
- The docs [style guide](../../../2026-10-08-docs/style-guide.md) governs READMEs and skills.

## Scope

**In:**

- The runner (Claude Code headless, `claude -p` JSON output, WebSearch disallowed, fresh temp directory, empty home) and the proxy with the per-arm host table of plan §7.1 (model API; the real feed read-only; npm and PyPI through a pull-through cache; only `key.plrs.im` intercepted for Node and curl with a harness CA; anything else refused and logged).
- Fixtures; the S, P, M and X suites of plan §7.3 (tasks needing `pkey dev` marked pending until SP-41); the trigger runner; the results schema with intervals (Wilson 95%, paired bootstrap); at least five runs per task per arm, paired.
- The M checkout at a pinned commit without `evals/` and without the plan's directory.
- The baseline on `8cd7e6192`'s artifacts, committed with its token counts.

**Out** (and where it belongs instead):

- Weekly and release workflows and the safety bar on the kit's release (→ AX-20).
- The `evals/` README is this package's (§3.2 row); the coverage test is AX-02's.
- Eval tasks' skill-specific trigger cases (→ each skill package).

## Design notes

- Tier: must (required; gates 1.0 on its deterministic checks only). Wave 1 in the plan's order (§8.4). Model routing (§8.5): Sonnet 5.5 for the runner; Opus 5.5 for eval tasks and rubrics; set the model on every agent call, never inherit.
- PR CI makes no model calls. Subjects: Sonnet 5.5; Opus 5.5 for X and as judge; Haiku spot check on S at the top arm. Scripted checks first; a judge only for what a script cannot check.
- S4 to S6 run by hand at each release in v1; the docs plan's fresh-reader run (§6.2 there) can run as suite `first-product` (DOC-07a, DOC-08a).
- The baseline does not wait on later packages, so wave 1 starts now.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Proxy tests: an un-listed host, a non-GET to `pkg.plrs.im` and a non-docs path on `key.plrs.im` are refused and logged.
- [ ] The M checkout has no `evals/`.
- [ ] The baseline is committed with its token counts.
- [ ] Its eval report (plan §7.4) is attached to the hand-off: the suite and arms it should move, and the measured difference with its interval. It never blocks the merge.
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

AX-07, AX-09, AX-12 and AX-14 report their effects with it; AX-20 schedules it. The baseline's token counts size the owner's spending cap.

The role agent sets `--set AX-05 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set AX-05 done`.
