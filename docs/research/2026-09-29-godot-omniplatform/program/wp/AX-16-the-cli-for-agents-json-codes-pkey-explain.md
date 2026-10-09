# AX-16 The CLI for agents: `--json` everywhere, codes, `pkey explain`

| Field       | Value                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | AX: Agent experience: READMEs, llms files, skills, a CLI machines can drive and an eval harness (docs/research/2026-10-08-llm-audit/) (LLM audit (2026-10-08)) |
| Size        | 1.2–1.6 engineer-weeks                                                                                                                                         |
| Depends on  | [P0-45](P0-45-pkey-command-registry-context-doctor.md)                                                                                                         |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [AX-17](AX-17-pkey-mcp-a-local-read-only-mcp-server.md)                                                                |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                          |
| Plan mode   | yes: the plan needs human approval before code                                                                                                                 |
| Gates       | `plan-mode`, `all-sdks`, `drift-gate`                                                                                                                          |
| Human input | none                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                      |

## Goal

Every `pkey` command and error path supports `--json` with a stable envelope carrying `code`, `hint` and `docs`; `pkey explain <code>` exists; CLI and publish reason codes are in the shared error registry.

## Why

`validate --json` is the model to copy, but `sdk`, `trust`, `mirror` and every error path ignore `--json`; there is no fix or docs link per code; offline, `pkey sdk` prints "fetch failed" and nothing else; publish reason codes (`policy_mismatch`, `ref_protected`, ...) have no registry, only `ci.md`'s hand-written table. Registered from [the LLM audit plan](../../../2026-10-08-llm-audit/README.md) (§8.1, §8.3).

## Read first

- `AGENTS.md` (always).
- [The LLM audit plan](../../../2026-10-08-llm-audit/README.md): §8.1, §8.3, and §2 (principles), §9 (how it fits the other plans), §10 (decisions).
- The docs [style guide](../../../2026-10-08-docs/style-guide.md) governs READMEs and skills.

## Scope

**In:**

- `--json` on every command and every error path (`sdk`, `trust`, `mirror` included), extending today's v1 envelope (`{v:1,command,event,ok,exit,…}` with `error` and `message`) with `code`, `hint` and `docs`; exit codes stay 0, 1 and 2 (the class is in `code`).
- Every interactive prompt has a flag and fails with a code naming it when there is no TTY; `pkey explain <code>`; a `docs` URL on every `validate` finding; `pkey init` refuses a reserved slug; `pkey sdk` offline says what to check next; an unknown command suggests the nearest one; `pkey release keys generate` refuses an `--out` inside a git work tree.
- The registry part, planned first (plan mode): CLI and publish reason codes (Worker responses from `platformDeploy.ts` and `core/publisher.ts`) join `conformance/parity/errors.json` under new kinds `cli` and `publish`, with `errors.schema.json`, a `registryVersion` bump, constant generation for all six languages skipping the new kinds, and every SDK's registry test.
- The package README's `--json` and `pkey explain` rows (§3.2).

**Out** (and where it belongs instead):

- `pkey agents` (→ AX-08), `pkey mcp` (→ AX-17); registry entries for them (→ P0-45 amendment).
- Interactive init's flags (→ ST-46 amendment).

## Design notes

- Tier: must (required; gates 1.0 on its deterministic checks only). Wave 2 in the plan's order (§8.4). Model routing (§8.5): Sonnet 5.5; the plan by `pkey-wire-planner` (Opus 5.5); set the model on every agent call, never inherit.
- Plan mode: the registry change affects every SDK. `plans/AX-16.md` goes to `pkey-wire-planner` first and must name the corpus regeneration and every SDK that follows. No other AX package touches the wire.
- Hotspot: AX-16 and P0-45 both edit `help.ts`.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] The approved plan exists and is merged.
- [ ] A test runs every registered command with `--json` on a failure and parses one JSON line.
- [ ] Every SDK's registry test passes; corpus and generated constants regenerated.
- [ ] Exit codes stay 0, 1 and 2.
- [ ] Its eval report (plan §7.4) is attached to the hand-off: the suite and arms it should move, and the measured difference with its interval. It never blocks the merge.
- [ ] Any skill or README it writes or changes is reviewed against the plan's principle 9 (terse: each fact once, in the reader's words).
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

AX-12's `references/reasons.md` and AX-17's `explain_code` read the new codes.

The role agent sets `--set AX-16 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set AX-16 done`.
