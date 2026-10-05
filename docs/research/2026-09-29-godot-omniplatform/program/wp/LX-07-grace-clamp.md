# LX-07 Clamp offline grace to licence expiry (G9), on by default after the affected-licence report, with a per-product opt-out

| Field       | Value                                                                                   |
| ----------- | --------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase A: independent fixes) |
| Size        | 0.2–0.3 engineer-weeks                                                                  |
| Depends on  | [LX-06](LX-06-licensing-settings.md)                                                    |
| Unblocks    | none                                                                                    |
| Role        | `pkey-implementer`                                                                      |
| Plan mode   | no                                                                                      |
| Gates       | THREAT-MODEL                                                                            |
| Human input | none                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                               |

## Goal

Offline grace is clamped to licence expiry on every product by default, after a report lists the affected licences, with a per-product opt-out (`licensing.clampGraceToExpiry`); grace is never clamped to a grant's expiry.

## Why

A licence expiring tomorrow with 30 offline days keeps working offline for 30 days (G9, [S-19 §4.3](../../notes/S-19-licensing-model.md#43-gaps)). Decision 7 accepted on-by-default ([S-19 §10.3](../../notes/S-19-licensing-model.md#103-owner-decisions-recommended-defaults-in-bold) decision 7).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §4.3](../../notes/S-19-licensing-model.md#43-gaps) G9, [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-07.

## Scope

**In:**

- Affected-licence report; the clamp in the document's offline window; the setting's default.

**Out** (and where it belongs instead):

- Grant expiry (→ LX-12).

## Design notes

- Perpetual licences are unaffected.

## Steps

1. Report.
2. Clamp.
3. Document tests.

## Acceptance criteria

- [ ] A licence expiring before its grace window ends gets a clamped window (test).
- [ ] Opt-out restores today's window (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:corpus -- --check
```

## Hand-off

- None.

The role agent sets `--set LX-07 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-07 done`.
