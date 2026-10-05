# ST-22 Per-product operator roles (D10, optional, after a security review)

| Field       | Value                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings architecture (S-18) (phase 5: governance and environments)                     |
| Size        | 1.2–1.7 engineer-weeks                                                                      |
| Depends on  | [ST-21](ST-21-capability-gate.md)                                                           |
| Unblocks    | none                                                                                        |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                       |
| Plan mode   | yes: the plan [`plans/ST-22.md`](../plans/ST-22.md) needs human approval before code        |
| Gates       | plan mode; THREAT-MODEL                                                                     |
| Human input | plan approval (`plans/ST-22.md`); a security review of the authorization model before merge |
| Repo        | `vladzaharia/polaris-key`                                                                   |

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
