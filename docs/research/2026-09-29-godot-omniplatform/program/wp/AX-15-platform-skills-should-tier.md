# AX-15 Platform skills, should tier

| Field       | Value                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | AX: Agent experience: READMEs, llms files, skills, a CLI machines can drive and an eval harness (docs/research/2026-10-08-llm-audit/) (LLM audit (2026-10-08)) |
| Size        | 1–1.4 engineer-weeks                                                                                                                                           |
| Depends on  | [AX-14](AX-14-platform-skills-must-tier.md)                                                                                                                    |
| Unblocks    | none                                                                                                                                                           |
| Role        | `pkey-implementer`                                                                                                                                             |
| Plan mode   | no                                                                                                                                                             |
| Gates       | `docs-links`                                                                                                                                                   |
| Human input | none                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                      |

## Goal

The four should platform skills ship and the program skill takes the integration and release material.

## Why

Adding a service, an SDK feature, a console screen and fixing a security finding each have repo-specific steps an agent otherwise rediscovers. Registered from [the LLM audit plan](../../../2026-10-08-llm-audit/README.md) (§5.4, §8.3).

## Read first

- `AGENTS.md` (always).
- [The LLM audit plan](../../../2026-10-08-llm-audit/README.md): §5.4, §8.3, and §2 (principles), §9 (how it fits the other plans), §10 (decisions).
- The docs [style guide](../../../2026-10-08-docs/style-guide.md) governs READMEs and skills.

## Scope

**In:**

- `adding-a-service` (`tools/services.json`, generation, the `contribute/layout` checklist); `adding-an-sdk-feature` (`features.json`, each SDK's `parity.json`, `api.json`, corpus or transcripts, all six SDKs); `building-a-console-or-portal-screen` (mockup first; `pkey-ux-reviewer` in both modes; the responsive matrix; Linux baselines in Docker; terse copy; the brand); `fixing-a-security-finding` (`model:` Sonnet 5.5; local endpoints only; a failing regression test first; fail closed; redaction; the THREAT-MODEL row; a security review).
- `running-the-omniplatform-program` kept and takes the lead material from `CLAUDE.md` and the batch gate, merge order, the tag, CI, deploy, migrations, feed coherence (P0-52) and the owner-steps checklist; `merge.sh` and `stall-watch.sh` named only through `$PKEY_LEAD`.
- A service task and a screen task added to the M suite.

**Out** (and where it belongs instead):

- Must-tier platform skills (→ AX-14).

## Design notes

- Tier: should (optional). Wave 3 in the plan's order (§8.4). Model routing (§8.5): Opus 5.5 for procedure; Sonnet 5.5 for the security skill and references; set the model on every agent call, never inherit.
- `running-the-green-gate` is dropped (the gate is in `AGENTS.md`) and `integrating-and-releasing` folds into the program skill.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] As AX-09, plus a service task and a screen task added to the M suite.
- [ ] Its eval report (plan §7.4) is attached to the hand-off: the suite and arms it should move, and the measured difference with its interval. It never blocks the merge.
- [ ] Any skill or README it writes or changes is reviewed against the plan's principle 9 (terse: each fact once, in the reader's words).
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

None downstream.

The role agent sets `--set AX-15 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set AX-15 done`.
