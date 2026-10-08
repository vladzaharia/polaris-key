# AX-19 Operator reads: `pkey product status` and two MCP tools

| Field       | Value                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | AX: Agent experience: READMEs, llms files, skills, a CLI machines can drive and an eval harness (docs/research/2026-10-08-llm-audit/) (LLM audit (2026-10-08)) |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                                         |
| Depends on  | [AX-17](AX-17-pkey-mcp-a-local-read-only-mcp-server.md), [AX-21](AX-21-product-read-token-scope-bound-to-one-product.md)                                       |
| Unblocks    | none                                                                                                                                                           |
| Role        | `pkey-implementer`                                                                                                                                             |
| Plan mode   | no                                                                                                                                                             |
| Gates       | `threat-model`                                                                                                                                                 |
| Human input | The owner's go (plan §8.1)                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                      |

## Goal

`pkey product status --json` and the MCP tools `get_product_status` and `list_releases` return statuses, ids, versions and counts for one product, using a `product:read` token from the keychain.

## Why

An operator's agent needs to see why a sync did nothing or what the latest release per channel is, without secrets or customer text. Registered from [the LLM audit plan](../../../2026-10-08-llm-audit/README.md) (§6.2, §6.3, §8.3).

## Read first

- `AGENTS.md` (always).
- [The LLM audit plan](../../../2026-10-08-llm-audit/README.md): §6.2, §6.3, §8.3, and §2 (principles), §9 (how it fits the other plans), §10 (decisions).
- The docs [style guide](../../../2026-10-08-docs/style-guide.md) governs READMEs and skills.

## Scope

**In:**

- `pkey product status --json`: services and who owns each, the last resync and its error codes, trusted publishers, key fingerprints, the latest release per channel, on AX-21's token from `pkey login`'s keychain; the same as `get_product_status` and `list_releases`. Statuses, ids, versions and counts only.

**Out** (and where it belongs instead):

- The token scope (→ AX-21). Any write.

## Design notes

- Tier: later (optional); deferred until the owner's go (plan §8.1); also waits for AX-21's token scope. Wave 5 in the plan's order (§8.4). Model routing (§8.5): Sonnet 5.5; security review Sonnet 5.5; set the model on every agent call, never inherit.
- The token is never in `.mcp.json`. No license notes, release notes or other customer-written text is returned. Security review on Sonnet 5.5.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A test that no customer-written field is returned.
- [ ] A security review.
- [ ] Its eval report (plan §7.4) is attached to the hand-off: the suite and arms it should move, and the measured difference with its interval. It never blocks the merge.
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

None downstream.

The role agent sets `--set AX-19 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set AX-19 done`.
