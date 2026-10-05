# LX-24 Per-seat feature assignment, with I-24's named-user seats

| Field       | Value                                                                                |
| ----------- | ------------------------------------------------------------------------------------ |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase D: optional)       |
| Size        | 0.6–0.85 engineer-weeks                                                              |
| Depends on  | [LX-09](LX-09-entitlement-resolver.md), [I-24a](I-24a-named-user-seats-server.md)    |
| Unblocks    | none                                                                                 |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                |
| Plan mode   | yes: the plan [`plans/LX-24.md`](../plans/LX-24.md) needs human approval before code |
| Gates       | plan mode                                                                            |
| Human input | plan approval (`plans/LX-24.md`)                                                     |
| Repo        | `vladzaharia/polaris-key`                                                            |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/I-24.md`](../plans/I-24.md):** per-seat features key on `license_seat_holders`; the dependency moves from I-24 to I-24a.

## Goal

Optional: features can be assigned per seat, alongside I-24's named-user seats.

## Why

[S-19 §7.3.1](../../notes/S-19-licensing-model.md#731-contributors): the seat user's own account is the holder; per-seat assignment joins I-24.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.3.1](../../notes/S-19-licensing-model.md#731-contributors), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-24.
- I-24's brief.

## Scope

**In:**

- The plan; assignment storage and resolver input.

**Out** (and where it belongs instead):

- Seats themselves (→ I-24).

## Design notes

- Plan mode: it changes the licence document's inputs.

## Steps

1. Plan and approval.
2. Implementation.

## Acceptance criteria

- [ ] A seat's assigned feature appears only for that seat user (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- None.

The role agent sets `--set LX-24 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-24 done`.
