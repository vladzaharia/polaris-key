# LX-05b Reserved entitlement names, error phase: `licensing.reservedNames` flipped to `error` and the warn path removed

| Field       | Value                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase A: independent fixes)                                          |
| Size        | 0.1–0.15 engineer-weeks                                                                                                          |
| Depends on  | [LX-05](LX-05-reserved-names-warn.md)                                                                                            |
| Unblocks    | [PX-W13b](PX-W13b-display-name-settings.md)                                                                                      |
| Role        | `pkey-implementer`                                                                                                               |
| Plan mode   | no                                                                                                                               |
| Gates       | rule 9 (validator rule, mutation table, JSON schema)                                                                             |
| Human input | the lead confirms the warn window has elapsed: two minor releases or 60 days after LX-05 ships, whichever is later (decision 15) |
| Repo        | `vladzaharia/polaris-key`                                                                                                        |

## Goal

`licensing.reservedNames` is flipped to `error` and the warn path is removed; the tier `maxOfflineDays` alias becomes an error on the same schedule (decision 17).

## Why

Decision 15 ends the warn window after two minor releases or 60 days ([S-19 §10.3](../../notes/S-19-licensing-model.md#103-owner-decisions-recommended-defaults-in-bold) decision 15).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.4](../../notes/S-19-licensing-model.md#74-combine-rules-entitlement-kinds-and-reserved-names), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-05b.

## Scope

**In:**

- Default flip; warn path removal; rule 9 mutation entry update.

**Out** (and where it belongs instead):

- Nothing else.

## Design notes

- Do not start before the lead confirms the window elapsed.

## Steps

1. Flip.
2. Remove the warn path.

## Acceptance criteria

- [ ] An incompatible declaration fails validation (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/manifest test
```

## Hand-off

- None.

The role agent sets `--set LX-05b in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-05b done`.
