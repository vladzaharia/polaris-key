# AX-03a The `CLAUDE.md` split, the move table, role agents

| Field       | Value                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | AX: Agent experience: READMEs, llms files, skills, a CLI machines can drive and an eval harness (docs/research/2026-10-08-llm-audit/) (LLM audit (2026-10-08))                                                      |
| Size        | 0.5–0.7 engineer-weeks                                                                                                                                                                                              |
| Depends on  | none                                                                                                                                                                                                                |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [AX-03b](AX-03b-agents-md-router-repo-map-nested-files.md), [AX-07](AX-07-the-agent-kit-layout-release-zip-references-lint.md), [AX-14](AX-14-platform-skills-must-tier.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                  |
| Plan mode   | no                                                                                                                                                                                                                  |
| Gates       | none                                                                                                                                                                                                                |
| Human input | none                                                                                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                           |

## Goal

`CLAUDE.md` is about 25 lines and starts with `@AGENTS.md`; every rule it held has a destination; the seven role agents have `tools:` and an explicit `model:`; `pkey-wp-reviewer` also reviews an ordinary PR.

## Why

Claude Code loads `AGENTS.md` only when it opens it, since `CLAUDE.md` says to read it but does not import it. Five rules that bind every builder (finish clean, merge `main` once, `00XX_` migrations, reviewers never block on conflicts, one fix round) live only in `CLAUDE.md`. Four role agents lack `tools:`; all seven say `model: inherit`; "eleven hard rules" is hardcoded; `pkey-ux-reviewer` names a `/Users/` path. Registered from [the LLM audit plan](../../../2026-10-08-llm-audit/README.md) (§4.4, §8.3).

## Read first

- `AGENTS.md` (always).
- [The LLM audit plan](../../../2026-10-08-llm-audit/README.md): §4.4, §8.3, and §2 (principles), §9 (how it fits the other plans), §10 (decisions).
- The docs [style guide](../../../2026-10-08-docs/style-guide.md) governs READMEs and skills.

## Scope

**In:**

- The plan's §4.4 move table: every `CLAUDE.md` rule gets a destination (line 1 becomes `@AGENTS.md`; the skills list is removed; the `mise exec node@22 --` prefix, background jobs, test budget, review, hand-off and finish-clean rules go to `AGENTS.md` sections Commands, Working, Testing, Review, Hand-off; the lead's rules go to `running-the-omniplatform-program`; plan mode and the explicit-model rule stay in `CLAUDE.md`).
- `agents-md.test.ts` holds a marker phrase per row and fails if one is missing from its destination.
- New `AGENTS.md` sections are appended at the end; no existing rule is edited.
- Tracked files name machine paths only through `$PKEY_LEAD` (the lead directory, set in the owner's shell profile; `_mockups/` is its sibling and `$PKEY_LEAD/owner-steps.md` links to the owner's checklist).
- Role agents (`.claude/agents/`): `tools:` and an explicit `model:` on all seven (plan §8.5), no rule counts in prose, `pkey-wp-reviewer` also reviews a PR that has no brief.

**Out** (and where it belongs instead):

- The `AGENTS.md` router, repo map, short rules and nested files (→ AX-03b).
- Rule 3 and the `gen:*` commands (→ P0-42), rule 4 and "Where docs live" (→ DOC-03a), rule 11 (→ DOC-03b), `CLAUDE.md`'s plan-mode list (→ SP-34). AX packages never edit those parts.

## Design notes

- Tier: must (required; gates 1.0 on its deterministic checks only). Wave 1 in the plan's order (§8.4). Model routing (§8.5): Opus 5.5 for the restructure, Sonnet 5.5 for the tests; set the model on every agent call, never inherit.
- Model routing (plan §8.5): Sonnet 5.5 for implementer, sdk-porter, godot-engineer, spike-runner; Opus 5.5 for wire-planner, wp-reviewer, ux-reviewer. Never inherit.
- The `AGENTS.md` restructure is judgement work (Opus 5.5).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] `agents-md.test.ts` finds every moved rule at its destination.
- [ ] `CLAUDE.md` is under 30 lines and starts with `@AGENTS.md`.
- [ ] No `/Users/` or `~/` path in a tracked agent, skill or `CLAUDE.md` file.
- [ ] All seven role agents have `tools:` and an explicit `model:`; none counts the hard rules in prose.
- [ ] Its eval report (plan §7.4) is attached to the hand-off: the suite and arms it should move, and the measured difference with its interval. It never blocks the merge.
- [ ] Any skill or README it writes or changes is reviewed against the plan's principle 9 (terse: each fact once, in the reader's words).
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

AX-03b builds the router on the appended sections; AX-07 and AX-14 depend on the split.

The role agent sets `--set AX-03a in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set AX-03a done`.
