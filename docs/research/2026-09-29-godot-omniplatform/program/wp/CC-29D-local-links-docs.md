# CC-29D Local links docs and Help

| Field       | Value                                                               |
| ----------- | ------------------------------------------------------------------- |
| Phase       | CC                                                                  |
| Size        | 0.05 engineer-weeks                                                 |
| Depends on  | [CC-29](CC-29-local-links.md), [CC-23L](CC-23L-local-links-plan.md) |
| Unblocks    | none                                                                |
| Role        | `pkey-implementer`                                                  |
| Plan mode   | no                                                                  |
| Gates       | docs-links, docs-generated                                          |
| Human input | none                                                                |
| Repo        | `vladzaharia/polaris-key`                                           |

## Goal

`features/cloud-connect/local-links.md` (with the entitlement snippet), a Help section "Pair with a code" in `help/pair-with-someone.mdx`, `site-map.json`, and the snippet lanes in `covered.ts` (Node, Python).

## Why

Adds to CC-17's and CC-19.11's Help page rather than a new one.

## Read first

- `AGENTS.md` (always).
- The CC-23L plan §10 (CC-29D)

## Acceptance criteria

- [ ] `pnpm --filter @polaris-key/docs lint:docs` and `check:links` are clean; the snippet lanes pass.

## Hand-off

The role agent sets `--set CC-29D in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CC-29D done`.
