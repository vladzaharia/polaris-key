# AX-22 Doc comments on every exported SDK symbol

| Field       | Value                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | AX: Agent experience: READMEs, llms files, skills, a CLI machines can drive and an eval harness (docs/research/2026-10-08-llm-audit/) (LLM audit (2026-10-08)) |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                                         |
| Depends on  | [SP-35](SP-35-sdk-api-registry-api-json-0-9.md)                                                                                                                |
| Unblocks    | none                                                                                                                                                           |
| Role        | `pkey-sdk-porter`                                                                                                                                              |
| Plan mode   | no                                                                                                                                                             |
| Gates       | `all-sdks`                                                                                                                                                     |
| Human input | none                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                      |

## Goal

Every exported symbol that `api.json` lists has a doc comment in its SDK's own form.

## Why

The plan lists doc comments on every exported symbol as its own package (review minor 9); `api.json` (SP-35) already names every exported symbol, so the lint has a source of truth. Registered from [the LLM audit plan](../../../2026-10-08-llm-audit/README.md) (§9, §8.3, review minor 9).

## Read first

- `AGENTS.md` (always).
- [The LLM audit plan](../../../2026-10-08-llm-audit/README.md): §9, §8.3, review minor 9, and §2 (principles), §9 (how it fits the other plans), §10 (decisions).
- The docs [style guide](../../../2026-10-08-docs/style-guide.md) governs READMEs and skills.

## Scope

**In:**

- A doc comment on every exported symbol `api.json` lists: TSDoc in the shipped `.d.ts`, Python docstrings, DocC, KDoc, GDScript doc comments.
- A lint per SDK, in its lane.

**Out** (and where it belongs instead):

- `api.json` itself (→ SP-35).

## Design notes

- Tier: should (optional). Wave 4 in the plan's order (§8.4). Model routing (§8.5): Sonnet 5.5; set the model on every agent call, never inherit.
- `api.json` also drives `check_sdk_names` and `get_sdk_api` (AX-17).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A lint per SDK, in its lane, passes.
- [ ] Its eval report (plan §7.4) is attached to the hand-off: the suite and arms it should move, and the measured difference with its interval. It never blocks the merge.
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

AX-17's `get_sdk_api` is richer for it.

The role agent sets `--set AX-22 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set AX-22 done`.
