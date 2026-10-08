# AX-21 A `product:read` token scope bound to one product

| Field       | Value                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | AX: Agent experience: READMEs, llms files, skills, a CLI machines can drive and an eval harness (docs/research/2026-10-08-llm-audit/) (LLM audit (2026-10-08)) |
| Size        | 0.5–0.8 engineer-weeks                                                                                                                                         |
| Depends on  | [ST-34](ST-34-admin-scope-personal-tokens-pkey-login.md)                                                                                                       |
| Unblocks    | [AX-19](AX-19-operator-reads-pkey-product-status-and-two-mcp-tools.md)                                                                                         |
| Role        | `pkey-implementer`                                                                                                                                             |
| Plan mode   | no                                                                                                                                                             |
| Gates       | `threat-model`                                                                                                                                                 |
| Human input | The owner's go (plan §8.1)                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                      |

## Goal

Personal tokens (ST-34) can carry a `product:read` scope, exclusive like the others, bound to one product and enforced server-side on every read route it reaches.

## Why

AX-19's operator reads need a token scope that did not exist. A new package rather than an ST-34 amendment: ST-34 gates 1.0, and a deferred, owner-gated scope should not widen it. Registered from [the LLM audit plan](../../../2026-10-08-llm-audit/README.md) (§6.2, §8.3, review B4).

## Read first

- `AGENTS.md` (always).
- [The LLM audit plan](../../../2026-10-08-llm-audit/README.md): §6.2, §8.3, review B4, and §2 (principles), §9 (how it fits the other plans), §10 (decisions).
- The docs [style guide](../../../2026-10-08-docs/style-guide.md) governs READMEs and skills.

## Scope

**In:**

- The `product:read` scope on personal tokens (ST-34), exclusive like the others, bound to one product, enforced server-side on every read route it reaches; a THREAT-MODEL row.

**Out** (and where it belongs instead):

- Using it (→ AX-19).

## Design notes

- Tier: later (optional); deferred until the owner's go (plan §8.1). Wave 5 in the plan's order (§8.4). Model routing (§8.5): Sonnet 5.5; security review Sonnet 5.5; set the model on every agent call, never inherit.
- Security review on Sonnet 5.5.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Tests that it is refused on any other product, any write and the registry.
- [ ] A THREAT-MODEL row.
- [ ] A security review.
- [ ] Its eval report (plan §7.4) is attached to the hand-off: the suite and arms it should move, and the measured difference with its interval. It never blocks the merge.
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

AX-19 uses it.

The role agent sets `--set AX-21 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set AX-21 done`.
