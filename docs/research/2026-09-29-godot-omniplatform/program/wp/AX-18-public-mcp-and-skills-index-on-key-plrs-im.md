# AX-18 Public MCP and skills index on key.plrs.im

| Field       | Value                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | AX: Agent experience: READMEs, llms files, skills, a CLI machines can drive and an eval harness (docs/research/2026-10-08-llm-audit/) (LLM audit (2026-10-08)) |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                                         |
| Depends on  | [AX-17](AX-17-pkey-mcp-a-local-read-only-mcp-server.md)                                                                                                        |
| Unblocks    | none                                                                                                                                                           |
| Role        | `pkey-implementer`                                                                                                                                             |
| Plan mode   | no                                                                                                                                                             |
| Gates       | `rule-9`, `rule-10`, `threat-model`, `docs:privacy`                                                                                                            |
| Human input | none                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                      |

## Goal

`key.plrs.im/mcp` serves the same read-only tools over stateless streamable HTTP with no auth, and `/.well-known/agent-skills/index.json` lists the public skills with SHA-256 digests.

## Why

The same tool module serves agents with nothing installed, once the logs justify it (decision 7: in the main Worker; a separate origin only if the logs show heavy use). Registered from [the LLM audit plan](../../../2026-10-08-llm-audit/README.md) (§6.2, §8.3).

## Read first

- `AGENTS.md` (always).
- [The LLM audit plan](../../../2026-10-08-llm-audit/README.md): §6.2, §8.3, and §2 (principles), §9 (how it fits the other plans), §10 (decisions).
- The docs [style guide](../../../2026-10-08-docs/style-guide.md) governs READMEs and skills.

## Scope

**In:**

- `/mcp` in the Worker: the tool module minus local-file inputs, `check_product` fixed to its own origin (no server-side fetch of a caller-supplied URL).
- Reserves the slug `mcp` (validator, schema, reserved-slug test; the lead first confirms no product uses it, as for D8), with an OpenAPI row, `routeCoverage` and a THREAT-MODEL row.
- Ignores every cookie, `__Host-pkey_admin` included; rate-limits in its own limiter bucket (`mcp`), keyed by a salted hash of the client address, failing closed (429) when the limiter is unavailable; a PRIVACY.md row.
- Caps `validate_manifest` input at 256 KB, refuses YAML aliases, caps each answer at 25k tokens.
- `/.well-known/agent-skills/index.json` with SHA-256 digests.

**Out** (and where it belongs instead):

- Operator reads (→ AX-19).

## Design notes

- Tier: later (optional). Wave 5 in the plan's order (§8.4). Model routing (§8.5): Sonnet 5.5; security review Sonnet 5.5; set the model on every agent call, never inherit.
- Security review on Sonnet 5.5.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A rate-limit test, fail-closed included.
- [ ] A test that a cookie is ignored.
- [ ] A test that tool code makes no outbound fetch.
- [ ] The input caps.
- [ ] A security review.
- [ ] Its eval report (plan §7.4) is attached to the hand-off: the suite and arms it should move, and the measured difference with its interval. It never blocks the merge.
- [ ] Any skill or README it writes or changes is reviewed against the plan's principle 9 (terse: each fact once, in the reader's words).
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

None downstream.

The role agent sets `--set AX-18 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set AX-18 done`.
