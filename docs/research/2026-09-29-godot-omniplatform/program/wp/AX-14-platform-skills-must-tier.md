# AX-14 Platform skills, must tier

| Field       | Value                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | AX: Agent experience: READMEs, llms files, skills, a CLI machines can drive and an eval harness (docs/research/2026-10-08-llm-audit/) (LLM audit (2026-10-08))                         |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                   |
| Depends on  | [AX-03a](AX-03a-claude-md-split-move-table-role-agents.md), [AX-05](AX-05-llm-eval-harness-suites-and-baseline.md), [AX-07](AX-07-the-agent-kit-layout-release-zip-references-lint.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [AX-15](AX-15-platform-skills-should-tier.md), [AX-20](AX-20-evals-on-a-schedule-and-the-safety-bar.md)                                        |
| Role        | `pkey-implementer`                                                                                                                                                                     |
| Plan mode   | no                                                                                                                                                                                     |
| Gates       | `docs-links`                                                                                                                                                                           |
| Human input | none                                                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                              |

## Goal

The five must platform skills ship in `.claude/skills/` with `paths:` frontmatter, and `AGENTS.md`'s router names each by path.

## Why

An agent maintaining the platform has no skill for the most common changes (a route, a migration, an error code, a wire change, a docs page). Registered from [the LLM audit plan](../../../2026-10-08-llm-audit/README.md) (§5.4, §8.3).

## Read first

- `AGENTS.md` (always).
- [The LLM audit plan](../../../2026-10-08-llm-audit/README.md): §5.4, §8.3, and §2 (principles), §9 (how it fits the other plans), §10 (decisions).
- The docs [style guide](../../../2026-10-08-docs/style-guide.md) governs READMEs and skills.

## Scope

**In:**

- `adding-a-worker-route` (router and service routes; OpenAPI entry and `routeCoverage`, rule 10; boundaries, rule 6; a reserved slug for a root segment; a THREAT-MODEL row for a public route).
- `adding-a-migration` (`00XX_<name>.sql`, the lead numbers it at merge; D1 limits; the data-migration runner P0-49 for backfills; tests).
- `adding-an-error-code` (`conformance/parity/errors.json` first, then constants and copy generation, every SDK's registry test, the Help column from DOC-12a).
- `making-a-wire-change` (plan mode and `pkey-wire-planner`; contract, catalog, corpus, SDKs; `PROTOCOL_VERSION`; which SDKs follow; it stops at the plan).
- `writing-docs-pages` (style guide, page types and budgets, frontmatter, MDX braces, links, doors and tiers, `nav.ts` and `docsLinks.ts`, `check:links`).
- Their router rows in `AGENTS.md` (AX-03b owns the router; coordinate).

**Out** (and where it belongs instead):

- Should-tier platform skills (→ AX-15). The gate needs no skill: `AGENTS.md` is always loaded.

## Design notes

- Tier: must (required; gates 1.0 on its deterministic checks only). Wave 2 in the plan's order (§8.4). Model routing (§8.5): Opus 5.5 for procedure; Sonnet 5.5 for references; set the model on every agent call, never inherit.
- Platform skills stay in the repo (decision 3); `AGENTS.md` routes other agents by path.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] As AX-09 (`skills:check`; trigger cases recorded; compiled fences where any).
- [ ] Its eval report (plan §7.4) is attached to the hand-off: the suite and arms it should move, and the measured difference with its interval. It never blocks the merge.
- [ ] Any skill or README it writes or changes is reviewed against the plan's principle 9 (terse: each fact once, in the reader's words).
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

AX-15 extends the family; AX-20 includes the M suite.

The role agent sets `--set AX-14 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set AX-14 done`.
