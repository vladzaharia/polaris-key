# SP-09 Velopack package route drops `Authorization` on its cross-origin 302 under licensed or entitled delivery (wire item W9, S-11 §5.2 follow-up)

| Field       | Value                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------ |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (wire items)                                |
| Size        | 0.1–0.2 engineer-weeks                                                                     |
| Depends on  | [P3-09](P3-09-updater-feeds.md)                                                            |
| Unblocks    | none                                                                                       |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                      |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/SP-09.md` first; no code before a human approves it |
| Gates       | plan mode; rule 10 (OpenAPI and `routeCoverage`); THREAT-MODEL; `test:workerd`             |
| Human input | none                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                  |

## Goal

The Velopack package route never forwards `Authorization` across its cross-origin 302 under
licensed or entitled delivery, and the Velopack drivers in Godot, Node, Python and Kotlin retry
correctly against it.

## Why

Wire item W9 in [`notes/SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §6, the S-11 §5.2 follow-up.
Approved to proceed through plan mode on 2026-10-05.

## Read first

- `AGENTS.md` and `CLAUDE.md`; [`notes/S-11`](../../notes/S-11-desktop-updaters.md) §5.2; the feeds code from P3-09.

## Scope

**In:** the route change, its OpenAPI text, a THREAT-MODEL row and a regression test.

**Out:** driver work beyond retry (each SDK's SP task).

## Steps

1. Plan, then Worker, then test.

## Acceptance criteria

- [ ] A licensed Velopack download redirects without leaking the bearer (test).
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- The Velopack drivers in the SP tasks rely on this.

The role agent sets `--set SP-09 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-09 done`.
