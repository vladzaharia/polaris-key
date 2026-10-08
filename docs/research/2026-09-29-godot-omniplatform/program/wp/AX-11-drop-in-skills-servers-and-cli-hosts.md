# AX-11 Drop-in skills: servers and CLI hosts

| Field       | Value                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | AX: Agent experience: READMEs, llms files, skills, a CLI machines can drive and an eval harness (docs/research/2026-10-08-llm-audit/) (LLM audit (2026-10-08)) |
| Size        | 0.5–0.8 engineer-weeks                                                                                                                                         |
| Depends on  | [AX-09](AX-09-sdk-skills-must-tier.md), [SP-64](SP-64-framework-drop-ins-integration-and-docs.md)                                                              |
| Unblocks    | none                                                                                                                                                           |
| Role        | `pkey-sdk-porter`                                                                                                                                              |
| Plan mode   | no                                                                                                                                                             |
| Gates       | `docs-links`                                                                                                                                                   |
| Human input | none                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                      |

## Goal

`adding-server-verification` ships, and `adding-licensing` and `adding-sign-in` gain the CLI-host references.

## Why

SP-64's framework drop-in pages are the source for protecting an app's own backend and gating a CLI. Registered from [the LLM audit plan](../../../2026-10-08-llm-audit/README.md) (§5.2, §8.3).

## Read first

- `AGENTS.md` (always).
- [The LLM audit plan](../../../2026-10-08-llm-audit/README.md): §5.2, §8.3, and §2 (principles), §9 (how it fits the other plans), §10 (decisions).
- The docs [style guide](../../../2026-10-08-docs/style-guide.md) governs READMEs and skills.

## Scope

**In:**

- `adding-server-verification` (after SP-64): Express, Hono, Next.js, FastAPI, Django, DRF, Flask and Ktor, verifying the `X-PKey-License` document offline, and sending it from the app with `client.backend`.
- The CLI-host references in `adding-licensing` (`references/cli-<framework>.md`: Commander, yargs, argparse, click, typer) and `adding-sign-in`.

**Out** (and where it belongs instead):

- Server and CLI middleware itself (→ SP-55 and neighbours).

## Design notes

- Tier: should (optional). Wave 4 in the plan's order (§8.4). Model routing (§8.5): Opus 5.5 for procedure; Sonnet 5.5 for references; set the model on every agent call, never inherit.
- `api.json`'s `layer` (`server`, `cli`) routes `using-polaris-key`. Exit 4 (UK-51) belongs to a host CLI's gate; `pkey`'s own exit codes stay 0, 1 and 2.

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

The role agent sets `--set AX-11 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set AX-11 done`.
