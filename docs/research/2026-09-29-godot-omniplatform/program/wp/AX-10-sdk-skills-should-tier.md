# AX-10 SDK skills, should tier

| Field       | Value                                                                                                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | AX: Agent experience: READMEs, llms files, skills, a CLI machines can drive and an eval harness (docs/research/2026-10-08-llm-audit/) (LLM audit (2026-10-08))                                                                                            |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                                                                      |
| Depends on  | [AX-09](AX-09-sdk-skills-must-tier.md), [SP-35](SP-35-sdk-api-registry-api-json-0-9.md), [SP-41](SP-41-pkey-dev-a-local-polaris-key-for-integrators.md), [SP-42](SP-42-test-doubles-on-the-real-client-in-every-sdk.md), [DOC-12a](DOC-12a-generators.md) |
| Unblocks    | none                                                                                                                                                                                                                                                      |
| Role        | `pkey-sdk-porter`                                                                                                                                                                                                                                         |
| Plan mode   | no                                                                                                                                                                                                                                                        |
| Gates       | `docs-links`                                                                                                                                                                                                                                              |
| Human input | none                                                                                                                                                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                 |

## Goal

The should-tier SDK skills ship: `adding-updates`, `customizing-the-ui-kits`, `testing-with-pkey-dev`, `upgrading-polaris-key`; `skills:check` switches to `api.json` names.

## Why

Updates, restyling, testing against `pkey dev` and moving to a new release are common integrator tasks with their own words and files. Registered from [the LLM audit plan](../../../2026-10-08-llm-audit/README.md) (§5.2, §8.3).

## Read first

- `AGENTS.md` (always).
- [The LLM audit plan](../../../2026-10-08-llm-audit/README.md): §5.2, §8.3, and §2 (principles), §9 (how it fits the other plans), §10 (decisions).
- The docs [style guide](../../../2026-10-08-docs/style-guide.md) governs READMEs and skills.

## Scope

**In:**

- `adding-updates`; `customizing-the-ui-kits`; `testing-with-pkey-dev` (after SP-41, SP-42); `upgrading-polaris-key` (after SP-35, with `references/renames.md` from DOC-12a's upgrade table, which reads `api.json`'s `replaces`, and `scripts/find-removed-names.mjs`).
- `skills:check` switches to `api.json` names and its removed-names list.

**Out** (and where it belongs instead):

- Must-tier skills (→ AX-09).

## Design notes

- Tier: should (optional). Wave 4 in the plan's order (§8.4). Model routing (§8.5): Opus 5.5 for procedure and descriptions; Sonnet 5.5 for references; set the model on every agent call, never inherit.
- The upgrade skill is version-neutral and the only skill that names removed names (its rename table).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] As AX-09: `skills:check`; compiled fences; trigger cases recorded.
- [ ] `skills:check` reads `api.json` names.
- [ ] Its eval report (plan §7.4) is attached to the hand-off: the suite and arms it should move, and the measured difference with its interval. It never blocks the merge.
- [ ] Any skill or README it writes or changes is reviewed against the plan's principle 9 (terse: each fact once, in the reader's words).
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

AX-17's `check_sdk_names` shares the removed-names list.

The role agent sets `--set AX-10 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set AX-10 done`.
