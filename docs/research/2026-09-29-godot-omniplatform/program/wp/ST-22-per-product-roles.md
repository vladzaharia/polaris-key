# ST-22 Per-product operator roles (D10, optional, after a security review)

| Field       | Value                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (phase 5: governance and environments)       |
| Size        | 1.2–1.7 engineer-weeks                                                                      |
| Depends on  | none                                                                                        |
| Unblocks    | none                                                                                        |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                       |
| Plan mode   | yes: the plan [`plans/ST-22.md`](../plans/ST-22.md) needs human approval before code        |
| Gates       | plan mode; THREAT-MODEL                                                                     |
| Human input | plan approval (`plans/ST-22.md`); a security review of the authorization model before merge |
| Repo        | `vladzaharia/polaris-key`                                                                   |

## Consolidation 2026-10-07

> **Closed 2026-10-07 (DX consolidation): merged into [ST-31](ST-31-roles-bindings-invites-members-pages.md).** The id stays in the graph as `dropped` so it
> is not reused; do not build this package. Its scope moves to [ST-31](ST-31-roles-bindings-invites-members-pages.md).

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **merge** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> No longer optional: the owner asks for full RBAC (ST-28 plan, ST-29 gate, ST-30 sign-in, ST-31 roles). Security review carried over.

- Dependencies cleared on closing (they were ST-21), so nothing in the graph waits on or through a closed package.

## Goal

Optional: per-product operator roles, after a security review of the authorization model.

## Why

D10 defers roles until after a security review ([S-18 §7.3](../../notes/S-18-settings-architecture.md#73-owner-decisions-recommended-defaults-in-bold)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §4.8](../../notes/S-18-settings-architecture.md#48-authorization), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-22, [S-18 §7.3](../../notes/S-18-settings-architecture.md#73-owner-decisions-recommended-defaults-in-bold) D10.

## Scope

**In:**

- The plan (authz model), then roles behind ST-21's gate.

**Out** (and where it belongs instead):

- Anything outside settings authorization.

## Design notes

- THREAT-MODEL §9 trigger.

## Steps

1. Plan and approval.
2. Security review.
3. Implementation.

## Acceptance criteria

- [ ] Security review recorded.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- None.

The role agent sets `--set ST-22 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-22 done`.
