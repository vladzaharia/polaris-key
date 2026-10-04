# U-11a Console Data tab, settings half: settings, account overrides, "what the app sees", quota meters, audit and step-up on I-12's Users page

| Field       | Value                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U1 MVP)                                                                                                         |
| Size        | 0.6–0.85 engineer-weeks                                                                                                               |
| Depends on  | [U-03](U-03-account-overrides.md), [U-05](U-05-cloud-sync-do.md), [I-12](I-12-console-users.md)                                       |
| Unblocks    | [U-11b](U-11b-console-data-saves.md), [U-11c](U-11c-console-data-records.md)                                                          |
| Role        | `pkey-implementer`                                                                                                                    |
| Plan mode   | no: follows the approved [`plans/U-01.md`](../plans/U-01.md) where it names this package                                              |
| Gates       | console CSP parity; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; accessibility and console tests; cross-product visibility test |
| Human input | none                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                             |

## Goal

The console's Users page (I-12) gains a Data tab for one pairwise subject: settings, account overrides, "what the app sees" (the effective values with sources), quota meters, and audit, with step-up for writes.

## Why

Operators need to support customers' synced settings without seeing other products ([S-17 §5.10](../../notes/S-17-user-data-sync.md#510-console-surfaces)).

## Read first

- `AGENTS.md` (always); `docs/design/ADMIN.md`.
- [S-17 §5.10](../../notes/S-17-user-data-sync.md#510-console-surfaces), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-11.
- I-12's Users page.

## Scope

**In:** the settings half of the Data tab.

**Out** (and where it belongs instead):

- Saves (→ U-11b); collections (→ U-11c).

## Design notes

- Pairwise subject only; every read and write audited (T10).
- I-12's Users page is platform-level (Core), shown on every product whether or not Identity is on, so the Data tab appears for every product with Cloud Sync on (owner clarification, 2026-10-04: Cloud Sync depends on the account, not the Identity toggle).
- Contact email follows S-16 D19 (accepted): the buyer email, and the account's primary email only with the person's consent.

## Steps

1. Admin routes. 2. Tab UI.

## Acceptance criteria

- [ ] The tab shows only this product's subject data (test).
- [ ] Writes need step-up and are audited (tests).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- U-11b and U-11c add their halves.

The role agent sets `--set U-11a in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-11a done`.
